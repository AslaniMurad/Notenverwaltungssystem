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
const { getPasswordValidationError } = require("./utils/password");
const userDisplay = require("./utils/userDisplay");
const schoolYearModel = require("./models/schoolYearModel");
const {
  microsoftAuthConfig,
  createMicrosoftAuthorizationRequest,
  exchangeMicrosoftCodeForProfile,
  isAllowedMicrosoftDomain,
  normalizeEmail
} = require("./services/microsoftAuth");

const adminRouter = require("./routes/admin");
const accountRouter = require("./routes/account");
const assignmentRouter = require("./routes/assignmentRoutes");
const archiveRouter = require("./routes/archiveRoutes");
const rolloverRouter = require("./routes/rolloverRoutes");
const studentRouter = require("./routes/student");
const teacherRouter = require("./routes/teacher");

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const assetVersion = process.env.ASSET_VERSION || (isProduction ? "1" : Date.now().toString(36));
const ssoEnabled = process.env.SSO_ENABLED === "true";
const ssoHeaderName = (process.env.SSO_HEADER || "x-remote-user").toLowerCase();
const ssoEmailDomain = (process.env.SSO_EMAIL_DOMAIN || "").toLowerCase();
const ssoRealm = (process.env.SSO_REALM || "").toLowerCase();

if (isProduction) {
  app.set("trust proxy", 1);
}
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}

const sessionStore = buildSessionStore({ pool, isFakeDb });

function parseOptionalBoolean(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseDelimitedList(value) {
  if (value == null || value === "") return [];
  return String(value)
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeFrameAncestor(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.toLowerCase() === "self" ? "'self'" : normalized;
}

function normalizeSameSite(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["lax", "strict", "none"].includes(normalized)) return normalized;
  return null;
}

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
const teamsEmbedEnabled = parseOptionalBoolean(process.env.TEAMS_EMBED_ENABLED) ?? false;
const teamsMicrosoftLoginOnly =
  parseOptionalBoolean(process.env.TEAMS_MICROSOFT_LOGIN_ONLY) ?? teamsEmbedEnabled;
const defaultTeamsFrameAncestors = [
  "'self'",
  "https://teams.microsoft.com",
  "https://*.teams.microsoft.com",
  "https://teams.cloud.microsoft",
  "https://*.cloud.microsoft"
];
const configuredFrameAncestors = parseDelimitedList(process.env.FRAME_ANCESTORS)
  .map(normalizeFrameAncestor)
  .filter(Boolean);
const allowedFrameAncestors = [
  ...(teamsEmbedEnabled ? defaultTeamsFrameAncestors : []),
  ...configuredFrameAncestors
].filter((entry, index, list) => list.indexOf(entry) === index);
const sessionCookieSameSite =
  normalizeSameSite(process.env.SESSION_COOKIE_SAMESITE) || (teamsEmbedEnabled ? "none" : "lax");
const secureCookieOverride = parseOptionalBoolean(process.env.SESSION_COOKIE_SECURE);
const useSecureSessionCookie = secureCookieOverride ?? (isProduction || sessionCookieSameSite === "none");
const sessionCookiePartitioned =
  parseOptionalBoolean(process.env.SESSION_COOKIE_PARTITIONED) ?? teamsEmbedEnabled;

if (sessionCookieSameSite === "none" && !useSecureSessionCookie) {
  throw new Error("SESSION_COOKIE_SECURE must be true when SESSION_COOKIE_SAMESITE is none.");
}
if (sessionCookiePartitioned && !useSecureSessionCookie) {
  throw new Error("SESSION_COOKIE_SECURE must be true when SESSION_COOKIE_PARTITIONED is true.");
}

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

function queryValueMatchesTeams(value) {
  if (value == null) return false;
  const values = Array.isArray(value) ? value : [value];
  return values.some((entry) => {
    const normalized = String(entry || "").trim().toLowerCase();
    return ["1", "true", "yes", "on", "teams", "msteams", "microsoftteams"].includes(normalized);
  });
}

function isTeamsHost(value) {
  if (!value) return false;
  try {
    const { hostname } = new URL(String(value));
    const normalizedHost = hostname.toLowerCase();
    return (
      normalizedHost === "teams.microsoft.com" ||
      normalizedHost.endsWith(".teams.microsoft.com") ||
      normalizedHost === "teams.cloud.microsoft" ||
      normalizedHost.endsWith(".teams.cloud.microsoft")
    );
  } catch {
    return false;
  }
}

function hasTeamsLoginSignal(req) {
  return (
    queryValueMatchesTeams(req.query?.teams) ||
    queryValueMatchesTeams(req.query?.client) ||
    queryValueMatchesTeams(req.query?.hostClientType) ||
    isTeamsHost(req.get("origin")) ||
    isTeamsHost(req.get("referer"))
  );
}

function rememberTeamsLoginContext(req) {
  if (hasTeamsLoginSignal(req)) {
    req.session.teamsLogin = true;
  }
}

function isTeamsLoginContext(req) {
  return Boolean(req.session?.teamsLogin || hasTeamsLoginSignal(req));
}

function shouldUseMicrosoftOnlyLogin(req) {
  return teamsMicrosoftLoginOnly && isTeamsLoginContext(req);
}

function saveSessionAndRedirect(req, res, next, target) {
  req.session.save((saveErr) => {
    if (saveErr) return next(saveErr);
    return res.redirect(target);
  });
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
app.locals.userDisplay = userDisplay;
app.use((req, res, next) => {
  res.locals.assetVersion = assetVersion;
  res.locals.currentPath = req.originalUrl || "/";
  next();
});

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

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
    microsoftAuthEnabled: microsoftAuthConfig.enabled,
    microsoftOnlyLogin: shouldUseMicrosoftOnlyLogin(req)
  });
}

