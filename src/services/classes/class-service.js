const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

function createClassService(db) {
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;

    async function createClass({
        ownerUserId,
        name,
        description,
        role,
        inviteCode,
    }) {
        const result = await db.run(
            `INSERT INTO classes (
                 name,
                 description,
                 owner_user_id,
                 invite_code,
                 status,
                 created_at
             )
             VALUES (?, ?, ?, ?, 'active', ${nowExpression})`,
            name,
            description,
            ownerUserId,
            inviteCode,
        );

        await db.run(
            `INSERT INTO class_members (
                 class_id,
                 user_id,
                 role,
                 joined_at
             )
             VALUES (?, ?, ?, ${nowExpression})`,
            result.lastID,
            ownerUserId,
            role,
        );

        return getClassForUser({ classId: result.lastID, userId: ownerUserId });
    }

    async function listClassesForUser(userId) {
        return db.all(
            `SELECT
                 c.id,
                 c.name,
                 c.status,
                 c.owner_user_id,
                 c.avatar_file_id,
                 cm.role AS membership_role,
                 uf.id AS avatar_id,
                 uf.file_name AS avatar_file_name,
                 uf.mime_type AS avatar_mime_type,
                 uf.size_bytes AS avatar_size_bytes,
                 uf.width AS avatar_width,
                 uf.height AS avatar_height,
                 uf.created_at AS avatar_created_at
             FROM classes c
             INNER JOIN class_members cm ON cm.class_id = c.id
             LEFT JOIN uploaded_files uf ON uf.id = c.avatar_file_id
             WHERE cm.user_id = ?
             ORDER BY c.created_at DESC, c.id DESC`,
            userId,
        );
    }

    async function getClassForUser({ classId, userId }) {
        return db.get(
            `SELECT
                 c.id,
                 c.name,
                 c.description,
                 c.owner_user_id,
                 c.invite_code,
                 c.status,
                 c.created_at,
                 c.avatar_file_id,
                 cm.role AS membership_role,
                 uf.id AS avatar_id,
                 uf.file_name AS avatar_file_name,
                 uf.mime_type AS avatar_mime_type,
                 uf.size_bytes AS avatar_size_bytes,
                 uf.width AS avatar_width,
                 uf.height AS avatar_height,
                 uf.created_at AS avatar_created_at
             FROM classes c
             INNER JOIN class_members cm ON cm.class_id = c.id
             LEFT JOIN uploaded_files uf ON uf.id = c.avatar_file_id
             WHERE c.id = ? AND cm.user_id = ?`,
            classId,
            userId,
        );
    }

    async function getClassByInviteCode(inviteCode) {
        return db.get(
            `SELECT
                 c.id,
                 c.name,
                 c.description,
                 c.owner_user_id,
                 c.invite_code,
                 c.status,
                 c.created_at,
                 c.avatar_file_id,
                 uf.id AS avatar_id,
                 uf.file_name AS avatar_file_name,
                 uf.mime_type AS avatar_mime_type,
                 uf.size_bytes AS avatar_size_bytes,
                 uf.width AS avatar_width,
                 uf.height AS avatar_height
             FROM classes c
             LEFT JOIN uploaded_files uf ON uf.id = c.avatar_file_id
             WHERE c.invite_code = ?`,
            inviteCode,
        );
    }

    async function getClassById(classId) {
        return db.get(
            `SELECT
                 c.id,
                 c.name,
                 c.description,
                 c.owner_user_id,
                 c.invite_code,
                 c.status,
                 c.created_at,
                 c.avatar_file_id,
                 uf.id AS avatar_id,
                 uf.file_name AS avatar_file_name,
                 uf.mime_type AS avatar_mime_type,
                 uf.size_bytes AS avatar_size_bytes,
                 uf.width AS avatar_width,
                 uf.height AS avatar_height
             FROM classes c
             LEFT JOIN uploaded_files uf ON uf.id = c.avatar_file_id
             WHERE c.id = ?`,
            classId,
        );
    }

    async function getMembership({ classId, userId }) {
        return db.get(
            `SELECT id, class_id, user_id, role, joined_at
             FROM class_members
             WHERE class_id = ? AND user_id = ?`,
            classId,
            userId,
        );
    }

    async function joinClass({ classId, userId, role }) {
        await db.run(
            `INSERT INTO class_members (
                 class_id,
                 user_id,
                 role,
                 joined_at
             )
             VALUES (?, ?, ?, ${nowExpression})`,
            classId,
            userId,
            role,
        );

        return getMembership({ classId, userId });
    }

    async function listMembers(classId) {
        return db.all(
            `SELECT
                 cm.id,
                 cm.class_id,
                 cm.user_id,
                 cm.role,
                 cm.joined_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at
             FROM class_members cm
             INNER JOIN users u
                 ON u.id = cm.user_id
             WHERE cm.class_id = ?
             ORDER BY
                 CASE WHEN cm.user_id = (
                     SELECT owner_user_id FROM classes WHERE id = ?
                 ) THEN 0 ELSE 1 END,
                 cm.joined_at ASC,
                 cm.id ASC`,
            classId,
            classId,
        );
    }

    async function listMemberUserIds(classId) {
        const rows = await db.all(
            `SELECT user_id
             FROM class_members
             WHERE class_id = ?`,
            classId,
        );

        return rows.map((row) => row.user_id);
    }

    async function getMemberById({ classId, memberId }) {
        return db.get(
            `SELECT id, class_id, user_id, role, joined_at
             FROM class_members
             WHERE class_id = ? AND id = ?`,
            classId,
            memberId,
        );
    }

    async function updateMemberRole({ memberId, role }) {
        await db.run(
            `UPDATE class_members
             SET role = ?
             WHERE id = ?`,
            role,
            memberId,
        );

        return db.get(
            `SELECT id, class_id, user_id, role, joined_at
             FROM class_members
             WHERE id = ?`,
            memberId,
        );
    }

    async function updateClass({ classId, name, description, status }) {
        const updates = [];
        const values = [];

        if (name !== undefined) {
            updates.push("name = ?");
            values.push(name);
        }

        if (description !== undefined) {
            updates.push("description = ?");
            values.push(description);
        }

        if (status !== undefined) {
            updates.push("status = ?");
            values.push(status);
        }

        if (updates.length === 0) {
            return getClassById(classId);
        }

        values.push(classId);
        await db.run(
            `UPDATE classes
             SET ${updates.join(", ")}
             WHERE id = ?`,
            values,
        );

        return getClassById(classId);
    }



    async function removeMember({ classId, memberId }) {
        return db.run(
            `DELETE FROM class_members
             WHERE class_id = ? AND id = ?`,
            classId,
            memberId,
        );
    }

    async function leaveClass({ classId, userId }) {
        return db.run(
            `DELETE FROM class_members
             WHERE class_id = ? AND user_id = ?`,
            classId,
            userId,
        );
    }

    async function updateClassAvatar({ classId, fileId }) {
        // 获取旧头像文件ID
        const classRecord = await getClassById(classId);
        const oldAvatarFileId = classRecord?.avatar_file_id;

        // 更新班级头像
        await db.run(
            `UPDATE classes SET avatar_file_id = ? WHERE id = ?`,
            fileId,
            classId,
        );

        // 如果存在旧头像，删除旧文件记录
        if (oldAvatarFileId && oldAvatarFileId !== fileId) {
            await db.run(`DELETE FROM uploaded_files WHERE id = ?`, oldAvatarFileId);
        }

        return getClassById(classId);
    }

    async function removeClassAvatar(classId) {
        const classRecord = await getClassById(classId);
        const oldAvatarFileId = classRecord?.avatar_file_id;

        if (oldAvatarFileId) {
            await db.run(`UPDATE classes SET avatar_file_id = NULL WHERE id = ?`, classId);
            await db.run(`DELETE FROM uploaded_files WHERE id = ?`, oldAvatarFileId);
        }

        return getClassById(classId);
    }

    return {
        createClass,
        getClassById,
        getClassByInviteCode,
        getClassForUser,
        getMemberById,
        getMembership,
        joinClass,
        leaveClass,
        listClassesForUser,
        listMemberUserIds,
        listMembers,
        removeMember,
        updateClass,
        updateMemberRole,
        updateClassAvatar,
        removeClassAvatar,
    };
}

module.exports = {
    createClassService,
};
