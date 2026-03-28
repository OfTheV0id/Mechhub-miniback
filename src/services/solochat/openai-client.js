function createOpenAiCompatibleClient() {
    const baseUrl = normalizeBaseUrl(process.env.OPENAI_BASE_URL);
    const apiKey = process.env.OPENAI_API_KEY;
    const defaultModel = process.env.OPENAI_MODEL;
    const timeoutMs = parseTimeoutMs(process.env.OPENAI_TIMEOUT_MS, 30000);
    const streamTimeoutMs = parseTimeoutMs(
        process.env.OPENAI_STREAM_TIMEOUT_MS,
        0,
    );

    async function createChatCompletion({
        messages,
        temperature = 0.7,
        model,
        maxTokens,
        signal: requestSignal,
    }) {
        const resolvedModel = validateConfig(model);
        const chatCompletionsUrl = resolveChatCompletionsUrl(baseUrl);
        const { controller, detach } = createLinkedAbortController(
            requestSignal,
        );
        const timeout = startAbortTimer(controller, timeoutMs);

        try {
            const response = await fetch(chatCompletionsUrl, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: resolvedModel,
                    messages,
                    temperature,
                    ...(maxTokens ? { max_tokens: maxTokens } : {}),
                }),
                signal: controller.signal,
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                throw upstreamError(
                    payload?.error?.message ||
                        payload?.message ||
                        `Upstream AI request failed with status ${response.status}`,
                );
            }

            const content = extractMessageContent(
                payload?.choices?.[0]?.message?.content,
                {
                    trim: true,
                },
            );

            if (!content) {
                throw upstreamError("AI response did not include any content");
            }

            return content;
        } catch (error) {
            if (isAbortError(error)) {
                throw requestSignal?.aborted
                    ? requestAbortedError()
                    : timeoutError();
            }

            throw error;
        } finally {
            clearAbortTimer(timeout);
            detach();
        }
    }

    async function* streamChatCompletion({
        messages,
        temperature = 0.7,
        model,
        signal: requestSignal,
    }) {
        const resolvedModel = validateConfig(model);
        const chatCompletionsUrl = resolveChatCompletionsUrl(baseUrl);
        const { controller, detach } = createLinkedAbortController(
            requestSignal,
        );
        let timeout = startAbortTimer(controller, streamTimeoutMs);

        try {
            const response = await fetch(chatCompletionsUrl, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: resolvedModel,
                    messages,
                    temperature,
                    stream: true,
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw upstreamError(
                    payload?.error?.message ||
                        payload?.message ||
                        `Upstream AI request failed with status ${response.status}`,
                );
            }

            if (!response.body) {
                throw upstreamError(
                    "AI stream did not include a response body",
                );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                timeout = refreshAbortTimer(
                    controller,
                    timeout,
                    streamTimeoutMs,
                );

                if (done) {
                    break;
                }

                buffer += decoder
                    .decode(value, { stream: true })
                    .replace(/\r\n/g, "\n");
                const events = buffer.split("\n\n");
                buffer = events.pop() || "";

                for (const event of events) {
                    const data = readSseData(event);

                    if (!data) {
                        continue;
                    }

                    if (data === "[DONE]") {
                        return;
                    }

                    const payload = JSON.parse(data);
                    const delta = extractMessageContent(
                        payload?.choices?.[0]?.delta?.content,
                        {
                            trim: false,
                        },
                    );

                    if (delta) {
                        yield delta;
                    }
                }
            }

            const finalData = readSseData(buffer);

            if (finalData && finalData !== "[DONE]") {
                const payload = JSON.parse(finalData);
                const delta = extractMessageContent(
                    payload?.choices?.[0]?.delta?.content,
                    {
                        trim: false,
                    },
                );

                if (delta) {
                    yield delta;
                }
            }
        } catch (error) {
            if (isAbortError(error)) {
                throw requestSignal?.aborted
                    ? requestAbortedError()
                    : timeoutError();
            }

            throw error;
        } finally {
            clearAbortTimer(timeout);
            detach();
        }
    }

    function validateConfig(model) {
        if (!baseUrl) {
            throw configurationError("OPENAI_BASE_URL is required");
        }

        if (!apiKey) {
            throw configurationError("OPENAI_API_KEY is required");
        }

        const resolvedModel = model || defaultModel;

        if (!resolvedModel) {
            throw configurationError("OPENAI_MODEL is required");
        }

        return resolvedModel;
    }

    return {
        createChatCompletion,
        streamChatCompletion,
    };
}

function normalizeBaseUrl(value) {
    const normalized = String(value || "")
        .trim()
        .replace(/\/+$/, "");
    return normalized || "";
}

function resolveChatCompletionsUrl(baseUrl) {
    if (baseUrl.endsWith("/chat/completions")) {
        return baseUrl;
    }

    return `${baseUrl}/chat/completions`;
}

function extractMessageContent(content, options = {}) {
    const trim = options.trim !== false;

    if (typeof content === "string") {
        return trim ? content.trim() : content;
    }

    if (Array.isArray(content)) {
        const text = content
            .filter(
                (item) =>
                    item?.type === "text" && typeof item.text === "string",
            )
            .map((item) => item.text)
            .join("");

        return trim ? text.trim() : text;
    }

    return "";
}

function readSseData(event) {
    return event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim();
}

function parseTimeoutMs(value, fallbackMs) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallbackMs;
    }

    return Math.trunc(parsed);
}

function startAbortTimer(controller, timeoutMs) {
    if (timeoutMs <= 0) {
        return null;
    }

    return setTimeout(() => controller.abort(), timeoutMs);
}

function createLinkedAbortController(externalSignal) {
    const controller = new AbortController();

    if (!externalSignal) {
        return {
            controller,
            detach() {},
        };
    }

    const abortFromExternalSignal = () => {
        controller.abort(externalSignal.reason);
    };

    if (externalSignal.aborted) {
        abortFromExternalSignal();
    } else {
        externalSignal.addEventListener("abort", abortFromExternalSignal, {
            once: true,
        });
    }

    return {
        controller,
        detach() {
            externalSignal.removeEventListener(
                "abort",
                abortFromExternalSignal,
            );
        },
    };
}

function isAbortError(error) {
    return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function clearAbortTimer(timeout) {
    if (timeout) {
        clearTimeout(timeout);
    }
}

function refreshAbortTimer(controller, timeout, timeoutMs) {
    clearAbortTimer(timeout);
    return startAbortTimer(controller, timeoutMs);
}

function configurationError(message) {
    const error = new Error(message);
    error.statusCode = 500;
    error.expose = true;
    return error;
}

function upstreamError(message) {
    const error = new Error(message);
    error.statusCode = 502;
    error.expose = true;
    return error;
}

function timeoutError() {
    const error = new Error("AI request timed out");
    error.statusCode = 504;
    error.expose = true;
    return error;
}

function requestAbortedError() {
    const error = new Error("AI request aborted by client");
    error.statusCode = 499;
    error.expose = true;
    error.code = "CLIENT_ABORTED";
    return error;
}

module.exports = {
    createOpenAiCompatibleClient,
};
