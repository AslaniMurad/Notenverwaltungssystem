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
      return res.redirect(redirectByRole(user.role));
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

          // Prüfe, ob Schüler bereits in einer anderen Klasse existiert (für konsistenten Namen)
          db.get("SELECT name FROM students WHERE email = ? LIMIT 1", [studentEmail], (err, existingStudent) => {
            if (err) {
              console.error("DB-Fehler bei Name-Prüfung:", err);
              return res.status(500).send("DB-Fehler: " + err.message);
            }
            
            // Wenn Schüler bereits existiert, prüfe ob Name übereinstimmt
            if (existingStudent && existingStudent.name !== name) {
              return res.render("teacher-add-student", {
                classData,
                csrfToken: req.csrfToken(),
                email: teacherEmail,
                error: `Name stimmt nicht überein. In der Datenbank ist der Schüler als "${existingStudent.name}" gespeichert.`
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
      });
    }
  );
});

// --- Schüler aus Klasse entfernen (POST) ---
app.post("/teacher/delete-student/:class_id/:student_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id, student_id } = req.params;
  const teacher_id = req.session.user.id;

  // Prüfe, ob Klasse dem Lehrer gehört
  db.get("SELECT id FROM classes WHERE id = ? AND teacher_id = ?", [class_id, teacher_id], (err, classRow) => {
    if (err || !classRow) return res.status(403).send("Forbidden");

    // Lösche Schüler aus der Klasse
    db.run("DELETE FROM students WHERE id = ? AND class_id = ?", [student_id, class_id], (err) => {
      if (err) return res.status(500).send("DB-Fehler");
      res.redirect("/teacher/students/" + class_id);
    });
  });
});

// ============================
// NOTEN ROUTES
// ============================

// --- Template-Verwaltung für Klasse ---
app.get("/teacher/grade-templates/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");

      db.all(
        "SELECT id, name, category, weight, date, description FROM grade_templates WHERE class_id = ? ORDER BY date, name",
        [class_id],
        (err, templates) => {
          if (err) return res.status(500).send("DB-Fehler");

          // Berechne Gesamtgewichtung
          const totalWeight = templates.reduce((sum, t) => sum + t.weight, 0);

          res.render("teacher-grade-templates", {
            classData,
            templates: templates || [],
            totalWeight,
            email: req.session.user.email,
            csrfToken: req.csrfToken()
          });
        }
      );
    }
  );
});

// --- Template erstellen (GET) ---
app.get("/teacher/create-template/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");

      res.render("teacher-create-template", {
        classData,
        email: req.session.user.email,
        csrfToken: req.csrfToken(),
        error: null
      });
    }
  );
});

// --- Template erstellen (POST) ---
app.post("/teacher/create-template/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const { name, category, weight, date, description } = req.body || {};
  const teacher_id = req.session.user.id;

  if (!name || !category || !weight) {
    return res.status(400).send("Name, Kategorie und Gewichtung sind erforderlich.");
  }

  const weightNum = parseFloat(weight);
  if (isNaN(weightNum) || weightNum < 0 || weightNum > 100) {
    return res.status(400).send("Gewichtung muss zwischen 0 und 100 liegen.");
  }

  db.get(
    "SELECT id FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Forbidden");

      db.run(
        "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
        [class_id, name, category, weightNum, date || null, description || null],
        function (err) {
          if (err) {
            console.error("DB-Fehler beim Erstellen des Templates:", err);
            return res.status(500).send("DB-Fehler: " + err.message);
          }
          res.redirect(`/teacher/grade-templates/${class_id}`);
        }
      );
    }
  );
});

// --- Template löschen (POST) ---
app.post("/teacher/delete-template/:class_id/:template_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id, template_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Forbidden");

      db.run("DELETE FROM grade_templates WHERE id = ? AND class_id = ?", [template_id, class_id], (err) => {
        if (err) return res.status(500).send("DB-Fehler");
        res.redirect(`/teacher/grade-templates/${class_id}`);
      });
    }
  );
});

