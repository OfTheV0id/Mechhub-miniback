function createGeminiClient(options = {}) {
    const baseUrl = normalizeBaseUrl(
        options.baseUrl ||
            process.env.GEMINI_BASE_URL ||
            "https://generativelanguage.googleapis.com",
    );
    const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    const defaultModel = normalizeModel(
        options.defaultModel ?? process.env.GEMINI_CHAT_MODEL ?? process.env.GEMINI_MODEL,
    );
    const timeoutMs = parseTimeoutMs(process.env.GEMINI_TIMEOUT_MS, 30000);
    const streamTimeoutMs = parseTimeoutMs(process.env.GEMINI_STREAM_TIMEOUT_MS, 0);

    async function createChatCompletion({
        messages,
        temperature = 0.7,
        model,
        maxTokens,
        responseMimeType,
        responseSchema,
        thinkingBudget,
        thinkingLevel,
        signal: requestSignal,
    }) {
        const resolvedModel = validateConfig(model);
        const url = resolveGenerateUrl(baseUrl, resolvedModel);
        const { controller, detach } = createLinkedAbortController(requestSignal);
        const timeout = startAbortTimer(controller, timeoutMs);

        try {
            const { systemInstruction, contents } = convertMessages(messages);
            const body = buildRequestBody({
                contents,
                systemInstruction,
                temperature,
                maxTokens,
                responseMimeType,
                responseSchema,
                thinkingBudget,
                thinkingLevel,
            });

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "X-goog-api-key": apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            const payload = await response.json().catch(() => null);

            if (!response.ok) {
                throw upstreamError(
                    payload?.error?.message ||
                        `Gemini request failed with status ${response.status}`,
                );
            }

            const content = extractCandidateText(payload);

            if (!content) {
                throw upstreamError("Gemini response did not include any content");
            }

            return content;
        } catch (error) {
            if (isAbortError(error)) {
                throw requestSignal?.aborted ? requestAbortedError() : timeoutError();
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
        maxTokens,
        responseMimeType,
        responseSchema,
        thinkingBudget,
        thinkingLevel,
        signal: requestSignal,
    }) {
        const resolvedModel = validateConfig(model);
        const url = resolveStreamUrl(baseUrl, resolvedModel);
        const { controller, detach } = createLinkedAbortController(requestSignal);
        let timeout = startAbortTimer(controller, streamTimeoutMs);

        try {
            const { systemInstruction, contents } = convertMessages(messages);
            const body = buildRequestBody({
                contents,
                systemInstruction,
                temperature,
                maxTokens,
                responseMimeType,
                responseSchema,
                thinkingBudget,
                thinkingLevel,
            });

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "X-goog-api-key": apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw upstreamError(
                    payload?.error?.message ||
                        `Gemini stream failed with status ${response.status}`,
                );
            }

            if (!response.body) {
                throw upstreamError("Gemini stream did not include a response body");
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                timeout = refreshAbortTimer(controller, timeout, streamTimeoutMs);

                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
                const events = buffer.split("\n\n");
                buffer = events.pop() || "";

                for (const event of events) {
                    const data = readSseData(event);

                    if (!data || data === "[DONE]") {
                        continue;
                    }

                    const payload = JSON.parse(data);
                    const delta = extractCandidateText(payload);

                    if (delta) {
                        yield delta;
                    }
                }
            }

            const finalData = readSseData(buffer);

            if (finalData && finalData !== "[DONE]") {
                const payload = JSON.parse(finalData);
                const delta = extractCandidateText(payload);

                if (delta) {
                    yield delta;
                }
            }
        } catch (error) {
            if (isAbortError(error)) {
                throw requestSignal?.aborted ? requestAbortedError() : timeoutError();
            }

            throw error;
        } finally {
            clearAbortTimer(timeout);
            detach();
        }
    }

    function validateConfig(model) {
        if (!apiKey) {
            throw configurationError("GEMINI_API_KEY is required");
        }

        const resolvedModel = model || defaultModel;

        if (!resolvedModel) {
            throw configurationError("A Gemini model is required");
        }

        return resolvedModel;
    }

    return {
        provider: "gemini",
        createChatCompletion,
        streamChatCompletion,
    };
}

