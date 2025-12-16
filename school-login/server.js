// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const { db, verifyPassword, hashPassword } = require("./db");
const { requireAuth, requireRole } = require("./middleware/auth");
const adminRoutes = require("./routes/admin");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// set view engine & static
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

// --- Session ---
app.use(session({
  name: "sid",
  secret: "change-this-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60
  }
}));

app.use((req, res, next) => {
  const { user } = req.session || {};
  if (user && user.mustChangePassword && !req.path.startsWith("/force-password-change") && req.path !== "/logout") {
    return res.redirect("/force-password-change");
  }
  next();
});

// --- CSRF ---
const csrfProtection = csrf();
app.use(csrfProtection);

// --- CSRF Error Handler ---
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).send('Ungültiges CSRF-Token. Bitte lade die Seite neu oder melde dich erneut an.');
  }
  next(err);
});

// --- Simple Security Headers ---
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// --- Helper: Zielpfad anhand der Rolle
function redirectByRole(role) {
  if (role === "admin") return "/admin";
  if (role === "teacher") return "/teacher/classes";
  if (role === "student") return "/student";
  return "/login";
}

// --- Startseite (nach Login) ---
app.get("/", requireAuth, (req, res) => {
  const { role } = req.session.user;
  return res.redirect(redirectByRole(role));
});

// --- Login Seite ---
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect(redirectByRole(req.session.user.role));
  res.render("login", { csrfToken: req.csrfToken() });
});

// --- Admin: mount router (statt einzelne /admin routes hier) ---
app.use("/admin", adminRoutes);

// --- Schüler-Dashboard ---
app.get("/student", requireAuth, requireRole("student"), (req, res) => {
  const hero = {
    headline: "Dein Dashboard",
    statement: "Alles Wichtige für deinen Schultag.",
    summary: "Aufgaben, Noten, Rückgaben, Materialien – übersichtlich und schnell erreichbar.",
    badges: ["Schüler-Sicht", "HTL Waidhofen/Ybbs"]
  };

  const studentProfile = {
    name: "Max Muster",
    class: "3AHWII",
    badges: ["Informatik-Schwerpunkt", "HTL-Waidhofen"],
    meta: [
      { label: "Klasse", value: "3AHWII" },
      { label: "⌀ Note", value: "2,1" },
      { label: "Offene Aufgaben", value: "2" },
      { label: "Neue Rückgaben", value: "1" }
    ]
  };

  const focusStats = [
    { label: "Nächste Abgabe", value: "Heute, 14:00", detail: "Chemie-Protokoll" },
    { label: "Tests diese Woche", value: "2", detail: "Mathe / Informatik" },
    { label: "Neue Materialien", value: "3", detail: "Seit gestern" }
  ];

  const tasks = [
    {
      id: 1,
      title: "Chemie – Laborprotokoll",
      subject: "Chemie",
      due: "Heute 14:00",
      status: "Offen",
      teacher: "Frau Bauer",
      description: "Versuch dokumentieren und Kurve einzeichnen.",
      attachments: ["chemie_arbeitsblatt.pdf"]
    },
    {
      id: 2,
      title: "Informatik – HTML/CSS Mini-Projekt",
      subject: "Informatik",
      due: "Montag 23:59",
      status: "In Arbeit",
      teacher: "Herr Leitner",
      description: "Kleine Website erstellen und ZIP-Datei abgeben.",
      attachments: []
    }
  ];

  const returns = [
    {
      title: "Mathematik – 1. Test",
      subject: "Mathematik",
      grade: "2",
      teacher: "Frau König",
      feedback: "Gute Leistung, nur Fehler bei Gleichungen.",
      attachments: ["mathe_test_loesung.pdf"]
    }
  ];

  const grades = [
    { subject: "Mathematik", grade: "2", teacher: "Frau König", weight: "40%" },
    { subject: "Informatik", grade: "1-", teacher: "Herr Leitner", weight: "35%" }
  ];

  const materials = [
    { title: "HTML Grundlagen", subject: "Informatik", fileName: "html_grundlagen.pdf" },
    { title: "Lineare Funktionen", subject: "Mathematik", fileName: "lineare_funktionen.pdf" }
  ];

  const messages = [
    { title: "Info zum Projekt", sender: "Herr Leitner", excerpt: "Bitte Ideen bis Mittwoch abgeben.", unread: true }
  ];

  res.render("student-dashboard", {
    email: req.session.user.email,
    hero,
    studentProfile,
    focusStats,
    tasks,
    returns,
    grades,
    materials,
    messages,
    csrfToken: req.csrfToken()
  });
});

