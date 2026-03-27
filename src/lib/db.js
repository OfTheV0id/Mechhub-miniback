const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { SQLITE_NOW_ISO_EXPRESSION } = require("./time");

let dbPromise;
const SQLITE_BUSY_TIMEOUT_MS = 5000;

function resolveDbPath() {
    const configuredPath = process.env.DB_PATH || "./data/app.sqlite";

    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);
}

async function initDb() {
    if (!dbPromise) {
        dbPromise = openDbConnection();
    }

    const db = await dbPromise;
    await prepareDb(db);

    return db;
}

async function openDbConnection() {
    const filename = resolveDbPath();
    fs.mkdirSync(path.dirname(filename), { recursive: true });

    const db = await open({
        filename,
        driver: sqlite3.Database,
    });

    await db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
    `);
    return db;
}

async function prepareDb(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION})
        );
    `);

    await ensureUserProfileColumns(db);
    await ensureSoloChatTables(db);
    await ensureClassTables(db);
    await ensureAssignmentTables(db);
    await ensureUploadTables(db);
}

async function withImmediateTransaction(work) {
    const db = await openDbConnection();

    try {
        await db.exec("BEGIN IMMEDIATE TRANSACTION");
        const result = await work(db);
        await db.exec("COMMIT");
        return result;
    } catch (error) {
        try {
            await db.exec("ROLLBACK");
        } catch (rollbackError) {
            error.rollbackError = rollbackError;
        }
        throw error;
    } finally {
        await db.close();
    }
}

async function ensureUserProfileColumns(db) {
    const columns = await db.all(`PRAGMA table_info(users)`);
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("display_name")) {
        await db.exec(
            `ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`,
        );
    }

    if (!columnNames.has("avatar_url")) {
        await db.exec(
            `ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''`,
        );
    }

    if (!columnNames.has("bio")) {
        await db.exec(
            `ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''`,
        );
    }

    if (!columnNames.has("default_role")) {
        await db.exec(
            `ALTER TABLE users ADD COLUMN default_role TEXT NOT NULL DEFAULT 'student'`,
        );
    }
}

