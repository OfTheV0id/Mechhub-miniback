const crypto = require("node:crypto");
const { toIsoTimestamp } = require("./time");

const USER_ROLES = {
    TEACHER: "teacher",
    STUDENT: "student",
};

const NAME_PREFIXES = [
    "Mech",
    "Torque",
    "Static",
    "Vector",
    "Gear",
    "Atlas",
    "Motion",
    "Force",
    "Pivot",
    "Axle",
];

const NAME_SUFFIXES = [
    "Fox",
    "Stone",
    "Wave",
    "Spark",
    "Leaf",
    "Pilot",
    "Nova",
    "Field",
    "Rider",
    "Forge",
];

function sanitizeUser(user) {
    return {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        bio: user.bio,
        defaultRole: user.default_role,
        createdAt: toIsoTimestamp(user.created_at),
    };
}

function buildUserSelectQuery() {
    return `SELECT id, email, display_name, avatar_url, bio, default_role, created_at
            FROM users`;
}

async function getUserById(db, userId) {
    return db.get(
        `${buildUserSelectQuery()}
         WHERE id = ?`,
        userId,
    );
}

function isValidUserRole(role) {
    return Object.values(USER_ROLES).includes(role);
}

function parseUserRole(value, fieldName = "defaultRole") {
    if (!isValidUserRole(value)) {
        const error = new Error(`${fieldName} must be either teacher or student`);
        error.statusCode = 400;
        throw error;
    }

    return value;
}

function generateDefaultProfile() {
    const suffixNumber = crypto.randomInt(1000, 10000);
    const displayName = `${pick(NAME_PREFIXES)}${pick(NAME_SUFFIXES)}${suffixNumber}`;

    return {
        displayName,
        avatarUrl: `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(displayName)}`,
    };
}

function createInviteCode() {
    return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function pick(items) {
    return items[crypto.randomInt(0, items.length)];
}

module.exports = {
    USER_ROLES,
    buildUserSelectQuery,
    createInviteCode,
    generateDefaultProfile,
    getUserById,
    parseUserRole,
    sanitizeUser,
};
