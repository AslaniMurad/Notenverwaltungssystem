const PENDING_WEBUNTIS_REDIRECT_SESSION_KEY = "pendingWebUntisRedirect";

function getPendingWebUntisRedirect(req) {
  if (req.method !== "GET") return "";

  const originalUrl = String(req.originalUrl || "");
  if (!originalUrl) return "";

  let parsedUrl;
  try {
    parsedUrl = new URL(originalUrl, "http://nvs.local");
  } catch {
    return "";
  }

  if (parsedUrl.origin !== "http://nvs.local") return "";
  if (parsedUrl.pathname !== "/student/grades") return "";
  if (String(parsedUrl.searchParams.get("from") || "").toLowerCase() !== "webuntis") {
    return "";
  }

  return `${parsedUrl.pathname}${parsedUrl.search}`;
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    const pendingRedirect = getPendingWebUntisRedirect(req);
    if (!pendingRedirect) return res.redirect("/login");

    req.session[PENDING_WEBUNTIS_REDIRECT_SESSION_KEY] = pendingRedirect;
    return req.session.save((err) => {
      if (err) return next(err);
      return res.redirect("/login");
    });
  }
  if (req.session.user.status !== "active") {
    return res.status(403).render("error", {
      message: "Account gesperrt.",
      status: 403,
      backUrl: "/login"
    });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).render("error", {
        message: "Zugriff verweigert.",
        status: 403,
        backUrl: req.get("referer") || "/"
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
