// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const { db, verifyPassword } = require("./db");
const { requireAuth, requireRole } = require("./middleware/auth");

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
  secret: "change-this-session-secret", // in echt aus ENV
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,         // bei HTTPS auf true setzen
    maxAge: 1000 * 60 * 60 // 1h
  }
}));

// --- CSRF ---
const csrfProtection = csrf();
app.use(csrfProtection);

// --- Simple Security Headers ---
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// --- Startseite (nach Login) ---
app.get("/", requireAuth, (req, res) => {
  const { email, role } = req.session.user;
  res.render("dashboard", { email, role, csrfToken: req.csrfToken() });
});

// --- Login Seite (Dark, clean) ---
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { csrfToken: req.csrfToken() });
});

// --- Admin: mount router (statt einzelne /admin routes hier) ---
const adminRouter = require("./routes/admin");
app.use("/admin", adminRouter);

// --- Schüler-Dashboard ---
function placeholderCollection(size) {
  return Array.from({ length: size }, () => ({
    label: "Test",
    value: "Test",
    detail: "Test"
  }));
}

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
      res.redirect("/");
    }
  );
});

// --- Logout ---
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});
// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft: http://localhost:${PORT}`);
});

