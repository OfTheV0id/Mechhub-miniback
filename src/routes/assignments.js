const fs = require("node:fs/promises");
const express = require("express");
const multer = require("multer");
const { withImmediateTransaction } = require("../lib/db");
const { toIsoTimestamp } = require("../lib/time");
const { USER_ROLES, sanitizeUser } = require("../lib/users");
const { createClassService } = require("../services/classes/class-service");
const {
    createAssignmentService,
} = require("../services/assignments/assignment-service");
const {
    createAssignmentEvaluator,
} = require("../services/assignments/assignment-evaluator");
const {
    createFileService,
    MAX_UPLOAD_BYTES,
} = require("../services/uploads/file-service");
const {
    createSoloChatConversationService,
} = require("../services/solochat/conversation-service");
const {
    normalizeRenderableMessageContent,
} = require("../services/solochat/math-normalizer");

const MAX_ASSIGNMENT_REFERENCE_ATTACHMENTS = 10;
const MAX_ASSIGNMENT_SUBMISSION_ATTACHMENTS = 10;
const MAX_ASSIGNMENT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SOLOCHAT_ATTACHMENT_PREVIEW_CHARS = 2_000;
const ASSIGNMENT_DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;
const assignmentReferenceUpload = multer({
    defParamCharset: "utf8",
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_ASSIGNMENT_REFERENCE_ATTACHMENTS,
    },
});
const assignmentSubmissionUpload = multer({
    defParamCharset: "utf8",
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_ASSIGNMENT_SUBMISSION_ATTACHMENTS,
    },
});

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function unauthorized(message) {
    const error = new Error(message);
    error.statusCode = 401;
    error.expose = true;
    return error;
}

function forbidden(message) {
    const error = new Error(message);
    error.statusCode = 403;
    error.expose = true;
    return error;
}

function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    error.expose = true;
    return error;
}

function unsupportedMediaType(message) {
    const error = new Error(message);
    error.statusCode = 415;
    error.expose = true;
    return error;
}

function requireUserId(req) {
    if (!req.session.userId) {
        throw unauthorized("Not authenticated");
    }

    return req.session.userId;
}

function parsePositiveInteger(value, fieldName) {
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw badRequest(`A valid ${fieldName} is required`);
    }

    return parsed;
}

function parseClassId(value) {
    return parsePositiveInteger(value, "classId");
}

function parseAssignmentId(value) {
    return parsePositiveInteger(value, "assignmentId");
}

function parseSubmissionId(value) {
    return parsePositiveInteger(value, "submissionId");
}

function parseFileId(value) {
    return parsePositiveInteger(value, "fileId");
}

function parseAssignmentTitle(value) {
    const title = String(value || "").trim();

    if (!title) {
        throw badRequest("title is required");
    }

    if (title.length > 160) {
        throw badRequest("title must be 160 characters or fewer");
    }

    return title;
}

function parseAssignmentDescription(value) {
    if (value !== undefined && value !== null && typeof value !== "string") {
        throw badRequest("description must be a string");
    }

    const description = String(value || "").trim();

    if (description.length > 5_000) {
        throw badRequest("description must be 5000 characters or fewer");
    }

    return description;
}

function parseOptionalAssignmentDescription(value) {
    if (value === undefined) {
        return undefined;
    }

    return parseAssignmentDescription(value);
}

function parseDueAt(value) {
    if (value === undefined) {
        return undefined;
    }

    if (value === null || String(value).trim() === "") {
        return null;
    }

    if (typeof value !== "string") {
        throw badRequest("dueAt must be a string or null");
    }

    const parsedDate = new Date(value);

    if (Number.isNaN(parsedDate.getTime())) {
        throw badRequest("dueAt must be a valid ISO timestamp");
    }

    return parsedDate.toISOString();
}

function parseAnswerText(value) {
    if (value !== undefined && value !== null && typeof value !== "string") {
        throw badRequest("answerText must be a string");
    }

    const answerText = String(value || "").trim();

    if (answerText.length > 20_000) {
        throw badRequest("answerText must be 20000 characters or fewer");
    }

    return answerText;
}

function parseOptionalConversationId(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return null;
    }

    return parsePositiveInteger(value, "solochatConversationId");
}

function parseOptionalScore(value) {
    if (value === undefined) {
        return undefined;
    }

    if (value === null || value === "") {
        return null;
    }

    const score = Number(value);

    if (!Number.isInteger(score) || score < 0 || score > 100) {
        throw badRequest("score must be an integer between 0 and 100");
    }

    return score;
}

function parseFeedbackMarkdown(value) {
    if (value !== undefined && value !== null && typeof value !== "string") {
        throw badRequest("feedbackMarkdown must be a string");
    }

    const feedbackMarkdown = String(value || "").trim();

    if (feedbackMarkdown.length > 20_000) {
        throw badRequest("feedbackMarkdown must be 20000 characters or fewer");
    }

    return feedbackMarkdown;
}

function parseOptionalFeedbackMarkdown(value) {
    if (value === undefined) {
        return undefined;
    }

    return parseFeedbackMarkdown(value);
}

function normalizeMulterError(error, maxFiles) {
    if (!(error instanceof multer.MulterError)) {
        return error;
    }

    if (error.code === "LIMIT_FILE_SIZE") {
        return badRequest("Each attachment must be 20MB or smaller (total attachments must be 20MB or smaller)");
    }

    if (error.code === "LIMIT_FILE_COUNT") {
        return badRequest(
            `attachments must contain ${maxFiles} files or fewer`,
        );
    }

    if (error.code === "LIMIT_UNEXPECTED_FILE") {
        return badRequest("Unexpected upload field");
    }

    return badRequest("Attachment upload failed");
}

function parseSingleReferenceUpload(req, res) {
    return new Promise((resolve, reject) => {
        assignmentReferenceUpload.single("file")(req, res, (error) => {
            if (!error) {
                resolve();
                return;
            }

            reject(
                normalizeMulterError(
                    error,
                    MAX_ASSIGNMENT_REFERENCE_ATTACHMENTS,
                ),
            );
        });
    });
}

