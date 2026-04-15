const express = require("express");
const multer = require("multer");
const { createClassService } = require("../services/classes/class-service");
const { createFileService } = require("../services/uploads/file-service");
const {
    USER_ROLES,
    createInviteCode,
    getUserById,
    parseUserRole,
    sanitizeUser,
} = require("../lib/users");
const { toIsoTimestamp } = require("../lib/time");

// 配置 multer 使用内存存储
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024, // 20MB 限制
    },
});

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

function conflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    return error;
}

const DEFAULT_CLASS_DESCRIPTION =
    "\u8fd9\u4e2a\u73ed\u7ea7\u5f88\u795e\u79d8 \u4ec0\u4e48\u4e5f\u6ca1\u7559\u4e0b";

function requireUserId(req) {
    if (!req.session.userId) {
        throw unauthorized("Not authenticated");
    }

    return req.session.userId;
}

function parseClassId(value) {
    const classId = Number(value);

    if (!Number.isInteger(classId) || classId <= 0) {
        throw badRequest("A valid classId is required");
    }

    return classId;
}

function parseMemberId(value) {
    const memberId = Number(value);

    if (!Number.isInteger(memberId) || memberId <= 0) {
        throw badRequest("A valid memberId is required");
    }

    return memberId;
}

function parseClassName(value) {
    const name = String(value || "").trim();

    if (!name) {
        throw badRequest("name is required");
    }

    if (name.length > 120) {
        throw badRequest("name must be 120 characters or fewer");
    }

    return name;
}

function parseClassDescription(value) {
    if (value !== undefined && value !== null && typeof value !== "string") {
        throw badRequest("description must be a string");
    }

    const description = String(value || "").trim();

    if (description.length > 1000) {
        throw badRequest("description must be 1000 characters or fewer");
    }

    return description;
}

function parseCreateClassDescription(value) {
    const description = parseClassDescription(value);

    return description || DEFAULT_CLASS_DESCRIPTION;
}

function parseOptionalClassName(value) {
    if (value === undefined) {
        return undefined;
    }

    return parseClassName(value);
}

function parseOptionalClassDescription(value) {
    if (value === undefined) {
        return undefined;
    }

    return parseClassDescription(value);
}

function parseClassStatus(value) {
    if (value !== "active" && value !== "archived") {
        throw badRequest("status must be either active or archived");
    }

    return value;
}

function parseOptionalClassStatus(value) {
    if (value === undefined) {
        return undefined;
    }

    return parseClassStatus(value);
}

function parseInviteCode(value) {
    const inviteCode = String(value || "")
        .trim()
        .toUpperCase();

    if (!inviteCode) {
        throw badRequest("inviteCode is required");
    }

    return inviteCode;
}

function serializeId(value) {
    if (value === undefined || value === null) {
        return null;
    }

    return String(value);
}

// 用于列表 - 精简字段
function sanitizeClassListRecord(classRecord) {
    return {
        id: serializeId(classRecord.id),
        name: classRecord.name,
        status: classRecord.status,
        membershipRole: classRecord.membership_role || null,
        isOwner: classRecord.owner_user_id === classRecord.current_user_id,
        avatar: sanitizeAvatar(classRecord),
    };
}

// 用于详情 - 完整字段
function sanitizeClassDetailRecord(classRecord) {
    return {
        id: serializeId(classRecord.id),
        name: classRecord.name,
        description: classRecord.description,
        ownerUserId: serializeId(classRecord.owner_user_id),
        inviteCode: classRecord.invite_code,
        status: classRecord.status,
        createdAt: toIsoTimestamp(classRecord.created_at),
        membershipRole: classRecord.membership_role || null,
        isOwner: classRecord.owner_user_id === classRecord.current_user_id,
        avatar: sanitizeAvatar(classRecord),
    };
}

