const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const csrf = require("csurf");
const { db } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { deriveNameFromEmail } = require("../utils/studentName");

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

router.use(requireAuth, requireRole("teacher"));

const csrfProtection = csrf({
  value: (req) =>
    (req.body && req.body._csrf) ||
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"]
});
const GRADE_ATTACHMENT_DIR = path.join(__dirname, "..", "uploads", "grade-attachments");
const MAX_GRADE_FILE_MB = Math.max(1, Number(process.env.GRADE_FILE_MAX_MB) || 10);
const MAX_GRADE_FILE_BYTES = MAX_GRADE_FILE_MB * 1024 * 1024;
const ALLOWED_GRADE_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png"]);
const ALLOWED_GRADE_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const MAGIC_BYTES = new Map([
  ["application/pdf", Buffer.from("%PDF-")],
  ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
  ["image/jpg", Buffer.from([0xff, 0xd8, 0xff])]
]);

fs.mkdirSync(GRADE_ATTACHMENT_DIR, { recursive: true });

const SPECIAL_ASSESSMENT_TYPES = ["PrÃ¤sentation", "WunschprÃ¼fung", "Benutzerdefiniert"];

function sanitizeFilename(name) {
  return String(name || "datei")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function normalizeExternalLink(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > 2048) {
    return { error: "Der Link ist zu lang." };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "UngÃ¼ltiger Link." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { error: "Der Link muss mit http:// oder https:// beginnen." };
  }
  return { value: url.toString() };
}

async function hasValidFileSignature(filePath, mime) {
  const expected = MAGIC_BYTES.get(mime);
  if (!expected) return false;
  try {
    const handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(expected.length);
    await handle.read(buffer, 0, expected.length, 0);
    await handle.close();
    return buffer.equals(expected);
  } catch {
    return false;
  }
}

async function removeUploadedFile(file) {
  if (!file || !file.path) return;
  try {
    await fs.promises.unlink(file.path);
  } catch {}
}

