const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { SQLITE_NOW_ISO_EXPRESSION } = require("../../lib/time");

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_EDGE = 2048;
const WEBP_QUALITY = 80;
const STALE_UNATTACHED_IMAGE_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
]);

function createSoloChatImageService(db, options = {}) {
    const uploadsRoot =
        options.uploadsRoot ||
        path.resolve(process.cwd(), "data", "uploads", "solochat");
    const nowExpression = SQLITE_NOW_ISO_EXPRESSION;

    async function processUpload({ userId, file }) {
        validateUploadedFile(file);
        try {
            const image = sharp(file.buffer, {
                failOn: "error",
                limitInputPixels: MAX_IMAGE_PIXELS,
            });
            const metadata = await image.metadata();
            const width = metadata.width || 0;
            const height = metadata.height || 0;

            if (!width || !height) {
                throw badRequest("Uploaded image dimensions could not be determined");
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
            const relativePath = path.join(String(userId), `${crypto.randomUUID()}.webp`);
            const absolutePath = path.join(uploadsRoot, relativePath);

            await fs.mkdir(path.dirname(absolutePath), { recursive: true });
            await fs.writeFile(absolutePath, outputBuffer);

            return createImageRecord({
                userId,
                storagePath: absolutePath,
                mimeType: "image/webp",
                width: outputMetadata.width || width,
                height: outputMetadata.height || height,
                sizeBytes: outputBuffer.length,
            });
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

    async function createImageRecord({
        userId,
        storagePath,
        mimeType,
        width,
        height,
        sizeBytes,
    }) {
        const result = await db.run(
            `INSERT INTO solochat_images (
                 user_id,
                 storage_path,
                 mime_type,
                 width,
                 height,
                 size_bytes,
                 created_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ${nowExpression})`,
            userId,
            storagePath,
            mimeType,
            width,
            height,
            sizeBytes,
        );

        return getImageById(result.lastID);
    }

    async function getImageById(imageId) {
        return db.get(
            `SELECT id, user_id, message_id, storage_path, mime_type, width, height, size_bytes, created_at
             FROM solochat_images
             WHERE id = ?`,
            imageId,
        );
    }

    async function getImageForUser({ imageId, userId }) {
        return db.get(
            `SELECT id, user_id, message_id, storage_path, mime_type, width, height, size_bytes, created_at
             FROM solochat_images
             WHERE id = ? AND user_id = ?`,
            imageId,
            userId,
        );
    }

    async function attachImageToMessage({ imageId, userId, messageId }) {
        const result = await db.run(
            `UPDATE solochat_images
             SET message_id = ?
             WHERE id = ? AND user_id = ? AND message_id IS NULL`,
            messageId,
            imageId,
            userId,
        );

        if (!result.changes) {
            throw badRequest("imageId is invalid or has already been used");
        }

        return getImageById(imageId);
    }

    async function listImagesForMessageIds(messageIds) {
        if (!messageIds.length) {
            return [];
        }

        const placeholders = messageIds.map(() => "?").join(", ");
        return db.all(
            `SELECT id, user_id, message_id, storage_path, mime_type, width, height, size_bytes, created_at
             FROM solochat_images
             WHERE message_id IN (${placeholders})
             ORDER BY id ASC`,
            ...messageIds,
        );
    }

    async function listImagesForConversation(conversationId) {
        return db.all(
            `SELECT si.id, si.user_id, si.message_id, si.storage_path, si.mime_type, si.width, si.height, si.size_bytes, si.created_at
             FROM solochat_images si
             INNER JOIN solochat_messages sm ON sm.id = si.message_id
             WHERE sm.conversation_id = ?
             ORDER BY si.id ASC`,
            conversationId,
        );
    }

    async function deleteUnattachedImageForUser({ imageId, userId }) {
        const image = await getImageForUser({
            imageId,
            userId,
        });

        if (!image) {
            return false;
        }

        if (image.message_id) {
            throw conflictError("Attached images cannot be deleted");
        }

        await deleteStoredFiles([image]);
        await db.run(
            `DELETE FROM solochat_images
             WHERE id = ? AND user_id = ? AND message_id IS NULL`,
            imageId,
            userId,
        );

        return true;
    }

    async function purgeStaleUnattachedImages({
        userId,
        olderThanMs = STALE_UNATTACHED_IMAGE_AGE_MS,
    }) {
        const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
        const images = await db.all(
            `SELECT id, user_id, message_id, storage_path, mime_type, width, height, size_bytes, created_at
             FROM solochat_images
             WHERE user_id = ? AND message_id IS NULL AND created_at < ?`,
            userId,
            cutoffIso,
        );

        if (!images.length) {
            return 0;
        }

        await deleteStoredFiles(images);

        const placeholders = images.map(() => "?").join(", ");
        await db.run(
            `DELETE FROM solochat_images
             WHERE id IN (${placeholders})`,
            ...images.map((image) => image.id),
        );

        return images.length;
    }

    async function deleteStoredFiles(images) {
        await Promise.all(
            images.map(async (image) => {
                try {
                    await fs.unlink(image.storage_path);
                } catch (error) {
                    if (error.code !== "ENOENT") {
                        throw error;
                    }
                }
            }),
        );
    }

    async function buildDataUrl(image) {
        const fileBuffer = await fs.readFile(image.storage_path);
        return `data:${image.mime_type};base64,${fileBuffer.toString("base64")}`;
    }

    return {
        ALLOWED_IMAGE_MIME_TYPES,
        MAX_IMAGE_PIXELS,
        MAX_UPLOAD_BYTES,
        STALE_UNATTACHED_IMAGE_AGE_MS,
        attachImageToMessage,
        buildDataUrl,
        deleteUnattachedImageForUser,
        deleteStoredFiles,
        getImageById,
        getImageForUser,
        listImagesForConversation,
        listImagesForMessageIds,
        purgeStaleUnattachedImages,
        processUpload,
    };
}

function validateUploadedFile(file) {
    if (!file) {
        throw badRequest("image file is required");
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
        throw badRequest("Unsupported image type");
    }

    if (!Number.isFinite(file.size) || file.size <= 0) {
        throw badRequest("Uploaded image is empty");
    }

    if (file.size > MAX_UPLOAD_BYTES) {
        throw badRequest("Image exceeds the 20MB upload limit");
    }
}

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function conflictError(message) {
    const error = new Error(message);
    error.statusCode = 409;
    error.expose = true;
    return error;
}

module.exports = {
    ALLOWED_IMAGE_MIME_TYPES,
    MAX_IMAGE_PIXELS,
    MAX_UPLOAD_BYTES,
    STALE_UNATTACHED_IMAGE_AGE_MS,
    createSoloChatImageService,
};
