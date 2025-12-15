// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const { db, verifyPassword, hashPassword } = require("./db");
const { promisify } = require("util");
const { requireAuth, requireRole } = require("./middleware/auth");
const adminRoutes = require("./routes/admin");

const app = express();

const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

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

async function loadStudentFromSession(req) {
  const email = req.session?.user?.email;
  if (!email) throw new Error("Unauthenticated");
  const student = await dbGet(
    "SELECT s.*, c.name as class_name, c.subject as class_subject, c.id as class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.email = ?",
    [email]
  );
  if (!student) {
    const err = new Error("Student not found");
    err.statusCode = 404;
    throw err;
  }
  return student;
}

function filterGrades(grades, { subject, startDate, endDate, sort }) {
  let filtered = [...grades];
  if (subject) filtered = filtered.filter((g) => g.subject === subject);
  if (startDate) filtered = filtered.filter((g) => new Date(g.graded_at) >= new Date(startDate));
  if (endDate) filtered = filtered.filter((g) => new Date(g.graded_at) <= new Date(endDate));

  if (sort === "value") {
    filtered.sort((a, b) => b.value - a.value);
  } else {
    filtered.sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at));
  }
  return filtered;
}

function computeAverages(grades) {
  const subjectMap = new Map();
  grades.forEach((g) => {
    const key = g.subject;
    const entry = subjectMap.get(key) || { weightedSum: 0, weightTotal: 0 };
    entry.weightedSum += g.value * (g.weight || 1);
    entry.weightTotal += g.weight || 1;
    subjectMap.set(key, entry);
  });

  const subjects = Array.from(subjectMap.entries()).map(([subject, data]) => ({
    subject,
    average: data.weightTotal ? Number((data.weightedSum / data.weightTotal).toFixed(2)) : null
  }));

  const totals = subjects.reduce(
    (acc, curr) => {
      if (curr.average == null) return acc;
      const weight = subjectMap.get(curr.subject).weightTotal;
      return {
        weightedSum: acc.weightedSum + curr.average * weight,
        weightTotal: acc.weightTotal + weight
      };
    },
    { weightedSum: 0, weightTotal: 0 }
  );

  const overall = totals.weightTotal ? Number((totals.weightedSum / totals.weightTotal).toFixed(2)) : null;
  return { subjects, overall };
}

function computeTrend(grades) {
  if (!grades.length) return { direction: "steady", change: 0 };
  const sorted = [...grades].sort((a, b) => new Date(a.graded_at) - new Date(b.graded_at));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const change = Number((last.value - first.value).toFixed(2));
  const direction = change < -0.1 ? "improving" : change > 0.1 ? "declining" : "steady";
  return { direction, change };
}