async function removeStoredAttachment(attachmentPath) {
  if (!attachmentPath) return;
  const baseDir = path.resolve(GRADE_ATTACHMENT_DIR);
  const filePath = path.resolve(path.join(GRADE_ATTACHMENT_DIR, attachmentPath));
  if (!filePath.startsWith(baseDir + path.sep)) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {}
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, GRADE_ATTACHMENT_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = ALLOWED_GRADE_EXTENSIONS.has(ext) ? ext : "";
      const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt}`;
      cb(null, uniqueName);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    if (!ALLOWED_GRADE_EXTENSIONS.has(ext) || !ALLOWED_GRADE_MIME_TYPES.has(mime)) {
      const error = new Error("Unsupported file type");
      error.code = "UNSUPPORTED_FILE_TYPE";
      return cb(error);
    }
    return cb(null, true);
  },
  limits: { fileSize: MAX_GRADE_FILE_BYTES }
});

function runCsrf(req, res) {
  return new Promise((resolve) => {
    csrfProtection(req, res, (err) => resolve(err));
  });
}

function handleUpload(req, res, next) {
  upload.single("attachment_file")(req, res, async (err) => {
    let uploadErr = err;
    try {
      const csrfErr = await runCsrf(req, res);
      if (csrfErr) {
        await removeUploadedFile(req.file);
        return next(csrfErr);
      }
      if (!uploadErr && req.file) {
        const signatureOk = await hasValidFileSignature(
          req.file.path,
          String(req.file.mimetype || "").toLowerCase()
        );
        if (!signatureOk) {
          await removeUploadedFile(req.file);
          uploadErr = new Error("Invalid file signature");
          uploadErr.code = "INVALID_FILE_SIGNATURE";
        }
      }
      if (!uploadErr) return next();

      await removeUploadedFile(req.file);
      const classId = req.params.classId;
      const studentId = req.params.studentId;
      const classData = await loadClassForTeacher(classId, req.session.user.id);
      if (!classData) {
        return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
      }
      const students = await loadStudents(classId);
      const student = students.find((entry) => String(entry.id) === String(studentId));
      if (!student) {
        return renderError(res, req, "SchÃ¼ler nicht gefunden.", 404, `/teacher/students/${classId}`);
      }
      const templates = await loadTemplates(classId);
      const errorMessage =
        uploadErr.code === "LIMIT_FILE_SIZE"
          ? `Datei ist zu groÃŸ. Maximal ${MAX_GRADE_FILE_MB} MB erlaubt.`
          : uploadErr.code === "UNSUPPORTED_FILE_TYPE"
          ? "Nur PDF-, JPG- oder PNG-Dateien sind erlaubt."
          : uploadErr.code === "INVALID_FILE_SIGNATURE"
          ? "Dateiinhalt passt nicht zum Dateityp."
          : "Upload fehlgeschlagen. Bitte erneut versuchen.";
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: errorMessage,
        maxFileSizeMb: MAX_GRADE_FILE_MB
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  });
}

function renderError(res, req, message, status, backUrl) {
  return res.status(status).render("error", {
    message,
    status,
    backUrl,
    csrfToken: req.csrfToken()
  });
}

async function loadClassForTeacher(classId, teacherId) {
  return getAsync(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, teacherId]
  );
}

async function loadStudents(classId) {
  return allAsync("SELECT id, name, email FROM students WHERE class_id = ? ORDER BY name", [classId]);
}

async function loadTemplates(classId) {
  return allAsync(
    "SELECT id, name, category, weight, date, description FROM grade_templates WHERE class_id = ? ORDER BY date, name",
    [classId]
  );
}

async function loadStudentGrades(studentId) {
  return allAsync(
    `SELECT g.id, g.grade, g.note, g.created_at, g.grade_template_id as template_id, gt.name, gt.category, gt.weight, gt.date, gt.description, c.subject as class_subject, g.attachment_path, g.attachment_original_name, g.attachment_mime, g.attachment_size, g.external_link, 0 as is_special
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

async function loadSpecialAssessments(classId) {
  return allAsync(
    `SELECT sa.id, sa.student_id, s.name AS student_name, sa.type, sa.name, sa.description, sa.weight, sa.grade, sa.created_at
     FROM special_assessments sa
     JOIN students s ON s.id = sa.student_id
     WHERE sa.class_id = ?
     ORDER BY sa.created_at DESC`,
    [classId]
  );
}

function computeWeightedAverage(grades) {
  let weightedSum = 0;
  let weightTotal = 0;

  grades.forEach((grade) => {
    const value = Number(grade.grade);
    const weight = Number(grade.weight || 1);
    if (Number.isNaN(value) || Number.isNaN(weight)) return;
    weightedSum += value * weight;
    weightTotal += weight;
  });

  return weightTotal ? Number((weightedSum / weightTotal).toFixed(2)) : null;
}

