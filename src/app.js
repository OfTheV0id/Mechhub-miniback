const express = require("express");
const cors = require("cors");
const { createClassEventsHub } = require("./lib/class-events-hub");
const {
    createAssignmentEventsHub,
} = require("./lib/assignment-events-hub");
const {
    createSoloChatGradingEventsHub,
} = require("./lib/solochat-grading-events-hub");
const { createSessionMiddleware } = require("./lib/session-store");
const { createAssignmentsRouter } = require("./routes/assignments");
const { createAuthRouter } = require("./routes/auth");
const { createClassesRouter } = require("./routes/classes");
const { createSoloChatRouter } = require("./routes/solochat");
const { createUsersRouter } = require("./routes/users");
const { errorHandler } = require("./middleware/error-handler");

function createApp(db) {
    const app = express();
    app.set("trust proxy", 1);
    const classEventsHub = createClassEventsHub();
    const assignmentEventsHub = createAssignmentEventsHub();
    const solochatGradingEventsHub = createSoloChatGradingEventsHub();
    const corsOptions = {
        origin: process.env.CORS_ORIGIN || "http://localhost:5173",
        credentials: true,
        methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        optionsSuccessStatus: 204,
    };

    app.use(cors(corsOptions));
    app.options("*", cors(corsOptions));
    app.use(express.json());
    app.use(createSessionMiddleware());

    app.get("/health", (req, res) => {
        res.json({ status: "ok" });
    });

    app.use("/auth", createAuthRouter(db));
    app.use("/classes", createClassesRouter(db, { classEventsHub }));
    app.use(createAssignmentsRouter(db, { assignmentEventsHub }));
    app.use(
        "/solochat",
        createSoloChatRouter(db, {
            gradingEventsHub: solochatGradingEventsHub,
        }),
    );
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
