const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");
const {
    SOLOCHAT_DOCUMENT_PREVIEW_MAX_CHARS,
    isAllowedSoloChatDocument,
    isSoloChatImageMimeType,
} = require("../solochat/attachment-contract");

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_EDGE = 2048;
const WEBP_QUALITY = 80;
const FILE_KINDS = {
    IMAGE: "image",
    TEXT: "text",
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

    async function processUpload({ userId, file }) {
        validateUploadedFile(file);

        const normalizedFile = await normalizeSoloChatUpload(file);
        const safeFileName = sanitizeFileName(
            file.originalname || "upload.bin",
        );
        const storedFileName =
            normalizedFile.kind === FILE_KINDS.IMAGE
                ? replaceFileExtension(safeFileName, ".webp")
                : safeFileName;
        const relativePath = path.join(
            "solochat",
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
            });
        } catch (error) {
            await deleteStoredFilesBestEffort([{ storage_path: absolutePath }]);
            throw error;
        }
    }

    async function processImageUpload({ userId, file, subDir = "images" }) {
        validateUploadedFile(file);

        const normalizedFile = await normalizeImageUpload(file);
        const safeFileName = sanitizeFileName(file.originalname || "image.bin");
        const storedFileName = replaceFileExtension(safeFileName, ".webp");
        const relativePath = path.join(
            subDir,
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
                mimeType: "image/webp",
                sizeBytes: normalizedFile.size,
                width: normalizedFile.width ?? null,
                height: normalizedFile.height ?? null,
                kind: FILE_KINDS.IMAGE,
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
                 created_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowExpression})`,
            userId,
            storagePath,
            fileName,
            mimeType,
            sizeBytes,
            width,
            height,
            kind,
        );

        return getFileById(result.lastID);
    }

    async function getFileById(fileId) {
        return db.get(
            `SELECT id, owner_user_id, storage_path, file_name, mime_type, size_bytes, width, height, kind, created_at
             FROM uploaded_files
             WHERE id = ?`,
            fileId,
        );
    }

    async function getSoloChatFileForUser({ fileId, userId }) {
        return db.get(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM uploaded_files uf
             INNER JOIN solochat_message_files smf ON smf.file_id = uf.id
             INNER JOIN solochat_messages sm ON sm.id = smf.message_id
             INNER JOIN solochat_conversations sc ON sc.id = sm.conversation_id
             WHERE uf.id = ? AND sc.user_id = ?
             LIMIT 1`,
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
            `SELECT id, owner_user_id, storage_path, file_name, mime_type, size_bytes, width, height, kind, created_at
             FROM uploaded_files
             WHERE id IN (${placeholders})`,
            ...normalizedIds,
        );
    }

    async function listFilesForSoloChatMessage(messageId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
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
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at
             FROM solochat_message_files smf
             INNER JOIN solochat_messages sm ON sm.id = smf.message_id
             INNER JOIN uploaded_files uf ON uf.id = smf.file_id
             WHERE sm.conversation_id = ?
             ORDER BY uf.id ASC`,
            conversationId,
        );
    }

    async function attachFilesToSoloChatMessage({
        messageId,
        fileIds,
        userId,
    }) {
        const files = await ensureSoloChatAttachableFiles({
            fileIds,
            messageId,
            userId,
        });

        for (const file of files) {
            await db.run(
                `INSERT OR IGNORE INTO solochat_message_files (message_id, file_id)
                 VALUES (?, ?)`,
                messageId,
                file.id,
            );
        }

        return listFilesForSoloChatMessage(messageId);
    }

    async function ensureSoloChatAttachableFiles({
        fileIds,
        messageId,
        userId,
    }) {
        const normalizedIds = normalizeIds(fileIds);

        if (!normalizedIds.length) {
            return [];
        }

        const files = await listFilesByIds(normalizedIds);

        if (files.length !== normalizedIds.length) {
            throw badRequest("One or more attachmentIds are invalid");
        }

        const fileMap = new Map(files.map((file) => [file.id, file]));
        const orderedFiles = normalizedIds.map((fileId) => fileMap.get(fileId));

        for (const file of orderedFiles) {
            if (file.owner_user_id !== userId) {
                throw badRequest(
                    "All attachments must be uploaded by the current user",
                );
            }

            const existingBinding = await db.get(
                `SELECT message_id FROM solochat_message_files WHERE file_id = ?`,
                file.id,
            );

            if (existingBinding && existingBinding.message_id !== messageId) {
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

    async function readTextPreview(file, options = {}) {
        const maxChars =
            options.maxChars || SOLOCHAT_DOCUMENT_PREVIEW_MAX_CHARS;
        const textContent = await readRawUtf8TextContent(file);
        const truncated = textContent.length > maxChars;

        return {
            textContent: truncated ? textContent.slice(0, maxChars) : textContent,
            truncated,
            maxChars,
        };
    }

    async function readTextContent(file, options = {}) {
        const { textContent } = await readTextPreview(file, options);
        const trimmedContent = textContent.trim();

        if (!trimmedContent) {
            return "";
        }

        return trimmedContent;
    }

    return {
        attachFilesToSoloChatMessage,
        buildDataUrl,
        getFileById,
        getSoloChatFileForUser,
        listFilesForConversation,
        listFilesForSoloChatMessage,
        processImageUpload,
        processUpload,
        readTextContent,
        readTextPreview,
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
    if (!isSoloChatImageMimeType(file.mimetype)) {
        throw badRequest("solochat_image must be an image file");
    }

    return normalizeImageUpload(file);
}

async function normalizeImageUpload(file) {
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

function normalizeSoloChatTextUpload(file) {
    if (
        !isAllowedSoloChatDocument({
            mimeType: file.mimetype,
            fileName: file.originalname,
        })
    ) {
        throw badRequest(
            "solochat only supports images or approved text/code documents",
        );
    }

    return {
        ...file,
        kind: FILE_KINDS.TEXT,
    };
}

async function normalizeSoloChatUpload(file) {
    return isSoloChatImageMimeType(file.mimetype)
        ? normalizeSoloChatImageUpload(file)
        : normalizeSoloChatTextUpload(file);
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

async function readRawUtf8TextContent(file) {
    const fileBuffer = await fs.readFile(file.storage_path);
    return fileBuffer.toString("utf8").replace(/\u0000/g, "");
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
    MAX_UPLOAD_BYTES,
};
