const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const { db } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

router.use(requireAuth, requireRole("student"));

const GRADE_ATTACHMENT_DIR = path.join(__dirname, "..", "uploads", "grade-attachments");
const ABSENCE_MODE_INCLUDE_ZERO = "include_zero";
const ABSENCE_MODE_EXCLUDE = "exclude";
const DEFAULT_ABSENCE_MODE = ABSENCE_MODE_INCLUDE_ZERO;

function sanitizeFilename(name) {
  return String(name || "datei")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function loadStudentProfiles(email) {
  const rows = await allAsync(
    `SELECT s.*, c.name as class_name, c.subject as class_subject, c.id as class_id, u.email as teacher_email
     FROM students s
     JOIN classes c ON c.id = s.class_id
     LEFT JOIN users u ON u.id = c.teacher_id
     WHERE s.email = ?
     ORDER BY c.name ASC, c.id ASC`,
    [email]
  );
  return rows.map((row) => ({
    ...row,
    id: row.id != null ? row.id : row.student_id,
    name: row.name || row.student_name || "",
    email: row.email || row.student_email || email,
    school_year: row.school_year || null,
    class_id: row.class_id,
    class_name: row.class_name || "",
    class_subject: row.class_subject || row.subject || "",
    teacher_email: row.teacher_email || null
  }));
}

async function loadClassInfo(classId) {
  return getAsync(
    "SELECT c.id, c.name, c.subject, u.email AS teacher_email FROM classes c LEFT JOIN users u ON c.teacher_id = u.id WHERE c.id = ?",
    [classId]
  );
}

function normalizeAbsenceMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized === ABSENCE_MODE_EXCLUDE) return ABSENCE_MODE_EXCLUDE;
  return DEFAULT_ABSENCE_MODE;
}

function isValidGradeValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 && numeric <= 5;
}

function isValidWeightValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

async function loadClassAbsenceMode(classId) {
  const row = await getAsync(
    `SELECT gp.absence_mode
     FROM classes c
     LEFT JOIN teacher_grading_profiles gp ON gp.teacher_id = c.teacher_id AND gp.is_active = ?
     WHERE c.id = ?
     ORDER BY gp.created_at ASC, gp.id ASC
     LIMIT 1`,
    [true, classId]
  );
  return normalizeAbsenceMode(row?.absence_mode);
}

async function loadStudentGrades(studentId) {
  return allAsync(
    `SELECT g.id, g.grade, g.note, g.created_at, g.is_absent, gt.id as template_id, gt.name, gt.category, gt.weight, gt.date, gt.description, c.id as class_id, c.name as class_name, c.subject as class_subject, g.attachment_path, g.attachment_original_name, g.attachment_mime, g.attachment_size, g.external_link, 0 as is_special
     FROM grades g
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     JOIN classes c ON c.id = g.class_id
     WHERE g.student_id = ?
     UNION ALL
     SELECT sa.id, sa.grade, sa.description as note, sa.created_at, false as is_absent, NULL as template_id, sa.name, sa.type as category, sa.weight, sa.created_at as date, sa.description, c.id as class_id, c.name as class_name, c.subject as class_subject, NULL as attachment_path, NULL as attachment_original_name, NULL as attachment_mime, NULL as attachment_size, NULL as external_link, 1 as is_special
     FROM special_assessments sa
     JOIN classes c ON c.id = sa.class_id
     WHERE sa.student_id = ?
     ORDER BY created_at DESC`,
    [studentId, studentId]
  );
}

async function loadTemplates(classId) {
  return allAsync(
    "SELECT id, name, category, weight, date, description FROM grade_templates WHERE class_id = ? ORDER BY date, name",
    [classId]
  );
}

async function loadClassGradeRows(classId) {
  return allAsync(
    `SELECT gt.name as subject, g.grade as value, gt.weight, g.is_absent
     FROM grades g
     JOIN students s ON s.id = g.student_id
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     WHERE s.class_id = ?
     UNION ALL
     SELECT sa.name as subject, sa.grade as value, sa.weight, false as is_absent
     FROM special_assessments sa
     WHERE sa.class_id = ?`,
    [classId, classId]
  );
}

async function loadNotifications(studentId) {
  return allAsync(
    "SELECT id, message, type, created_at, read_at FROM grade_notifications WHERE student_id = ? ORDER BY created_at DESC",
    [studentId]
  );
}

