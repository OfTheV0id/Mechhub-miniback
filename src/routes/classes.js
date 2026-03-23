const express = require("express");
const { createClassService } = require("../services/classes/class-service");
const {
    USER_ROLES,
    createInviteCode,
    getUserById,
    parseUserRole,
    sanitizeUser,
} = require("../lib/users");

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

function parseInviteCode(value) {
    const inviteCode = String(value || "").trim().toUpperCase();

    if (!inviteCode) {
        throw badRequest("inviteCode is required");
    }

    return inviteCode;
}

function sanitizeClassRecord(classRecord) {
    return {
        id: classRecord.id,
        name: classRecord.name,
        description: classRecord.description,
        ownerUserId: classRecord.owner_user_id,
        inviteCode: classRecord.invite_code,
        status: classRecord.status,
        createdAt: classRecord.created_at,
        membershipRole: classRecord.membership_role || null,
        isOwner: classRecord.owner_user_id === classRecord.current_user_id,
    };
}

function sanitizeMembership(member, ownerUserId) {
    return {
        id: member.id,
        classId: member.class_id,
        userId: member.user_id,
        role: member.role,
        joinedAt: member.joined_at,
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

function attachCurrentUserId(classRecord, userId) {
    return {
        ...classRecord,
        current_user_id: userId,
    };
}

function createClassesRouter(db) {
    const router = express.Router();
    const classService = createClassService(db);

    router.get("/", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const classes = await classService.listClassesForUser(userId);

            return res.json(
                classes.map((classRecord) =>
                    sanitizeClassRecord(attachCurrentUserId(classRecord, userId)),
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
                description: parseClassDescription(req.body?.description),
                role: USER_ROLES.TEACHER,
                inviteCode: createInviteCode(),
            });

            return res
                .status(201)
                .json(sanitizeClassRecord(attachCurrentUserId(classRecord, userId)));
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

            return res
                .status(201)
                .json(sanitizeClassRecord(attachCurrentUserId(joinedClass, userId)));
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
                sanitizeClassRecord(attachCurrentUserId(classRecord, userId)),
            );
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

            return res.json(
                sanitizeMembership(updatedMember, classRecord.owner_user_id),
            );
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = {
    createClassesRouter,
};