// --- Login POST ---
app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).render("login", {
      csrfToken: req.csrfToken(),
      errorType: "invalid",
      email,
      errorMessage: "Bitte E-Mail und Passwort eingeben."
    });

  db.get(
    "SELECT id, email, password_hash, role, status, must_change_password FROM users WHERE email = ?",
    [email],
    (err, user) => {
      if (err)
        return res.status(500).render("login", {
          csrfToken: req.csrfToken(),
          errorType: "invalid",
          email,
          errorMessage: "Es gab ein Problem mit der Anmeldung. Bitte versuche es erneut."
        });

      const passwordValid = user && verifyPassword(user.password_hash, password);

      if (!user || !passwordValid) {
        return res.status(401).render("login", {
          csrfToken: req.csrfToken(),
          errorType: "invalid",
          email,
          errorMessage: "Der Login ist fehlgeschlagen, versuchen Sie es erneut."
        });
      }
      if (user.status !== "active") {
        return res.status(403).render("login", {
          csrfToken: req.csrfToken(),
          errorType: "locked",
          lockedInfo: { id: user.id, email: user.email }
        });
      }

      req.session.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        mustChangePassword: !!user.must_change_password
      };
      return res.redirect(req.session.user.mustChangePassword ? "/force-password-change" : redirectByRole(user.role));
    }
  );
});

app.get("/force-password-change", requireAuth, (req, res) => {
  if (!req.session.user?.mustChangePassword) {
    return res.redirect(redirectByRole(req.session.user.role));
  }
  res.render("force-password-change", {
    csrfToken: req.csrfToken(),
    email: req.session.user.email
  });
});

app.post("/force-password-change", requireAuth, (req, res, next) => {
  const { newPassword } = req.body || {};
  if (!newPassword) {
    return res.status(400).render("force-password-change", {
      csrfToken: req.csrfToken(),
      email: req.session.user.email,
      error: "Bitte ein neues Passwort festlegen."
    });
  }

  const hash = hashPassword(newPassword);
  const userId = req.session.user.id;
  db.run(
    "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
    [hash, userId],
    (err) => {
      if (err) {
        console.error("Fehler beim Aktualisieren des Passworts:", err);
        return next(err);
      }
      req.session.user.mustChangePassword = false;
      return res.redirect(redirectByRole(req.session.user.role));
    }
  );
});

// --- Logout ---
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ============================
// TEACHER ROUTES
// ============================

// --- Meine Klassen anzeigen ---
app.get("/teacher/classes", requireAuth, requireRole("teacher"), (req, res) => {
  const teacher_id = req.session.user.id;
  db.all(
    "SELECT id, name, subject FROM classes WHERE teacher_id = ? ORDER BY created_at DESC",
    [teacher_id],
    (err, classes) => {
      if (err) return res.status(500).send("DB-Fehler");
      res.render("teacher-classes", {
        classes: classes || [],
        email: req.session.user.email,
        csrfToken: req.csrfToken()
      });
    }
  );
});

// --- Lehrer-Startseite ---
app.get("/teacher", requireAuth, requireRole("teacher"), (req, res) => {
  res.redirect("/teacher/classes");
});

// --- Klasse erstellen (GET - Form anzeigen) ---
app.get("/teacher/create-class", requireAuth, requireRole("teacher"), (req, res) => {
  res.render("teacher-create-class", { 
    email: req.session.user.email, 
    csrfToken: req.csrfToken() 
  });
});

