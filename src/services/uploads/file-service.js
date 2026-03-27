const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { withImmediateTransaction } = require("../../lib/db");
const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_EDGE = 2048;
const WEBP_QUALITY = 80;
const MAX_DOCUMENT_TEXT_CHARS = 24000;
const FILE_KINDS = {
    IMAGE: "image",
    DOCUMENT: "document",
    FILE: "file",
};
const FILE_PURPOSES = {
    ASSIGNMENT_ATTACHMENT: "assignment_attachment",
    SUBMISSION_ATTACHMENT: "submission_attachment",
    SOLOCHAT: "solochat",
};

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function conflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    error.expose = true;
    return error;
}

function createFileService(db, options = {}) {
    const uploadsRoot =
        options.uploadsRoot ||
        path.resolve(process.cwd(), "data", "uploads", "files");
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;

    async function processUpload({ userId, file, purpose }) {
        validateUploadedFile(file);
        validatePurpose(purpose);

        const normalizedFile = await normalizeUploadForPurpose({
            file,
            purpose,
        });

        const safeFileName = sanitizeFileName(
            file.originalname || "upload.bin",
        );
        const storedFileName =
            normalizedFile.kind === FILE_KINDS.IMAGE
                ? replaceFileExtension(safeFileName, ".webp")
                : safeFileName;
        const relativePath = path.join(
            purpose,
            String(userId),
            `${crypto.randomUUID()}-${storedFileName}`,
        );
        const absolutePath = path.join(uploadsRoot, relativePath);

        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, normalizedFile.buffer);

        try {
            return await createFileRecord({
                userId,
                storagePath: absolutePath,
                fileName: storedFileName,
                mimeType: String(
                    normalizedFile.mimetype || "application/octet-stream",
                ),
                sizeBytes: normalizedFile.size,
                width: normalizedFile.width ?? null,
                height: normalizedFile.height ?? null,
                kind: normalizedFile.kind,
                purpose,
            });
        } catch (error) {
            await deleteStoredFilesBestEffort([{ storage_path: absolutePath }]);
            throw error;
        }
    }

    async function createFileRecord({
        userId,
        storagePath,
        fileName,
        mimeType,
        sizeBytes,
        width,
        height,
        kind,
        purpose,
    }) {
        const result = await db.run(
            `INSERT INTO uploaded_files (
                 owner_user_id,
                 storage_path,
                 file_name,
                 mime_type,
                 size_bytes,
                 width,
                 height,
                 kind,
                 purpose,
                 created_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowExpression})`,
            userId,
            storagePath,
            fileName,
            mimeType,
            sizeBytes,
            width,
            height,
            kind,
            purpose,
        );

        return getFileById(result.lastID);
    }

    async function getFileById(fileId) {
        return db.get(
            `SELECT id, owner_user_id, storage_path, file_name, mime_type, size_bytes, width, height, kind, purpose, created_at
             FROM uploaded_files
             WHERE id = ?`,
            fileId,
        );
    }

    async function getFileForOwner({ fileId, userId }) {
        return db.get(
            `SELECT id, owner_user_id, storage_path, file_name, mime_type, size_bytes, width, height, kind, purpose, created_at
             FROM uploaded_files
             WHERE id = ? AND owner_user_id = ?`,
            fileId,
            userId,
        );
    }

    async function listFilesByIds(fileIds) {
        const normalizedIds = normalizeIds(fileIds);

        if (!normalizedIds.length) {
            return [];
        }

        const placeholders = normalizedIds.map(() => "?").join(", ");
        return db.all(
            `SELECT id, owner_user_id, storage_path, file_name, mime_type, size_bytes, width, height, kind, purpose, created_at
             FROM uploaded_files
             WHERE id IN (${placeholders})`,
            ...normalizedIds,
        );
    }

    async function listFilesForAssignment(assignmentId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.purpose, uf.created_at
             FROM assignment_files af
             INNER JOIN uploaded_files uf
                 ON uf.id = af.file_id
             WHERE af.assignment_id = ?
             ORDER BY uf.id ASC`,
            assignmentId,
        );
    }

    async function listFilesForSubmission(submissionId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.purpose, uf.created_at
             FROM submission_files sf
             INNER JOIN uploaded_files uf
                 ON uf.id = sf.file_id
             WHERE sf.submission_id = ?
             ORDER BY uf.id ASC`,
            submissionId,
        );
    }

    async function listFilesForSoloChatMessage(messageId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.purpose, uf.created_at
             FROM solochat_message_files smf
             INNER JOIN uploaded_files uf
                 ON uf.id = smf.file_id
             WHERE smf.message_id = ?
             ORDER BY uf.id ASC`,
            messageId,
        );
    }

    async function listFilesForConversation(conversationId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.purpose, uf.created_at
             FROM solochat_message_files smf
             INNER JOIN solochat_messages sm ON sm.id = smf.message_id
             INNER JOIN uploaded_files uf ON uf.id = smf.file_id
             WHERE sm.conversation_id = ?
             ORDER BY uf.id ASC`,
            conversationId,
        );
    }

    async function replaceAssignmentFiles({ assignmentId, fileIds, userId }) {
        const normalizedIds = normalizeIds(fileIds);
        const files = await ensureAttachableFiles({
            fileIds: normalizedIds,
            userId,
            expectedPurpose: FILE_PURPOSES.ASSIGNMENT_ATTACHMENT,
            targetType: "assignment",
            targetId: assignmentId,
        });

        await db.run(
            `DELETE FROM assignment_files WHERE assignment_id = ?`,
            assignmentId,
        );

        for (const file of files) {
            await db.run(
                `INSERT INTO assignment_files (assignment_id, file_id)
                 VALUES (?, ?)`,
                assignmentId,
                file.id,
            );
        }

        return listFilesForAssignment(assignmentId);
    }

    async function replaceSubmissionFiles({ submissionId, fileIds, userId }) {
        const normalizedIds = normalizeIds(fileIds);
        const files = await ensureAttachableFiles({
            fileIds: normalizedIds,
            userId,
            expectedPurpose: FILE_PURPOSES.SUBMISSION_ATTACHMENT,
            targetType: "submission",
            targetId: submissionId,
        });

        await db.run(
            `DELETE FROM submission_files WHERE submission_id = ?`,
            submissionId,
        );

        for (const file of files) {
            await db.run(
                `INSERT INTO submission_files (submission_id, file_id)
                 VALUES (?, ?)`,
                submissionId,
                file.id,
            );
        }

        return listFilesForSubmission(submissionId);
    }

    async function attachFilesToSoloChatMessage({
        messageId,
        fileIds,
        userId,
    }) {
        const normalizedIds = normalizeIds(fileIds);
        const files = await ensureAttachableFiles({
            fileIds: normalizedIds,
            userId,
            expectedPurpose: [FILE_PURPOSES.SOLOCHAT],
            targetType: "solochat_message",
            targetId: messageId,
        });

        for (const file of files) {
            await db.run(
                `INSERT INTO solochat_message_files (message_id, file_id)
                 VALUES (?, ?)`,
                messageId,
                file.id,
            );
        }

        return listFilesForSoloChatMessage(messageId);
    }

    async function deleteUnattachedFileForUser({ fileId, userId }) {
        const deletedFile = await withImmediateTransaction(async (txDb) => {
            const file = await txDb.get(
                `SELECT id, owner_user_id, storage_path, file_name, mime_type, size_bytes, purpose, created_at
                 FROM uploaded_files
                 WHERE id = ? AND owner_user_id = ?`,
                fileId,
                userId,
            );

            if (!file) {
                return null;
            }

            const assignmentBinding = await txDb.get(
                `SELECT assignment_id FROM assignment_files WHERE file_id = ?`,
                fileId,
            );
            const submissionBinding = await txDb.get(
                `SELECT submission_id FROM submission_files WHERE file_id = ?`,
                fileId,
            );
            const solochatBinding = await txDb.get(
                `SELECT message_id FROM solochat_message_files WHERE file_id = ?`,
                fileId,
            );

            if (assignmentBinding || submissionBinding || solochatBinding) {
                throw conflict("Attached files cannot be deleted");
            }

            const result = await txDb.run(
                `DELETE FROM uploaded_files WHERE id = ? AND owner_user_id = ?`,
                fileId,
                userId,
            );

            if (!result.changes) {
                return null;
            }

            return file;
        });

        if (!deletedFile) {
            return false;
        }

        await deleteStoredFilesBestEffort([deletedFile]);
        return true;
    }

    async function canUserAccessFile({ fileId, userId }) {
        const file = await getFileById(fileId);

        if (!file) {
            return null;
        }

        if (file.owner_user_id === userId) {
            return file;
        }

        const assignmentBinding = await db.get(
            `SELECT a.class_id
             FROM assignment_files af
             INNER JOIN assignments a ON a.id = af.assignment_id
             WHERE af.file_id = ?`,
            fileId,
        );

        if (assignmentBinding) {
            const membership = await db.get(
                `SELECT id FROM class_members WHERE class_id = ? AND user_id = ?`,
                assignmentBinding.class_id,
                userId,
            );

            if (membership) {
                return file;
            }
        }

        const submissionBinding = await db.get(
            `SELECT s.student_user_id, a.class_id
             FROM submission_files sf
             INNER JOIN assignment_submissions s ON s.id = sf.submission_id
             INNER JOIN assignments a ON a.id = s.assignment_id
             WHERE sf.file_id = ?`,
            fileId,
        );

        if (submissionBinding) {
            if (submissionBinding.student_user_id === userId) {
                return file;
            }

            const teacherMembership = await db.get(
                `SELECT id
                 FROM class_members
                 WHERE class_id = ? AND user_id = ? AND role = 'teacher'`,
                submissionBinding.class_id,
                userId,
            );

            if (teacherMembership) {
                return file;
            }
        }

        const solochatBinding = await db.get(
            `SELECT c.user_id
             FROM solochat_message_files smf
             INNER JOIN solochat_messages m ON m.id = smf.message_id
             INNER JOIN solochat_conversations c ON c.id = m.conversation_id
             WHERE smf.file_id = ?`,
            fileId,
        );

        if (solochatBinding && solochatBinding.user_id === userId) {
            return file;
        }

        return null;
    }

    async function ensureAttachableFiles({
        fileIds,
        userId,
        expectedPurpose,
        targetType,
        targetId,
    }) {
        if (!fileIds.length) {
            return [];
        }

        const files = await listFilesByIds(fileIds);

        if (files.length !== fileIds.length) {
            throw badRequest("One or more attachmentIds are invalid");
        }

        const fileMap = new Map(files.map((file) => [file.id, file]));
        const orderedFiles = fileIds.map((fileId) => fileMap.get(fileId));

        for (const file of orderedFiles) {
            if (file.owner_user_id !== userId) {
                throw badRequest(
                    "All attachments must be uploaded by the current user",
                );
            }

            const allowedPurposes = Array.isArray(expectedPurpose)
                ? expectedPurpose
                : [expectedPurpose];

            if (!allowedPurposes.includes(file.purpose)) {
                throw badRequest(
                    "One or more attachments use the wrong purpose",
                );
            }

            const assignmentBinding = await db.get(
                `SELECT assignment_id FROM assignment_files WHERE file_id = ?`,
                file.id,
            );
            const submissionBinding = await db.get(
                `SELECT submission_id FROM submission_files WHERE file_id = ?`,
                file.id,
            );
            const solochatBinding = await db.get(
                `SELECT message_id FROM solochat_message_files WHERE file_id = ?`,
                file.id,
            );

            if (
                assignmentBinding &&
                !(
                    targetType === "assignment" &&
                    assignmentBinding.assignment_id === targetId
                )
            ) {
                throw conflict(
                    "One or more attachments are already attached elsewhere",
                );
            }

            if (
                submissionBinding &&
                !(
                    targetType === "submission" &&
                    submissionBinding.submission_id === targetId
                )
            ) {
                throw conflict(
                    "One or more attachments are already attached elsewhere",
                );
            }

            if (
                solochatBinding &&
                !(
                    targetType === "solochat_message" &&
                    solochatBinding.message_id === targetId
                )
            ) {
                throw conflict(
                    "One or more attachments are already attached elsewhere",
                );
            }
        }

        return orderedFiles;
    }

    async function buildDataUrl(file) {
        const fileBuffer = await fs.readFile(file.storage_path);
        return `data:${file.mime_type};base64,${fileBuffer.toString("base64")}`;
    }

    async function readTextContent(file, options = {}) {
        const maxChars = options.maxChars || MAX_DOCUMENT_TEXT_CHARS;
        const fileBuffer = await fs.readFile(file.storage_path);
        const textContent = fileBuffer
            .toString("utf8")
            .replace(/\u0000/g, "")
            .trim();

        if (!textContent) {
            return "";
        }

        return textContent.slice(0, maxChars);
    }

    return {
        attachFilesToSoloChatMessage,
        buildDataUrl,
        canUserAccessFile,
        deleteUnattachedFileForUser,
        getFileById,
        getFileForOwner,
        listFilesByIds,
        listFilesForAssignment,
        listFilesForConversation,
        listFilesForSoloChatMessage,
        listFilesForSubmission,
        processUpload,
        readTextContent,
        replaceAssignmentFiles,
        replaceSubmissionFiles,
    };
}