function parseAssignmentCreateUpload(req, res) {
    return new Promise((resolve, reject) => {
        assignmentReferenceUpload.fields([
            {
                name: "attachments",
                maxCount: MAX_ASSIGNMENT_REFERENCE_ATTACHMENTS,
            },
            {
                name: "attachments[]",
                maxCount: MAX_ASSIGNMENT_REFERENCE_ATTACHMENTS,
            },
        ])(req, res, (error) => {
            if (!error) {
                resolve();
                return;
            }

            reject(
                normalizeMulterError(
                    error,
                    MAX_ASSIGNMENT_REFERENCE_ATTACHMENTS,
                ),
            );
        });
    });
}

function parseSubmissionUpload(req, res) {
    return new Promise((resolve, reject) => {
        assignmentSubmissionUpload.fields([
            {
                name: "attachments",
                maxCount: MAX_ASSIGNMENT_SUBMISSION_ATTACHMENTS,
            },
            {
                name: "attachments[]",
                maxCount: MAX_ASSIGNMENT_SUBMISSION_ATTACHMENTS,
            },
        ])(req, res, (error) => {
            if (!error) {
                resolve();
                return;
            }

            reject(
                normalizeMulterError(
                    error,
                    MAX_ASSIGNMENT_SUBMISSION_ATTACHMENTS,
                ),
            );
        });
    });
}

function normalizeMultipartFiles(files, maxFiles) {
    if (!files) {
        return [];
    }

    const uploadedFiles = [
        ...(Array.isArray(files.attachments) ? files.attachments : []),
        ...(Array.isArray(files["attachments[]"])
            ? files["attachments[]"]
            : []),
    ];

    if (uploadedFiles.length > maxFiles) {
        throw badRequest(
            `attachments must contain ${maxFiles} files or fewer`,
        );
    }

    return uploadedFiles;
}

function validateTotalAttachmentSize(uploadedFiles) {
    const totalBytes = uploadedFiles.reduce(
        (sum, file) => sum + (file.size || 0),
        0,
    );
    if (totalBytes > MAX_ASSIGNMENT_TOTAL_BYTES) {
        throw badRequest("Total attachment size must be 20MB or smaller");
    }
}

function serializeId(value) {
    if (value === undefined || value === null) {
        return null;
    }

    return String(value);
}

function parseJson(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch (_error) {
        return null;
    }
}

function normalizeAttachmentKind(kind) {
    return kind === "image" ? "image" : "text";
}

function buildAssignmentAttachmentUrl(fileId) {
    return `/assignments/files/${fileId}`;
}

function sanitizeAttachment(file) {
    return {
        id: serializeId(file.id),
        kind: normalizeAttachmentKind(file.kind),
        fileName: file.file_name,
        url: buildAssignmentAttachmentUrl(serializeId(file.id)),
        mimeType: file.mime_type,
        width: file.width ?? null,
        height: file.height ?? null,
        sizeBytes: file.size_bytes,
        createdAt: toIsoTimestamp(file.created_at),
    };
}

function sanitizeTextPreviewResponse(file, preview) {
    return {
        id: serializeId(file.id),
        fileName: file.file_name,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        textContent: preview.textContent,
        truncated: preview.truncated,
        maxChars: preview.maxChars,
    };
}

