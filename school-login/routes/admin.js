const express = require("express");
const router = express.Router();
const { db, hashPassword } = require("../db");
const schoolYearModel = require("../models/schoolYearModel");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createAuditLogMiddleware } = require("../middleware/audit");
const { getPasswordValidationError } = require("../utils/password");
const { deriveNameFromEmail } = require("../utils/studentName");
const { getDisplayName } = require("../utils/userDisplay");

const INITIAL_PASSWORD = process.env.INITIAL_PASSWORD || null;

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

function parseAuditFilters(req) {
  const actor = String(req.query.actor || "").trim();
  const action = String(req.query.action || "").trim();
  const entity = String(req.query.entity || "").trim();
  return { actor, action, entity };
}

function buildAuditWhereClause(filters = {}) {
  const where = [];
  const params = [];

  if (filters.actor) {
    where.push("LOWER(actor_email) LIKE LOWER(?)");
    params.push(`%${filters.actor}%`);
  }
  if (filters.action) {
    where.push("LOWER(action) LIKE LOWER(?)");
    params.push(`%${filters.action}%`);
  }
  if (filters.entity) {
    where.push("LOWER(entity_type) = LOWER(?)");
    params.push(filters.entity);
  }

  return {
    whereClause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

async function fetchAuditLogCount(filters) {
  const { whereClause, params } = buildAuditWhereClause(filters);
  const row = await getAsync(
    `SELECT COUNT(*) AS count
     FROM audit_logs
     ${whereClause}`,
    params
  );
  return Number(row?.count || 0);
}

async function fetchAuditLogsPage({ filters, beforeId = null, afterId = null, limit = 100 }) {
  const { whereClause, params } = buildAuditWhereClause(filters);
  const clauses = whereClause ? [whereClause.slice(6)] : [];
  const queryParams = [...params];

  if (beforeId != null) {
    clauses.push("id < ?");
    queryParams.push(Number(beforeId));
  }
  if (afterId != null) {
    clauses.push("id > ?");
    queryParams.push(Number(afterId));
  }

  const combinedWhere = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await allAsync(
    `SELECT id, actor_email, actor_role, action, entity_type, entity_id, http_method, route_path, status_code, created_at
     FROM audit_logs
     ${combinedWhere}
     ORDER BY id DESC
     LIMIT ?`,
    [...queryParams, Number(limit)]
  );

  return rows;
}

async function getActiveSchoolYearOrThrow() {
  const activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
  if (!activeSchoolYear) {
    throw new Error("Kein aktives Schuljahr vorhanden.");
  }
  return activeSchoolYear;
}

async function getActiveClassById(classId, columns = "id, name") {
  const activeSchoolYear = await getActiveSchoolYearOrThrow();
  return getAsync(
    `SELECT ${columns}
     FROM classes
     WHERE id = ? AND school_year_id = ?`,
    [classId, activeSchoolYear.id]
  );
}

async function listActiveTeachers() {
  return allAsync(
    "SELECT id, email FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY email ASC"
  );
}

function buildTeacherDirectory(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    map.set(Number(row.id), {
      id: Number(row.id),
      email: String(row.email || "").trim(),
      display_name: getDisplayName({ email: row.email }) || String(row.email || "").trim()
    });
  });
  return map;
}

function normalizeOptionalTeacherId(value) {
  if (value == null || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function summarizeAssignmentsByClass(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const classId = Number(row.class_id);
    if (!map.has(classId)) {
      map.set(classId, {
        subjectSet: new Set(),
        teacherSet: new Set(),
        assignmentCount: 0
      });
    }
    const entry = map.get(classId);
    if (row.subject_name) entry.subjectSet.add(String(row.subject_name));
    if (row.teacher_email) entry.teacherSet.add(String(row.teacher_email));
    entry.assignmentCount += 1;
  });
  return map;
}

