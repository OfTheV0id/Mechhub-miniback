const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { SQLITE_NOW_ISO_EXPRESSION } = require("./time");

let dbPromise;
const SQLITE_BUSY_TIMEOUT_MS = 5000;
const LEGACY_ASSIGNMENT_TABLES = [
    "assignment_files",
    "submission_files",
    "submission_reviews",
    "assignment_submissions",
    "assignments",
];

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
    await migrateLegacyAssignmentAndUploadTables(db);
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
            type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'grading')),
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

    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_grading_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            message_id INTEGER DEFAULT NULL,
            prompt_text TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
            error_message TEXT DEFAULT NULL,
            selected_image_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            started_at TEXT DEFAULT NULL,
            completed_at TEXT DEFAULT NULL,
            FOREIGN KEY (conversation_id) REFERENCES solochat_conversations(id) ON DELETE CASCADE,
            FOREIGN KEY (message_id) REFERENCES solochat_messages(id) ON DELETE SET NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_grading_task_files (
            task_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('image', 'context')),
            PRIMARY KEY (task_id, file_id),
            FOREIGN KEY (task_id) REFERENCES solochat_grading_tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_grading_annotations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL,
            page_index INTEGER NOT NULL DEFAULT 0,
            order_index INTEGER NOT NULL DEFAULT 0,
            bbox_x REAL NOT NULL,
            bbox_y REAL NOT NULL,
            bbox_width REAL NOT NULL,
            bbox_height REAL NOT NULL,
            recognized_text TEXT NOT NULL DEFAULT '',
            recognized_formula TEXT NOT NULL DEFAULT '',
            commentary TEXT NOT NULL DEFAULT '',
            severity TEXT NOT NULL CHECK (severity IN ('correct', 'warning', 'error', 'note')),
            FOREIGN KEY (task_id) REFERENCES solochat_grading_tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_grading_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
            error_message TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (task_id) REFERENCES solochat_grading_tasks(id) ON DELETE CASCADE
        );
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_grading_tasks_conversation
        ON solochat_grading_tasks(conversation_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_grading_tasks_user
        ON solochat_grading_tasks(user_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_grading_task_files_task
        ON solochat_grading_task_files(task_id, file_id)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_grading_annotations_task
        ON solochat_grading_annotations(task_id, file_id, page_index, order_index)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_grading_runs_task
        ON solochat_grading_runs(task_id, created_at DESC, id DESC)
    `);

    await db.run(
        `UPDATE solochat_grading_tasks
         SET status = 'failed',
             error_message = COALESCE(error_message, 'Grading interrupted by server restart'),
             completed_at = COALESCE(completed_at, (${SQLITE_NOW_ISO_EXPRESSION}))
         WHERE status = 'processing'`,
    );

    await db.run(
        `UPDATE solochat_grading_runs
         SET status = 'failed',
             error_message = COALESCE(error_message, 'Grading interrupted by server restart')
         WHERE status = 'processing'`,
    );

    const messageColumns = await db.all(`PRAGMA table_info(solochat_messages)`);
    const messageColumnNames = new Set(
        messageColumns.map((column) => column.name),
    );
    if (!messageColumnNames.has("type")) {
        await db.exec(
            `ALTER TABLE solochat_messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'`,
        );
    }

    const gradingTaskColumns = await db.all(
        `PRAGMA table_info(solochat_grading_tasks)`,
    );
    const gradingTaskColumnNames = new Set(
        gradingTaskColumns.map((column) => column.name),
    );
    if (!gradingTaskColumnNames.has("message_id")) {
        await db.exec(
            `ALTER TABLE solochat_grading_tasks ADD COLUMN message_id INTEGER DEFAULT NULL REFERENCES solochat_messages(id)`,
        );
    }

    await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_solochat_grading_tasks_message
        ON solochat_grading_tasks(message_id)
        WHERE message_id IS NOT NULL
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

    // 检查并添加 avatar_file_id 字段
    const columns = await db.all(`PRAGMA table_info(classes)`);
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("avatar_file_id")) {
        await db.exec(
            `ALTER TABLE classes ADD COLUMN avatar_file_id INTEGER DEFAULT NULL REFERENCES uploaded_files(id)`
        );
    }
}

