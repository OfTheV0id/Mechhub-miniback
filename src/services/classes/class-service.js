const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

function createClassService(db) {
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;

    async function createClass({ ownerUserId, name, description, role, inviteCode }) {
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
                 c.description,
                 c.owner_user_id,
                 c.invite_code,
                 c.status,
                 c.created_at,
                 cm.role AS membership_role
             FROM classes c
             INNER JOIN class_members cm
                 ON cm.class_id = c.id
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
                 cm.role AS membership_role
             FROM classes c
             INNER JOIN class_members cm
                 ON cm.class_id = c.id
             WHERE c.id = ? AND cm.user_id = ?`,
            classId,
            userId,
        );
    }

    async function getClassByInviteCode(inviteCode) {
        return db.get(
            `SELECT id, name, description, owner_user_id, invite_code, status, created_at
             FROM classes
             WHERE invite_code = ?`,
            inviteCode,
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

    return {
        createClass,
        getClassByInviteCode,
        getClassForUser,
        getMemberById,
        getMembership,
        joinClass,
        listClassesForUser,
        listMembers,
        updateMemberRole,
    };
}

module.exports = {
    createClassService,
};
