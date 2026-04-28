const express = require("express");
const cors = require("cors");
const { createClassEventsHub } = require("./lib/class-events-hub");
const {
    createAssignmentEventsHub,
} = require("./lib/assignment-events-hub");
const {
    createClassActivityEventsHub,
} = require("./lib/class-activity-events-hub");
const {
    createSoloChatGradingEventsHub,
} = require("./lib/solochat-grading-events-hub");
const { createSessionMiddleware } = require("./lib/session-store");
const { createAssignmentsRouter } = require("./routes/assignments");
const { createAuthRouter } = require("./routes/auth");
const {
    createClassActivitiesRouter,
} = require("./routes/class-activities");
const { createClassesRouter } = require("./routes/classes");
const { createSoloChatRouter } = require("./routes/solochat");
const { createUsersRouter } = require("./routes/users");
const { createFileService } = require("./services/uploads/file-service");
const { errorHandler } = require("./middleware/error-handler");

function normalizeOriginList(value) {
    return String(value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function isSameOriginRequest(req, origin) {
    try {
        const parsed = new URL(origin);
        return (
            parsed.host === req.get("host") &&
            parsed.protocol === `${req.protocol}:`
        );
    } catch (_error) {
        return false;
    }
}

function createCorsOptions(req, allowedOrigins) {
    return {
        origin: (origin, callback) => {
            // allow requests with no origin (e.g. curl, mobile apps)
            if (!origin) return callback(null, true);
            // allow same-origin requests when the app is served through a reverse proxy
            if (isSameOriginRequest(req, origin)) return callback(null, true);
            // exact match from env list
            if (allowedOrigins.includes(origin)) return callback(null, true);
            // allow any Netlify deploy-preview / branch-deploy / production
            if (/^https:\/\/[a-z0-9-]+--mechhub\.netlify\.app$/.test(origin))
                return callback(null, true);
            callback(new Error(`CORS: origin not allowed - ${origin}`));
        },
        credentials: true,
        methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        optionsSuccessStatus: 204,
    };
}

function createApp(db) {
    const app = express();
    const fileService = createFileService(db);
    app.set("trust proxy", 1);
    const classEventsHub = createClassEventsHub();
    const assignmentEventsHub = createAssignmentEventsHub();
    const activityEventsHub = createClassActivityEventsHub();
    const solochatGradingEventsHub = createSoloChatGradingEventsHub();
    const allowedOrigins = normalizeOriginList(process.env.CORS_ORIGIN);

    app.use((req, res, next) => {
        cors(createCorsOptions(req, allowedOrigins))(req, res, next);
    });
    app.options("*", (req, res, next) => {
        cors(createCorsOptions(req, allowedOrigins))(req, res, next);
    });
    app.use(express.json());
    app.use(createSessionMiddleware());

    app.get("/health", (req, res) => {
        res.json({ status: "ok" });
    });

    app.use("/auth", createAuthRouter(db));
    app.use("/classes", createClassesRouter(db, { classEventsHub }));
    app.use(createAssignmentsRouter(db, { assignmentEventsHub }));
    app.use(createClassActivitiesRouter(db, { activityEventsHub }));
    app.use(
        "/solochat",
        createSoloChatRouter(db, {
            gradingEventsHub: solochatGradingEventsHub,
        }),
    );
    app.use("/users", createUsersRouter(db, { fileService }));

    app.use((req, res) => {
        res.status(404).json({ message: "Not found" });
    });

    app.use(errorHandler);

    return app;
}

module.exports = {
    createApp,
};
