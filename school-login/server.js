// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const { db, hashPassword, verifyPassword } = require("./db");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
  res.send(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Dashboard</title>
  <style>
    :root {
      --bg: #050816;
      --bg-elevated: #0f172a;
      --accent: #3b82f6;
      --accent-soft: rgba(59,130,246,.15);
      --text: #e5e7eb;
      --muted: #6b7280;
      --radius-xl: 18px;
      --shadow-soft: 0 18px 40px rgba(15,23,42,.7);
      --font: system-ui, -apple-system, BlinkMacSystemFont, -system-ui, sans-serif;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:var(--font);
      background: radial-gradient(circle at top,#111827 0, #020817 40%, #000 100%);
      color:var(--text);
      min-height:100vh;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:24px;
    }
    .shell{
      width:100%;
      max-width:900px;
      background:linear-gradient(to bottom right, rgba(15,23,42,.96), rgba(2,6,23,.98));
      border-radius:var(--radius-xl);
      padding:22px 24px 20px;
      box-shadow:var(--shadow-soft);
      border:1px solid rgba(148,163,253,.08);
      display:grid;
      grid-template-columns:minmax(0,2fr) minmax(220px,1.4fr);
      gap:22px;
      backdrop-filter: blur(18px);
    }
    .brand{
      display:flex;
      align-items:center;
      gap:10px;
      margin-bottom:10px;
    }
    .logo-dot{
      width:22px;height:22px;
      border-radius:999px;
      background:radial-gradient(circle at 30% 0, #60a5fa, #1d4ed8);
      box-shadow:0 0 18px rgba(37,99,235,.75);
    }
    .brand-title{
      font-size:17px;
      font-weight:600;
      letter-spacing:.08em;
      text-transform:uppercase;
      color:#9ca3af;
    }
    .headline{
      font-size:22px;
      font-weight:600;
      margin-bottom:4px;
      color:#e5e7eb;
    }
    .subline{
      font-size:13px;
      color:var(--muted);
      margin-bottom:14px;
    }
    .pill{
      display:inline-flex;
      align-items:center;
      gap:6px;
      padding:5px 11px;
      border-radius:999px;
      font-size:10px;
      color:#9ca3af;
      background:rgba(15,23,42,.9);
      border:1px solid rgba(75,85,99,.9);
      margin-bottom:10px;
    }
    .pill span.bullet{
      width:7px;height:7px;border-radius:999px;
      background:#22c55e;
      box-shadow:0 0 9px #22c55e;
    }
    .meta{
      display:flex;
      gap:14px;
      margin-top:4px;
      font-size:11px;
      color:var(--muted);
    }
    .meta strong{color:#e5e7eb;font-weight:500}
    .tag{
      padding:3px 8px;
      border-radius:999px;
      border:1px solid rgba(75,85,99,.9);
      font-size:10px;
      color:#9ca3af;
    }
    .right-box{
      align-self:stretch;
      background:radial-gradient(circle at top, var(--accent-soft), rgba(15,23,42,1));
      border-radius:var(--radius-xl);
      padding:14px 14px 12px;
      border:1px solid rgba(75,85,99,.85);
      display:flex;
      flex-direction:column;
      justify-content:space-between;
      gap:10px;
    }
    .right-label{
      font-size:10px;
      text-transform:uppercase;
      letter-spacing:.14em;
      color:#6b7280;
      margin-bottom:3px;
    }
    .right-email{
      font-size:12px;
      color:#e5e7eb;
    }
    .right-role{
      font-size:11px;
      color:#9ca3af;
      margin-bottom:6px;
    }
    .nav-row{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:6px;
      margin-top:4px;
      margin-bottom:6px;
    }
    .btn-link{
      font-size:11px;
      color:var(--accent);
      text-decoration:none;
      padding:5px 8px;
      border-radius:8px;
      background:rgba(15,23,42,.9);
      border:1px solid rgba(37,99,235,.35);
      transition:all .18s ease;
    }
    .btn-link:hover{
      background:rgba(37,99,235,.16);
      box-shadow:0 0 16px rgba(37,99,235,.26);
    }
    .logout-form{
      margin-top:3px;
    }
    .logout-btn{
      width:100%;
      padding:7px 0;
      border-radius:10px;
      border:none;
      background:linear-gradient(to right,#1d4ed8,#0f766e);
      color:white;
      font-size:11px;
      font-weight:500;
      cursor:pointer;
      box-shadow:0 10px 22px rgba(15,23,42,.9);
      transition:all .18s ease-in-out;
    }
    .logout-btn:hover{
      transform:translateY(-1px);
      box-shadow:0 16px 32px rgba(15,23,42,1);
      filter:saturate(1.12);
    }
    @media (max-width:720px){
      .shell{grid-template-columns:1fr;max-width:430px;padding:18px 16px 14px}
      .headline{font-size:19px;}
    }
  </style>
</head>
<body>
  <div class="shell">
    <div>
      <div class="brand">
        <div class="logo-dot"></div>
        <div class="brand-title">School Panel</div>
      </div>
      <div class="pill">
        <span class="bullet"></span>
        Eingeloggt – sichere Schulverwaltung aktiv
      </div>
      <h1 class="headline">Willkommen zurück, ${email}</h1>
      <p class="subline">
        Du bist angemeldet als <b>${role}</b>. Verwende das Panel rechts, um in den passenden Bereich zu wechseln.
      </p>
      <div class="meta">
        <div><strong>Rolle</strong><br>${role}</div>
        <div><strong>Sicherheit</strong><br>Session-Cookies, CSRF-Schutz</div>
        <div class="tag">Nur autorisierte Zugriffe</div>
      </div>
    </div>
    <div class="right-box">
      <div>
        <div class="right-label">Account</div>
        <div class="right-email">${email}</div>
        <div class="right-role">Level: ${role}</div>
      </div>
      <div class="nav-row">
        ${
          role === "admin"
          ? `<a class="btn-link" href="/admin">Admin-Bereich öffnen</a>`
          : `<span style="font-size:10px;color:#6b7280;">Nutze das Menü deiner Rolle entsprechend.</span>`
        }
      </div>
      <form class="logout-form" method="POST" action="/logout">
        <input type="hidden" name="_csrf" value="${req.csrfToken()}">
        <button class="logout-btn" type="submit">Logout</button>
      </form>
    </div>
  </div>
</body>
</html>`);
});

// --- Login Seite (Dark, clean) ---
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  const token = req.csrfToken();

  res.send(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Login | School Panel</title>
  <style>
    :root{
      --bg:#020817;
      --card:#050816;
      --card-soft:#0b1020;
      --accent:#3b82f6;
      --accent-soft:rgba(59,130,246,.14);
      --accent-red:#f97316;
      --border-soft:rgba(148,163,253,.14);
      --text:#e5e7eb;
      --muted:#6b7280;
      --radius-xl:18px;
      --shadow:0 22px 55px rgba(15,23,42,.95);
      --font:system-ui, -apple-system, BlinkMacSystemFont, -system-ui, sans-serif;
    }
    *{margin:0;padding:0;box-sizing:border-box}
    body{
      min-height:100vh;
      font-family:var(--font);
      background:
        radial-gradient(circle at top,#111827 0, #020817 38%, #000 100%);
      color:var(--text);
      display:flex;
      align-items:center;
      justify-content:center;
      padding:24px;
    }
    .wrap{
      width:100%;
      max-width:420px;
      background:radial-gradient(circle at top, rgba(37,99,235,.08), var(--card));
      border-radius:var(--radius-xl);
      padding:22px 22px 18px;
      box-shadow:var(--shadow);
      border:1px solid var(--border-soft);
      backdrop-filter: blur(20px);
      position:relative;
      overflow:hidden;
    }
    .glow{
      position:absolute;
      width:140px;height:140px;
      background:radial-gradient(circle,#1d4ed8,transparent);
      opacity:.14;
      top:-40px;right:-40px;
      pointer-events:none;
    }
    .brand{
      display:flex;
      align-items:center;
      gap:9px;
      margin-bottom:10px;
      position:relative;
      z-index:2;
    }
    .logo-dot{
      width:22px;height:22px;
      border-radius:999px;
      background:radial-gradient(circle at 30% 0,#60a5fa,#1d4ed8);
      box-shadow:0 0 18px rgba(37,99,235,.9);
    }
    .brand-text{
      display:flex;
      flex-direction:column;
      gap:0;
    }
    .brand-label{
      font-size:9px;
      text-transform:uppercase;
      letter-spacing:.16em;
      color:#6b7280;
    }
    .brand-title{
      font-size:15px;
      font-weight:600;
      color:#e5e7eb;
      letter-spacing:.03em;
    }
    .title{
      font-size:21px;
      font-weight:600;
      margin-bottom:4px;
      color:#e5e7eb;
    }
    .subtitle{
      font-size:11px;
      color:var(--muted);
      margin-bottom:14px;
    }
    .security-pill{
      display:inline-flex;
      align-items:center;
      gap:6px;
      padding:4px 9px;
      border-radius:999px;
      border:1px solid rgba(75,85,99,.9);
      font-size:9px;
      color:#9ca3af;
      background:rgba(5,9,20,.98);
      margin-bottom:10px;
    }
    .security-pill span.dot{
      width:7px;height:7px;border-radius:999px;
      background:#22c55e;
      box-shadow:0 0 10px #22c55e;
    }

    form{
      position:relative;
      z-index:2;
    }
    label{
      display:block;
      font-size:10px;
      color:#9ca3af;
      margin-bottom:4px;
      margin-top:6px;
    }
    input[type="email"],
    input[type="password"]{
      width:100%;
      padding:9px 10px;
      border-radius:11px;
      border:1px solid rgba(75,85,99,.9);
      background:linear-gradient(to bottom,var(--card-soft),#020817);
      color:var(--text);
      font-size:11px;
      outline:none;
      transition:all .17s ease;
    }
    input::placeholder{
      color:#4b5563;
      font-size:10px;
    }
    input[type="email"]:focus,
    input[type="password"]:focus{
      border-color:var(--accent);
      box-shadow:0 0 16px rgba(37,99,235,.28);
      transform:translateY(-1px);
    }
    .hint-row{
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-top:4px;
      margin-bottom:8px;
    }
    .hint-text{
      font-size:8px;
      color:var(--muted);
    }
    .role-hint{
      font-size:8px;
      color:var(--accent);
      text-align:right;
    }
    button[type="submit"]{
      width:100%;
      margin-top:6px;
      padding:9px 0;
      border-radius:12px;
      border:none;
      background:linear-gradient(to right,#2563eb,#4f46e5);
      color:#f9fafb;
      font-size:11px;
      font-weight:500;
      cursor:pointer;
      box-shadow:0 15px 32px rgba(15,23,42,1);
      transition:all .18s ease-in-out;
    }
    button[type="submit"]:hover{
      transform:translateY(-1px);
      box-shadow:0 22px 40px rgba(15,23,42,1);
      filter:saturate(1.08);
    }
    .foot{
      margin-top:10px;
      font-size:8px;
      color:var(--muted);
      display:flex;
      justify-content:space-between;
      gap:8px;
    }
    .foot span.key{
      color:var(--accent-red);
    }
    @media (max-width:480px){
      body{padding:14px;}
      .wrap{padding:18px 16px 14px;}
      .title{font-size:18px;}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="glow"></div>
    <div class="brand">
      <div class="logo-dot"></div>
      <div class="brand-text">
        <div class="brand-label">Secure School Access</div>
        <div class="brand-title">School Panel Login</div>
      </div>
    </div>
    <div class="security-pill">
      <span class="dot"></span>
      Interner Zugang für Admins, Lehrer & Schüler
    </div>
    <h1 class="title">Melde dich an</h1>
    <p class="subtitle">
      Nutze deine zugewiesene Schul-E-Mail und dein Passwort. Nur freigegebene Accounts erhalten Zugriff.
    </p>

    <form method="POST" action="/login">
      <input type="hidden" name="_csrf" value="${token}">

      <label for="email">E-Mail-Adresse</label>
      <input id="email" name="email" type="email" placeholder="z.B. max.muster@schule.at" required>

      <label for="password">Passwort</label>
      <input id="password" name="password" type="password" placeholder="Dein sicheres Passwort" required>

      <div class="hint-row">
        <div class="hint-text">Zugangsdaten erhältst du von einem Admin.</div>
        <div class="role-hint">Rollen: Admin • Lehrer • Schüler</div>
      </div>

      <button type="submit">Login</button>
    </form>

    <div class="foot">
      <div>Keine Selbst-Registrierung – nur zentrale Vergabe.</div>
      <div><span class="key">AES</span> / Hashing / Sessions geschützt.</div>
    </div>
  </div>
</body>
</html>`);
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

// --- Admin UI: User anlegen (gleiches Dark-Design, minimal) ---
app.get("/admin", requireAuth, requireRole("admin"), (req, res) => {
  res.send(`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Admin | Nutzerverwaltung</title>
  <style>
    body{
      margin:0;
      min-height:100vh;
      font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
      background:#020817;
      color:#e5e7eb;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:24px;
    }
    .card{
      width:100%;
      max-width:520px;
      background:radial-gradient(circle at top,rgba(37,99,235,.06),#050816);
      border-radius:18px;
      padding:20px 20px 16px;
      border:1px solid rgba(148,163,253,.16);
      box-shadow:0 22px 50px rgba(15,23,42,.96);
    }
    h1{
      font-size:19px;
      margin:0 0 4px;
    }
    p{
      font-size:10px;
      color:#9ca3af;
      margin:0 0 10px;
    }
    label{
      display:block;
      font-size:9px;
      margin-top:6px;
      margin-bottom:3px;
      color:#9ca3af;
    }
    input,select{
      width:100%;
      padding:8px 9px;
      border-radius:10px;
      border:1px solid rgba(75,85,99,.95);
      background:#020817;
      color:#e5e7eb;
      font-size:10px;
      outline:none;
      transition:all .18s ease;
    }
    input:focus,select:focus{
      border-color:#3b82f6;
      box-shadow:0 0 14px rgba(37,99,235,.32);
      transform:translateY(-1px);
    }
    button{
      width:100%;
      margin-top:10px;
      padding:8px 0;
      border-radius:11px;
      border:none;
      background:linear-gradient(to right,#22c55e,#16a34a);
      color:#020817;
      font-size:10px;
      font-weight:600;
      cursor:pointer;
      box-shadow:0 18px 36px rgba(15,23,42,1);
      transition:all .18s ease;
    }
    button:hover{
      transform:translateY(-1px);
      box-shadow:0 24px 46px rgba(15,23,42,1);
    }
    .toprow{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:8px;
      margin-bottom:6px;
    }
    .tag{
      font-size:8px;
      padding:3px 7px;
      border-radius:999px;
      border:1px solid rgba(75,85,99,.9);
      color:#9ca3af;
    }
    .back{
      font-size:8px;
      color:#60a5fa;
      text-decoration:none;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="toprow">
      <div>
        <h1>Nutzer anlegen</h1>
        <p>Admins erstellen hier Accounts für Lehrer & Schüler. Passwörter werden sicher gehasht gespeichert.</p>
      </div>
      <div class="tag">Rolle: Admin</div>
    </div>
    <form method="POST" action="/admin/users">
      <input type="hidden" name="_csrf" value="${req.csrfToken()}">
      <label for="email">E-Mail</label>
      <input id="email" name="email" type="email" required>

      <label for="role">Rolle</label>
      <select id="role" name="role">
        <option value="student">Schüler</option>
        <option value="teacher">Lehrer</option>
        <option value="admin">Admin</option>
      </select>

      <label for="password">Initial-Passwort</label>
      <input id="password" name="password" type="password" required minlength="8">

      <button type="submit">Nutzer erstellen</button>
    </form>
    <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">
      <a class="back" href="/">← Zurück zum Dashboard</a>
      <span style="font-size:7px;color:#6b7280;">Nur vertrauenswürdige Admins erhalten Zugriff auf dieses Panel.</span>
    </div>
  </div>
</body>
</html>`);
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
