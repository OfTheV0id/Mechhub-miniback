const express = require("express");
const bcrypt = require("bcrypt");
const { SQLITE_NOW_ISO_EXPRESSION } = require("../lib/time");
const {
    buildUserSelectQuery,
    generateDefaultProfile,
    parseUserRole,
    sanitizeUser,
} = require("../lib/users");

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

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

function conflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    return error;
}

function createAuthRouter(db) {
    const router = express.Router();

    router.post("/register", async (req, res, next) => {
        try {
            const email = String(req.body?.email || "").trim().toLowerCase();
            const password = String(req.body?.password || "");

            if (!email || !isValidEmail(email)) {
                throw badRequest("A valid email is required");
            }

            if (!password || password.length < 8) {
                throw badRequest("Password must be at least 8 characters");
            }

            const defaultRole = parseUserRole(req.body?.defaultRole);
            const existingUser = await db.get(
                "SELECT id FROM users WHERE email = ?",
                email,
            );

            if (existingUser) {
                throw conflict("Email is already registered");
            }

            const passwordHash = await bcrypt.hash(password, 10);
            const defaultProfile = generateDefaultProfile();
            const result = await db.run(
                `INSERT INTO users (
                     email,
                     password_hash,
                     display_name,
                     avatar_url,
                     default_role,
                     created_at
                 )
                 VALUES (?, ?, ?, ?, ?, ${SQLITE_NOW_ISO_EXPRESSION})`,
                email,
                passwordHash,
                defaultProfile.displayName,
                defaultProfile.avatarUrl,
                defaultRole,
            );

            const user = await db.get(
                `${buildUserSelectQuery()}
                 WHERE id = ?`,
                result.lastID,
            );

            req.session.userId = user.id;
            return res.status(201).json(sanitizeUser(user));
        } catch (err) {
            return next(err);
        }
    });

    router.post("/login", async (req, res, next) => {
        try {
            const email = String(req.body?.email || "").trim().toLowerCase();
            const password = String(req.body?.password || "");

            if (!email || !isValidEmail(email)) {
                throw badRequest("A valid email is required");
            }

            if (!password) {
                throw badRequest("Password is required");
            }

            const user = await db.get(
                `SELECT id, email, password_hash, display_name, avatar_url, bio, default_role, created_at
                 FROM users
                 WHERE email = ?`,
                email,
            );

            if (!user) {
                throw unauthorized("Invalid email or password");
            }

            const passwordMatches = await bcrypt.compare(password, user.password_hash);

            if (!passwordMatches) {
                throw unauthorized("Invalid email or password");
            }

            req.session.userId = user.id;
            return res.json(sanitizeUser(user));
        } catch (err) {
            return next(err);
        }
    });

    router.get("/me", async (req, res, next) => {
        try {
            if (!req.session.userId) {
                throw unauthorized("Not authenticated");
            }

            const user = await db.get(
                `${buildUserSelectQuery()}
                 WHERE id = ?`,
                req.session.userId,
            );

            if (!user) {
                req.session.destroy(() => {});
                throw unauthorized("Not authenticated");
            }

            return res.json(sanitizeUser(user));
        } catch (err) {
            return next(err);
        }
    });

    router.post("/logout", (req, res, next) => {
        req.session.destroy((err) => {
            if (err) {
                return next(err);
            }

            res.clearCookie("mechhub.sid");
            return res.json({ message: "Logged out" });
        });
    });

    return router;
}

module.exports = {
    createAuthRouter,
};