function mapGradeRow(row, classInfo) {
  const subject = row.class_subject || classInfo?.subject || row.name || "Fach";
  const gradedAt = row.date || row.created_at;
  const isSpecial = Boolean(row.is_special);
  const baseComment = row.note || row.name || "";
  let comment = baseComment;
  if (isSpecial) {
    const displayName = row.name || row.category || "Sonderleistung";
    const description = row.description || row.note || "";
    comment = description && description !== displayName ? `${displayName} – ${description}` : displayName;
  }
  return {
    id: row.id,
    value: row.grade == null ? null : Number(row.grade),
    weight: row.weight == null ? 1 : Number(row.weight),
    is_absent: Boolean(row.is_absent),
    absence_mode: row.absence_mode || null,
    class_id: row.class_id != null ? Number(row.class_id) : classInfo?.id || null,
    class_name: row.class_name || classInfo?.name || "",
    subject,
    teacher: row.teacher_email || classInfo?.teacher_email || null,
    comment,
    graded_at: gradedAt
  };
}

function mapTaskRow(template, gradeRow, classInfo) {
  return {
    id: template.id,
    class_id: template.class_id != null ? Number(template.class_id) : classInfo?.id || null,
    class_name: template.class_name || classInfo?.name || "",
    title: template.name,
    category: template.category,
    weight: Number(template.weight || 0),
    due_at: template.date || null,
    description: template.description || "",
    subject: template.class_subject || classInfo?.subject || "",
    graded: Boolean(gradeRow && gradeRow.id),
    grade: gradeRow ? Number(gradeRow.grade) : null,
    graded_at: gradeRow?.created_at || null,
    note: gradeRow?.note || null
  };
}

function mapReturnRow(row, classInfo) {
  const subject = row.class_subject || classInfo?.subject || row.name || "";
  const hasFile = Boolean(row.attachment_path);
  const hasLink = Boolean(row.external_link);
  return {
    id: row.id,
    template_id: row.template_id,
    class_id: row.class_id != null ? Number(row.class_id) : classInfo?.id || null,
    class_name: row.class_name || classInfo?.name || "",
    title: row.name,
    category: row.category,
    weight: Number(row.weight || 0),
    grade: Number(row.grade),
    graded_at: row.created_at || row.date || null,
    note: row.note || "",
    subject,
    attachment_download_url: hasFile ? `/student/returns/${row.id}/attachment` : null,
    attachment_name: hasFile ? row.attachment_original_name || null : null,
    attachment_mime: hasFile ? row.attachment_mime || null : null,
    attachment_size: hasFile ? row.attachment_size || null : null,
    external_link: hasLink ? row.external_link : null
  };
}

function computeAverages(grades, options = {}) {
  const subjectMap = new Map();
  let weightedSum = 0;
  let weightTotal = 0;

  grades.forEach((grade) => {
    const absenceMode = normalizeAbsenceMode(grade?.absence_mode || options.absenceMode);
    if (grade?.is_absent && absenceMode === ABSENCE_MODE_EXCLUDE) return;
    const value = Number(grade?.value);
    const weight = grade?.weight == null ? 1 : Number(grade.weight);
    if (!isValidGradeValue(value) || !isValidWeightValue(weight)) return;
    weightedSum += value * weight;
    weightTotal += weight;

    const bucket = subjectMap.get(grade.subject) || { weightedSum: 0, weightTotal: 0 };
    bucket.weightedSum += value * weight;
    bucket.weightTotal += weight;
    subjectMap.set(grade.subject, bucket);
  });

  const subjects = Array.from(subjectMap.entries()).map(([subject, info]) => ({
    subject,
    average: info.weightTotal ? Number((info.weightedSum / info.weightTotal).toFixed(2)) : null
  }));

  return {
    subjects,
    overall: weightTotal ? Number((weightedSum / weightTotal).toFixed(2)) : null
  };
}

function computeClassAverages(rows, options = {}) {
  const bucket = new Map();
  rows.forEach((row) => {
    const absenceMode = normalizeAbsenceMode(row?.absence_mode || options.absenceMode);
    if (row?.is_absent && absenceMode === ABSENCE_MODE_EXCLUDE) return;
    const value = Number(row?.value);
    const weight = row?.weight == null ? 1 : Number(row.weight);
    if (!isValidGradeValue(value) || !isValidWeightValue(weight)) return;
    const key = row.subject || "Fach";
    const entry = bucket.get(key) || { weightedSum: 0, weightTotal: 0 };
    entry.weightedSum += value * weight;
    entry.weightTotal += weight;
    bucket.set(key, entry);
  });

  return Array.from(bucket.entries()).map(([subject, info]) => ({
    subject,
    average: info.weightTotal ? Number((info.weightedSum / info.weightTotal).toFixed(2)) : null
  }));
}