async function migrateLegacyAssignmentAndUploadTables(db) {
    const uploadedFilesSourceTable = await resolveSourceTableName(
        db,
        "uploaded_files",
    );
    const solochatBindingsSourceTable = await resolveSourceTableName(
        db,
        "solochat_message_files",
    );
    const hasUploadedFilesOldTable = await tableExists(db, "uploaded_files_old");
    const hasSoloChatBindingsOldTable = await tableExists(
        db,
        "solochat_message_files_old",
    );
    const legacyTables = await listExistingTables(db, LEGACY_ASSIGNMENT_TABLES);
    const uploadedFilesColumns = uploadedFilesSourceTable
        ? await getTableColumns(db, uploadedFilesSourceTable)
        : [];
    const uploadedFilesColumnNames = new Set(
        uploadedFilesColumns.map((column) => column.name),
    );
    const needsUploadMigration =
        Boolean(uploadedFilesSourceTable) &&
        (hasUploadedFilesOldTable ||
            hasSoloChatBindingsOldTable ||
            uploadedFilesSourceTable !== "uploaded_files" ||
            solochatBindingsSourceTable === "solochat_message_files_old" ||
            uploadedFilesColumnNames.has("purpose") ||
            legacyTables.length > 0);

    if (!needsUploadMigration) {
        if (!uploadedFilesSourceTable && legacyTables.length) {
            await dropTablesWithForeignKeysDisabled(db, legacyTables);
        }

        return;
    }

    const retainedFiles =
        uploadedFilesSourceTable && solochatBindingsSourceTable
            ? await db.all(
                  `SELECT DISTINCT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
                   FROM ${uploadedFilesSourceTable} uf
                   INNER JOIN ${solochatBindingsSourceTable} smf
                       ON smf.file_id = uf.id
                   ORDER BY uf.id ASC`,
              )
            : [];
    const retainedFileIds = retainedFiles.map((file) => file.id);
    const retainedFileIdSet = new Set(retainedFileIds);
    const allUploadedFiles = uploadedFilesSourceTable
        ? await db.all(
              `SELECT id, storage_path
               FROM ${uploadedFilesSourceTable}`,
          )
        : [];
    const filesToDelete = allUploadedFiles.filter(
        (file) => !retainedFileIdSet.has(file.id),
    );
    const retainedBindings =
        retainedFileIds.length && solochatBindingsSourceTable
            ? await db.all(
                  `SELECT message_id, file_id
                   FROM ${solochatBindingsSourceTable}
                   WHERE file_id IN (${retainedFileIds.map(() => "?").join(", ")})
                   ORDER BY message_id ASC, file_id ASC`,
                  ...retainedFileIds,
              )
            : [];

    await rebuildUploadTables(db, {
        retainedFiles: retainedFiles.map((file) => ({
            ...file,
            kind: normalizeUploadedFileKind(file.kind),
        })),
        retainedBindings,
        dropTableNames: [
            ...LEGACY_ASSIGNMENT_TABLES,
            "uploaded_files",
            "uploaded_files_old",
            "solochat_message_files",
            "solochat_message_files_old",
        ],
    });
    await deleteStoredFilesBestEffort(filesToDelete);
}

async function rebuildUploadTables(
    db,
    { retainedFiles, retainedBindings, dropTableNames },
) {
    await db.exec("PRAGMA foreign_keys = OFF");

    try {
        await dropTables(db, dropTableNames);
        await createUploadedFilesTable(db);
        await createSoloChatMessageFilesTable(db);

        for (const file of retainedFiles) {
            await db.run(
                `INSERT INTO uploaded_files (
                     id,
                     owner_user_id,
                     storage_path,
                     file_name,
                     mime_type,
                     size_bytes,
                     width,
                     height,
                     kind,
                     created_at
                 )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                file.id,
                file.owner_user_id,
                file.storage_path,
                file.file_name,
                file.mime_type,
                file.size_bytes,
                file.width ?? null,
                file.height ?? null,
                file.kind,
                file.created_at || new Date().toISOString(),
            );
        }

        for (const binding of retainedBindings) {
            await db.run(
                `INSERT INTO solochat_message_files (message_id, file_id)
                 VALUES (?, ?)`,
                binding.message_id,
                binding.file_id,
            );
        }
    } finally {
        await db.exec("PRAGMA foreign_keys = ON");
    }
}

async function ensureUploadTables(db) {
    await createUploadedFilesTable(db);
    await createSoloChatMessageFilesTable(db);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_uploaded_files_owner_created
        ON uploaded_files(owner_user_id, created_at DESC, id DESC)
    `);

    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_solochat_message_files_message
        ON solochat_message_files(message_id, file_id)
    `);
}

async function createUploadedFilesTable(db) {
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
            kind TEXT NOT NULL CHECK (kind IN ('image', 'text')),
            created_at TEXT NOT NULL DEFAULT (${SQLITE_NOW_ISO_EXPRESSION}),
            FOREIGN KEY (owner_user_id) REFERENCES users(id)
        );
    `);
}

async function createSoloChatMessageFilesTable(db) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS solochat_message_files (
            message_id INTEGER NOT NULL,
            file_id INTEGER NOT NULL UNIQUE,
            PRIMARY KEY (message_id, file_id),
            FOREIGN KEY (message_id) REFERENCES solochat_messages(id) ON DELETE CASCADE,
            FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
        );
    `);
}

async function resolveSourceTableName(db, tableName) {
    if (await tableExists(db, tableName)) {
        return tableName;
    }

    const oldTableName = `${tableName}_old`;
    return (await tableExists(db, oldTableName)) ? oldTableName : null;
}

async function listExistingTables(db, tableNames) {
    const existing = [];

    for (const tableName of tableNames) {
        if (await tableExists(db, tableName)) {
            existing.push(tableName);
        }
    }

    return existing;
}

async function dropTablesWithForeignKeysDisabled(db, tableNames) {
    await db.exec("PRAGMA foreign_keys = OFF");

    try {
        await dropTables(db, tableNames);
    } finally {
        await db.exec("PRAGMA foreign_keys = ON");
    }
}

async function dropTables(db, tableNames) {
    for (const tableName of tableNames) {
        await db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    }
}

function normalizeUploadedFileKind(kind) {
    return kind === "image" ? "image" : "text";
}

async function deleteStoredFilesBestEffort(files) {
    for (const file of files) {
        if (!file?.storage_path) {
            continue;
        }

        try {
            await fsPromises.unlink(file.storage_path);
        } catch (error) {
            if (error?.code !== "ENOENT") {
                console.warn(
                    "Failed to delete stored file",
                    file.storage_path,
                    error,
                );
            }
        }
    }
}

async function tableExists(db, tableName) {
    const row = await db.get(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
        tableName,
    );

    return Boolean(row);
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
