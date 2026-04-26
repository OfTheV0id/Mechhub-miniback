const express = require("express");
const bcrypt = require("bcrypt");
const multer = require("multer");
const {
    getUserById,
    sanitizeUser,
} = require("../lib/users");

const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const ASSIGNMENT_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

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

function serializeId(value) {
    if (value === undefined || value === null) {
        return null;
    }

    return String(value);
}

function computeAssignmentStatus(dueAt) {
    if (!dueAt) {
        return "published";
    }

    const parsed = new Date(dueAt);

    if (Number.isNaN(parsed.getTime())) {
        return "published";
    }

    const diffMs = parsed.getTime() - Date.now();

    if (diffMs <= 0) {
        return "overdue";
    }

    if (diffMs <= ASSIGNMENT_DUE_SOON_WINDOW_MS) {
        return "due_soon";
    }

    return "published";
}

function toIsoTimestamp(value) {
    if (!value) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function getCurrentUser(db, userId) {
    return getUserById(db, userId);
}

async function requireCurrentUser(db, req) {
    if (!req.session.userId) {
        throw unauthorized("Not authenticated");
    }

    const user = await getCurrentUser(db, req.session.userId);

    if (!user) {
        req.session.destroy(() => {});
        throw unauthorized("Not authenticated");
    }

    return user;
}

async function getDashboardAssignments(db, userId) {
    const rows = await db.all(
        `SELECT
             a.id,
             a.class_id,
             a.title,
             a.due_at,
             a.updated_at,
             c.name AS class_name,
             c.owner_user_id,
             cm.role AS membership_role,
             latest.id AS latest_submission_id,
             latest.evaluation_status AS latest_evaluation_status,
             latest.submission_version AS latest_submission_version,
             latest.submitted_at AS latest_submitted_at,
             COALESCE(student_counts.total_student_count, 0) AS total_student_count,
             COALESCE(submission_counts.submission_count, 0) AS submission_count,
             COALESCE(submission_counts.evaluated_count, 0) AS evaluated_count
         FROM assignments a
         INNER JOIN classes c ON c.id = a.class_id
         INNER JOIN class_members cm ON cm.class_id = a.class_id
         LEFT JOIN assignment_submissions latest
             ON latest.id = (
                 SELECT s2.id
                 FROM assignment_submissions s2
                 WHERE s2.assignment_id = a.id
                   AND s2.user_id = ?
                 ORDER BY s2.submission_version DESC, s2.id DESC
                 LIMIT 1
             )
         LEFT JOIN (
             SELECT class_id, COUNT(*) AS total_student_count
             FROM class_members
             WHERE role = 'student'
             GROUP BY class_id
         ) student_counts ON student_counts.class_id = a.class_id
         LEFT JOIN (
             SELECT
                 latest_by_user.assignment_id,
                 COUNT(*) AS submission_count,
                 COUNT(
                     CASE WHEN latest_by_user.evaluation_status = 'completed'
                     THEN 1 END
                 ) AS evaluated_count,
                 COUNT(
                     CASE WHEN latest_by_user.is_teacher_overridden = 1
                     THEN 1 END
                 ) AS teacher_reviewed_count
             FROM assignment_submissions latest_by_user
             INNER JOIN (
                 SELECT assignment_id, user_id, MAX(submission_version) AS version
                 FROM assignment_submissions
                 GROUP BY assignment_id, user_id
             ) latest_versions
                 ON latest_versions.assignment_id = latest_by_user.assignment_id
                AND latest_versions.user_id = latest_by_user.user_id
                AND latest_versions.version = latest_by_user.submission_version
             GROUP BY latest_by_user.assignment_id
         ) submission_counts ON submission_counts.assignment_id = a.id
         WHERE cm.user_id = ?
         ORDER BY
             CASE
                 WHEN a.due_at IS NOT NULL AND datetime(a.due_at) >= datetime('now')
                 THEN 0 ELSE 1
             END,
             datetime(a.due_at) ASC,
             datetime(a.updated_at) DESC`,
        userId,
        userId,
    );

    return rows.map((row) => ({
        id: serializeId(row.id),
        classId: serializeId(row.class_id),
        className: row.class_name,
        title: row.title,
        status: computeAssignmentStatus(row.due_at),
        dueAt: toIsoTimestamp(row.due_at),
        updatedAt: toIsoTimestamp(row.updated_at),
        membershipRole: row.membership_role,
        isOwner: row.owner_user_id === userId,
        latestSubmission: row.latest_submission_id
            ? {
                  id: serializeId(row.latest_submission_id),
                  submissionVersion: Number(row.latest_submission_version || 0),
                  submittedAt: toIsoTimestamp(row.latest_submitted_at),
                  evaluationStatus: row.latest_evaluation_status,
              }
            : null,
        totalStudentCount: Number(row.total_student_count || 0),
        submissionCount: Number(row.submission_count || 0),
        evaluatedCount: Number(row.evaluated_count || 0),
        teacherReviewedCount: Number(row.teacher_reviewed_count || 0),
    }));
}

async function getClassSummaries(db, userId) {
    const rows = await db.all(
        `SELECT
             c.id,
             c.name,
             c.owner_user_id,
             c.created_at,
             cm.role AS membership_role,
             COALESCE(member_counts.member_count, 0) AS member_count,
             COALESCE(assignment_counts.assignment_count, 0) AS assignment_count,
             COALESCE(student_pending_counts.pending_count, 0) AS student_pending_count
         FROM classes c
         INNER JOIN class_members cm ON cm.class_id = c.id
         LEFT JOIN (
             SELECT class_id, COUNT(*) AS member_count
             FROM class_members
             GROUP BY class_id
         ) member_counts ON member_counts.class_id = c.id
         LEFT JOIN (
             SELECT class_id, COUNT(*) AS assignment_count
             FROM assignments
             GROUP BY class_id
         ) assignment_counts ON assignment_counts.class_id = c.id
         LEFT JOIN (
             SELECT a.class_id, COUNT(*) AS pending_count
             FROM assignments a
             LEFT JOIN assignment_submissions s
                 ON s.id = (
                     SELECT s2.id
                     FROM assignment_submissions s2
                     WHERE s2.assignment_id = a.id
                       AND s2.user_id = ?
                     ORDER BY s2.submission_version DESC, s2.id DESC
                     LIMIT 1
                 )
             WHERE s.id IS NULL
             GROUP BY a.class_id
         ) student_pending_counts ON student_pending_counts.class_id = c.id
         WHERE cm.user_id = ?
         ORDER BY datetime(c.created_at) DESC, c.id DESC`,
        userId,
        userId,
    );

    return rows.map((row) => ({
        id: serializeId(row.id),
        name: row.name,
        membershipRole: row.membership_role,
        isOwner: row.owner_user_id === userId,
        memberCount: Number(row.member_count || 0),
        assignmentCount: Number(row.assignment_count || 0),
        pendingCount: Number(row.student_pending_count || 0),
        createdAt: toIsoTimestamp(row.created_at),
    }));
}

async function getRecentConversations(db, userId) {
    const rows = await db.all(
        `SELECT id, title, updated_at
         FROM solochat_conversations
         WHERE user_id = ?
         ORDER BY datetime(updated_at) DESC, id DESC
         LIMIT 6`,
        userId,
    );

    return rows.map((row) => ({
        id: serializeId(row.id),
        title: row.title,
        updatedAt: toIsoTimestamp(row.updated_at),
    }));
}

function buildDashboardStats({ classSummaries, recentAssignments, conversations }) {
    const teachingClasses = classSummaries.filter(
        (item) => item.membershipRole === "teacher",
    );
    const studentClasses = classSummaries.filter(
        (item) => item.membershipRole === "student",
    );
    const studentAssignments = recentAssignments.filter(
        (item) => item.membershipRole === "student",
    );
    const teacherAssignments = recentAssignments.filter(
        (item) => item.membershipRole === "teacher",
    );

    return {
        classCount: classSummaries.length,
        teachingClassCount: teachingClasses.length,
        studentClassCount: studentClasses.length,
        assignmentCount: recentAssignments.length,
        dueSoonCount: recentAssignments.filter((item) => item.status === "due_soon")
            .length,
        overdueCount: recentAssignments.filter((item) => item.status === "overdue")
            .length,
        pendingSubmissionCount: studentAssignments.filter(
            (item) => !item.latestSubmission && item.status !== "overdue",
        ).length,
        submittedAssignmentCount: studentAssignments.filter(
            (item) => item.latestSubmission,
        ).length,
        teacherSubmissionCount: teacherAssignments.reduce(
            (sum, item) => sum + item.submissionCount,
            0,
        ),
        teacherEvaluatedCount: teacherAssignments.reduce(
            (sum, item) => sum + item.evaluatedCount,
            0,
        ),
        teacherPendingReviewCount: teacherAssignments.reduce(
            (sum, item) =>
                sum + Math.max(item.submissionCount - item.teacherReviewedCount, 0),
            0,
        ),
        recentConversationCount: conversations.length,
    };
}

function createUsersRouter(db, { fileService } = {}) {
    const router = express.Router();

    router.get("/me", async (req, res, next) => {
        try {
            const user = await requireCurrentUser(db, req);

            return res.json(sanitizeUser(user));
        } catch (err) {
            return next(err);
        }
    });

    router.get("/me/dashboard-summary", async (req, res, next) => {
        try {
            const user = await requireCurrentUser(db, req);
            const [dashboardAssignments, recentConversations, classSummaries] =
                await Promise.all([
                    getDashboardAssignments(db, req.session.userId),
                    getRecentConversations(db, req.session.userId),
                    getClassSummaries(db, req.session.userId),
                ]);

            return res.json({
                user: sanitizeUser(user),
                stats: buildDashboardStats({
                    classSummaries,
                    recentAssignments: dashboardAssignments,
                    conversations: recentConversations,
                }),
                recentAssignments: dashboardAssignments.slice(0, 12),
                recentConversations,
                classSummaries,
            });
        } catch (err) {
            return next(err);
        }
    });

    router.patch("/me", async (req, res, next) => {
        try {
            await requireCurrentUser(db, req);

            const updates = [];
            const values = [];

            if (Object.hasOwn(req.body, "displayName")) {
                if (typeof req.body.displayName !== "string") {
                    throw badRequest("displayName must be a string");
                }

                const displayName = req.body.displayName.trim();

                if (displayName.length > 100) {
                    throw badRequest("displayName must be 100 characters or fewer");
                }

                updates.push("display_name = ?");
                values.push(displayName);
            }

            if (Object.hasOwn(req.body, "avatarUrl")) {
                if (typeof req.body.avatarUrl !== "string") {
                    throw badRequest("avatarUrl must be a string");
                }

                const avatarUrl = req.body.avatarUrl.trim();

                if (avatarUrl.length > 2048) {
                    throw badRequest("avatarUrl must be 2048 characters or fewer");
                }

                updates.push("avatar_url = ?");
                values.push(avatarUrl);
            }

            if (Object.hasOwn(req.body, "bio")) {
                if (typeof req.body.bio !== "string") {
                    throw badRequest("bio must be a string");
                }

                const bio = req.body.bio.trim();

                if (bio.length > 500) {
                    throw badRequest("bio must be 500 characters or fewer");
                }

                updates.push("bio = ?");
                values.push(bio);
            }

            if (Object.hasOwn(req.body, "defaultRole")) {
                throw badRequest("defaultRole cannot be changed");
            }

            if (updates.length === 0) {
                throw badRequest("At least one profile field is required");
            }

            values.push(req.session.userId);

            const result = await db.run(
                `UPDATE users
                 SET ${updates.join(", ")}
                 WHERE id = ?`,
                values,
            );

            if (result.changes === 0) {
                req.session.destroy(() => {});
                throw unauthorized("Not authenticated");
            }

            const user = await getCurrentUser(db, req.session.userId);
            return res.json(sanitizeUser(user));
        } catch (err) {
            return next(err);
        }
    });

    router.post(
        "/me/avatar",
        (req, res, next) => avatarUpload.single("avatar")(req, res, next),
        async (req, res, next) => {
            try {
                const user = await requireCurrentUser(db, req);

                if (!req.file) {
                    throw badRequest("avatar file is required");
                }

                const mimeType = String(req.file.mimetype || "").toLowerCase();
                if (!mimeType.startsWith("image/")) {
                    throw badRequest("avatar must be an image file");
                }

                const fileRecord = await fileService.processImageUpload({
                    userId: user.id,
                    file: req.file,
                    subDir: "avatars",
                });

                const relativeUrl = `/users/avatars/${fileRecord.id}`;

                await db.run(
                    `UPDATE users SET avatar_url = ? WHERE id = ?`,
                    relativeUrl,
                    user.id,
                );

                const updatedUser = await getCurrentUser(db, user.id);
                return res.json(sanitizeUser(updatedUser));
            } catch (err) {
                return next(err);
            }
        },
    );

    router.get("/avatars/:fileId", async (req, res, next) => {
        try {
            const fileId = Number(req.params.fileId);
            if (!Number.isInteger(fileId) || fileId <= 0) {
                throw badRequest("invalid fileId");
            }

            const file = await db.get(
                `SELECT id, storage_path, mime_type FROM uploaded_files WHERE id = ?`,
                fileId,
            );

            const normalizedPath = file?.storage_path?.replace(/\\/g, "/") ?? "";
            if (!file || !normalizedPath.includes("/avatars/")) {
                const err = new Error("Not found");
                err.statusCode = 404;
                throw err;
            }

            res.setHeader("Content-Type", file.mime_type || "image/webp");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            return res.sendFile(file.storage_path);
        } catch (err) {
            return next(err);
        }
    });

    router.patch("/me/password", async (req, res, next) => {
        try {
            await requireCurrentUser(db, req);

            const currentPassword = String(req.body?.currentPassword || "");
            const newPassword = String(req.body?.newPassword || "");

            if (!currentPassword) {
                throw badRequest("currentPassword is required");
            }

            if (!newPassword || newPassword.length < 8) {
                throw badRequest("newPassword must be at least 8 characters");
            }

            const user = await db.get(
                `SELECT id, password_hash
                 FROM users
                 WHERE id = ?`,
                req.session.userId,
            );

            const passwordMatches = await bcrypt.compare(
                currentPassword,
                user.password_hash,
            );

            if (!passwordMatches) {
                throw unauthorized("Current password is incorrect");
            }

            const passwordHash = await bcrypt.hash(newPassword, 10);
            await db.run(
                `UPDATE users
                 SET password_hash = ?
                 WHERE id = ?`,
                passwordHash,
                req.session.userId,
            );

            return res.json({ message: "Password updated" });
        } catch (err) {
            return next(err);
        }
    });

    return router;
}

module.exports = {
    createUsersRouter,
};
