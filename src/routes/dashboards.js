const express = require("express");
const { getUserById } = require("../lib/users");
const {
    sanitizeAssignment,
    sanitizeStudentAssignmentCard,
    sanitizeSubmission,
    sanitizeTeacherAssignmentDashboardItem,
} = require("../lib/assignments");
const { toIsoTimestamp } = require("../lib/time");
const { sanitizeUser } = require("../lib/users");
const {
    createAssignmentService,
} = require("../services/assignments/assignment-service");
const { createClassService } = require("../services/classes/class-service");
const { createFileService } = require("../services/uploads/file-service");

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

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
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

function sanitizeClassRecord(classRecord, userId) {
    return {
        id: classRecord.id,
        name: classRecord.name,
        description: classRecord.description,
        ownerUserId: classRecord.owner_user_id,
        inviteCode: classRecord.invite_code,
        status: classRecord.status,
        createdAt: toIsoTimestamp(classRecord.created_at),
        membershipRole: classRecord.membership_role || null,
        isOwner: classRecord.owner_user_id === userId,
    };
}

function sanitizeMembership(member, ownerUserId) {
    return {
        id: member.id,
        classId: member.class_id,
        userId: member.user_id,
        role: member.role,
        joinedAt: toIsoTimestamp(member.joined_at),
        isOwner: member.user_id === ownerUserId,
        user: sanitizeUser({
            id: member.user_id,
            email: member.email,
            display_name: member.display_name,
            avatar_url: member.avatar_url,
            bio: member.bio,
            default_role: member.default_role,
            created_at: member.user_created_at,
        }),
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

function createDashboardsRouter(db) {
    const router = express.Router();
    const assignmentService = createAssignmentService(db);
    const classService = createClassService(db);
    const fileService = createFileService(db);

    router.get("/dashboards/teacher/classes", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classes = (
                await classService.listClassesForUser(userId)
            ).filter(
                (classRecord) => classRecord.membership_role === "teacher",
            );

            const items = await Promise.all(
                classes.map(async (classRecord) => {
                    const members = await classService.listMembers(
                        classRecord.id,
                    );
                    const assignments =
                        await assignmentService.listAssignmentsForClass({
                            classId: classRecord.id,
                            includeDrafts: true,
                        });
                    const assignmentItems = await Promise.all(
                        assignments.map(async (assignment) => {
                            const rows =
                                await assignmentService.listRosterSubmissions(
                                    assignment.id,
                                );
                            const submittedCount = rows.filter(
                                (row) => row.submission_id,
                            ).length;
                            const reviewedCount = rows.filter(
                                (row) =>
                                    row.review_score !== null &&
                                    row.review_score !== undefined,
                            ).length;

                            return {
                                totalStudents: rows.length,
                                submittedCount,
                                reviewedCount,
                            };
                        }),
                    );

                    const pendingReviewCount = assignmentItems.reduce(
                        (sum, item) =>
                            sum +
                            Math.max(
                                item.submittedCount - item.reviewedCount,
                                0,
                            ),
                        0,
                    );
                    const upcomingDueCount = assignments.filter(
                        (assignment) => {
                            if (
                                !assignment.due_at ||
                                assignment.status !== "published"
                            ) {
                                return false;
                            }

                            const dueTime = new Date(
                                assignment.due_at,
                            ).getTime();
                            return (
                                dueTime >= Date.now() &&
                                dueTime <= Date.now() + 7 * 24 * 60 * 60 * 1000
                            );
                        },
                    ).length;

                    return {
                        class: sanitizeClassRecord(classRecord, userId),
                        studentCount: members.filter(
                            (member) => member.role === "student",
                        ).length,
                        assignmentCount: assignments.length,
                        pendingReviewCount,
                        upcomingDueCount,
                    };
                }),
            );

            return res.json({
                summary: {
                    classCount: items.length,
                    studentCount: items.reduce(
                        (sum, item) => sum + item.studentCount,
                        0,
                    ),
                    assignmentCount: items.reduce(
                        (sum, item) => sum + item.assignmentCount,
                        0,
                    ),
                    pendingReviewCount: items.reduce(
                        (sum, item) => sum + item.pendingReviewCount,
                        0,
                    ),
                },
                classes: items,
            });
        } catch (error) {
            return next(error);
        }
    });

    router.get("/dashboards/teacher/assignments", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const rows =
                await assignmentService.listAssignmentsForTeacher(userId);
            const items = rows.map(sanitizeTeacherAssignmentDashboardItem);

            return res.json({
                summary: {
                    assignmentCount: items.length,
                    publishedCount: items.filter(
                        (item) => item.status === "published",
                    ).length,
                    pendingReviewCount: items.reduce(
                        (sum, item) => sum + item.pendingReviewCount,
                        0,
                    ),
                    overdueCount: items.filter((item) => {
                        if (!item.dueAt || item.status !== "published") {
                            return false;
                        }

                        return new Date(item.dueAt).getTime() < Date.now();
                    }).length,
                },
                assignments: items,
            });
        } catch (error) {
            return next(error);
        }
    });

    router.get("/dashboards/classes/:classId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parsePositiveInt(req.params.classId, "classId");
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.membership_role !== "teacher") {
                throw forbidden(
                    "Only class teachers can access this dashboard",
                );
            }

            const members = await classService.listMembers(classId);
            const assignments = await assignmentService.listAssignmentsForClass(
                {
                    classId,
                    includeDrafts: true,
                },
            );
            const assignmentItems = await Promise.all(
                assignments.map(async (assignment) => {
                    const rows = await assignmentService.listRosterSubmissions(
                        assignment.id,
                    );
                    const item = sanitizeTeacherAssignmentDashboardItem({
                        ...assignment,
                        total_students: rows.length,
                        submitted_count: rows.filter((row) => row.submission_id)
                            .length,
                        reviewed_count: rows.filter(
                            (row) =>
                                row.review_score !== null &&
                                row.review_score !== undefined,
                        ).length,
                    });

                    return item;
                }),
            );

            return res.json({
                class: sanitizeClassRecord(classRecord, userId),
                summary: {
                    studentCount: members.filter(
                        (member) => member.role === "student",
                    ).length,
                    assignmentCount: assignmentItems.length,
                    pendingReviewCount: assignmentItems.reduce(
                        (sum, item) => sum + item.pendingReviewCount,
                        0,
                    ),
                },
                members: members.map((member) =>
                    sanitizeMembership(member, classRecord.owner_user_id),
                ),
                assignments: assignmentItems,
            });
        } catch (error) {
            return next(error);
        }
    });

    router.get(
        "/dashboards/classes/:classId/assignments/:assignmentId",
        async (req, res, next) => {
            try {
                const userId = requireUserId(req);
                const classId = parsePositiveInt(req.params.classId, "classId");
                const assignmentId = parsePositiveInt(
                    req.params.assignmentId,
                    "assignmentId",
                );
                const classRecord = await classService.getClassForUser({
                    classId,
                    userId,
                });

                if (!classRecord) {
                    throw notFound("Class not found");
                }

                if (classRecord.membership_role !== "teacher") {
                    throw forbidden(
                        "Only class teachers can access this dashboard",
                    );
                }

                const assignment =
                    await assignmentService.getAssignmentById(assignmentId);

                if (!assignment || assignment.class_id !== classId) {
                    throw notFound("Assignment not found");
                }

                const rows =
                    await assignmentService.listRosterSubmissions(assignmentId);
                const submissions = await Promise.all(
                    rows.map((row) =>
                        buildSubmissionPayload({ row, fileService, db }),
                    ),
                );

                return res.json({
                    assignment: await buildAssignmentPayload({
                        assignment,
                        fileService,
                    }),
                    summary: {
                        studentCount: submissions.length,
                        submittedCount: submissions.filter(
                            (item) => item.id !== null,
                        ).length,
                        reviewedCount: submissions.filter(
                            (item) => item.review !== null,
                        ).length,
                        pendingReviewCount: submissions.filter(
                            (item) => item.id !== null && item.review === null,
                        ).length,
                        lateCount: submissions.filter((item) => item.isLate)
                            .length,
                    },
                    submissions,
                });
            } catch (error) {
                return next(error);
            }
        },
    );

    router.get("/dashboards/student/assignments", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const user = await getUserById(db, userId);

            if (!user || user.default_role !== "student") {
                throw forbidden("Only students can access this dashboard");
            }

            const rows = await assignmentService.listStudentAssignments(userId);
            const assignments = rows.map(sanitizeStudentAssignmentCard);

            return res.json({
                summary: {
                    pendingCount: assignments.filter(
                        (item) =>
                            item.submissionStatus === "not_started" ||
                            item.submissionStatus === "draft",
                    ).length,
                    dueSoonCount: assignments.filter((item) => {
                        if (
                            !item.dueAt ||
                            item.assignmentStatus !== "published"
                        ) {
                            return false;
                        }

                        const dueTime = new Date(item.dueAt).getTime();
                        return (
                            dueTime >= Date.now() &&
                            dueTime <= Date.now() + 3 * 24 * 60 * 60 * 1000
                        );
                    }).length,
                    submittedCount: assignments.filter(
                        (item) =>
                            item.submissionStatus === "submitted" ||
                            item.submissionStatus === "late_submitted",
                    ).length,
                    reviewedCount: assignments.filter(
                        (item) => item.submissionStatus === "reviewed",
                    ).length,
                },
                assignments,
            });
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = {
    createDashboardsRouter,
};
