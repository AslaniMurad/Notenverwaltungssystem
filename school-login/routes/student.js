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

function sanitizeFilename(name) {
  return String(name || "datei")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function loadStudentProfile(email) {
  return getAsync(
    "SELECT s.*, c.name as class_name, c.subject as class_subject, c.id as class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.email = ?",
    [email]
  );
}

async function loadClassInfo(classId) {
  return getAsync(
    "SELECT c.id, c.name, c.subject, u.email AS teacher_email FROM classes c LEFT JOIN users u ON c.teacher_id = u.id WHERE c.id = ?",
    [classId]
  );
}

async function loadStudentGrades(studentId) {
  return allAsync(
    `SELECT g.id, g.grade, g.note, g.created_at, gt.id as template_id, gt.name, gt.category, gt.weight, gt.date, gt.description, c.subject as class_subject, g.attachment_path, g.attachment_original_name, g.attachment_mime, g.attachment_size, g.external_link, 0 as is_special
     FROM grades g
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     JOIN classes c ON c.id = g.class_id
     WHERE g.student_id = ?
     UNION ALL
     SELECT sa.id, sa.grade, sa.description as note, sa.created_at, NULL as template_id, sa.name, sa.type as category, sa.weight, sa.created_at as date, sa.description, c.subject as class_subject, NULL as attachment_path, NULL as attachment_original_name, NULL as attachment_mime, NULL as attachment_size, NULL as external_link, 1 as is_special
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
    `SELECT gt.name as subject, g.grade as value, gt.weight
     FROM grades g
     JOIN students s ON s.id = g.student_id
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     WHERE s.class_id = ?
     UNION ALL
     SELECT sa.name as subject, sa.grade as value, sa.weight
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
    value: Number(row.grade),
    weight: Number(row.weight || 1),
    subject,
    teacher: classInfo?.teacher_email || null,
    comment,
    graded_at: gradedAt
  };
}

function mapTaskRow(template, gradeRow, classInfo) {
  return {
    id: template.id,
    title: template.name,
    category: template.category,
    weight: Number(template.weight || 0),
    due_at: template.date || null,
    description: template.description || "",
    subject: classInfo?.subject || "",
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

function computeAverages(grades) {
  const subjectMap = new Map();
  let weightedSum = 0;
  let weightTotal = 0;

  grades.forEach((grade) => {
    const weight = Number(grade.weight || 1);
    if (Number.isNaN(grade.value) || Number.isNaN(weight)) return;
    weightedSum += grade.value * weight;
    weightTotal += weight;

    const bucket = subjectMap.get(grade.subject) || { weightedSum: 0, weightTotal: 0 };
    bucket.weightedSum += grade.value * weight;
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

function computeClassAverages(rows) {
  const bucket = new Map();
  rows.forEach((row) => {
    const key = row.subject || "Fach";
    const entry = bucket.get(key) || { sum: 0, count: 0 };
    entry.sum += Number(row.value);
    entry.count += 1;
    bucket.set(key, entry);
  });

  return Array.from(bucket.entries()).map(([subject, info]) => ({
    subject,
    average: info.count ? Number((info.sum / info.count).toFixed(2)) : null
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
  const student = await loadStudentProfile(req.session.user.email);
  if (!student) return null;
  const classInfo = await loadClassInfo(student.class_id);
  return { student, classInfo };
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

    const { student, classInfo } = context;
    const gradeRows = await loadStudentGrades(student.id);
    const grades = gradeRows.map((row) => mapGradeRow(row, classInfo));
    const subjectSet = new Set(grades.map((grade) => grade.subject));
    if (classInfo?.subject) subjectSet.add(classInfo.subject);
    if (student.class_subject) subjectSet.add(student.class_subject);
    const subjects = Array.from(subjectSet).filter(Boolean);
    const averages = computeAverages(grades);
    const templates = await loadTemplates(student.class_id);
    const gradeByTemplate = new Map(
      gradeRows
        .filter((row) => row.template_id != null)
        .map((row) => [String(row.template_id), row])
    );
    const tasks = templates.map((template) =>
      mapTaskRow(template, gradeByTemplate.get(String(template.id)), classInfo)
    );
    const returns = gradeRows
      .map((row) => mapReturnRow(row, classInfo))
      .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
    const classRows = await loadClassGradeRows(student.class_id);
    const classAverages = computeClassAverages(classRows);
    const notifications = await loadNotifications(student.id);
    const csrfToken = req.csrfToken();

    const studentProfile = {
      name: student.name,
      class: student.class_name || classInfo?.name || "Unbekannt",
      subject: student.class_subject || classInfo?.subject || ""
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
    res.json({
      name: student.name,
      class: student.class_name || classInfo?.name || "",
      classId: student.class_id,
      subject: student.class_subject || classInfo?.subject || "",
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

    const { student, classInfo } = context;
    const gradeRows = await loadStudentGrades(student.id);
    let grades = gradeRows.map((row) => mapGradeRow(row, classInfo));

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

    const { student } = context;
    const templates = await loadTemplates(student.class_id);
    const gradeRows = await loadStudentGrades(student.id);
    const gradeByTemplate = new Map(
      gradeRows
        .filter((row) => row.template_id != null)
        .map((row) => [String(row.template_id), row])
    );
    const tasks = templates.map((template) =>
      mapTaskRow(template, gradeByTemplate.get(String(template.id)), context.classInfo)
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

    const gradeRows = await loadStudentGrades(context.student.id);
    const returns = gradeRows
      .map((row) => mapReturnRow(row, context.classInfo))
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

    const row = await getAsync(
      "SELECT attachment_path, attachment_original_name, attachment_mime FROM grades WHERE id = ? AND student_id = ?",
      [gradeId, context.student.id]
    );
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

    const classRows = await loadClassGradeRows(context.student.class_id);
    res.json({ subjects: computeClassAverages(classRows) });
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

    const notifications = await loadNotifications(context.student.id);
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

    await runAsync(
      "UPDATE grade_notifications SET read_at = current_timestamp WHERE id = ? AND student_id = ?",
      [id, context.student.id]
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
    const gradeRows = await loadStudentGrades(student.id);
    const grades = gradeRows.map((row) => mapGradeRow(row, classInfo));

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
    const gradeRows = await loadStudentGrades(student.id);
    const grades = gradeRows.map((row) => mapGradeRow(row, classInfo));

    const lines = [
      "Notenuebersicht",
      `Schueler: ${student.name}`,
      `Klasse: ${student.class_name || classInfo?.name || ""}`,
      `Fach: ${student.class_subject || classInfo?.subject || ""}`,
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
