const { createOpenAiCompatibleClient } = require("./openai-client");

const TITLE_MAX_LENGTH = 60;
const TITLE_PROMPT =
    "请根据用户的首发消息生成一个简短自然的中文对话标题。标题要概括实际主题，不要返回“对话标题生成”“聊天标题”“会话标题”“新对话”这类泛化标题。只返回标题本身，不加引号，不超过10个字。";
const TITLE_TEXT_LIMIT = 200;
const TITLE_DOCUMENT_TEXT_LIMIT = 800;
const GENERIC_TITLES = new Set([
    "标题",
    "中文标题",
    "标题生成",
    "生成标题",
    "对话标题",
    "对话标题生成",
    "生成对话标题",
    "聊天标题",
    "生成聊天标题",
    "会话标题",
    "生成会话标题",
    "新对话",
    "新聊天",
    "新会话",
    "newchat",
    "chattitle",
    "conversationtitle",
    "title",
]);

function createSoloChatAiService(options = {}) {
    const client = options.client || createOpenAiCompatibleClient();
    const attachmentService = options.attachmentService || null;

    async function streamAssistantTurn({
        conversation,
        messages,
        onDelta,
        signal,
    }) {
        let assistantContent = "";
        const replyMessages = await buildReplyMessages(
            messages,
            attachmentService,
        );

        for await (const delta of client.streamChatCompletion({
            messages: replyMessages,
            temperature: 0.6,
            signal,
        })) {
            assistantContent += delta;

            if (onDelta) {
                await onDelta(delta);
            }
        }

        let nextTitle = null;

        if (signal?.aborted) {
            return {
                assistantContent: assistantContent.trim(),
                nextTitle,
            };
        }

        if (conversation.title === "New Chat") {
            try {
                nextTitle = normalizeTitle(
                    await client.createChatCompletion({
                        messages: await buildTitleMessages(
                            messages,
                            attachmentService,
                        ),
                        temperature: 0.2,
                        maxTokens: 24,
                        signal,
                    }),
                );

                if (!nextTitle) {
                    nextTitle = buildFallbackTitle(messages);
                }
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
            content: "Your name is MechHub SoloChat.",
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
        if (attachment.kind === "text") {
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

async function buildTitleMessages(messages, attachmentService) {
    const firstUserMessage = messages.find((message) => message.role === "user");
    const firstTurnContent = await buildTitleContextContent(
        firstUserMessage,
        attachmentService,
    );

    return [
        {
            role: "system",
            content: TITLE_PROMPT,
        },
        {
            role: "user",
            content: firstTurnContent,
        },
    ];
}

async function buildTitleContextContent(message, attachmentService) {
    if (!message) {
        return `${TITLE_PROMPT}\n\n用户首发消息为空。`;
    }

    const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : [];
    const blocks = [
        {
            type: "text",
            text: "以下是用户发起对话时提供的首条消息与附件，请基于实际内容生成标题：",
        },
    ];
    const textContent = normalizeWhitespace(message.content);

    if (textContent) {
        blocks.push({
            type: "text",
            text: `用户文本：\n${truncateText(textContent, TITLE_TEXT_LIMIT)}`,
        });
    }

    for (const attachment of attachments) {
        const fileName = normalizeWhitespace(attachment?.file_name || "未命名附件");

        if (attachment?.kind === "text") {
            const documentText = await readAttachmentTextSafe({
                attachment,
                attachmentService,
            });

            blocks.push({
                type: "text",
                text: documentText
                    ? `文档附件《${fileName}》：\n${truncateText(documentText, TITLE_DOCUMENT_TEXT_LIMIT)}`
                    : `文档附件：${fileName}`,
            });
            continue;
        }

        if (attachment?.kind === "image") {
            blocks.push({
                type: "text",
                text: `图片附件：${fileName}`,
            });

            const imageUrl = await buildAttachmentDataUrlSafe({
                attachment,
                attachmentService,
            });

            if (imageUrl) {
                blocks.push({
                    type: "image_url",
                    image_url: {
                        url: imageUrl,
                    },
                });
            }
        }
    }

    if (blocks.length === 1) {
        return `${TITLE_PROMPT}\n\n用户首发消息为空。`;
    }

    return blocks;
}

async function readAttachmentTextSafe({ attachment, attachmentService }) {
    if (!attachmentService?.readTextContent) {
        return "";
    }

    try {
        return normalizeWhitespace(
            await attachmentService.readTextContent(attachment),
        );
    } catch (error) {
        return "";
    }
}

async function buildAttachmentDataUrlSafe({ attachment, attachmentService }) {
    if (!attachmentService?.buildDataUrl) {
        return "";
    }

    try {
        return await attachmentService.buildDataUrl(attachment);
    } catch (error) {
        return "";
    }
}

function buildFallbackTitle(messages) {
    const firstUserMessage = messages.find((message) => message.role === "user");
    const fallbackFromText = buildFallbackTitleFromText(
        firstUserMessage?.content,
    );

    if (fallbackFromText) {
        return fallbackFromText;
    }

    const fallbackFromAttachment = buildFallbackTitleFromAttachments(
        firstUserMessage?.attachments,
    );

    if (fallbackFromAttachment) {
        return fallbackFromAttachment;
    }

    return "新对话";
}

function buildFallbackTitleFromText(value) {
    const normalized = normalizeWhitespace(value);

    if (!normalized) {
        return "";
    }

    const candidate =
        normalized
            .split(/[\n。！？!?；;，,]/)
            .map((part) => part.trim())
            .find(Boolean) || normalized;

    return normalizeTitle(truncateText(candidate, 10));
}

function buildFallbackTitleFromAttachments(attachments) {
    if (!Array.isArray(attachments) || !attachments.length) {
        return "";
    }

    const firstNamedAttachment = attachments.find((attachment) =>
        normalizeWhitespace(attachment?.file_name),
    );

    if (!firstNamedAttachment) {
        return "";
    }

    const normalizedFileName = normalizeWhitespace(
        firstNamedAttachment.file_name,
    )
        .replace(/\.[^.]+$/, "")
        .trim();

    return normalizeTitle(truncateText(normalizedFileName, 10));
}

function normalizeTitle(value) {
    const normalized = normalizeWhitespace(value)
        .replace(/^["'“”‘’《》「」『』]+|["'“”‘’《》「」『』]+$/g, "")
        .trim()
        .slice(0, TITLE_MAX_LENGTH);

    if (!normalized || isGenericTitle(normalized)) {
        return "";
    }

    return normalized;
}

function isGenericTitle(value) {
    const compact = String(value || "")
        .toLowerCase()
        .replace(/[\s"'“”‘’《》「」『』:：,，。.!?！？()（）\-_/\\]+/g, "");

    if (!compact) {
        return true;
    }

    return GENERIC_TITLES.has(compact);
}

function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, limit) {
    const normalized = normalizeWhitespace(value);

    if (!normalized) {
        return "";
    }

    if (normalized.length <= limit) {
        return normalized;
    }

    return `${normalized.slice(0, Math.max(1, limit - 1)).trim()}…`;
}

module.exports = {
    createSoloChatAiService,
};
