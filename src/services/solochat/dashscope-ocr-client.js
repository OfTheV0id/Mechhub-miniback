const DEFAULT_DASHSCOPE_OCR_BASE_URL =
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DEFAULT_DASHSCOPE_OCR_MODEL = "qwen-vl-ocr-2025-11-20";

function createDashScopeOcrClient(options = {}) {
    const endpoint = normalizeEndpoint(
        options.endpoint ||
            process.env.DASHSCOPE_OCR_URL ||
            process.env.DASHSCOPE_BASE_URL ||
            process.env.OPENAI_BASE_URL,
    );
    const apiKey = String(
        options.apiKey ||
            process.env.DASHSCOPE_API_KEY ||
            process.env.OPENAI_API_KEY ||
            "",
    ).trim();
    const model = String(
        options.model ||
            process.env.DASHSCOPE_OCR_MODEL ||
            process.env.OPENAI_OCR_MODEL ||
            DEFAULT_DASHSCOPE_OCR_MODEL,
    ).trim();

    async function recognizeImage({ imageDataUrl, signal }) {
        if (!apiKey) {
            throw new Error(
                "DASHSCOPE_API_KEY or OPENAI_API_KEY is required for DashScope OCR",
            );
        }

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                input: {
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    image: imageDataUrl,
                                    min_pixels: 32 * 32 * 3,
                                    max_pixels: 32 * 32 * 8192,
                                    enable_rotate: false,
                                },
                            ],
                        },
                    ],
                },
                parameters: {
                    ocr_options: {
                        task: "advanced_recognition",
                    },
                },
            }),
            signal,
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(
                payload?.message ||
                    payload?.error?.message ||
                    `DashScope OCR failed with status ${response.status}`,
            );
        }

        return parseDashScopeOcrPayload(payload);
    }

    return {
        recognizeImage,
    };
}

function parseDashScopeOcrPayload(payload) {
    const content =
        payload?.output?.choices?.[0]?.message?.content ||
        payload?.choices?.[0]?.message?.content;
    const firstContent = Array.isArray(content) ? content[0] : content;
    const ocrResult = firstContent?.ocr_result || firstContent?.ocrResult;
    const wordsInfo =
        ocrResult?.words_info ||
        ocrResult?.wordsInfo ||
        firstContent?.words_info ||
        firstContent?.wordsInfo;

    if (Array.isArray(wordsInfo)) {
        return normalizeDashScopeWordsInfo(wordsInfo);
    }

    const text =
        typeof firstContent === "string"
            ? firstContent
            : firstContent?.text || firstContent?.content || "";
    return normalizeDashScopeWordsInfo(parseJsonFromText(text));
}

function parseJsonFromText(text) {
    const normalized = String(text || "")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "");
    if (!normalized) {
        return [];
    }

    try {
        const parsed = JSON.parse(normalized);
        return Array.isArray(parsed) ? parsed : parsed?.words_info || [];
    } catch (_error) {
        return [];
    }
}

function normalizeDashScopeWordsInfo(wordsInfo) {
    return wordsInfo
        .map((item) => {
            const text = String(item?.text || item?.word || "").trim();
            const location = Array.isArray(item?.location)
                ? item.location
                : null;
            if (!text || !location || location.length < 8) {
                return null;
            }

            const xs = [location[0], location[2], location[4], location[6]]
                .map(Number)
                .filter(Number.isFinite);
            const ys = [location[1], location[3], location[5], location[7]]
                .map(Number)
                .filter(Number.isFinite);
            if (xs.length !== 4 || ys.length !== 4) {
                return null;
            }

            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            const width = maxX - minX;
            const height = maxY - minY;
            if (width <= 0 || height <= 0) {
                return null;
            }

            return {
                text,
                bboxPixels: {
                    x: minX,
                    y: minY,
                    width,
                    height,
                },
            };
        })
        .filter(Boolean);
}

function normalizeEndpoint(value) {
    const normalized = String(value || DEFAULT_DASHSCOPE_OCR_BASE_URL)
        .trim()
        .replace(/\/+$/, "");
    if (normalized.endsWith("/compatible-mode/v1")) {
        return normalized.replace(
            /\/compatible-mode\/v1$/,
            "/api/v1/services/aigc/multimodal-generation/generation",
        );
    }
    if (normalized.endsWith("/api/v1")) {
        return `${normalized}/services/aigc/multimodal-generation/generation`;
    }
    return normalized;
}

module.exports = {
    createDashScopeOcrClient,
};
