// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const { db, verifyPassword, ready } = require("./db");
const { requireAuth } = require("./middleware/auth");

const adminRouter = require("./routes/admin");
const studentRouter = require("./routes/student");
const teacherRouter = require("./routes/teacher");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(async (req, res, next) => {
  try {
    if (ready) {
      await ready;
    }
    next();
  } catch (err) {
    next(err);
  }
});

// set view engine & static
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

function renderLogin(res, req, options = {}) {
  const {
    status = 200,
    errorType = null,
    errorMessage = null,
    lockedInfo = null,
    email = ""
  } = options;

  return res.status(status).render("login", {
    csrfToken: req.csrfToken(),
    errorType,
    errorMessage,
    lockedInfo,
    email
  });
}

// --- Session ---
app.use(
  session({
    name: "sid",
    secret: "change-this-session-secret", // in echt aus ENV
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // bei HTTPS auf true setzen
      maxAge: 1000 * 60 * 60 // 1h
    }
  })
);

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

// --- Login Seite ---
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  renderLogin(res, req);
});

// --- Login POST ---
app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return renderLogin(res, req, {
      status: 400,
      errorType: "invalid",
      errorMessage: "Bitte E-Mail und Passwort eingeben.",
      email
    });
  }

  db.get(
    "SELECT id, email, password_hash, role, status FROM users WHERE email = ?",
    [email],
    (err, user) => {
      if (err) {
        return res.status(500).render("error", {
          message: "DB-Fehler.",
          status: 500,
          backUrl: "/login"
        });
      }
      if (!user || !verifyPassword(user.password_hash, password)) {
        return renderLogin(res, req, {
          status: 401,
          errorType: "invalid",
          errorMessage: "Login fehlgeschlagen.",
          email
        });
      }
      if (user.status !== "active") {
        return renderLogin(res, req, {
          status: 403,
          errorType: "locked",
          lockedInfo: { id: user.id, email: user.email },
          email: user.email
        });
      }

      req.session.user = {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status
      };

      const redirectMap = {
        admin: "/admin",
        teacher: "/teacher/classes",
        student: "/student"
      };
      res.redirect(redirectMap[user.role] || "/");
    }
  );
});

// --- Logout ---
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// --- Router Mounts ---
app.use("/admin", adminRouter);
app.use("/teacher", teacherRouter);
app.use("/student", studentRouter);

app.use((req, res) => {
  res.status(404).render("error", {
    message: "Seite nicht gefunden.",
    status: 404,
    backUrl: req.get("referer") || "/"
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).render("error", {
    message: "Interner Serverfehler.",
    status: 500,
    backUrl: req.get("referer") || "/"
  });
});

module.exports = app;

// --- Start ---
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server läuft: http://localhost:${PORT}`);
  });
}
