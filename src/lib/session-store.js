const session = require("express-session");
const MemoryStoreFactory = require("memorystore");

function createSessionMiddleware() {
    const MemoryStore = MemoryStoreFactory(session);

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
            sameSite: "lax",
            secure: false,
            maxAge: 1000 * 60 * 60 * 24 * 7,
        },
    });
}

module.exports = {
    createSessionMiddleware,
};
