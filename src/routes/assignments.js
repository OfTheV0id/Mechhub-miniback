const express = require("express");
const { getUserById } = require("../lib/users");
const {
    sanitizeAssignment,
    sanitizeSubmission,
} = require("../lib/assignments");
const {
    createAssignmentService,
} = require("../services/assignments/assignment-service");
const { createClassService } = require("../services/classes/class-service");
const { createFileService } = require("../services/uploads/file-service");

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function unauthorized(message) {
    const error = new Error(message);
    error.statusCode = 401;
    return error;
}

function forbidden(message) {
    const error = new Error(message);
    error.statusCode = 403;
    return error;
}

function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

function requireUserId(req) {
    if (!req.session.userId) {
        throw unauthorized("Not authenticated");
    }

    return req.session.userId;
}

function parsePositiveInt(value, fieldName) {
    const parsedValue = Number(value);

    if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
        throw badRequest(`A valid ${fieldName} is required`);
    }

    return parsedValue;
}

function parseOptionalString(value, fieldName, maxLength) {
    if (value === undefined) {
        return undefined;
    }

    if (value !== null && typeof value !== "string") {
        throw badRequest(`${fieldName} must be a string`);
    }

    const normalizedValue = String(value || "").trim();

    if (maxLength && normalizedValue.length > maxLength) {
        throw badRequest(
            `${fieldName} must be ${maxLength} characters or fewer`,
        );
    }

    return normalizedValue;
}

function parseRequiredString(value, fieldName, maxLength) {
    const normalizedValue = parseOptionalString(value, fieldName, maxLength);

    if (!normalizedValue) {
        throw badRequest(`${fieldName} is required`);
    }

    return normalizedValue;
}

function parseOptionalDateTime(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }

    if (value === null || value === "") {
        return null;
    }

    if (typeof value !== "string") {
        throw badRequest(`${fieldName} must be a valid ISO date-time string`);
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw badRequest(`${fieldName} must be a valid ISO date-time string`);
    }

    return date.toISOString();
}

function parseOptionalBoolean(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "boolean") {
        throw badRequest(`${fieldName} must be a boolean`);
    }

    return value;
}

function parseOptionalNumber(value, fieldName) {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
        throw badRequest(`${fieldName} must be a non-negative number`);
    }

    return value;
}

function parseCreateAssignmentInput(body = {}) {
    const title = parseRequiredString(body.title, "title", 200);
    const description = parseRequiredString(
        body.description,
        "description",
        10000,
    );
    const startAt = parseOptionalDateTime(body.startAt, "startAt");
    const dueAt = parseOptionalDateTime(body.dueAt, "dueAt");

    validateStartAndDueAt({ startAt, dueAt });

    return {
        title,
        description,
        attachmentIds: normalizeAttachmentIds(body.attachmentIds),
        startAt,
        dueAt,
        allowLateSubmission:
            body.allowLateSubmission === undefined
                ? false
                : parseOptionalBoolean(
                      body.allowLateSubmission,
                      "allowLateSubmission",
                  ),
        maxScore:
            body.maxScore === undefined
                ? 100
                : parseOptionalNumber(body.maxScore, "maxScore"),
        status: parseCreateAssignmentStatus(body.status),
    };
}

function parseUpdateAssignmentInput(body = {}) {
    const title = parseOptionalString(body.title, "title", 200);
    const description = parseOptionalString(
        body.description,
        "description",
        10000,
    );
    const startAt = parseOptionalDateTime(body.startAt, "startAt");
    const dueAt = parseOptionalDateTime(body.dueAt, "dueAt");

    if (
        title === undefined &&
        description === undefined &&
        body.attachmentIds === undefined &&
        startAt === undefined &&
        dueAt === undefined &&
        body.allowLateSubmission === undefined &&
        body.maxScore === undefined
    ) {
        throw badRequest("At least one assignment field is required");
    }

    validateStartAndDueAt({ startAt, dueAt });

    return {
        title,
        description,
        attachmentIds:
            body.attachmentIds === undefined
                ? undefined
                : normalizeAttachmentIds(body.attachmentIds),
        startAt,
        dueAt,
        allowLateSubmission: parseOptionalBoolean(
            body.allowLateSubmission,
            "allowLateSubmission",
        ),
        maxScore: parseOptionalNumber(body.maxScore, "maxScore"),
    };
}

function parseCreateAssignmentStatus(value) {
    if (value === undefined) {
        return "draft";
    }

    if (value !== "draft" && value !== "published") {
        throw badRequest("status must be either draft or published");
    }

    return value;
}

