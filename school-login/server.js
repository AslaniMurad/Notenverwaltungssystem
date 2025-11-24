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
    // show a friendly error page with back button
    return res.status(403).render("error", {
      message: "Dein Account ist gesperrt.",
      status: 403,
      backUrl: "/login",
      csrfToken: req.csrfToken()
    });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).render("error", {
        message: "Zugriff verweigert. Du hast nicht die nötige Berechtigung.",
        status: 403,
        backUrl: req.get("Referer") || "/",
        csrfToken: req.csrfToken()
      });
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
  res.render("login", { csrfToken: req.csrfToken(), error: null });
});

// --- Admin: mount router (statt einzelne /admin routes hier) ---
const adminRouter = require("./routes/admin");
app.use("/admin", adminRouter);

// --- Login POST ---
app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).render("login", {
      csrfToken: req.csrfToken(),
      error: "Bitte E‑Mail und Passwort angeben.",
      email: email || ""
    });
  }

  db.get(
    "SELECT id, email, password_hash, role, status FROM users WHERE email = ?",
    [email],
    (err, user) => {
      if (err) {
        console.error("DB error on login:", err);
        return res.status(500).render("error", {
          message: "Datenbankfehler beim Login.",
          status: 500,
          backUrl: "/login",
          csrfToken: req.csrfToken()
        });
      }
      if (!user || !verifyPassword(user.password_hash, password)) {
        return res.status(401).render("login", {
          csrfToken: req.csrfToken(),
          error: "Login fehlgeschlagen. Bitte überprüfe deine Zugangsdaten.",
          email: email || ""
        });
      }
      if (user.status !== "active") {
        return res.status(403).render("error", {
          message: "Account gesperrt. Bitte wende dich an einen Admin.",
          status: 403,
          backUrl: "/login",
          csrfToken: req.csrfToken()
        });
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

// --- Generic error handler (renders friendly error page) ---
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err && err.stack ? err.stack : err);
  const status = err.status || 500;
  const message = err.message || "Internal Server Error";
  // Try to render friendly error page
  try {
    res.status(status).render("error", {
      message,
      status,
      backUrl: req.get("Referer") || (req.path === "/login" ? "/" : "/login"),
      csrfToken: req.csrfToken ? req.csrfToken() : null
    });
  } catch (renderErr) {
    // fallback plain text
    res.status(status).send(`${status} - ${message}`);
  }
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server läuft: http://localhost:${PORT}`);
});