router.get("/classes", async (req, res, next) => {
  try {
    const classes = await allAsync(
      "SELECT id, name, subject FROM classes WHERE teacher_id = ? ORDER BY created_at DESC",
      [req.session.user.id]
    );

    res.render("teacher/teacher-classes", {
      email: req.session.user.email,
      classes,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/create-class", (req, res) => {
  res.render("teacher/teacher-create-class", {
    email: req.session.user.email,
    csrfToken: req.csrfToken()
  });
});

router.post("/create-class", async (req, res, next) => {
  try {
    const { name, subject } = req.body || {};
    if (!name || !subject) {
      return renderError(res, req, "Bitte alle Pflichtfelder ausfÃ¼llen.", 400, "/teacher/create-class");
    }

    await runAsync("INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)", [
      name,
      subject,
      req.session.user.id
    ]);
    res.redirect("/teacher/classes");
  } catch (err) {
    next(err);
  }
});

router.post("/delete-class/:id", async (req, res, next) => {
  try {
    const classId = req.params.id;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    await runAsync("DELETE FROM students WHERE class_id = ?", [classId]);
    await runAsync("DELETE FROM classes WHERE id = ?", [classId]);
    res.redirect("/teacher/classes");
  } catch (err) {
    next(err);
  }
});

router.get("/students/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    res.render("teacher/teacher-students", {
      email: req.session.user.email,
      classData,
      students,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/add-student/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    res.render("teacher/teacher-add-student", {
      email: req.session.user.email,
      classData,
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/add-student/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const { name, email } = req.body || {};
    const resolvedEmail = String(email || "").trim();
    let resolvedName = String(name || "").trim();
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    if (!resolvedEmail) {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Bitte E-Mail angeben."
      });
    }
    if (!resolvedName) {
      const derived = deriveNameFromEmail(resolvedEmail);
      if (derived) {
        resolvedName = derived;
      } else {
        return res.status(400).render("teacher/teacher-add-student", {
          email: req.session.user.email,
          classData,
          csrfToken: req.csrfToken(),
          error: "Bitte Name angeben (oder E-Mail im Format vorname.nachname@xy)."
        });
      }
    }

    const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [resolvedEmail]);
    if (!userRow || userRow.role !== "student") {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "E-Mail nicht gefunden oder nicht als SchǬler registriert."
      });
    }

    const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [resolvedEmail, classId]);
    if (duplicate) {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Dieser SchǬler ist bereits in der Klasse."
      });
    }

    await runAsync("INSERT INTO students (name, email, class_id) VALUES (?,?,?)", [resolvedName, resolvedEmail, classId]);
    res.redirect(`/teacher/students/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-student/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    await runAsync("DELETE FROM students WHERE id = ? AND class_id = ?", [studentId, classId]);
    res.redirect(`/teacher/students/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/grades/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const templates = await loadTemplates(classId);
    const possibleCount = templates.length;
    const studentsWithGrades = await Promise.all(
      students.map(async (student) => {
        const grades = await loadStudentGrades(student.id);
        const average = computeWeightedAverage(grades);
        return {
          ...student,
          grade_count: grades.length,
          average_grade: average
        };
      })
    );

    res.render("teacher/teacher-grades", {
      email: req.session.user.email,
      classData,
      students: studentsWithGrades,
      possibleCount,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/student-grades/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "SchÃ¼ler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const gradeRows = await loadStudentGrades(student.id);
    const grades = gradeRows.map((row) => {
      const hasAttachment = Boolean(row.attachment_path);
      return {
        id: row.id,
        grade: row.grade,
        note: row.note,
        category: row.category,
        weight: row.weight,
        template_name: row.name,
        template_date: row.date,
        is_special: Boolean(row.is_special),
        has_attachment: hasAttachment,
        attachment_name: row.attachment_original_name || null,
        attachment_delete_action: hasAttachment
          ? `/teacher/delete-grade-attachment/${classId}/${row.id}`
          : null,
        delete_action: row.is_special
          ? `/teacher/delete-special-assessment/${classId}/${row.id}`
          : `/teacher/delete-grade/${classId}/${row.id}`
      };
    });
    const average = computeWeightedAverage(gradeRows);

    res.render("teacher/teacher-student-grades", {
      email: req.session.user.email,
      classData,
      student,
      grades,
      average,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/delete-grade/:classId/:gradeId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const gradeId = req.params.gradeId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const gradeRow = await getAsync(
      "SELECT attachment_path FROM grades WHERE id = ? AND class_id = ?",
      [gradeId, classId]
    );
    await runAsync("DELETE FROM grades WHERE id = ? AND class_id = ?", [gradeId, classId]);
    await removeStoredAttachment(gradeRow?.attachment_path);
    const backUrl = req.get("referer") || `/teacher/grades/${classId}`;
    res.redirect(backUrl);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-grade-attachment/:classId/:gradeId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const gradeId = req.params.gradeId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const gradeRow = await getAsync(
      "SELECT attachment_path FROM grades WHERE id = ? AND class_id = ?",
      [gradeId, classId]
    );
    if (!gradeRow) {
      return renderError(res, req, "Note nicht gefunden.", 404, `/teacher/student-grades/${classId}`);
    }

    await runAsync(
      "UPDATE grades SET attachment_path = NULL, attachment_original_name = NULL, attachment_mime = NULL, attachment_size = NULL WHERE id = ? AND class_id = ?",
      [gradeId, classId]
    );
    await removeStoredAttachment(gradeRow.attachment_path);

    const backUrl = req.get("referer") || `/teacher/grades/${classId}`;
    res.redirect(backUrl);
  } catch (err) {
    next(err);
  }
});

router.get("/add-grade/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "SchÃ¼ler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const templates = await loadTemplates(classId);
    res.render("teacher/teacher-add-grade", {
      email: req.session.user.email,
      classData,
      student,
      templates,
      csrfToken: req.csrfToken(),
      error: null,
      maxFileSizeMb: MAX_GRADE_FILE_MB
    });
  } catch (err) {
    next(err);
  }
});