function validateUploadedFile(file) {
    if (!file || !file.buffer || !Buffer.isBuffer(file.buffer)) {
        throw badRequest("file is required");
    }

    if (!file.size || file.size <= 0) {
        throw badRequest("Uploaded file is empty");
    }

    if (file.size > MAX_UPLOAD_BYTES) {
        throw badRequest("File exceeds the 20MB upload limit");
    }
}

async function normalizeSoloChatImageUpload(file) {
    if (!String(file.mimetype || "").startsWith("image/")) {
        throw badRequest("solochat_image must be an image file");
    }

    try {
        const image = sharp(file.buffer, {
            failOn: "error",
            limitInputPixels: MAX_IMAGE_PIXELS,
        });
        const metadata = await image.metadata();
        const width = metadata.width || 0;
        const height = metadata.height || 0;

        if (!width || !height) {
            throw badRequest(
                "Uploaded image dimensions could not be determined",
            );
        }

        if (width * height > MAX_IMAGE_PIXELS) {
            throw badRequest("Image is too large");
        }

        const outputBuffer = await image
            .rotate()
            .resize({
                width: MAX_IMAGE_EDGE,
                height: MAX_IMAGE_EDGE,
                fit: "inside",
                withoutEnlargement: true,
            })
            .webp({ quality: WEBP_QUALITY })
            .toBuffer();
        const outputMetadata = await sharp(outputBuffer).metadata();

        return {
            ...file,
            buffer: outputBuffer,
            size: outputBuffer.length,
            mimetype: "image/webp",
            width: outputMetadata.width || width,
            height: outputMetadata.height || height,
            kind: FILE_KINDS.IMAGE,
        };
    } catch (error) {
        if (error.statusCode) {
            throw error;
        }

        if (
            /Input image exceeds pixel limit|unsupported image format|corrupt header|bad seek/i.test(
                error.message || "",
            )
        ) {
            throw badRequest("Uploaded image could not be processed");
        }

        throw error;
    }
}