// --- Klasse erstellen (POST) ---
app.post("/teacher/create-class", requireAuth, requireRole("teacher"), (req, res) => {
  const { name, subject } = req.body || {};
  if (!name || !subject) return res.status(400).send("Fehlende Felder.");

  const teacher_id = req.session.user.id;
  db.run(
    "INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)",
    [name, subject, teacher_id],
    function (err) {
      if (err) return res.status(500).send("DB-Fehler: " + err.message);
      res.redirect("/teacher/classes");
    }
  );
});

// --- Klasse löschen (POST) ---
app.post("/teacher/delete-class/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const teacher_id = req.session.user.id;

  // Prüfe, ob Klasse dem Lehrer gehört
  db.get("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [class_id, teacher_id], (err, classRow) => {
    if (err || !classRow) return res.status(403).send("Forbidden");

    // Lösche erst alle Schüler der Klasse
    db.run("DELETE FROM students WHERE class_id = ?", [class_id], (err) => {
      if (err) return res.status(500).send("DB-Fehler");

      // Dann lösche die Klasse
      db.run("DELETE FROM classes WHERE id = ?", [class_id], (err) => {
        if (err) return res.status(500).send("DB-Fehler");
        res.redirect("/teacher/classes");
      });
    });
  });
});

// --- Schüler einer Klasse anzeigen ---
app.get("/teacher/students/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");

      db.all(
        "SELECT id, name, email FROM students WHERE class_id = ? ORDER BY name",
        [class_id],
        (err, students) => {
          if (err) return res.status(500).send("DB-Fehler");
          res.render("teacher-students", {
            classData,
            students: students || [],
            email: req.session.user.email,
            csrfToken: req.csrfToken()
          });
        }
      );
    }
  );
});

// --- Schüler zu Klasse hinzufügen (GET - Form) ---
app.get("/teacher/add-student/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");
      res.render("teacher-add-student", { 
        classData, 
        csrfToken: req.csrfToken(), 
        email: req.session.user.email,
        error: null 
      });
    }
  );
});

// --- Schüler zu Klasse hinzufügen (POST) ---
app.post("/teacher/add-student/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const { name, email: studentEmail } = req.body || {};
  const teacher_id = req.session.user.id;
  const teacherEmail = req.session.user.email;
  
  if (!name || !studentEmail) return res.status(400).send("Fehlende Felder.");

  db.get(
    "SELECT id, name FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err) {
        console.error("DB-Fehler bei Klassenabfrage:", err);
        return res.status(500).send("DB-Fehler: " + err.message);
      }
      if (!classData) return res.status(403).send("Klasse nicht gefunden");

      // Prüfe, ob die E-Mail als Nutzer mit Rolle 'student' existiert
      db.get("SELECT id, role FROM users WHERE email = ?", [studentEmail], (err, userRow) => {
        if (err) {
          console.error("DB-Fehler bei User-Abfrage:", err);
          return res.status(500).send("DB-Fehler: " + err.message);
        }
        if (!userRow || userRow.role !== "student") {
          return res.render("teacher-add-student", {
            classData,
            csrfToken: req.csrfToken(),
            email: teacherEmail,
            error: "E-Mail nicht gefunden oder nicht als Schüler registriert."
          });
        }

        // Verhindere Duplikate
        db.get("SELECT id FROM students WHERE email = ? AND class_id = ?", [studentEmail, class_id], (err, existing) => {
          if (err) {
            console.error("DB-Fehler bei Duplikat-Prüfung:", err);
            return res.status(500).send("DB-Fehler: " + err.message);
          }
          if (existing) {
            return res.render("teacher-add-student", {
              classData,
              csrfToken: req.csrfToken(),
              email: teacherEmail,
              error: "Dieser Schüler ist bereits in der Klasse."
            });
          }

          // Einfügen
          db.run("INSERT INTO students (name, email, class_id) VALUES (?,?,?)", [name, studentEmail, class_id], function (err) {
            if (err) {
              console.error("DB-Fehler beim Einfügen:", err);
              return res.status(500).send("DB-Fehler: " + err.message);
            }
            res.redirect("/teacher/students/" + class_id);
          });
        });
      });
    }
  );
});

// --- Start ---
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server läuft: http://localhost:${PORT}`);
  });
}

module.exports = app;