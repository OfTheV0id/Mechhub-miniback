const express = require("express");
const multer = require("multer");
const { toIsoTimestamp } = require("../lib/time");
const {
    createSoloChatConversationService,
} = require("../services/solochat/conversation-service");
const { createSoloChatAiService } = require("../services/solochat/ai-service");
const {
    ALLOWED_IMAGE_MIME_TYPES,
    MAX_UPLOAD_BYTES,
    createSoloChatImageService,
} = require("../services/solochat/image-service");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
    },
    fileFilter(req, file, callback) {
        if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
            callback(badRequest("Unsupported image type"));
            return;
        }

        callback(null, true);
    },
});

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function unauthorized(message) {
    const error = new Error(message);
    error.statusCode = 401;
    return error;
}

function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

function requireUserId(req) {
    if (!req.session.userId) {
        throw unauthorized("Not authenticated");
    }

    return req.session.userId;
}

function parseConversationId(value) {
    const conversationId = Number(value);

    if (!Number.isInteger(conversationId) || conversationId <= 0) {
        throw badRequest("A valid conversationId is required");
    }

    return conversationId;
}

function parseImageId(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const imageId = Number(value);

    if (!Number.isInteger(imageId) || imageId <= 0) {
        throw badRequest("imageId must be a positive integer");
    }

    return imageId;
}

function parseTitle(value) {
    const title = String(value || "").trim();

    if (!title) {
        throw badRequest("title is required");
    }

    if (title.length > 120) {
        throw badRequest("title must be 120 characters or fewer");
    }

    return title;
}

function parseMessageInput(body = {}) {
    if (
        body.content !== undefined &&
        body.content !== null &&
        typeof body.content !== "string"
    ) {
        throw badRequest("content must be a string");
    }

    const content = typeof body.content === "string" ? body.content.trim() : "";
    const imageId = parseImageId(body.imageId);

    if (!content && !imageId) {
        throw badRequest("content or imageId is required");
    }

    return {
        content,
        imageId,
    };
}

function sanitizeConversation(conversation) {
    return {
        id: conversation.id,
        title: conversation.title,
        updatedAt: toIsoTimestamp(conversation.updated_at),
    };
}

function sanitizeAttachment(attachment) {
    return {
        id: attachment.id,
        kind: "image",
        url: `/solochat/images/${attachment.id}`,
        mimeType: attachment.mime_type,
        width: attachment.width,
        height: attachment.height,
        sizeBytes: attachment.size_bytes,
        createdAt: toIsoTimestamp(attachment.created_at),
    };
}

function sanitizeMessage(message) {
    return {
        id: message.id,
        conversationId: message.conversation_id,
        role: message.role,
        content: message.content,
        status: message.status,
        attachments: (message.attachments || []).map(sanitizeAttachment),
        createdAt: toIsoTimestamp(message.created_at),
        updatedAt: toIsoTimestamp(message.updated_at),
    };
}

function sanitizeImageUpload(image) {
    return {
        id: image.id,
        url: `/solochat/images/${image.id}`,
        mimeType: image.mime_type,
        width: image.width,
        height: image.height,
        sizeBytes: image.size_bytes,
        createdAt: toIsoTimestamp(image.created_at),
    };
}

function writeStreamEvent(res, payload) {
    res.write(`${JSON.stringify(payload)}\n`);
}

function singleFileUpload(req, res) {
    return new Promise((resolve, reject) => {
        upload.single("image")(req, res, (error) => {
            if (!error) {
                resolve();
                return;
            }

            if (error instanceof multer.MulterError) {
                if (error.code === "LIMIT_FILE_SIZE") {
                    reject(badRequest("Image exceeds the 20MB upload limit"));
                    return;
                }

                reject(badRequest("Image upload failed"));
                return;
            }

            reject(error);
        });
    });
}

