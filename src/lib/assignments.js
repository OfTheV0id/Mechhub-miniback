const { toIsoTimestamp } = require("./time");
const { sanitizeUser } = require("./users");

function sanitizeFileAsset(file) {
    return {
        id: file.id,
        kind: file.kind,
        fileName: file.file_name,
        url: `/uploads/files/${file.id}`,
        mimeType: file.mime_type,
        width: file.width ?? null,
        height: file.height ?? null,
        sizeBytes: file.size_bytes,
        purpose: file.purpose,
        createdAt: toIsoTimestamp(file.created_at),
    };
}

function sanitizeAssignment(assignment, attachments = []) {
    return {
        id: assignment.id,
        classId: assignment.class_id,
        className: assignment.class_name,
        title: assignment.title,
        description: assignment.description,
        attachments: attachments.map(sanitizeFileAsset),
        startAt: toIsoTimestamp(assignment.start_at),
        dueAt: toIsoTimestamp(assignment.due_at),
        allowLateSubmission: Boolean(assignment.allow_late_submission),
        maxScore: assignment.max_score,
        status: assignment.status,
        createdByUserId: assignment.created_by_user_id,
        publishedAt: toIsoTimestamp(assignment.published_at),
        closedAt: toIsoTimestamp(assignment.closed_at),
        createdAt: toIsoTimestamp(assignment.created_at),
        updatedAt: toIsoTimestamp(assignment.updated_at),
    };
}

function sanitizeSubmission(row, { attachments = [], reviewer = null } = {}) {
    const review =
        row.review_score !== null && row.review_score !== undefined
            ? {
                  score: row.review_score,
                  comment: row.review_comment || "",
                  reviewedAt: toIsoTimestamp(row.reviewed_at),
                  reviewerUserId: row.reviewer_user_id,
                  reviewer: reviewer ? sanitizeUser(reviewer) : null,
              }
            : null;

    return {
        id: row.submission_id || null,
        assignmentId: row.assignment_id,
        studentId: row.student_user_id,
        student: sanitizeUser({
            id: row.student_user_id,
            email: row.email,
            display_name: row.display_name,
            avatar_url: row.avatar_url,
            bio: row.bio,
            default_role: row.default_role,
            created_at: row.user_created_at,
        }),
        submissionStatus: deriveSubmissionStatus(row),
        textAnswer: row.text_answer || "",
        attachments: attachments.map(sanitizeFileAsset),
        submittedAt: toIsoTimestamp(row.submitted_at),
        updatedAt: toIsoTimestamp(row.submission_updated_at || row.updated_at),
        isLate: isSubmissionLate({
            dueAt: row.due_at,
            submittedAt: row.submitted_at,
        }),
        review,
    };
}

function sanitizeTeacherAssignmentDashboardItem(row) {
    const totalStudents = Number(row.total_students || 0);
    const submittedCount = Number(row.submitted_count || 0);
    const reviewedCount = Number(row.reviewed_count || 0);

    return {
        assignmentId: row.id,
        classId: row.class_id,
        className: row.class_name,
        title: row.title,
        status: row.status,
        dueAt: toIsoTimestamp(row.due_at),
        totalStudents,
        submittedCount,
        reviewedCount,
        pendingReviewCount: Math.max(submittedCount - reviewedCount, 0),
    };
}

function sanitizeStudentAssignmentCard(row) {
    return {
        assignmentId: row.id,
        classId: row.class_id,
        className: row.class_name,
        title: row.title,
        dueAt: toIsoTimestamp(row.due_at),
        assignmentStatus: row.status,
        submissionStatus: deriveSubmissionStatus(row),
        submittedAt: toIsoTimestamp(row.submitted_at),
        isLate: isSubmissionLate({
            dueAt: row.due_at,
            submittedAt: row.submitted_at,
        }),
        score:
            row.review_score === null || row.review_score === undefined
                ? null
                : row.review_score,
    };
}

function deriveSubmissionStatus(row) {
    if (row.review_score !== null && row.review_score !== undefined) {
        return "reviewed";
    }

    if (!row.submission_id) {
        return "not_started";
    }

    if (row.submission_status === "draft") {
        return "draft";
    }

    return isSubmissionLate({
        dueAt: row.due_at,
        submittedAt: row.submitted_at,
    })
        ? "late_submitted"
        : "submitted";
}

function isSubmissionLate({ dueAt, submittedAt }) {
    if (!dueAt || !submittedAt) {
        return false;
    }

    const dueTime = new Date(dueAt).getTime();
    const submittedTime = new Date(submittedAt).getTime();

    if (Number.isNaN(dueTime) || Number.isNaN(submittedTime)) {
        return false;
    }

    return submittedTime > dueTime;
}

module.exports = {
    deriveSubmissionStatus,
    isSubmissionLate,
    sanitizeAssignment,
    sanitizeFileAsset,
    sanitizeStudentAssignmentCard,
    sanitizeSubmission,
    sanitizeTeacherAssignmentDashboardItem,
};
