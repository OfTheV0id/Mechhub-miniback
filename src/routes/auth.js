const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const { SQLITE_NOW_ISO_EXPRESSION } = require("../lib/time");
const {
    buildUserSelectQuery,
    generateDefaultProfile,
    parseUserRole,
    sanitizeUser,
} = require("../lib/users");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

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

function serverError(message) {
    const error = new Error(message);
    error.statusCode = 500;
    return error;
}

function getFirstOrigin(value) {
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)[0];
}

function getFrontendOrigin() {
    return (
        process.env.FRONTEND_ORIGIN ||
        getFirstOrigin(process.env.CORS_ORIGIN) ||
        "http://localhost:5173"
    );
}

function buildFrontendRedirect(pathname, params = {}) {
    const redirectUrl = new URL(pathname, getFrontendOrigin());

    Object.entries(params).forEach(([key, value]) => {
        if (value) redirectUrl.searchParams.set(key, value);
    });

    return redirectUrl.toString();
}

function getGoogleCallbackUrl(req) {
    if (process.env.GOOGLE_OAUTH_CALLBACK_URL) {
        return process.env.GOOGLE_OAUTH_CALLBACK_URL;
    }

    return `${req.protocol}://${req.get("host")}/auth/google/callback`;
}

function assertGoogleOAuthConfig() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        throw serverError("Google OAuth is not configured");
    }
}

function validateGoogleUser(profile) {
    const email = String(profile?.email || "").trim().toLowerCase();
    const subject = String(profile?.sub || "").trim();

    if (!subject || !email || !isValidEmail(email)) {
        throw unauthorized("Google account did not provide a valid email");
    }

    if (profile.email_verified !== true) {
        throw unauthorized("Google email is not verified");
    }

    return {
        providerUserId: subject,
        email,
        displayName: String(profile?.name || "").trim(),
        avatarUrl: String(profile?.picture || "").trim(),
    };
}

async function exchangeGoogleCode({ code, redirectUri }) {
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
        }),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload.access_token) {
        throw unauthorized(payload.error_description || "Google token exchange failed");
    }

    return payload;
}

async function fetchGoogleProfile(accessToken) {
    const response = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw unauthorized(payload.error_description || "Google user lookup failed");
    }

    return validateGoogleUser(payload);
}

async function findOrCreateGoogleUser(db, profile) {
    const linkedAccount = await db.get(
        `SELECT u.id, u.email, u.display_name, u.avatar_url, u.bio, u.default_role, u.created_at
         FROM user_auth_accounts account
         INNER JOIN users u ON u.id = account.user_id
         WHERE account.provider = 'google'
           AND account.provider_user_id = ?`,
        profile.providerUserId,
    );

    if (linkedAccount) {
        return linkedAccount;
    }

    const existingUser = await db.get(
        `${buildUserSelectQuery()}
         WHERE email = ?`,
        profile.email,
    );

    if (existingUser) {
        await db.run(
            `INSERT INTO user_auth_accounts (
                 user_id,
                 provider,
                 provider_user_id,
                 email,
                 created_at,
                 updated_at
             )
             VALUES (?, 'google', ?, ?, ${SQLITE_NOW_ISO_EXPRESSION}, ${SQLITE_NOW_ISO_EXPRESSION})`,
            existingUser.id,
            profile.providerUserId,
            profile.email,
        );
        return existingUser;
    }

    const defaultProfile = generateDefaultProfile();
    const passwordHash = await bcrypt.hash(
        crypto.randomBytes(32).toString("hex"),
        10,
    );
    const result = await db.run(
        `INSERT INTO users (
             email,
             password_hash,
             display_name,
             avatar_url,
             default_role,
             created_at
         )
         VALUES (?, ?, ?, ?, 'student', ${SQLITE_NOW_ISO_EXPRESSION})`,
        profile.email,
        passwordHash,
        profile.displayName || defaultProfile.displayName,
        profile.avatarUrl || defaultProfile.avatarUrl,
    );

    await db.run(
        `INSERT INTO user_auth_accounts (
             user_id,
             provider,
             provider_user_id,
             email,
             created_at,
             updated_at
         )
         VALUES (?, 'google', ?, ?, ${SQLITE_NOW_ISO_EXPRESSION}, ${SQLITE_NOW_ISO_EXPRESSION})`,
        result.lastID,
        profile.providerUserId,
        profile.email,
    );

    return db.get(
        `${buildUserSelectQuery()}
         WHERE id = ?`,
        result.lastID,
    );
}

function createAuthRouter(db) {
    const router = express.Router();

    router.get("/google", (req, res, next) => {
        try {
            assertGoogleOAuthConfig();

            const state = crypto.randomBytes(24).toString("hex");
            const redirectUri = getGoogleCallbackUrl(req);
            req.session.googleOAuthState = state;
            req.session.googleOAuthRedirectUri = redirectUri;

            const authUrl = new URL(GOOGLE_AUTH_URL);
            authUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("scope", "openid email profile");
            authUrl.searchParams.set("state", state);
            authUrl.searchParams.set("prompt", "select_account");

            return res.redirect(authUrl.toString());
        } catch (err) {
            return next(err);
        }
    });

    router.get("/google/callback", async (req, res, next) => {
        try {
            assertGoogleOAuthConfig();

            const code = String(req.query?.code || "");
            const state = String(req.query?.state || "");
            const expectedState = req.session.googleOAuthState;
            const redirectUri =
                req.session.googleOAuthRedirectUri || getGoogleCallbackUrl(req);

            delete req.session.googleOAuthState;
            delete req.session.googleOAuthRedirectUri;

            if (!code || !state || state !== expectedState) {
                throw unauthorized("Invalid Google OAuth callback");
            }

            const tokenPayload = await exchangeGoogleCode({ code, redirectUri });
            const googleProfile = await fetchGoogleProfile(
                tokenPayload.access_token,
            );
            const user = await findOrCreateGoogleUser(db, googleProfile);

            req.session.userId = user.id;
            return res.redirect(buildFrontendRedirect("/dashboard"));
        } catch (err) {
            if (err.statusCode) {
                return res.redirect(
                    buildFrontendRedirect("/auth", { error: err.message }),
                );
            }

            return next(err);
        }
    });

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