function escapeCsv(value) {
  const stringValue = value == null ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(stringValue) ? `'${stringValue}` : stringValue;
  if (/[",\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function sanitizePdfText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, "?");
}

function buildPdf(lines) {
  const safeLines = lines.map((line) => sanitizePdfText(line));
  const contentLines = ["BT", "/F1 12 Tf", "14 TL", "72 760 Td"];

  safeLines.forEach((line, index) => {
    contentLines.push(`(${line}) Tj`);
    if (index < safeLines.length - 1) {
      contentLines.push("T*");
    }
  });

  contentLines.push("ET");
  const content = contentLines.join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  let currentOffset = pdf.length;

  objects.forEach((obj) => {
    offsets.push(currentOffset);
    pdf += obj;
    currentOffset = pdf.length;
  });

  const xrefOffset = currentOffset;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });

  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return pdf;
}

async function getStudentContext(req) {
  const students = await loadStudentProfiles(req.session.user.email);
  if (!students.length) return null;

  const classIds = [...new Set(students.map((student) => String(student.class_id)))];
  const classInfos = await Promise.all(classIds.map((classId) => loadClassInfo(classId)));
  const classInfoById = new Map(
    classInfos.filter(Boolean).map((classInfo) => [String(classInfo.id), classInfo])
  );
  const absenceModeEntries = await Promise.all(
    classIds.map(async (classId) => [String(classId), await loadClassAbsenceMode(classId)])
  );

  return {
    students,
    student: students[0],
    classInfo: classInfoById.get(String(students[0].class_id)) || null,
    classAbsenceMode:
      new Map(absenceModeEntries).get(String(students[0].class_id)) || DEFAULT_ABSENCE_MODE,
    classInfoById,
    absenceModeByClassId: new Map(absenceModeEntries)
  };
}

async function loadGradeRowsForStudents(context) {
  const rows = await Promise.all(
    (context.students || []).map(async (student) => {
      const gradeRows = await loadStudentGrades(student.id);
      return gradeRows.map((row) => ({
        ...row,
        student_id: student.id,
        class_id: row.class_id != null ? Number(row.class_id) : Number(student.class_id),
        class_name: row.class_name || student.class_name || "",
        class_subject: row.class_subject || student.class_subject || "",
        teacher_email: row.teacher_email || student.teacher_email || null,
        absence_mode:
          context.absenceModeByClassId.get(
            String(row.class_id != null ? row.class_id : student.class_id)
          ) || DEFAULT_ABSENCE_MODE
      }));
    })
  );
  return rows.flat();
}

async function loadTemplatesForStudents(context) {
  const templates = await Promise.all(
    (context.students || []).map(async (student) => {
      const rows = await loadTemplates(student.class_id);
      return rows.map((template) => ({
        ...template,
        class_id: Number(student.class_id),
        class_name: student.class_name || "",
        class_subject: student.class_subject || ""
      }));
    })
  );
  return templates.flat();
}

async function loadClassRowsForStudents(context) {
  const rows = await Promise.all(
    [...new Set((context.students || []).map((student) => String(student.class_id)))].map(
      async (classId) => {
        const classRows = await loadClassGradeRows(classId);
        const absenceMode =
          context.absenceModeByClassId.get(String(classId)) || DEFAULT_ABSENCE_MODE;
        return classRows.map((row) => ({
          ...row,
          class_id: Number(classId),
          absence_mode: absenceMode
        }));
      }
    )
  );
  return rows.flat();
}

