// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const { db, hashPassword, verifyPassword } = require("./db");

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

// --- Helper ---
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.status !== "active") {
    return res.status(403).send("Account gesperrt.");
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).send("Forbidden");
    }
    next();
  };
}

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

// --- Admin UI: User anlegen (gleiches Dark-Design, minimal) ---
app.get("/admin", requireAuth, requireRole("admin"), (req, res) => {
  res.render("admin", { csrfToken: req.csrfToken() });
});

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
    headline: "Test",
    statement: "Test",
    summary: "Test",
    badges: ["Test", "Test", "Test"],
    meta: [
      { label: "Test", value: "Test" },
      { label: "Test", value: "Test" },
      { label: "Test", value: "Test" }
    ]
  };

  const focusStats = placeholderCollection(4);

  const studyPanels = Array.from({ length: 5 }, () => ({
    title: "Test",
    chip: "Test",
    signal: "Test"
  }));

  const timeline = Array.from({ length: 4 }, () => ({
    badge: "Test",
    title: "Test",
    detail: "Test",
    date: "Test"
  }));

  const routines = Array.from({ length: 4 }, () => ({
    title: "Test",
    detail: "Test",
    emphasis: "Test"
  }));

  const insights = Array.from({ length: 3 }, () => ({
    title: "Test",
    detail: "Test"
  }));

  const goals = Array.from({ length: 3 }, () => ({
    title: "Test",
    due: "Test",
    progress: "Test"
  }));

  res.render("student-dashboard", {
    email: req.session.user.email,
    hero,
    focusStats,
    studyPanels,
    timeline,
    routines,
    insights,
    goals,
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

app.post("/admin/users", requireAuth, requireRole("admin"), (req, res) => {
  const { email, role, password } = req.body || {};
  if (!email || !role || !password) return res.status(400).send("Fehlende Felder.");

  const hash = hashPassword(password);
  db.run(
    "INSERT INTO users (email, password_hash, role, status) VALUES (?,?,?, 'active')",
    [email, hash, role],
    function (err) {
      if (err) {
        if (String(err).includes("UNIQUE")) {
          return res.status(409).send("E-Mail existiert bereits.");
        }
        return res.status(500).send("DB-Fehler.");
      }
      res.redirect("/admin");
    }
  );
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft: http://localhost:${PORT}`);
});
