const express = require("express");
const router = express.Router();
const { db, hashPassword } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const INITIAL_PASSWORD = "2025!HTL";

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
    const users = await allAsync(
      "SELECT id, email, role, status, created_at, must_change_password FROM users ORDER BY id DESC"
    );
    res.render("admin/users", {
      users,
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
        message: "E‑Mail existiert bereits.",
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
        message: "E‑Mail existiert bereits.",
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
      message: "Bitte alle Pflichtfelder ausfüllen.",
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
      message: "Bitte alle Pflichtfelder ausfüllen.",
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

    const students = await allAsync(
      "SELECT id, name, email FROM students WHERE class_id = ? ORDER BY name",
      [classId]
    );

    res.render("admin/class-students", {
      classData,
      students,
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
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/classes/:id/students/add", async (req, res, next) => {
  const classId = req.params.id;
  const { name, email } = req.body || {};
  if (!name || !email) {
    return res.status(400).render("error", {
      message: "Bitte Name und E-Mail angeben.",
      status: 400,
      backUrl: `/admin/classes/${classId}/students/add`,
      csrfToken: req.csrfToken()
    });
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

    const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [email]);
    if (!userRow || userRow.role !== "student") {
      return res.render("admin/add-student", {
        classData,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: `/admin/classes/${classId}/students/add`,
        error: "E-Mail nicht gefunden oder nicht als Schüler registriert."
      });
    }

    const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [email, classId]);
    if (duplicate) {
      return res.render("admin/add-student", {
        classData,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: `/admin/classes/${classId}/students/add`,
        error: "Dieser Schüler ist bereits in der Klasse."
      });
    }

    await runAsync("INSERT INTO students (name, email, class_id) VALUES (?,?,?)", [name, email, classId]);
    res.redirect(`/admin/classes/${classId}/students`);
  } catch (err) {
    console.error("DB error adding student:", err);
    next(err);
  }
});

module.exports = router;