function buildRequestBody({
    contents,
    systemInstruction,
    temperature,
    maxTokens,
    responseMimeType,
    responseSchema,
    thinkingBudget,
    thinkingLevel,
}) {
    const generationConfig = {
        temperature,
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        ...(responseMimeType ? { responseMimeType } : {}),
        ...(responseSchema ? { responseSchema } : {}),
    };
    const resolvedThinkingLevel = normalizeThinkingLevel(
        thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL,
    );
    const resolvedThinkingBudget = parseOptionalInteger(
        thinkingBudget ?? process.env.GEMINI_THINKING_BUDGET,
    );

    if (resolvedThinkingLevel) {
        generationConfig.thinkingConfig = {
            thinkingLevel: resolvedThinkingLevel,
        };
    } else if (resolvedThinkingBudget !== null) {
        generationConfig.thinkingConfig = {
            thinkingBudget: resolvedThinkingBudget,
            includeThoughts: false,
        };
    }

    return {
        contents,
        generationConfig,
        ...(systemInstruction ? { systemInstruction } : {}),
    };
}

// Converts OpenAI-format messages to Gemini `contents` + optional `systemInstruction`.
function convertMessages(messages) {
    let systemInstruction = null;
    const contents = [];

    for (const message of messages) {
        if (message.role === "system") {
            const text = extractPlainText(message.content);

            if (text) {
                systemInstruction = { parts: [{ text }] };
            }

            continue;
        }

        const role = message.role === "assistant" ? "model" : "user";
        const parts = convertContentToParts(message.content);

        if (parts.length) {
            contents.push({ role, parts });
        }
    }

    return { systemInstruction, contents };
}

function convertContentToParts(content) {
    if (typeof content === "string") {
        return content.trim() ? [{ text: content }] : [];
    }

    if (!Array.isArray(content)) {
        return [];
    }

    const parts = [];

    for (const item of content) {
        if (item.type === "text" && item.text) {
            parts.push({ text: item.text });
            continue;
        }

        if (item.type === "image_url" && item.image_url?.url) {
            const url = item.image_url.url;
            const inlinePart = tryParseDataUrl(url);

            if (inlinePart) {
                parts.push(inlinePart);
            } else {
                parts.push({ file_data: { file_uri: url } });
            }
        }
    }

    return parts;
}

// Parses "data:<mimeType>;base64,<data>" into a Gemini inline_data part.
function tryParseDataUrl(url) {
    if (!url.startsWith("data:")) {
        return null;
    }

    const commaIdx = url.indexOf(",");

    if (commaIdx < 0) {
        return null;
    }

    const header = url.slice(5, commaIdx);
    const data = url.slice(commaIdx + 1);
    const semicolonIdx = header.indexOf(";");
    const mimeType = semicolonIdx >= 0 ? header.slice(0, semicolonIdx) : header;
    const encoding = semicolonIdx >= 0 ? header.slice(semicolonIdx + 1) : "";

    if (encoding !== "base64" || !mimeType) {
        return null;
    }

    return { inline_data: { mime_type: mimeType, data } };
}

function extractPlainText(content) {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .filter((item) => item.type === "text" && typeof item.text === "string")
            .map((item) => item.text)
            .join("");
    }

    return "";
}

function extractCandidateText(payload) {
    const parts = payload?.candidates?.[0]?.content?.parts;

    if (!Array.isArray(parts)) {
        return "";
    }

    return parts
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text)
        .join("");
}

function resolveGenerateUrl(baseUrl, model) {
    return `${baseUrl}/v1beta/models/${model}:generateContent`;
}

function resolveStreamUrl(baseUrl, model) {
    return `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse`;
}

function normalizeBaseUrl(value) {
    return String(value || "")
        .trim()
        .replace(/\/+$/, "");
}

function normalizeModel(value) {
    return String(value || "").trim();
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

function parseOptionalInteger(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
        return null;
    }

    return Math.trunc(parsed);
}

function normalizeThinkingLevel(value) {
    const normalized = String(value || "")
        .trim()
        .toLowerCase();

    return ["minimal", "low", "medium", "high"].includes(normalized)
        ? normalized
        : "";
}

function startAbortTimer(controller, timeoutMs) {
    if (timeoutMs <= 0) {
        return null;
    }

    return setTimeout(() => controller.abort(), timeoutMs);
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

function createLinkedAbortController(externalSignal) {
    const controller = new AbortController();

    if (!externalSignal) {
        return { controller, detach() {} };
    }

    const abortFromExternal = () => {
        controller.abort(externalSignal.reason);
    };

    if (externalSignal.aborted) {
        abortFromExternal();
    } else {
        externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }

    return {
        controller,
        detach() {
            externalSignal.removeEventListener("abort", abortFromExternal);
        },
    };
}

function isAbortError(error) {
    return error?.name === "AbortError" || error?.code === "ABORT_ERR";
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
    const error = new Error("Gemini request timed out");
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
    createGeminiClient,
};