async function loadNotificationsForStudents(context) {
  const rows = await Promise.all(
    (context.students || []).map(async (student) => {
      const notifications = await loadNotifications(student.id);
      return notifications.map((notification) => ({
        ...notification,
        student_id: student.id,
        class_id: student.class_id
      }));
    })
  );
  return rows
    .flat()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

router.get("/", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).render("error", {
        message: "Student nicht gefunden.",
        status: 404,
        backUrl: "/",
        csrfToken: req.csrfToken()
      });
    }

    const { student, classInfo, classAbsenceMode } = context;
    const gradeRows = await loadGradeRowsForStudents(context);
    const grades = gradeRows.map((row) =>
      mapGradeRow(row, context.classInfoById.get(String(row.class_id)) || classInfo)
    );
    const subjectSet = new Set(grades.map((grade) => grade.subject));
    context.students.forEach((entry) => {
      if (entry.class_subject) subjectSet.add(entry.class_subject);
    });
    const subjects = Array.from(subjectSet).filter(Boolean);
    const averages = computeAverages(grades, { absenceMode: classAbsenceMode });
    const templates = await loadTemplatesForStudents(context);
    const gradeByTemplate = new Map(
      gradeRows
        .filter((row) => row.template_id != null)
        .map((row) => [`${row.class_id}:${row.template_id}`, row])
    );
    const tasks = templates.map((template) =>
      mapTaskRow(
        template,
        gradeByTemplate.get(`${template.class_id}:${template.id}`),
        context.classInfoById.get(String(template.class_id)) || classInfo
      )
    );
    const returns = gradeRows
      .map((row) => mapReturnRow(row, context.classInfoById.get(String(row.class_id)) || classInfo))
      .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
    const classRows = await loadClassRowsForStudents(context);
    const classAverages = computeClassAverages(classRows, { absenceMode: classAbsenceMode });
    const notifications = await loadNotificationsForStudents(context);
    const csrfToken = req.csrfToken();
    const classLabels = [...new Set(context.students.map((entry) => entry.class_name).filter(Boolean))];
    const subjectLabels = [...new Set(context.students.map((entry) => entry.class_subject).filter(Boolean))];

    const studentProfile = {
      name: student.name,
      class: classLabels.length ? classLabels.join(" / ") : student.class_name || classInfo?.name || "Unbekannt",
      subject: subjectLabels.join(" / ")
    };

    res.render("student-dashboard", {
      email: req.session.user.email,
      studentProfile,
      subjects,
      tasks,
      returns,
      materials: [],
      messages: [],
      initialData: {
        grades,
        averages,
        tasks,
        returns,
        classAverages,
        notifications,
        trend: { direction: "steady", change: 0 },
        csrfToken
      },
      csrfToken
    });
  } catch (err) {
    next(err);
  }
});

router.get("/profile", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const { student, classInfo } = context;
    const classLabels = [...new Set(context.students.map((entry) => entry.class_name).filter(Boolean))];
    const classIds = [...new Set(context.students.map((entry) => Number(entry.class_id)).filter(Number.isFinite))];
    const subjectLabels = [...new Set(context.students.map((entry) => entry.class_subject).filter(Boolean))];
    res.json({
      name: student.name,
      class: classLabels.length ? classLabels.join(" / ") : student.class_name || classInfo?.name || "",
      classId: classIds[0] || student.class_id,
      classIds,
      subject: subjectLabels.join(" / "),
      schoolYear: student.school_year || null
    });
  } catch (err) {
    next(err);
  }
});

router.get("/grades", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const { classInfo } = context;
    const gradeRows = await loadGradeRowsForStudents(context);
    let grades = gradeRows.map((row) =>
      mapGradeRow(row, context.classInfoById.get(String(row.class_id)) || classInfo)
    );

    const subject = String(req.query.subject || "").trim();
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;

    if (endDate && !Number.isNaN(endDate.getTime())) {
      endDate.setHours(23, 59, 59, 999);
    }

    if (subject) {
      grades = grades.filter((grade) => grade.subject === subject);
    }
    if (startDate && !Number.isNaN(startDate.getTime())) {
      grades = grades.filter((grade) => {
        if (!grade.graded_at) return false;
        return new Date(grade.graded_at) >= startDate;
      });
    }
    if (endDate && !Number.isNaN(endDate.getTime())) {
      grades = grades.filter((grade) => {
        if (!grade.graded_at) return false;
        return new Date(grade.graded_at) <= endDate;
      });
    }

    const sort = String(req.query.sort || "date");
    if (sort === "value") {
      grades.sort((a, b) => a.value - b.value);
    } else {
      grades.sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
    }

    res.json({ grades });
  } catch (err) {
    next(err);
  }
});

router.get("/tasks", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const { classInfo } = context;
    const templates = await loadTemplatesForStudents(context);
    const gradeRows = await loadGradeRowsForStudents(context);
    const gradeByTemplate = new Map(
      gradeRows
        .filter((row) => row.template_id != null)
        .map((row) => [`${row.class_id}:${row.template_id}`, row])
    );
    const tasks = templates.map((template) =>
      mapTaskRow(
        template,
        gradeByTemplate.get(`${template.class_id}:${template.id}`),
        context.classInfoById.get(String(template.class_id)) || classInfo
      )
    );
    res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

router.get("/returns", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const gradeRows = await loadGradeRowsForStudents(context);
    const returns = gradeRows
      .map((row) => mapReturnRow(row, context.classInfoById.get(String(row.class_id)) || context.classInfo))
      .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
    res.json({ returns });
  } catch (err) {
    next(err);
  }
});

