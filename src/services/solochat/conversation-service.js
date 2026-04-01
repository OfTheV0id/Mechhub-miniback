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
            `SELECT id, conversation_id, role, content, status, created_at, updated_at
             FROM solochat_messages
             WHERE conversation_id = ?
             ORDER BY id ASC`,
            conversationId,
        );

        return attachAttachments(messages);
    }

    async function createMessage({
        conversationId,
        role,
        content,
        status = "completed",
    }) {
        const result = await db.run(
            `INSERT INTO solochat_messages (
                 conversation_id,
                 role,
                 content,
                 status,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ${nowExpression}, ${nowExpression})`,
            conversationId,
            role,
            content,
            status,
        );

        return getMessageById(result.lastID);
    }

    async function getMessageById(messageId) {
        const message = await db.get(
            `SELECT id, conversation_id, role, content, status, created_at, updated_at
             FROM solochat_messages
             WHERE id = ?`,
            messageId,
        );

        if (!message) {
            return null;
        }

        const [hydratedMessage] = await attachAttachments([message]);
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

    async function updateMessage({ messageId, content, status }) {
        await db.run(
            `UPDATE solochat_messages
             SET content = ?, status = ?, updated_at = ${nowExpression}
             WHERE id = ?`,
            content,
            status,
            messageId,
        );

        return getMessageById(messageId);
    }

    async function deleteConversation({ conversationId, userId }) {
        await db.run(
            `DELETE FROM solochat_messages
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
