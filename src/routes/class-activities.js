const fs = require("node:fs/promises");
const express = require("express");
const multer = require("multer");
const { withImmediateTransaction } = require("../lib/db");
const { toIsoTimestamp } = require("../lib/time");
const { USER_ROLES, sanitizeUser } = require("../lib/users");
const { createChatClient } = require("../services/solochat/ai-client-factory");
const { createClassService } = require("../services/classes/class-service");
const {
    createClassActivityService,
} = require("../services/classes/class-activity-service");
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
const {
    buildSoloChatSnapshotAttachmentUrl,
} = require("../services/solochat/attachment-contract");

const MAX_ACTIVITY_ATTACHMENTS = 10;
const MAX_SUBMISSION_ATTACHMENTS = 10;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SOLOCHAT_PREVIEW_CHARS = 2000;
const MAX_SUMMARY_SUBMISSIONS = 80;

const activityUpload = multer({
    defParamCharset: "utf8",
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_ACTIVITY_ATTACHMENTS,
    },
});

const submissionUpload = multer({
    defParamCharset: "utf8",
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_SUBMISSION_ATTACHMENTS,
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
    if (!req.session.userId) throw unauthorized("Not authenticated");
    return req.session.userId;
}

function parsePositiveInteger(value, fieldName) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw badRequest(`A valid ${fieldName} is required`);
    }
    return parsed;
}

function parseTitle(value) {
    const title = String(value || "").trim();
    if (!title) throw badRequest("title is required");
    if (title.length > 160) throw badRequest("title must be 160 characters or fewer");
    return title;
}

function parsePromptText(value) {
    const promptText = String(value || "").trim();
    if (!promptText) throw badRequest("promptText is required");
    if (promptText.length > 8000) {
        throw badRequest("promptText must be 8000 characters or fewer");
    }
    return promptText;
}

function parseAnswerText(value) {
    const answerText = String(value || "").trim();
    if (answerText.length > 20000) {
        throw badRequest("answerText must be 20000 characters or fewer");
    }
    return answerText;
}

function parseDueAt(value) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw badRequest("dueAt must be a valid ISO timestamp");
    }
    return parsed.toISOString();
}

function parseStatus(value) {
    const status = String(value || "").trim();
    if (!["draft", "active", "discussion", "ended"].includes(status)) {
        throw badRequest("status must be draft, active, discussion, or ended");
    }
    return status;
}

function serializeId(value) {
    return value === undefined || value === null ? null : String(value);
}

function parseJson(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch (_error) {
        return null;
    }
}

function normalizeAttachmentKind(kind) {
    if (kind === "image" || kind === "document") {
        return kind;
    }

    return "text";
}

function buildActivityAttachmentUrl(fileId) {
    return `/class-activities/files/${fileId}`;
}

function sanitizeAttachment(file) {
    return {
        id: serializeId(file.id),
        kind: normalizeAttachmentKind(file.kind),
        fileName: file.file_name,
        url: buildActivityAttachmentUrl(serializeId(file.id)),
        mimeType: file.mime_type,
        width: file.width ?? null,
        height: file.height ?? null,
        sizeBytes: file.size_bytes,
        createdAt: toIsoTimestamp(file.created_at),
    };
}

function sanitizeActivityBase(activity) {
    return {
        id: serializeId(activity.id),
        classId: serializeId(activity.class_id),
        title: activity.title,
        promptText: activity.prompt_text,
        aiGuidance: activity.ai_guidance,
        status: activity.status,
        dueAt: activity.due_at ? toIsoTimestamp(activity.due_at) : null,
        summaryStatus: activity.summary_status,
        summaryMarkdown: activity.summary_markdown || "",
        summaryErrorMessage: activity.summary_error_message || null,
        focusedSubmissionId: serializeId(activity.focused_submission_id),
        createdAt: toIsoTimestamp(activity.created_at),
        updatedAt: toIsoTimestamp(activity.updated_at),
    };
}

function sanitizeShowcaseComment(comment) {
    const user = sanitizeUser({
        id: comment.user_id,
        email: comment.email,
        display_name: comment.display_name,
        avatar_url: comment.avatar_url,
        bio: comment.bio,
        default_role: comment.default_role,
        created_at: comment.user_created_at,
    });
    return {
        id: serializeId(comment.id),
        activityId: serializeId(comment.activity_id),
        submissionId: serializeId(comment.submission_id),
        userId: serializeId(comment.user_id),
        user,
        body: comment.body,
        createdAt: toIsoTimestamp(comment.created_at),
    };
}

