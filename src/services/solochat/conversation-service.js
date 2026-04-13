const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

function createSoloChatConversationService(db) {
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;

    async function listConversationsForUser(userId) {
        return db.all(
            `SELECT id, user_id, title, created_at, updated_at
             FROM solochat_conversations
             WHERE user_id = ?
             ORDER BY updated_at DESC, id DESC`,
            userId,
        );
    }

    async function createConversation({ userId, title = "New Chat" }) {
        const result = await db.run(
            `INSERT INTO solochat_conversations (
                 user_id,
                 title,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ${nowExpression}, ${nowExpression})`,
            userId,
            title,
        );

        return getConversationById(result.lastID);
    }

    async function getConversationById(conversationId) {
        return db.get(
            `SELECT id, user_id, title, created_at, updated_at
             FROM solochat_conversations
             WHERE id = ?`,
            conversationId,
        );
    }

    async function getConversationForUser({ conversationId, userId }) {
        return db.get(
            `SELECT id, user_id, title, created_at, updated_at
             FROM solochat_conversations
             WHERE id = ? AND user_id = ?`,
            conversationId,
            userId,
        );
    }

    async function listMessages(conversationId) {
        const messages = await db.all(
            `SELECT id, conversation_id, role, type, content, status, created_at, updated_at
             FROM solochat_messages
             WHERE conversation_id = ?
             ORDER BY id ASC`,
            conversationId,
        );

        return hydrateMessages(messages);
    }

    async function createMessage({
        conversationId,
        role,
        type = "text",
        content,
        status = "completed",
    }) {
        const result = await db.run(
            `INSERT INTO solochat_messages (
                 conversation_id,
                 role,
                 type,
                 content,
                 status,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?, ${nowExpression}, ${nowExpression})`,
            conversationId,
            role,
            type,
            content,
            status,
        );

        return getMessageById(result.lastID);
    }

    async function getMessageById(messageId) {
        const message = await db.get(
            `SELECT id, conversation_id, role, type, content, status, created_at, updated_at
             FROM solochat_messages
             WHERE id = ?`,
            messageId,
        );

        if (!message) {
            return null;
        }

        const [hydratedMessage] = await hydrateMessages([message]);
        return hydratedMessage;
    }

    async function updateConversationTitle({ conversationId, title }) {
        await db.run(
            `UPDATE solochat_conversations
             SET title = ?, updated_at = ${nowExpression}
             WHERE id = ?`,
            title,
            conversationId,
        );

        return getConversationById(conversationId);
    }

    async function touchConversation(conversationId) {
        await db.run(
            `UPDATE solochat_conversations
             SET updated_at = ${nowExpression}
             WHERE id = ?`,
            conversationId,
        );
    }

    async function updateMessage({ messageId, content, status, type }) {
        const updates = [];
        const values = [];

        if (content !== undefined) {
            updates.push("content = ?");
            values.push(content);
        }

        if (status !== undefined) {
            updates.push("status = ?");
            values.push(status);
        }

        if (type !== undefined) {
            updates.push("type = ?");
            values.push(type);
        }

        if (!updates.length) {
            return getMessageById(messageId);
        }

        await db.run(
            `UPDATE solochat_messages
             SET ${updates.join(", ")}, updated_at = ${nowExpression}
             WHERE id = ?`,
            ...values,
            messageId,
        );

        return getMessageById(messageId);
    }

    async function deleteConversation({ conversationId, userId }) {
        await db.run(
            `UPDATE solochat_grading_tasks
             SET message_id = NULL
             WHERE conversation_id = ?`,
            conversationId,
        );

        const result = await db.run(
            `DELETE FROM solochat_conversations
             WHERE id = ? AND user_id = ?`,
            conversationId,
            userId,
        );

        return result.changes;
    }

    async function hydrateMessages(messages) {
        const messagesWithAttachments = await attachAttachments(messages);
        return attachGradingSummaries(messagesWithAttachments);
    }

    async function attachAttachments(messages) {
        if (!messages.length) {
            return [];
        }

        const messageIds = messages.map((message) => message.id);
        const placeholders = messageIds.map(() => "?").join(", ");
        const attachments = await db.all(
            `SELECT uf.id, uf.owner_user_id, smf.message_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM solochat_message_files smf
             INNER JOIN uploaded_files uf
                 ON uf.id = smf.file_id
             WHERE smf.message_id IN (${placeholders})
             ORDER BY uf.id ASC`,
            ...messageIds,
        );
        const attachmentsByMessageId = new Map();

        for (const attachment of attachments) {
            const current =
                attachmentsByMessageId.get(attachment.message_id) || [];
            current.push(attachment);
            attachmentsByMessageId.set(attachment.message_id, current);
        }

        return messages.map((message) => ({
            ...message,
            attachments: attachmentsByMessageId.get(message.id) || [],
        }));
    }

    async function attachGradingSummaries(messages) {
        if (!messages.length) {
            return [];
        }

        const gradingMessages = messages.filter(
            (message) => (message.type || "text") === "grading",
        );

        if (!gradingMessages.length) {
            return messages.map((message) => ({
                ...message,
                type: message.type || "text",
                grading: null,
            }));
        }

        const messageIds = gradingMessages.map((message) => message.id);
        const placeholders = messageIds.map(() => "?").join(", ");
        const tasks = await db.all(
            `SELECT id, conversation_id, user_id, message_id, prompt_text, generated_title, status, error_message, selected_image_count, created_at, started_at, completed_at
             FROM solochat_grading_tasks
             WHERE message_id IN (${placeholders})`,
            ...messageIds,
        );
        const taskIds = tasks.map((task) => task.id);
        const counts = taskIds.length
            ? await db.all(
                  `SELECT task_id, COUNT(*) AS count
                   FROM solochat_grading_annotations
                   WHERE task_id IN (${taskIds.map(() => "?").join(", ")})
                   GROUP BY task_id`,
                  ...taskIds,
              )
            : [];
        const countByTaskId = new Map(
            counts.map((row) => [row.task_id, Number(row.count || 0)]),
        );
        const taskByMessageId = new Map(
            tasks.map((task) => [
                task.message_id,
                {
                    taskId: String(task.id),
                    generatedTitle: task.generated_title,
                    status: task.status,
                    errorMessage: task.error_message,
                    selectedImageCount: Number(task.selected_image_count || 0),
                    annotationCount: Number(countByTaskId.get(task.id) || 0),
                },
            ]),
        );

        return messages.map((message) => ({
            ...message,
            type: message.type || "text",
            grading:
                (message.type || "text") === "grading"
                    ? taskByMessageId.get(message.id) || null
                    : null,
        }));
    }

    return {
        createConversation,
        createMessage,
        deleteConversation,
        getConversationById,
        getConversationForUser,
        getMessageById,
        listConversationsForUser,
        listMessages,
        touchConversation,
        updateConversationTitle,
        updateMessage,
    };
}

module.exports = {
    createSoloChatConversationService,
};