function createSoloChatRouter(db) {
    const router = express.Router();
    const conversationService = createSoloChatConversationService(db);
    const imageService = createSoloChatImageService(db);
    const aiService = createSoloChatAiService({
        db,
        imageService,
    });

    router.get("/conversations", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const conversations = await conversationService.listConversationsForUser(
                userId,
            );

            return res.json(conversations.map(sanitizeConversation));
        } catch (error) {
            return next(error);
        }
    });

    router.post("/conversations", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const conversation = await conversationService.createConversation({
                userId,
            });

            return res.status(201).json(sanitizeConversation(conversation));
        } catch (error) {
            return next(error);
        }
    });

    router.patch("/conversations/:conversationId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const conversationId = parseConversationId(req.params.conversationId);
            const title = parseTitle(req.body?.title);
            const conversation = await conversationService.getConversationForUser({
                conversationId,
                userId,
            });

            if (!conversation) {
                throw notFound("Conversation not found");
            }

            const updatedConversation =
                await conversationService.updateConversationTitle({
                    conversationId,
                    title,
                });

            return res.json(sanitizeConversation(updatedConversation));
        } catch (error) {
            return next(error);
        }
    });

    router.delete("/conversations/:conversationId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const conversationId = parseConversationId(req.params.conversationId);
            const conversation = await conversationService.getConversationForUser({
                conversationId,
                userId,
            });

            if (!conversation) {
                throw notFound("Conversation not found");
            }

            const images = await imageService.listImagesForConversation(conversationId);
            await conversationService.deleteConversation({
                conversationId,
                userId,
            });
            await imageService.deleteStoredFiles(images);

            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    router.get("/conversations/:conversationId/messages", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const conversationId = parseConversationId(req.params.conversationId);
            const conversation = await conversationService.getConversationForUser({
                conversationId,
                userId,
            });

            if (!conversation) {
                throw notFound("Conversation not found");
            }

            const messages = await conversationService.listMessages(conversationId);
            return res.json(messages.map(sanitizeMessage));
        } catch (error) {
            return next(error);
        }
    });

    router.post("/uploads/images", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            await imageService.purgeStaleUnattachedImages({ userId });
            await singleFileUpload(req, res);
            const image = await imageService.processUpload({
                userId,
                file: req.file,
            });

            return res.status(201).json(sanitizeImageUpload(image));
        } catch (error) {
            return next(error);
        }
    });

    router.get("/images/:imageId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const imageId = parseImageId(req.params.imageId);
            const image = await imageService.getImageForUser({
                imageId,
                userId,
            });

            if (!image) {
                throw notFound("Image not found");
            }

            return res.type(image.mime_type).sendFile(image.storage_path);
        } catch (error) {
            return next(error);
        }
    });

    router.delete("/images/:imageId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const imageId = parseImageId(req.params.imageId);
            const deleted = await imageService.deleteUnattachedImageForUser({
                imageId,
                userId,
            });

            if (!deleted) {
                throw notFound("Image not found");
            }

            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    router.post(
        "/conversations/:conversationId/messages/stream",
        async (req, res, next) => {
            let streamStarted = false;
            let assistantMessage = null;
            let assistantContentBuffer = "";
            let transactionStarted = false;

            try {
                const userId = requireUserId(req);
                const conversationId = parseConversationId(req.params.conversationId);
                const { content, imageId } = parseMessageInput(req.body);
                const conversation = await conversationService.getConversationForUser({
                    conversationId,
                    userId,
                });

                if (!conversation) {
                    throw notFound("Conversation not found");
                }

                if (imageId) {
                    const image = await imageService.getImageForUser({
                        imageId,
                        userId,
                    });

                    if (!image || image.message_id) {
                        throw badRequest("imageId is invalid or has already been used");
                    }
                }

                await imageService.purgeStaleUnattachedImages({ userId });
                await db.exec("BEGIN IMMEDIATE TRANSACTION");
                transactionStarted = true;

                const userMessage = await conversationService.createMessage({
                    conversationId,
                    role: "user",
                    content,
                    status: "completed",
                });

                if (imageId) {
                    await imageService.attachImageToMessage({
                        imageId,
                        userId,
                        messageId: userMessage.id,
                    });
                }

                await conversationService.touchConversation(conversationId);
                await db.exec("COMMIT");
                transactionStarted = false;

                const history = await conversationService.listMessages(conversationId);
                assistantMessage = await conversationService.createMessage({
                    conversationId,
                    role: "assistant",
                    content: "",
                    status: "streaming",
                });

                res.status(200);
                res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache, no-transform");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders();
                streamStarted = true;

                writeStreamEvent(res, {
                    type: "assistant_start",
                    message: sanitizeMessage(assistantMessage),
                });

                const { assistantContent, nextTitle } =
                    await aiService.streamAssistantTurn({
                        conversation,
                        messages: history,
                        onDelta(delta) {
                            assistantContentBuffer += delta;
                            writeStreamEvent(res, {
                                type: "assistant_delta",
                                messageId: assistantMessage.id,
                                delta,
                            });
                        },
                    });

                assistantMessage = await conversationService.updateMessage({
                    messageId: assistantMessage.id,
                    content: assistantContent || assistantContentBuffer,
                    status: "completed",
                });

                await conversationService.touchConversation(conversationId);

                if (nextTitle) {
                    const updatedConversation =
                        await conversationService.updateConversationTitle({
                            conversationId,
                            title: nextTitle,
                        });

                    writeStreamEvent(res, {
                        type: "conversation_title",
                        conversation: sanitizeConversation(updatedConversation),
                    });
                }

                writeStreamEvent(res, {
                    type: "assistant_done",
                    message: sanitizeMessage(assistantMessage),
                });

                return res.end();
            } catch (error) {
                if (transactionStarted) {
                    try {
                        await db.exec("ROLLBACK");
                    } catch (rollbackError) {
                        error.rollbackError = rollbackError;
                    }
                }

                if (streamStarted) {
                    if (assistantMessage) {
                        assistantMessage = await conversationService.updateMessage({
                            messageId: assistantMessage.id,
                            content: assistantContentBuffer,
                            status: "failed",
                        });
                    }

                    writeStreamEvent(res, {
                        type: "assistant_error",
                        message: error.message || "AI stream failed",
                        assistantMessage: assistantMessage
                            ? sanitizeMessage(assistantMessage)
                            : null,
                    });
                    return res.end();
                }

                return next(error);
            }
        },
    );

    return router;
}

module.exports = {
    createSoloChatRouter,
};