// --- Notenübersicht einer Klasse ---
app.get("/teacher/grades/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");

      // Hole alle Templates für Gewichtungsberechnung
      db.all(
        "SELECT id, weight FROM grade_templates WHERE class_id = ?",
        [class_id],
        (err, templates) => {
          if (err) return res.status(500).send("DB-Fehler");

          const totalWeight = templates.reduce((sum, t) => sum + t.weight, 0);

          // Hole alle Schüler mit gewichteten Noten
          db.all(
            `SELECT 
              s.id, 
              s.name, 
              s.email
            FROM students s
            WHERE s.class_id = ?
            ORDER BY s.name`,
            [class_id],
            (err, students) => {
              if (err) return res.status(500).send("DB-Fehler");

              // Für jeden Schüler gewichteten Durchschnitt berechnen
              let completed = 0;
              students.forEach(student => {
                db.all(
                  `SELECT g.grade, gt.weight 
                   FROM grades g 
                   JOIN grade_templates gt ON g.grade_template_id = gt.id 
                   WHERE g.student_id = ? AND g.class_id = ?`,
                  [student.id, class_id],
                  (err, grades) => {
                    if (err) {
                      student.grade_count = 0;
                      student.average_grade = null;
                    } else {
                      student.grade_count = grades.length;
                      if (grades.length > 0 && totalWeight > 0) {
                        const weightedSum = grades.reduce((sum, g) => sum + (g.grade * g.weight), 0);
                        const usedWeight = grades.reduce((sum, g) => sum + g.weight, 0);
                        student.average_grade = (weightedSum / usedWeight).toFixed(2);
                      } else {
                        student.average_grade = null;
                      }
                    }

                    completed++;
                    if (completed === students.length) {
                      res.render("teacher-grades", {
                        classData,
                        students,
                        email: req.session.user.email,
                        csrfToken: req.csrfToken()
                      });
                    }
                  }
                );
              });

              if (students.length === 0) {
                res.render("teacher-grades", {
                  classData,
                  students: [],
                  email: req.session.user.email,
                  csrfToken: req.csrfToken()
                });
              }
            }
          );
        }
      );
    }
  );
});

// --- Noten eines Schülers anzeigen ---
app.get("/teacher/student-grades/:class_id/:student_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id, student_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");

      db.get(
        "SELECT id, name, email FROM students WHERE id = ? AND class_id = ?",
        [student_id, class_id],
        (err, student) => {
          if (err || !student) return res.status(404).send("Schüler nicht gefunden");

          // Hole Noten mit Template-Info
          db.all(
            `SELECT 
              g.id,
              g.grade,
              g.note,
              g.created_at,
              gt.name as template_name,
              gt.category,
              gt.weight,
              gt.date as template_date
             FROM grades g 
             JOIN grade_templates gt ON g.grade_template_id = gt.id
             WHERE g.student_id = ? AND g.class_id = ?
             ORDER BY gt.date DESC, gt.name`,
            [student_id, class_id],
            (err, grades) => {
              if (err) return res.status(500).send("DB-Fehler");

              // Berechne gewichteten Durchschnitt
              let average = null;
              if (grades.length > 0) {
                const totalWeightedGrade = grades.reduce((sum, g) => sum + (g.grade * g.weight), 0);
                const totalWeight = grades.reduce((sum, g) => sum + g.weight, 0);
                if (totalWeight > 0) {
                  average = (totalWeightedGrade / totalWeight).toFixed(2);
                }
              }

              res.render("teacher-student-grades", {
                classData,
                student,
                grades: grades || [],
                average,
                email: req.session.user.email,
                csrfToken: req.csrfToken()
              });
            }
          );
        }
      );
    }
  );
});

// --- Note hinzufügen (GET - Form) ---
app.get("/teacher/add-grade/:class_id/:student_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id, student_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");

      db.get(
        "SELECT id, name, email FROM students WHERE id = ? AND class_id = ?",
        [student_id, class_id],
        (err, student) => {
          if (err || !student) return res.status(404).send("Schüler nicht gefunden");

          // Hole verfügbare Templates
          db.all(
            "SELECT id, name, category, weight, date FROM grade_templates WHERE class_id = ? ORDER BY date, name",
            [class_id],
            (err, templates) => {
              if (err) return res.status(500).send("DB-Fehler");

              // Prüfe welche Templates schon vergeben sind
              db.all(
                "SELECT grade_template_id FROM grades WHERE student_id = ? AND class_id = ?",
                [student_id, class_id],
                (err, existingGrades) => {
                  if (err) return res.status(500).send("DB-Fehler");

                  const usedTemplateIds = existingGrades.map(g => g.grade_template_id);
                  const availableTemplates = templates.filter(t => !usedTemplateIds.includes(t.id));

                  res.render("teacher-add-grade", {
                    classData,
                    student,
                    templates: availableTemplates,
                    email: req.session.user.email,
                    csrfToken: req.csrfToken(),
                    error: null
                  });
                }
              );
            }
          );
        }
      );
    }
  );
});

// --- Note hinzufügen (POST) ---
app.post("/teacher/add-grade/:class_id/:student_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id, student_id } = req.params;
  const { grade_template_id, grade, note } = req.body || {};
  const teacher_id = req.session.user.id;

  if (!grade_template_id || !grade) {
    return res.status(400).send("Template und Note sind erforderlich.");
  }

  const gradeNum = parseFloat(grade);
  if (isNaN(gradeNum) || gradeNum < 1 || gradeNum > 5) {
    return res.status(400).send("Note muss zwischen 1 und 5 liegen.");
  }

  db.get(
    "SELECT id FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Forbidden");

      // Prüfe ob Template zur Klasse gehört
      db.get(
        "SELECT id FROM grade_templates WHERE id = ? AND class_id = ?",
        [grade_template_id, class_id],
        (err, template) => {
          if (err || !template) return res.status(400).send("Ungültiges Template");

          db.run(
            "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
            [student_id, class_id, grade_template_id, gradeNum, note || null],
            function (err) {
              if (err) {
                console.error("DB-Fehler beim Einfügen der Note:", err);
                if (err.message.includes("UNIQUE constraint")) {
                  return res.status(400).send("Für dieses Template wurde bereits eine Note vergeben.");
                }
                return res.status(500).send("DB-Fehler: " + err.message);
              }
              res.redirect(`/teacher/student-grades/${class_id}/${student_id}`);
            }
          );
        }
      );
    }
  );
});

