const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const bcrypt = require("bcrypt");
const { SQLITE_NOW_ISO_EXPRESSION } = require("../lib/time");
const { createInviteCode } = require("../lib/users");
const {
    createAssignmentService,
} = require("../services/assignments/assignment-service");
const { createClassService } = require("../services/classes/class-service");
const { createFileService } = require("../services/uploads/file-service");

const DEMO_TEACHERS = [
    {
        email: "teacher.lead@mechhub.local",
        password: "Teacher123!",
        displayName: "Astra Quinn",
        bio: "Lead instructor for the mechanics demo classroom.",
        role: "teacher",
    },
    {
        email: "teacher.assist@mechhub.local",
        password: "Teacher123!",
        displayName: "Noah Vale",
        bio: "Co-instructor focusing on review and grading.",
        role: "teacher",
    },
];

const DEMO_STUDENTS = [
    {
        email: "student.anna@mechhub.local",
        password: "Student123!",
        displayName: "Anna Vector",
        bio: "Strong at diagrams and neat writeups.",
        role: "student",
    },
    {
        email: "student.ben@mechhub.local",
        password: "Student123!",
        displayName: "Ben Torque",
        bio: "Moves fast and usually submits before the deadline.",
        role: "student",
    },
    {
        email: "student.claire@mechhub.local",
        password: "Student123!",
        displayName: "Claire Static",
        bio: "Reflective student who often leaves a draft first.",
        role: "student",
    },
];

const DEMO_CLASS = {
    name: "Mechanics Design Studio · Demo",
    description:
        "Demo class seeded for UI testing. Includes two teachers, three students, several assignments, mixed submission states, and review data.",
};

