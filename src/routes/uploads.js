const express = require("express");
const multer = require("multer");
const {
    createFileService,
    FILE_PURPOSES,
    MAX_UPLOAD_BYTES,
} = require("../services/uploads/file-service");
const { sanitizeFileAsset } = require("../lib/assignments");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
    },
});

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function unauthorized(message) {
    const error = new Error(message);
    error.statusCode = 401;
    return error;
}

function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

function requireUserId(req) {
    if (!req.session.userId) {
        throw unauthorized("Not authenticated");
    }

    return req.session.userId;
}

function parseFileId(value) {
    const fileId = Number(value);

    if (!Number.isInteger(fileId) || fileId <= 0) {
        throw badRequest("A valid fileId is required");
    }

    return fileId;
}

function parsePurpose(value) {
    if (!Object.values(FILE_PURPOSES).includes(value)) {
        throw badRequest(
            "purpose must be assignment_attachment, submission_attachment, or solochat",
        );
    }

    return value;
}

function singleFileUpload(req, res) {
    return new Promise((resolve, reject) => {
        upload.single("file")(req, res, (error) => {
            if (!error) {
                if (!req.file) {
                    reject(badRequest("file is required"));
                    return;
                }

                resolve();
                return;
            }

            if (error instanceof multer.MulterError) {
                if (error.code === "LIMIT_FILE_SIZE") {
                    reject(badRequest("File exceeds the 20MB upload limit"));
                    return;
                }

                reject(badRequest("File upload failed"));
                return;
            }

            reject(error);
        });
    });
}

function createUploadsRouter(db) {
    const router = express.Router();
    const fileService = createFileService(db);

    router.post("/uploads/files", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            await singleFileUpload(req, res);
            const uploadedFile = await fileService.processUpload({
                userId,
                file: req.file,
                purpose: parsePurpose(req.body?.purpose),
            });

            return res.status(201).json(sanitizeFileAsset(uploadedFile));
        } catch (error) {
            return next(error);
        }
    });

    router.get("/uploads/files/:fileId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const fileId = parseFileId(req.params.fileId);
            const file = await fileService.canUserAccessFile({
                fileId,
                userId,
            });

            if (!file) {
                throw notFound("File not found");
            }

            res.setHeader(
                "Content-Disposition",
                `inline; filename="${encodeURIComponent(file.file_name)}"`,
            );
            return res.type(file.mime_type).sendFile(file.storage_path);
        } catch (error) {
            return next(error);
        }
    });

    router.delete("/uploads/files/:fileId", async (req, res, next) => {
        try {
            const userId = requireUserId(req);
            const fileId = parseFileId(req.params.fileId);
            const deleted = await fileService.deleteUnattachedFileForUser({
                fileId,
                userId,
            });

            if (!deleted) {
                throw notFound("File not found");
            }

            return res.status(204).end();
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

module.exports = {
    createUploadsRouter,
};