function sanitizeActivityListItem(activity, role) {
    const base = sanitizeActivityBase(activity);
    if (role === USER_ROLES.TEACHER) {
        return {
            ...base,
            totalStudentCount: Number(activity.total_student_count || 0),
            workspaceCount: Number(activity.workspace_count || 0),
            submissionCount: Number(activity.submission_count || 0),
            showcaseCount: Number(activity.showcase_count || 0),
        };
    }

    return {
        ...base,
        workspaceConversationId: serializeId(activity.workspace_conversation_id),
        latestSubmission: activity.latest_submission_id
            ? {
                  id: serializeId(activity.latest_submission_id),
                  submissionVersion: Number(activity.latest_submission_version || 0),
                  submittedAt: activity.latest_submitted_at
                      ? toIsoTimestamp(activity.latest_submitted_at)
                      : null,
              }
            : null,
    };
}

function sanitizeActivityDetail({
    activity,
    role,
    files,
    workspace = null,
    latestSubmission = null,
    latestSubmissionFiles = [],
    showcasedSubmissions = [],
    showcaseCommentsBySubmissionId = {},
    showcaseFilesBySubmissionId = {},
    viewerUserId = null,
}) {
    const creator = sanitizeUser({
        id: activity.creator_user_id,
        email: activity.creator_email,
        display_name: activity.creator_display_name,
        avatar_url: activity.creator_avatar_url,
        bio: activity.creator_bio,
        default_role: activity.creator_default_role,
        created_at: activity.creator_created_at,
    });

    return {
        ...sanitizeActivityBase(activity),
        creator,
        role,
        attachments: files.map(sanitizeAttachment),
        workspace: workspace
            ? {
                  conversationId: serializeId(workspace.conversation_id),
                  startedAt: toIsoTimestamp(workspace.started_at),
                  updatedAt: toIsoTimestamp(workspace.updated_at),
              }
            : null,
        latestSubmission: latestSubmission
            ? sanitizeSubmission(latestSubmission, {
                  files: latestSubmissionFiles,
                  includeSnapshot: true,
              })
            : null,
        showcasedSubmissions: showcasedSubmissions.map((submission) => {
            const submissionId = serializeId(submission.id);
            const isRedacted =
                role === USER_ROLES.STUDENT &&
                submission.is_anonymous &&
                serializeId(submission.user_id) !==
                    serializeId(viewerUserId);
            const sanitized = sanitizeSubmission(submission, {
                // Hide attachments for anonymous showcased submissions when
                // the viewer is not the author (URLs would leak ownership).
                files: isRedacted
                    ? []
                    : showcaseFilesBySubmissionId[submissionId] || [],
                includeSnapshot: false,
                redactAnonymous:
                    role === USER_ROLES.STUDENT &&
                    serializeId(submission.user_id) !==
                        serializeId(viewerUserId),
            });
            const comments = (
                showcaseCommentsBySubmissionId[submissionId] || []
            ).map(sanitizeShowcaseComment);
            return { ...sanitized, comments };
        }),
    };
}

function sanitizeSubmission(
    submission,
    { files = [], includeSnapshot = false, redactAnonymous = false } = {},
) {
    const isAnonymous = Boolean(submission.is_anonymous);
    const fullUser = submission.email
        ? sanitizeUser({
              id: submission.user_id,
              email: submission.email,
              display_name: submission.display_name,
              avatar_url: submission.avatar_url,
              bio: submission.bio,
              default_role: submission.default_role,
              created_at: submission.user_created_at,
          })
        : null;
    const shouldRedact = redactAnonymous && isAnonymous;

    return {
        id: serializeId(submission.id),
        activityId: serializeId(submission.activity_id),
        userId: shouldRedact ? null : serializeId(submission.user_id),
        user: shouldRedact ? null : fullUser,
        isAnonymous,
        answerText: submission.answer_text || "",
        sourceConversationId: shouldRedact
            ? null
            : serializeId(submission.source_conversation_id),
        solochatSnapshot:
            includeSnapshot && !shouldRedact
                ? parseJson(submission.solochat_snapshot_json)
                : null,
        submissionVersion: Number(submission.submission_version || 0),
        submittedAt: submission.submitted_at
            ? toIsoTimestamp(submission.submitted_at)
            : null,
        showcased: Boolean(submission.showcased),
        attachmentCount: Number(submission.attachment_count || files.length || 0),
        attachments: files.map(sanitizeAttachment),
    };
}

