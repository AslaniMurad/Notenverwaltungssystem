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

module.exports = { requireAuth, requireRole };