function isMicrosoftLinked(user) {
  return Boolean(user?.microsoft_oid && user?.microsoft_tenant_id);
}

function buildSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    must_change_password: shouldRequirePasswordChange(user),
    microsoft_connected: isMicrosoftLinked(user),
    microsoft_email: user.microsoft_email || null
  };
}

function shouldRequirePasswordChange(user) {
  return Boolean(user && user.must_change_password);
}

function logTeacherAssignments(user) {
  if (user.role !== "teacher") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
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

function createUserSession(req, user, loginKey) {
  return new Promise((resolve, reject) => {
    const teamsLogin = Boolean(req.session?.teamsLogin);
    req.session.regenerate((regenErr) => {
      if (regenErr) return reject(regenErr);

      if (teamsLogin) {
        req.session.teamsLogin = true;
      }
      req.session.user = buildSessionUser(user);

      if (loginKey) {
        resetLoginAttempts(loginKey);
      }

      db.run("UPDATE users SET last_login = current_timestamp WHERE id = ?", [user.id], () => {});

      req.session.save((saveErr) => {
        if (saveErr) return reject(saveErr);
        resolve(
          shouldRequirePasswordChange(user)
            ? "/force-password-change"
            : getRedirectForRole(user.role)
        );
      });
    });
  });
}

async function completeLogin(req, user, loginKey) {
  await logTeacherAssignments(user);
  return createUserSession(req, user, loginKey);
}

async function findUserByMicrosoftAccount(profile) {
  if (!profile?.oid || !profile?.tid) {
    return null;
  }

  return getAsync(
    "SELECT id, email, password_hash, role, status, must_change_password, microsoft_oid, microsoft_tenant_id, microsoft_email FROM users WHERE microsoft_oid = ? AND microsoft_tenant_id = ?",
    [profile.oid, profile.tid]
  );
}

function renderMicrosoftAuthError(res, req, message, status = 401, email = "") {
  return renderLogin(res, req, {
    status,
    errorType: "invalid",
    errorMessage: message,
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
      sameSite: sessionCookieSameSite,
      secure: useSecureSessionCookie,
      partitioned: sessionCookiePartitioned,
      maxAge: 1000 * 60 * 60 // 1h
    }
  })
);
app.use((req, res, next) => {
  res.locals.sessionUser = req.session?.user || null;
  next();
});
app.use((req, res, next) => {
  rememberTeamsLoginContext(req);
  res.locals.microsoftOnlyLogin = shouldUseMicrosoftOnlyLogin(req);
  next();
});

