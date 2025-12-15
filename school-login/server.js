// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const { db, verifyPassword, hashPassword } = require("./db");
const { requireAuth, requireRole } = require("./middleware/auth");
const adminRoutes = require("./routes/admin");
const studentRoutes = require("./routes/student");

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

// --- Schüler: Daten- und Dashboard-Routen ---
app.use("/student", studentRoutes);

// --- Login POST ---
app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).send("Fehlende Felder.");

  db.get(
    "SELECT id, email, password_hash, role, status FROM users WHERE email = ?",
    [email],
    (err, user) => {
      if (err) return res.status(500).send("DB-Fehler.");
      if (!user || !verifyPassword(user.password_hash, password)) {
        return res.status(401).send("Login fehlgeschlagen.");
      }
      if (user.status !== "active") {
        return res.status(403).send("Account gesperrt.");
      }

      req.session.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status
      };
      // immer auf die zentrale Startseite leiten, die anhand der Rolle weiterleitet
      return res.redirect("/");
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