async function ensureSoloChatTables(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT 'New Chat',
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('streaming', 'completed', 'failed')),
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
             FOREIGN KEY (conversation_id) REFERENCES solochat_conversations(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            message_id INTEGER DEFAULT NULL,
            storage_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (message_id) REFERENCES solochat_messages(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_conversations_user_updated
        ON solochat_conversations(user_id, updated_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_messages_conversation_id
        ON solochat_messages(conversation_id, id ASC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_images_user_created
        ON solochat_images(user_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_images_message_id
        ON solochat_images(message_id)
    `);
}

async function ensureClassTables(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            owner_user_id INTEGER NOT NULL,
            invite_code TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (owner_user_id) REFERENCES users(id)
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS class_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
            joined_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            UNIQUE (class_id, user_id),
            FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_classes_owner_user_id
        ON classes(owner_user_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_class_members_user_id
        ON class_members(user_id, class_id)
    `);
}

async function ensureAssignmentTables(db) {
    await ensureAssignmentsTableDefinition(db);
    await ensureAssignmentSubmissionsTableDefinition(db);
    await ensureSubmissionReviewsTableDefinition(db);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignments_class_created
        ON assignments(class_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignments_class_status_due
        ON assignments(class_id, status, due_at, id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignments_creator
        ON assignments(created_by_user_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignment_submissions_assignment_student
        ON assignment_submissions(assignment_id, student_user_id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignment_submissions_student_updated
        ON assignment_submissions(student_user_id, updated_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_submission_reviews_submission
        ON submission_reviews(submission_id)
    `);
}

async function ensureAssignmentsTableDefinition(db) {
    const columns = await getTableColumns(db, "assignments");
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columns.length) {
        await db.exec(`
            CREATE TABLE assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                class_id INTEGER NOT NULL,
                created_by_user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                start_at TEXT DEFAULT NULL,
                due_at TEXT DEFAULT NULL,
                allow_late_submission INTEGER NOT NULL DEFAULT 0 CHECK (allow_late_submission IN (0, 1)),
                max_score REAL NOT NULL DEFAULT 100,
                status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'archived')),
                published_at TEXT DEFAULT NULL,
                closed_at TEXT DEFAULT NULL,
                created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
                updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
                FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
                FOREIGN KEY (created_by_user_id) REFERENCES users(id)
            );
        `);
        return;
    }

    const requiredColumns = [
        "created_by_user_id",
        "start_at",
        "allow_late_submission",
        "max_score",
        "published_at",
        "closed_at",
    ];

    if (requiredColumns.every((columnName) => columnNames.has(columnName))) {
        return;
    }

    const createdByExpression = columnNames.has("created_by_user_id")
        ? "created_by_user_id"
        : columnNames.has("creator_user_id")
          ? "creator_user_id"
          : "(SELECT owner_user_id FROM classes WHERE id = assignments_old.class_id)";
    const startAtExpression = columnNames.has("start_at") ? "start_at" : "NULL";
    const dueAtExpression = columnNames.has("due_at") ? "due_at" : "NULL";
    const allowLateExpression = columnNames.has("allow_late_submission")
        ? "allow_late_submission"
        : "0";
    const maxScoreExpression = columnNames.has("max_score")
        ? "max_score"
        : "100";
    const statusExpression = columnNames.has("status") ? "status" : "'draft'";
    const publishedAtExpression = columnNames.has("published_at")
        ? "published_at"
        : columnNames.has("status")
          ? `CASE WHEN status = 'published' THEN created_at ELSE NULL END`
          : "NULL";
    const closedAtExpression = columnNames.has("closed_at")
        ? "closed_at"
        : columnNames.has("deleted_at")
          ? "deleted_at"
          : "NULL";
    const createdAtExpression = columnNames.has("created_at")
        ? "created_at"
        : SQLITE_NOW_ISO_EXPRESSION;
    const updatedAtExpression = columnNames.has("updated_at")
        ? "updated_at"
        : createdAtExpression;

    await db.exec(`ALTER TABLE assignments RENAME TO assignments_old`);
    await db.exec(`
        CREATE TABLE assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_id INTEGER NOT NULL,
            created_by_user_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            start_at TEXT DEFAULT NULL,
            due_at TEXT DEFAULT NULL,
            allow_late_submission INTEGER NOT NULL DEFAULT 0 CHECK (allow_late_submission IN (0, 1)),
            max_score REAL NOT NULL DEFAULT 100,
            status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'archived')),
            published_at TEXT DEFAULT NULL,
            closed_at TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by_user_id) REFERENCES users(id)
        );
    `);
    await db.exec(`
        INSERT INTO assignments (
            id,
            class_id,
            created_by_user_id,
            title,
            description,
            start_at,
            due_at,
            allow_late_submission,
            max_score,
            status,
            published_at,
            closed_at,
            created_at,
            updated_at
        )
        SELECT
            id,
            class_id,
            ${createdByExpression},
            title,
            description,
            ${startAtExpression},
            ${dueAtExpression},
            ${allowLateExpression},
            ${maxScoreExpression},
            ${statusExpression},
            ${publishedAtExpression},
            ${closedAtExpression},
            ${createdAtExpression},
            ${updatedAtExpression}
        FROM assignments_old
    `);
    await db.exec(`DROP TABLE assignments_old`);
}

async function ensureAssignmentSubmissionsTableDefinition(db) {
    const columns = await getTableColumns(db, "assignment_submissions");
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columns.length) {
        await db.exec(`
            CREATE TABLE assignment_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                assignment_id INTEGER NOT NULL,
                student_user_id INTEGER NOT NULL,
                text_answer TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
                submitted_at TEXT DEFAULT NULL,
                created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
                updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
                UNIQUE (assignment_id, student_user_id),
                FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
                FOREIGN KEY (student_user_id) REFERENCES users(id)
            );
        `);
        return;
    }

    const requiredColumns = ["text_answer", "status", "created_at"];

    if (requiredColumns.every((columnName) => columnNames.has(columnName))) {
        return;
    }

    const textAnswerExpression = columnNames.has("text_answer")
        ? "text_answer"
        : columnNames.has("text_content")
          ? "text_content"
          : "''";
    const statusExpression = columnNames.has("status")
        ? "status"
        : "'submitted'";
    const submittedAtExpression = columnNames.has("submitted_at")
        ? "submitted_at"
        : "NULL";
    const createdAtExpression = columnNames.has("created_at")
        ? "created_at"
        : columnNames.has("submitted_at")
          ? "submitted_at"
          : SQLITE_NOW_ISO_EXPRESSION;
    const updatedAtExpression = columnNames.has("updated_at")
        ? "updated_at"
        : createdAtExpression;

    await db.exec(
        `ALTER TABLE assignment_submissions RENAME TO assignment_submissions_old`,
    );
    await db.exec(`
        CREATE TABLE assignment_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            assignment_id INTEGER NOT NULL,
            student_user_id INTEGER NOT NULL,
            text_answer TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK (status IN ('draft', 'submitted')),
            submitted_at TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            UNIQUE (assignment_id, student_user_id),
            FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
            FOREIGN KEY (student_user_id) REFERENCES users(id)
        );
    `);
    await db.exec(`
        INSERT INTO assignment_submissions (
            id,
            assignment_id,
            student_user_id,
            text_answer,
            status,
            submitted_at,
            created_at,
            updated_at
        )
        SELECT
            id,
            assignment_id,
            student_user_id,
            ${textAnswerExpression},
            ${statusExpression},
            ${submittedAtExpression},
            ${createdAtExpression},
            ${updatedAtExpression}
        FROM assignment_submissions_old
    `);
    await db.exec(`DROP TABLE assignment_submissions_old`);
}

async function ensureSubmissionReviewsTableDefinition(db) {
    const columns = await getTableColumns(db, "submission_reviews");

    if (!columns.length) {
        await db.exec(`
            CREATE TABLE submission_reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                submission_id INTEGER NOT NULL UNIQUE,
                reviewer_user_id INTEGER NOT NULL,
                score REAL NOT NULL,
                comment TEXT NOT NULL DEFAULT '',
                reviewed_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
                updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
                FOREIGN KEY (submission_id) REFERENCES assignment_submissions(id) ON DELETE CASCADE,
                FOREIGN KEY (reviewer_user_id) REFERENCES users(id)
            );
        `);
        return;
    }

    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
        "submission_id",
        "reviewer_user_id",
        "score",
        "comment",
        "reviewed_at",
        "updated_at",
    ];
    const foreignKeys = await db.all(
        `PRAGMA foreign_key_list(submission_reviews)`,
    );
    const submissionForeignKey = foreignKeys.find(
        (foreignKey) => foreignKey.from === "submission_id",
    );
    const reviewerForeignKey = foreignKeys.find(
        (foreignKey) => foreignKey.from === "reviewer_user_id",
    );
    const hasExpectedForeignKeys =
        submissionForeignKey?.table === "assignment_submissions" &&
        submissionForeignKey?.to === "id" &&
        reviewerForeignKey?.table === "users" &&
        reviewerForeignKey?.to === "id";

    if (
        requiredColumns.every((columnName) => columnNames.has(columnName)) &&
        hasExpectedForeignKeys
    ) {
        return;
    }

    await db.exec(
        `ALTER TABLE submission_reviews RENAME TO submission_reviews_old`,
    );
    await db.exec(`
        CREATE TABLE submission_reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            submission_id INTEGER NOT NULL UNIQUE,
            reviewer_user_id INTEGER NOT NULL,
            score REAL NOT NULL,
            comment TEXT NOT NULL DEFAULT '',
            reviewed_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            updated_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (submission_id) REFERENCES assignment_submissions(id) ON DELETE CASCADE,
            FOREIGN KEY (reviewer_user_id) REFERENCES users(id)
        );
    `);
    await db.exec(`
        INSERT INTO submission_reviews (
            id,
            submission_id,
            reviewer_user_id,
            score,
            comment,
            reviewed_at,
            updated_at
        )
        SELECT
            id,
            submission_id,
            reviewer_user_id,
            score,
            comment,
            reviewed_at,
            updated_at
        FROM submission_reviews_old
    `);
    await db.exec(`DROP TABLE submission_reviews_old`);
}

async function ensureUploadTables(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS uploaded_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER NOT NULL,
            storage_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            width INTEGER DEFAULT NULL,
            height INTEGER DEFAULT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('image', 'document', 'file')),
            purpose TEXT NOT NULL CHECK (purpose IN ('assignment_attachment', 'submission_attachment', 'solochat')),
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (owner_user_id) REFERENCES users(id)
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS assignment_files (
            assignment_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL UNIQUE,
            PRIMARY KEY (assignment_id, file_id),
            FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS submission_files (
            submission_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL UNIQUE,
            PRIMARY KEY (submission_id, file_id),
            FOREIGN KEY (submission_id) REFERENCES assignment_submissions(id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_message_files (
            message_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL UNIQUE,
            PRIMARY KEY (message_id, file_id),
            FOREIGN KEY (message_id) REFERENCES solochat_messages(id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_uploaded_files_owner_created
        ON uploaded_files(owner_user_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_assignment_files_assignment
        ON assignment_files(assignment_id, file_id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_submission_files_submission
        ON submission_files(submission_id, file_id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_message_files_message
        ON solochat_message_files(message_id, file_id)
    `);
}

async function getTableColumns(db, tableName) {
    return db.all(`PRAGMA table_info(${tableName})`);
}

module.exports = {
    initDb,
    openDbConnection,
    SQLITE_BUSY_TIMEOUT_MS,
    withImmediateTransaction,
};