app.use((req, res, next) => {
  if (!ssoEnabled || req.session.user) return next();

  const ssoEmail = normalizeSsoEmail(getHeaderValue(req, ssoHeaderName));
  if (!ssoEmail) return next();

  db.get(
    "SELECT id, email, password_hash, role, status, must_change_password FROM users WHERE email = ?",
    [ssoEmail],
    (err, user) => {
      if (err) return next(err);
      if (!user) {
        return res.status(403).render("error", {
          message: "Windows-Anmeldung erkannt, aber kein passender NVS-Benutzer gefunden.",
          status: 403,
          backUrl: "/login"
        });
      }
      if (user.status !== "active") {
        return res.status(403).render("error", {
          message: "Account gesperrt.",
          status: 403,
          backUrl: "/login"
        });
      }
      createSessionForUser(req, user, next);
    }
  );
});

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
        message: "Multipart ist für diese Route nicht erlaubt.",
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
  if (allowedFrameAncestors.length) {
    res.setHeader("Content-Security-Policy", `frame-ancestors ${allowedFrameAncestors.join(" ")}`);
  } else {
    res.setHeader("X-Frame-Options", "DENY");
  }
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

function getHeaderValue(req, headerName) {
  const value = req.headers[headerName];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeSsoEmail(rawPrincipal) {
  const principal = String(rawPrincipal || "").trim();
  if (!principal) return null;

  const withoutDomain = principal.includes("\\")
    ? principal.slice(principal.lastIndexOf("\\") + 1)
    : principal;
  const lowerPrincipal = withoutDomain.toLowerCase();

  if (lowerPrincipal.includes("@")) {
    const [userPart, realmPart] = lowerPrincipal.split("@", 2);
    if (ssoRealm && ssoEmailDomain && realmPart === ssoRealm) {
      return `${userPart}@${ssoEmailDomain}`;
    }
    return lowerPrincipal;
  }

  return ssoEmailDomain ? `${lowerPrincipal}@${ssoEmailDomain}` : lowerPrincipal;
}

function createSessionForUser(req, user, next) {
  req.session.regenerate((regenErr) => {
    if (regenErr) return next(regenErr);

    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      must_change_password: Boolean(user.must_change_password)
    };

    db.run("UPDATE users SET last_login = current_timestamp WHERE id = ?", [user.id], () => {});
    req.session.save(next);
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

app.use(async (req, res, next) => {
  res.locals.activeSchoolYear = res.locals.activeSchoolYear || null;
  res.locals.sidebarStudentClass = null;
  res.locals.sidebarTeacherKvClasses = null;

  const sessionUser = req.session?.user;
  if (!sessionUser) {
    return next();
  }

  try {
    if (!res.locals.activeSchoolYear) {
      res.locals.activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
    }
  } catch (err) {
    res.locals.activeSchoolYear = null;
  }

  if (!res.locals.activeSchoolYear?.id) {
    return next();
  }

  if (sessionUser.role === "student") {
    try {
      const studentContext = await getAsync(
        `SELECT c.name AS class_name
         FROM students s
         JOIN classes c ON c.id = s.class_id
         WHERE s.email = ? AND c.school_year_id = ?`,
        [sessionUser.email, res.locals.activeSchoolYear.id]
      );
      res.locals.sidebarStudentClass = studentContext?.class_name || null;
    } catch (err) {
      res.locals.sidebarStudentClass = null;
    }
  }

  if (sessionUser.role === "teacher") {
    try {
      const kvClasses = await allAsync(
        `SELECT c.name
         FROM classes c
         WHERE c.head_teacher_id = ? AND c.school_year_id = ?
         ORDER BY c.name ASC`,
        [sessionUser.id, res.locals.activeSchoolYear.id]
      );
      const uniqueClassNames = [...new Set(
        kvClasses
          .map((entry) => String(entry?.name || "").trim())
          .filter(Boolean)
      )];
      res.locals.sidebarTeacherKvClasses = uniqueClassNames.join(", ") || null;
    } catch (err) {
      res.locals.sidebarTeacherKvClasses = null;
    }
  }

  return next();
});

// --- Startseite (nach Login) ---
app.get("/", requireAuth, (req, res) => {
  const { email, role } = req.session.user;
  res.render("dashboard", { email, role, csrfToken: req.csrfToken() });
});

// --- Login Seite ---
app.get("/login", (req, res, next) => {
  if (req.session.user) return res.redirect("/");
  if (shouldUseMicrosoftOnlyLogin(req)) {
    if (!microsoftAuthConfig.enabled) {
      return renderMicrosoftAuthError(
        res,
        req,
        "Microsoft-Anmeldung ist derzeit nicht konfiguriert.",
        503
      );
    }
    return saveSessionAndRedirect(req, res, next, "/auth/microsoft");
  }
  renderLogin(res, req);
});

app.get("/auth/microsoft", (req, res, next) => {
  rememberTeamsLoginContext(req);
  if (req.session.user) {
    return res.redirect("/");
  }
  if (!microsoftAuthConfig.enabled) {
    return renderMicrosoftAuthError(
      res,
      req,
      "Microsoft-Anmeldung ist derzeit nicht konfiguriert.",
      503
    );
  }

  const authorizationRequest = createMicrosoftAuthorizationRequest();
  if (!authorizationRequest) {
    return renderMicrosoftAuthError(
      res,
      req,
      "Microsoft-Anmeldung ist derzeit nicht verfuegbar.",
      503
    );
  }

  req.session.microsoftAuth = {
    state: authorizationRequest.state,
    nonce: authorizationRequest.nonce,
    createdAt: Date.now()
  };

  req.session.save((saveErr) => {
    if (saveErr) return next(saveErr);
    res.redirect(authorizationRequest.url);
  });
});

app.get("/auth/microsoft/callback", async (req, res, next) => {
  const authState = req.session.microsoftAuth;
  const isLinkMode = authState?.mode === "link";

  if (req.session.user && !isLinkMode) {
    return res.redirect("/");
  }
  if (!microsoftAuthConfig.enabled) {
    return renderMicrosoftAuthError(
      res,
      req,
      "Microsoft-Anmeldung ist derzeit nicht konfiguriert.",
      503
    );
  }

  const { code, state, error } = req.query || {};
  delete req.session.microsoftAuth;

  if (error) {
    if (isLinkMode) {
      return res.redirect("/account/microsoft-link?error=microsoft-cancelled");
    }
    return renderMicrosoftAuthError(
      res,
      req,
      "Die Microsoft-Anmeldung wurde abgebrochen oder verweigert."
    );
  }

  const isExpired = !authState?.createdAt || Date.now() - authState.createdAt > 10 * 60 * 1000;
  if (!code || !state || !authState || authState.state !== state || isExpired) {
    if (isLinkMode) {
      return res.redirect("/account/microsoft-link?error=microsoft-state");
    }
    return renderMicrosoftAuthError(
      res,
      req,
      "Die Microsoft-Anmeldung konnte nicht bestaetigt werden."
    );
  }

  try {
    const profile = await exchangeMicrosoftCodeForProfile(String(code));
    const email = normalizeEmail(profile.email);

    if (!isAllowedMicrosoftDomain(email)) {
      if (isLinkMode) {
        return res.redirect("/account/microsoft-link?error=domain-blocked");
      }
      return renderMicrosoftAuthError(
        res,
        req,
        "Dieses Microsoft-Konto ist fuer die Schulanmeldung nicht freigegeben.",
        403,
        email
      );
    }

    if (isLinkMode) {
      if (!req.session.user || Number(req.session.user.id) !== Number(authState.userId)) {
        return res.redirect("/account/microsoft-link?error=session-expired");
      }

      const linkingUser = await getAsync(
        "SELECT id, email, status, microsoft_oid, microsoft_tenant_id, microsoft_email FROM users WHERE id = ?",
        [authState.userId]
      );

      if (!linkingUser || linkingUser.status !== "active") {
        return res.redirect("/account/microsoft-link?error=account-missing");
      }

      const existingLinkedUser = await findUserByMicrosoftAccount(profile);
      if (existingLinkedUser && Number(existingLinkedUser.id) !== Number(linkingUser.id)) {
        return res.redirect("/account/microsoft-link?error=already-linked");
      }

      await new Promise((resolve, reject) => {
        db.run(
          "UPDATE users SET microsoft_oid = ?, microsoft_tenant_id = ?, microsoft_email = ?, microsoft_connected_at = current_timestamp WHERE id = ?",
          [profile.oid, profile.tid, email, linkingUser.id],
          (updateErr) => (updateErr ? reject(updateErr) : resolve())
        );
      });

      req.session.user = {
        ...req.session.user,
        microsoft_connected: true,
        microsoft_email: email
      };

      return req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        return res.redirect("/account/microsoft-link?linked=1");
      });
    }

    const user = await findUserByMicrosoftAccount(profile);
    if (!user || user.status !== "active") {
      return renderMicrosoftAuthError(
        res,
        req,
        "Dieses Microsoft-Konto ist noch mit keinem NVS-Konto verknuepft.",
        401,
        email
      );
    }

    const redirectTarget = await completeLogin(req, user);
    return res.redirect(redirectTarget);
  } catch (err) {
    if (err?.isMicrosoftAuthError) {
      console.error("Microsoft auth failed:", {
        message: err.message,
        status: err.status,
        details: err.details || null
      });
      if (isLinkMode) {
        return res.redirect("/account/microsoft-link?error=microsoft-failed");
      }
      return renderMicrosoftAuthError(
        res,
        req,
        "Microsoft-Anmeldung fehlgeschlagen. Bitte spaeter erneut versuchen."
      );
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
  if (shouldUseMicrosoftOnlyLogin(req)) {
    if (!microsoftAuthConfig.enabled) {
      return renderMicrosoftAuthError(
        res,
        req,
        "Microsoft-Anmeldung ist derzeit nicht konfiguriert.",
        503
      );
    }
    return res.redirect("/auth/microsoft");
  }

  const { email, password } = req.body || {};
  const loginKey = buildLoginKey(req, email);
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
  let user;
  try {
    user = await getAsync(
      "SELECT id, email, password_hash, role, status, must_change_password, microsoft_oid, microsoft_tenant_id, microsoft_email FROM users WHERE email = ?",
      [email]
    );
  } catch (err) {
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

  try {
    const redirectTarget = await completeLogin(req, user, loginKey);
    return res.redirect(redirectTarget);
  } catch (err) {
    return next(err);
  }
});

// --- Logout ---
app.post("/logout", (req, res) => {
  const teamsLogin = Boolean(req.session?.teamsLogin);
  req.session.destroy(() => res.redirect(teamsLogin ? "/login?teams=1" : "/login"));
});

// --- Router Mounts ---
app.use("/admin", adminRouter);
app.use("/admin", assignmentRouter);
app.use("/admin", rolloverRouter);
app.use("/account", accountRouter);
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server läuft auf Port ${PORT}`);
    console.log('PGHOST:', process.env.PGHOST);
  });
}
