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

// --- Startseite (Dashboard-Zwischenfenster nach Login) ---
app.get("/", requireAuth, (req, res) => {
  const { email, role } = req.session.user;
  res.render("dashboard", { email, role, csrfToken: req.csrfToken() });
});

// --- Login Seite (Dark, clean) ---
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", { csrfToken: req.csrfToken() });
});

// --- Admin UI: User anlegen ---
app.get("/admin", requireAuth, requireRole("admin"), (req, res) => {
  res.render("admin", { csrfToken: req.csrfToken() });
});

// --- Lehrer-Dashboard ---
app.get("/teacher-dashboard", requireAuth, requireRole("teacher"), (req, res) => {
  const { email } = req.session.user;
  res.render("teacher-dashboard", { email, csrfToken: req.csrfToken() });
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

      // Alle gehen erst zum Zwischenfenster
      return res.redirect("/");
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
