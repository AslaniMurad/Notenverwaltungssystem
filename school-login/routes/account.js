const express = require("express");
const { db, verifyPassword } = require("../db");
const { requireAuth } = require("../middleware/auth");
const {
  microsoftAuthConfig,
  createMicrosoftAuthorizationRequest,
  normalizeEmail
} = require("../services/microsoftAuth");

const router = express.Router();

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

function getRedirectForRole(role) {
  const redirectMap = {
    admin: "/admin",
    teacher: "/teacher/classes",
    student: "/student"
  };
  return redirectMap[role] || "/";
}

function resolveLinkFeedback(query = {}) {
  if (query.linked === "1") {
    return {
      tone: "success",
      message: "Dein NVS-Konto ist jetzt mit Microsoft verknuepft."
    };
  }

  const errors = {
    "microsoft-cancelled": "Die Microsoft-Anmeldung wurde abgebrochen.",
    "microsoft-state": "Die Microsoft-Verknuepfung konnte nicht bestaetigt werden.",
    "microsoft-failed": "Microsoft konnte die Verknuepfung nicht abschliessen.",
    "domain-blocked": "Dieses Microsoft-Konto ist fuer die Schule nicht freigegeben.",
    "session-expired": "Deine Sitzung ist abgelaufen. Bitte pruefe dein Passwort erneut.",
    "account-missing": "Dein NVS-Konto ist nicht mehr aktiv.",
    "already-linked": "Dieses Microsoft-Konto ist bereits mit einem anderen NVS-Konto verknuepft."
  };

  const message = errors[String(query.error || "")];
  if (!message) return null;
  return { tone: "error", message };
}

async function loadLinkPageModel(req, overrides = {}) {
  const currentUser = await getAsync(
    "SELECT id, email, status, microsoft_oid, microsoft_tenant_id, microsoft_email FROM users WHERE id = ?",
    [req.session.user.id]
  );

  const feedback = overrides.feedback || resolveLinkFeedback(req.query);

  return {
    title: "Microsoft verknuepfen",
    headerTitle: "Konto",
    styles: ["/css/account-link.css"],
    scripts: ["/js/app.js"],
    bodyClass: "page-account-link",
    hideHeader: true,
    hideFooter: true,
    currentUser: req.session.user,
    csrfToken: req.csrfToken(),
    formEmail: overrides.formEmail ?? req.session.user.email,
    feedback,
    microsoftAuthEnabled: microsoftAuthConfig.enabled,
    microsoftConnected: Boolean(currentUser?.microsoft_oid && currentUser?.microsoft_tenant_id),
    microsoftEmail: currentUser?.microsoft_email || "",
    backUrl: getRedirectForRole(req.session.user.role)
  };
}

router.get("/microsoft-link", requireAuth, async (req, res, next) => {
  try {
    const pageModel = await loadLinkPageModel(req);
    return res.render("account/microsoft-link", pageModel);
  } catch (err) {
    return next(err);
  }
});

router.post("/microsoft-link", requireAuth, async (req, res, next) => {
  const submittedEmail = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");

  try {
    const currentUser = await getAsync(
      "SELECT id, email, password_hash, role, status, must_change_password, microsoft_oid, microsoft_tenant_id, microsoft_email FROM users WHERE email = ?",
      [req.session.user.email]
    );

    if (!microsoftAuthConfig.enabled) {
      const pageModel = await loadLinkPageModel(req, {
        formEmail: submittedEmail || req.session.user.email,
        feedback: {
          tone: "error",
          message: "Microsoft-Anmeldung ist derzeit nicht konfiguriert."
        }
      });
      return res.status(503).render("account/microsoft-link", pageModel);
    }

    if (!submittedEmail || !password) {
      const pageModel = await loadLinkPageModel(req, {
        formEmail: submittedEmail,
        feedback: {
          tone: "error",
          message: "Bitte gib deine NVS-E-Mail-Adresse und dein Passwort ein."
        }
      });
      return res.status(400).render("account/microsoft-link", pageModel);
    }

    if (!currentUser || currentUser.status !== "active") {
      const pageModel = await loadLinkPageModel(req, {
        formEmail: submittedEmail,
        feedback: {
          tone: "error",
          message: "Dein aktuelles NVS-Konto ist nicht aktiv."
        }
      });
      return res.status(403).render("account/microsoft-link", pageModel);
    }

    if (submittedEmail !== normalizeEmail(currentUser.email) || !verifyPassword(currentUser.password_hash, password)) {
      const pageModel = await loadLinkPageModel(req, {
        formEmail: submittedEmail,
        feedback: {
          tone: "error",
          message: "Die eingegebene NVS-E-Mail oder das Passwort stimmen nicht."
        }
      });
      return res.status(401).render("account/microsoft-link", pageModel);
    }

    const authorizationRequest = createMicrosoftAuthorizationRequest();
    if (!authorizationRequest) {
      const pageModel = await loadLinkPageModel(req, {
        formEmail: submittedEmail,
        feedback: {
          tone: "error",
          message: "Microsoft-Anmeldung ist derzeit nicht verfuegbar."
        }
      });
      return res.status(503).render("account/microsoft-link", pageModel);
    }

    req.session.microsoftAuth = {
      mode: "link",
      userId: currentUser.id,
      state: authorizationRequest.state,
      nonce: authorizationRequest.nonce,
      createdAt: Date.now()
    };

    return req.session.save((saveErr) => {
      if (saveErr) return next(saveErr);
      return res.redirect(authorizationRequest.url);
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