function createDevSeedRouter(db) {
    const router = express.Router();
    const classService = createClassService(db);
    const assignmentService = createAssignmentService(db);
    const fileService = createFileService(db);

    router.get("/seed/academy-demo", async (req, res, next) => {
        try {
            await clearDemoData(db);

            const teacherUsers = [];
            for (const teacher of DEMO_TEACHERS) {
                teacherUsers.push(await createUser(db, teacher));
            }

            const studentUsers = [];
            for (const student of DEMO_STUDENTS) {
                studentUsers.push(await createUser(db, student));
            }

            const leadTeacher = teacherUsers[0];
            const assistantTeacher = teacherUsers[1];

            const classroom = await classService.createClass({
                ownerUserId: leadTeacher.id,
                name: DEMO_CLASS.name,
                description: DEMO_CLASS.description,
                role: "teacher",
                inviteCode: createInviteCode(),
            });

            await classService.joinClass({
                classId: classroom.id,
                userId: assistantTeacher.id,
                role: "teacher",
            });

            for (const student of studentUsers) {
                await classService.joinClass({
                    classId: classroom.id,
                    userId: student.id,
                    role: "student",
                });
            }

            const now = Date.now();
            const assignments = [];

            assignments.push(
                await createSeedAssignment({
                    assignmentService,
                    fileService,
                    classId: classroom.id,
                    teacherId: leadTeacher.id,
                    title: "Free-Body Diagram Precision Lab",
                    description:
                        "Draw free-body diagrams for three linked mechanical systems, label every force clearly, and explain why each support reaction appears in your diagram.",
                    startAt: new Date(
                        now - 2 * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                    dueAt: new Date(
                        now + 3 * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                    allowLateSubmission: false,
                    maxScore: 100,
                    status: "published",
                    attachments: [
                        {
                            fileName: "fbd-brief.txt",
                            content:
                                "Assignment brief: submit three free-body diagrams and a short reflection about support reactions.",
                        },
                        {
                            fileName: "fbd-rubric.txt",
                            content:
                                "Rubric: 40% correct forces, 30% clean labels, 30% reasoning quality.",
                        },
                    ],
                }),
            );

            assignments.push(
                await createSeedAssignment({
                    assignmentService,
                    fileService,
                    classId: classroom.id,
                    teacherId: leadTeacher.id,
                    title: "Truss Analysis Reflection Memo",
                    description:
                        "Complete a method-of-joints analysis on the sample truss, then write a short memo on which member forces were easiest and hardest to determine.",
                    startAt: new Date(
                        now - 6 * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                    dueAt: new Date(
                        now - 1 * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                    allowLateSubmission: true,
                    maxScore: 100,
                    status: "published",
                    attachments: [
                        {
                            fileName: "truss-case.txt",
                            content:
                                "Case file: evaluate the Pratt truss under a distributed roof load and summarize member force categories.",
                        },
                    ],
                }),
            );

            assignments.push(
                await createSeedAssignment({
                    assignmentService,
                    fileService,
                    classId: classroom.id,
                    teacherId: assistantTeacher.id,
                    title: "Beam Deflection Mini Project",
                    description:
                        "Estimate beam deflection using superposition, compare with a quick numerical approximation, and discuss the mismatch in a compact design note.",
                    startAt: new Date(
                        now - 10 * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                    dueAt: new Date(
                        now - 4 * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                    allowLateSubmission: false,
                    maxScore: 100,
                    status: "closed",
                    attachments: [
                        {
                            fileName: "beam-geometry.txt",
                            content:
                                "Beam geometry: simply supported span, mixed point and distributed loads, compare hand estimate with quick script output.",
                        },
                    ],
                }),
            );

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[0].id,
                studentId: studentUsers[0].id,
                textAnswer:
                    "I broke each mechanism into one isolated body at a time, listed every applied load, and used the support type to decide each reaction component.",
                status: "submitted",
                submittedAt: new Date(now - 12 * 60 * 60 * 1000).toISOString(),
                attachments: [
                    {
                        fileName: "anna-fbd-notes.txt",
                        content:
                            "Anna's clean notes on support reactions and sign conventions for the FBD lab.",
                    },
                ],
                review: {
                    reviewerUserId: assistantTeacher.id,
                    score: 96,
                    comment:
                        "Clear diagrams and excellent reaction reasoning. Tighten the labeling around the pin support on system B.",
                },
            });

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[0].id,
                studentId: studentUsers[1].id,
                textAnswer:
                    "The diagrams are arranged by body, and I marked reactions based on the constraints before writing the equilibrium equations.",
                status: "submitted",
                submittedAt: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
                attachments: [
                    {
                        fileName: "ben-fbd-draft.txt",
                        content:
                            "Ben's concise submission notes for the FBD lab.",
                    },
                ],
            });

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[0].id,
                studentId: studentUsers[2].id,
                textAnswer:
                    "Draft notes: still checking whether the roller support should create one or two reaction arrows in the second sketch.",
                status: "draft",
                attachments: [
                    {
                        fileName: "claire-fbd-draft.txt",
                        content:
                            "Claire's unfinished draft for the free-body diagram lab.",
                    },
                ],
            });

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[1].id,
                studentId: studentUsers[0].id,
                textAnswer:
                    "The top chord compression members were straightforward, but the diagonal near the support took the most iteration to verify.",
                status: "submitted",
                submittedAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
                review: {
                    reviewerUserId: leadTeacher.id,
                    score: 88,
                    comment:
                        "Good memo and solid force classification. Show one extra intermediate joint calculation next time.",
                },
            });

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[1].id,
                studentId: studentUsers[2].id,
                textAnswer:
                    "The diagonals around the loaded joint were the most interesting because the sign switched when I rechecked the tension assumption.",
                status: "submitted",
                submittedAt: new Date(now - 30 * 60 * 1000).toISOString(),
                attachments: [
                    {
                        fileName: "claire-truss-reflection.txt",
                        content:
                            "Claire's late reflection memo on the truss analysis task.",
                    },
                ],
            });

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[2].id,
                studentId: studentUsers[0].id,
                textAnswer:
                    "I used superposition for the point load and distributed load separately, then compared the sum against a coarse numerical spreadsheet check.",
                status: "submitted",
                submittedAt: new Date(
                    now - 6 * 24 * 60 * 60 * 1000,
                ).toISOString(),
                review: {
                    reviewerUserId: assistantTeacher.id,
                    score: 94,
                    comment:
                        "Strong design note and well-structured comparison. Nice explanation of the approximation gap.",
                },
            });

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[2].id,
                studentId: studentUsers[1].id,
                textAnswer:
                    "My numerical check was rough, but the trend matched the hand estimate and the maximum deflection location lined up correctly.",
                status: "submitted",
                submittedAt: new Date(
                    now - 5 * 24 * 60 * 60 * 1000,
                ).toISOString(),
                review: {
                    reviewerUserId: leadTeacher.id,
                    score: 86,
                    comment:
                        "Good comparison and clear structure. Improve the explanation around your boundary condition assumptions.",
                },
            });

            await createSeedSubmission({
                db,
                assignmentService,
                fileService,
                assignmentId: assignments[2].id,
                studentId: studentUsers[2].id,
                textAnswer:
                    "I summarized the hand estimate first, then used a lightweight script to check the order of magnitude before writing the conclusion.",
                status: "submitted",
                submittedAt: new Date(
                    now - 4.5 * 24 * 60 * 60 * 1000,
                ).toISOString(),
                review: {
                    reviewerUserId: assistantTeacher.id,
                    score: 79,
                    comment:
                        "Solid structure, but the numerical section needs more detail and the final interpretation is still too brief.",
                },
            });

            const result = {
                message: "Demo academy data seeded successfully",
                class: {
                    id: classroom.id,
                    name: classroom.name,
                    inviteCode: classroom.invite_code,
                },
                teachers: DEMO_TEACHERS.map((teacher) => ({
                    email: teacher.email,
                    password: teacher.password,
                    displayName: teacher.displayName,
                })),
                students: DEMO_STUDENTS.map((student) => ({
                    email: student.email,
                    password: student.password,
                    displayName: student.displayName,
                })),
                assignments: assignments.map((assignment) => ({
                    id: assignment.id,
                    title: assignment.title,
                    dueAt: assignment.due_at,
                    status: assignment.status,
                })),
            };

            return res.type("html").send(renderSeedResult(result));
        } catch (error) {
            return next(error);
        }
    });

    return router;
}

