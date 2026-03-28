const fs = require("node:fs/promises");
const express = require("express");
const multer = require("multer");
const { withImmediateTransaction } = require("../lib/db");
const { toIsoTimestamp } = require("../lib/time");
const {
    createSoloChatConversationService,
} = require("../services/solochat/conversation-service");
const { createSoloChatAiService } = require("../services/solochat/ai-service");
const {
    createFileService,
    FILE_PURPOSES,
    MAX_UPLOAD_BYTES,
} = require("../services/uploads/file-service");

const MAX_SOLOCHAT_ATTACHMENTS = 4;
const solochatUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_SOLOCHAT_ATTACHMENTS,
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

function unsupportedMediaType(message) {
    const error = new Error(message);
    error.statusCode = 415;
    error.expose = true;
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

function parseStreamMessageInput(req) {
    if (!req.is("multipart/form-data")) {
        throw unsupportedMediaType(
            "Content-Type must be multipart/form-data",
        );
    }

    const body = req.body || {};
    const uploadedFiles = normalizeMultipartFiles(req.files);

    if (
        body.content !== undefined &&
        body.content !== null &&
        typeof body.content !== "string"
    ) {
        throw badRequest("content must be a string");
    }

    const content = typeof body.content === "string" ? body.content.trim() : "";

    if (!content && !uploadedFiles.length) {
        throw badRequest("content or attachments is required");
    }

    return {
        content,
        uploadedFiles,
    };
}

function normalizeMultipartFiles(files) {
    if (!files) {
        return [];
    }

    const uploadedFiles = [
        ...(Array.isArray(files.attachments) ? files.attachments : []),
        ...(Array.isArray(files["attachments[]"])
            ? files["attachments[]"]
            : []),
    ];

    if (uploadedFiles.length > MAX_SOLOCHAT_ATTACHMENTS) {
        throw badRequest(
            `attachments must contain ${MAX_SOLOCHAT_ATTACHMENTS} files or fewer`,
        );
    }

    return uploadedFiles;
}

function parseSoloChatUpload(req, res) {
    return new Promise((resolve, reject) => {
        solochatUpload.fields([
            {
                name: "attachments",
                maxCount: MAX_SOLOCHAT_ATTACHMENTS,
            },
            {
                name: "attachments[]",
                maxCount: MAX_SOLOCHAT_ATTACHMENTS,
            },
        ])(req, res, (error) => {
            if (!error) {
                resolve();
                return;
            }

            if (error instanceof multer.MulterError) {
                if (error.code === "LIMIT_FILE_SIZE") {
                    reject(badRequest("Each attachment must be 20MB or smaller"));
                    return;
                }

                if (error.code === "LIMIT_FILE_COUNT") {
                    reject(
                        badRequest(
                            `attachments must contain ${MAX_SOLOCHAT_ATTACHMENTS} files or fewer`,
                        ),
                    );
                    return;
                }

                if (error.code === "LIMIT_UNEXPECTED_FILE") {
                    reject(
                        badRequest(
                            'attachments must be uploaded under the "attachments" field',
                        ),
                    );
                    return;
                }

                reject(badRequest("Attachment upload failed"));
                return;
            }

            reject(error);
        });
    });
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
        kind: attachment.kind,
        purpose: attachment.purpose,
        fileName: attachment.file_name,
        url: `/uploads/files/${attachment.id}`,
        mimeType: attachment.mime_type,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
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

function writeStreamEvent(res, payload) {
    res.write(`${JSON.stringify(payload)}\n`);
}

async function deleteStoredAttachments(attachments) {
    await Promise.all(
        attachments.map(async (attachment) => {
            try {
                await fs.unlink(attachment.storage_path);
            } catch (error) {
                if (error?.code !== "ENOENT") {
                    throw error;
                }
            }
        }),
    );
}

function createSoloChatRouter(db) {
    const router = express.Router();
    const conversationService = createSoloChatConversationService(db);
    const fileService = createFileService(db);
    const aiService = createSoloChatAiService({
        db,
        attachmentService: fileService,
    });

    router.get("/conversations", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const conversations =
                await conversationService.listConversationsForUser(userId);

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
            const conversationId = parseConversationId(
                req.params.conversationId,
            );
            const title = parseTitle(req.body?.title);
            const conversation =
                await conversationService.getConversationForUser({
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
            const conversationId = parseConversationId(
                req.params.conversationId,
            );
            const conversation =
                await conversationService.getConversationForUser({
                    conversationId,
                    userId,
                });

            if (!conversation) {
                throw notFound("Conversation not found");
            }

            const attachments =
                await fileService.listFilesForConversation(conversationId);
            await conversationService.deleteConversation({
                conversationId,
                userId,
            });

            if (attachments.length) {
                const placeholders = attachments.map(() => "?").join(", ");
                await db.run(
                    `DELETE FROM uploaded_files WHERE id IN (${placeholders})`,
                    ...attachments.map((attachment) => attachment.id),
                );
                await deleteStoredAttachments(attachments);
            }

            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    router.get(
        "/conversations/:conversationId/messages",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const conversationId = parseConversationId(
                    req.params.conversationId,
                );
                const conversation =
                    await conversationService.getConversationForUser({
                        conversationId,
                        userId,
                    });

                if (!conversation) {
                    throw notFound("Conversation not found");
                }

                const messages =
                    await conversationService.listMessages(conversationId);
                return res.json(messages.map(sanitizeMessage));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.post(
        "/conversations/:conversationId/messages/stream",
        async (req, res, next) => {
            let streamStarted = false;
            let userMessage = null;
            let assistantMessage = null;
            let assistantContentBuffer = "";
            let createdAttachments = [];
            let userMessageStored = false;
            let streamAbortController = null;
            let streamAbortedByClient = false;

            const abortStream = () => {
                streamAbortedByClient = true;

                if (streamAbortController && !streamAbortController.signal.aborted) {
                    streamAbortController.abort();
                }
            };

            const handleResponseClose = () => {
                if (!res.writableEnded) {
                    abortStream();
                }
            };

            try {
                const userId = requireUserId(req);
                const conversationId = parseConversationId(
                    req.params.conversationId,
                );

                await parseSoloChatUpload(req, res);

                const { content, uploadedFiles } = parseStreamMessageInput(req);
                const conversation =
                    await conversationService.getConversationForUser({
                        conversationId,
                        userId,
                    });

                if (!conversation) {
                    throw notFound("Conversation not found");
                }

                streamAbortController = new AbortController();
                req.on("aborted", abortStream);
                res.on("close", handleResponseClose);

                await withImmediateTransaction(async (txDb) => {
                    const txConversationService =
                        createSoloChatConversationService(txDb);
                    const txFileService = createFileService(txDb);
                    userMessage = await txConversationService.createMessage({
                            conversationId,
                            role: "user",
                            content,
                            status: "completed",
                        });

                    if (uploadedFiles.length) {
                        createdAttachments = [];

                        for (const uploadedFile of uploadedFiles) {
                            createdAttachments.push(
                                await txFileService.processUpload({
                                    userId,
                                    file: uploadedFile,
                                    purpose: FILE_PURPOSES.SOLOCHAT,
                                }),
                            );
                        }
                    }

                    if (createdAttachments.length) {
                        await txFileService.attachFilesToSoloChatMessage({
                            messageId: userMessage.id,
                            fileIds: createdAttachments.map(
                                (attachment) => attachment.id,
                            ),
                            userId,
                        });
                    }

                    await txConversationService.touchConversation(
                        conversationId,
                    );
                });
                userMessageStored = true;
                userMessage = await conversationService.getMessageById(
                    userMessage.id,
                );

                const history =
                    await conversationService.listMessages(conversationId);
                assistantMessage = await conversationService.createMessage({
                    conversationId,
                    role: "assistant",
                    content: "",
                    status: "streaming",
                });

                res.status(200);
                res.setHeader(
                    "Content-Type",
                    "application/x-ndjson; charset=utf-8",
                );
                res.setHeader("Cache-Control", "no-cache, no-transform");
                res.setHeader("Connection", "keep-alive");
                res.flushHeaders();
                streamStarted = true;

                writeStreamEvent(res, {
                    type: "user_input",
                    message: sanitizeMessage(userMessage),
                });

                writeStreamEvent(res, {
                    type: "assistant_start",
                    message: sanitizeMessage(assistantMessage),
                });

                const { assistantContent, nextTitle } =
                    await aiService.streamAssistantTurn({
                        conversation,
                        messages: history,
                        signal: streamAbortController.signal,
                        onDelta(delta) {
                            assistantContentBuffer += delta;

                            if (res.writableEnded || res.destroyed) {
                                abortStream();
                                return;
                            }

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

                if (nextTitle && !streamAbortController.signal.aborted) {
                    const updatedConversation =
                        await conversationService.updateConversationTitle({
                            conversationId,
                            title: nextTitle,
                        });

                    if (!res.writableEnded && !res.destroyed) {
                        writeStreamEvent(res, {
                            type: "conversation_title",
                            conversation: sanitizeConversation(updatedConversation),
                        });
                    }
                }

                if (!res.writableEnded && !res.destroyed) {
                    writeStreamEvent(res, {
                        type: "assistant_done",
                        message: sanitizeMessage(assistantMessage),
                    });
                }

                return res.end();
            } catch (error) {
                if (!streamStarted && !userMessageStored && createdAttachments.length) {
                    await deleteStoredAttachments(createdAttachments);
                }

                if (streamStarted) {
                    if (assistantMessage) {
                        assistantMessage =
                            await conversationService.updateMessage({
                                messageId: assistantMessage.id,
                                content: assistantContentBuffer,
                                status: "failed",
                            });
                    }

                    if (!streamAbortedByClient && !res.writableEnded && !res.destroyed) {
                        writeStreamEvent(res, {
                            type: "assistant_error",
                            message: error.message || "AI stream failed",
                            assistantMessage: assistantMessage
                                ? sanitizeMessage(assistantMessage)
                                : null,
                        });
                    }

                    if (!res.writableEnded && !res.destroyed) {
                        return res.end();
                    }

                    return undefined;
                }

                if (error?.code === "CLIENT_ABORTED") {
                    return res.status(499).end();
                }

                return next(error);
            } finally {
                req.off("aborted", abortStream);
                res.off("close", handleResponseClose);
            }
        },
    );

    return router;
}

module.exports = {
    createSoloChatRouter,
};
