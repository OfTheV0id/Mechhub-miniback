const { createChatClient } = require("./ai-client-factory");
const {
    createMarkdownMathStreamNormalizer,
} = require("./math-normalizer");

const TITLE_MAX_LENGTH = 60;

function createChatTitleClient() {
    return createChatClient();
}
const SOLOCHAT_SYSTEM_PROMPT = `
你是 MechHub SoloChat，一个面向学生的智能学习助手。
默认使用中文回复，除非用户明确使用其他语言提问。
回答应简洁、准确，适合学生理解。
书写数学公式时使用 KaTeX/LaTeX 语法。
禁止在公式中使用 Unicode 数学符号（如 ⇒ → − ≤ ≥ ≠ × ·），应使用 LaTeX 命令（如 \\Rightarrow \\to - \\le \\ge \\ne \\times \\cdot）。
`.trim();
const TITLE_PROMPT =
    `请根据用户的首发消息生成一个简短自然的中文对话标题。标题要概括实际主题，不要返回”对话标题生成””聊天标题””会话标题””新对话”这类泛化标题。只返回标题本身，不加引号，不超过10个字。`;
const TITLE_TEXT_LIMIT = 200;
const TITLE_DOCUMENT_TEXT_LIMIT = 800;
const GRADING_TITLE_PROMPT = `
为一次作业批改结果生成一个简短的中文标题。
标题应概括批改的题目或核心问题，而不是对话本身。
只返回标题文本，不加引号、标签或 markdown。
不超过 15 个汉字。
`.trim();
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
    const client = options.client || createChatClient();
    const attachmentService = options.attachmentService || null;

    async function streamAssistantTurn({
        conversation,
        messages,
        onDelta,
        signal,
    }) {
        let assistantContent = "";
        const streamNormalizer = createMarkdownMathStreamNormalizer();
        const replyMessages = await buildReplyMessages(
            messages,
            attachmentService,
        );

        for await (const delta of client.streamChatCompletion({
            messages: replyMessages,
            temperature: 0.6,
            signal,
        })) {
            const normalizedDelta = streamNormalizer.pushChunk(delta);
            assistantContent += normalizedDelta;

            if (onDelta && normalizedDelta) {
                await onDelta(normalizedDelta);
            }
        }

        const trailingDelta = streamNormalizer.finish();
        if (trailingDelta) {
            assistantContent += trailingDelta;

            if (onDelta) {
                await onDelta(trailingDelta);
            }
        }

        const nextTitle = signal?.aborted
            ? null
            : await generateConversationTitle({
                  conversation,
                  messages,
                  attachmentService,
                  client,
                  signal,
              });

        return {
            assistantContent: assistantContent.trim(),
            nextTitle,
        };
    }

    return {
        streamAssistantTurn,
    };
}

async function generateConversationTitle({
    conversation,
    messages,
    attachmentService,
    client = createChatTitleClient(),
    signal,
}) {
    if (signal?.aborted || conversation?.title !== "New Chat") {
        return null;
    }

    try {
        const nextTitle = normalizeTitle(
            await client.createChatCompletion({
                messages: await buildTitleMessages(messages, attachmentService),
                temperature: 0.2,
                maxTokens: 24,
                signal,
            }),
        );

        if (nextTitle) {
            return nextTitle;
        }

        return buildFallbackTitle(messages);
    } catch (error) {
        return buildFallbackTitle(messages);
    }
}

async function generateGradingTitle({
    promptText = "",
    annotations = [],
    attachmentFileName = "",
    client = createChatTitleClient(),
    signal,
}) {
    try {
        const nextTitle = normalizeTitle(
            await client.createChatCompletion({
                messages: buildGradingTitleMessages({
                    promptText,
                    annotations,
                    attachmentFileName,
                }),
                temperature: 0.2,
                maxTokens: 24,
                signal,
            }),
        );

        if (nextTitle) {
            return truncateText(nextTitle, TITLE_MAX_LENGTH);
        }
    } catch (_error) {
        // Fall through to fallback.
    }

    return buildFallbackGradingTitle({
        promptText,
        annotations,
        attachmentFileName,
    });
}

async function buildReplyMessages(messages, attachmentService) {
    const replyMessages = [
        {
            role: "system",
            content: SOLOCHAT_SYSTEM_PROMPT,
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

function buildGradingTitleMessages({
    promptText,
    annotations,
    attachmentFileName,
}) {
    const parts = [];
    const normalizedPromptText = normalizeWhitespace(promptText);
    const normalizedFileName = normalizeWhitespace(attachmentFileName);

    if (normalizedPromptText) {
        parts.push(`Question prompt: ${truncateText(normalizedPromptText, 200)}`);
    }

    if (normalizedFileName) {
        parts.push(`Attachment: ${normalizedFileName}`);
    }

    const annotationSummary = (Array.isArray(annotations) ? annotations : [])
        .slice(0, 5)
        .map((annotation, index) => {
            const severity = normalizeWhitespace(annotation?.severity || "");
            const commentary = truncateText(annotation?.commentary, 140);
            const recognizedText = truncateText(annotation?.recognizedText, 80);

            return [
                `#${index + 1}`,
                severity ? `[${severity}]` : "",
                commentary,
                recognizedText ? `text: ${recognizedText}` : "",
            ]
                .filter(Boolean)
                .join(" ");
        })
        .filter(Boolean);

    if (annotationSummary.length) {
        parts.push(`Annotations:\n${annotationSummary.join("\n")}`);
    }

    return [
        {
            role: "system",
            content: GRADING_TITLE_PROMPT,
        },
        {
            role: "user",
            content: parts.length
                ? parts.join("\n\n")
                : "No grading context was provided.",
        },
    ];
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

        if (attachment.kind === "document") {
            // Binary document (PDF/DOCX/etc.) — sent as a data URL so the
            // Gemini client can convert it to inline_data. Qianwen will ignore
            // unrecognised content types and this block is unreachable when
            // only text/image attachments are used with that provider.
            content.push({
                type: "image_url",
                image_url: {
                    url: await attachmentService.buildDataUrl(attachment),
                },
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

            continue;
        }

        if (attachment?.kind === "document") {
            blocks.push({
                type: "text",
                text: `文档附件：${fileName}`,
            });
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

function buildFallbackGradingTitle({
    promptText,
    annotations,
    attachmentFileName,
}) {
    const fallbackFromPrompt = buildFallbackTitleFromText(promptText);
    if (fallbackFromPrompt) {
        return fallbackFromPrompt;
    }

    const fallbackFromCommentary = buildFallbackTitleFromText(
        Array.isArray(annotations) && annotations.length
            ? annotations[0]?.commentary
            : "",
    );
    if (fallbackFromCommentary) {
        return fallbackFromCommentary;
    }

    const fallbackFromAttachment = normalizeTitle(
        truncateText(
            normalizeWhitespace(attachmentFileName).replace(/\.[^.]+$/, ""),
            12,
        ),
    );
    if (fallbackFromAttachment) {
        return fallbackFromAttachment;
    }

    return "作业批改结果";
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
    generateConversationTitle,
    generateGradingTitle,
};