function parseSubmissionInput(body = {}) {
    const textAnswer = parseOptionalString(
        body.textAnswer,
        "textAnswer",
        50000,
    );
    const status = body.status;

    if (status !== "draft" && status !== "submitted") {
        throw badRequest("status must be either draft or submitted");
    }

    return {
        textAnswer: textAnswer || "",
        attachmentIds: normalizeAttachmentIds(body.attachmentIds),
        status,
    };
}

function parseReviewInput(body = {}) {
    const score = parseOptionalNumber(body.score, "score");

    if (score === undefined) {
        throw badRequest("score is required");
    }

    return {
        score,
        comment: parseOptionalString(body.comment, "comment", 10000) || "",
    };
}

function normalizeAttachmentIds(value) {
    if (value === undefined || value === null) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw badRequest("attachmentIds must be an array");
    }

    const seen = new Set();
    return value.map((entry) => {
        const attachmentId = Number(entry);

        if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
            throw badRequest("attachmentIds must contain positive integers");
        }

        if (seen.has(attachmentId)) {
            throw badRequest("attachmentIds must not contain duplicates");
        }

        seen.add(attachmentId);
        return attachmentId;
    });
}

function validateStartAndDueAt({ startAt, dueAt }) {
    if (!startAt || !dueAt) {
        return;
    }

    if (new Date(startAt).getTime() > new Date(dueAt).getTime()) {
        throw badRequest("startAt must be earlier than or equal to dueAt");
    }
}

async function requireClassMembership({ classService, classId, userId }) {
    const classRecord = await classService.getClassForUser({ classId, userId });

    if (!classRecord) {
        throw notFound("Class not found");
    }

    return classRecord;
}

async function requireTeacherMembership({ classService, classId, userId }) {
    const classRecord = await requireClassMembership({
        classService,
        classId,
        userId,
    });

    if (classRecord.membership_role !== "teacher") {
        throw forbidden("Only class teachers can perform this action");
    }

    return classRecord;
}

async function requireStudentMembership({ classService, classId, userId }) {
    const classRecord = await requireClassMembership({
        classService,
        classId,
        userId,
    });

    if (classRecord.membership_role !== "student") {
        throw forbidden("Only class students can perform this action");
    }

    return classRecord;
}

async function requireAssignmentAccess({
    assignmentService,
    classService,
    assignmentId,
    userId,
}) {
    const assignment = await assignmentService.getAssignmentById(assignmentId);

    if (!assignment) {
        throw notFound("Assignment not found");
    }

    const classRecord = await requireClassMembership({
        classService,
        classId: assignment.class_id,
        userId,
    });

    return {
        assignment,
        classRecord,
    };
}

async function buildAssignmentPayload({ assignment, fileService }) {
    const attachments = await fileService.listFilesForAssignment(assignment.id);
    return sanitizeAssignment(assignment, attachments);
}

async function buildSubmissionPayload({ row, fileService, db }) {
    const attachments = row.submission_id
        ? await fileService.listFilesForSubmission(row.submission_id)
        : [];
    const reviewer = row.reviewer_user_id
        ? await getUserById(db, row.reviewer_user_id)
        : null;

    return sanitizeSubmission(row, {
        attachments,
        reviewer,
    });
}

