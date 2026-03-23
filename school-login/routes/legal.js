const express = require("express");

const router = express.Router();

function getRedirectForRole(role) {
  const redirectMap = {
    admin: "/admin",
    teacher: "/teacher",
    student: "/student"
  };
  return redirectMap[role] || "/";
}

function buildHeaderActions(req) {
  const user = req.session?.user;
  if (!user) {
    return [{ href: "/login", label: "Zum Login" }];
  }
  return [{ href: getRedirectForRole(user.role), label: "Zum Bereich" }];
}

router.get(["/nutzungsbedingungen", "/terms"], (req, res) => {
  res.render("legal/terms", {
    headerActions: buildHeaderActions(req)
  });
});

router.get(["/datenschutz", "/privacy"], (req, res) => {
  res.render("legal/privacy", {
    headerActions: buildHeaderActions(req)
  });
});

module.exports = router;
