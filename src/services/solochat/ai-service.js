const { createOpenAiCompatibleClient } = require("./openai-client");

function createSoloChatAiService(options = {}) {
    const client = options.client || createOpenAiCompatibleClient();

    async function streamAssistantTurn({ conversation, messages, onDelta }) {
        let assistantContent = "";

        for await (const delta of client.streamChatCompletion({
            messages: buildReplyMessages(messages),
            temperature: 0.6,
        })) {
            assistantContent += delta;

            if (onDelta) {
                await onDelta(delta);
            }
        }

        let nextTitle = null;

        if (conversation.title === "New Chat") {
            try {
                nextTitle = normalizeTitle(
                    await client.createChatCompletion({
                        messages: buildTitleMessages(messages),
                        temperature: 0.2,
                        maxTokens: 24,
                    }),
                );
            } catch (error) {
                nextTitle = buildFallbackTitle(messages);
            }
        }

        return {
            assistantContent: assistantContent.trim(),
            nextTitle,
        };
    }

    return {
        streamAssistantTurn,
    };
}

function buildReplyMessages(messages) {
    return [
        {
            role: "system",
            content:
                "You are MechHub SoloChat, a concise mechanics learning assistant. Give direct, accurate help for engineering and study questions. Prefer clear steps and practical explanation over long essays.",
        },
        ...messages.map((message) => ({
            role: message.role,
            content: message.content,
        })),
    ];
}

function buildTitleMessages(messages) {
    const firstUserMessage =
        messages.find((message) => message.role === "user")?.content || "";

    return [
        {
            role: "system",
            content:
                "Generate a short chat title. Return only the title, with no quotes, within 8 words.",
        },
        {
            role: "user",
            content: `Write a concise title for this mechanics study chat:\n${firstUserMessage}`,
        },
    ];
}

function buildFallbackTitle(messages) {
    const firstUserMessage =
        messages.find((message) => message.role === "user")?.content || "";

    return normalizeTitle(firstUserMessage);
}

function normalizeTitle(value) {
    return String(value || "")
        .replace(/^["'\s]+|["'\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "New Chat";
}

module.exports = {
    createSoloChatAiService,
};
