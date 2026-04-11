const SOLOCHAT_DOCUMENT_EXTENSIONS = new Set([
    "txt",
    "md",
    "markdown",
    "csv",
    "json",
    "xml",
    "yaml",
    "yml",
    "log",
    "html",
    "htm",
    "css",
    "js",
    "mjs",
    "cjs",
    "ts",
    "jsx",
    "tsx",
    "py",
    "java",
    "c",
    "cpp",
    "cc",
    "h",
    "hpp",
    "go",
    "rs",
    "sql",
]);

const SOLOCHAT_IMAGE_EXTENSIONS = new Set([
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "bmp",
]);

const SOLOCHAT_DOCUMENT_MIME_TYPES = new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "text/css",
    "text/javascript",
    "text/xml",
    "application/json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/javascript",
    "application/x-javascript",
]);

const SOLOCHAT_DOCUMENT_PREVIEW_MAX_CHARS = 24000;

function normalizeMimeType(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizeExtension(fileName) {
    const normalizedName = String(fileName || "").trim().toLowerCase();
    const lastDotIndex = normalizedName.lastIndexOf(".");

    if (lastDotIndex < 0 || lastDotIndex === normalizedName.length - 1) {
        return "";
    }

    return normalizedName.slice(lastDotIndex + 1);
}

function isSoloChatImageMimeType(mimeType) {
    return normalizeMimeType(mimeType).startsWith("image/");
}

function isSoloChatImageFileName(fileName) {
    return SOLOCHAT_IMAGE_EXTENSIONS.has(normalizeExtension(fileName));
}

function isSoloChatDocumentMimeType(mimeType) {
    return SOLOCHAT_DOCUMENT_MIME_TYPES.has(normalizeMimeType(mimeType));
}

function isSoloChatDocumentFileName(fileName) {
    return SOLOCHAT_DOCUMENT_EXTENSIONS.has(normalizeExtension(fileName));
}

function isAllowedSoloChatDocument({ mimeType, fileName }) {
    const normalizedMimeType = normalizeMimeType(mimeType);

    if (isSoloChatDocumentMimeType(normalizedMimeType)) {
        return true;
    }

    if (
        normalizedMimeType &&
        normalizedMimeType !== "application/octet-stream"
    ) {
        return false;
    }

    return isSoloChatDocumentFileName(fileName);
}

function buildSoloChatAttachmentUrl(attachmentId) {
    return `/solochat/attachments/${attachmentId}`;
}

function buildSoloChatPreviewTextUrl(attachmentId) {
    return `${buildSoloChatAttachmentUrl(attachmentId)}/preview-text`;
}

module.exports = {
    SOLOCHAT_DOCUMENT_EXTENSIONS,
    SOLOCHAT_DOCUMENT_MIME_TYPES,
    SOLOCHAT_DOCUMENT_PREVIEW_MAX_CHARS,
    buildSoloChatAttachmentUrl,
    buildSoloChatPreviewTextUrl,
    isAllowedSoloChatDocument,
    isSoloChatImageFileName,
    isSoloChatDocumentFileName,
    isSoloChatDocumentMimeType,
    isSoloChatImageMimeType,
    normalizeExtension,
    normalizeMimeType,
};
