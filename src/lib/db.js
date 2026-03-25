const fs = require("node:fs");
const path = require("node:path");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const { SQLITE_NOW_ISO_EXPRESSION } = require("./time");

let dbPromise;

function resolveDbPath() {
    const configuredPath = process.env.DB_PATH || "./data/app.sqlite";

    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);
}

async function initDb() {
    if (!dbPromise) {
        const filename = resolveDbPath();
        fs.mkdirSync(path.dirname(filename), { recursive: true });

        dbPromise = open({
            filename,
            driver: sqlite3.Database,
        });
    }

    const db = await dbPromise;
    await db.exec("PRAGMA foreign_keys = ON");

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

    return db;
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
        await db.exec(`ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''`);
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

module.exports = {
    initDb,
};
