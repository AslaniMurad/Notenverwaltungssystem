// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const crypto = require("crypto");
require('dotenv').config({ override: true });
const { db, verifyPassword, ready, hashPassword, pool, isFakeDb } = require("./db");
const { requireAuth } = require("./middleware/auth");
const { detectDevice } = require("./middleware/deviceDetection");
const { buildSessionStore } = require("./sessionStore");
const { getPasswordValidationError } = require("./utils/password");

const adminRouter = require("./routes/admin");
const studentRouter = require("./routes/student");
const teacherRouter = require("./routes/teacher");

const app = express();
const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  app.set("trust proxy", 1);
}
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}

const sessionStore = buildSessionStore({ pool, isFakeDb });

function isDbConnectionError(err) {
  if (!err) return false;
  if (Array.isArray(err.errors)) {
    return err.errors.some(isDbConnectionError);
  }
  const code = err.code || "";
  if (["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "ECONNREFUSED"].includes(code)) {
    return true;
  }
  const message = String(err.message || "");
  return (
    message.includes("Connection terminated unexpectedly") ||
    message.includes("connect ETIMEDOUT") ||
    message.includes("ENETUNREACH") ||
    message.includes("ECONNRESET")
  );
}

const LOGIN_RATE_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const LOGIN_RATE_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5;
const loginAttempts = new Map();

function buildLoginKey(req, email) {
  const ip = req.ip || "unknown";
  const normalizedEmail = String(email || "").toLowerCase();
  return `${ip}|${normalizedEmail}`;
}

function isLoginRateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  const now = Date.now();
  if (entry.lockedUntil && entry.lockedUntil > now) return true;
  if (now - entry.firstAttemptAt > LOGIN_RATE_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_RATE_MAX;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > LOGIN_RATE_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_RATE_MAX) {
    entry.lockedUntil = now + LOGIN_RATE_WINDOW_MS;
  }
}

function resetLoginAttempts(key) {
  loginAttempts.delete(key);
}

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
    email = ""
  } = options;

  return res.status(status).render("login", {
    csrfToken: req.csrfToken(),
    errorType,
    errorMessage,
    email
  });
}

// --- Session ---
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
app.use(
  session({
    name: "sid",
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 // 1h
    }
  })
);

// --- CSRF ---
const multipartAllowList = [/^\/teacher\/add-grade\/\d+\/\d+$/];
const csrfProtection = csrf({
  value: (req) =>
    (req.body && req.body._csrf) ||
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"]
});
app.use((req, res, next) => {
  if (req.method !== "GET" && req.is("multipart/form-data")) {
    const allowed = multipartAllowList.some((entry) => entry.test(req.path));
    if (!allowed) {
      return res.status(415).render("error", {
        message: "Multipart ist fuer diese Route nicht erlaubt.",
        status: 415,
        backUrl: "/"
      });
    }
  }
  if (req.is("multipart/form-data")) {
    return next();
  }
  return csrfProtection(req, res, next);
});

// --- Device Detection ---
app.use(detectDevice);

// --- Simple Security Headers ---
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

function getRedirectForRole(role) {
  const redirectMap = {
    admin: "/admin",
    teacher: "/teacher/classes",
    student: "/student"
  };
  return redirectMap[role] || "/";
}

app.use((req, res, next) => {
  const user = req.session.user;
  if (!user || !user.must_change_password) return next();
  if (req.path === "/force-password-change" || req.path === "/logout") {
    return next();
  }
  return res.redirect("/force-password-change");
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

// --- Passwortwechsel erzwingen ---
app.get("/force-password-change", requireAuth, (req, res) => {
  if (!req.session.user.must_change_password) {
    return res.redirect(getRedirectForRole(req.session.user.role));
  }
  res.render("force-password-change", {
    email: req.session.user.email,
    csrfToken: req.csrfToken(),
    error: null
  });
});

app.post("/force-password-change", requireAuth, (req, res, next) => {
  if (!req.session.user.must_change_password) {
    return res.redirect(getRedirectForRole(req.session.user.role));
  }
  const newPassword = req.body?.newPassword;
  const validationError = getPasswordValidationError(newPassword);
  if (validationError) {
    return res.status(400).render("force-password-change", {
      email: req.session.user.email,
      csrfToken: req.csrfToken(),
      error: validationError
    });
  }
  const hash = hashPassword(newPassword);
  db.run(
    "UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?",
    [hash, 0, req.session.user.id],
    (err) => {
      if (err) return next(err);
      req.session.user.must_change_password = false;
      return res.redirect(getRedirectForRole(req.session.user.role));
    }
  );
});

// --- Login POST ---
app.post("/login", (req, res, next) => {
  const { email, password } = req.body || {};
  const loginKey = buildLoginKey(req, email);
  if (isLoginRateLimited(loginKey)) {
    return renderLogin(res, req, {
      status: 429,
      errorType: "invalid",
      errorMessage: "Zu viele Versuche. Bitte spaeter erneut versuchen.",
      email
    });
  }
  if (!email || !password) {
    recordLoginFailure(loginKey);
    return renderLogin(res, req, {
      status: 400,
      errorType: "invalid",
      errorMessage: "Bitte E-Mail und Passwort eingeben.",
      email
    });
  }

  db.get(
    "SELECT id, email, password_hash, role, status, must_change_password FROM users WHERE email = ?",
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
        recordLoginFailure(loginKey);
        return renderLogin(res, req, {
          status: 401,
          errorType: "invalid",
          errorMessage: "Login fehlgeschlagen.",
          email
        });
      }
      if (user.status !== "active") {
        recordLoginFailure(loginKey);
        return renderLogin(res, req, {
          status: 401,
          errorType: "invalid",
          errorMessage: "Login fehlgeschlagen.",
          email
        });
      }

      req.session.regenerate((regenErr) => {
        if (regenErr) return next(regenErr);

        req.session.user = {
          id: user.id,
          email: user.email,
          role: user.role,
          status: user.status,
          must_change_password: Boolean(user.must_change_password)
        };

        resetLoginAttempts(loginKey);
        db.run("UPDATE users SET last_login = current_timestamp WHERE id = ?", [user.id], () => {});
        const redirectTarget = user.must_change_password
          ? "/force-password-change"
          : getRedirectForRole(user.role);
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.redirect(redirectTarget);
        });
      });
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
  if (res.headersSent) return next(err);
  if (err && err.code === "EBADCSRFTOKEN") {
    return res.status(403).render("error", {
      message:
        "Ungültiges oder abgelaufenes Sicherheits-Token. Bitte Seite neu laden und erneut versuchen.",
      status: 403,
      backUrl: req.get("referer") || "/login"
    });
  }
  if (isDbConnectionError(err)) {
    console.error("Database connection error:", err);
    return res.status(503).render("error", {
      message: "Datenbank nicht erreichbar. Bitte spaeter erneut versuchen.",
      status: 503,
      backUrl: req.get("referer") || "/login"
    });
  }
  console.error("Unhandled error:", err);
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