// --- Note löschen (POST) ---
app.post("/teacher/delete-grade/:class_id/:grade_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id, grade_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Forbidden");

      // Hole student_id vor dem Löschen für Redirect
      db.get("SELECT student_id FROM grades WHERE id = ?", [grade_id], (err, gradeRow) => {
        if (err || !gradeRow) return res.status(404).send("Note nicht gefunden");

        db.run("DELETE FROM grades WHERE id = ? AND class_id = ?", [grade_id, class_id], (err) => {
          if (err) return res.status(500).send("DB-Fehler");
          res.redirect(`/teacher/student-grades/${class_id}/${gradeRow.student_id}`);
        });
      });
    }
  );
});

// --- Klassenstatistiken anzeigen ---
app.get("/teacher/class-statistics/:class_id", requireAuth, requireRole("teacher"), (req, res) => {
  const { class_id } = req.params;
  const teacher_id = req.session.user.id;

  db.get(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [class_id, teacher_id],
    (err, classData) => {
      if (err || !classData) return res.status(403).send("Klasse nicht gefunden");

      // Hole alle Templates
      db.all(
        "SELECT id, name, category, weight, date FROM grade_templates WHERE class_id = ? ORDER BY date, name",
        [class_id],
        (err, templates) => {
          if (err) return res.status(500).send("DB-Fehler");

          // Hole Anzahl Schüler
          db.get(
            "SELECT COUNT(*) as student_count FROM students WHERE class_id = ?",
            [class_id],
            (err, countResult) => {
              if (err) return res.status(500).send("DB-Fehler");

              const studentCount = countResult.student_count;

              // Für jedes Template Statistiken berechnen
              let completed = 0;
              const templateStats = [];

              if (templates.length === 0) {
                return res.render("teacher-class-statistics", {
                  classData,
                  templateStats: [],
                  overallAverage: null,
                  overallWeightedAverage: null,
                  studentCount,
                  email: req.session.user.email,
                  csrfToken: req.csrfToken()
                });
              }

              templates.forEach(template => {
                db.all(
                  `SELECT g.grade, s.name as student_name
                   FROM grades g
                   JOIN students s ON g.student_id = s.id
                   WHERE g.grade_template_id = ? AND g.class_id = ?`,
                  [template.id, class_id],
                  (err, grades) => {
                    const stat = {
                      ...template,
                      graded_count: grades ? grades.length : 0,
                      average: null,
                      best_grade: null,
                      worst_grade: null,
                      best_students: [],
                      worst_students: []
                    };

                    if (grades && grades.length > 0) {
                      const sum = grades.reduce((acc, g) => acc + g.grade, 0);
                      stat.average = (sum / grades.length).toFixed(2);
                      stat.best_grade = Math.min(...grades.map(g => g.grade));
                      stat.worst_grade = Math.max(...grades.map(g => g.grade));
                      
                      stat.best_students = grades
                        .filter(g => g.grade === stat.best_grade)
                        .map(g => g.student_name);
                      
                      stat.worst_students = grades
                        .filter(g => g.grade === stat.worst_grade)
                        .map(g => g.student_name);
                    }

                    templateStats.push(stat);
                    completed++;

                    if (completed === templates.length) {
                      // Berechne Gesamtdurchschnitt
                      const templatesWithGrades = templateStats.filter(t => t.average !== null);
                      let overallAverage = null;
                      let overallWeightedAverage = null;

                      if (templatesWithGrades.length > 0) {
                        // Ungewichteter Durchschnitt
                        const avgSum = templatesWithGrades.reduce((sum, t) => sum + parseFloat(t.average), 0);
                        overallAverage = (avgSum / templatesWithGrades.length).toFixed(2);

                        // Gewichteter Durchschnitt
                        const weightedSum = templatesWithGrades.reduce((sum, t) => sum + (parseFloat(t.average) * t.weight), 0);
                        const totalWeight = templatesWithGrades.reduce((sum, t) => sum + t.weight, 0);
                        if (totalWeight > 0) {
                          overallWeightedAverage = (weightedSum / totalWeight).toFixed(2);
                        }
                      }

                      // Sortiere nach Datum
                      templateStats.sort((a, b) => {
                        if (!a.date && !b.date) return a.name.localeCompare(b.name);
                        if (!a.date) return 1;
                        if (!b.date) return -1;
                        return new Date(a.date) - new Date(b.date);
                      });

                      res.render("teacher-class-statistics", {
                        classData,
                        templateStats,
                        overallAverage,
                        overallWeightedAverage,
                        studentCount,
                        email: req.session.user.email,
                        csrfToken: req.csrfToken()
                      });
                    }
                  }
                );
              });
            }
          );
        }
      );
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