async function clearDemoData(db) {
    const demoEmails = [...DEMO_TEACHERS, ...DEMO_STUDENTS].map(
        (user) => user.email,
    );
    const placeholders = demoEmails.map(() => "?").join(", ");
    const demoUsers = await db.all(
        `SELECT id FROM users WHERE email IN (${placeholders})`,
        ...demoEmails,
    );
    const userIds = demoUsers.map((user) => user.id);

    const demoClasses = await db.all(
        `SELECT id FROM classes WHERE name = ?`,
        DEMO_CLASS.name,
    );

    if (demoClasses.length) {
        const classPlaceholders = demoClasses.map(() => "?").join(", ");
        await db.run(
            `DELETE FROM classes WHERE id IN (${classPlaceholders})`,
            ...demoClasses.map((classroom) => classroom.id),
        );
    }

    if (userIds.length) {
        const idPlaceholders = userIds.map(() => "?").join(", ");
        const uploadedFiles = await db.all(
            `SELECT storage_path FROM uploaded_files WHERE owner_user_id IN (${idPlaceholders})`,
            ...userIds,
        );

        for (const file of uploadedFiles) {
            try {
                await fs.unlink(file.storage_path);
            } catch (error) {
                if (error.code !== "ENOENT") {
                    throw error;
                }
            }
        }

        await db.run(
            `DELETE FROM uploaded_files WHERE owner_user_id IN (${idPlaceholders})`,
            ...userIds,
        );
        await db.run(
            `DELETE FROM users WHERE id IN (${idPlaceholders})`,
            ...userIds,
        );
    }
}

