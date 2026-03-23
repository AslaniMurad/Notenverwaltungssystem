// server.js
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ override: process.env.NODE_ENV !== "test" });
const { db, verifyPassword, ready, hashPassword, pool, isFakeDb } = require("./db");
const { requireAuth } = require("./middleware/auth");
const { detectDevice } = require("./middleware/deviceDetection");
const { buildSessionStore } = require("./sessionStore");
const { getAsync } = require("./utils/dbAsync");
const { getPasswordValidationError } = require("./utils/password");
const {
  beginSsoAuthorization,
  buildSsoLogoutUrl,
  completeSsoAuthorization,
  createMockOidcRouter,
  getSsoLoginViewModel,
  getSsoSettings
} = require("./services/ssoService");

const adminRouter = require("./routes/admin");
const assignmentRouter = require("./routes/assignmentRoutes");
const archiveRouter = require("./routes/archiveRoutes");
const rolloverRouter = require("./routes/rolloverRoutes");
const studentRouter = require("./routes/student");
const teacherRouter = require("./routes/teacher");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const assetVersion = process.env.ASSET_VERSION || (isProduction ? "1" : Date.now().toString(36));

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
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    lastModified: true,
    maxAge: isProduction ? "7d" : 0
  })
);

app.locals.assetVersion = assetVersion;
app.use((req, res, next) => {
  res.locals.assetVersion = assetVersion;
  next();
});

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
    email,
    sso: getSsoLoginViewModel(req)
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
const csrfBypassList = [/^\/dev\/mock-oidc\/token$/];
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
        message: "Multipart ist für diese Route nicht erlaubt.",
        status: 415,
        backUrl: "/"
      });
    }
  }
  if (req.is("multipart/form-data")) {
    return next();
  }
  if (csrfBypassList.some((entry) => entry.test(req.path))) {
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
    teacher: "/teacher",
    student: "/student"
  };
  return redirectMap[role] || "/";
}

function buildSessionUser(user, options = {}) {
  const authMethod = options.authMethod || "local";
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    must_change_password: authMethod === "sso" ? false : Boolean(user.must_change_password),
    auth_method: authMethod,
    sso_provider: authMethod === "sso" ? options.providerKey || null : null
  };
}

function persistLoginMetadata(userId, authMethod, callback) {
  db.run("UPDATE users SET last_login = current_timestamp WHERE id = ?", [userId], () => {
    if (authMethod !== "sso") return callback();
    db.run("UPDATE users SET last_sso_login = current_timestamp WHERE id = ?", [userId], () => callback());
  });
}

function determineRedirectTarget(sessionUser, options = {}) {
  if (options.returnTo && options.returnTo.startsWith("/")) {
    return options.returnTo;
  }
  return sessionUser.must_change_password
    ? "/force-password-change"
    : getRedirectForRole(sessionUser.role);
}

function logTeacherAssignmentsIfNeeded(user) {
  return new Promise((resolve) => {
    if (!user || user.role !== "teacher") return resolve();
    db.get(
      "SELECT COUNT(*) AS count FROM class_subject_teacher WHERE teacher_id = ?",
      [user.id],
      (assignmentErr, assignmentRow) => {
        if (assignmentErr) {
          console.error("Assignment count check failed:", assignmentErr);
          console.log("Assignments found: 0");
        } else {
          console.log(`Assignments found: ${Number(assignmentRow?.count || 0)}`);
        }
        resolve();
      }
    );
  });
}

function establishLoginSession(req, user, options = {}) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenErr) => {
      if (regenErr) return reject(regenErr);

      const sessionUser = buildSessionUser(user, options);
      req.session.user = sessionUser;

      if (options.authMethod === "sso") {
        req.session.sso = {
          provider: options.providerKey || null,
          idToken: options.idToken || null,
          logoutUrl: options.logoutUrl || null
        };
      } else {
        delete req.session.sso;
      }

      if (options.loginKey) {
        resetLoginAttempts(options.loginKey);
      }

      persistLoginMetadata(user.id, options.authMethod, () => {
        const redirectTarget = determineRedirectTarget(sessionUser, options);
        req.session.save((saveErr) => {
          if (saveErr) return reject(saveErr);
          resolve(redirectTarget);
        });
      });
    });
  });
}

app.use((req, res, next) => {
  const user = req.session.user;
  if (!user || !user.must_change_password) return next();
  if (req.path === "/force-password-change" || req.path === "/logout") {
    return next();
  }
  return res.redirect("/force-password-change");
});