function parseUpload(req, res, upload, maxFiles) {
    return new Promise((resolve, reject) => {
        upload.fields([
            { name: "attachments", maxCount: maxFiles },
            { name: "attachments[]", maxCount: maxFiles },
        ])(req, res, (error) => {
            if (!error) return resolve();
            if (error instanceof multer.MulterError) {
                if (error.code === "LIMIT_FILE_SIZE") {
                    return reject(badRequest("Each attachment must be 20MB or smaller"));
                }
                if (error.code === "LIMIT_FILE_COUNT") {
                    return reject(
                        badRequest(`attachments must contain ${maxFiles} files or fewer`),
                    );
                }
                if (error.code === "LIMIT_UNEXPECTED_FILE") {
                    return reject(
                        badRequest('attachments must be uploaded under the "attachments" field'),
                    );
                }
                return reject(badRequest("Attachment upload failed"));
            }
            return reject(error);
        });
    });
}

function normalizeMultipartFiles(files, maxFiles) {
    if (!files) return [];
    const uploadedFiles = [
        ...(Array.isArray(files.attachments) ? files.attachments : []),
        ...(Array.isArray(files["attachments[]"]) ? files["attachments[]"] : []),
    ];
    if (uploadedFiles.length > maxFiles) {
        throw badRequest(`attachments must contain ${maxFiles} files or fewer`);
    }
    return uploadedFiles;
}

