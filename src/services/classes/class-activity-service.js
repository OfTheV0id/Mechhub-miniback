const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

function createClassActivityService(db) {
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;

    async function createActivity({
        classId,
        creatorUserId,
        title,
        promptText,
        aiGuidance = "guided",
        dueAt = null,
    }) {
        const result = await db.run(
            `INSERT INTO class_activities (
                 class_id,
                 creator_user_id,
                 title,
                 prompt_text,
                 ai_guidance,
                 status,
                 due_at,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?, 'draft', ?, ${nowExpression}, ${nowExpression})`,
            classId,
            creatorUserId,
            title,
            promptText,
            aiGuidance,
            dueAt,
        );

        return getActivityById(result.lastID);
    }

    async function attachFileToActivity({ activityId, fileId }) {
        await db.run(
            `INSERT INTO class_activity_files (activity_id, file_id)
             VALUES (?, ?)`,
            activityId,
            fileId,
        );

        return getFileById(fileId);
    }

    async function getActivityById(activityId) {
        return db.get(
            `SELECT
                 a.id,
                 a.class_id,
                 a.creator_user_id,
                 a.title,
                 a.prompt_text,
                 a.ai_guidance,
                 a.status,
                 a.due_at,
                 a.summary_status,
                 a.summary_markdown,
                 a.summary_error_message,
                 a.focused_submission_id,
                 a.created_at,
                 a.updated_at,
                 creator.email AS creator_email,
                 creator.display_name AS creator_display_name,
                 creator.avatar_url AS creator_avatar_url,
                 creator.bio AS creator_bio,
                 creator.default_role AS creator_default_role,
                 creator.created_at AS creator_created_at
             FROM class_activities a
             INNER JOIN users creator
                 ON creator.id = a.creator_user_id
             WHERE a.id = ?`,
            activityId,
        );
    }

    async function setFocusedSubmission({ activityId, submissionId }) {
        await db.run(
            `UPDATE class_activities
             SET focused_submission_id = ?,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            submissionId,
            activityId,
        );
        return getActivityById(activityId);
    }

    async function getActiveActivityForClass(classId) {
        return db.get(
            `SELECT
                 a.id,
                 a.class_id,
                 a.title,
                 a.status,
                 a.due_at,
                 a.created_at
             FROM class_activities a
             WHERE a.class_id = ?
               AND a.status IN ('active', 'discussion')
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT 1`,
            classId,
        );
    }

    async function listActivitiesForTeacher(classId) {
        return db.all(
            `SELECT
                 a.id,
                 a.class_id,
                 a.creator_user_id,
                 a.title,
                 a.prompt_text,
                 a.ai_guidance,
                 a.status,
                 a.due_at,
                 a.summary_status,
                 a.summary_markdown,
                 a.summary_error_message,
                 a.focused_submission_id,
                 a.created_at,
                 a.updated_at,
                 COALESCE(student_counts.total_student_count, 0) AS total_student_count,
                 COALESCE(workspace_counts.workspace_count, 0) AS workspace_count,
                 COALESCE(submission_counts.submission_count, 0) AS submission_count,
                 COALESCE(showcase_counts.showcase_count, 0) AS showcase_count
             FROM class_activities a
             LEFT JOIN (
                 SELECT class_id, COUNT(*) AS total_student_count
                 FROM class_members
                 WHERE role = 'student'
                 GROUP BY class_id
             ) student_counts
                 ON student_counts.class_id = a.class_id
             LEFT JOIN (
                 SELECT activity_id, COUNT(*) AS workspace_count
                 FROM class_activity_workspaces
                 GROUP BY activity_id
             ) workspace_counts
                 ON workspace_counts.activity_id = a.id
             LEFT JOIN (
                 SELECT activity_id, COUNT(DISTINCT user_id) AS submission_count
                 FROM class_activity_submissions
                 GROUP BY activity_id
             ) submission_counts
                 ON submission_counts.activity_id = a.id
             LEFT JOIN (
                 SELECT activity_id, COUNT(*) AS showcase_count
                 FROM class_activity_showcases
                 GROUP BY activity_id
             ) showcase_counts
                 ON showcase_counts.activity_id = a.id
             WHERE a.class_id = ?
             ORDER BY a.created_at DESC, a.id DESC`,
            classId,
        );
    }

    async function listActivitiesForStudent({ classId, userId }) {
        return db.all(
            `SELECT
                 a.id,
                 a.class_id,
                 a.creator_user_id,
                 a.title,
                 a.prompt_text,
                 a.ai_guidance,
                 a.status,
                 a.due_at,
                 a.summary_status,
                 a.summary_markdown,
                 a.summary_error_message,
                 a.focused_submission_id,
                 a.created_at,
                 a.updated_at,
                 w.conversation_id AS workspace_conversation_id,
                 s.id AS latest_submission_id,
                 s.submission_version AS latest_submission_version,
                 s.submitted_at AS latest_submitted_at
             FROM class_activities a
             LEFT JOIN class_activity_workspaces w
                 ON w.activity_id = a.id
                AND w.user_id = ?
             LEFT JOIN class_activity_submissions s
                 ON s.id = (
                     SELECT s2.id
                     FROM class_activity_submissions s2
                     WHERE s2.activity_id = a.id
                       AND s2.user_id = ?
                     ORDER BY s2.submission_version DESC, s2.id DESC
                     LIMIT 1
                 )
             WHERE a.class_id = ?
               AND a.status <> 'draft'
             ORDER BY a.created_at DESC, a.id DESC`,
            userId,
            userId,
            classId,
        );
    }

    async function listActivityFiles(activityId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM class_activity_files af
             INNER JOIN uploaded_files uf
                 ON uf.id = af.file_id
             WHERE af.activity_id = ?
             ORDER BY uf.id ASC`,
            activityId,
        );
    }

    async function updateActivityStatus({ activityId, status }) {
        await db.run(
            `UPDATE class_activities
             SET status = ?,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            status,
            activityId,
        );

        return getActivityById(activityId);
    }

    async function getWorkspace({ activityId, userId }) {
        return db.get(
            `SELECT activity_id, user_id, conversation_id, started_at, updated_at
             FROM class_activity_workspaces
             WHERE activity_id = ? AND user_id = ?`,
            activityId,
            userId,
        );
    }

    async function createWorkspace({ activityId, userId, conversationId }) {
        await db.run(
            `INSERT INTO class_activity_workspaces (
                 activity_id,
                 user_id,
                 conversation_id,
                 started_at,
                 updated_at
             )
             VALUES (?, ?, ?, ${nowExpression}, ${nowExpression})
             ON CONFLICT(activity_id, user_id) DO UPDATE SET
                 updated_at = ${nowExpression}`,
            activityId,
            userId,
            conversationId,
        );

        return getWorkspace({ activityId, userId });
    }

    async function listSubmissions(activityId) {
        return db.all(
            `SELECT
                 s.id,
                 s.activity_id,
                 s.user_id,
                 s.answer_text,
                 s.source_conversation_id,
                 s.solochat_snapshot_json,
                 s.submission_version,
                 s.submitted_at,
                 s.is_anonymous,
                 s.created_at,
                 s.updated_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at,
                 CASE WHEN cs.submission_id IS NULL THEN 0 ELSE 1 END AS showcased,
                 COALESCE(file_counts.attachment_count, 0) AS attachment_count
             FROM class_activity_submissions s
             INNER JOIN users u
                 ON u.id = s.user_id
             LEFT JOIN class_activity_showcases cs
                 ON cs.activity_id = s.activity_id
                AND cs.submission_id = s.id
             LEFT JOIN (
                 SELECT submission_id, COUNT(*) AS attachment_count
                 FROM class_activity_submission_files
                 GROUP BY submission_id
             ) file_counts
                 ON file_counts.submission_id = s.id
             WHERE s.activity_id = ?
             ORDER BY s.submitted_at DESC, s.id DESC`,
            activityId,
        );
    }

    async function listLatestSubmissions(activityId) {
        return db.all(
            `SELECT
                 latest.*,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at
             FROM class_activity_submissions latest
             INNER JOIN (
                 SELECT user_id, MAX(submission_version) AS latest_submission_version
                 FROM class_activity_submissions
                 WHERE activity_id = ?
                 GROUP BY user_id
             ) versions
                 ON versions.user_id = latest.user_id
                AND versions.latest_submission_version = latest.submission_version
             INNER JOIN users u
                 ON u.id = latest.user_id
             WHERE latest.activity_id = ?
             ORDER BY latest.submitted_at DESC, latest.id DESC`,
            activityId,
            activityId,
        );
    }

    async function getSubmissionById(submissionId) {
        return db.get(
            `SELECT
                 s.id,
                 s.activity_id,
                 s.user_id,
                 s.answer_text,
                 s.source_conversation_id,
                 s.solochat_snapshot_json,
                 s.submission_version,
                 s.submitted_at,
                 s.is_anonymous,
                 s.created_at,
                 s.updated_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at,
                 CASE WHEN cs.submission_id IS NULL THEN 0 ELSE 1 END AS showcased
             FROM class_activity_submissions s
             INNER JOIN users u
                 ON u.id = s.user_id
             LEFT JOIN class_activity_showcases cs
                 ON cs.activity_id = s.activity_id
                AND cs.submission_id = s.id
             WHERE s.id = ?`,
            submissionId,
        );
    }

    async function getLatestSubmissionForUser({ activityId, userId }) {
        return db.get(
            `SELECT
                 id,
                 activity_id,
                 user_id,
                 answer_text,
                 source_conversation_id,
                 solochat_snapshot_json,
                 submission_version,
                 submitted_at,
                 is_anonymous,
                 created_at,
                 updated_at
             FROM class_activity_submissions
             WHERE activity_id = ? AND user_id = ?
             ORDER BY submission_version DESC, id DESC
             LIMIT 1`,
            activityId,
            userId,
        );
    }

    async function createSubmission({
        activityId,
        userId,
        answerText,
        sourceConversationId,
        solochatSnapshotJson,
        isAnonymous = false,
    }) {
        const latest = await getLatestSubmissionForUser({ activityId, userId });
        const nextVersion = Number(latest?.submission_version || 0) + 1;
        const result = await db.run(
            `INSERT INTO class_activity_submissions (
                 activity_id,
                 user_id,
                 answer_text,
                 source_conversation_id,
                 solochat_snapshot_json,
                 submission_version,
                 submitted_at,
                 is_anonymous,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ${nowExpression}, ?, ${nowExpression}, ${nowExpression})`,
            activityId,
            userId,
            answerText,
            sourceConversationId,
            solochatSnapshotJson,
            nextVersion,
            isAnonymous ? 1 : 0,
        );

        return getSubmissionById(result.lastID);
    }

    async function addShowcaseComment({
        activityId,
        submissionId,
        userId,
        body,
    }) {
        const result = await db.run(
            `INSERT INTO class_activity_showcase_comments (
                 activity_id,
                 submission_id,
                 user_id,
                 body,
                 created_at
             )
             VALUES (?, ?, ?, ?, ${nowExpression})`,
            activityId,
            submissionId,
            userId,
            body,
        );
        return db.get(
            `SELECT
                 c.id,
                 c.activity_id,
                 c.submission_id,
                 c.user_id,
                 c.body,
                 c.created_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at
             FROM class_activity_showcase_comments c
             INNER JOIN users u ON u.id = c.user_id
             WHERE c.id = ?`,
            result.lastID,
        );
    }

    async function listShowcaseComments({ activityId, submissionId }) {
        return db.all(
            `SELECT
                 c.id,
                 c.activity_id,
                 c.submission_id,
                 c.user_id,
                 c.body,
                 c.created_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at
             FROM class_activity_showcase_comments c
             INNER JOIN users u ON u.id = c.user_id
             WHERE c.activity_id = ? AND c.submission_id = ?
             ORDER BY c.created_at ASC, c.id ASC`,
            activityId,
            submissionId,
        );
    }

    async function deleteShowcaseComment({ commentId, userId }) {
        const result = await db.run(
            `DELETE FROM class_activity_showcase_comments
             WHERE id = ? AND user_id = ?`,
            commentId,
            userId,
        );
        return result.changes > 0;
    }

    async function getShowcaseComment(commentId) {
        return db.get(
            `SELECT id, activity_id, submission_id, user_id
             FROM class_activity_showcase_comments
             WHERE id = ?`,
            commentId,
        );
    }

    async function attachFileToSubmission({ submissionId, fileId }) {
        await db.run(
            `INSERT INTO class_activity_submission_files (submission_id, file_id)
             VALUES (?, ?)`,
            submissionId,
            fileId,
        );

        return getFileById(fileId);
    }

    async function listSubmissionFiles(submissionId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM class_activity_submission_files sf
             INNER JOIN uploaded_files uf
                 ON uf.id = sf.file_id
             WHERE sf.submission_id = ?
             ORDER BY uf.id ASC`,
            submissionId,
        );
    }

    async function addShowcase({ activityId, submissionId, userId }) {
        await db.run(
            `INSERT OR IGNORE INTO class_activity_showcases (
                 activity_id,
                 submission_id,
                 created_by_user_id,
                 created_at
             )
             VALUES (?, ?, ?, ${nowExpression})`,
            activityId,
            submissionId,
            userId,
        );

        return getSubmissionById(submissionId);
    }

    async function removeShowcase({ activityId, submissionId }) {
        await db.run(
            `DELETE FROM class_activity_showcases
             WHERE activity_id = ? AND submission_id = ?`,
            activityId,
            submissionId,
        );

        return getSubmissionById(submissionId);
    }

    async function listShowcasedSubmissions(activityId) {
        return db.all(
            `SELECT
                 s.id,
                 s.activity_id,
                 s.user_id,
                 s.answer_text,
                 s.source_conversation_id,
                 s.solochat_snapshot_json,
                 s.submission_version,
                 s.submitted_at,
                 s.is_anonymous,
                 s.created_at,
                 s.updated_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at,
                 1 AS showcased
             FROM class_activity_showcases cs
             INNER JOIN class_activity_submissions s
                 ON s.id = cs.submission_id
             INNER JOIN users u
                 ON u.id = s.user_id
             WHERE cs.activity_id = ?
             ORDER BY cs.created_at ASC, s.id ASC`,
            activityId,
        );
    }

    async function markSummaryGenerating(activityId) {
        await db.run(
            `UPDATE class_activities
             SET summary_status = 'generating',
                 summary_error_message = NULL,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            activityId,
        );

        return getActivityById(activityId);
    }

    async function storeSummary({ activityId, markdown }) {
        await db.run(
            `UPDATE class_activities
             SET summary_status = 'completed',
                 summary_markdown = ?,
                 summary_error_message = NULL,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            markdown,
            activityId,
        );

        return getActivityById(activityId);
    }

    async function markSummaryFailed({ activityId, errorMessage }) {
        await db.run(
            `UPDATE class_activities
             SET summary_status = 'failed',
                 summary_error_message = ?,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            errorMessage,
            activityId,
        );

        return getActivityById(activityId);
    }

    async function getFileById(fileId) {
        return db.get(
            `SELECT id, owner_user_id, storage_path, file_name, mime_type, size_bytes, width, height, kind, created_at
             FROM uploaded_files
             WHERE id = ?`,
            fileId,
        );
    }

    async function getActivityFileForUser({ fileId, userId }) {
        return db.get(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM uploaded_files uf
             WHERE uf.id = ?
               AND (
                   EXISTS (
                       SELECT 1
                       FROM class_activity_files af
                       INNER JOIN class_activities a ON a.id = af.activity_id
                       INNER JOIN class_members cm ON cm.class_id = a.class_id
                       WHERE af.file_id = uf.id AND cm.user_id = ?
                   )
                   OR EXISTS (
                       SELECT 1
                       FROM class_activity_submission_files sf
                       INNER JOIN class_activity_submissions s ON s.id = sf.submission_id
                       INNER JOIN class_activities a ON a.id = s.activity_id
                       INNER JOIN class_members cm ON cm.class_id = a.class_id
                       WHERE sf.file_id = uf.id
                         AND cm.user_id = ?
                         AND (cm.role = 'teacher' OR s.user_id = ?)
                   )
               )
             LIMIT 1`,
            fileId,
            userId,
            userId,
            userId,
        );
    }

    return {
        addShowcase,
        addShowcaseComment,
        attachFileToActivity,
        attachFileToSubmission,
        createActivity,
        createSubmission,
        createWorkspace,
        deleteShowcaseComment,
        getActiveActivityForClass,
        getActivityById,
        getActivityFileForUser,
        getLatestSubmissionForUser,
        getShowcaseComment,
        getSubmissionById,
        getWorkspace,
        listActivitiesForStudent,
        listActivitiesForTeacher,
        listActivityFiles,
        listLatestSubmissions,
        listShowcasedSubmissions,
        listShowcaseComments,
        listSubmissionFiles,
        listSubmissions,
        markSummaryFailed,
        markSummaryGenerating,
        removeShowcase,
        setFocusedSubmission,
        storeSummary,
        updateActivityStatus,
    };
}

module.exports = {
    createClassActivityService,
};