app.use("/dev/mock-oidc", createMockOidcRouter());

// --- Startseite (nach Login) ---
app.get("/", requireAuth, (req, res) => {
  return res.redirect(getRedirectForRole(req.session.user.role));
});

// --- Login Seite ---
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect(getRedirectForRole(req.session.user.role));
  renderLogin(res, req);
});

app.get("/auth/sso/start", async (req, res, next) => {
  if (req.session.user) return res.redirect("/");

  try {
    const redirectUrl = await beginSsoAuthorization(req);
    return res.redirect(redirectUrl);
  } catch (err) {
    if (err?.exposeToLogin) {
      return renderLogin(res, req, {
        status: 400,
        errorType: "invalid",
        errorMessage: err.message
      });
    }
    return next(err);
  }
});

app.get("/auth/sso/callback", async (req, res, next) => {
  if (req.query?.error) {
    const providerMessage = String(
      req.query.error_description || req.query.error || "SSO-Anmeldung fehlgeschlagen."
    );
    return renderLogin(res, req, {
      status: 401,
      errorType: "invalid",
      errorMessage: providerMessage
    });
  }

  try {
    const ssoResult = await completeSsoAuthorization(req);
    await logTeacherAssignmentsIfNeeded(ssoResult.user);
    const redirectTarget = await establishLoginSession(req, ssoResult.user, {
      authMethod: "sso",
      providerKey: getSsoSettings(req).providerKey,
      idToken: ssoResult.idToken,
      logoutUrl: ssoResult.logoutUrl,
      returnTo: ssoResult.returnTo
    });
    return res.redirect(redirectTarget);
  } catch (err) {
    if (req.session?.oidc) {
      delete req.session.oidc;
    }
    if (err?.exposeToLogin) {
      return renderLogin(res, req, {
        status: 401,
        errorType: "invalid",
        errorMessage: err.message
      });
    }
    return next(err);
  }
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
app.post("/login", async (req, res, next) => {
  const { email, password } = req.body || {};
  const loginKey = buildLoginKey(req, email);
  const ssoSettings = getSsoSettings(req);

  if (!ssoSettings.allowLocalLogin) {
    return renderLogin(res, req, {
      status: 400,
      errorType: "invalid",
      errorMessage: `Lokaler Login ist deaktiviert. Bitte ${ssoSettings.displayName} verwenden.`,
      email
    });
  }

  if (isLoginRateLimited(loginKey)) {
    return renderLogin(res, req, {
      status: 429,
      errorType: "invalid",
      errorMessage: "Zu viele Versuche. Bitte später erneut versuchen.",
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

  try {
    const user = await getAsync(
      "SELECT id, email, password_hash, role, status, must_change_password, local_login_enabled FROM users WHERE email = ?",
      [email]
    );

    if (!user || !verifyPassword(user.password_hash, password)) {
      recordLoginFailure(loginKey);
      return renderLogin(res, req, {
        status: 401,
        errorType: "invalid",
        errorMessage: "Login fehlgeschlagen.",
        email
      });
    }
    if (user.local_login_enabled === false || user.local_login_enabled === 0) {
      recordLoginFailure(loginKey);
      return renderLogin(res, req, {
        status: 401,
        errorType: "invalid",
        errorMessage: `Fuer dieses Konto ist nur ${ssoSettings.displayName}-SSO erlaubt.`,
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

    await logTeacherAssignmentsIfNeeded(user);
    const redirectTarget = await establishLoginSession(req, user, {
      authMethod: "local",
      loginKey
    });
    return res.redirect(redirectTarget);
  } catch (err) {
    console.error("DB error during login:", err);
    return res.status(500).render("error", {
      message: "DB-Fehler.",
      status: 500,
      backUrl: "/login"
    });
  }
});

// --- Logout ---
app.post("/logout", (req, res) => {
  const logoutUrl = buildSsoLogoutUrl(req) || "/login";
  req.session.destroy(() => res.redirect(logoutUrl));
});

// --- Router Mounts ---
app.use("/admin", adminRouter);
app.use("/admin", assignmentRouter);
app.use("/admin", rolloverRouter);
app.use("/teacher", teacherRouter);
app.use("/student", studentRouter);
app.use("/", archiveRouter);

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
      message: "Datenbank nicht erreichbar. Bitte später erneut versuchen.",
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
