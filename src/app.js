const express = require("express");
const cors = require("cors");
const { createSessionMiddleware } = require("./lib/session-store");
const { createAuthRouter } = require("./routes/auth");
const { createClassesRouter } = require("./routes/classes");
const { createSoloChatRouter } = require("./routes/solochat");
const { createUsersRouter } = require("./routes/users");
const { errorHandler } = require("./middleware/error-handler");

function createApp(db) {
    const app = express();

    app.use(
        cors({
            origin: process.env.CORS_ORIGIN || "http://localhost:5173",
            credentials: true,
        }),
    );
    app.use(express.json());
    app.use(createSessionMiddleware());

    app.get("/health", (req, res) => {
        res.json({ status: "ok" });
    });

    app.use("/auth", createAuthRouter(db));
    app.use("/classes", createClassesRouter(db));
    app.use("/solochat", createSoloChatRouter(db));
    app.use("/users", createUsersRouter(db));

    app.use((req, res) => {
        res.status(404).json({ message: "Not found" });
    });

    app.use(errorHandler);

    return app;
}

module.exports = {
    createApp,
};