router.get("/returns/:gradeId/attachment", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).send("Student nicht gefunden.");
    }

    const gradeId = Number(req.params.gradeId);
    if (!gradeId) {
      return res.status(400).send("Ungültige ID.");
    }

    let row = null;
    for (const student of context.students) {
      row = await getAsync(
        "SELECT attachment_path, attachment_original_name, attachment_mime FROM grades WHERE id = ? AND student_id = ?",
        [gradeId, student.id]
      );
      if (row) break;
    }
    if (!row || !row.attachment_path) {
      return res.status(404).send("Datei nicht gefunden.");
    }

    const baseDir = path.resolve(GRADE_ATTACHMENT_DIR);
    const filePath = path.resolve(path.join(GRADE_ATTACHMENT_DIR, row.attachment_path));
    if (!filePath.startsWith(baseDir + path.sep)) {
      return res.status(400).send("Ungültiger Dateipfad.");
    }

    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      return res.status(404).send("Datei nicht gefunden.");
    }

    const downloadName = sanitizeFilename(row.attachment_original_name || "datei");
    res.setHeader("Content-Type", row.attachment_mime || "application/octet-stream");
    return res.download(filePath, downloadName, (err) => {
      if (err) next(err);
    });
  } catch (err) {
    next(err);
  }
});

router.get("/class-averages", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const classRows = await loadClassRowsForStudents(context);
    res.json({ subjects: computeClassAverages(classRows, { absenceMode: context.classAbsenceMode }) });
  } catch (err) {
    next(err);
  }
});

router.get("/notifications", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const notifications = await loadNotificationsForStudents(context);
    res.json({ notifications });
  } catch (err) {
    next(err);
  }
});

router.post("/notifications/:id/read", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Ungültige ID." });
    }

    const notifications = await loadNotificationsForStudents(context);
    const notification = notifications.find((entry) => Number(entry.id) === id);
    if (!notification) {
      return res.status(404).json({ error: "Benachrichtigung nicht gefunden." });
    }

    await runAsync(
      "UPDATE grade_notifications SET read_at = current_timestamp WHERE id = ? AND student_id = ?",
      [id, notification.student_id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/grades.csv", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).send("Student nicht gefunden.");
    }

    const { student, classInfo } = context;
    const gradeRows = await loadGradeRowsForStudents(context);
    const grades = gradeRows.map((row) =>
      mapGradeRow(row, context.classInfoById.get(String(row.class_id)) || classInfo)
    );

    const header = ["Fach", "Datum", "Note", "Gewichtung", "Lehrkraft", "Kommentar"];
    const lines = [header.map(escapeCsv).join(",")];

    grades.forEach((grade) => {
      const dateLabel = grade.graded_at ? new Date(grade.graded_at).toLocaleDateString("de-DE") : "";
      const row = [
        grade.subject,
        dateLabel,
        Number(grade.value).toFixed(2),
        grade.weight,
        grade.teacher || "",
        grade.comment
      ];
      lines.push(row.map(escapeCsv).join(","));
    });

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=grades.csv");
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get("/grades.pdf", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).send("Student nicht gefunden.");
    }

    const { student, classInfo } = context;
    const gradeRows = await loadGradeRowsForStudents(context);
    const grades = gradeRows.map((row) =>
      mapGradeRow(row, context.classInfoById.get(String(row.class_id)) || classInfo)
    );
    const classLabels = [...new Set(context.students.map((entry) => entry.class_name).filter(Boolean))];
    const subjectLabels = [...new Set(context.students.map((entry) => entry.class_subject).filter(Boolean))];

    const lines = [
      "Notenuebersicht",
      `Schueler: ${student.name}`,
      `Klasse: ${classLabels.join(" / ")}`,
      `Fach: ${subjectLabels.join(" / ")}`,
      "",
      "Fach | Datum | Note | Gewicht | Kommentar"
    ];

    grades.forEach((grade) => {
      const dateLabel = grade.graded_at ? new Date(grade.graded_at).toLocaleDateString("de-DE") : "";
      const row = [
        grade.subject,
        dateLabel,
        Number(grade.value).toFixed(2),
        String(grade.weight || ""),
        grade.comment || ""
      ].join(" | ");
      lines.push(row);
    });

    const pdf = buildPdf(lines);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=grades.pdf");
    res.send(Buffer.from(pdf, "utf8"));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
