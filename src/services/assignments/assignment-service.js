const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

function createAssignmentService(db) {
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;

    async function createAssignment({
        classId,
        createdByUserId,
        title,
        description,
        startAt,
        dueAt,
        allowLateSubmission,
        maxScore,
        status,
    }) {
        const publishNow = status === "published";
        const result = await db.run(
            `INSERT INTO assignments (
                 class_id,
                 created_by_user_id,
                 title,
                 description,
                 start_at,
                 due_at,
                 allow_late_submission,
                 max_score,
                 status,
                 published_at,
                 created_at,
                 updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${publishNow ? nowExpression : "NULL"}, ${nowExpression}, ${nowExpression})`,
            classId,
            createdByUserId,
            title,
            description,
            startAt,
            dueAt,
            allowLateSubmission ? 1 : 0,
            maxScore,
            status,
        );

        return getAssignmentById(result.lastID);
    }

    async function listAssignmentsForClass({ classId, includeDrafts = false }) {
        const statusFilter = includeDrafts ? "" : `AND a.status != 'draft'`;
        return db.all(
            `SELECT
                 a.id,
                 a.class_id,
                 c.name AS class_name,
                 a.title,
                 a.description,
                 a.start_at,
                 a.due_at,
                 a.allow_late_submission,
                 a.max_score,
                 a.status,
                 a.created_by_user_id,
                 a.published_at,
                 a.closed_at,
                 a.created_at,
                 a.updated_at
             FROM assignments a
             INNER JOIN classes c
                 ON c.id = a.class_id
             WHERE a.class_id = ? ${statusFilter}
             ORDER BY a.created_at DESC, a.id DESC`,
            classId,
        );
    }

    async function listAssignmentsForTeacher(userId) {
        return db.all(
            `SELECT
                 a.id,
                 a.class_id,
                 c.name AS class_name,
                 a.title,
                 a.description,
                 a.start_at,
                 a.due_at,
                 a.allow_late_submission,
                 a.max_score,
                 a.status,
                 a.created_by_user_id,
                 a.published_at,
                 a.closed_at,
                 a.created_at,
                 a.updated_at,
                 (
                     SELECT COUNT(*)
                     FROM class_members cm2
                     WHERE cm2.class_id = a.class_id AND cm2.role = 'student'
                 ) AS total_students,
                 (
                     SELECT COUNT(*)
                     FROM assignment_submissions s
                     WHERE s.assignment_id = a.id AND s.status = 'submitted'
                 ) AS submitted_count,
                 (
                     SELECT COUNT(*)
                     FROM assignment_submissions s
                     INNER JOIN submission_reviews r ON r.submission_id = s.id
                     WHERE s.assignment_id = a.id
                 ) AS reviewed_count
             FROM assignments a
             INNER JOIN classes c
                 ON c.id = a.class_id
             INNER JOIN class_members cm
                 ON cm.class_id = a.class_id
             WHERE cm.user_id = ? AND cm.role = 'teacher'
             ORDER BY a.created_at DESC, a.id DESC`,
            userId,
        );
    }

    async function listStudentAssignments(userId) {
        return db.all(
            `SELECT
                 a.id,
                 a.class_id,
                 c.name AS class_name,
                 a.title,
                 a.description,
                 a.start_at,
                 a.due_at,
                 a.allow_late_submission,
                 a.max_score,
                 a.status,
                 a.created_by_user_id,
                 a.published_at,
                 a.closed_at,
                 a.created_at,
                 a.updated_at,
                 s.id AS submission_id,
                 s.text_answer,
                 s.status AS submission_status,
                 s.submitted_at,
                 s.created_at AS submission_created_at,
                 s.updated_at AS submission_updated_at,
                 r.score AS review_score,
                 r.comment AS review_comment,
                 r.reviewed_at,
                 r.reviewer_user_id
             FROM assignments a
             INNER JOIN classes c
                 ON c.id = a.class_id
             INNER JOIN class_members cm
                 ON cm.class_id = a.class_id
             LEFT JOIN assignment_submissions s
                 ON s.assignment_id = a.id AND s.student_user_id = cm.user_id
             LEFT JOIN submission_reviews r
                 ON r.submission_id = s.id
             WHERE cm.user_id = ? AND cm.role = 'student' AND a.status IN ('published', 'closed', 'archived')
             ORDER BY a.due_at IS NULL ASC, a.due_at ASC, a.created_at DESC, a.id DESC`,
            userId,
        );
    }

    async function getAssignmentById(assignmentId) {
        return db.get(
            `SELECT
                 a.id,
                 a.class_id,
                 c.name AS class_name,
                 a.title,
                 a.description,
                 a.start_at,
                 a.due_at,
                 a.allow_late_submission,
                 a.max_score,
                 a.status,
                 a.created_by_user_id,
                 a.published_at,
                 a.closed_at,
                 a.created_at,
                 a.updated_at
             FROM assignments a
             INNER JOIN classes c
                 ON c.id = a.class_id
             WHERE a.id = ?`,
            assignmentId,
        );
    }

    async function updateAssignment({
        assignmentId,
        title,
        description,
        startAt,
        dueAt,
        allowLateSubmission,
        maxScore,
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

        if (startAt !== undefined) {
            updates.push("start_at = ?");
            values.push(startAt);
        }

        if (dueAt !== undefined) {
            updates.push("due_at = ?");
            values.push(dueAt);
        }

        if (allowLateSubmission !== undefined) {
            updates.push("allow_late_submission = ?");
            values.push(allowLateSubmission ? 1 : 0);
        }

        if (maxScore !== undefined) {
            updates.push("max_score = ?");
            values.push(maxScore);
        }

        if (updates.length === 0) {
            return getAssignmentById(assignmentId);
        }

        values.push(assignmentId);
        await db.run(
            `UPDATE assignments
             SET ${updates.join(", ")}, updated_at = ${nowExpression}
             WHERE id = ?`,
            values,
        );

        return getAssignmentById(assignmentId);
    }

    async function publishAssignment(assignmentId) {
        await db.run(
            `UPDATE assignments
             SET status = 'published',
                 published_at = COALESCE(published_at, ${nowExpression}),
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            assignmentId,
        );

        return getAssignmentById(assignmentId);
    }

    async function closeAssignment(assignmentId) {
        await db.run(
            `UPDATE assignments
             SET status = 'closed',
                 closed_at = COALESCE(closed_at, ${nowExpression}),
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            assignmentId,
        );

        return getAssignmentById(assignmentId);
    }

    async function deleteAssignment(assignmentId) {
        const assignment = await getAssignmentById(assignmentId);

        if (!assignment) {
            return null;
        }

        if (assignment.status === "draft") {
            await db.run(`DELETE FROM assignments WHERE id = ?`, assignmentId);
            return { ...assignment, deleted: true };
        }

        await db.run(
            `UPDATE assignments
             SET status = 'archived', updated_at = ${nowExpression}
             WHERE id = ?`,
            assignmentId,
        );

        return getAssignmentById(assignmentId);
    }

    async function getSubmissionRecord({ assignmentId, studentUserId }) {
        return db.get(
            `SELECT id, assignment_id, student_user_id, text_answer, status, submitted_at, created_at, updated_at
             FROM assignment_submissions
             WHERE assignment_id = ? AND student_user_id = ?`,
            assignmentId,
            studentUserId,
        );
    }

    async function getRosterSubmission({ assignmentId, studentUserId }) {
        return db.get(
            `SELECT
                 a.id AS assignment_id,
                 a.class_id,
                 a.title,
                 a.description,
                 a.start_at,
                 a.due_at,
                 a.allow_late_submission,
                 a.max_score,
                 a.status AS assignment_status,
                 cm.user_id AS student_user_id,
                 cm.joined_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at,
                 s.id AS submission_id,
                 s.text_answer,
                 s.status AS submission_status,
                 s.submitted_at,
                 s.created_at AS submission_created_at,
                 s.updated_at AS submission_updated_at,
                 r.score AS review_score,
                 r.comment AS review_comment,
                 r.reviewed_at,
                 r.updated_at AS review_updated_at,
                 r.reviewer_user_id
             FROM assignments a
             INNER JOIN class_members cm
                 ON cm.class_id = a.class_id AND cm.user_id = ? AND cm.role = 'student'
             INNER JOIN users u
                 ON u.id = cm.user_id
             LEFT JOIN assignment_submissions s
                 ON s.assignment_id = a.id AND s.student_user_id = cm.user_id
             LEFT JOIN submission_reviews r
                 ON r.submission_id = s.id
             WHERE a.id = ?`,
            studentUserId,
            assignmentId,
        );
    }

    async function listRosterSubmissions(assignmentId) {
        return db.all(
            `SELECT
                 a.id AS assignment_id,
                 a.class_id,
                 a.title,
                 a.description,
                 a.start_at,
                 a.due_at,
                 a.allow_late_submission,
                 a.max_score,
                 a.status AS assignment_status,
                 cm.user_id AS student_user_id,
                 cm.joined_at,
                 u.email,
                 u.display_name,
                 u.avatar_url,
                 u.bio,
                 u.default_role,
                 u.created_at AS user_created_at,
                 s.id AS submission_id,
                 s.text_answer,
                 s.status AS submission_status,
                 s.submitted_at,
                 s.created_at AS submission_created_at,
                 s.updated_at AS submission_updated_at,
                 r.score AS review_score,
                 r.comment AS review_comment,
                 r.reviewed_at,
                 r.updated_at AS review_updated_at,
                 r.reviewer_user_id
             FROM assignments a
             INNER JOIN class_members cm
                 ON cm.class_id = a.class_id AND cm.role = 'student'
             INNER JOIN users u
                 ON u.id = cm.user_id
             LEFT JOIN assignment_submissions s
                 ON s.assignment_id = a.id AND s.student_user_id = cm.user_id
             LEFT JOIN submission_reviews r
                 ON r.submission_id = s.id
             WHERE a.id = ?
             ORDER BY cm.joined_at ASC, cm.user_id ASC`,
            assignmentId,
        );
    }

    async function createOrUpdateSubmission({
        assignmentId,
        studentUserId,
        textAnswer,
        status,
    }) {
        const existing = await getSubmissionRecord({
            assignmentId,
            studentUserId,
        });
        const submittedAt =
            status === "submitted" ? new Date().toISOString() : null;

        if (!existing) {
            const result = await db.run(
                `INSERT INTO assignment_submissions (
                     assignment_id,
                     student_user_id,
                     text_answer,
                     status,
                     submitted_at,
                     created_at,
                     updated_at
                 )
                 VALUES (?, ?, ?, ?, ?, ${nowExpression}, ${nowExpression})`,
                assignmentId,
                studentUserId,
                textAnswer,
                status,
                submittedAt,
            );

            return db.get(
                `SELECT id, assignment_id, student_user_id, text_answer, status, submitted_at, created_at, updated_at
                 FROM assignment_submissions
                 WHERE id = ?`,
                result.lastID,
            );
        }

        await db.run(
            `UPDATE assignment_submissions
             SET text_answer = ?,
                 status = ?,
                 submitted_at = ?,
                 updated_at = ${nowExpression}
             WHERE id = ?`,
            textAnswer,
            status,
            submittedAt,
            existing.id,
        );

        return db.get(
            `SELECT id, assignment_id, student_user_id, text_answer, status, submitted_at, created_at, updated_at
             FROM assignment_submissions
             WHERE id = ?`,
            existing.id,
        );
    }

    async function reviewSubmission({
        assignmentId,
        studentUserId,
        reviewerUserId,
        score,
        comment,
    }) {
        const submission = await getSubmissionRecord({
            assignmentId,
            studentUserId,
        });

        if (!submission) {
            return null;
        }

        const existingReview = await db.get(
            `SELECT id FROM submission_reviews WHERE submission_id = ?`,
            submission.id,
        );

        if (!existingReview) {
            await db.run(
                `INSERT INTO submission_reviews (
                     submission_id,
                     reviewer_user_id,
                     score,
                     comment,
                     reviewed_at,
                     updated_at
                 )
                 VALUES (?, ?, ?, ?, ${nowExpression}, ${nowExpression})`,
                submission.id,
                reviewerUserId,
                score,
                comment,
            );
        } else {
            await db.run(
                `UPDATE submission_reviews
                 SET reviewer_user_id = ?,
                     score = ?,
                     comment = ?,
                     reviewed_at = ${nowExpression},
                     updated_at = ${nowExpression}
                 WHERE submission_id = ?`,
                reviewerUserId,
                score,
                comment,
                submission.id,
            );
        }

        return getRosterSubmission({ assignmentId, studentUserId });
    }

    return {
        closeAssignment,
        createAssignment,
        createOrUpdateSubmission,
        deleteAssignment,
        getAssignmentById,
        getRosterSubmission,
        getSubmissionRecord,
        listAssignmentsForClass,
        listAssignmentsForTeacher,
        listRosterSubmissions,
        listStudentAssignments,
        publishAssignment,
        reviewSubmission,
        updateAssignment,
    };
}

module.exports = {
    createAssignmentService,
};
