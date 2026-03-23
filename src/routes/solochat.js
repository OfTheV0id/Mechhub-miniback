const express = require("express");
const {
    createSoloChatConversationService,
} = require("../services/solochat/conversation-service");
const { createSoloChatAiService } = require("../services/solochat/ai-service");

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
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

function parseContent(value) {
    const content = String(value || "").trim();

    if (!content) {
        throw badRequest("content is required");
    }

    return content;
}

function sanitizeConversation(conversation) {
    return {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updated_at,
    };
}

function sanitizeMessage(message) {
    return {
        id: message.id,
        conversationId: message.conversation_id,
        role: message.role,
        content: message.content,
        status: message.status,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
    };
}

function writeStreamEvent(res, payload) {
    res.write(`${JSON.stringify(payload)}\n`);
}

function createSoloChatRouter(db) {
    const router = express.Router();
    const conversationService = createSoloChatConversationService(db);
    const aiService = createSoloChatAiService();

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

            await conversationService.deleteConversation({
                conversationId,
                userId,
            });

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

    router.post(
        "/conversations/:conversationId/messages/stream",
        async (req, res, next) => {
            let streamStarted = false;
            let assistantMessage = null;
            let assistantContentBuffer = "";

            try {
                const userId = requireUserId(req);
                const conversationId = parseConversationId(req.params.conversationId);
                const content = parseContent(req.body?.content);
                const conversation = await conversationService.getConversationForUser({
                    conversationId,
                    userId,
                });

                if (!conversation) {
                    throw notFound("Conversation not found");
                }

                await conversationService.createMessage({
                    conversationId,
                    role: "user",
                    content,
                    status: "completed",
                });
                await conversationService.touchConversation(conversationId);

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
