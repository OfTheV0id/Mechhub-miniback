const sharp = require("sharp");

const DEFAULT_MATHPIX_BASE_URL = "https://api.mathpix.com";
const MATHPIX_IMAGE_OPTIONS = {
    ocr: ["math", "text"],
    formats: ["text", "data"],
    data_options: {
        include_asciimath: true,
        include_latex: true,
    },
    include_line_data: true,
    math_inline_delimiters: ["\\(", "\\)"],
    math_display_delimiters: ["\\[", "\\]"],
    rm_spaces: false,
};

function createMathpixOcrClient(options = {}) {
    const baseUrl = normalizeBaseUrl(
        options.baseUrl || process.env.MATHPIX_BASE_URL,
    );
    const appId = String(options.appId || process.env.MATHPIX_APP_ID || "")
        .trim();
    const appKey = String(options.appKey || process.env.MATHPIX_APP_KEY || "")
        .trim();

    async function recognizeImage({ imageDataUrl, signal }) {
        if (!appId || !appKey) {
            throw new Error("MATHPIX_APP_ID and MATHPIX_APP_KEY are required");
        }

        const imageFile = await buildMathpixImageFile(imageDataUrl);
        const formData = new FormData();
        formData.append("file", imageFile.blob, imageFile.fileName);
        formData.append(
            "options_json",
            JSON.stringify(MATHPIX_IMAGE_OPTIONS),
        );

        const response = await fetch(`${baseUrl}/v3/text`, {
            method: "POST",
            headers: {
                app_id: appId,
                app_key: appKey,
            },
            body: formData,
            signal,
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(
                payload?.error ||
                    payload?.error_info?.message ||
                    `Mathpix OCR failed with status ${response.status}`,
            );
        }

        return parseMathpixLineData(payload);
    }

    return {
        recognizeImage,
    };
}

async function buildMathpixImageFile(imageDataUrl) {
    const parsed = parseDataUrl(imageDataUrl);
    if (parsed.mimeType === "image/jpeg" || parsed.mimeType === "image/png") {
        return {
            blob: new Blob([parsed.buffer], { type: parsed.mimeType }),
            fileName: parsed.mimeType === "image/png" ? "image.png" : "image.jpg",
        };
    }

    const jpegBuffer = await sharp(parsed.buffer)
        .jpeg({ quality: 92 })
        .toBuffer();
    return {
        blob: new Blob([jpegBuffer], { type: "image/jpeg" }),
        fileName: "image.jpg",
    };
}

function parseDataUrl(value) {
    const match = String(value || "").match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) {
        throw new Error("Mathpix OCR requires a base64 image data URL");
    }

    return {
        mimeType: match[1].toLowerCase(),
        buffer: Buffer.from(match[2], "base64"),
    };
}

function parseMathpixLineData(payload) {
    const imageWidth = Number(payload?.image_width) || 0;
    const imageHeight = Number(payload?.image_height) || 0;
    if (imageWidth <= 0 || imageHeight <= 0) {
        return [];
    }

    return (Array.isArray(payload?.line_data) ? payload.line_data : [])
        .map((line) => normalizeMathpixLine(line, imageWidth, imageHeight))
        .filter(Boolean);
}

function normalizeMathpixLine(line, imageWidth, imageHeight) {
    const text = String(line?.text || "").trim();
    const contour = Array.isArray(line?.cnt) ? line.cnt : [];
    if (!text || !contour.length) {
        return null;
    }

    const points = contour
        .map((point) => ({
            x: Number(point?.[0]),
            y: Number(point?.[1]),
        }))
        .filter(
            (point) =>
                Number.isFinite(point.x) && Number.isFinite(point.y),
        );
    if (!points.length) {
        return null;
    }

    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = maxX - minX;
    const height = maxY - minY;
    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        id: line.id || null,
        text,
        type: line.type || null,
        confidence: line.confidence ?? null,
        confidenceRate: line.confidence_rate ?? null,
        isPrinted: Boolean(line.is_printed),
        isHandwritten: Boolean(line.is_handwritten),
        bbox: {
            x: clamp(minX / imageWidth, 0, 1),
            y: clamp(minY / imageHeight, 0, 1),
            width: clamp(width / imageWidth, 0, 1),
            height: clamp(height / imageHeight, 0, 1),
        },
    };
}

function normalizeBaseUrl(value) {
    return String(value || DEFAULT_MATHPIX_BASE_URL)
        .trim()
        .replace(/\/+$/, "");
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

module.exports = {
    createMathpixOcrClient,
};