function sanitizeAssignmentBase(assignment) {
    const dueAt = assignment.due_at ? toIsoTimestamp(assignment.due_at) : null;

    return {
        id: serializeId(assignment.id),
        classId: serializeId(assignment.class_id),
        creator: sanitizeUser({
            id: assignment.creator_user_id,
            email: assignment.creator_email,
            display_name: assignment.creator_display_name,
            avatar_url: assignment.creator_avatar_url,
            bio: assignment.creator_bio,
            default_role: assignment.creator_default_role,
            created_at: assignment.creator_created_at,
        }),
        title: assignment.title,
        description: assignment.description,
        status: computeAssignmentStatus(assignment.due_at),
        dueAt,
        createdAt: toIsoTimestamp(assignment.created_at),
        updatedAt: toIsoTimestamp(assignment.updated_at),
    };
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

function sanitizeAssignmentListBase(assignment) {
    return {
        id: serializeId(assignment.id),
        title: assignment.title,
        status: computeAssignmentStatus(assignment.due_at),
        dueAt: assignment.due_at ? toIsoTimestamp(assignment.due_at) : null,
        createdAt: toIsoTimestamp(assignment.created_at),
        updatedAt: toIsoTimestamp(assignment.updated_at),
    };
}

function sanitizeTeacherAssignmentListItem(assignment) {
    return {
        ...sanitizeAssignmentListBase(assignment),
        submissionCount: Number(assignment.submission_count || 0),
        totalStudentCount: Number(assignment.total_student_count || 0),
    };
}

function sanitizeTeacherAssignmentStats(assignment) {
    return {
        totalStudentCount: Number(assignment.total_student_count || 0),
        submissionCount: Number(assignment.submission_count || 0),
        evaluatedCount: Number(assignment.evaluated_count || 0),
    };
}

function pickSubmissionPublicResult(submission) {
    const isTeacherOverridden = Boolean(submission?.is_teacher_overridden);
    const score = isTeacherOverridden
        ? submission.final_score
        : submission.ai_score;
    const feedbackMarkdown = isTeacherOverridden
        ? submission.final_feedback_markdown
        : submission.ai_feedback_markdown;

    return {
        score: score === undefined || score === null ? null : Number(score),
        feedbackMarkdown: String(feedbackMarkdown || "").trim() || "",
        isTeacherOverridden,
        reviewedAt: submission?.reviewed_at
            ? toIsoTimestamp(submission.reviewed_at)
            : null,
    };
}

function hasAiEvaluation(submission) {
    return Boolean(
        submission?.ai_reviewed_at ||
            submission?.ai_score !== undefined &&
                submission?.ai_score !== null ||
            String(submission?.ai_feedback_markdown || "").trim() ||
            submission?.ai_feedback_json,
    );
}

function hasTeacherReview(submission) {
    return Boolean(
        submission?.is_teacher_overridden ||
            submission?.reviewer_user_id ||
            submission?.reviewed_at,
    );
}

function getEffectiveSubmissionScore(submission) {
    const hasFinalScore =
        submission?.final_score !== undefined && submission?.final_score !== null;
    const hasAiScore =
        submission?.ai_score !== undefined && submission?.ai_score !== null;

    if (hasTeacherReview(submission) && hasFinalScore) {
        return Number(submission.final_score);
    }

    if (hasAiScore) {
        return Number(submission.ai_score);
    }

    return null;
}

function sanitizeTeacherSubmissionReviewer(submission) {
    if (!submission?.reviewer_user_id) {
        return null;
    }

    return sanitizeUser({
        id: submission.reviewer_user_id,
        email: submission.reviewer_email,
        display_name: submission.reviewer_display_name,
        avatar_url: submission.reviewer_avatar_url,
        bio: submission.reviewer_bio,
        default_role: submission.reviewer_default_role,
        created_at: submission.reviewer_created_at,
    });
}

function sanitizeTeacherSubmissionAiResult(submission) {
    return {
        score:
            submission.ai_score === undefined || submission.ai_score === null
                ? null
                : Number(submission.ai_score),
        feedbackMarkdown: submission.ai_feedback_markdown || "",
        feedbackJson: parseJson(submission.ai_feedback_json),
        reviewedAt: submission.ai_reviewed_at
            ? toIsoTimestamp(submission.ai_reviewed_at)
            : null,
    };
}

function sanitizeTeacherSubmissionFinalResult(submission) {
    return {
        score:
            submission.final_score === undefined || submission.final_score === null
                ? null
                : Number(submission.final_score),
        feedbackMarkdown: submission.final_feedback_markdown || "",
        isTeacherOverridden: Boolean(submission.is_teacher_overridden),
        reviewedAt: submission.reviewed_at
            ? toIsoTimestamp(submission.reviewed_at)
            : null,
        reviewer: sanitizeTeacherSubmissionReviewer(submission),
    };
}

function sanitizeStudentSubmissionSummary(submission) {
    const hasExplicitSummaryId = Object.prototype.hasOwnProperty.call(
        submission || {},
        "latest_submission_id",
    );
    const submissionId = hasExplicitSummaryId
        ? submission?.latest_submission_id
        : submission?.id;

    if (!submissionId) {
        return null;
    }

    const publicResult = pickSubmissionPublicResult({
        ai_score:
            submission.ai_score !== undefined
                ? submission.ai_score
                : submission.latest_ai_score,
        ai_feedback_markdown:
            submission.ai_feedback_markdown !== undefined
                ? submission.ai_feedback_markdown
                : submission.latest_ai_feedback_markdown,
        final_score:
            submission.final_score !== undefined
                ? submission.final_score
                : submission.latest_final_score,
        final_feedback_markdown:
            submission.final_feedback_markdown !== undefined
                ? submission.final_feedback_markdown
                : submission.latest_final_feedback_markdown,
        is_teacher_overridden:
            submission.is_teacher_overridden !== undefined
                ? submission.is_teacher_overridden
                : submission.latest_is_teacher_overridden,
        reviewed_at:
            submission.reviewed_at !== undefined
                ? submission.reviewed_at
                : submission.latest_reviewed_at,
    });

    return {
        id: serializeId(submissionId),
        submissionVersion: Number(
            hasExplicitSummaryId
                ? submission.latest_submission_version || 0
                : submission.submission_version || 0,
        ),
        submittedAt: hasExplicitSummaryId
            ? submission.latest_submitted_at
                ? toIsoTimestamp(submission.latest_submitted_at)
                : null
            : submission.submitted_at
              ? toIsoTimestamp(submission.submitted_at)
            : null,
        evaluationStatus: hasExplicitSummaryId
            ? submission.latest_evaluation_status
            : submission.evaluation_status,
        evaluationErrorMessage:
            (hasExplicitSummaryId
                ? submission.latest_evaluation_error_message
                : submission.evaluation_error_message) || null,
        ...publicResult,
    };
}

function sanitizeStudentAssignmentListItem(assignment) {
    return {
        ...sanitizeAssignmentListBase(assignment),
        latestSubmissionStatus: assignment.latest_evaluation_status ?? null,
    };
}

function sanitizeTeacherAssignmentDetail(assignment, files = []) {
    return {
        ...sanitizeAssignmentBase(assignment),
        ...sanitizeTeacherAssignmentStats(assignment),
        attachments: files.map(sanitizeAttachment),
    };
}

function sanitizeStudentAssignmentDetail(assignment, files = []) {
    return {
        ...sanitizeAssignmentBase(assignment),
        attachments: files.map(sanitizeAttachment),
        latestSubmission: sanitizeStudentSubmissionSummary(assignment),
    };
}

function sanitizeStudentSubmissionDetail(submission, files = []) {
    if (!submission) {
        return null;
    }

    const publicResult = pickSubmissionPublicResult(submission);

    return {
        id: serializeId(submission.id),
        assignmentId: serializeId(submission.assignment_id),
        userId: serializeId(submission.user_id),
        answerText: submission.answer_text || "",
        sourceConversationId: serializeId(submission.source_conversation_id),
        solochatSnapshot: parseJson(submission.solochat_snapshot_json),
        submissionVersion: Number(submission.submission_version || 0),
        submittedAt: submission.submitted_at
            ? toIsoTimestamp(submission.submitted_at)
            : null,
        evaluationStatus: submission.evaluation_status,
        evaluationErrorMessage: submission.evaluation_error_message || null,
        attachments: files.map(sanitizeAttachment),
        ...publicResult,
    };
}

function sanitizeTeacherSubmissionSummary(submission) {
    const teacherReviewed = hasTeacherReview(submission);

    return {
        id: serializeId(submission.id),
        assignmentId: serializeId(submission.assignment_id),
        userId: serializeId(submission.user_id),
        submissionVersion: Number(submission.submission_version || 0),
        submittedAt: submission.submitted_at
            ? toIsoTimestamp(submission.submitted_at)
            : null,
        evaluationStatus: submission.evaluation_status,
        evaluationErrorMessage: submission.evaluation_error_message || null,
        attachmentCount: Number(submission.attachment_count || 0),
        score: getEffectiveSubmissionScore(submission),
        aiEvaluated: hasAiEvaluation(submission),
        aiReviewedAt: submission.ai_reviewed_at
            ? toIsoTimestamp(submission.ai_reviewed_at)
            : null,
        teacherReviewed,
        teacherReviewedAt: submission.reviewed_at
            ? toIsoTimestamp(submission.reviewed_at)
            : null,
        user: sanitizeUser({
            id: submission.user_id,
            email: submission.email,
            display_name: submission.display_name,
            avatar_url: submission.avatar_url,
            bio: submission.bio,
            default_role: submission.default_role,
            created_at: submission.user_created_at,
        }),
    };
}

function sanitizeTeacherSubmissionDetail(submission, files = []) {
    return {
        ...sanitizeTeacherSubmissionSummary(submission),
        ai: sanitizeTeacherSubmissionAiResult(submission),
        final: sanitizeTeacherSubmissionFinalResult(submission),
        answerText: submission.answer_text || "",
        sourceConversationId: serializeId(submission.source_conversation_id),
        solochatSnapshot: parseJson(submission.solochat_snapshot_json),
        attachments: files.map(sanitizeAttachment),
        createdAt: toIsoTimestamp(submission.created_at),
        updatedAt: toIsoTimestamp(submission.updated_at),
    };
}

function sanitizeStreamSubmission(submission) {
    return {
        id: serializeId(submission.id),
        assignmentId: serializeId(submission.assignment_id),
        userId: serializeId(submission.user_id),
        submissionVersion: Number(submission.submission_version || 0),
        submittedAt: submission.submitted_at
            ? toIsoTimestamp(submission.submitted_at)
            : null,
        evaluationStatus: submission.evaluation_status,
        evaluationErrorMessage: submission.evaluation_error_message || null,
    };
}

function buildInlineContentDisposition(fileName) {
    const normalizedFileName = String(fileName || "download")
        .replace(/[\r\n]+/g, " ")
        .trim();
    const asciiFallback =
        normalizedFileName.replace(/[^\x20-\x7E]+/g, "_") || "download";
    const quotedFallback = asciiFallback
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');

    return `inline; filename="${quotedFallback}"; filename*=UTF-8''${encodeURIComponent(normalizedFileName)}`;
}

function writeStreamEvent(res, payload) {
    res.write(`${JSON.stringify(payload)}\n`);
}

async function deleteStoredAttachments(files) {
    await Promise.all(
        files.map(async (file) => {
            if (!file?.storage_path) {
                return;
            }

            try {
                await fs.unlink(file.storage_path);
            } catch (error) {
                if (error?.code !== "ENOENT") {
                    throw error;
                }
            }
        }),
    );
}

function isTeacherInClass(classRecord) {
    return classRecord?.membership_role === USER_ROLES.TEACHER;
}

function hasDueAtPassed(dueAt) {
    if (!dueAt) {
        return false;
    }

    const parsed = new Date(dueAt);
    return !Number.isNaN(parsed.getTime()) && parsed.getTime() <= Date.now();
}

async function buildSoloChatSnapshot({
    conversationId,
    userId,
    conversationService,
    fileService,
}) {
    const conversation = await conversationService.getConversationForUser({
        conversationId,
        userId,
    });

    if (!conversation) {
        throw badRequest("solochatConversationId is invalid");
    }

    const messages = await conversationService.listMessages(conversationId);
    const snapshotMessages = [];

    for (const message of messages) {
        const attachments = [];
        const messageAttachments = Array.isArray(message.attachments)
            ? message.attachments
            : [];

        for (const attachment of messageAttachments) {
            const snapshotAttachment = {
                id: serializeId(attachment.id),
                kind: normalizeAttachmentKind(attachment.kind),
                fileName: attachment.file_name,
                mimeType: attachment.mime_type,
                sizeBytes: attachment.size_bytes,
                width: attachment.width ?? null,
                height: attachment.height ?? null,
            };

            if (snapshotAttachment.kind === "text") {
                const preview = await fileService.readTextPreview(attachment, {
                    maxChars: MAX_SOLOCHAT_ATTACHMENT_PREVIEW_CHARS,
                });
                snapshotAttachment.textPreview = preview.textContent;
                snapshotAttachment.truncated = preview.truncated;
            }

            attachments.push(snapshotAttachment);
        }

        snapshotMessages.push({
            id: serializeId(message.id),
            role: message.role,
            type: message.type || "text",
            content: normalizeRenderableMessageContent(message.content),
            createdAt: toIsoTimestamp(message.created_at),
            attachments,
            grading: message.grading || null,
        });
    }

    return {
        conversationId: serializeId(conversation.id),
        title: conversation.title,
        capturedAt: new Date().toISOString(),
        messageCount: snapshotMessages.length,
        messages: snapshotMessages,
    };
}

async function streamSubmissionEvaluation({
    req,
    res,
    assignment,
    submission,
    submissionFiles,
    assignmentService,
    assignmentEvaluator,
    referenceFiles,
    onEvaluationSettled,
}) {
    let streamStarted = false;
    let streamAbortController = null;
    let streamAbortedByClient = false;

    const abortStream = () => {
        streamAbortedByClient = true;

        if (streamAbortController && !streamAbortController.signal.aborted) {
            streamAbortController.abort();
        }
    };

    const handleResponseClose = () => {
        if (!res.writableEnded) {
            abortStream();
        }
    };

    try {
        streamAbortController = new AbortController();
        req.on("aborted", abortStream);
        res.on("close", handleResponseClose);

        res.status(200);
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        streamStarted = true;

        writeStreamEvent(res, {
            type: "submission_saved",
            submission: sanitizeStreamSubmission(submission),
        });
        writeStreamEvent(res, {
            type: "sidebar_update",
            historyItem: sanitizeStreamSubmission(submission),
        });
        writeStreamEvent(res, {
            type: "evaluation_started",
            submissionId: serializeId(submission.id),
        });

        const evaluation = await assignmentEvaluator.evaluateSubmissionStream({
            assignment,
            referenceFiles,
            submission: {
                answerText: submission.answer_text,
                solochatSnapshotJson: submission.solochat_snapshot_json,
            },
            submissionFiles,
            signal: streamAbortController.signal,
            onDelta(delta) {
                if (res.writableEnded || res.destroyed) {
                    abortStream();
                    return;
                }

                writeStreamEvent(res, {
                    type: "evaluation_delta",
                    submissionId: serializeId(submission.id),
                    delta,
                });
            },
        });

        const completedSubmission =
            await assignmentService.storeSubmissionEvaluation({
                submissionId: submission.id,
                score: evaluation.score,
                feedbackMarkdown: evaluation.feedbackMarkdown,
                feedbackJson: evaluation.feedbackJson,
            });

        if (!res.writableEnded && !res.destroyed) {
            writeStreamEvent(res, {
                type: "evaluation_completed",
                submissionId: serializeId(submission.id),
                score: evaluation.score,
                feedbackMarkdown: evaluation.feedbackMarkdown,
                feedbackJson: evaluation.feedbackJson,
                submission: sanitizeStreamSubmission(completedSubmission),
            });
        }

        if (onEvaluationSettled) {
            await onEvaluationSettled();
        }

        return res.end();
    } catch (error) {
        const failedSubmission =
            await assignmentService.markSubmissionEvaluationFailed({
                submissionId: submission.id,
                errorMessage: error.message,
            });

        if (onEvaluationSettled) {
            await onEvaluationSettled();
        }

        if (streamStarted && !streamAbortedByClient && !res.writableEnded && !res.destroyed) {
            writeStreamEvent(res, {
                type: "evaluation_failed",
                submissionId: serializeId(submission.id),
                message: error.message || "Evaluation failed",
                submission: sanitizeStreamSubmission(failedSubmission),
            });
            return res.end();
        }

        if (streamStarted && !res.writableEnded && !res.destroyed) {
            return res.end();
        }

        throw error;
    } finally {
        req.off("aborted", abortStream);
        res.off("close", handleResponseClose);
    }
}

function createAssignmentsRouter(db, { assignmentEventsHub }) {
    const router = express.Router();
    const classService = createClassService(db);
    const assignmentService = createAssignmentService(db);
    const fileService = createFileService(db);
    const conversationService = createSoloChatConversationService(db);
    const assignmentEvaluator = createAssignmentEvaluator({
        fileService,
    });

    async function emitAssignmentInvalidation({
        classId,
        assignmentId,
        submissionId = null,
        targets,
        reason,
        excludeUserIds = [],
    }) {
        const memberUserIds = await classService.listMemberUserIds(classId);
        const excludedUserIds = new Set(excludeUserIds.filter(Boolean));
        const targetUserIds = memberUserIds.filter(
            (userId) => !excludedUserIds.has(userId),
        );

        assignmentEventsHub.emitToUsers(targetUserIds, {
            type: "assignment.invalidate",
            classId: String(classId),
            assignmentId: assignmentId ? String(assignmentId) : null,
            submissionId: submissionId ? String(submissionId) : null,
            targets,
            reason,
        });
    }

    async function requireClassMembership({ classId, userId }) {
        const classRecord = await classService.getClassForUser({
            classId,
            userId,
        });

        if (!classRecord) {
            throw notFound("Class not found");
        }

        return classRecord;
    }

    async function requireTeacherAssignmentContext({ assignmentId, userId }) {
        const assignment = await assignmentService.getAssignmentById(assignmentId);

        if (!assignment) {
            throw notFound("Assignment not found");
        }

        const classRecord = await requireClassMembership({
            classId: assignment.class_id,
            userId,
        });

        if (!isTeacherInClass(classRecord)) {
            throw forbidden("Only teachers can manage assignments");
        }

        return {
            assignment,
            classRecord,
        };
    }

    router.get("/assignments/events", async (req, res, next) => {
        try {
            const userId = requireUserId(req);

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();

            const unsubscribe = assignmentEventsHub.subscribe(userId, res);
            req.on("close", unsubscribe);
        } catch (error) {
            return next(error);
        }
    });

    router.get("/classes/:classId/assignments", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const classRecord = await requireClassMembership({ classId, userId });

            if (isTeacherInClass(classRecord)) {
                const assignments =
                    await assignmentService.listAssignmentsForTeacher(classId);
                return res.json(assignments.map(sanitizeTeacherAssignmentListItem));
            }

            const assignments = await assignmentService.listAssignmentsForStudent({
                classId,
                userId,
            });
            return res.json(assignments.map(sanitizeStudentAssignmentListItem));
        } catch (error) {
            return next(error);
        }
    });

    router.post("/classes/:classId/assignments", async (req, res, next) => {
        let createdFiles = [];

        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const classRecord = await requireClassMembership({ classId, userId });

            if (!isTeacherInClass(classRecord)) {
                throw forbidden("Only teachers can create assignments");
            }

            if (!req.is("multipart/form-data")) {
                throw unsupportedMediaType(
                    "Content-Type must be multipart/form-data",
                );
            }

            await parseAssignmentCreateUpload(req, res);
            const uploadedFiles = normalizeMultipartFiles(
                req.files,
                MAX_ASSIGNMENT_REFERENCE_ATTACHMENTS,
            );
            validateTotalAttachmentSize(uploadedFiles);

            const assignment = await withImmediateTransaction(async (txDb) => {
                const txAssignmentService = createAssignmentService(txDb);
                const txFileService = createFileService(txDb);
                const createdAssignment = await txAssignmentService.createAssignment({
                    classId,
                    creatorUserId: userId,
                    title: parseAssignmentTitle(req.body?.title),
                    description: parseAssignmentDescription(req.body?.description),
                    dueAt: parseDueAt(req.body?.dueAt) ?? null,
                });

                createdFiles = [];
                for (const uploadedFile of uploadedFiles) {
                    createdFiles.push(
                        await txFileService.processAssignmentFileUpload({
                            userId,
                            file: uploadedFile,
                            subDir: "assignment-references",
                        }),
                    );
                }

                for (const createdFile of createdFiles) {
                    await txAssignmentService.attachFileToAssignment({
                        assignmentId: createdAssignment.id,
                        fileId: createdFile.id,
                    });
                }

                return createdAssignment;
            });
            createdFiles = [];

            const summary = await assignmentService.getAssignmentSummaryForTeacher(
                assignment.id,
            );
            const files = await assignmentService.listAssignmentFiles(
                assignment.id,
            );

            await emitAssignmentInvalidation({
                classId,
                assignmentId: assignment.id,
                targets: ["assignments"],
                reason: "assignment_created",
                excludeUserIds: [userId],
            });

            return res
                .status(201)
                .json(sanitizeTeacherAssignmentListItem(summary));
        } catch (error) {
            if (createdFiles.length) {
                await deleteStoredAttachments(createdFiles);
            }

            return next(error);
        }
    });

    router.get("/assignments/:assignmentId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const assignmentId = parseAssignmentId(req.params.assignmentId);
            const assignment = await assignmentService.getAssignmentById(
                assignmentId,
            );

            if (!assignment) {
                throw notFound("Assignment not found");
            }

            const classRecord = await requireClassMembership({
                classId: assignment.class_id,
                userId,
            });

            const files = await assignmentService.listAssignmentFiles(assignmentId);

            if (isTeacherInClass(classRecord)) {
                const summary =
                    await assignmentService.getAssignmentSummaryForTeacher(
                        assignmentId,
                    );
                return res.json(sanitizeTeacherAssignmentDetail(summary, files));
            }

            const summary = await assignmentService.getAssignmentSummaryForStudent({
                assignmentId,
                userId,
            });
            return res.json(sanitizeStudentAssignmentDetail(summary, files));
        } catch (error) {
            return next(error);
        }
    });

    router.patch("/assignments/:assignmentId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const assignmentId = parseAssignmentId(req.params.assignmentId);
            const { assignment } = await requireTeacherAssignmentContext({
                assignmentId,
                userId,
            });

            const title =
                req.body?.title === undefined
                    ? undefined
                    : parseAssignmentTitle(req.body?.title);
            const description = parseOptionalAssignmentDescription(
                req.body?.description,
            );
            const dueAt = parseDueAt(req.body?.dueAt);

            if (
                title === undefined &&
                description === undefined &&
                dueAt === undefined
            ) {
                throw badRequest(
                    "At least one editable assignment field is required",
                );
            }

            await assignmentService.updateAssignment({
                assignmentId,
                title,
                description,
                dueAt,
            });

            const summary = await assignmentService.getAssignmentSummaryForTeacher(
                assignmentId,
            );
            const files = await assignmentService.listAssignmentFiles(
                assignmentId,
            );

            await emitAssignmentInvalidation({
                classId: assignment.class_id,
                assignmentId,
                targets: ["assignments", "assignmentDetail"],
                reason: "assignment_updated",
                excludeUserIds: [userId],
            });

            return res.json(sanitizeTeacherAssignmentDetail(summary, files));
        } catch (error) {
            return next(error);
        }
    });

    router.post("/assignments/:assignmentId/files", async (req, res, next) => {
        let createdFile = null;

        try {
            const userId = requireUserId(req);
            const assignmentId = parseAssignmentId(req.params.assignmentId);
            const { assignment } = await requireTeacherAssignmentContext({
                assignmentId,
                userId,
            });

            if (!req.is("multipart/form-data")) {
                throw unsupportedMediaType(
                    "Content-Type must be multipart/form-data",
                );
            }

            await parseSingleReferenceUpload(req, res);

            if (!req.file) {
                throw badRequest('file must be uploaded under the "file" field');
            }

            createdFile = await fileService.processAssignmentFileUpload({
                userId,
                file: req.file,
                subDir: "assignment-references",
            });

            const attachedFile = await assignmentService.attachFileToAssignment({
                assignmentId: assignment.id,
                fileId: createdFile.id,
            });

            await emitAssignmentInvalidation({
                classId: assignment.class_id,
                assignmentId: assignment.id,
                targets: ["assignmentDetail"],
                reason: "reference_file_added",
                excludeUserIds: [userId],
            });

            return res.status(201).json(sanitizeAttachment(attachedFile));
        } catch (error) {
            if (createdFile) {
                await deleteStoredAttachments([createdFile]);
            }

            return next(error);
        }
    });

    router.delete(
        "/assignments/:assignmentId/files/:fileId",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parseAssignmentId(req.params.assignmentId);
                const fileId = parseFileId(req.params.fileId);
                const { assignment } = await requireTeacherAssignmentContext({
                    assignmentId,
                    userId,
                });

                const removedFile = await assignmentService.removeAssignmentFile({
                    assignmentId,
                    fileId,
                });

                if (!removedFile) {
                    throw notFound("Assignment file not found");
                }

                await emitAssignmentInvalidation({
                    classId: assignment.class_id,
                    assignmentId,
                    targets: ["assignmentDetail"],
                    reason: "reference_file_removed",
                    excludeUserIds: [userId],
                });

                return res.status(204).end();
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get("/assignments/files/:fileId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const fileId = parseFileId(req.params.fileId);
            const file =
                (await assignmentService.getAssignmentReferenceFileForUser({
                    fileId,
                    userId,
                })) ||
                (await assignmentService.getAssignmentSubmissionFileForUser({
                    fileId,
                    userId,
                }));

            if (!file) {
                throw notFound("Assignment attachment not found");
            }

            res.setHeader(
                "Content-Disposition",
                buildInlineContentDisposition(file.file_name),
            );
            return res.type(file.mime_type).sendFile(file.storage_path);
        } catch (error) {
            return next(error);
        }
    });

    router.get(
        "/assignments/files/:fileId/preview-text",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const fileId = parseFileId(req.params.fileId);
                const file =
                    (await assignmentService.getAssignmentReferenceFileForUser({
                        fileId,
                        userId,
                    })) ||
                    (await assignmentService.getAssignmentSubmissionFileForUser({
                        fileId,
                        userId,
                    }));

                if (!file) {
                    throw notFound("Assignment attachment not found");
                }

                if (normalizeAttachmentKind(file.kind) !== "text") {
                    throw badRequest("Attachment does not support text preview");
                }

                const preview = await fileService.readTextPreview(file);
                return res.json(sanitizeTextPreviewResponse(file, preview));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get("/assignments/:assignmentId/submissions", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const assignmentId = parseAssignmentId(req.params.assignmentId);
            await requireTeacherAssignmentContext({
                assignmentId,
                userId,
            });

            const submissions =
                await assignmentService.listSubmissionsForAssignment(
                    assignmentId,
                );
            return res.json(submissions.map(sanitizeTeacherSubmissionSummary));
        } catch (error) {
            return next(error);
        }
    });

    router.patch(
        "/assignments/:assignmentId/submissions/:submissionId/final-review",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parseAssignmentId(req.params.assignmentId);
                const submissionId = parseSubmissionId(req.params.submissionId);
                const { assignment } = await requireTeacherAssignmentContext({
                    assignmentId,
                    userId,
                });

                const submission =
                    await assignmentService.getSubmissionDetailForTeacher({
                        assignmentId,
                        submissionId,
                    });

                if (!submission) {
                    throw notFound("Submission not found");
                }

                const parsedScore = parseOptionalScore(req.body?.score);
                const parsedFeedback = parseOptionalFeedbackMarkdown(
                    req.body?.feedbackMarkdown,
                );

                if (parsedScore === undefined && parsedFeedback === undefined) {
                    throw badRequest(
                        "score or feedbackMarkdown is required for final review",
                    );
                }

                const publicResult = pickSubmissionPublicResult(submission);
                const finalScore =
                    parsedScore === undefined
                        ? publicResult.score
                        : parsedScore;
                const finalFeedbackMarkdown =
                    parsedFeedback === undefined
                        ? publicResult.feedbackMarkdown
                        : parsedFeedback;

                if (finalScore === null) {
                    throw badRequest(
                        "score is required when the submission has no existing score",
                    );
                }

                await assignmentService.updateFinalReview({
                    submissionId,
                    finalScore,
                    finalFeedbackMarkdown,
                    reviewerUserId: userId,
                });

                const updatedSubmission =
                    await assignmentService.getSubmissionDetailForTeacher({
                        assignmentId,
                        submissionId,
                    });
                const files = await assignmentService.listSubmissionFiles(
                    submissionId,
                );

                await emitAssignmentInvalidation({
                    classId: assignment.class_id,
                    assignmentId,
                    submissionId,
                    targets: [
                        "assignments",
                        "assignmentDetail",
                        "submissions",
                        "submissionDetail",
                        "latestSubmission",
                        "submissionHistory",
                    ],
                    reason: "final_review_saved",
                    excludeUserIds: [userId],
                });

                return res.json(
                    sanitizeTeacherSubmissionDetail(updatedSubmission, files),
                );
            } catch (error) {
                return next(error);
            }
        },
    );

    router.post(
        "/assignments/:assignmentId/submissions",
        async (req, res, next) => {
            let createdFiles = [];

            try {
                const userId = requireUserId(req);
                const assignmentId = parseAssignmentId(req.params.assignmentId);
                const assignment = await assignmentService.getAssignmentById(
                    assignmentId,
                );

                if (!assignment) {
                    throw notFound("Assignment not found");
                }

                const classRecord = await requireClassMembership({
                    classId: assignment.class_id,
                    userId,
                });

                if (isTeacherInClass(classRecord)) {
                    throw forbidden("Teachers cannot submit student assignments");
                }

                if (hasDueAtPassed(assignment.due_at)) {
                    throw forbidden("Assignment submissions are closed");
                }

                if (!req.is("multipart/form-data")) {
                    throw unsupportedMediaType(
                        "Content-Type must be multipart/form-data",
                    );
                }

                await parseSubmissionUpload(req, res);
                const uploadedFiles = normalizeMultipartFiles(
                    req.files,
                    MAX_ASSIGNMENT_SUBMISSION_ATTACHMENTS,
                );
                validateTotalAttachmentSize(uploadedFiles);
                const answerText = parseAnswerText(req.body?.answerText);
                const solochatConversationId = parseOptionalConversationId(
                    req.body?.solochatConversationId,
                );

                if (!answerText && !uploadedFiles.length && !solochatConversationId) {
                    throw badRequest(
                        "answerText, attachments, or solochatConversationId is required",
                    );
                }

                const solochatSnapshot = solochatConversationId
                    ? await buildSoloChatSnapshot({
                          conversationId: solochatConversationId,
                          userId,
                          conversationService,
                          fileService,
                      })
                    : null;

                const submission = await withImmediateTransaction(async (txDb) => {
                    const txAssignmentService = createAssignmentService(txDb);
                    const txFileService = createFileService(txDb);

                    createdFiles = [];
                    for (const uploadedFile of uploadedFiles) {
                        createdFiles.push(
                            await txFileService.processAssignmentSubmissionUpload({
                                userId,
                                file: uploadedFile,
                            }),
                        );
                    }

                    return txAssignmentService.createSubmission({
                        assignmentId,
                        userId,
                        answerText,
                        sourceConversationId: solochatConversationId,
                        solochatSnapshotJson: solochatSnapshot
                            ? JSON.stringify(solochatSnapshot)
                            : "",
                        attachmentFileIds: createdFiles.map((file) => file.id),
                    });
                });
                createdFiles = [];

                await emitAssignmentInvalidation({
                    classId: assignment.class_id,
                    assignmentId,
                    submissionId: submission.id,
                    targets: ["assignments", "assignmentDetail", "submissions"],
                    reason: "submission_created",
                    excludeUserIds: [userId],
                });

                const referenceFiles = await assignmentService.listAssignmentFiles(
                    assignmentId,
                );
                const submissionFiles = await assignmentService.listSubmissionFiles(
                    submission.id,
                );

                return await streamSubmissionEvaluation({
                    req,
                    res,
                    assignment,
                    submission,
                    submissionFiles,
                    assignmentService,
                    assignmentEvaluator,
                    referenceFiles,
                    onEvaluationSettled: async () => {
                        await emitAssignmentInvalidation({
                            classId: assignment.class_id,
                            assignmentId,
                            submissionId: submission.id,
                            targets: [
                                "assignments",
                                "assignmentDetail",
                                "submissions",
                                "submissionDetail",
                                "latestSubmission",
                                "submissionHistory",
                            ],
                            reason: "evaluation_settled",
                            excludeUserIds: [userId],
                        });
                        // 单独通知提交学生刷新自己的提交状态
                        assignmentEventsHub.emitToUsers([userId], {
                            type: "assignment.invalidate",
                            classId: String(assignment.class_id),
                            assignmentId: String(assignmentId),
                            submissionId: String(submission.id),
                            targets: [
                                "assignments",
                                "assignmentDetail",
                                "submissionDetail",
                                "latestSubmission",
                                "submissionHistory",
                            ],
                            reason: "evaluation_settled",
                        });
                    },
                });
            } catch (error) {
                if (createdFiles.length) {
                    await deleteStoredAttachments(createdFiles);
                }

                return next(error);
            }
        },
    );

    router.get(
        "/assignments/:assignmentId/submissions/latest",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parseAssignmentId(req.params.assignmentId);
                const assignment = await assignmentService.getAssignmentById(
                    assignmentId,
                );

                if (!assignment) {
                    throw notFound("Assignment not found");
                }

                const classRecord = await requireClassMembership({
                    classId: assignment.class_id,
                    userId,
                });

                if (isTeacherInClass(classRecord)) {
                    throw forbidden("Teachers do not have a latest student submission");
                }

                const submission =
                    await assignmentService.getLatestSubmissionForAssignmentAndUser({
                        assignmentId,
                        userId,
                    });

                if (!submission) {
                    throw notFound("Submission not found");
                }

                const files = await assignmentService.listSubmissionFiles(
                    submission.id,
                );
                return res.json(sanitizeStudentSubmissionDetail(submission, files));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get(
        "/assignments/:assignmentId/submissions/history",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parseAssignmentId(req.params.assignmentId);
                const assignment = await assignmentService.getAssignmentById(
                    assignmentId,
                );

                if (!assignment) {
                    throw notFound("Assignment not found");
                }

                const classRecord = await requireClassMembership({
                    classId: assignment.class_id,
                    userId,
                });

                if (isTeacherInClass(classRecord)) {
                    throw forbidden("Teachers do not have student submissions");
                }

                const history =
                    await assignmentService.listSubmissionHistoryForStudent({
                        assignmentId,
                        userId,
                    });

                return res.json(history.map(sanitizeStudentSubmissionSummary));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get(
        "/assignments/:assignmentId/submissions/:submissionId",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parseAssignmentId(req.params.assignmentId);
                const submissionId = parseSubmissionId(req.params.submissionId);
                const assignment = await assignmentService.getAssignmentById(
                    assignmentId,
                );

                if (!assignment) {
                    throw notFound("Assignment not found");
                }

                const classRecord = await requireClassMembership({
                    classId: assignment.class_id,
                    userId,
                });
                const teacherView = isTeacherInClass(classRecord);
                const submission = teacherView
                    ? await assignmentService.getSubmissionDetailForTeacher({
                          assignmentId,
                          submissionId,
                      })
                    : await assignmentService.getSubmissionDetailForStudent({
                          assignmentId,
                          submissionId,
                          userId,
                      });

                if (!submission) {
                    throw notFound("Submission not found");
                }

                const files = await assignmentService.listSubmissionFiles(
                    submissionId,
                );
                return res.json(
                    teacherView
                        ? sanitizeTeacherSubmissionDetail(submission, files)
                        : sanitizeStudentSubmissionDetail(submission, files),
                );
            } catch (error) {
                return next(error);
            }
        },
    );

    router.post(
        "/assignments/:assignmentId/submissions/:submissionId/re-evaluate",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parseAssignmentId(req.params.assignmentId);
                const submissionId = parseSubmissionId(req.params.submissionId);
                const { assignment } = await requireTeacherAssignmentContext({
                    assignmentId,
                    userId,
                });

                const submission =
                    await assignmentService.getSubmissionDetailForTeacher({
                        assignmentId,
                        submissionId,
                    });

                if (!submission) {
                    throw notFound("Submission not found");
                }

                const evaluatingSubmission =
                    await assignmentService.markSubmissionEvaluating(
                        submissionId,
                    );
                const referenceFiles = await assignmentService.listAssignmentFiles(
                    assignmentId,
                );
                const submissionFiles = await assignmentService.listSubmissionFiles(
                    submissionId,
                );

                return await streamSubmissionEvaluation({
                    req,
                    res,
                    assignment,
                    submission: evaluatingSubmission,
                    submissionFiles,
                    assignmentService,
                    assignmentEvaluator,
                    referenceFiles,
                    onEvaluationSettled: () =>
                        emitAssignmentInvalidation({
                            classId: assignment.class_id,
                            assignmentId,
                            submissionId,
                            targets: [
                                "assignments",
                                "assignmentDetail",
                                "submissions",
                                "submissionDetail",
                                "latestSubmission",
                                "submissionHistory",
                            ],
                            reason: "re_evaluation_settled",
                            excludeUserIds: [userId],
                        }),
                });
            } catch (error) {
                return next(error);
            }
        },
    );

    return router;
}

module.exports = {
    createAssignmentsRouter,
};
