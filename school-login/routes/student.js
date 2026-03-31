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

async function loadStudentProfile(email) {
  return getAsync(
    "SELECT s.*, c.name as class_name, c.subject as class_subject, c.id as class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.email = ?",
    [email]
  );
}

async function loadClassInfo(classId) {
  return getAsync(
    `SELECT c.id, c.name, c.subject,
            COALESCE((
              SELECT STRING_AGG(teacher_rows.email, ', ')
              FROM (
                SELECT DISTINCT u.email
                FROM class_subject_teacher cst
                JOIN users u ON u.id = cst.teacher_id
                WHERE cst.class_id = c.id
                ORDER BY u.email
              ) AS teacher_rows
            ), '') AS teacher_email
     FROM classes c
     WHERE c.id = ?`,
    [classId]
  );
}

async function loadClassSubjects(classId) {
  return allAsync(
    `SELECT cst.subject_id, COALESCE(s.name, c.subject) AS subject_name
     FROM class_subject_teacher cst
     JOIN classes c ON c.id = cst.class_id
     LEFT JOIN subjects s ON s.id = cst.subject_id
     WHERE cst.class_id = ? AND cst.school_year_id = c.school_year_id
     ORDER BY subject_name ASC`,
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
     FROM class_subject_teacher cst
     JOIN classes c ON c.id = cst.class_id
     LEFT JOIN teacher_grading_profiles gp ON gp.teacher_id = cst.teacher_id AND gp.is_active = ?
     WHERE c.id = ?
     ORDER BY gp.created_at ASC, gp.id ASC
     LIMIT 1`,
    [true, classId]
  );
  return normalizeAbsenceMode(row?.absence_mode);
}

async function loadStudentGrades(studentId) {
  return allAsync(
    `SELECT g.id, g.grade, g.note, g.created_at, g.is_absent, gt.id as template_id, gt.name, gt.category, gt.weight, gt.date, gt.description, COALESCE(s.name, c.subject) as subject_name, c.subject as class_subject,
            COALESCE((
              SELECT STRING_AGG(teacher_rows.email, ', ')
              FROM (
                SELECT DISTINCT u.email
                FROM class_subject_teacher cst
                JOIN users u ON u.id = cst.teacher_id
                WHERE cst.class_id = g.class_id AND cst.subject_id = gt.subject_id
                ORDER BY u.email
              ) AS teacher_rows
            ), '') AS teacher_email,
            g.attachment_path, g.attachment_original_name, g.attachment_mime, g.attachment_size, g.external_link, 0 as is_special
     FROM grades g
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     JOIN classes c ON c.id = g.class_id
     LEFT JOIN subjects s ON s.id = gt.subject_id
     WHERE g.student_id = ?
     UNION ALL
     SELECT sa.id, sa.grade, sa.description as note, sa.created_at, false as is_absent, NULL as template_id, sa.name, sa.type as category, sa.weight, sa.created_at as date, sa.description, COALESCE(ss.name, c.subject) as subject_name, c.subject as class_subject,
            COALESCE((
              SELECT STRING_AGG(teacher_rows.email, ', ')
              FROM (
                SELECT DISTINCT u.email
                FROM class_subject_teacher cst
                JOIN users u ON u.id = cst.teacher_id
                WHERE cst.class_id = sa.class_id AND cst.subject_id = sa.subject_id
                ORDER BY u.email
              ) AS teacher_rows
            ), '') AS teacher_email,
            NULL as attachment_path, NULL as attachment_original_name, NULL as attachment_mime, NULL as attachment_size, NULL as external_link, 1 as is_special
     FROM special_assessments sa
     JOIN classes c ON c.id = sa.class_id
     LEFT JOIN subjects ss ON ss.id = sa.subject_id
     WHERE sa.student_id = ?
     ORDER BY created_at DESC`,
    [studentId, studentId]
  );
}

async function loadTemplates(classId) {
  return allAsync(
    `SELECT gt.id, gt.name, gt.category, gt.weight, gt.date, gt.description, COALESCE(s.name, c.subject) AS subject_name, gt.subject_id
     FROM grade_templates gt
     JOIN classes c ON c.id = gt.class_id
     LEFT JOIN subjects s ON s.id = gt.subject_id
     WHERE gt.class_id = ? AND gt.archived_at IS NULL
     ORDER BY subject_name ASC, gt.date, gt.name`,
    [classId]
  );
}

async function loadArchivedTemplates(classId) {
  return allAsync(
    `SELECT gt.id, gt.name, gt.category, gt.weight, gt.date, gt.description, COALESCE(s.name, c.subject) AS subject_name, gt.subject_id
     FROM grade_templates gt
     JOIN classes c ON c.id = gt.class_id
     LEFT JOIN subjects s ON s.id = gt.subject_id
     WHERE gt.class_id = ? AND gt.archived_at IS NOT NULL
     ORDER BY subject_name ASC, gt.date DESC, gt.name`,
    [classId]
  );
}

async function loadClassGradeRows(classId) {
  return allAsync(
    `SELECT COALESCE(subj.name, c.subject) as subject, g.grade as value, gt.weight, g.is_absent
     FROM grades g
     JOIN students student ON student.id = g.student_id
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     JOIN classes c ON c.id = g.class_id
     LEFT JOIN subjects subj ON subj.id = gt.subject_id
     WHERE student.class_id = ?
     UNION ALL
     SELECT COALESCE(subj.name, c.subject) as subject, sa.grade as value, sa.weight, false as is_absent
     FROM special_assessments sa
     JOIN classes c ON c.id = sa.class_id
     LEFT JOIN subjects subj ON subj.id = sa.subject_id
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

async function loadGradeMessages(studentId) {
  return allAsync(
    `SELECT gm.id, gm.grade_id, gm.student_message, gm.teacher_reply, gm.teacher_reply_by_email, gm.teacher_reply_seen_at, gm.student_hidden_at, gm.created_at, gm.replied_at
     FROM grade_messages gm
     JOIN grades g ON g.id = gm.grade_id
     WHERE gm.student_id = ? AND g.student_id = ?
     ORDER BY gm.created_at ASC`,
    [studentId, studentId]
  );
}

function mapGradeRow(row, classInfo) {
  const subject = row.subject_name || row.class_subject || classInfo?.subject || row.name || "Fach";
  const gradedAt = row.date || row.created_at;
  const isSpecial = Boolean(row.is_special);
  const title = row.name || row.category || "Leistung";
  const category = row.category || (isSpecial ? "Sonderleistung" : "");
  let comment = row.note || "";
  if (isSpecial) {
    const displayName = row.name || row.category || "Sonderleistung";
    const description = row.description || row.note || "";
    comment = description && description !== displayName ? `${displayName} - ${description}` : displayName;
  }
  return {
    id: row.id,
    value: row.grade == null ? null : Number(row.grade),
    weight: row.weight == null ? 1 : Number(row.weight),
    is_absent: Boolean(row.is_absent),
    title,
    category,
    subject,
    teacher: row.teacher_email || classInfo?.teacher_email || null,
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
    subject: template.subject_name || classInfo?.subject || "",
    graded: Boolean(gradeRow && gradeRow.id),
    grade: gradeRow ? Number(gradeRow.grade) : null,
    graded_at: gradeRow?.created_at || null,
    note: gradeRow?.note || null
  };
}

function mapReturnRow(row, classInfo, messagesByGrade = new Map()) {
  const subject = row.subject_name || row.class_subject || classInfo?.subject || row.name || "";
  const hasFile = Boolean(row.attachment_path);
  const hasLink = Boolean(row.external_link);
  const canMessage = Boolean(row.template_id && !row.is_special);
  const messages = canMessage ? messagesByGrade.get(String(row.id)) || [] : [];
  const threadClosedAt = messages.reduce((latest, message) => {
    const hiddenAt = message.student_hidden_at || null;
    if (!hiddenAt) return latest;
    if (!latest) return hiddenAt;
    return new Date(hiddenAt) > new Date(latest) ? hiddenAt : latest;
  }, null);
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
    external_link: hasLink ? row.external_link : null,
    can_message: canMessage,
    thread_closed_at: threadClosedAt,
    messages
  };
}

function computeAverages(grades, options = {}) {
  const absenceMode = normalizeAbsenceMode(options.absenceMode);
  const subjectMap = new Map();
  let weightedSum = 0;
  let weightTotal = 0;

  grades.forEach((grade) => {
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
  const absenceMode = normalizeAbsenceMode(options.absenceMode);
  const bucket = new Map();
  rows.forEach((row) => {
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
  const student = await loadStudentProfile(req.session.user.email);
  if (!student) return null;
  const classInfo = await loadClassInfo(student.class_id);
  const classAbsenceMode = await loadClassAbsenceMode(student.class_id);
  return { student, classInfo, classAbsenceMode };
}

function wantsJson(req) {
  const format = String(req.query?.format || "").trim().toLowerCase();
  if (format === "json") return true;
  return String(req.get("Accept") || "").toLowerCase().includes("application/json");
}

function buildStudentPageUrl(page, query = {}) {
  const normalizedPage = String(page || "overview").trim().toLowerCase();
  const pagePathByKey = {
    overview: "/student",
    tasks: "/student/tasks",
    returns: "/student/returns",
    requests: "/student/requests",
    grades: "/student/grades",
    archive: "/student/archive"
  };
  const pathname = pagePathByKey[normalizedPage];
  if (!pathname) return null;

  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, rawValue]) => {
    if (key === "page" || rawValue == null) return;
    if (Array.isArray(rawValue)) {
      rawValue.forEach((value) => {
        if (value != null) params.append(key, String(value));
      });
      return;
    }
    params.append(key, String(rawValue));
  });

  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

async function buildStudentDashboardViewModel(req) {
  const context = await getStudentContext(req);
  if (!context) return null;

  const { student, classInfo, classAbsenceMode } = context;
  const [gradeRows, templates, archivedTemplates, classRows, notifications, classSubjects] = await Promise.all([
    loadStudentGrades(student.id),
    loadTemplates(student.class_id),
    loadArchivedTemplates(student.class_id),
    loadClassGradeRows(student.class_id),
    loadNotifications(student.id),
    loadClassSubjects(student.class_id)
  ]);

  const grades = gradeRows.map((row) => mapGradeRow(row, classInfo));
  const subjectSet = new Set(
    classSubjects.map((entry) => String(entry.subject_name || "").trim()).filter(Boolean)
  );
  grades.forEach((grade) => {
    if (grade.subject) subjectSet.add(grade.subject);
  });

  const subjects = Array.from(subjectSet).filter(Boolean);
  const averages = computeAverages(grades, { absenceMode: classAbsenceMode });
  const gradeByTemplate = new Map(
    gradeRows
      .filter((row) => row.template_id != null)
      .map((row) => [String(row.template_id), row])
  );
  const tasks = templates.map((template) =>
    mapTaskRow(template, gradeByTemplate.get(String(template.id)), classInfo)
  );
  const archivedTasks = archivedTemplates.map((template) =>
    mapTaskRow(template, gradeByTemplate.get(String(template.id)), classInfo)
  );
  const returnMessages = await loadGradeMessages(student.id);
  const messagesByGrade = new Map();
  returnMessages.forEach((message) => {
    const key = String(message.grade_id);
    const list = messagesByGrade.get(key) || [];
    list.push({
      id: message.id,
      student_message: message.student_message,
      teacher_reply: message.teacher_reply || null,
      teacher_reply_by_email: message.teacher_reply_by_email || null,
      teacher_reply_seen_at: message.teacher_reply_seen_at || null,
      student_hidden_at: message.student_hidden_at || null,
      created_at: message.created_at,
      replied_at: message.replied_at || null
    });
    messagesByGrade.set(key, list);
  });
  const returns = gradeRows
    .map((row) => mapReturnRow(row, classInfo, messagesByGrade))
    .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
  const classAverages = computeClassAverages(classRows, { absenceMode: classAbsenceMode });
  const csrfToken = req.csrfToken();
  const studentProfile = {
    name: student.name,
    class: student.class_name || classInfo?.name || "Unbekannt",
    schoolYear: req.res?.locals?.activeSchoolYear?.name || student.school_year || ""
  };

  return {
    context,
    studentProfile,
    subjects,
    tasks,
    archivedTasks,
    returns,
    initialData: {
      currentUserEmail: req.session.user.email,
      grades,
      averages,
      tasks,
      archivedTasks,
      returns,
      classAverages,
      notifications,
      trend: { direction: "steady", change: 0 },
      csrfToken
    },
    csrfToken
  };
}

async function renderStudentDashboardPage(req, res, activePage) {
  const viewModel = await buildStudentDashboardViewModel(req);
  if (!viewModel) {
    return res.status(404).render("error", {
      message: "Student nicht gefunden.",
      status: 404,
      backUrl: "/",
      csrfToken: req.csrfToken()
    });
  }

  const requestedGradeSubject =
    activePage === "grades" ? String(req.query.subject || "").trim() : "";
  const selectedGradeSubject = viewModel.subjects.includes(requestedGradeSubject)
    ? requestedGradeSubject
    : "";
  const gradeFilters = {
    query: String(req.query.query || "").trim(),
    startDate: String(req.query.startDate || "").trim(),
    endDate: String(req.query.endDate || "").trim(),
    sort: String(req.query.sort || "date").trim().toLowerCase() === "value" ? "value" : "date"
  };

  return res.render("student-dashboard", {
    activePage,
    activeSchoolYear: req.res?.locals?.activeSchoolYear || null,
    email: req.session.user.email,
    studentProfile: viewModel.studentProfile,
    subjects: viewModel.subjects,
    tasks: viewModel.tasks,
    archivedTasks: viewModel.archivedTasks,
    returns: viewModel.returns,
    materials: [],
    messages: [],
    gradeSubject: selectedGradeSubject,
    gradeFilters,
    initialData: viewModel.initialData,
    csrfToken: viewModel.csrfToken
  });
}

router.get("/", async (req, res, next) => {
  try {
    const requestedPage = String(req.query.page || "").trim().toLowerCase();
    if (requestedPage) {
      const legacyTarget = buildStudentPageUrl(requestedPage, req.query);
      if (legacyTarget) {
        return res.redirect(legacyTarget);
      }
    }
    return await renderStudentDashboardPage(req, res, "overview");
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
    const classSubjects = await loadClassSubjects(student.class_id);
    const subjects = classSubjects
      .map((entry) => String(entry.subject_name || "").trim())
      .filter(Boolean);
    res.json({
      name: student.name,
      class: student.class_name || classInfo?.name || "",
      classId: student.class_id,
      subjects,
      schoolYear: student.school_year || null
    });
  } catch (err) {
    next(err);
  }
});

router.get("/grades", async (req, res, next) => {
  try {
    if (!wantsJson(req)) {
      return await renderStudentDashboardPage(req, res, "grades");
    }

    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const { student, classInfo } = context;
    const gradeRows = await loadStudentGrades(student.id);
    let grades = gradeRows.map((row) => mapGradeRow(row, classInfo));

    const subject = String(req.query.subject || "").trim();
    const query = String(req.query.query || "").trim().toLowerCase();
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;

    if (endDate && !Number.isNaN(endDate.getTime())) {
      endDate.setHours(23, 59, 59, 999);
    }

    if (subject) {
      grades = grades.filter((grade) => grade.subject === subject);
    }
    if (query) {
      grades = grades.filter((grade) =>
        [grade.subject, grade.title, grade.category, grade.comment, grade.teacher]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value.includes(query))
      );
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
    if (!wantsJson(req)) {
      return await renderStudentDashboardPage(req, res, "tasks");
    }

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

router.get("/archive", async (req, res, next) => {
  try {
    if (!wantsJson(req)) {
      return await renderStudentDashboardPage(req, res, "archive");
    }

    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const { student, classInfo } = context;
    const [templates, gradeRows] = await Promise.all([
      loadArchivedTemplates(student.class_id),
      loadStudentGrades(student.id)
    ]);
    const gradeByTemplate = new Map(
      gradeRows
        .filter((row) => row.template_id != null)
        .map((row) => [String(row.template_id), row])
    );
    const tasks = templates.map((template) =>
      mapTaskRow(template, gradeByTemplate.get(String(template.id)), classInfo)
    );
    return res.json({ tasks });
  } catch (err) {
    next(err);
  }
});

router.get("/returns", async (req, res, next) => {
  try {
    if (!wantsJson(req)) {
      return await renderStudentDashboardPage(req, res, "returns");
    }

    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const gradeRows = await loadStudentGrades(context.student.id);
    const returnMessages = await loadGradeMessages(context.student.id);
    const messagesByGrade = new Map();
    returnMessages.forEach((message) => {
      const key = String(message.grade_id);
      const list = messagesByGrade.get(key) || [];
      list.push({
        id: message.id,
        student_message: message.student_message,
        teacher_reply: message.teacher_reply || null,
        teacher_reply_by_email: message.teacher_reply_by_email || null,
        teacher_reply_seen_at: message.teacher_reply_seen_at || null,
        student_hidden_at: message.student_hidden_at || null,
        created_at: message.created_at,
        replied_at: message.replied_at || null
      });
      messagesByGrade.set(key, list);
    });
    const returns = gradeRows
      .map((row) => mapReturnRow(row, context.classInfo, messagesByGrade))
      .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
    res.json({ returns });
  } catch (err) {
    next(err);
  }
});

router.get("/requests", async (req, res, next) => {
  try {
    return await renderStudentDashboardPage(req, res, "requests");
  } catch (err) {
    next(err);
  }
});

router.post("/returns/:gradeId/message", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const gradeId = Number(req.params.gradeId);
    if (!gradeId) {
      return res.status(400).json({ error: "Ungueltige Rueckgabe-ID." });
    }

    const grade = await getAsync(
      "SELECT id, student_id, grade_template_id FROM grades WHERE id = ? AND student_id = ?",
      [gradeId, context.student.id]
    );
    if (!grade) {
      return res.status(404).json({ error: "Rueckgabe nicht gefunden." });
    }
    if (!grade.grade_template_id) {
      return res.status(400).json({ error: "Nachrichten sind nur fuer Rueckgaben aus Pruefungen moeglich." });
    }

    const message = String(req.body?.message || "").trim();
    if (!message) {
      return res.status(400).json({ error: "Bitte eine Nachricht eingeben." });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: "Die Nachricht darf maximal 1000 Zeichen lang sein." });
    }

    await runAsync(
      `UPDATE grade_messages
       SET student_hidden_at = NULL
       WHERE grade_id = ? AND student_id = ? AND student_hidden_at IS NOT NULL`,
      [gradeId, context.student.id]
    );
    await runAsync(
      "INSERT INTO grade_messages (grade_id, student_id, student_message) VALUES (?,?,?)",
      [gradeId, context.student.id, message]
    );
    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/returns/:gradeId/messages/hide", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const gradeId = Number(req.params.gradeId);
    if (!gradeId) {
      return res.status(400).json({ error: "Ungueltige Rueckgabe-ID." });
    }

    const grade = await getAsync(
      "SELECT id, grade_template_id FROM grades WHERE id = ? AND student_id = ?",
      [gradeId, context.student.id]
    );
    if (!grade) {
      return res.status(404).json({ error: "Rueckgabe nicht gefunden." });
    }
    if (!grade.grade_template_id) {
      return res.status(400).json({ error: "Tickets sind nur fuer Rueckgaben aus Pruefungen verfuegbar." });
    }

    await runAsync(
      `UPDATE grade_messages
       SET student_hidden_at = current_timestamp
       WHERE grade_id = ? AND student_id = ? AND student_hidden_at IS NULL`,
      [gradeId, context.student.id]
    );

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/returns/:gradeId/messages/seen", async (req, res, next) => {
  try {
    const context = await getStudentContext(req);
    if (!context) {
      return res.status(404).json({ error: "Student nicht gefunden." });
    }

    const gradeId = Number(req.params.gradeId);
    if (!gradeId) {
      return res.status(400).json({ error: "Ungueltige Rueckgabe-ID." });
    }

    const grade = await getAsync("SELECT id FROM grades WHERE id = ? AND student_id = ?", [
      gradeId,
      context.student.id
    ]);
    if (!grade) {
      return res.status(404).json({ error: "Rueckgabe nicht gefunden." });
    }

    await runAsync(
      `UPDATE grade_messages
       SET teacher_reply_seen_at = current_timestamp
       WHERE grade_id = ? AND student_id = ? AND teacher_reply IS NOT NULL AND teacher_reply_seen_at IS NULL`,
      [gradeId, context.student.id]
    );
    return res.json({ ok: true });
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