router.post("/add-grade/:classId/:studentId", handleUpload, async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const { grade_template_id, grade, note, external_link } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      await removeUploadedFile(req.file);
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      await removeUploadedFile(req.file);
      return renderError(res, req, "SchÃ¼ler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const templates = await loadTemplates(classId);
    if (!grade_template_id || !grade) {
      await removeUploadedFile(req.file);
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: "Bitte alle Pflichtfelder ausfÃ¼llen.",
        maxFileSizeMb: MAX_GRADE_FILE_MB
      });
    }

    const gradeValue = Number(grade);
    if (!Number.isFinite(gradeValue) || gradeValue < 1 || gradeValue > 5) {
      await removeUploadedFile(req.file);
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: "Note muss zwischen 1 und 5 liegen.",
        maxFileSizeMb: MAX_GRADE_FILE_MB
      });
    }

    const linkResult = normalizeExternalLink(external_link);
    if (linkResult.error) {
      await removeUploadedFile(req.file);
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: linkResult.error,
        maxFileSizeMb: MAX_GRADE_FILE_MB
      });
    }

    if (req.file && linkResult.value) {
      await removeUploadedFile(req.file);
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: "Bitte entweder eine Datei hochladen oder einen Link angeben, nicht beides.",
        maxFileSizeMb: MAX_GRADE_FILE_MB
      });
    }

    const templateRow = await getAsync(
      "SELECT id FROM grade_templates WHERE id = ? AND class_id = ?",
      [grade_template_id, classId]
    );
    if (!templateRow) {
      await removeUploadedFile(req.file);
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: "PrÃ¼fungsvorlage nicht gefunden.",
        maxFileSizeMb: MAX_GRADE_FILE_MB
      });
    }

    const attachmentPath = req.file ? req.file.filename : null;
    const attachmentOriginalName = req.file ? sanitizeFilename(req.file.originalname) : null;
    const attachmentMime = req.file ? req.file.mimetype : null;
    const attachmentSize = req.file ? req.file.size : null;

    try {
      await runAsync(
        "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note, attachment_path, attachment_original_name, attachment_mime, attachment_size, external_link) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
          studentId,
          classId,
          grade_template_id,
          gradeValue,
          note || null,
          attachmentPath,
          attachmentOriginalName,
          attachmentMime,
          attachmentSize,
          linkResult.value
        ]
      );
      await runAsync("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [
        studentId,
        "Neue Note eingetragen.",
        "grade"
      ]);
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        await removeUploadedFile(req.file);
        return res.status(409).render("teacher/teacher-add-grade", {
          email: req.session.user.email,
          classData,
          student,
          templates,
          csrfToken: req.csrfToken(),
          error: "Diese PrÃ¼fung wurde bereits benotet.",
          maxFileSizeMb: MAX_GRADE_FILE_MB
        });
      }
      throw err;
    }

    res.redirect(`/teacher/student-grades/${classId}/${studentId}`);
  } catch (err) {
    await removeUploadedFile(req.file);
    next(err);
  }
});

