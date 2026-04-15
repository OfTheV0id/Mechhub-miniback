const { createOpenAiCompatibleClient } = require("../solochat/openai-client");

const REFERENCE_TEXT_MAX_CHARS = 8_000;
const ANSWER_TEXT_MAX_CHARS = 16_000;
const SOLOCHAT_SNAPSHOT_MAX_CHARS = 24_000;

const ASSIGNMENT_EVALUATION_PROMPT = `
你是一个严谨、克制的课程作业学习质量评估助手。
你正在评估的是学生的学习过程与作业提交质量，而不是做逐点批注。

你的评分标准固定如下：
- 过程表现 60 分：思路推进、提问质量、修正迭代、学习投入、表达完整度、是否体现主动理解
- 正确性 40 分：最终答案、方法、论证、结论是否正确，以及是否与提交证据一致

评估要求：
- 所有输出必须使用简体中文
- 只能依据提供的作业说明、教师参考材料、学生额外文字、学生上传图片、以及可选的 SoloChat 快照来评估
- 如果证据不足，必须明确指出证据不足，不得臆造过程
- 如果学生过程很好但最终结果不完全正确，可以给出较高过程分和较低正确性分
- 如果学生结果看似正确但过程证据明显不足，必须下调过程分
- 允许肯定优点，也要明确指出关键问题和改进建议
- 不要输出 JSON，不要输出代码块，不要输出多余前言

请输出一份 Markdown 评语，并严格以以下三行结束：
过程得分：<整数>/60
正确性得分：<整数>/40
总评分：<整数>/100

其中总评分必须等于前两项之和，三个分数都必须是整数。
`.trim();

function upstreamError(message) {
    const error = new Error(message);
    error.statusCode = 502;
    error.expose = true;
    return error;
}

function createAssignmentEvaluator(options = {}) {
    const fileService = options.fileService;
    const client =
        options.client ||
        createOpenAiCompatibleClient({
            defaultModel:
                process.env.OPENAI_GRADING_MODEL || process.env.OPENAI_MODEL,
        });

    async function evaluateSubmissionStream({
        assignment,
        referenceFiles = [],
        submission,
        submissionFiles = [],
        signal,
        onDelta,
    }) {
        const messages = await buildEvaluationMessages({
            assignment,
            referenceFiles,
            submission,
            submissionFiles,
            fileService,
        });
        let feedbackMarkdown = "";

        for await (const delta of client.streamChatCompletion({
            messages,
            temperature: 0.2,
            maxTokens: 4000,
            signal,
        })) {
            feedbackMarkdown += delta;
            onDelta?.(delta);
        }

        const parsed = parseEvaluationScores(feedbackMarkdown);

        return {
            score: parsed.totalScore,
            feedbackMarkdown: feedbackMarkdown.trim(),
            feedbackJson: {
                processScore: parsed.processScore,
                correctnessScore: parsed.correctnessScore,
                totalScore: parsed.totalScore,
                rubric: {
                    processMax: 60,
                    correctnessMax: 40,
                    totalMax: 100,
                },
            },
        };
    }

    return {
        evaluateSubmissionStream,
    };
}

async function buildEvaluationMessages({
    assignment,
    referenceFiles,
    submission,
    submissionFiles,
    fileService,
}) {
    const userContent = [];
    const assignmentTitle = String(assignment?.title || "").trim();
    const assignmentDescription = String(assignment?.description || "").trim();
    const answerText = String(submission?.answerText || "").trim();
    const solochatSnapshotText = formatSoloChatSnapshot(
        submission?.solochatSnapshotJson,
    );

    userContent.push({
        type: "text",
        text: [
            "以下是本次作业的基础信息。",
            `作业标题：${assignmentTitle || "未命名作业"}`,
            `作业说明：${assignmentDescription || "未提供额外说明"}`,
        ].join("\n"),
    });

    if (referenceFiles.length) {
        userContent.push({
            type: "text",
            text: `教师参考附件数量：${referenceFiles.length}`,
        });
    } else {
        userContent.push({
            type: "text",
            text: "教师未提供参考附件。",
        });
    }

    for (const referenceFile of referenceFiles) {
        if (referenceFile.kind === "text") {
            const textContent = await fileService.readTextContent(referenceFile, {
                maxChars: REFERENCE_TEXT_MAX_CHARS,
            });

            if (!textContent) {
                continue;
            }

            userContent.push({
                type: "text",
                text: [
                    `教师参考文本附件：${referenceFile.file_name}`,
                    trimByChars(textContent, REFERENCE_TEXT_MAX_CHARS),
                ].join("\n"),
            });
            continue;
        }

        userContent.push({
            type: "text",
            text: `教师参考图片：${referenceFile.file_name}`,
        });
        userContent.push({
            type: "image_url",
            image_url: {
                url: await fileService.buildDataUrl(referenceFile),
            },
        });
    }

    userContent.push({
        type: "text",
        text: [
            "学生补充文字：",
            answerText ? trimByChars(answerText, ANSWER_TEXT_MAX_CHARS) : "未提交额外文字。",
        ].join("\n"),
    });

    if (submissionFiles.length) {
        userContent.push({
            type: "text",
            text: `学生提交图片数量：${submissionFiles.length}`,
        });
    } else {
        userContent.push({
            type: "text",
            text: "学生未上传额外图片。",
        });
    }

    submissionFiles.forEach((file, index) => {
        userContent.push({
            type: "text",
            text: `学生提交图片 ${index + 1}：${file.file_name}`,
        });
    });

    for (const submissionFile of submissionFiles) {
        userContent.push({
            type: "image_url",
            image_url: {
                url: await fileService.buildDataUrl(submissionFile),
            },
        });
    }

    userContent.push({
        type: "text",
        text: [
            "SoloChat 学习过程快照：",
            solochatSnapshotText || "未提供 SoloChat 快照，请明确说明过程证据有限。",
        ].join("\n"),
    });

    return [
        {
            role: "system",
            content: ASSIGNMENT_EVALUATION_PROMPT,
        },
        {
            role: "user",
            content: userContent,
        },
    ];
}

