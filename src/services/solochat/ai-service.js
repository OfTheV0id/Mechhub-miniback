const { createOpenAiCompatibleClient } = require("./openai-client");

function createSoloChatAiService(options = {}) {
    const client = options.client || createOpenAiCompatibleClient();
    const attachmentService = options.attachmentService || null;

    async function streamAssistantTurn({ conversation, messages, onDelta }) {
        let assistantContent = "";
        const replyMessages = await buildReplyMessages(
            messages,
            attachmentService,
        );

        for await (const delta of client.streamChatCompletion({
            messages: replyMessages,
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

async function buildReplyMessages(messages, attachmentService) {
    const replyMessages = [
        {
            role: "system",
            content:
                "You are MechHub SoloChat, a concise mechanics learning assistant. Give direct, accurate help for engineering and study questions. Prefer clear steps and practical explanation over long essays.",
        },
    ];

    for (const message of messages) {
        replyMessages.push({
            role: message.role,
            content: await buildMessageContent(message, attachmentService),
        });
    }

    return replyMessages;
}

async function buildMessageContent(message, attachmentService) {
    const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : [];

    if (!attachments.length) {
        return message.content;
    }

    if (!attachmentService) {
        throw new Error(
            "Attachment service is required for multimodal messages",
        );
    }

    const content = [];
    const textContent = String(message.content || "").trim();

    if (textContent) {
        content.push({
            type: "text",
            text: textContent,
        });
    }

    for (const attachment of attachments) {
        if (attachment.kind === "document") {
            const documentText =
                await attachmentService.readTextContent(attachment);

            if (!documentText) {
                continue;
            }

            content.push({
                type: "text",
                text: `Document: ${attachment.file_name}\n${documentText}`,
            });
            continue;
        }

        content.push({
            type: "image_url",
            image_url: {
                url: await attachmentService.buildDataUrl(attachment),
            },
        });
    }

    return content;
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
    return (
        String(value || "")
            .replace(/^["'\s]+|["'\s]+$/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60) || "New Chat"
    );
}

module.exports = {
    createSoloChatAiService,
};