function validateTotalAttachmentSize(uploadedFiles) {
    const totalBytes = uploadedFiles.reduce((sum, file) => sum + (file.size || 0), 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
        throw badRequest("Total attachment size must be 20MB or smaller");
    }
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

async function deleteStoredAttachments(attachments) {
    await Promise.all(
        attachments.map(async (attachment) => {
            try {
                await fs.unlink(attachment.storage_path);
            } catch (error) {
                if (error?.code !== "ENOENT") throw error;
            }
        }),
    );
}

function isTeacherInClass(classRecord) {
    return classRecord?.membership_role === USER_ROLES.TEACHER;
}

function hasDueAtPassed(dueAt) {
    if (!dueAt) return false;
    const parsed = new Date(dueAt);
    return !Number.isNaN(parsed.getTime()) && parsed.getTime() <= Date.now();
}

function buildActivityContextPrompt(activity) {
    const lines = [
        `课堂活动标题：${activity.title}`,
        `课堂题目/要求：${activity.prompt_text || "未提供"}`,
    ];
    if (activity.due_at) lines.push(`课堂截止时间：${toIsoTimestamp(activity.due_at)}`);
    lines.push("请以课堂助教身份进行引导，帮助学生形成自己的最终答案。");
    return lines.join("\n");
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

    if (!conversation) throw badRequest("conversationId is invalid");

    const messages = await conversationService.listMessages(conversationId);
    const snapshotMessages = [];

    for (const message of messages) {
        const attachments = [];
        for (const attachment of Array.isArray(message.attachments)
            ? message.attachments
            : []) {
            const snapshotAttachment = {
                id: serializeId(attachment.id),
                kind: normalizeAttachmentKind(attachment.kind),
                fileName: attachment.file_name,
                mimeType: attachment.mime_type,
                sizeBytes: attachment.size_bytes,
                width: attachment.width ?? null,
                height: attachment.height ?? null,
                url: buildSoloChatSnapshotAttachmentUrl(
                    serializeId(attachment.id),
                ),
            };
            if (snapshotAttachment.kind === "text") {
                const preview = await fileService.readTextPreview(attachment, {
                    maxChars: MAX_SOLOCHAT_PREVIEW_CHARS,
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

function buildSummaryMessages({ activity, submissions }) {
    const latestSubmissions = submissions.slice(0, MAX_SUMMARY_SUBMISSIONS);
    const body = [
        `课堂活动：${activity.title}`,
        `题目要求：${activity.prompt_text}`,
        "",
        "学生提交：",
        ...latestSubmissions.map((submission, index) => {
            const name = submission.display_name || submission.email || `学生${index + 1}`;
            return [
                `#${index + 1} ${name}`,
                `答案：${submission.answer_text || "未填写文字答案"}`,
                `提交版本：${submission.submission_version}`,
            ].join("\n");
        }),
    ].join("\n\n");

    return [
        {
            role: "system",
            content:
                "你是课堂讨论助教。请用简体中文把全班答案做课堂讨论汇总，不打分。输出 Markdown，包含：主要思路分组、典型答案、常见误区、建议讨论顺序、可追问的问题。",
        },
        {
            role: "user",
            content: body,
        },
    ];
}

function createClassActivitiesRouter(db, { activityEventsHub }) {
    const router = express.Router();
    const classService = createClassService(db);
    const activityService = createClassActivityService(db);
    const fileService = createFileService(db);
    const conversationService = createSoloChatConversationService(db);
    const summaryClient = createChatClient();

    async function emitActivityInvalidation({
        classId,
        activityId = null,
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

        activityEventsHub.emitToUsers(targetUserIds, {
            type: "class_activity.invalidate",
            classId: String(classId),
            activityId: activityId ? String(activityId) : null,
            submissionId: submissionId ? String(submissionId) : null,
            targets,
            reason,
        });
    }

    async function requireClassMembership({ classId, userId }) {
        const classRecord = await classService.getClassForUser({ classId, userId });
        if (!classRecord) throw notFound("Class not found");
        return classRecord;
    }

    async function requireActivityMembership({ activityId, userId }) {
        const activity = await activityService.getActivityById(activityId);
        if (!activity) throw notFound("Activity not found");
        const classRecord = await requireClassMembership({
            classId: activity.class_id,
            userId,
        });
        return { activity, classRecord };
    }

    async function requireTeacherActivity({ activityId, userId }) {
        const context = await requireActivityMembership({ activityId, userId });
        if (!isTeacherInClass(context.classRecord)) {
            throw forbidden("Only teachers can manage class activities");
        }
        return context;
    }

    router.get("/class-activities/events", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();
            const unsubscribe = activityEventsHub.subscribe(userId, res);
            req.on("close", unsubscribe);
        } catch (error) {
            return next(error);
        }
    });

    router.get("/classes/:classId/activities", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parsePositiveInteger(req.params.classId, "classId");
            const classRecord = await requireClassMembership({ classId, userId });
            if (isTeacherInClass(classRecord)) {
                const activities =
                    await activityService.listActivitiesForTeacher(classId);
                return res.json(
                    activities.map((activity) =>
                        sanitizeActivityListItem(activity, USER_ROLES.TEACHER),
                    ),
                );
            }
            const activities = await activityService.listActivitiesForStudent({
                classId,
                userId,
            });
            return res.json(
                activities.map((activity) =>
                    sanitizeActivityListItem(activity, USER_ROLES.STUDENT),
                ),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.post("/classes/:classId/activities", async (req, res, next) => {
        let createdFiles = [];
        try {
            const userId = requireUserId(req);
            const classId = parsePositiveInteger(req.params.classId, "classId");
            const classRecord = await requireClassMembership({ classId, userId });
            if (!isTeacherInClass(classRecord)) {
                throw forbidden("Only teachers can create class activities");
            }
            if (!req.is("multipart/form-data")) {
                throw unsupportedMediaType("Content-Type must be multipart/form-data");
            }

            await parseUpload(req, res, activityUpload, MAX_ACTIVITY_ATTACHMENTS);
            const uploadedFiles = normalizeMultipartFiles(
                req.files,
                MAX_ACTIVITY_ATTACHMENTS,
            );
            validateTotalAttachmentSize(uploadedFiles);

            const activity = await withImmediateTransaction(async (txDb) => {
                const txActivityService = createClassActivityService(txDb);
                const txFileService = createFileService(txDb);
                const createdActivity = await txActivityService.createActivity({
                    classId,
                    creatorUserId: userId,
                    title: parseTitle(req.body?.title),
                    promptText: parsePromptText(req.body?.promptText),
                    dueAt: parseDueAt(req.body?.dueAt),
                });
                createdFiles = [];
                for (const uploadedFile of uploadedFiles) {
                    createdFiles.push(
                        await txFileService.processAssignmentFileUpload({
                            userId,
                            file: uploadedFile,
                            subDir: "class-activity-references",
                        }),
                    );
                }
                for (const createdFile of createdFiles) {
                    await txActivityService.attachFileToActivity({
                        activityId: createdActivity.id,
                        fileId: createdFile.id,
                    });
                }
                return createdActivity;
            });
            createdFiles = [];

            await emitActivityInvalidation({
                classId,
                activityId: activity.id,
                targets: ["activities"],
                reason: "activity_created",
                excludeUserIds: [userId],
            });

            return res
                .status(201)
                .json(sanitizeActivityListItem(activity, USER_ROLES.TEACHER));
        } catch (error) {
            if (createdFiles.length) await deleteStoredAttachments(createdFiles);
            return next(error);
        }
    });

    router.get("/class-activities/:activityId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const activityId = parsePositiveInteger(
                req.params.activityId,
                "activityId",
            );
            const { activity, classRecord } = await requireActivityMembership({
                activityId,
                userId,
            });
            const files = await activityService.listActivityFiles(activityId);
            const role = isTeacherInClass(classRecord)
                ? USER_ROLES.TEACHER
                : USER_ROLES.STUDENT;
            if (role === USER_ROLES.STUDENT && activity.status === "draft") {
                throw notFound("Activity not found");
            }
            const workspace =
                role === USER_ROLES.STUDENT
                    ? await activityService.getWorkspace({ activityId, userId })
                    : null;
            const latestSubmission =
                role === USER_ROLES.STUDENT
                    ? await activityService.getLatestSubmissionForUser({
                          activityId,
                          userId,
                      })
                    : null;
            const showcasedSubmissions =
                await activityService.listShowcasedSubmissions(activityId);
            const showcaseCommentsBySubmissionId = {};
            const showcaseFilesBySubmissionId = {};
            for (const showcased of showcasedSubmissions) {
                const submissionId = serializeId(showcased.id);
                showcaseCommentsBySubmissionId[submissionId] =
                    await activityService.listShowcaseComments({
                        activityId,
                        submissionId: showcased.id,
                    });
                showcaseFilesBySubmissionId[submissionId] =
                    await activityService.listSubmissionFiles(showcased.id);
            }
            const latestSubmissionFiles = latestSubmission
                ? await activityService.listSubmissionFiles(latestSubmission.id)
                : [];
            return res.json(
                sanitizeActivityDetail({
                    activity,
                    role,
                    files,
                    workspace,
                    latestSubmission,
                    latestSubmissionFiles,
                    showcasedSubmissions,
                    showcaseCommentsBySubmissionId,
                    showcaseFilesBySubmissionId,
                    viewerUserId: userId,
                }),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.patch("/class-activities/:activityId/status", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const activityId = parsePositiveInteger(
                req.params.activityId,
                "activityId",
            );
            const { activity } = await requireTeacherActivity({ activityId, userId });
            const status = parseStatus(req.body?.status);
            const updated = await activityService.updateActivityStatus({
                activityId,
                status,
            });

            await emitActivityInvalidation({
                classId: activity.class_id,
                activityId,
                targets: ["activities", "activityDetail"],
                reason: "activity_status_updated",
                excludeUserIds: [userId],
            });

            return res.json(sanitizeActivityBase(updated));
        } catch (error) {
            return next(error);
        }
    });

    router.post("/class-activities/:activityId/workspace", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const activityId = parsePositiveInteger(
                req.params.activityId,
                "activityId",
            );
            const { activity, classRecord } = await requireActivityMembership({
                activityId,
                userId,
            });
            if (isTeacherInClass(classRecord)) {
                throw forbidden("Teachers do not need activity workspaces");
            }
            if (!["active", "discussion"].includes(activity.status)) {
                throw badRequest("Activity is not open");
            }

            let workspace = await activityService.getWorkspace({
                activityId,
                userId,
            });
            if (!workspace) {
                const conversation = await conversationService.createConversation({
                    userId,
                    title: `课堂活动：${activity.title}`,
                    contextType: "class_activity",
                    contextRefId: activity.id,
                    contextPrompt: buildActivityContextPrompt(activity),
                });
                await conversationService.createMessage({
                    conversationId: conversation.id,
                    role: "assistant",
                    content:
                        "我会作为课堂助教帮助你理解题目、拆解思路并检查答案。你可以先告诉我你的想法，最后我会帮你整理成可提交的答案。",
                    status: "completed",
                });
                workspace = await activityService.createWorkspace({
                    activityId,
                    userId,
                    conversationId: conversation.id,
                });
            }

            await emitActivityInvalidation({
                classId: activity.class_id,
                activityId,
                targets: ["activities", "activityDetail", "submissions"],
                reason: "workspace_started",
                excludeUserIds: [userId],
            });

            return res.status(201).json({
                conversationId: serializeId(workspace.conversation_id),
                startedAt: toIsoTimestamp(workspace.started_at),
                updatedAt: toIsoTimestamp(workspace.updated_at),
            });
        } catch (error) {
            return next(error);
        }
    });

    router.post(
        "/class-activities/:activityId/submissions",
        async (req, res, next) => {
            let createdFiles = [];
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const { activity, classRecord } = await requireActivityMembership({
                    activityId,
                    userId,
                });
                if (isTeacherInClass(classRecord)) {
                    throw forbidden("Only students can submit activity answers");
                }
                if (activity.status !== "active") {
                    throw badRequest("Activity is not open for submissions");
                }
                if (hasDueAtPassed(activity.due_at)) {
                    throw badRequest("Activity deadline has passed");
                }
                if (!req.is("multipart/form-data")) {
                    throw unsupportedMediaType(
                        "Content-Type must be multipart/form-data",
                    );
                }

                await parseUpload(req, res, submissionUpload, MAX_SUBMISSION_ATTACHMENTS);
                const uploadedFiles = normalizeMultipartFiles(
                    req.files,
                    MAX_SUBMISSION_ATTACHMENTS,
                );
                validateTotalAttachmentSize(uploadedFiles);
                const answerText = parseAnswerText(req.body?.answerText);
                const isAnonymous = String(req.body?.isAnonymous || "")
                    .toLowerCase()
                    .trim() === "true";
                const workspace = await activityService.getWorkspace({
                    activityId,
                    userId,
                });
                const conversationId = workspace?.conversation_id;
                if (!answerText && !uploadedFiles.length && !conversationId) {
                    throw badRequest("answerText, attachments, or workspace is required");
                }

                const snapshot = conversationId
                    ? await buildSoloChatSnapshot({
                          conversationId,
                          userId,
                          conversationService,
                          fileService,
                      })
                    : null;

                const submission = await withImmediateTransaction(async (txDb) => {
                    const txActivityService = createClassActivityService(txDb);
                    const txFileService = createFileService(txDb);
                    const createdSubmission =
                        await txActivityService.createSubmission({
                            activityId,
                            userId,
                            answerText,
                            sourceConversationId: conversationId,
                            solochatSnapshotJson: snapshot
                                ? JSON.stringify(snapshot)
                                : "",
                            isAnonymous,
                        });
                    createdFiles = [];
                    for (const uploadedFile of uploadedFiles) {
                        createdFiles.push(
                            await txFileService.processAssignmentSubmissionUpload({
                                userId,
                                file: uploadedFile,
                            }),
                        );
                    }
                    for (const createdFile of createdFiles) {
                        await txActivityService.attachFileToSubmission({
                            submissionId: createdSubmission.id,
                            fileId: createdFile.id,
                        });
                    }
                    return createdSubmission;
                });
                createdFiles = [];

                const files = await activityService.listSubmissionFiles(submission.id);
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    submissionId: submission.id,
                    targets: ["activities", "activityDetail", "submissions"],
                    reason: "submission_created",
                    excludeUserIds: [userId],
                });

                return res
                    .status(201)
                    .json(sanitizeSubmission(submission, { files, includeSnapshot: true }));
            } catch (error) {
                if (createdFiles.length) await deleteStoredAttachments(createdFiles);
                return next(error);
            }
        },
    );

    router.get("/class-activities/:activityId/submissions", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const activityId = parsePositiveInteger(
                req.params.activityId,
                "activityId",
            );
            const { classRecord } = await requireActivityMembership({
                activityId,
                userId,
            });
            if (!isTeacherInClass(classRecord)) {
                throw forbidden("Only teachers can list activity submissions");
            }
            const submissions = await activityService.listSubmissions(activityId);
            const sanitizedList = [];
            for (const submission of submissions) {
                const files = await activityService.listSubmissionFiles(
                    submission.id,
                );
                sanitizedList.push(sanitizeSubmission(submission, { files }));
            }
            return res.json(sanitizedList);
        } catch (error) {
            return next(error);
        }
    });

    router.post(
        "/class-activities/:activityId/showcases",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const submissionId = parsePositiveInteger(
                    req.body?.submissionId,
                    "submissionId",
                );
                const { activity } = await requireTeacherActivity({
                    activityId,
                    userId,
                });
                const submission = await activityService.getSubmissionById(
                    submissionId,
                );
                if (!submission || Number(submission.activity_id) !== activityId) {
                    throw notFound("Submission not found");
                }
                const showcased = await activityService.addShowcase({
                    activityId,
                    submissionId,
                    userId,
                });
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    submissionId,
                    targets: ["activityDetail", "submissions"],
                    reason: "showcase_added",
                    excludeUserIds: [userId],
                });
                return res.status(201).json(sanitizeSubmission(showcased));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.delete(
        "/class-activities/:activityId/showcases/:submissionId",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const submissionId = parsePositiveInteger(
                    req.params.submissionId,
                    "submissionId",
                );
                const { activity } = await requireTeacherActivity({
                    activityId,
                    userId,
                });
                await activityService.removeShowcase({ activityId, submissionId });
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    submissionId,
                    targets: ["activityDetail", "submissions"],
                    reason: "showcase_removed",
                    excludeUserIds: [userId],
                });
                return res.status(204).end();
            } catch (error) {
                return next(error);
            }
        },
    );

    router.post("/class-activities/:activityId/summary", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const activityId = parsePositiveInteger(
                req.params.activityId,
                "activityId",
            );
            const { activity } = await requireTeacherActivity({ activityId, userId });
            const submissions =
                await activityService.listLatestSubmissions(activityId);
            if (!submissions.length) {
                throw badRequest("No submissions are available to summarize");
            }

            await activityService.markSummaryGenerating(activityId);
            await emitActivityInvalidation({
                classId: activity.class_id,
                activityId,
                targets: ["activities", "activityDetail"],
                reason: "summary_started",
                excludeUserIds: [userId],
            });

            try {
                const markdown = await summaryClient.createChatCompletion({
                    messages: buildSummaryMessages({ activity, submissions }),
                    temperature: 0.3,
                    maxTokens: 3000,
                });
                const updated = await activityService.storeSummary({
                    activityId,
                    markdown,
                });
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    targets: ["activities", "activityDetail"],
                    reason: "summary_completed",
                    excludeUserIds: [userId],
                });
                return res.json(sanitizeActivityBase(updated));
            } catch (summaryError) {
                const failed = await activityService.markSummaryFailed({
                    activityId,
                    errorMessage: summaryError.message,
                });
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    targets: ["activities", "activityDetail"],
                    reason: "summary_failed",
                    excludeUserIds: [userId],
                });
                return res.status(502).json(sanitizeActivityBase(failed));
            }
        } catch (error) {
            return next(error);
        }
    });

    router.patch(
        "/class-activities/:activityId/focus",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const { activity } = await requireTeacherActivity({
                    activityId,
                    userId,
                });
                const submissionIdRaw = req.body?.submissionId;
                let submissionId = null;
                if (submissionIdRaw !== null && submissionIdRaw !== undefined && submissionIdRaw !== "") {
                    submissionId = parsePositiveInteger(
                        submissionIdRaw,
                        "submissionId",
                    );
                    const submission =
                        await activityService.getSubmissionById(submissionId);
                    if (!submission || Number(submission.activity_id) !== activityId) {
                        throw notFound("Submission not found");
                    }
                }
                const updated = await activityService.setFocusedSubmission({
                    activityId,
                    submissionId,
                });
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    targets: ["activityDetail"],
                    reason: "focus_updated",
                    excludeUserIds: [userId],
                });
                return res.json(sanitizeActivityBase(updated));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get(
        "/class-activities/:activityId/submissions/:submissionId/snapshot",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const submissionId = parsePositiveInteger(
                    req.params.submissionId,
                    "submissionId",
                );
                const { classRecord } = await requireActivityMembership({
                    activityId,
                    userId,
                });
                const submission =
                    await activityService.getSubmissionById(submissionId);
                if (!submission || Number(submission.activity_id) !== activityId) {
                    throw notFound("Submission not found");
                }
                const isTeacher = isTeacherInClass(classRecord);
                const isOwn = Number(submission.user_id) === userId;
                if (!isTeacher && !isOwn) {
                    throw forbidden("Only the author or a teacher can view this snapshot");
                }
                return res.json({
                    submissionId: serializeId(submission.id),
                    snapshot: parseJson(submission.solochat_snapshot_json),
                });
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get(
        "/class-activities/:activityId/submissions/:submissionId/comments",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const submissionId = parsePositiveInteger(
                    req.params.submissionId,
                    "submissionId",
                );
                await requireActivityMembership({ activityId, userId });
                const submission =
                    await activityService.getSubmissionById(submissionId);
                if (!submission || Number(submission.activity_id) !== activityId) {
                    throw notFound("Submission not found");
                }
                const comments = await activityService.listShowcaseComments({
                    activityId,
                    submissionId,
                });
                return res.json(comments.map(sanitizeShowcaseComment));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.post(
        "/class-activities/:activityId/submissions/:submissionId/comments",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const submissionId = parsePositiveInteger(
                    req.params.submissionId,
                    "submissionId",
                );
                const { activity } = await requireActivityMembership({
                    activityId,
                    userId,
                });
                const submission =
                    await activityService.getSubmissionById(submissionId);
                if (!submission || Number(submission.activity_id) !== activityId) {
                    throw notFound("Submission not found");
                }
                if (!Number(submission.showcased)) {
                    throw badRequest("Comments are only allowed on showcased submissions");
                }
                const body = String(req.body?.body || "").trim();
                if (!body) throw badRequest("body is required");
                if (body.length > 1000) {
                    throw badRequest("body must be 1000 characters or fewer");
                }
                const comment = await activityService.addShowcaseComment({
                    activityId,
                    submissionId,
                    userId,
                    body,
                });
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    submissionId,
                    targets: ["activityDetail"],
                    reason: "comment_added",
                    excludeUserIds: [userId],
                });
                return res.status(201).json(sanitizeShowcaseComment(comment));
            } catch (error) {
                return next(error);
            }
        },
    );

    router.delete(
        "/class-activities/:activityId/comments/:commentId",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const activityId = parsePositiveInteger(
                    req.params.activityId,
                    "activityId",
                );
                const commentId = parsePositiveInteger(
                    req.params.commentId,
                    "commentId",
                );
                const { activity, classRecord } =
                    await requireActivityMembership({ activityId, userId });
                const comment = await activityService.getShowcaseComment(commentId);
                if (!comment || Number(comment.activity_id) !== activityId) {
                    throw notFound("Comment not found");
                }
                const isAuthor = Number(comment.user_id) === userId;
                const isTeacher = isTeacherInClass(classRecord);
                if (!isAuthor && !isTeacher) {
                    throw forbidden("Only the author or a teacher can delete this comment");
                }
                await activityService.deleteShowcaseComment({
                    commentId,
                    userId: isAuthor ? userId : Number(comment.user_id),
                });
                await emitActivityInvalidation({
                    classId: activity.class_id,
                    activityId,
                    submissionId: comment.submission_id,
                    targets: ["activityDetail"],
                    reason: "comment_deleted",
                    excludeUserIds: [userId],
                });
                return res.status(204).end();
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get("/class-activities/files/:fileId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const fileId = parsePositiveInteger(req.params.fileId, "fileId");
            const file = await activityService.getActivityFileForUser({
                fileId,
                userId,
            });
            if (!file) throw notFound("Class activity attachment not found");
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
        "/class-activities/files/:fileId/preview-text",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const fileId = parsePositiveInteger(req.params.fileId, "fileId");
                const file = await activityService.getActivityFileForUser({
                    fileId,
                    userId,
                });
                if (!file) throw notFound("Class activity attachment not found");
                if (file.kind !== "text") {
                    throw badRequest("Attachment does not support text preview");
                }
                const preview = await fileService.readTextPreview(file);
                return res.json({
                    id: serializeId(file.id),
                    fileName: file.file_name,
                    mimeType: file.mime_type,
                    sizeBytes: file.size_bytes,
                    textContent: preview.textContent,
                    truncated: preview.truncated,
                    maxChars: preview.maxChars,
                });
            } catch (error) {
                return next(error);
            }
        },
    );

    return router;
}

module.exports = {
    createClassActivitiesRouter,
};