function parseEvaluationScores(markdown) {
    const normalized = String(markdown || "").trim();
    const processMatch = normalized.match(/过程得分[：:]\s*(\d{1,3})\s*\/\s*60/i);
    const correctnessMatch = normalized.match(
        /正确性得分[：:]\s*(\d{1,3})\s*\/\s*40/i,
    );
    const totalMatch = normalized.match(/总评分[：:]\s*(\d{1,3})\s*\/\s*100/i);

    if (!processMatch || !correctnessMatch || !totalMatch) {
        throw upstreamError("AI evaluation did not include the required score lines");
    }

    const processScore = clampInteger(processMatch[1], 0, 60);
    const correctnessScore = clampInteger(correctnessMatch[1], 0, 40);
    const totalScore = clampInteger(totalMatch[1], 0, 100);

    if (processScore + correctnessScore !== totalScore) {
        throw upstreamError("AI evaluation score lines are inconsistent");
    }

    return {
        processScore,
        correctnessScore,
        totalScore,
    };
}

function formatSoloChatSnapshot(snapshotValue) {
    if (!snapshotValue) {
        return "";
    }

    let snapshot = snapshotValue;

    if (typeof snapshotValue === "string") {
        try {
            snapshot = JSON.parse(snapshotValue);
        } catch (_error) {
            return trimByChars(snapshotValue, SOLOCHAT_SNAPSHOT_MAX_CHARS);
        }
    }

    if (!snapshot || typeof snapshot !== "object") {
        return "";
    }

    const lines = [];
    lines.push(`会话标题：${snapshot.title || "未命名会话"}`);
    lines.push(`快照时间：${snapshot.capturedAt || "未知"}`);
    lines.push(`消息数：${Number(snapshot.messageCount || 0)}`);

    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    for (const message of messages) {
        lines.push("");
        lines.push(
            `[${message.role || "unknown"}|${message.type || "text"}] ${String(
                message.content || "",
            ).trim() || "(空内容)"}`,
        );

        const attachments = Array.isArray(message.attachments)
            ? message.attachments
            : [];
        for (const attachment of attachments) {
            if (attachment.kind === "text") {
                lines.push(
                    `附件(text): ${attachment.fileName || "unnamed"}${
                        attachment.textPreview
                            ? `\n${String(attachment.textPreview).trim()}`
                            : ""
                    }`,
                );
            } else {
                lines.push(
                    `附件(image): ${attachment.fileName || "unnamed"}`,
                );
            }
        }
    }

    return trimByChars(lines.join("\n"), SOLOCHAT_SNAPSHOT_MAX_CHARS);
}

function trimByChars(value, maxChars) {
    const normalized = String(value || "").trim();

    if (!normalized) {
        return "";
    }

    if (normalized.length <= maxChars) {
        return normalized;
    }

    return `${normalized.slice(0, maxChars)}\n\n[内容已截断]`;
}

function clampInteger(value, min, max) {
    const parsed = Number(value);

    if (!Number.isInteger(parsed)) {
        throw upstreamError("AI evaluation produced a non-integer score");
    }

    return Math.min(Math.max(parsed, min), max);
}

module.exports = {
    createAssignmentEvaluator,
};
