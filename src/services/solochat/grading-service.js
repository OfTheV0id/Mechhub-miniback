const fs = require("node:fs/promises");
const { withImmediateTransaction } = require("../../lib/db");
const { toIsoTimestamp } = require("../../lib/time");
const { createFileService } = require("../uploads/file-service");
const { createSoloChatConversationService } = require("./conversation-service");
const { createOpenAiCompatibleClient } = require("./openai-client");
const {
    createChatClient,
    createGradingClient,
} = require("./ai-client-factory");
const { createDashScopeOcrClient } = require("./dashscope-ocr-client");
const { createMathpixOcrClient } = require("./mathpix-ocr-client");
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
const OCR_BLOCK_TEXT_MAX_CHARS = 220;
const OCR_BLOCKS_PER_IMAGE_MAX = 120;
const ALLOWED_SEVERITIES = new Set(["correct", "warning", "error", "note"]);
const DEFAULT_GRADING_MAX_TOKENS = 4000;
const DEFAULT_GEMINI_GRADING_MAX_TOKENS = 12000;
const GEMINI_GRADING_RESPONSE_SCHEMA = {
    type: "ARRAY",
    items: {
        type: "OBJECT",
        properties: {
            type: { type: "STRING" },
            fileIndex: { type: "INTEGER" },
            pageIndex: { type: "INTEGER" },
            orderIndex: { type: "INTEGER" },
            ocrBlockIds: {
                type: "ARRAY",
                items: { type: "STRING" },
            },
            recognizedText: { type: "STRING" },
            recognizedFormula: { type: "STRING" },
            commentary: { type: "STRING" },
            severity: {
                type: "STRING",
                enum: ["correct", "warning", "error", "note"],
            },
        },
        required: [
            "type",
            "fileIndex",
            "pageIndex",
            "orderIndex",
            "ocrBlockIds",
            "recognizedText",
            "recognizedFormula",
            "commentary",
            "severity",
        ],
    },
};
const LEGACY_GRADING_PROMPT = `
你是一名正在批改学生主观题作业的老师。
只输出 JSON 对象流，不要包含 markdown 代码块或任何其他文字。
你可能收到可选的题目文本、可选的参考文档，以及一张或多张作业图片。
所有说明性内容必须使用简体中文书写。
commentary 字段必须使用简体中文。
不要输出英文注释或英文解释。
recognizedFormula 字段必须使用 KaTeX/LaTeX 语法。
禁止在 recognizedFormula 中使用 Unicode 数学符号（如 ⇒ → − ≤ ≥ ≠ × ·），应使用 LaTeX 命令（如 \\Rightarrow \\to - \\le \\ge \\ne \\times \\cdot）。
commentary 中如果包含数学表达式，同样使用 KaTeX/LaTeX 语法，避免 Unicode 数学符号。
必须逐一检查每张上传的图片。
对所有图片进行全面分析，返回所有应该标注的问题，不要在找到第一个有用标注后停止。
每次输出一个标注对象。
每个 JSON 对象可以包含空格和换行，但只输出完整的 JSON 对象，不输出其他内容。
不要将标注包裹在数组中。
每个标注对象必须包含以下字段：
- type: "annotation"
- fileIndex: 从 0 开始的图片列表索引
- pageIndex: 整数，单张图片始终为 0
- orderIndex: 该图片内的标注顺序（从 0 开始）
- sourceText: 该标注区域内图片中实际出现的原始文字，用于精确定位；应尽量精确，优先使用该行/区域中最有特征性的文字或公式片段；无法识别时为空字符串
- recognizedText: 该区域的原文转录（字符串，无法识别时为空字符串）
- recognizedFormula: 该区域包含的数学公式（KaTeX/LaTeX 格式，无公式时为空字符串）
- commentary: 对该处问题的简体中文说明
- severity: 以下之一：correct、warning、error、note
若某张图片无需标注，则跳过该图片。
若所有图片均无有效标注，则不输出任何内容。
`.trim();

