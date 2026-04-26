const { createOpenAiCompatibleClient } = require("./openai-client");
const { createGeminiClient } = require("./gemini-client");

function isGeminiEnabled() {
    return Boolean(process.env.GEMINI_API_KEY);
}

function createChatClient(options = {}) {
    if (isGeminiEnabled()) {
        return createGeminiClient({
            defaultModel:
                options.defaultModel ??
                process.env.GEMINI_CHAT_MODEL ??
                process.env.GEMINI_MODEL,
        });
    }

    return createOpenAiCompatibleClient({
        defaultModel:
            options.defaultModel ??
            process.env.OPENAI_CHAT_MODEL ??
            process.env.OPENAI_MODEL,
    });
}

function createGradingClient(options = {}) {
    if (isGeminiEnabled()) {
        return createGeminiClient({
            defaultModel:
                options.defaultModel ??
                process.env.GEMINI_GRADING_MODEL ??
                process.env.GEMINI_MODEL,
        });
    }

    return createOpenAiCompatibleClient({
        defaultModel:
            options.defaultModel ??
            process.env.OPENAI_GRADING_MODEL ??
            process.env.OPENAI_MODEL,
    });
}

module.exports = {
    isGeminiEnabled,
    createChatClient,
    createGradingClient,
};