function normalizeSoloChatDocumentUpload(file) {
    if (!isTextLikeFile(file)) {
        throw badRequest(
            "solochat only supports images or text-like documents",
        );
    }

    return {
        ...file,
        kind: FILE_KINDS.DOCUMENT,
    };
}

async function normalizeUploadForPurpose({ file, purpose }) {
    if (purpose === FILE_PURPOSES.SOLOCHAT) {
        return String(file.mimetype || "").startsWith("image/")
            ? normalizeSoloChatImageUpload(file)
            : normalizeSoloChatDocumentUpload(file);
    }

    return {
        ...file,
        kind: String(file.mimetype || "").startsWith("image/")
            ? FILE_KINDS.IMAGE
            : FILE_KINDS.FILE,
    };
}

function validatePurpose(value) {
    if (!Object.values(FILE_PURPOSES).includes(value)) {
        throw badRequest(
            "purpose must be assignment_attachment, submission_attachment, or solochat",
        );
    }

    return value;
}

function normalizeIds(values) {
    if (values === undefined || values === null) {
        return [];
    }

    if (!Array.isArray(values)) {
        throw badRequest("attachmentIds must be an array");
    }

    const seen = new Set();
    return values.map((value) => {
        const id = Number(value);

        if (!Number.isInteger(id) || id <= 0) {
            throw badRequest("attachmentIds must contain positive integers");
        }

        if (seen.has(id)) {
            throw badRequest("attachmentIds must not contain duplicates");
        }

        seen.add(id);
        return id;
    });
}

function sanitizeFileName(fileName) {
    return (
        String(fileName || "upload.bin")
            .replace(/[\\/\r\n]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200) || "upload.bin"
    );
}

function replaceFileExtension(fileName, extension) {
    return fileName.replace(/\.[^.]+$/, "") + extension;
}

function isTextLikeFile(file) {
    const mimeType = String(file.mimetype || "").toLowerCase();
    const fileName = String(file.originalname || "").toLowerCase();

    if (
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/xml" ||
        mimeType === "application/javascript" ||
        mimeType === "application/x-javascript" ||
        mimeType === "application/x-yaml"
    ) {
        return true;
    }

    return /\.(txt|md|markdown|csv|json|yaml|yml|xml|html|htm|css|js|mjs|cjs|ts|tsx|jsx|py|java|c|cpp|cc|h|hpp|go|rs|sql)$/i.test(
        fileName,
    );
}

async function deleteStoredFilesBestEffort(files) {
    for (const file of files) {
        if (!file?.storage_path) {
            continue;
        }

        try {
            await fs.unlink(file.storage_path);
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

module.exports = {
    createFileService,
    FILE_PURPOSES,
    MAX_UPLOAD_BYTES,
};