const OCR_PROMPT = `Read all text in the image. Output one text block per line using this exact CSV format: x,y,height,width,angle,text. Use pixel coordinates from the original image. Do not output markdown or explanations.`;
const GRADING_BLOCK_PROMPT = `
你是一名正在批改学生主观题作业的老师。
你会收到题目/参考资料、作业图片，以及每张图片的 OCR 文本块列表。
OCR 文本块已经包含稳定的 block id 和位置。你只负责判断哪些 OCR 文本块应该被批注，不要自己编写坐标。

输出规则：
- 只输出 JSON 对象流，不要输出 markdown、数组、解释文字或额外前后缀。
- 第一个可见字符必须是 {，禁止输出 markdown 代码块围栏。
- 每次输出一个完整 JSON 对象；多个标注就连续输出多个 JSON 对象。
- JSON 对象只能包含下方列出的字段，不要复制 OCR_BLOCKS，不要添加 blocks、bbox、analysis、reasoning 等额外字段。
- 所有说明性内容必须使用简体中文。
- commentary 必须使用简体中文。
- recognizedFormula 必须使用 KaTeX/LaTeX 语法。
- 禁止在 recognizedFormula 中使用 Unicode 数学符号（如 ⇒ → − ≤ ≥ ≠ × ·），应使用 LaTeX 命令（如 \\Rightarrow \\to - \\le \\ge \\ne \\times \\cdot）。
- commentary 中如果包含数学表达式，同样使用 KaTeX/LaTeX 语法，避免 Unicode 数学符号。
- 必须逐一检查每张上传图片，返回所有应该标注的问题，不要在找到第一个问题后停止。
- 如果某张图片无需标注，跳过该图片；如果所有图片都无需标注，不输出任何内容。

定位规则：
- ocrBlockIds 必须从用户提供的 OCR_BLOCKS 中选择，不能编造 id。
- ocrBlockIds 只放 id 字符串，例如 ["img0_block3"]。
- ocrBlockIds 应选择最能覆盖该批注区域的一个或多个 OCR block。
- 如果一个错误跨越多行或多个公式块，返回多个 ocrBlockIds。
- 不要输出 bbox 坐标；后端会根据 ocrBlockIds 合并 bbox。
- 不要依赖 OCR 文本完全正确。请同时看图片和 OCR 文本，判断哪个 block 最接近你要批注的位置。

每个标注对象必须包含：
- type: "annotation"
- fileIndex: 从 0 开始的图片列表索引
- pageIndex: 整数，单张图片始终为 0
- orderIndex: 该图片内的标注顺序（从 0 开始）
- ocrBlockIds: 字符串数组，来自 OCR_BLOCKS 的 id
- recognizedText: 该区域的原文转录；优先使用 OCR 文本，必要时根据图片修正
- recognizedFormula: 该区域包含的数学公式；无公式时为空字符串
- commentary: 对该处问题的简体中文说明
- severity: 以下之一：correct、warning、error、note
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

function normalizeOcrProvider(value) {
    const normalized = String(value || "openai")
        .trim()
        .toLowerCase();

    if (normalized === "dashscope" || normalized === "qwen") {
        return "dashscope";
    }

    if (normalized === "mathpix") {
        return "mathpix";
    }

    return "openai";
}

function createOcrClient(provider) {
    if (provider === "dashscope") {
        return createDashScopeOcrClient();
    }

    if (provider === "mathpix") {
        return createMathpixOcrClient();
    }

    return createOpenAiCompatibleClient({
        defaultModel: process.env.OPENAI_OCR_MODEL || "qwen-vl-ocr",
    });
}

function resolveGradingMaxTokens(useGeminiJsonMode) {
    const specificValue = useGeminiJsonMode
        ? process.env.GEMINI_GRADING_MAX_TOKENS
        : process.env.OPENAI_GRADING_MAX_TOKENS;
    const fallbackValue = process.env.GRADING_MAX_TOKENS;
    const defaultValue = useGeminiJsonMode
        ? DEFAULT_GEMINI_GRADING_MAX_TOKENS
        : DEFAULT_GRADING_MAX_TOKENS;

    return parsePositiveInteger(specificValue || fallbackValue, defaultValue);
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.trunc(parsed);
}

function createSoloChatGradingService(options = {}) {
    const db = options.db;
    const gradingEventsHub = options.gradingEventsHub;
    const gradingClient = options.client || createGradingClient();
    const ocrProvider = normalizeOcrProvider(
        options.ocrProvider || process.env.OCR_PROVIDER,
    );
    const ocrClient = options.ocrClient || createOcrClient(ocrProvider);
    const titleClient = options.titleClient || createChatClient();
    const fileService = options.fileService || createFileService(db);
    const conversationService =
        options.conversationService || createSoloChatConversationService(db);

    const runningTasks = new Map();

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
        const controller = new AbortController();
        runningTasks.set(Number(taskId), controller);

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

            // Step 1: run OCR first so the grading model can select block ids.
            const ocrBlocksByFileIndex = await loadOcrBlocksForImages({
                ocrClient,
                imageAttachments,
                attachmentService: fileService,
                signal: controller.signal,
            });
            const ocrBlockById = buildOcrBlockLookup(ocrBlocksByFileIndex);

            // Step 2: stream grading analysis. Each annotation already carries
            // OCR block ids, so bbox resolution is a deterministic merge.
            const annotations = [];
            const streamParser = createStreamAnnotationParser(
                imageAttachments,
                ocrBlockById,
            );
            const useGeminiJsonMode = gradingClient.provider === "gemini";
            const gradingMessages = await buildGradingMessages({
                promptText: processingTask.promptText,
                imageAttachments,
                contextAttachments,
                attachmentService: fileService,
                ocrBlocksByFileIndex,
                jsonArrayMode: useGeminiJsonMode,
            });
            const gradingMaxTokens = resolveGradingMaxTokens(useGeminiJsonMode);
            let streamIndex = 0;

            const queueAnnotationEvent = (annotation) => {
                annotations.push(annotation);
                const currentStreamIndex = streamIndex;
                streamIndex += 1;
                if (!controller.signal.aborted) {
                    emitTaskAnnotationEvent(
                        processingTask,
                        annotation,
                        currentStreamIndex,
                    );
                }
            };

            for await (const delta of gradingClient.streamChatCompletion({
                messages: gradingMessages,
                temperature: useGeminiJsonMode ? 0 : 0.1,
                maxTokens: gradingMaxTokens,
                ...(useGeminiJsonMode
                    ? {
                          responseMimeType: "application/json",
                          responseSchema: GEMINI_GRADING_RESPONSE_SCHEMA,
                      }
                    : {}),
                signal: controller.signal,
            })) {
                for (const annotation of streamParser.pushChunk(delta)) {
                    queueAnnotationEvent(annotation);
                }
            }
            for (const annotation of streamParser.finish()) {
                queueAnnotationEvent(annotation);
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
            if (!completedTask) {
                return;
            }
            await syncGradingMessageProjection(completedTask);
            await emitTaskStatusEvent(completedTask.id);
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }

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
            if (!failedTask) {
                return;
            }
            await syncGradingMessageProjection(failedTask);
            await emitTaskStatusEvent(failedTask.id);
        } finally {
            runningTasks.delete(Number(taskId));
        }
    }

    async function abortTasksForConversation(conversationId) {
        const rows = await db.all(
            `SELECT id FROM solochat_grading_tasks
             WHERE conversation_id = ?
               AND status IN ('pending', 'processing')`,
            conversationId,
        );
        for (const row of rows) {
            const controller = runningTasks.get(Number(row.id));
            if (controller) {
                controller.abort();
                runningTasks.delete(Number(row.id));
            }
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
        abortTasksForConversation,
    };
}

async function buildGradingMessages({
    promptText,
    imageAttachments,
    contextAttachments,
    attachmentService,
    ocrBlocksByFileIndex = new Map(),
    jsonArrayMode = false,
}) {
    const userContent = [];

    if (jsonArrayMode) {
        userContent.push({
            type: "text",
            text:
                "Output mode override: return exactly one JSON array. Each array item must be one annotation object with the required fields. Do not output markdown, comments, tables, or text outside the JSON array. If there are no annotations, return [].",
        });
    }

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
        userContent.push({
            type: "text",
            text: formatOcrBlocksForPrompt(
                index,
                ocrBlocksByFileIndex.get(index) || [],
            ),
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
            content: GRADING_BLOCK_PROMPT,
        },
        {
            role: "user",
            content: userContent,
        },
    ];
}

function formatOcrBlocksForPrompt(fileIndex, blocks) {
    const items = (Array.isArray(blocks) ? blocks : [])
        .slice(0, OCR_BLOCKS_PER_IMAGE_MAX)
        .map((block) => ({
            id: block.id,
            text: truncateText(block.text, OCR_BLOCK_TEXT_MAX_CHARS),
            bbox: roundBbox(block.bbox),
        }));

    return `OCR_BLOCKS for image ${fileIndex}:\n${JSON.stringify(items)}`;
}

function roundBbox(bbox) {
    if (!bbox) {
        return null;
    }

    return {
        x: roundNumber(bbox.x),
        y: roundNumber(bbox.y),
        width: roundNumber(bbox.width),
        height: roundNumber(bbox.height),
    };
}

function roundNumber(value) {
    return Math.round(Number(value || 0) * 10000) / 10000;
}

function truncateText(value, limit) {
    const text = String(value || "");
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function parseStreamAnnotationObject(
    objectText,
    fallbackOrderIndex,
    imageAttachments,
    ocrBlockById,
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

    return normalizeAnnotation(
        parsed,
        fallbackOrderIndex,
        imageAttachments,
        ocrBlockById,
    );
}

function createStreamAnnotationParser(imageAttachments, ocrBlockById) {
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
                    continue;
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
                            ocrBlockById,
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

function normalizeAnnotation(
    annotation,
    fallbackOrderIndex,
    imageAttachments,
    ocrBlockById,
) {
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

    const severity = String(annotation.severity || "")
        .trim()
        .toLowerCase();

    if (!ALLOWED_SEVERITIES.has(severity)) {
        throw badRequest("AI annotation severity is invalid");
    }

    const ocrBlockIds = normalizeOcrBlockIds(annotation.ocrBlockIds);
    const selectedBlocks = ocrBlockIds
        .map((blockId) => ocrBlockById.get(blockId))
        .filter((block) => block && block.fileIndex === fileIndex);
    const bbox = mergeOcrBlockBboxes(selectedBlocks) ||
        buildFallbackBbox(orderIndex);
    const recognizedText = String(annotation.recognizedText || "").trim() ||
        selectedBlocks.map((block) => block.text).join("\n");

    return {
        fileIndex,
        fileId: imageAttachments[fileIndex].id,
        pageIndex,
        orderIndex,
        bbox,
        ocrBlockIds: selectedBlocks.map((block) => block.id),
        sourceText: String(annotation.sourceText || "").trim(),
        recognizedText,
        recognizedFormula: normalizeFormulaText(annotation.recognizedFormula),
        commentary: normalizeCommentaryText(annotation.commentary),
        severity,
    };
}

function normalizeOcrBlockIds(value) {
    const rawIds = Array.isArray(value)
        ? value
        : value === undefined || value === null
          ? []
          : [value];
    return [...new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean))];
}

function mergeOcrBlockBboxes(blocks) {
    const validBlocks = (Array.isArray(blocks) ? blocks : [])
        .map((block) => block?.bbox)
        .filter(Boolean);
    if (!validBlocks.length) {
        return null;
    }

    const minX = Math.min(...validBlocks.map((bbox) => bbox.x));
    const minY = Math.min(...validBlocks.map((bbox) => bbox.y));
    const maxX = Math.max(...validBlocks.map((bbox) => bbox.x + bbox.width));
    const maxY = Math.max(...validBlocks.map((bbox) => bbox.y + bbox.height));
    return {
        x: clamp(minX, 0, 1 - MIN_BBOX_SIZE),
        y: clamp(minY, 0, 1 - MIN_BBOX_SIZE),
        width: clamp(maxX - minX, MIN_BBOX_SIZE, 1 - minX),
        height: clamp(maxY - minY, MIN_BBOX_SIZE, 1 - minY),
    };
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// OCR matching — Step 2 of the two-step grading pipeline
// ---------------------------------------------------------------------------

const OCR_BBOX_PADDING_X = 0.008;
const OCR_BBOX_PADDING_Y = 0.012;
const OCR_BBOX_MIN_HEIGHT = 0.04;

async function loadOcrBlocksForImages({
    ocrClient,
    imageAttachments,
    attachmentService,
    signal,
}) {
    const entries = await Promise.all(
        imageAttachments.map(async (attachment, fileIndex) => {
            const blocks = await loadOcrBlocksForImage(
                ocrClient,
                attachment,
                attachmentService,
                signal,
            );
            return [
                fileIndex,
                blocks.map((block, blockIndex) => ({
                    ...block,
                    id: `img${fileIndex}_block${blockIndex}`,
                    fileIndex,
                    blockIndex,
                })),
            ];
        }),
    );

    return new Map(entries);
}

function buildOcrBlockLookup(ocrBlocksByFileIndex) {
    const lookup = new Map();
    for (const blocks of ocrBlocksByFileIndex.values()) {
        for (const block of blocks) {
            lookup.set(block.id, block);
        }
    }
    return lookup;
}

async function loadOcrBlocksForImage(
    ocrClient,
    imageAttachment,
    attachmentService,
    signal,
) {
    const imgW = Number(imageAttachment.width) || 0;
    const imgH = Number(imageAttachment.height) || 0;
    if (imgW <= 0 || imgH <= 0) return [];

    let ocrBlocks;
    try {
        const imageDataUrl =
            await attachmentService.buildDataUrl(imageAttachment);
        if (typeof ocrClient.recognizeImage === "function") {
            ocrBlocks = await ocrClient.recognizeImage({
                imageDataUrl,
                signal,
            });
        } else {
            const responseText = await ocrClient.createChatCompletion({
                messages: [{
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: imageDataUrl } },
                        { type: "text", text: OCR_PROMPT },
                    ],
                }],
                temperature: 0,
                signal,
            });
            ocrBlocks = parseOcrResponse(responseText, imgW, imgH);
        }
    } catch (error) {
        if (!signal?.aborted) {
            console.warn(
                "Failed to run grading OCR matching",
                imageAttachment.id,
                error,
            );
        }
        return [];
    }

    return normalizeOcrBlocksForMatching(ocrBlocks, imgW, imgH);
}

// Parse the CSV-per-line OCR response: "x1,y1,h,w,angle,text..."
// qwen-vl-ocr returns angle=90 for normal horizontal text (h and w are swapped
// relative to the visual box), and angle=0 for vertically-oriented blocks.
function parseOcrResponse(text, imgW, imgH) {
    const blocks = [];
    for (const line of String(text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Split on first 5 commas only; the rest is the text content
        const parts = trimmed.split(",");
        if (parts.length < 6) continue;
        const x1 = Number(parts[0]);
        const y1 = Number(parts[1]);
        const v3 = Number(parts[2]);
        const v4 = Number(parts[3]);
        const angle = Number(parts[4]);
        const blockText = parts.slice(5).join(",").trim();
        if (!blockText || [x1, y1, v3, v4].some((n) => !Number.isFinite(n))) {
            continue;
        }
        // angle=90: v3=height, v4=width. angle=0: v3=width, v4=height.
        const w = angle === 90 ? v4 : v3;
        const h = angle === 90 ? v3 : v4;
        if (w <= 0 || h <= 0) continue;

        const x = clamp(x1 / imgW, 0, 1 - MIN_BBOX_SIZE);
        const y = clamp(y1 / imgH, 0, 1 - MIN_BBOX_SIZE);
        const paddedX = clamp(x - OCR_BBOX_PADDING_X, 0, 1 - MIN_BBOX_SIZE);
        const paddedY = clamp(y - OCR_BBOX_PADDING_Y, 0, 1 - MIN_BBOX_SIZE);
        const paddedW = clamp(w / imgW + OCR_BBOX_PADDING_X * 2, MIN_BBOX_SIZE, 1 - paddedX);
        const paddedH = clamp(
            Math.max(h / imgH + OCR_BBOX_PADDING_Y * 2, OCR_BBOX_MIN_HEIGHT),
            MIN_BBOX_SIZE,
            1 - paddedY,
        );

        blocks.push({
            text: blockText,
            normalizedText: normalizeForOcrMatch(blockText),
            bbox: { x: paddedX, y: paddedY, width: paddedW, height: paddedH },
        });
    }
    return blocks;
}

function normalizeOcrBlocksForMatching(blocks, imgW, imgH) {
    return (Array.isArray(blocks) ? blocks : [])
        .map((block) => {
            const text = String(block?.text || "").trim();
            const bbox = normalizeOcrBbox(
                block?.bbox,
                block?.bboxPixels,
                imgW,
                imgH,
            );
            if (!text || !bbox) {
                return null;
            }

            return {
                ...block,
                text,
                normalizedText: normalizeForOcrMatch(text),
                bbox,
            };
        })
        .filter(Boolean);
}

function normalizeOcrBbox(bbox, bboxPixels, imgW, imgH) {
    const normalizedBbox =
        bbox ||
        (bboxPixels && imgW > 0 && imgH > 0
            ? {
                  x: Number(bboxPixels.x) / imgW,
                  y: Number(bboxPixels.y) / imgH,
                  width: Number(bboxPixels.width) / imgW,
                  height: Number(bboxPixels.height) / imgH,
              }
            : null);
    const x = Number(normalizedBbox?.x);
    const y = Number(normalizedBbox?.y);
    const width = Number(normalizedBbox?.width);
    const height = Number(normalizedBbox?.height);
    if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
    ) {
        return null;
    }

    const clampedX = clamp(x, 0, 1 - MIN_BBOX_SIZE);
    const clampedY = clamp(y, 0, 1 - MIN_BBOX_SIZE);
    return {
        x: clampedX,
        y: clampedY,
        width: clamp(width, MIN_BBOX_SIZE, 1 - clampedX),
        height: clamp(height, MIN_BBOX_SIZE, 1 - clampedY),
    };
}

function findBestOcrMatch(query, ocrBlocks) {
    const normalizedQuery = normalizeForOcrMatch(query);
    if (!normalizedQuery) return null;

    let bestBbox = null;
    let bestScore = 0;

    for (const block of ocrBlocks) {
        const score = textOverlapScore(normalizedQuery, block.normalizedText);
        if (score > bestScore) {
            bestScore = score;
            bestBbox = block.bbox;
        }
    }

    // Require at least 30% character overlap to accept the match
    return bestScore >= 0.3 ? bestBbox : null;
}

// Strip LaTeX/markup noise, normalize whitespace for comparison
function normalizeForOcrMatch(value) {
    return String(value || "")
        .replace(/\$|\\\(|\\\)|\\\[|\\\]|\\[a-zA-Z]+\{?/g, " ")
        .replace(/[{}_^\\]/g, " ")
        .replace(/\s+/g, "")
        .toLowerCase();
}

// Character-level overlap: |intersection| / |union| (Jaccard on char bags)
function textOverlapScore(a, b) {
    if (!a || !b) return 0;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    let matched = 0;
    let searchFrom = 0;
    for (const ch of shorter) {
        const idx = longer.indexOf(ch, searchFrom);
        if (idx !== -1) {
            matched++;
            searchFrom = idx + 1;
        }
    }
    return matched / Math.max(a.length, b.length);
}

function buildFallbackBbox(orderIndex) {
    const y = clamp((Number(orderIndex) || 0) * 0.08, 0, 0.9);
    return { x: 0.05, y, width: 0.9, height: 0.06 };
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