function sanitizeAvatar(classRecord) {
    if (!classRecord.avatar_file_id) {
        return null;
    }

    return {
        id: serializeId(classRecord.avatar_id),
        fileName: classRecord.avatar_file_name,
        mimeType: classRecord.avatar_mime_type,
        sizeBytes: classRecord.avatar_size_bytes,
        width: classRecord.avatar_width,
        height: classRecord.avatar_height,
        createdAt: classRecord.avatar_created_at
            ? toIsoTimestamp(classRecord.avatar_created_at)
            : null,
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

function sanitizeMembership(member, ownerUserId) {
    const user = sanitizeUser({
        id: member.user_id,
        email: member.email,
        display_name: member.display_name,
        avatar_url: member.avatar_url,
        bio: member.bio,
        default_role: member.default_role,
        created_at: member.user_created_at,
    });

    return {
        id: serializeId(member.id),
        classId: serializeId(member.class_id),
        userId: serializeId(member.user_id),
        role: member.role,
        joinedAt: toIsoTimestamp(member.joined_at),
        isOwner: member.user_id === ownerUserId,
        user: {
            ...user,
            id: serializeId(user.id),
        },
    };
}

function attachCurrentUserId(classRecord, userId) {
    return {
        ...classRecord,
        current_user_id: userId,
    };
}

function createClassesRouter(db, { classEventsHub }) {
    const router = express.Router();
    const classService = createClassService(db);

    async function emitClassInvalidation({
        classId,
        targets,
        reason,
        extraUserIds = [],
        excludeUserIds = [],
    }) {
        const memberUserIds = await classService.listMemberUserIds(classId);
        const excludedUserIds = new Set(excludeUserIds.filter(Boolean));
        const targetUserIds = [...memberUserIds, ...extraUserIds].filter(
            (userId) => !excludedUserIds.has(userId),
        );

        classEventsHub.emitToUsers(targetUserIds, {
            type: "class.invalidate",
            classId: String(classId),
            targets,
            reason,
        });
    }

    router.get("/", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classes = await classService.listClassesForUser(userId);

            return res.json(
                classes.map((classRecord) =>
                    sanitizeClassListRecord(
                        attachCurrentUserId(classRecord, userId),
                    ),
                ),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.post("/", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const user = await getUserById(db, userId);

            if (!user) {
                req.session.destroy(() => {});
                throw unauthorized("Not authenticated");
            }

            if (user.default_role !== USER_ROLES.TEACHER) {
                throw forbidden("Only teachers can create classes");
            }

            const classRecord = await classService.createClass({
                ownerUserId: userId,
                name: parseClassName(req.body?.name),
                description: parseCreateClassDescription(req.body?.description),
                role: USER_ROLES.TEACHER,
                inviteCode: createInviteCode(),
            });

            return res
                .status(201)
                .json(
                    sanitizeClassListRecord(
                        attachCurrentUserId(classRecord, userId),
                    ),
                );
        } catch (error) {
            return next(error);
        }
    });

    router.post("/join", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const user = await getUserById(db, userId);

            if (!user) {
                req.session.destroy(() => {});
                throw unauthorized("Not authenticated");
            }

            const classRecord = await classService.getClassByInviteCode(
                parseInviteCode(req.body?.inviteCode),
            );

            if (!classRecord || classRecord.status !== "active") {
                throw notFound("Class not found");
            }

            const existingMembership = await classService.getMembership({
                classId: classRecord.id,
                userId,
            });

            if (existingMembership) {
                throw conflict("You have already joined this class");
            }

            await classService.joinClass({
                classId: classRecord.id,
                userId,
                role: user.default_role,
            });

            const joinedClass = await classService.getClassForUser({
                classId: classRecord.id,
                userId,
            });

            await emitClassInvalidation({
                classId: classRecord.id,
                targets: ["members"],
                reason: "member_joined",
                excludeUserIds: [userId],
            });

            return res
                .status(201)
                .json(
                    sanitizeClassDetailRecord(
                        attachCurrentUserId(joinedClass, userId),
                    ),
                );
        } catch (error) {
            return next(error);
        }
    });

    router.get("/events", async (req, res, next) => {
        try {
            const userId = requireUserId(req);

            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();

            const unsubscribe = classEventsHub.subscribe(userId, res);
            req.on("close", unsubscribe);
        } catch (error) {
            return next(error);
        }
    });

    router.get("/:classId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            return res.json(
                sanitizeClassDetailRecord(attachCurrentUserId(classRecord, userId)),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.patch("/:classId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.owner_user_id !== userId) {
                throw forbidden("Only the class owner can update the class");
            }

            const name = parseOptionalClassName(req.body?.name);
            const description = parseOptionalClassDescription(
                req.body?.description,
            );
            const status = parseOptionalClassStatus(req.body?.status);

            if (
                name === undefined &&
                description === undefined &&
                status === undefined
            ) {
                throw badRequest("At least one class field is required");
            }

            await classService.updateClass({
                classId,
                name,
                description,
                status,
            });

            const updatedClass = await classService.getClassForUser({
                classId,
                userId,
            });

            await emitClassInvalidation({
                classId,
                targets: ["classes", "classDetail"],
                reason: "class_updated",
                excludeUserIds: [userId],
            });

            return res.json(
                sanitizeClassDetailRecord(attachCurrentUserId(updatedClass, userId)),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.delete("/:classId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.owner_user_id !== userId) {
                throw forbidden("Only the class owner can delete the class");
            }

            const memberUserIds = await classService.listMemberUserIds(classId);

            await classService.deleteClass(classId);

            classEventsHub.emitToUsers(
                memberUserIds.filter((memberUserId) => memberUserId !== userId),
                {
                    type: "class.invalidate",
                    classId: String(classId),
                    targets: ["classes", "classDetail", "members"],
                    reason: "class_deleted",
                },
            );

            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    router.post("/:classId/avatar", upload.single("avatar"), async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);

            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.owner_user_id !== userId) {
                throw forbidden("Only the class owner can upload avatar");
            }

            if (!req.file) {
                throw badRequest("Avatar file is required");
            }

            const fileService = createFileService(db);
            const uploadedFile = await fileService.processImageUpload({
                userId,
                file: req.file,
                subDir: "class-avatars",
            });

            await classService.updateClassAvatar({
                classId,
                fileId: uploadedFile.id,
            });

            const updatedClass = await classService.getClassForUser({
                classId,
                userId,
            });

            await emitClassInvalidation({
                classId,
                targets: ["classes", "classDetail"],
                reason: "avatar_updated",
                excludeUserIds: [userId],
            });

            return res.status(200).json(
                sanitizeClassDetailRecord(attachCurrentUserId(updatedClass, userId)),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.delete("/:classId/avatar", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);

            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.owner_user_id !== userId) {
                throw forbidden("Only the class owner can remove avatar");
            }

            await classService.removeClassAvatar(classId);
            await emitClassInvalidation({
                classId,
                targets: ["classes", "classDetail"],
                reason: "avatar_removed",
                excludeUserIds: [userId],
            });

            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    router.get("/:classId/avatar", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);

            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (!classRecord.avatar_file_id) {
                throw notFound("Avatar not found");
            }

            const fileService = createFileService(db);
            const file = await fileService.getFileById(classRecord.avatar_file_id);

            if (!file) {
                throw notFound("Avatar file not found");
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

    router.post("/:classId/leave", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.owner_user_id === userId) {
                throw badRequest(
                    "The class owner cannot leave the class directly",
                );
            }

            await classService.leaveClass({ classId, userId });
            await emitClassInvalidation({
                classId,
                targets: ["members"],
                reason: "member_left",
                extraUserIds: [userId],
                excludeUserIds: [userId],
            });
            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    router.get("/:classId/members", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            const members = await classService.listMembers(classId);
            return res.json(
                members.map((member) =>
                    sanitizeMembership(member, classRecord.owner_user_id),
                ),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.patch("/:classId/members/:memberId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const memberId = parseMemberId(req.params.memberId);
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.owner_user_id !== userId) {
                throw forbidden("Only the class owner can update member roles");
            }

            const member = await classService.getMemberById({
                classId,
                memberId,
            });

            if (!member) {
                throw notFound("Member not found");
            }

            if (member.user_id === classRecord.owner_user_id) {
                throw badRequest("The class owner role cannot be changed");
            }

            await classService.updateMemberRole({
                memberId,
                role: parseUserRole(req.body?.role, "role"),
            });

            const members = await classService.listMembers(classId);
            const updatedMember = members.find((row) => row.id === memberId);

            await emitClassInvalidation({
                classId,
                targets: ["members"],
                reason: "member_role_updated",
                excludeUserIds: [member.user_id],
            });
            classEventsHub.emitToUsers([member.user_id], {
                type: "class.invalidate",
                classId: String(classId),
                targets: ["classes", "classDetail", "members"],
                reason: "member_role_updated",
            });

            return res.json(
                sanitizeMembership(updatedMember, classRecord.owner_user_id),
            );
        } catch (error) {
            return next(error);
        }
    });

    router.delete("/:classId/members/:memberId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classId = parseClassId(req.params.classId);
            const memberId = parseMemberId(req.params.memberId);
            const classRecord = await classService.getClassForUser({
                classId,
                userId,
            });

            if (!classRecord) {
                throw notFound("Class not found");
            }

            if (classRecord.owner_user_id !== userId) {
                throw forbidden("Only the class owner can remove members");
            }

            const member = await classService.getMemberById({
                classId,
                memberId,
            });

            if (!member) {
                throw notFound("Member not found");
            }

            if (member.user_id === classRecord.owner_user_id) {
                throw badRequest("The class owner cannot be removed");
            }

            await classService.removeMember({ classId, memberId });
            await emitClassInvalidation({
                classId,
                targets: ["members"],
                reason: "member_removed",
                extraUserIds: [member.user_id],
                excludeUserIds: [userId],
            });
            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = {
    createClassesRouter,
};
