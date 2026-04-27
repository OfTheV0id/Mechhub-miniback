const session = require("express-session");
const MemoryStoreFactory = require("memorystore");

function readBooleanEnv(value, fallback) {
    if (value === undefined) return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function createSessionMiddleware() {
    const MemoryStore = MemoryStoreFactory(session);
    const secureCookie = readBooleanEnv(
        process.env.SESSION_COOKIE_SECURE,
        process.env.NODE_ENV === "production",
    );
    const sameSiteCookie =
        process.env.SESSION_COOKIE_SAME_SITE || (secureCookie ? "none" : "lax");

    return session({
        store: new MemoryStore({
            checkPeriod: 1000 * 60 * 60 * 24,
        }),
        name: "mechhub.sid",
        secret: process.env.SESSION_SECRET || "dev-secret-change-me",
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: sameSiteCookie,
            secure: secureCookie,
            maxAge: 1000 * 60 * 60 * 24 * 7,
        },
    });
}

module.exports = {
    createSessionMiddleware,
};
