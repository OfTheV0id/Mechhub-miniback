const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

function createAssignmentService(db) {
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;
    const latestSubmissionJoinForAssignments = `
        LEFT JOIN assignment_submissions s
            ON s.id = (
                SELECT s2.id
                FROM assignment_submissions s2
                WHERE s2.assignment_id = a.id
                  AND s2.user_id = ?
                ORDER BY s2.submission_version DESC, s2.id DESC
                LIMIT 1
            )
    `;
    const latestSubmissionStatsJoin = `
        LEFT JOIN (
            SELECT
                latest.assignment_id,
                COUNT(*) AS submission_count,
                COUNT(
                    CASE WHEN latest.evaluation_status = 'completed' THEN 1 END
                ) AS evaluated_count
            FROM assignment_submissions latest
            INNER JOIN (
                SELECT
                    assignment_id,
                    user_id,
                    MAX(submission_version) AS latest_submission_version
                FROM assignment_submissions
                GROUP BY assignment_id, user_id
            ) latest_versions
                ON latest_versions.assignment_id = latest.assignment_id
               AND latest_versions.user_id = latest.user_id
               AND latest_versions.latest_submission_version =
                    latest.submission_version
            GROUP BY latest.assignment_id
        ) submission_counts
            ON submission_counts.assignment_id = a.id
    `;

    async function createAssignment({
        classId,
        creatorUserId,
        title,
        description,
        dueAt = null,
    }) {
        const result = await db.run(
            `INSERT INTO assignments (
                 class_id,
                 creator_user_id,
                 title,
                 description,
                 status,
                 due_at,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ${nowExpression}, ${nowExpression})`,
            classId,
            creatorUserId,
            title,
            description,
            "published",
            dueAt,
        );

        return getAssignmentById(result.lastID);
    }

    async function updateAssignment({
        assignmentId,
        title,
        description,
        dueAt,
    }) {
        const updates = [];
        const values = [];

        if (title !== undefined) {
            updates.push("title = ?");
            values.push(title);
        }

        if (description !== undefined) {
            updates.push("description = ?");
            values.push(description);
        }

        if (dueAt !== undefined) {
            updates.push("due_at = ?");
            values.push(dueAt);
        }

        if (!updates.length) {
            return getAssignmentById(assignmentId);
        }

        values.push(assignmentId);
        await db.run(
            `UPDATE assignments
             SET ${updates.join(", ")},
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            values,
        );

        return getAssignmentById(assignmentId);
    }

    async function getAssignmentById(assignmentId) {
        return db.get(
            `SELECT id, class_id, creator_user_id, title, description, status, due_at, created_at, updated_at
             FROM assignments
             WHERE id = ?`,
            assignmentId,
        );
    }

    async function getAssignmentForClass({ classId, assignmentId }) {
        return db.get(
            `SELECT id, class_id, creator_user_id, title, description, status, due_at, created_at, updated_at
             FROM assignments
             WHERE id = ? AND class_id = ?`,
            assignmentId,
            classId,
        );
    }

    async function listAssignmentsForTeacher(classId) {
        return db.all(
            `SELECT
                 a.id,
                 a.class_id,
                 a.creator_user_id,
                 a.title,
                 a.description,
                 a.status,
                 a.due_at,
                 a.created_at,
                 a.updated_at,
                 COALESCE(student_counts.total_student_count, 0) AS total_student_count,
                 COALESCE(submission_counts.submission_count, 0) AS submission_count,
                 COALESCE(submission_counts.evaluated_count, 0) AS evaluated_count
             FROM assignments a
             LEFT JOIN (
                 SELECT class_id, COUNT(*) AS total_student_count
                 FROM class_members
                 WHERE role = 'student'
                 GROUP BY class_id
             ) student_counts
                 ON student_counts.class_id = a.class_id
             ${latestSubmissionStatsJoin}
             WHERE a.class_id = ?
             ORDER BY a.created_at DESC, a.id DESC`,
            classId,
        );
    }

    async function listAssignmentsForStudent({ classId, userId }) {
        return db.all(
            `SELECT
                 a.id,
                 a.class_id,
                 a.creator_user_id,
                 a.title,
                 a.description,
                 a.status,
                 a.due_at,
                 a.created_at,
                 a.updated_at,
                 s.id AS latest_submission_id,
                 s.submission_version AS latest_submission_version,
                 s.submitted_at AS latest_submitted_at,
                 s.evaluation_status AS latest_evaluation_status,
                 s.evaluation_error_message AS latest_evaluation_error_message,
                 s.ai_score AS latest_ai_score,
                 s.ai_feedback_markdown AS latest_ai_feedback_markdown,
                 s.final_score AS latest_final_score,
                 s.final_feedback_markdown AS latest_final_feedback_markdown,
                 s.is_teacher_overridden AS latest_is_teacher_overridden,
                 s.reviewed_at AS latest_reviewed_at
             FROM assignments a
             ${latestSubmissionJoinForAssignments}
             WHERE a.class_id = ?
             ORDER BY a.created_at DESC, a.id DESC`,
            userId,
            classId,
        );
    }

    async function getAssignmentSummaryForTeacher(assignmentId) {
        return db.get(
            `SELECT
                 a.id,
                 a.class_id,
                 a.creator_user_id,
                 a.title,
                 a.description,
                 a.status,
                 a.due_at,
                 a.created_at,
                 a.updated_at,
                 COALESCE(student_counts.total_student_count, 0) AS total_student_count,
                 COALESCE(submission_counts.submission_count, 0) AS submission_count,
                 COALESCE(submission_counts.evaluated_count, 0) AS evaluated_count,
                 creator.email AS creator_email,
                 creator.display_name AS creator_display_name,
                 creator.avatar_url AS creator_avatar_url,
                 creator.bio AS creator_bio,
                 creator.default_role AS creator_default_role,
                 creator.created_at AS creator_created_at
             FROM assignments a
             INNER JOIN users creator
                 ON creator.id = a.creator_user_id
             LEFT JOIN (
                 SELECT class_id, COUNT(*) AS total_student_count
                 FROM class_members
                 WHERE role = 'student'
                 GROUP BY class_id
             ) student_counts
                 ON student_counts.class_id = a.class_id
             ${latestSubmissionStatsJoin}
             WHERE a.id = ?`,
            assignmentId,
        );
    }

    async function getAssignmentSummaryForStudent({ assignmentId, userId }) {
        return db.get(
            `SELECT
                 a.id,
                 a.class_id,
                 a.creator_user_id,
                 a.title,
                 a.description,
                 a.status,
                 a.due_at,
                 a.created_at,
                 a.updated_at,
                 s.id AS latest_submission_id,
                 s.submission_version AS latest_submission_version,
                 s.submitted_at AS latest_submitted_at,
                 s.evaluation_status AS latest_evaluation_status,
                 s.evaluation_error_message AS latest_evaluation_error_message,
                 s.ai_score AS latest_ai_score,
                 s.ai_feedback_markdown AS latest_ai_feedback_markdown,
                 s.final_score AS latest_final_score,
                 s.final_feedback_markdown AS latest_final_feedback_markdown,
                 s.is_teacher_overridden AS latest_is_teacher_overridden,
                 s.reviewed_at AS latest_reviewed_at,
                 creator.email AS creator_email,
                 creator.display_name AS creator_display_name,
                 creator.avatar_url AS creator_avatar_url,
                 creator.bio AS creator_bio,
                 creator.default_role AS creator_default_role,
                 creator.created_at AS creator_created_at
             FROM assignments a
             INNER JOIN users creator
                 ON creator.id = a.creator_user_id
             ${latestSubmissionJoinForAssignments}
             WHERE a.id = ?`,
            userId,
            assignmentId,
        );
    }

    async function listAssignmentFiles(assignmentId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM assignment_files af
             INNER JOIN uploaded_files uf
                 ON uf.id = af.file_id
             WHERE af.assignment_id = ?
             ORDER BY uf.id ASC`,
            assignmentId,
        );
    }

    async function attachFileToAssignment({ assignmentId, fileId }) {
        await db.run(
            `INSERT INTO assignment_files (assignment_id, file_id)
             VALUES (?, ?)`,
            assignmentId,
            fileId,
        );

        return db.get(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM assignment_files af
             INNER JOIN uploaded_files uf
                 ON uf.id = af.file_id
             WHERE af.assignment_id = ? AND af.file_id = ?`,
            assignmentId,
            fileId,
        );
    }

    async function removeAssignmentFile({ assignmentId, fileId }) {
        const file = await db.get(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM assignment_files af
             INNER JOIN uploaded_files uf
                 ON uf.id = af.file_id
             WHERE af.assignment_id = ? AND af.file_id = ?`,
            assignmentId,
            fileId,
        );

        if (!file) {
            return null;
        }

        await db.run(
            `DELETE FROM assignment_files
             WHERE assignment_id = ? AND file_id = ?`,
            assignmentId,
            fileId,
        );

        return file;
    }

    async function getLatestSubmissionForAssignmentAndUser({
        assignmentId,
        userId,
    }) {
        return db.get(
            `SELECT id, assignment_id, user_id, answer_text, source_conversation_id, solochat_snapshot_json, submission_version, submitted_at, evaluation_status, evaluation_error_message, ai_score, ai_feedback_markdown, ai_feedback_json, ai_reviewed_at, final_score, final_feedback_markdown, is_teacher_overridden, reviewer_user_id, reviewed_at, created_at, updated_at
             FROM assignment_submissions
             WHERE assignment_id = ? AND user_id = ?
             ORDER BY submission_version DESC, id DESC
             LIMIT 1`,
            assignmentId,
            userId,
        );
    }

    async function getSubmissionById(submissionId) {
        return db.get(
            `SELECT id, assignment_id, user_id, answer_text, source_conversation_id, solochat_snapshot_json, submission_version, submitted_at, evaluation_status, evaluation_error_message, ai_score, ai_feedback_markdown, ai_feedback_json, ai_reviewed_at, final_score, final_feedback_markdown, is_teacher_overridden, reviewer_user_id, reviewed_at, created_at, updated_at
             FROM assignment_submissions
             WHERE id = ?`,
            submissionId,
        );
    }

    async function listSubmissionFiles(submissionId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM assignment_submission_files sf
             INNER JOIN uploaded_files uf
                 ON uf.id = sf.file_id
             WHERE sf.submission_id = ?
             ORDER BY uf.id ASC`,
            submissionId,
        );
    }

    async function createSubmission({
        assignmentId,
        userId,
        answerText,
        sourceConversationId,
        solochatSnapshotJson,
        attachmentFileIds = [],
    }) {
        const latestSubmission = await getLatestSubmissionForAssignmentAndUser({
            assignmentId,
            userId,
        });
        const nextSubmissionVersion =
            Number(latestSubmission?.submission_version || 0) + 1;

        const result = await db.run(
            `INSERT INTO assignment_submissions (
                 assignment_id,
                 user_id,
                 answer_text,
                 source_conversation_id,
                 solochat_snapshot_json,
                 submission_version,
                 submitted_at,
                 evaluation_status,
                 evaluation_error_message,
                 ai_score,
                 ai_feedback_markdown,
                 ai_feedback_json,
                 ai_reviewed_at,
                 final_score,
                 final_feedback_markdown,
                 is_teacher_overridden,
                 reviewer_user_id,
                 reviewed_at,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ${nowExpression}, 'evaluating', NULL, NULL, '', NULL, NULL, NULL, '', 0, NULL, NULL, ${nowExpression}, ${nowExpression})`,
            assignmentId,
            userId,
            answerText,
            sourceConversationId,
            solochatSnapshotJson,
            nextSubmissionVersion,
        );
        const submissionId = result.lastID;

        for (const fileId of attachmentFileIds) {
            await db.run(
                `INSERT INTO assignment_submission_files (submission_id, file_id)
                 VALUES (?, ?)`,
                submissionId,
                fileId,
            );
        }

        return getSubmissionById(submissionId);
    }

    async function markSubmissionEvaluating(submissionId) {
        await db.run(
            `UPDATE assignment_submissions
             SET evaluation_status = 'evaluating',
                 evaluation_error_message = NULL,
                 ai_score = NULL,
                 ai_feedback_markdown = '',
                 ai_feedback_json = NULL,
                 ai_reviewed_at = NULL,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            submissionId,
        );

        return getSubmissionById(submissionId);
    }

    async function storeSubmissionEvaluation({
        submissionId,
        score,
        feedbackMarkdown,
        feedbackJson,
    }) {
        await db.run(
            `UPDATE assignment_submissions
             SET evaluation_status = 'completed',
                 evaluation_error_message = NULL,
                 ai_score = ?,
                 ai_feedback_markdown = ?,
                 ai_feedback_json = ?,
                 ai_reviewed_at = ${nowExpression},
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            score,
            feedbackMarkdown,
            feedbackJson ? JSON.stringify(feedbackJson) : null,
            submissionId,
        );

        return getSubmissionById(submissionId);
    }

    async function markSubmissionEvaluationFailed({
        submissionId,
        errorMessage,
    }) {
        await db.run(
            `UPDATE assignment_submissions
             SET evaluation_status = 'failed',
                 evaluation_error_message = ?,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            String(errorMessage || "Evaluation failed").slice(0, 500),
            submissionId,
        );

        return getSubmissionById(submissionId);
    }

    async function listSubmissionsForAssignment(assignmentId) {
        return db.all(
            `SELECT
                 s.id,
                 s.assignment_id,
                 s.user_id,
                 s.submission_version,
                 s.submitted_at,
                 s.evaluation_status,
                 s.evaluation_error_message,
                 s.ai_score,
                 s.ai_reviewed_at,
                 s.final_score,
                 s.is_teacher_overridden,
                 s.reviewer_user_id,
                 s.reviewed_at,
                 COALESCE(file_counts.attachment_count, 0) AS attachment_count,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at
             FROM assignment_submissions s
             INNER JOIN users u
                 ON u.id = s.user_id
             LEFT JOIN (
                 SELECT submission_id, COUNT(*) AS attachment_count
                 FROM assignment_submission_files
                 GROUP BY submission_id
             ) file_counts
                 ON file_counts.submission_id = s.id
             WHERE s.assignment_id = ?
             ORDER BY s.submitted_at DESC, s.id DESC`,
            assignmentId,
        );
    }

    async function getSubmissionDetailForTeacher({ assignmentId, submissionId }) {
        return db.get(
            `SELECT
                 s.id,
                 s.assignment_id,
                 s.user_id,
                 s.answer_text,
                 s.source_conversation_id,
                 s.solochat_snapshot_json,
                 s.submission_version,
                 s.submitted_at,
                 s.evaluation_status,
                 s.evaluation_error_message,
                 s.ai_score,
                 s.ai_feedback_markdown,
                 s.ai_feedback_json,
                 s.ai_reviewed_at,
                 s.final_score,
                 s.final_feedback_markdown,
                 s.is_teacher_overridden,
                 s.reviewer_user_id,
                 s.reviewed_at,
                 s.created_at,
                 s.updated_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at,
                 reviewer.email AS reviewer_email,
                 reviewer.display_name AS reviewer_display_name,
                 reviewer.avatar_url AS reviewer_avatar_url,
                 reviewer.bio AS reviewer_bio,
                 reviewer.default_role AS reviewer_default_role,
                 reviewer.created_at AS reviewer_created_at
             FROM assignment_submissions s
             INNER JOIN users u
                 ON u.id = s.user_id
             LEFT JOIN users reviewer
                 ON reviewer.id = s.reviewer_user_id
             WHERE s.assignment_id = ? AND s.id = ?`,
            assignmentId,
            submissionId,
        );
    }

    async function getSubmissionDetailForStudent({
        assignmentId,
        submissionId,
        userId,
    }) {
        return db.get(
            `SELECT
                 id,
                 assignment_id,
                 user_id,
                 answer_text,
                 source_conversation_id,
                 solochat_snapshot_json,
                 submission_version,
                 submitted_at,
                 evaluation_status,
                 evaluation_error_message,
                 ai_score,
                 ai_feedback_markdown,
                 ai_feedback_json,
                 ai_reviewed_at,
                 final_score,
                 final_feedback_markdown,
                 is_teacher_overridden,
                 reviewer_user_id,
                 reviewed_at,
                 created_at,
                 updated_at
             FROM assignment_submissions
             WHERE assignment_id = ?
               AND id = ?
               AND user_id = ?`,
            assignmentId,
            submissionId,
            userId,
        );
    }

    async function updateFinalReview({
        submissionId,
        finalScore,
        finalFeedbackMarkdown,
        reviewerUserId,
    }) {
        await db.run(
            `UPDATE assignment_submissions
             SET final_score = ?,
                 final_feedback_markdown = ?,
                 is_teacher_overridden = 1,
                 reviewer_user_id = ?,
                 reviewed_at = ${nowExpression},
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            finalScore,
            finalFeedbackMarkdown,
            reviewerUserId,
            submissionId,
        );

        return getSubmissionById(submissionId);
    }

    async function getAssignmentReferenceFileForUser({ fileId, userId }) {
        return db.get(
            `SELECT
                 uf.id,
                 uf.owner_user_id,
                 uf.storage_path,
                 uf.file_name,
                 uf.mime_type,
                 uf.size_bytes,
                 uf.width,
                 uf.height,
                 uf.kind,
                 uf.created_at
             FROM uploaded_files uf
             INNER JOIN assignment_files af
                 ON af.file_id = uf.id
             INNER JOIN assignments a
                 ON a.id = af.assignment_id
             INNER JOIN class_members cm
                 ON cm.class_id = a.class_id
                AND cm.user_id = ?
             WHERE uf.id = ?
             LIMIT 1`,
            userId,
            fileId,
        );
    }

    async function listSubmissionHistoryForStudent({ assignmentId, userId }) {
        return db.all(
            `SELECT
                 id,
                 assignment_id,
                 user_id,
                 submission_version,
                 submitted_at,
                 evaluation_status,
                 evaluation_error_message,
                 ai_score,
                 ai_feedback_markdown,
                 final_score,
                 final_feedback_markdown,
                 is_teacher_overridden,
                 reviewed_at
             FROM assignment_submissions
             WHERE assignment_id = ? AND user_id = ?
             ORDER BY submission_version DESC`,
            assignmentId,
            userId,
        );
    }

    async function getAssignmentSubmissionFileForUser({ fileId, userId }) {
        return db.get(
            `SELECT
                 uf.id,
                 uf.owner_user_id,
                 uf.storage_path,
                 uf.file_name,
                 uf.mime_type,
                 uf.size_bytes,
                 uf.width,
                 uf.height,
                 uf.kind,
                 uf.created_at
             FROM uploaded_files uf
             INNER JOIN assignment_submission_files sf
                 ON sf.file_id = uf.id
             INNER JOIN assignment_submissions s
                 ON s.id = sf.submission_id
             INNER JOIN assignments a
                 ON a.id = s.assignment_id
             INNER JOIN class_members cm
                 ON cm.class_id = a.class_id
                AND cm.user_id = ?
             WHERE uf.id = ?
               AND (cm.role = 'teacher' OR s.user_id = ?)
             LIMIT 1`,
            userId,
            fileId,
            userId,
        );
    }

    return {
        attachFileToAssignment,
        createAssignment,
        getAssignmentById,
        getAssignmentForClass,
        getAssignmentReferenceFileForUser,
        getAssignmentSubmissionFileForUser,
        getAssignmentSummaryForStudent,
        getAssignmentSummaryForTeacher,
        getSubmissionById,
        getSubmissionDetailForStudent,
        getSubmissionDetailForTeacher,
        getLatestSubmissionForAssignmentAndUser,
        listAssignmentFiles,
        listAssignmentsForStudent,
        listAssignmentsForTeacher,
        listSubmissionHistoryForStudent,
        listSubmissionFiles,
        listSubmissionsForAssignment,
        markSubmissionEvaluating,
        markSubmissionEvaluationFailed,
        removeAssignmentFile,
        storeSubmissionEvaluation,
        updateAssignment,
        updateFinalReview,
        createSubmission,
    };
}

module.exports = {
    createAssignmentService,
};
