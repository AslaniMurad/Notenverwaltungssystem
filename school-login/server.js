//require("dotenv").config(); // optional, falls .env genutzt
const path = require("path");
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const { db, hashPassword, verifyPassword } = require("./db");

const app = express();
app.use(express.urlencoded({ extended: true })); // für HTML-Form
app.use(express.json());

// ---- Sessions (MemoryStore reicht für Demo/Entwicklung) ----
app.use(session({
  name: "sid",
  secret: process.env.SESSION_SECRET || "change-me-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // bei HTTPS auf true setzen!
    maxAge: 1000 * 60 * 60 // 1h
  }
}));

// ---- CSRF ----
const csrfProtection = csrf();
app.use(csrfProtection);

// ---- kleine Security-Header (ohne Zusatzpaket) ----
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=()");
  next();
});

// ---- Helfer-Middlewares ----
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  if (req.session.user.status !== "active") return res.status(403).send("Account gesperrt.");
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) return res.status(403).send("Forbidden");
    next();
  };
}

// ---- HTML Seiten ----
app.get("/", requireAuth, (req, res) => {
  const { email, role } = req.session.user;
  res.send(`
    <!doctype html><meta charset="utf-8">
    <h1>Dashboard</h1>
    <p>Eingeloggt als <b>${email}</b> (${role})</p>
    <nav>
      ${role === "admin" ? `<a href="/admin">Admin-Bereich</a> | ` : ""}
      <form method="POST" action="/logout" style="display:inline">
        <input type="hidden" name="_csrf" value="${req.csrfToken()}">
        <button>Logout</button>
      </form>
    </nav>
  `);
});

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  const token = req.csrfToken();
  res.send(`
    <!doctype html><meta charset="utf-8">
    <style>
      body{font-family:system-ui;max-width:380px;margin:4rem auto;padding:1rem}
      input,button{padding:.6rem;font-size:1rem;width:100%;margin:.3rem 0}
      .box{border:1px solid #ddd;padding:1rem;border-radius:.5rem}
    </style>
    <h1>Login</h1>
    <div class="box">
      <form method="POST" action="/login">
        <input type="hidden" name="_csrf" value="${token}">
        <label>E-Mail</label>
        <input type="email" name="email" required autofocus>
        <label>Passwort</label>
        <input type="password" name="password" required>
        <button type="submit">Einloggen</button>
      </form>
    </div>
  `);
});

app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).send("Fehlende Felder.");

  db.get("SELECT id, email, password_hash, role, status FROM users WHERE email = ?", [email], (err, user) => {
    if (err) return res.status(500).send("DB-Fehler.");
    if (!user || !verifyPassword(user.password_hash, password)) {
      // einfache, generische Fehlermeldung
      return res.status(401).send("Login fehlgeschlagen.");
    }
    if (user.status !== "active") return res.status(403).send("Account gesperrt.");

    req.session.user = { id: user.id, email: user.email, role: user.role, status: user.status };
    res.redirect("/");
  });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// ---- Admin-Bereich: Nutzer anlegen (ohne E-Mail, direktes Setzen eines Passworts) ----
app.get("/admin", requireAuth, requireRole("admin"), (req, res) => {
  res.send(`
    <!doctype html><meta charset="utf-8">
    <h1>Admin</h1>
    <h3>Neuen Nutzer anlegen</h3>
    <form method="POST" action="/admin/users">
      <input type="hidden" name="_csrf" value="${req.csrfToken()}">
      <label>E-Mail</label><br>
      <input name="email" type="email" required><br>
      <label>Rolle</label><br>
      <select name="role">
        <option value="student">student</option>
        <option value="teacher">teacher</option>
        <option value="admin">admin</option>
      </select><br>
      <label>Initial-Passwort</label><br>
      <input name="password" type="password" required minlength="8"><br><br>
      <button>Nutzer anlegen</button>
    </form>
    <p><a href="/">Zurück</a></p>
  `);
});

app.post("/admin/users", requireAuth, requireRole("admin"), (req, res) => {
  const { email, role, password } = req.body || {};
  if (!email || !role || !password) return res.status(400).send("Fehlende Felder.");

  const hash = hashPassword(password);
  db.run(
    "INSERT INTO users (email, password_hash, role, status) VALUES (?,?,?, 'active')",
    [email, hash, role],
    function(err) {
      if (err) {
        if (String(err).includes("UNIQUE")) return res.status(409).send("E-Mail existiert bereits.");
        return res.status(500).send("DB-Fehler.");
      }
      res.redirect("/admin");
    }
  );
});

// ---- Beispiel-geschützte Route für Lehrer ----
app.get("/teacher/area", requireAuth, (req, res) => {
  if (req.session.user.role !== "teacher" && req.session.user.role !== "admin") {
    return res.status(403).send("Nur für Lehrer/Admin.");
  }
  res.send("<h1>Lehrerbereich</h1>");
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft: http://localhost:${PORT}`));
