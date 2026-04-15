const fs = require("node:fs/promises");
const { withImmediateTransaction } = require("../../lib/db");
const { toIsoTimestamp } = require("../../lib/time");
const { createFileService } = require("../uploads/file-service");
const { createSoloChatConversationService } = require("./conversation-service");
const { createOpenAiCompatibleClient } = require("./openai-client");
const {
    generateConversationTitle,
    generateGradingTitle,
} = require("./ai-service");
const { buildSoloChatAttachmentUrl } = require("./attachment-contract");
const {
    normalizeCommentaryText,
    normalizeFormulaText,
    normalizeRenderableMessageContent,
} = require("./math-normalizer");

const CONTEXT_TEXT_MAX_CHARS = 12000;
const ALLOWED_SEVERITIES = new Set(["correct", "warning", "error", "note"]);
const GRADING_PROMPT = `
You are grading a student's subjective-answer homework submission.
Return JSON object stream only. Do not include markdown fences or any extra text.
You may receive optional question text, optional context documents, and multiple homework images.
All explanatory output must be written in Simplified Chinese.
The commentary field must be written in Simplified Chinese.
Do not write English commentary or extra English explanations.
The recognizedFormula field must be KaTeX/LaTeX-compatible.
Do not use Unicode math symbols such as ⇒, →, −, ≤, ≥, ≠, ×, · in recognizedFormula.
Use LaTeX commands such as \\Rightarrow, \\to, -, \\le, \\ge, \\ne, \\times, \\cdot instead.
When commentary contains mathematical expressions, use KaTeX/LaTeX-compatible syntax and avoid Unicode math symbols.
You must inspect every uploaded image.
Be exhaustive across all uploaded images and return every issue that should be annotated.
Do not stop after the first useful annotation.
Emit one annotation object at a time.
You may format each JSON object with whitespace and newlines, but output only complete JSON objects and nothing else.
Do not wrap annotations in an array.
Every annotation object must include:
- type: "annotation"
- fileIndex: zero-based index into the uploaded image list
- pageIndex: integer, use 0 for normal images
- orderIndex: integer order within that image
- bbox: { x, y, width, height } normalized between 0 and 1 relative to the image
- recognizedText: string
- recognizedFormula: string
- commentary: string
- severity: one of correct, warning, error, note
If an image does not need annotation, omit it for that image only.
If there are no useful annotations, output nothing.
`.trim();

const MIN_BBOX_SIZE = 0.001;

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.expose = true;
    return error;
}

function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

function conflict(message) {
    const error = new Error(message);
    error.statusCode = 409;
    error.expose = true;
    return error;
}

function serializeId(value) {
    if (value === undefined || value === null) {
        return null;
    }

    return String(value);
}