async function createUser(db, user) {
    const passwordHash = await bcrypt.hash(user.password, 10);
    const avatarUrl = `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(user.displayName)}`;
    const result = await db.run(
        `INSERT INTO users (
             email,
             password_hash,
             display_name,
             avatar_url,
             bio,
             default_role,
             created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ${SQLITE_NOW_ISO_EXPRESSION})`,
        user.email,
        passwordHash,
        user.displayName,
        avatarUrl,
        user.bio,
        user.role,
    );

    return db.get(
        `SELECT id, email, display_name, avatar_url, bio, default_role, created_at
         FROM users
         WHERE id = ?`,
        result.lastID,
    );
}

async function createSeedAssignment({
    assignmentService,
    fileService,
    classId,
    teacherId,
    title,
    description,
    startAt,
    dueAt,
    allowLateSubmission,
    maxScore,
    status,
    attachments,
}) {
    const created = await assignmentService.createAssignment({
        classId,
        createdByUserId: teacherId,
        title,
        description,
        startAt,
        dueAt,
        allowLateSubmission,
        maxScore,
        status: status === "closed" ? "published" : status,
    });

    if (status === "closed") {
        await assignmentService.closeAssignment(created.id);
    }

    const uploadedFiles = [];
    for (const attachment of attachments) {
        uploadedFiles.push(
            await fileService.processUpload({
                userId: teacherId,
                purpose: "assignment_attachment",
                file: {
                    originalname: attachment.fileName,
                    mimetype: "text/plain",
                    size: Buffer.byteLength(attachment.content),
                    buffer: Buffer.from(attachment.content),
                },
            }),
        );
    }

    await fileService.replaceAssignmentFiles({
        assignmentId: created.id,
        fileIds: uploadedFiles.map((file) => file.id),
        userId: teacherId,
    });

    return assignmentService.getAssignmentById(created.id);
}

async function createSeedSubmission({
    db,
    assignmentService,
    fileService,
    assignmentId,
    studentId,
    textAnswer,
    status,
    submittedAt,
    attachments = [],
    review = null,
}) {
    const submission = await assignmentService.createOrUpdateSubmission({
        assignmentId,
        studentUserId: studentId,
        textAnswer,
        status,
    });

    if (submittedAt !== undefined) {
        await db.run(
            `UPDATE assignment_submissions
             SET submitted_at = ?, updated_at = ?
             WHERE id = ?`,
            submittedAt,
            submittedAt || new Date().toISOString(),
            submission.id,
        );
    }

    const uploadedFiles = [];
    for (const attachment of attachments) {
        uploadedFiles.push(
            await fileService.processUpload({
                userId: studentId,
                purpose: "submission_attachment",
                file: {
                    originalname: attachment.fileName,
                    mimetype: "text/plain",
                    size: Buffer.byteLength(attachment.content),
                    buffer: Buffer.from(attachment.content),
                },
            }),
        );
    }

    await fileService.replaceSubmissionFiles({
        submissionId: submission.id,
        fileIds: uploadedFiles.map((file) => file.id),
        userId: studentId,
    });

    if (review) {
        await assignmentService.reviewSubmission({
            assignmentId,
            studentUserId: studentId,
            reviewerUserId: review.reviewerUserId,
            score: review.score,
            comment: review.comment,
        });
    }
}

function renderSeedResult(result) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>MechHub Demo Seed</title>
  <style>
    body { font-family: Consolas, monospace; background:#101013; color:#e5e7eb; padding:24px; }
    pre { white-space: pre-wrap; word-break: break-word; background:#18181c; border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:16px; }
  </style>
</head>
<body>
  <h1>MechHub Demo Seed Complete</h1>
  <pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>
</body>
</html>`;
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

module.exports = {
    createDevSeedRouter,
};