function decorateClassWithAssignments(classRow, assignmentSummary, teacherDirectory = new Map()) {
  const summary = assignmentSummary.get(Number(classRow.id));
  const assignedSubjects = summary ? [...summary.subjectSet].sort((a, b) => a.localeCompare(b)) : [];
  const teacherEmails = summary ? [...summary.teacherSet].sort((a, b) => a.localeCompare(b)) : [];
  const headTeacher = teacherDirectory.get(Number(classRow.head_teacher_id));

  return {
    ...classRow,
    assigned_subjects: assignedSubjects,
    assigned_subjects_label: assignedSubjects.length ? assignedSubjects.join(", ") : "Keine Fachzuordnungen",
    teacher_emails: teacherEmails.length ? teacherEmails.join(", ") : "",
    head_teacher_email: headTeacher?.email || "",
    head_teacher_display_name: headTeacher?.display_name || "",
    teacher_count: teacherEmails.length,
    assignment_count: summary ? summary.assignmentCount : 0
  };
}

function buildClassDetailTables(classId, assignmentRows = [], students = [], teacherDirectory = new Map()) {
  const subjectMap = new Map();
  const teacherMap = new Map();

  assignmentRows
    .filter((row) => Number(row.class_id) === Number(classId))
    .forEach((row) => {
      const subjectName = String(row.subject_name || "").trim();
      const teacherEmail = String(row.teacher_email || "").trim();
      if (!subjectName || !teacherEmail) return;

      if (!subjectMap.has(subjectName)) {
        subjectMap.set(subjectName, {
          name: subjectName,
          teacherSet: new Set()
        });
      }
      subjectMap.get(subjectName).teacherSet.add(teacherEmail);

      if (!teacherMap.has(teacherEmail)) {
        teacherMap.set(teacherEmail, {
          email: teacherEmail,
          display_name: getDisplayName({ email: teacherEmail }) || teacherEmail,
          subjectSet: new Set()
        });
      }
      teacherMap.get(teacherEmail).subjectSet.add(subjectName);
    });

  const subjectRows = [...subjectMap.values()]
    .map((entry) => {
      const teachers = [...entry.teacherSet].sort((a, b) => a.localeCompare(b));
      return {
        name: entry.name,
        teacher_count: teachers.length,
        teacher_emails: teachers.join(", ")
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const teacherRows = [...teacherMap.values()]
    .map((entry) => {
      const subjects = [...entry.subjectSet].sort((a, b) => a.localeCompare(b));
      return {
        email: entry.email,
        display_name: entry.display_name,
        subject_count: subjects.length,
        subjects_label: subjects.join(", "),
        is_head_teacher: false
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));

  const studentRows = [...students].sort((a, b) => {
    const nameResult = String(a.name || "").localeCompare(String(b.name || ""));
    if (nameResult !== 0) return nameResult;
    return String(a.email || "").localeCompare(String(b.email || ""));
  });

  return {
    subjectRows,
    teacherRows,
    studentRows,
    stats: {
      teacher_count: teacherRows.length,
      student_count: studentRows.length,
      subject_count: subjectRows.length
    }
  };
}

router.use(requireAuth, requireRole("admin"));
router.use(createAuditLogMiddleware());
router.use(async (req, res, next) => {
  try {
    res.locals.activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
  } catch (err) {
    res.locals.activeSchoolYear = null;
  }
  next();
});

router.get("/", async (req, res, next) => {
  try {
    const [userCount, classCount, studentCount, activeSchoolYear] = await Promise.all([
      getAsync("SELECT COUNT(*) AS count FROM users"),
      getAsync("SELECT COUNT(*) AS count FROM classes"),
      getAsync("SELECT COUNT(*) AS count FROM students"),
      schoolYearModel.getActiveSchoolYear()
    ]);

    res.render("admin/home-school-year", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
      activeSchoolYear,
      stats: {
        users: userCount?.count || 0,
        classes: classCount?.count || 0,
        students: studentCount?.count || 0
      }
    });
  } catch (err) {
    console.error("DB error fetching admin home stats:", err);
    next(err);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    const idQuery = String(req.query.id || "").trim();
    const emailQuery = String(req.query.email || "").trim();
    const roleQuery = String(req.query.role || "").trim();

    const filters = [];
    const params = [];

    if (idQuery) {
      const idValue = Number.parseInt(idQuery, 10);
      if (!Number.isNaN(idValue)) {
        filters.push("id = ?");
        params.push(idValue);
      }
    }

    if (emailQuery) {
      filters.push("LOWER(email) LIKE LOWER(?)");
      params.push(`%${emailQuery}%`);
    }

    if (["admin", "teacher", "student"].includes(roleQuery)) {
      filters.push("role = ?");
      params.push(roleQuery);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const users = await allAsync(
      `SELECT id, email, role, status, created_at, must_change_password FROM users ${whereClause} ORDER BY id DESC`,
      params
    );
    res.render("admin/users", {
      users,
      query: { id: idQuery, email: emailQuery, role: roleQuery },
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching users (admin list):", err);
    next(err);
  }
});

router.get("/users/new", (req, res) => {
  res.render("admin/create-user", {
    csrfToken: req.csrfToken(),
    currentUser: req.session.user,
    activePath: req.originalUrl,
    bulkResult: null,
    error: null
  });
});

router.post("/users", async (req, res, next) => {
  const { email, role, password, useInitial } = req.body || {};
  const wantsInitial = useInitial === "on";

  if (!email || !role || (!password && !wantsInitial)) {
    return res.status(400).render("error", {
      message: "Fehlende Felder beim Erstellen eines Nutzers.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }
  if (role === "teacher" && wantsInitial) {
    return res.status(400).render("error", {
      message: "Für Lehrer darf kein Initial-Passwort vergeben werden.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }

  if (wantsInitial) {
    if (!INITIAL_PASSWORD) {
      return res.status(400).render("error", {
        message: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      return res.status(400).render("error", {
        message: `Initial-Passwort ist zu schwach: ${initialError}`,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  } else {
    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return res.status(400).render("error", {
        message: passwordError,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  }

  const chosenPassword = wantsInitial ? INITIAL_PASSWORD : password;
  const mustChange = wantsInitial ? 1 : 0;
  const hash = hashPassword(chosenPassword);

  try {
    await runAsync(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [email, hash, role, "active", mustChange]
    );
    res.redirect("/admin/users?created=1");
  } catch (err) {
    console.error("DB error inserting user:", err);
    if (String(err).includes("UNIQUE")) {
      return res.status(409).render("error", {
        message: "E-Mail existiert bereits.",
        status: 409,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
    next(err);
  }
});

router.post("/users/bulk", async (req, res, next) => {
  const { bulkEmails, bulkRole, bulkPassword, bulkUseInitial } = req.body || {};
  const wantsInitial = bulkUseInitial === "on";

  if (!bulkRole) {
    return res.status(400).render("error", {
      message: "Bitte wähle eine Rolle für neue Nutzer.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }
  if (wantsInitial && bulkRole === "teacher") {
    return res.status(400).render("error", {
      message: "Lehrer dürfen kein Initial-Passwort erhalten.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }

  const lines = (bulkEmails || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return res.status(400).render("error", {
      message: "Keine E-Mails zum Anlegen gefunden.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }
  if (!wantsInitial && !bulkPassword) {
    return res.status(400).render("error", {
      message: "Bitte Passwort eingeben oder Initial-Kennwort nutzen.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }

  if (wantsInitial) {
    if (!INITIAL_PASSWORD) {
      return res.status(400).render("error", {
        message: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      return res.status(400).render("error", {
        message: `Initial-Passwort ist zu schwach: ${initialError}`,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  } else {
    const passwordError = getPasswordValidationError(bulkPassword);
    if (passwordError) {
      return res.status(400).render("error", {
        message: passwordError,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  }

  const chosenPassword = wantsInitial ? INITIAL_PASSWORD : bulkPassword;
  const mustChange = wantsInitial ? 1 : 0;
  const hash = hashPassword(chosenPassword);

  const bulkResult = { success: [], failed: [] };

  for (const line of lines) {
    try {
      await runAsync(
        "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
        [line, hash, bulkRole, "active", mustChange]
      );
      bulkResult.success.push(line);
    } catch (err) {
      bulkResult.failed.push({ email: line, reason: String(err) });
    }
  }

  res.render("admin/create-user", {
    csrfToken: req.csrfToken(),
    currentUser: req.session.user,
    activePath: "/admin/users/new",
    bulkResult,
    error: null
  });
});

router.get("/users/:id", async (req, res, next) => {
  const id = req.params.id;
  try {
    const user = await getAsync(
      "SELECT id, email, role, status, created_at, must_change_password FROM users WHERE id = ?",
      [id]
    );
    if (!user) {
      return res.status(404).render("error", {
        message: "Nutzer nicht gefunden.",
        status: 404,
        backUrl: "/admin/users",
        csrfToken: req.csrfToken()
      });
    }

    let classes = [];
    const activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
    if (user.role === "teacher") {
      classes = await allAsync(
        `SELECT cst.id AS assignment_id, c.id, c.name, s.name AS subject
         FROM class_subject_teacher cst
         JOIN classes c ON c.id = cst.class_id
         JOIN subjects s ON s.id = cst.subject_id
         WHERE cst.teacher_id = ? AND cst.school_year_id = ?
         ORDER BY c.created_at DESC`,
        [user.id, activeSchoolYear?.id || 0]
      );
    } else if (user.role === "student") {
      classes = await allAsync(
        `SELECT s.id AS student_id, s.name AS student_name, s.email AS student_email, s.school_year,
                c.id AS class_id, c.name AS class_name, c.subject,
                COALESCE((
                  SELECT STRING_AGG(u2.email, ', ' ORDER BY u2.email)
                  FROM class_subject_teacher cst2
                  JOIN users u2 ON u2.id = cst2.teacher_id
                  WHERE cst2.class_id = c.id
                ), '') AS teacher_emails
         FROM students s
         JOIN classes c ON c.id = s.class_id
         WHERE s.email = ? AND c.school_year_id = ?
         ORDER BY c.name`,
        [user.email, activeSchoolYear?.id || 0]
      );
    }

    res.render("admin/user-details", {
      user,
      classes,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching user detail:", err);
    next(err);
  }
});

router.get("/users/:id/edit", async (req, res, next) => {
  const id = req.params.id;
  try {
    const user = await getAsync(
      "SELECT id, email, role, status, must_change_password FROM users WHERE id = ?",
      [id]
    );
    if (!user)
      return res.status(404).render("error", {
        message: "Nutzer nicht gefunden.",
        status: 404,
        backUrl: "/admin/users",
        csrfToken: req.csrfToken()
      });

    res.render("admin/edit", {
      user,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching user for edit:", err);
    next(err);
  }
});

router.post("/users/:id", async (req, res, next) => {
  const id = req.params.id;
  const { email, role, status } = req.body || {};
  if (!email || !role || !status) {
    return res.status(400).render("error", {
      message: "Fehlende Felder beim Aktualisieren.",
      status: 400,
      backUrl: `/admin/users/${id}/edit`,
      csrfToken: req.csrfToken()
    });
  }

  try {
    await runAsync("UPDATE users SET email = ?, role = ?, status = ? WHERE id = ?", [email, role, status, id]);
    res.redirect("/admin/users");
  } catch (err) {
    console.error("DB error updating user:", err);
    if (String(err).includes("UNIQUE")) {
      return res.status(409).render("error", {
        message: "E-Mail existiert bereits.",
        status: 409,
        backUrl: `/admin/users/${id}/edit`,
        csrfToken: req.csrfToken()
      });
    }
    next(err);
  }
});

router.post("/users/:id/reset", async (req, res, next) => {
  const id = req.params.id;
  const { password, useInitial } = req.body || {};
  const wantsInitial = useInitial === "1";
  const backUrl = wantsInitial ? "/admin/users" : `/admin/users/${id}/edit`;

  if (!wantsInitial && !password) {
    return res.status(400).render("error", {
      message: "Kein Passwort angegeben.",
      status: 400,
      backUrl,
      csrfToken: req.csrfToken()
    });
  }

  if (wantsInitial) {
    if (!INITIAL_PASSWORD) {
      return res.status(400).render("error", {
        message: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
        status: 400,
        backUrl,
        csrfToken: req.csrfToken()
      });
    }

    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      return res.status(400).render("error", {
        message: `Initial-Passwort ist zu schwach: ${initialError}`,
        status: 400,
        backUrl,
        csrfToken: req.csrfToken()
      });
    }
  } else {
    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return res.status(400).render("error", {
        message: passwordError,
        status: 400,
        backUrl,
        csrfToken: req.csrfToken()
      });
    }
  }

  const chosenPassword = wantsInitial ? INITIAL_PASSWORD : password;
  const mustChange = wantsInitial ? 1 : 0;
  const hash = hashPassword(chosenPassword);

  try {
    await runAsync("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?", [hash, mustChange, id]);
    res.redirect("/admin/users");
  } catch (err) {
    console.error("DB error resetting password:", err);
    next(err);
  }
});

router.post("/users/:id/delete", async (req, res, next) => {
  const id = req.params.id;
  try {
    await runAsync("UPDATE users SET status = 'deleted' WHERE id = ?", [id]);
    res.redirect("/admin/users");
  } catch (err) {
    console.error("DB error deleting user:", err);
    next(err);
  }
});

router.get("/classes", async (req, res, next) => {
  try {
    const queryValue = String(req.query.q || "").trim();
    const queryNormalized = queryValue.toLowerCase();
    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    const [classRows, assignmentRows, teachers] = await Promise.all([
      schoolYearModel.listClassesBySchoolYear(activeSchoolYear.id),
      schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id),
      listActiveTeachers()
    ]);
    const teacherDirectory = buildTeacherDirectory(teachers);
    const assignmentSummary = summarizeAssignmentsByClass(assignmentRows);
    const classes = classRows
      .map((row) => decorateClassWithAssignments(row, assignmentSummary, teacherDirectory))
      .filter((row) => {
        if (!queryNormalized) return true;
        return [
          row.name,
          row.assigned_subjects_label,
          row.teacher_emails,
          row.head_teacher_email,
          row.head_teacher_display_name
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(queryNormalized));
      });

    res.render("admin/classes", {
      classes,
      query: queryValue,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching classes:", err);
    next(err);
  }
});

router.get("/classes/new", async (req, res, next) => {
  try {
    const teachers = await listActiveTeachers();
    res.render("admin/create-class", {
      teachers,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    next(err);
  }
});

router.post("/classes", async (req, res, next) => {
  const name = String(req.body?.name || "").trim();
  const headTeacherId = normalizeOptionalTeacherId(req.body?.head_teacher_id);
  if (!name) {
    return res.status(400).render("error", {
      message: "Bitte alle Pflichtfelder ausfüllen.",
      status: 400,
      backUrl: "/admin/classes/new",
      csrfToken: req.csrfToken()
    });
  }
  try {
    const teacherDirectory = buildTeacherDirectory(await listActiveTeachers());
    if (headTeacherId && !teacherDirectory.has(Number(headTeacherId))) {
      return res.status(400).render("error", {
        message: "Klassenvorstand nicht gefunden.",
        status: 400,
        backUrl: "/admin/classes/new",
        csrfToken: req.csrfToken()
      });
    }

    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    await runAsync("INSERT INTO classes (name, subject, subject_id, school_year_id, head_teacher_id) VALUES (?,?,?,?,?)", [
      name,
      null,
      null,
      activeSchoolYear.id,
      headTeacherId
    ]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error creating class:", err);
    next(err);
  }
});

router.get("/classes/:id", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    const [classRow, assignmentRows, students, teachers] = await Promise.all([
      getActiveClassById(classId, "id, name, head_teacher_id, created_at"),
      schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id),
      schoolYearModel.listStudentsByClassId(classId),
      listActiveTeachers()
    ]);

    if (!classRow) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    const teacherDirectory = buildTeacherDirectory(teachers);
    const classAssignments = assignmentRows.filter((row) => Number(row.class_id) === Number(classId));
    const classData = decorateClassWithAssignments(
      classRow,
      summarizeAssignmentsByClass(classAssignments),
      teacherDirectory
    );
    const detailData = buildClassDetailTables(classId, classAssignments, students, teacherDirectory);
    const teacherRows = detailData.teacherRows.map((row) => ({
      ...row,
      is_head_teacher: classData.head_teacher_email
        ? row.email.toLowerCase() === classData.head_teacher_email.toLowerCase()
        : false
    }));

    res.render("admin/class-detail", {
      classData,
      stats: detailData.stats,
      subjectRows: detailData.subjectRows,
      teacherRows,
      students: detailData.studentRows,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error loading class detail:", err);
    next(err);
  }
});

router.get("/classes/:id/edit", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const [classData, teachers] = await Promise.all([
      getActiveClassById(classId, "id, name, head_teacher_id"),
      listActiveTeachers()
    ]);

    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    res.render("admin/edit-class", {
      classData,
      teachers,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching class for edit:", err);
    next(err);
  }
});

router.post("/classes/:id", async (req, res, next) => {
  const classId = req.params.id;
  const name = String(req.body?.name || "").trim();
  const headTeacherId = normalizeOptionalTeacherId(req.body?.head_teacher_id);
  if (!name) {
    return res.status(400).render("error", {
      message: "Bitte alle Pflichtfelder ausfüllen.",
      status: 400,
      backUrl: `/admin/classes/${classId}/edit`,
      csrfToken: req.csrfToken()
    });
  }

  try {
    const teacherDirectory = buildTeacherDirectory(await listActiveTeachers());
    if (headTeacherId && !teacherDirectory.has(Number(headTeacherId))) {
      return res.status(400).render("error", {
        message: "Klassenvorstand nicht gefunden.",
        status: 400,
        backUrl: `/admin/classes/${classId}/edit`,
        csrfToken: req.csrfToken()
      });
    }

    const classData = await getActiveClassById(classId, "id");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    await runAsync("UPDATE classes SET name = ?, subject = ?, subject_id = ?, head_teacher_id = ? WHERE id = ?", [
      name,
      null,
      null,
      headTeacherId,
      classId
    ]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error updating class:", err);
    next(err);
  }
});

router.post("/classes/:id/delete", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const classData = await getActiveClassById(classId, "id");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }
    await runAsync(
      "DELETE FROM grade_notifications WHERE student_id IN (SELECT id FROM students WHERE class_id = ?)",
      [classId]
    );
    await runAsync("DELETE FROM students WHERE class_id = ?", [classId]);
    await runAsync("DELETE FROM classes WHERE id = ?", [classId]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error deleting class:", err);
    next(err);
  }
});

router.get("/classes/:id/students", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const nameQuery = String(req.query.name || "").trim();
    const emailQuery = String(req.query.email || "").trim();

    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    const [classRow, assignmentRows] = await Promise.all([
      getActiveClassById(classId, "id, name"),
      schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id)
    ]);
    const classData = classRow
      ? decorateClassWithAssignments(
          classRow,
          summarizeAssignmentsByClass(assignmentRows.filter((row) => Number(row.class_id) === Number(classId)))
        )
      : null;

    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    const filters = ["class_id = ?"];
    const params = [classId];

    if (nameQuery) {
      filters.push("LOWER(name) LIKE LOWER(?)");
      params.push(`%${nameQuery}%`);
    }

    if (emailQuery) {
      filters.push("LOWER(email) LIKE LOWER(?)");
      params.push(`%${emailQuery}%`);
    }

    const whereClause = `WHERE ${filters.join(" AND ")}`;
    const students = await allAsync(
      `SELECT id, name, email FROM students ${whereClause} ORDER BY name`,
      params
    );

    res.render("admin/class-students", {
      classData,
      students,
      query: { name: nameQuery, email: emailQuery },
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error loading students:", err);
    next(err);
  }
});

router.post("/classes/:classId/students/:studentId/delete", async (req, res, next) => {
  const { classId, studentId } = req.params;
  try {
    const classData = await getActiveClassById(classId, "id, name");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    await runAsync("DELETE FROM grade_notifications WHERE student_id = ?", [studentId]);
    await runAsync("DELETE FROM students WHERE id = ? AND class_id = ?", [studentId, classId]);
    res.redirect(`/admin/classes/${classId}/students`);
  } catch (err) {
    console.error("DB error deleting student from class:", err);
    next(err);
  }
});

router.get("/classes/:id/students/add", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const classData = await getActiveClassById(classId, "id, name");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    res.render("admin/add-student", {
      classData,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
      error: null,
      bulkResult: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/classes/:id/students/add", async (req, res, next) => {
  const classId = req.params.id;
  const { name, email } = req.body || {};
  const resolvedEmail = String(email || "").trim();
  let resolvedName = String(name || "").trim();

  if (!resolvedEmail) {
    return res.status(400).render("error", {
      message: "Bitte E-Mail angeben.",
      status: 400,
      backUrl: `/admin/classes/${classId}/students/add`,
      csrfToken: req.csrfToken()
    });
  }
  if (!resolvedName) {
    const derived = deriveNameFromEmail(resolvedEmail);
    if (derived) {
      resolvedName = derived;
    } else {
      return res.status(400).render("error", {
        message: "Bitte Name angeben (oder E-Mail im Format vorname.nachname@xy).",
        status: 400,
        backUrl: `/admin/classes/${classId}/students/add`,
        csrfToken: req.csrfToken()
      });
    }
  }
  try {
    const [classData, activeSchoolYear] = await Promise.all([
      getActiveClassById(classId, "id, name"),
      getActiveSchoolYearOrThrow()
    ]);
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [resolvedEmail]);
    if (!userRow || userRow.role !== "student") {
      return res.render("admin/add-student", {
        classData,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: `/admin/classes/${classId}/students/add`,
        error: "E-Mail nicht gefunden oder nicht als SchÇ¬ler registriert.",
        bulkResult: null
      });
    }

    const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [resolvedEmail, classId]);
    if (duplicate) {
      return res.render("admin/add-student", {
        classData,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: `/admin/classes/${classId}/students/add`,
        error: "Dieser SchÇ¬ler ist bereits in der Klasse.",
        bulkResult: null
      });
    }

    await runAsync("INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)", [
      resolvedName,
      resolvedEmail,
      classId,
      activeSchoolYear.name
    ]);
    res.redirect(`/admin/classes/${classId}/students`);
  } catch (err) {
    console.error("DB error adding student:", err);
    next(err);
  }
});

router.post("/classes/:id/students/add-bulk", async (req, res, next) => {
  const classId = req.params.id;
  const bulkEmailsRaw = String((req.body && req.body.bulkEmails) || "");
  const lines = bulkEmailsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  try {
    const [classData, activeSchoolYear] = await Promise.all([
      getActiveClassById(classId, "id, name"),
      getActiveSchoolYearOrThrow()
    ]);
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    if (lines.length === 0) {
      return res.status(400).render("admin/add-student", {
        classData,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: `/admin/classes/${classId}/students/add`,
        error: "Bitte E-Mails angeben.",
        bulkResult: null
      });
    }

    const bulkResult = { success: [], failed: [] };

    for (const line of lines) {
      const email = line;
      const derivedName = deriveNameFromEmail(email);
      if (!derivedName) {
        bulkResult.failed.push({
          email,
          reason: "Name fehlt (E-Mail Format vorname.nachname@xy)."
        });
        continue;
      }

      const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [email]);
      if (!userRow || userRow.role !== "student") {
        bulkResult.failed.push({
          email,
          reason: "E-Mail nicht gefunden oder nicht als Student registriert."
        });
        continue;
      }

      const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [email, classId]);
      if (duplicate) {
        bulkResult.failed.push({
          email,
          reason: "Schüler ist bereits in der Klasse."
        });
        continue;
      }

      try {
        await runAsync("INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)", [
          derivedName,
          email,
          classId,
          activeSchoolYear.name
        ]);
        bulkResult.success.push(email);
      } catch (err) {
        bulkResult.failed.push({ email, reason: String(err) });
      }
    }

    return res.render("admin/add-student", {
      classData,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: `/admin/classes/${classId}/students/add`,
      error: null,
      bulkResult
    });
  } catch (err) {
    console.error("DB error adding students in bulk:", err);
    next(err);
  }
});

router.get("/audit-logs", async (req, res, next) => {
  try {
    const filters = parseAuditFilters(req);
    const [logs, totalCount] = await Promise.all([
      fetchAuditLogsPage({ filters, limit: 100 }),
      fetchAuditLogCount(filters)
    ]);

    res.render("admin/audit-logs", {
      logs,
      totalCount,
      query: filters,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error loading audit logs:", err);
    next(err);
  }
});

router.get("/audit-logs/data", async (req, res, next) => {
  try {
    const filters = parseAuditFilters(req);
    const rawBeforeId = req.query.beforeId ? Number(req.query.beforeId) : null;
    const rawAfterId = req.query.afterId ? Number(req.query.afterId) : null;
    const beforeId = Number.isFinite(rawBeforeId) ? rawBeforeId : null;
    const afterId = Number.isFinite(rawAfterId) ? rawAfterId : null;
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, requestedLimit))
      : 100;

    const [logs, totalCount] = await Promise.all([
      fetchAuditLogsPage({ filters, beforeId, afterId, limit }),
      fetchAuditLogCount(filters)
    ]);

    const oldestId = logs.length ? Number(logs[logs.length - 1].id) : null;
    const hasMore = beforeId != null ? logs.length === limit : true;

    return res.json({
      logs,
      hasMore,
      oldestId,
      totalCount
    });
  } catch (err) {
    console.error("DB error loading audit logs data:", err);
    next(err);
  }
});

module.exports = router;

