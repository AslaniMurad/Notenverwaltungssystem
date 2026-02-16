function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
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
