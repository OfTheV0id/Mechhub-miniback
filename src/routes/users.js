const express = require("express");
const { getUserById, sanitizeUser } = require("../lib/users");

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

async function getCurrentUser(db, userId) {
    return getUserById(db, userId);
}

function createUsersRouter(db) {
    const router = express.Router();

    router.get("/me", async (req, res, next) => {
        try {
            if (!req.session.userId) {
                throw unauthorized("Not authenticated");
            }

            const user = await getCurrentUser(db, req.session.userId);

            if (!user) {
                req.session.destroy(() => {});
                throw unauthorized("Not authenticated");
            }

            return res.json(sanitizeUser(user));
        } catch (err) {
            return next(err);
        }
    });

    router.patch("/me", async (req, res, next) => {
        try {
            if (!req.session.userId) {
                throw unauthorized("Not authenticated");
            }

            const updates = [];
            const values = [];

            if (Object.hasOwn(req.body, "displayName")) {
                if (typeof req.body.displayName !== "string") {
                    throw badRequest("displayName must be a string");
                }

                const displayName = req.body.displayName.trim();

                if (displayName.length > 100) {
                    throw badRequest("displayName must be 100 characters or fewer");
                }

                updates.push("display_name = ?");
                values.push(displayName);
            }

            if (Object.hasOwn(req.body, "avatarUrl")) {
                if (typeof req.body.avatarUrl !== "string") {
                    throw badRequest("avatarUrl must be a string");
                }

                const avatarUrl = req.body.avatarUrl.trim();

                if (avatarUrl.length > 2048) {
                    throw badRequest("avatarUrl must be 2048 characters or fewer");
                }

                updates.push("avatar_url = ?");
                values.push(avatarUrl);
            }

            if (Object.hasOwn(req.body, "bio")) {
                if (typeof req.body.bio !== "string") {
                    throw badRequest("bio must be a string");
                }

                const bio = req.body.bio.trim();

                if (bio.length > 500) {
                    throw badRequest("bio must be 500 characters or fewer");
                }

                updates.push("bio = ?");
                values.push(bio);
            }

            if (updates.length === 0) {
                throw badRequest("At least one profile field is required");
            }

            values.push(req.session.userId);

            const result = await db.run(
                `UPDATE users
                 SET ${updates.join(", ")}
                 WHERE id = ?`,
                values,
            );

            if (result.changes === 0) {
                req.session.destroy(() => {});
                throw unauthorized("Not authenticated");
            }

            const user = await getCurrentUser(db, req.session.userId);
            return res.json(sanitizeUser(user));
        } catch (err) {
            return next(err);
        }
    });

    return router;
}

module.exports = {
    createUsersRouter,
};