router.get("/grade-templates/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const templates = await loadTemplates(classId);
    const totalWeight = Number(
      templates.reduce((sum, template) => sum + Number(template.weight || 0), 0).toFixed(2)
    );

    res.render("teacher/teacher-grade-templates", {
      email: req.session.user.email,
      classData,
      templates,
      totalWeight,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/create-template/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    res.render("teacher/teacher-create-template", {
      email: req.session.user.email,
      classData,
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/create-template/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const { name, category, weight, date, description } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const weightValue = Number(weight);
    if (!name || !category || !Number.isFinite(weightValue)) {
      return res.status(400).render("teacher/teacher-create-template", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Bitte alle Pflichtfelder ausfÃ¼llen."
      });
    }
    if (weightValue < 0 || weightValue > 100) {
      return res.status(400).render("teacher/teacher-create-template", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Gewichtung muss zwischen 0 und 100 liegen."
      });
    }

    await runAsync(
      "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
      [classId, name, category, weightValue, date || null, description || null]
    );
    res.redirect(`/teacher/grade-templates/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-template/:classId/:templateId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const templateId = req.params.templateId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const templateRow = await getAsync(
      "SELECT id FROM grade_templates WHERE id = ? AND class_id = ?",
      [templateId, classId]
    );
    if (!templateRow) {
      return renderError(res, req, "PrÃ¼fung nicht gefunden.", 404, `/teacher/grade-templates/${classId}`);
    }

    await runAsync("DELETE FROM grade_templates WHERE id = ? AND class_id = ?", [templateId, classId]);
    res.redirect(`/teacher/grade-templates/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/special-assessments/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const assessments = await loadSpecialAssessments(classId);
    const selectedStudent = req.query.student_id ? String(req.query.student_id) : "";

    res.render("teacher/teacher-special-assessments", {
      email: req.session.user.email,
      classData,
      students,
      assessments,
      specialTypes: SPECIAL_ASSESSMENT_TYPES,
      formData: {
        student_id: selectedStudent,
        type: "",
        name: "",
        description: "",
        weight: "",
        grade: ""
      },
      error: null,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/special-assessments/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const { student_id, type, name, description, weight, grade } = req.body || {};
    const selectedStudent = students.find((entry) => String(entry.id) === String(student_id));
    const trimmedType = String(type || "").trim();
    const trimmedName = String(name || "").trim();
    const trimmedDescription = String(description || "").trim();
    const weightValue = Number(weight);
    const gradeValue = Number(grade);

    const isTypeValid = SPECIAL_ASSESSMENT_TYPES.includes(trimmedType);
    const resolvedName =
      trimmedName || (trimmedType && trimmedType !== "Benutzerdefiniert" ? trimmedType : "");

    if (!selectedStudent || !isTypeValid || !Number.isFinite(weightValue) || !Number.isFinite(gradeValue)) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: "Bitte alle Pflichtfelder korrekt ausfÃ¼llen.",
        csrfToken: req.csrfToken()
      });
    }

    if (trimmedType === "Benutzerdefiniert" && !resolvedName) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: "Bitte eine Bezeichnung fÃ¼r die benutzerdefinierte Sonderleistung angeben.",
        csrfToken: req.csrfToken()
      });
    }

    if (weightValue < 0 || weightValue > 100) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: "Gewichtung muss zwischen 0 und 100 liegen.",
        csrfToken: req.csrfToken()
      });
    }

    if (gradeValue < 1 || gradeValue > 5) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: "Note muss zwischen 1 und 5 liegen.",
        csrfToken: req.csrfToken()
      });
    }

    await runAsync(
      "INSERT INTO special_assessments (student_id, class_id, type, name, description, weight, grade) VALUES (?,?,?,?,?,?,?)",
      [
        selectedStudent.id,
        classId,
        trimmedType,
        resolvedName,
        trimmedDescription || null,
        weightValue,
        gradeValue
      ]
    );
    await runAsync("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [
      selectedStudent.id,
      "Neue Sonderleistung eingetragen.",
      "grade"
    ]);

    res.redirect(`/teacher/special-assessments/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-special-assessment/:classId/:assessmentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const assessmentId = req.params.assessmentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const assessmentRow = await getAsync(
      "SELECT id FROM special_assessments WHERE id = ? AND class_id = ?",
      [assessmentId, classId]
    );
    if (!assessmentRow) {
      return renderError(res, req, "Sonderleistung nicht gefunden.", 404, `/teacher/special-assessments/${classId}`);
    }

    await runAsync("DELETE FROM special_assessments WHERE id = ? AND class_id = ?", [assessmentId, classId]);
    const backUrl = req.get("referer") || `/teacher/special-assessments/${classId}`;
    res.redirect(backUrl);
  } catch (err) {
    next(err);
  }
});

router.get("/class-statistics/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const templates = await loadTemplates(classId);
    const studentMap = new Map(students.map((student) => [String(student.id), student]));
    const gradesByStudent = new Map();

    for (const student of students) {
      const grades = await loadStudentGrades(student.id);
      gradesByStudent.set(String(student.id), grades);
    }

    const templateStats = templates.map((template) => {
      const templateGrades = [];

      gradesByStudent.forEach((grades, studentId) => {
        const student = studentMap.get(studentId);
        grades.forEach((grade) => {
          if (grade.is_special) return;
          const matchesById =
            grade.template_id && Number(grade.template_id) === Number(template.id);
          const matchesByName = !grade.template_id && grade.name === template.name;
          if (!matchesById && !matchesByName) return;

          const value = Number(grade.grade);
          if (Number.isNaN(value)) return;
          templateGrades.push({ value, studentName: student?.name || "" });
        });
      });

      const values = templateGrades.map((entry) => entry.value);
      const average = values.length
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
        : null;
      const bestGrade = values.length ? Math.min(...values) : null;
      const worstGrade = values.length ? Math.max(...values) : null;

      const bestStudents =
        bestGrade == null
          ? []
          : templateGrades
              .filter((entry) => entry.value === bestGrade)
              .map((entry) => entry.studentName)
              .filter(Boolean);
      const worstStudents =
        worstGrade == null
          ? []
          : templateGrades
              .filter((entry) => entry.value === worstGrade)
              .map((entry) => entry.studentName)
              .filter(Boolean);

      return {
        ...template,
        average,
        graded_count: values.length,
        best_grade: bestGrade,
        worst_grade: worstGrade,
        best_students: bestStudents,
        worst_students: worstStudents
      };
    });

    const allValues = [];
    let weightedSum = 0;
    let weightTotal = 0;

    gradesByStudent.forEach((grades) => {
      grades.forEach((grade) => {
        const value = Number(grade.grade);
        const weight = Number(grade.weight || 1);
        if (Number.isNaN(value) || Number.isNaN(weight)) return;
        allValues.push(value);
        weightedSum += value * weight;
        weightTotal += weight;
      });
    });

    const overallAverage = allValues.length
      ? Number((allValues.reduce((sum, value) => sum + value, 0) / allValues.length).toFixed(2))
      : null;
    const overallWeightedAverage = weightTotal
      ? Number((weightedSum / weightTotal).toFixed(2))
      : null;

    res.render("teacher/teacher-class-statistics", {
      email: req.session.user.email,
      classData,
      studentCount: students.length,
      overallWeightedAverage,
      overallAverage,
      templateStats,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  if (req.file) {
    return removeUploadedFile(req.file)
      .then(() => next(err))
      .catch(() => next(err));
  }
  return next(err);
});

module.exports = router;