function escapePdf(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildSimplePdf(student, grades, averages) {
  const lines = [
    "Notenübersicht",
    `Schüler: ${student.name} (${student.email})`,
    `Klasse: ${student.class_name || "-"}`,
    `Schuljahr: ${student.school_year || "-"}`,
    "",
    "Noten:"
  ];

  grades
    .sort((a, b) => new Date(b.graded_at) - new Date(a.graded_at))
    .forEach((g) => {
      lines.push(`${g.subject}: ${g.value.toFixed(2)} (Gewichtung ${g.weight || 1}) ${g.teacher ? "- " + g.teacher : ""}`);
      lines.push(`Datum: ${new Date(g.graded_at).toLocaleDateString()}`);
      if (g.comment) lines.push(`Kommentar: ${g.comment}`);
      lines.push("");
    });

  lines.push("Durchschnitt:");
  averages.subjects.forEach((s) => lines.push(`${s.subject}: ${s.average ?? "–"}`));
  lines.push(`Gesamt: ${averages.overall ?? "–"}`);

  const textOps = ["BT /F1 12 Tf 50 760 Td"];
  lines.forEach((line, idx) => {
    textOps.push(`(${escapePdf(line)}) Tj`);
    if (idx !== lines.length - 1) textOps.push("0 -16 Td");
  });
  textOps.push("ET");

  const content = textOps.join("\n");
  const contentBuffer = Buffer.from(content, "utf8");
  const objects = [
    `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n`,
    `2 0 obj<< /Type /Pages /Count 1 /Kids [3 0 R] >>endobj\n`,
    `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n`,
    `4 0 obj<< /Length ${contentBuffer.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    `5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n`
  ];

  let offset = `%PDF-1.4\n`.length;
  const xrefEntries = ["0000000000 65535 f "];
  const body = objects
    .map((obj) => {
      const currentOffset = offset;
      const entry = String(obj);
      xrefEntries.push(`${String(currentOffset).padStart(10, "0")} 00000 n `);
      offset += Buffer.byteLength(entry, "utf8");
      return entry;
    })
    .join("");

  const xrefOffset = offset; // offset already includes header length
  const xref = `xref\n0 ${objects.length + 1}\n${xrefEntries.join("\n")}\n`;
  const trailer = `trailer<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF`;
  const pdf = `%PDF-1.4\n${body}${xref}${trailer}`;
  return Buffer.from(pdf, "utf8");
}

async function loadGrades(studentId) {
  const rows = await dbAll(
    "SELECT id, subject, value, weight, comment, teacher, graded_at, created_at FROM grades WHERE student_id = ?",
    [studentId]
  );
  return (rows || []).map((r) => ({
    ...r,
    value: Number(r.value),
    weight: Number(r.weight || 1)
  }));
}

async function loadClassAverages(classId) {
  const rows = await dbAll(
    "SELECT g.subject, g.value, g.weight FROM grades g JOIN students s ON s.id = g.student_id WHERE s.class_id = ?",
    [classId]
  );
  const grouped = {};
  (rows || []).forEach((row) => {
    const target = grouped[row.subject] || { weightedSum: 0, weightTotal: 0 };
    target.weightedSum += Number(row.value) * Number(row.weight || 1);
    target.weightTotal += Number(row.weight || 1);
    grouped[row.subject] = target;
  });

  return Object.entries(grouped).map(([subject, data]) => ({
    subject,
    average: data.weightTotal ? Number((data.weightedSum / data.weightTotal).toFixed(2)) : null
  }));
}

async function loadNotifications(studentId) {
  const notes = await dbAll(
    "SELECT id, message, type, created_at, read_at FROM grade_notifications WHERE student_id = ? ORDER BY created_at DESC",
    [studentId]
  );
  return notes || [];
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
app.get("/student", requireAuth, requireRole("student"), async (req, res, next) => {
  try {
    const student = await loadStudentFromSession(req);
    const grades = await loadGrades(student.id);
    const averages = computeAverages(grades);
    const classAverages = student.class_id ? await loadClassAverages(student.class_id) : [];
    const notifications = await loadNotifications(student.id);
    const trend = computeTrend(grades);

    const hero = {
      headline: "Dein Dashboard",
      statement: "Alles Wichtige für deinen Schultag.",
      summary: "Aufgaben, Noten, Rückgaben, Materialien – übersichtlich und schnell erreichbar.",
      badges: ["Schüler-Sicht", student.class_name || ""]
    };

    const studentProfile = {
      name: student.name,
      class: student.class_name,
      schoolYear: student.school_year,
      badges: [student.class_subject || ""],
      meta: [
        { label: "Klasse", value: student.class_name || "-" },
        { label: "⌀ Note", value: averages.overall ?? "–" },
        { label: "Schuljahr", value: student.school_year || "–" }
      ]
    };

    const focusStats = [
      { label: "Aktuelle Hinweise", value: notifications.length || 0, detail: "Benachrichtigungen" },
      { label: "Fächer mit Noten", value: averages.subjects.length || 0, detail: "Deine Fächer" },
      { label: "Trend", value: trend.direction === "improving" ? "⬆︎" : trend.direction === "declining" ? "⬇︎" : "→", detail: `${trend.change}` }
    ];

    const tasks = [];
    const returns = [];
    const materials = [];
    const messages = [];
    const subjects = [...new Set(grades.map((g) => g.subject))];

    res.render("student-dashboard", {
      email: req.session.user.email,
      hero,
      studentProfile,
      focusStats,
      tasks,
      returns,
      materials,
      messages,
      csrfToken: req.csrfToken(),
      initialData: JSON.stringify({ grades, averages, classAverages, notifications, trend }),
      subjects
    });
  } catch (err) {
    next(err);
  }
});

// --- Student APIs ---
app.get("/student/profile", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    const grades = await loadGrades(student.id);
    const averages = computeAverages(grades);
    res.json({
      name: student.name,
      email: student.email,
      class: student.class_name,
      classId: student.class_id,
      schoolYear: student.school_year,
      subjects: [...new Set(grades.map((g) => g.subject))],
      averages
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
});

app.get("/student/grades", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    const { subject, startDate, endDate, sort } = req.query;
    if (sort && !["date", "value"].includes(sort)) {
      return res.status(400).json({ error: "Ungültige Sortierung" });
    }

    const grades = await loadGrades(student.id);
    const filtered = filterGrades(grades, { subject, startDate, endDate, sort });
    res.json({ grades: filtered, count: filtered.length });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
});

app.get("/student/averages", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    const grades = await loadGrades(student.id);
    res.json(computeAverages(grades));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
});

app.get("/student/class-averages", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    if (!student.class_id) return res.status(400).json({ error: "Keine Klasse gefunden" });
    const averages = await loadClassAverages(student.class_id);
    res.json({ subjects: averages });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
});

app.get("/student/grades.csv", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    const grades = await loadGrades(student.id);
    const rows = [
      "Subject,Grade,Weight,Teacher,Date,Comment",
      ...grades.map((g) => [g.subject, g.value, g.weight, g.teacher || "", g.graded_at, (g.comment || "").replace(/,/g, ";")].join(","))
    ];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=grades.csv");
    res.send(rows.join("\n"));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
});

app.get("/student/grades.pdf", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    const grades = await loadGrades(student.id);
    const averages = computeAverages(grades);

    const pdfBuffer = buildSimplePdf(student, grades, averages);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=grades.pdf");
    res.send(pdfBuffer);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
});

app.get("/student/notifications", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    const notes = await loadNotifications(student.id);
    res.json({ notifications: notes });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
});

app.post("/student/notifications/:id/read", requireAuth, requireRole("student"), async (req, res) => {
  try {
    const student = await loadStudentFromSession(req);
    const noteId = Number(req.params.id);
    if (Number.isNaN(noteId)) return res.status(400).json({ error: "Ungültige ID" });
    await dbRun("UPDATE grade_notifications SET read_at = current_timestamp WHERE id = ? AND student_id = ?", [noteId, student.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || "Unbekannter Fehler" });
  }
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