function createAssignmentsRouter(db) {
    const router = express.Router();
    const assignmentService = createAssignmentService(db);
    const classService = createClassService(db);
    const fileService = createFileService(db);

    router.get("/classes/:classId/assignments", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parsePositiveInt(req.params.classId, "classId");
            const classRecord = await requireClassMembership({
                classService,
                classId,
                userId,
            });
            const assignments = await assignmentService.listAssignmentsForClass(
                {
                    classId,
                    includeDrafts: classRecord.membership_role === "teacher",
                },
            );
            const payload = await Promise.all(
                assignments.map((assignment) =>
                    buildAssignmentPayload({ assignment, fileService }),
                ),
            );

            return res.json(payload);
        } catch (error) {
            return next(error);
        }
    });

    router.post("/classes/:classId/assignments", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parsePositiveInt(req.params.classId, "classId");
            await requireTeacherMembership({ classService, classId, userId });
            const input = parseCreateAssignmentInput(req.body);
            const assignment = await assignmentService.createAssignment({
                classId,
                createdByUserId: userId,
                title: input.title,
                description: input.description,
                startAt: input.startAt,
                dueAt: input.dueAt,
                allowLateSubmission: input.allowLateSubmission,
                maxScore: input.maxScore,
                status: input.status,
            });

            await fileService.replaceAssignmentFiles({
                assignmentId: assignment.id,
                fileIds: input.attachmentIds,
                userId,
            });

            return res.status(201).json(
                await buildAssignmentPayload({
                    assignment: await assignmentService.getAssignmentById(
                        assignment.id,
                    ),
                    fileService,
                }),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.get("/assignments/:assignmentId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const assignmentId = parsePositiveInt(
                req.params.assignmentId,
                "assignmentId",
            );
            const { assignment, classRecord } = await requireAssignmentAccess({
                assignmentService,
                classService,
                assignmentId,
                userId,
            });

            if (
                classRecord.membership_role !== "teacher" &&
                assignment.status === "draft"
            ) {
                throw notFound("Assignment not found");
            }

            return res.json(
                await buildAssignmentPayload({ assignment, fileService }),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.patch("/assignments/:assignmentId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const assignmentId = parsePositiveInt(
                req.params.assignmentId,
                "assignmentId",
            );
            const { assignment, classRecord } = await requireAssignmentAccess({
                assignmentService,
                classService,
                assignmentId,
                userId,
            });

            if (classRecord.membership_role !== "teacher") {
                throw forbidden("Only class teachers can update assignments");
            }

            const input = parseUpdateAssignmentInput(req.body);
            await assignmentService.updateAssignment({
                assignmentId,
                title: input.title,
                description: input.description,
                startAt: input.startAt,
                dueAt: input.dueAt,
                allowLateSubmission: input.allowLateSubmission,
                maxScore: input.maxScore,
            });

            if (input.attachmentIds !== undefined) {
                await fileService.replaceAssignmentFiles({
                    assignmentId,
                    fileIds: input.attachmentIds,
                    userId,
                });
            }

            return res.json(
                await buildAssignmentPayload({
                    assignment: await assignmentService.getAssignmentById(
                        assignment.id,
                    ),
                    fileService,
                }),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.post(
        "/assignments/:assignmentId/publish",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parsePositiveInt(
                    req.params.assignmentId,
                    "assignmentId",
                );
                const { assignment, classRecord } =
                    await requireAssignmentAccess({
                        assignmentService,
                        classService,
                        assignmentId,
                        userId,
                    });

                if (classRecord.membership_role !== "teacher") {
                    throw forbidden(
                        "Only class teachers can publish assignments",
                    );
                }

                if (assignment.status === "published") {
                    throw badRequest("Assignment is already published");
                }

                const updatedAssignment =
                    await assignmentService.publishAssignment(assignmentId);
                return res.json(
                    await buildAssignmentPayload({
                        assignment: updatedAssignment,
                        fileService,
                    }),
                );
            } catch (error) {
                return next(error);
            }
        },
    );

    router.post("/assignments/:assignmentId/close", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const assignmentId = parsePositiveInt(
                req.params.assignmentId,
                "assignmentId",
            );
            const { assignment, classRecord } = await requireAssignmentAccess({
                assignmentService,
                classService,
                assignmentId,
                userId,
            });

            if (classRecord.membership_role !== "teacher") {
                throw forbidden("Only class teachers can close assignments");
            }

            if (assignment.status === "closed") {
                throw badRequest("Assignment is already closed");
            }

            const updatedAssignment =
                await assignmentService.closeAssignment(assignmentId);
            return res.json(
                await buildAssignmentPayload({
                    assignment: updatedAssignment,
                    fileService,
                }),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.delete("/assignments/:assignmentId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const assignmentId = parsePositiveInt(
                req.params.assignmentId,
                "assignmentId",
            );
            const { classRecord } = await requireAssignmentAccess({
                assignmentService,
                classService,
                assignmentId,
                userId,
            });

            if (classRecord.membership_role !== "teacher") {
                throw forbidden("Only class teachers can delete assignments");
            }

            const result =
                await assignmentService.deleteAssignment(assignmentId);

            if (!result) {
                throw notFound("Assignment not found");
            }

            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    router.get(
        "/assignments/:assignmentId/submissions",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parsePositiveInt(
                    req.params.assignmentId,
                    "assignmentId",
                );
                const { assignment, classRecord } =
                    await requireAssignmentAccess({
                        assignmentService,
                        classService,
                        assignmentId,
                        userId,
                    });

                if (classRecord.membership_role !== "teacher") {
                    throw forbidden(
                        "Only class teachers can view all submissions",
                    );
                }

                const rows = await assignmentService.listRosterSubmissions(
                    assignment.id,
                );
                const payload = await Promise.all(
                    rows.map((row) =>
                        buildSubmissionPayload({ row, fileService, db }),
                    ),
                );

                return res.json(payload);
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get(
        "/assignments/:assignmentId/submissions/me",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parsePositiveInt(
                    req.params.assignmentId,
                    "assignmentId",
                );
                const { assignment } = await requireAssignmentAccess({
                    assignmentService,
                    classService,
                    assignmentId,
                    userId,
                });

                await requireStudentMembership({
                    classService,
                    classId: assignment.class_id,
                    userId,
                });

                const row = await assignmentService.getRosterSubmission({
                    assignmentId,
                    studentUserId: userId,
                });

                if (!row) {
                    throw notFound("Assignment not found");
                }

                return res.json(
                    await buildSubmissionPayload({ row, fileService, db }),
                );
            } catch (error) {
                return next(error);
            }
        },
    );

    router.put(
        "/assignments/:assignmentId/submissions/me",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parsePositiveInt(
                    req.params.assignmentId,
                    "assignmentId",
                );
                const { assignment } = await requireAssignmentAccess({
                    assignmentService,
                    classService,
                    assignmentId,
                    userId,
                });

                await requireStudentMembership({
                    classService,
                    classId: assignment.class_id,
                    userId,
                });

                if (assignment.status !== "published") {
                    throw badRequest(
                        "This assignment is not accepting submissions",
                    );
                }

                const input = parseSubmissionInput(req.body);

                if (
                    input.status === "submitted" &&
                    assignment.due_at &&
                    new Date().getTime() >
                        new Date(assignment.due_at).getTime() &&
                    !assignment.allow_late_submission
                ) {
                    throw badRequest("The assignment due time has passed");
                }

                const submission =
                    await assignmentService.createOrUpdateSubmission({
                        assignmentId,
                        studentUserId: userId,
                        textAnswer: input.textAnswer,
                        status: input.status,
                    });

                await fileService.replaceSubmissionFiles({
                    submissionId: submission.id,
                    fileIds: input.attachmentIds,
                    userId,
                });

                const row = await assignmentService.getRosterSubmission({
                    assignmentId,
                    studentUserId: userId,
                });
                return res.json(
                    await buildSubmissionPayload({ row, fileService, db }),
                );
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get(
        "/assignments/:assignmentId/submissions/:studentId",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parsePositiveInt(
                    req.params.assignmentId,
                    "assignmentId",
                );
                const studentId = parsePositiveInt(
                    req.params.studentId,
                    "studentId",
                );
                const { assignment, classRecord } =
                    await requireAssignmentAccess({
                        assignmentService,
                        classService,
                        assignmentId,
                        userId,
                    });

                if (classRecord.membership_role !== "teacher") {
                    throw forbidden(
                        "Only class teachers can view another student's submission",
                    );
                }

                const row = await assignmentService.getRosterSubmission({
                    assignmentId: assignment.id,
                    studentUserId: studentId,
                });

                if (!row) {
                    throw notFound("Student submission not found");
                }

                return res.json(
                    await buildSubmissionPayload({ row, fileService, db }),
                );
            } catch (error) {
                return next(error);
            }
        },
    );

    router.patch(
        "/assignments/:assignmentId/submissions/:studentId/review",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const assignmentId = parsePositiveInt(
                    req.params.assignmentId,
                    "assignmentId",
                );
                const studentId = parsePositiveInt(
                    req.params.studentId,
                    "studentId",
                );
                const { assignment, classRecord } =
                    await requireAssignmentAccess({
                        assignmentService,
                        classService,
                        assignmentId,
                        userId,
                    });

                if (classRecord.membership_role !== "teacher") {
                    throw forbidden(
                        "Only class teachers can review submissions",
                    );
                }

                const submission = await assignmentService.getSubmissionRecord({
                    assignmentId,
                    studentUserId: studentId,
                });

                if (!submission || submission.status !== "submitted") {
                    throw notFound("Student submission not found");
                }

                const input = parseReviewInput(req.body);
                const row = await assignmentService.reviewSubmission({
                    assignmentId: assignment.id,
                    studentUserId: studentId,
                    reviewerUserId: userId,
                    score: input.score,
                    comment: input.comment,
                });

                return res.json(
                    await buildSubmissionPayload({ row, fileService, db }),
                );
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