function createSoloChatGradingService(options = {}) {
    const db = options.db;
    const gradingEventsHub = options.gradingEventsHub;
    const gradingClient =
        options.client ||
        createOpenAiCompatibleClient({
            defaultModel:
                process.env.OPENAI_GRADING_MODEL ||
                process.env.OPENAI_MODEL,
        });
    const titleClient =
        options.titleClient ||
        createOpenAiCompatibleClient({
            defaultModel:
                process.env.OPENAI_CHAT_MODEL || process.env.OPENAI_MODEL,
        });
    const fileService = options.fileService || createFileService(db);
    const conversationService =
        options.conversationService || createSoloChatConversationService(db);

    async function createTask({
        conversationId,
        userId,
        promptText = "",
        uploadedFiles = [],
    }) {
        const normalizedPromptText = String(promptText || "").trim();
        let task = null;
        let userMessage = null;
        let gradingMessage = null;
        let updatedConversation = null;
        let createdFiles = [];
        let conversation = null;

        try {
            await withImmediateTransaction(async (txDb) => {
                const txConversationService =
                    createSoloChatConversationService(txDb);
                const txFileService = createFileService(txDb);
                conversation =
                    await txConversationService.getConversationForUser({
                        conversationId,
                        userId,
                    });

                if (!conversation) {
                    throw notFound("Conversation not found");
                }

                if (!uploadedFiles.length) {
                    throw badRequest("attachments are required");
                }

                createdFiles = [];
                for (const uploadedFile of uploadedFiles) {
                    createdFiles.push(
                        await txFileService.processUpload({
                            userId,
                            file: uploadedFile,
                        }),
                    );
                }

                const imageFiles = createdFiles.filter(
                    (file) => file.kind === "image",
                );
                if (!imageFiles.length) {
                    throw badRequest(
                        "grading mode requires at least one image attachment",
                    );
                }

                userMessage = await txConversationService.createMessage({
                    conversationId,
                    role: "user",
                    type: "text",
                    content: normalizedPromptText,
                    status: "completed",
                });

                if (createdFiles.length) {
                    await txFileService.attachFilesToSoloChatMessage({
                        messageId: userMessage.id,
                        fileIds: createdFiles.map((attachment) => attachment.id),
                        userId,
                    });
                }

                gradingMessage = await txConversationService.createMessage({
                    conversationId,
                    role: "assistant",
                    type: "grading",
                    content: "Grading homework...",
                    status: "streaming",
                });

                const result = await txDb.run(
                    `INSERT INTO solochat_grading_tasks (
                         conversation_id,
                         user_id,
                         message_id,
                         prompt_text,
                         generated_title,
                         status,
                         error_message,
                         selected_image_count,
                         created_at,
                         started_at,
                         completed_at
                     )
                     VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?, CURRENT_TIMESTAMP, NULL, NULL)`,
                    conversationId,
                    userId,
                    gradingMessage.id,
                    normalizedPromptText,
                    imageFiles.length,
                );

                for (const file of createdFiles) {
                    await txDb.run(
                        `INSERT INTO solochat_grading_task_files (task_id, file_id, role)
                         VALUES (?, ?, ?)`,
                        result.lastID,
                        file.id,
                        file.kind === "image" ? "image" : "context",
                    );
                }

                await txDb.run(
                    `INSERT INTO solochat_grading_runs (
                         task_id,
                         status,
                         error_message,
                         created_at
                     )
                     VALUES (?, 'pending', NULL, CURRENT_TIMESTAMP)`,
                    result.lastID,
                );

                task = await getTaskSummaryByIdWithDb(txDb, result.lastID);
                userMessage = await txConversationService.getMessageById(
                    userMessage.id,
                );
                gradingMessage = await txConversationService.getMessageById(
                    gradingMessage.id,
                );
                await txConversationService.touchConversation(conversationId);
            });
        } catch (error) {
            if (createdFiles.length) {
                await deleteStoredFilesBestEffort(createdFiles);
            }
            throw error;
        }

        const nextTitle = await generateConversationTitle({
            conversation,
            messages: [userMessage],
            attachmentService: fileService,
            client: titleClient,
        });
        updatedConversation = nextTitle
            ? await conversationService.updateConversationTitle({
                  conversationId,
                  title: nextTitle,
              })
            : await conversationService.getConversationById(conversationId);

        queueMicrotask(() => {
            void runTask(task.id);
        });

        return {
            task,
            userMessage,
            gradingMessage,
            conversation: updatedConversation,
        };
    }

    async function listTasksForConversation({ conversationId, userId }) {
        const conversation = await conversationService.getConversationForUser({
            conversationId,
            userId,
        });

        if (!conversation) {
            throw notFound("Conversation not found");
        }

        return listTaskSummariesByConversationId(conversationId);
    }

    async function getTaskSummaryForUser({ taskId, userId }) {
        const task = await getTaskByIdForUser(taskId, userId);
        if (!task) {
            throw notFound("Grading task not found");
        }

        const annotationCountRow = await db.get(
            `SELECT COUNT(*) AS count
             FROM solochat_grading_annotations
             WHERE task_id = ?`,
            task.id,
        );

        return hydrateTaskSummary(
            task,
            new Map([[task.id, Number(annotationCountRow?.count || 0)]]),
        );
    }

    async function getTaskDetailForUser({ taskId, userId }) {
        const task = await getTaskByIdForUser(taskId, userId);
        if (!task) {
            throw notFound("Grading task not found");
        }

        const allAttachments = await listTaskFiles(task.id);
        const annotations = await listTaskAnnotations(task.id);
        const attachments = allAttachments.filter(
            (attachment) => attachment.role === "image",
        );

        return {
            ...hydrateTaskSummary(task, new Map([[task.id, annotations.length]])),
            attachments,
            annotations,
        };
    }

    async function retryTask({ taskId, userId }) {
        const task = await getTaskByIdForUser(taskId, userId);
        if (!task) {
            throw notFound("Grading task not found");
        }

        if (![ "failed", "completed" ].includes(task.status)) {
            throw conflict(
                "Only completed or failed grading tasks can be retried",
            );
        }

        await db.run(
            `UPDATE solochat_grading_tasks
             SET status = 'pending',
                 generated_title = NULL,
                 error_message = NULL,
                 started_at = NULL,
                 completed_at = NULL
             WHERE id = ?`,
            task.id,
        );

        await db.run(
            `DELETE FROM solochat_grading_annotations
             WHERE task_id = ?`,
            task.id,
        );

        await db.run(
            `INSERT INTO solochat_grading_runs (
                 task_id,
                 status,
                 error_message,
                 created_at
             )
             VALUES (?, 'pending', NULL, CURRENT_TIMESTAMP)`,
            task.id,
        );

        const nextTask = await getTaskSummaryById(task.id);
        await syncGradingMessageProjection(nextTask);
        await emitTaskStatusEvent(nextTask.id);

        queueMicrotask(() => {
            void runTask(task.id);
        });

        return nextTask;
    }

    async function runTask(taskId) {
        let processingRunId = null;

        try {
            const processingTask = await withImmediateTransaction(async (txDb) => {
                const task = await txDb.get(
                    `SELECT id, conversation_id, user_id, message_id, prompt_text, generated_title, status, error_message, selected_image_count, created_at, started_at, completed_at
                     FROM solochat_grading_tasks
                     WHERE id = ?`,
                    Number(taskId),
                );

                if (!task || task.status === "processing") {
                    return null;
                }

                await txDb.run(
                    `UPDATE solochat_grading_tasks
                     SET status = 'processing',
                         error_message = NULL,
                         started_at = CURRENT_TIMESTAMP,
                         completed_at = NULL
                     WHERE id = ?`,
                    task.id,
                );

                const runResult = await txDb.run(
                    `INSERT INTO solochat_grading_runs (
                         task_id,
                         status,
                         error_message,
                         created_at
                     )
                     VALUES (?, 'processing', NULL, CURRENT_TIMESTAMP)`,
                    task.id,
                );
                processingRunId = runResult.lastID;

                return getTaskSummaryByIdWithDb(txDb, task.id);
            });

            if (!processingTask) {
                return;
            }

            await syncGradingMessageProjection(processingTask);
            await emitTaskStatusEvent(processingTask.id);

            const attachments = await listTaskFiles(Number(taskId));
            const imageAttachments = attachments.filter(
                (attachment) => attachment.role === "image",
            );
            const contextAttachments = attachments.filter(
                (attachment) => attachment.role === "context",
            );

            if (!imageAttachments.length) {
                throw badRequest(
                    "Grading task does not contain image attachments",
                );
            }

            const annotations = [];
            let streamIndex = 0;
            const streamParser = createStreamAnnotationParser(
                imageAttachments,
            );

            for await (const delta of gradingClient.streamChatCompletion({
                messages: await buildGradingMessages({
                    promptText: processingTask.promptText,
                    imageAttachments,
                    contextAttachments,
                    attachmentService: fileService,
                }),
                temperature: 0.1,
                maxTokens: 4000,
            })) {
                const nextAnnotations = streamParser.pushChunk(delta);
                for (const annotation of nextAnnotations) {
                    annotations.push(annotation);
                    emitTaskAnnotationEvent(
                        processingTask,
                        annotation,
                        streamIndex,
                    );
                    streamIndex += 1;
                }
            }

            const trailingAnnotations = streamParser.finish();
            for (const annotation of trailingAnnotations) {
                annotations.push(annotation);
                emitTaskAnnotationEvent(
                    processingTask,
                    annotation,
                    streamIndex,
                );
                streamIndex += 1;
            }

            annotations.sort(compareAnnotations);
            const generatedTitle = await generateGradingTitle({
                promptText: processingTask.promptText,
                annotations,
                attachmentFileName: imageAttachments[0]?.file_name || "",
                client: titleClient,
            });

            await withImmediateTransaction(async (txDb) => {
                await txDb.run(
                    `DELETE FROM solochat_grading_annotations
                     WHERE task_id = ?`,
                    Number(taskId),
                );

                for (const annotation of annotations) {
                    await txDb.run(
                        `INSERT INTO solochat_grading_annotations (
                             task_id,
                             file_id,
                             page_index,
                             order_index,
                             bbox_x,
                             bbox_y,
                             bbox_width,
                             bbox_height,
                             recognized_text,
                             recognized_formula,
                             commentary,
                             severity
                         )
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        Number(taskId),
                        annotation.fileId,
                        annotation.pageIndex,
                        annotation.orderIndex,
                        annotation.bbox.x,
                        annotation.bbox.y,
                        annotation.bbox.width,
                        annotation.bbox.height,
                        annotation.recognizedText,
                        annotation.recognizedFormula,
                        annotation.commentary,
                        annotation.severity,
                    );
                }

                await txDb.run(
                    `UPDATE solochat_grading_tasks
                     SET status = 'completed',
                         generated_title = ?,
                         error_message = NULL,
                         completed_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    generatedTitle || null,
                    Number(taskId),
                );

                if (processingRunId) {
                    await txDb.run(
                        `UPDATE solochat_grading_runs
                         SET status = 'completed',
                             error_message = NULL
                         WHERE id = ?`,
                        processingRunId,
                    );
                }
            });

            const completedTask = await getTaskSummaryById(Number(taskId));
            await syncGradingMessageProjection(completedTask);
            await emitTaskStatusEvent(completedTask.id);
        } catch (error) {
            await db.run(
                `UPDATE solochat_grading_tasks
                 SET status = 'failed',
                     error_message = ?,
                     completed_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                truncateErrorMessage(error.message),
                Number(taskId),
            );

            if (processingRunId) {
                await db.run(
                    `UPDATE solochat_grading_runs
                     SET status = 'failed',
                         error_message = ?
                     WHERE id = ?`,
                    truncateErrorMessage(error.message),
                    processingRunId,
                );
            }

            const failedTask = await getTaskSummaryById(Number(taskId));
            await syncGradingMessageProjection(failedTask);
            await emitTaskStatusEvent(failedTask.id);
        }
    }

    async function listTaskSummariesByConversationId(conversationId) {
        const rows = await db.all(
            `SELECT id, conversation_id, user_id, message_id, prompt_text, generated_title, status, error_message, selected_image_count, created_at, started_at, completed_at
             FROM solochat_grading_tasks
             WHERE conversation_id = ?
             ORDER BY created_at DESC, id DESC`,
            conversationId,
        );
        const counts = await getAnnotationCountsByTaskIds(
            rows.map((row) => row.id),
        );

        return rows.map((row) => hydrateTaskSummary(row, counts));
    }

    async function getTaskSummaryById(taskId) {
        return getTaskSummaryByIdWithDb(db, taskId);
    }

    async function getTaskSummaryByIdWithDb(queryDb, taskId) {
        const row = await queryDb.get(
            `SELECT id, conversation_id, user_id, message_id, prompt_text, generated_title, status, error_message, selected_image_count, created_at, started_at, completed_at
             FROM solochat_grading_tasks
             WHERE id = ?`,
            taskId,
        );

        if (!row) {
            return null;
        }

        const annotationCountRow = await queryDb.get(
            `SELECT COUNT(*) AS count
             FROM solochat_grading_annotations
             WHERE task_id = ?`,
            taskId,
        );

        return hydrateTaskSummary(
            row,
            new Map([[row.id, Number(annotationCountRow?.count || 0)]]),
        );
    }

    async function getTaskByIdForUser(taskId, userId) {
        return db.get(
            `SELECT id, conversation_id, user_id, message_id, prompt_text, generated_title, status, error_message, selected_image_count, created_at, started_at, completed_at
             FROM solochat_grading_tasks
             WHERE id = ? AND user_id = ?`,
            taskId,
            userId,
        );
    }

    async function getGradingMessageForTask(taskId) {
        const task = await getTaskSummaryById(taskId);
        if (!task?.messageId) {
            return null;
        }

        return conversationService.getMessageById(Number(task.messageId));
    }

    async function getGradingMessageForTaskForUser({ taskId, userId }) {
        const task = await getTaskByIdForUser(taskId, userId);
        if (!task) {
            throw notFound("Grading task not found");
        }

        if (!task.message_id) {
            throw notFound("Grading message not found");
        }

        return conversationService.getMessageById(task.message_id);
    }

    async function listTaskFiles(taskId) {
        return db.all(
            `SELECT uf.id, uf.owner_user_id, uf.storage_path, uf.file_name, uf.mime_type, uf.size_bytes, uf.width, uf.height, uf.kind, uf.created_at, sgtf.role
             FROM solochat_grading_task_files sgtf
             INNER JOIN uploaded_files uf ON uf.id = sgtf.file_id
             WHERE sgtf.task_id = ?
             ORDER BY CASE sgtf.role WHEN 'image' THEN 0 ELSE 1 END, uf.id ASC`,
            taskId,
        );
    }

    async function listTaskAnnotations(taskId) {
        const rows = await db.all(
            `SELECT id, task_id, file_id, page_index, order_index, bbox_x, bbox_y, bbox_width, bbox_height, recognized_text, recognized_formula, commentary, severity
             FROM solochat_grading_annotations
             WHERE task_id = ?
             ORDER BY file_id ASC, page_index ASC, order_index ASC, id ASC`,
            taskId,
        );

        return rows.map((row) => ({
            id: serializeId(row.id),
            fileId: serializeId(row.file_id),
            pageIndex: row.page_index,
            orderIndex: row.order_index,
            bbox: {
                x: row.bbox_x,
                y: row.bbox_y,
                width: row.bbox_width,
                height: row.bbox_height,
            },
            recognizedText: row.recognized_text,
            recognizedFormula: normalizeFormulaText(row.recognized_formula),
            commentary: normalizeCommentaryText(row.commentary),
            severity: row.severity,
        }));
    }

    async function getAnnotationCountsByTaskIds(taskIds) {
        const normalizedIds = taskIds.filter(Boolean);
        if (!normalizedIds.length) {
            return new Map();
        }

        const placeholders = normalizedIds.map(() => "?").join(", ");
        const rows = await db.all(
            `SELECT task_id, COUNT(*) AS count
             FROM solochat_grading_annotations
             WHERE task_id IN (${placeholders})
             GROUP BY task_id`,
            ...normalizedIds,
        );

        return new Map(
            rows.map((row) => [row.task_id, Number(row.count || 0)]),
        );
    }

    async function syncGradingMessageProjection(task) {
        if (!task?.messageId) {
            return null;
        }

        return conversationService.updateMessage({
            messageId: Number(task.messageId),
            content: buildGradingMessageContent(task),
            status:
                task.status === "completed"
                    ? "completed"
                    : task.status === "failed"
                      ? "failed"
                      : "streaming",
            type: "grading",
        });
    }

    async function emitTaskStatusEvent(taskId) {
        if (!gradingEventsHub) {
            return;
        }

        const gradingMessage = await getGradingMessageForTask(Number(taskId));
        if (!gradingMessage) {
            return;
        }

        gradingEventsHub.emitToTask(String(taskId), {
            type: "grading_status",
            message: sanitizeStreamMessage(gradingMessage),
        });
    }

    function emitTaskAnnotationEvent(task, annotation, streamIndex) {
        if (!task || !gradingEventsHub) {
            return;
        }

        gradingEventsHub.emitToTask(task.id, {
            type: "grading_annotation",
            taskId: task.id,
            messageId: task.messageId,
            conversationId: task.conversationId,
            streamIndex,
            annotation: sanitizeStreamAnnotation(annotation),
        });
    }

    return {
        createTask,
        getGradingMessageForTaskForUser,
        getTaskSummaryForUser,
        getTaskDetailForUser,
        listTasksForConversation,
        retryTask,
    };
}

async function buildGradingMessages({
    promptText,
    imageAttachments,
    contextAttachments,
    attachmentService,
}) {
    const userContent = [];

    if (String(promptText || "").trim()) {
        userContent.push({
            type: "text",
            text: `Question prompt:\n${String(promptText).trim()}`,
        });
    }

    for (const attachment of contextAttachments) {
        const text = await attachmentService.readTextContent(attachment, {
            maxChars: CONTEXT_TEXT_MAX_CHARS,
        });

        if (!text) {
            continue;
        }

        userContent.push({
            type: "text",
            text: `Context file: ${attachment.file_name}\n${text}`,
        });
    }

    imageAttachments.forEach((attachment, index) => {
        userContent.push({
            type: "text",
            text: `Homework image index ${index}: ${attachment.file_name}`,
        });
    });

    for (const attachment of imageAttachments) {
        userContent.push({
            type: "image_url",
            image_url: {
                url: await attachmentService.buildDataUrl(attachment),
            },
        });
    }

    return [
        {
            role: "system",
            content: GRADING_PROMPT,
        },
        {
            role: "user",
            content: userContent,
        },
    ];
}

function parseStreamAnnotationObject(
    objectText,
    fallbackOrderIndex,
    imageAttachments,
) {
    let parsed;

    try {
        parsed = JSON.parse(String(objectText || "").trim());
    } catch (_error) {
        throw badRequest("AI stream emitted an invalid JSON annotation object");
    }

    if (!parsed || parsed.type !== "annotation") {
        throw badRequest("AI stream emitted an invalid annotation event");
    }

    return normalizeAnnotation(parsed, fallbackOrderIndex, imageAttachments);
}

function createStreamAnnotationParser(imageAttachments) {
    let objectBuffer = "";
    let braceDepth = 0;
    let inString = false;
    let isEscaped = false;
    let parsedCount = 0;

    function pushChunk(chunk) {
        const annotations = [];
        const normalizedChunk = String(chunk || "").replace(/\r\n/g, "\n");

        for (const char of normalizedChunk) {
            if (!objectBuffer) {
                if (/\s/.test(char)) {
                    continue;
                }

                if (char !== "{") {
                    throw badRequest(
                        "AI stream emitted invalid content outside annotation objects",
                    );
                }

                objectBuffer = "{";
                braceDepth = 1;
                inString = false;
                isEscaped = false;
                continue;
            }

            objectBuffer += char;

            if (isEscaped) {
                isEscaped = false;
                continue;
            }

            if (char === "\\" && inString) {
                isEscaped = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === "{") {
                braceDepth += 1;
                continue;
            }

            if (char === "}") {
                braceDepth -= 1;

                if (braceDepth < 0) {
                    throw badRequest(
                        "AI stream emitted an invalid annotation object boundary",
                    );
                }

                if (braceDepth === 0) {
                    annotations.push(
                        parseStreamAnnotationObject(
                            objectBuffer,
                            parsedCount,
                            imageAttachments,
                        ),
                    );
                    parsedCount += 1;
                    objectBuffer = "";
                    inString = false;
                    isEscaped = false;
                }
            }
        }

        return annotations;
    }

    function finish() {
        if (objectBuffer.trim()) {
            throw badRequest(
                "AI stream ended before a complete annotation object was received",
            );
        }

        return [];
    }

    return {
        pushChunk,
        finish,
    };
}

function normalizeAnnotation(annotation, fallbackOrderIndex, imageAttachments) {
    if (!annotation || typeof annotation !== "object") {
        throw badRequest("AI annotation item must be an object");
    }

    const fileIndex = Number(annotation.fileIndex);
    if (
        !Number.isInteger(fileIndex) ||
        fileIndex < 0 ||
        fileIndex >= imageAttachments.length
    ) {
        throw badRequest("AI annotation contains an invalid fileIndex");
    }

    const pageIndex = Number(annotation.pageIndex ?? 0);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw badRequest("AI annotation contains an invalid pageIndex");
    }

    const orderIndex = Number(annotation.orderIndex ?? fallbackOrderIndex);
    if (!Number.isInteger(orderIndex) || orderIndex < 0) {
        throw badRequest("AI annotation contains an invalid orderIndex");
    }

    const bbox = normalizeBbox(annotation.bbox);
    const severity = String(annotation.severity || "")
        .trim()
        .toLowerCase();

    if (!ALLOWED_SEVERITIES.has(severity)) {
        throw badRequest("AI annotation severity is invalid");
    }

    return {
        fileId: imageAttachments[fileIndex].id,
        pageIndex,
        orderIndex,
        bbox,
        recognizedText: String(annotation.recognizedText || "").trim(),
        recognizedFormula: normalizeFormulaText(annotation.recognizedFormula),
        commentary: normalizeCommentaryText(annotation.commentary),
        severity,
    };
}

function normalizeBbox(bbox) {
    if (!bbox || typeof bbox !== "object") {
        throw badRequest("AI annotation bbox is required");
    }

    const x = Number(bbox.x);
    const y = Number(bbox.y);
    const width = Number(bbox.width);
    const height = Number(bbox.height);
    const values = [x, y, width, height];

    if (values.some((value) => !Number.isFinite(value))) {
        throw badRequest("AI annotation bbox must contain numeric values");
    }

    if (width <= 0 || height <= 0) {
        throw badRequest("AI annotation bbox must have positive width and height");
    }

    const normalizedX = clamp(x, 0, 1 - MIN_BBOX_SIZE);
    const normalizedY = clamp(y, 0, 1 - MIN_BBOX_SIZE);
    const normalizedWidth = Math.min(
        clamp(width, MIN_BBOX_SIZE, 1),
        1 - normalizedX,
    );
    const normalizedHeight = Math.min(
        clamp(height, MIN_BBOX_SIZE, 1),
        1 - normalizedY,
    );

    return {
        x: normalizedX,
        y: normalizedY,
        width: normalizedWidth,
        height: normalizedHeight,
    };
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function compareAnnotations(left, right) {
    const fileDiff = Number(left.fileId) - Number(right.fileId);
    if (fileDiff !== 0) {
        return fileDiff;
    }

    const pageDiff = left.pageIndex - right.pageIndex;
    if (pageDiff !== 0) {
        return pageDiff;
    }

    const orderDiff = left.orderIndex - right.orderIndex;
    if (orderDiff !== 0) {
        return orderDiff;
    }

    return 0;
}

function sanitizeStreamAnnotation(annotation) {
    return {
        fileId: serializeId(annotation.fileId),
        pageIndex: annotation.pageIndex,
        orderIndex: annotation.orderIndex,
        bbox: annotation.bbox,
        recognizedText: annotation.recognizedText,
        recognizedFormula: annotation.recognizedFormula,
        commentary: annotation.commentary,
        severity: annotation.severity,
    };
}

function hydrateTaskSummary(row, annotationCounts) {
    return {
        id: serializeId(row.id),
        conversationId: serializeId(row.conversation_id),
        userId: serializeId(row.user_id),
        messageId: serializeId(row.message_id),
        promptText: row.prompt_text || "",
        generatedTitle: row.generated_title || null,
        status: row.status,
        errorMessage: row.error_message,
        selectedImageCount: Number(row.selected_image_count || 0),
        annotationCount: Number(annotationCounts.get(row.id) || 0),
        createdAt: toIsoTimestamp(row.created_at),
        startedAt: toIsoTimestamp(row.started_at),
        completedAt: toIsoTimestamp(row.completed_at),
    };
}

function sanitizeTaskAttachment(attachment) {
    return {
        id: serializeId(attachment.id),
        role: attachment.role,
        kind: attachment.kind,
        fileName: attachment.file_name,
        url: buildSoloChatAttachmentUrl(serializeId(attachment.id)),
        mimeType: attachment.mime_type,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        sizeBytes: attachment.size_bytes,
        createdAt: toIsoTimestamp(attachment.created_at),
    };
}

function buildGradingMessageContent(task) {
    if (!task) {
        return "Grading homework...";
    }

    if (task.status === "completed") {
        return task.generatedTitle
            ? `Grading completed - ${task.generatedTitle}`
            : "Grading completed";
    }

    if (task.status === "failed") {
        const errorMessage = String(task.errorMessage || "").trim();
        return errorMessage
            ? `Grading failed - ${errorMessage}`
            : "Grading failed";
    }

    return "Grading homework...";
}

function sanitizeStreamMessage(message) {
    return {
        id: serializeId(message.id),
        conversationId: serializeId(message.conversation_id),
        role: message.role,
        type: message.type || "text",
        content: normalizeRenderableMessageContent(message.content),
        status: message.status,
        attachments: Array.isArray(message.attachments)
            ? message.attachments.map((attachment) => ({
                  id: serializeId(attachment.id),
                  kind: attachment.kind === "image" ? "image" : "text",
                  fileName: attachment.file_name,
                  url: buildSoloChatAttachmentUrl(serializeId(attachment.id)),
                  mimeType: attachment.mime_type,
                  width: attachment.width ?? null,
                  height: attachment.height ?? null,
                  sizeBytes: attachment.size_bytes,
                  createdAt: toIsoTimestamp(attachment.created_at),
              }))
            : [],
        createdAt: toIsoTimestamp(message.created_at),
        updatedAt: toIsoTimestamp(message.updated_at),
        grading: message.grading
            ? {
                  taskId: serializeId(message.grading.taskId),
                  generatedTitle: message.grading.generatedTitle || null,
                  status: message.grading.status,
                  errorMessage: message.grading.errorMessage,
                  selectedImageCount: message.grading.selectedImageCount,
                  annotationCount: message.grading.annotationCount,
              }
            : null,
    };
}

function truncateErrorMessage(value) {
    return String(value || "Grading task failed").slice(0, 500);
}

module.exports = {
    createSoloChatGradingService,
    sanitizeTaskAttachment,
};

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
                    "Failed to delete grading attachment",
                    file.storage_path,
                    error,
                );
            }
        }
    }
}
