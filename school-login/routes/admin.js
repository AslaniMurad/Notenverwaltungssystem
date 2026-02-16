const express = require("express");
const router = express.Router();
const { db, hashPassword } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getPasswordValidationError } = require("../utils/password");
const { deriveNameFromEmail } = require("../utils/studentName");

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

router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res, next) => {
  try {
    const [userCount, classCount, studentCount] = await Promise.all([
      getAsync("SELECT COUNT(*) AS count FROM users"),
      getAsync("SELECT COUNT(*) AS count FROM classes"),
      getAsync("SELECT COUNT(*) AS count FROM students")
    ]);

    res.render("admin/home", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
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
      message: "FÃ¼r Lehrer darf kein Initial-Passwort vergeben werden.",
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
    await runAsync(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [email, hash, role, "active", mustChange]
    );
    res.redirect("/admin/users?created=1");
  } catch (err) {
    console.error("DB error inserting user:", err);
    if (String(err).includes("UNIQUE")) {
      return res.status(409).render("error", {
        message: "Eâ€‘Mail existiert bereits.",
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
      message: "Bitte wÃ¤hle eine Rolle fÃ¼r neue Nutzer.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }
  if (wantsInitial && bulkRole === "teacher") {
    return res.status(400).render("error", {
      message: "Lehrer dÃ¼rfen kein Initial-Passwort erhalten.",
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
    if (user.role === "teacher") {
      classes = await allAsync(
        "SELECT id, name, subject FROM classes WHERE teacher_id = ? ORDER BY created_at DESC",
        [user.id]
      );
    } else if (user.role === "student") {
      classes = await allAsync(
        `SELECT s.id AS student_id, s.name AS student_name, s.email AS student_email, s.school_year,
                c.id AS class_id, c.name AS class_name, c.subject, u.email AS teacher_email
         FROM students s
         JOIN classes c ON c.id = s.class_id
         LEFT JOIN users u ON u.id = c.teacher_id
         WHERE s.email = ?
         ORDER BY c.name`,
        [user.email]
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
        message: "Eâ€‘Mail existiert bereits.",
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

  if (!wantsInitial && !password)
    return res.status(400).render("error", {
      message: "Kein Passwort angegeben.",
      status: 400,
      backUrl,
      csrfToken: req.csrfToken()
    });

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
  const q = req.query.q;
  const params = [];
  let whereClause = "";
  if (q) {
    whereClause = "WHERE c.name LIKE ? OR c.subject LIKE ? OR u.email LIKE ?";
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  try {
    const classes = await allAsync(
      `SELECT c.id, c.name, c.subject, c.created_at, u.email AS teacher_email, u.id AS teacher_id
       FROM classes c
       LEFT JOIN users u ON c.teacher_id = u.id
       ${whereClause}
       ORDER BY c.created_at DESC`,
      params
    );

    res.render("admin/classes", {
      classes,
      query: q || "",
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
    const teachers = await allAsync(
      "SELECT id, email FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY email ASC"
    );
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
  const { name, subject, teacher_id } = req.body || {};
  if (!name || !subject || !teacher_id) {
    return res.status(400).render("error", {
      message: "Bitte alle Pflichtfelder ausfÃ¼llen.",
      status: 400,
      backUrl: "/admin/classes/new",
      csrfToken: req.csrfToken()
    });
  }
  try {
    await runAsync("INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)", [name, subject, teacher_id]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error creating class:", err);
    next(err);
  }
});

router.get("/classes/:id/edit", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const [classData, teachers] = await Promise.all([
      getAsync(
        `SELECT c.id, c.name, c.subject, c.teacher_id, u.email AS teacher_email
         FROM classes c
         LEFT JOIN users u ON c.teacher_id = u.id
         WHERE c.id = ?`,
        [classId]
      ),
      allAsync(
        "SELECT id, email FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY email ASC"
      )
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
  const { name, subject, teacher_id } = req.body || {};
  if (!name || !subject || !teacher_id) {
    return res.status(400).render("error", {
      message: "Bitte alle Pflichtfelder ausfÃ¼llen.",
      status: 400,
      backUrl: `/admin/classes/${classId}/edit`,
      csrfToken: req.csrfToken()
    });
  }

  try {
    await runAsync("UPDATE classes SET name = ?, subject = ?, teacher_id = ? WHERE id = ?", [name, subject, teacher_id, classId]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error updating class:", err);
    next(err);
  }
});

router.post("/classes/:id/delete", async (req, res, next) => {
  const classId = req.params.id;
  try {
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

    const classData = await getAsync(
      `SELECT c.id, c.name, c.subject, u.email AS teacher_email
       FROM classes c
       LEFT JOIN users u ON c.teacher_id = u.id
       WHERE c.id = ?`,
      [classId]
    );

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
    const classData = await getAsync("SELECT id, name, subject FROM classes WHERE id = ?", [classId]);
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
    const classData = await getAsync("SELECT id, name FROM classes WHERE id = ?", [classId]);
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
    const classData = await getAsync("SELECT id, name FROM classes WHERE id = ?", [classId]);
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

    await runAsync("INSERT INTO students (name, email, class_id) VALUES (?,?,?)", [resolvedName, resolvedEmail, classId]);
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
    const classData = await getAsync("SELECT id, name FROM classes WHERE id = ?", [classId]);
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
          reason: "Schueler ist bereits in der Klasse."
        });
        continue;
      }

      try {
        await runAsync("INSERT INTO students (name, email, class_id) VALUES (?,?,?)", [derivedName, email, classId]);
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

module.exports = router;

