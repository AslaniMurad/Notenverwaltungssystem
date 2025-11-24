const express = require("express");
const router = express.Router();
const path = require("path");
const { db, hashPassword } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

// Alle Admin-Routen schützen
router.use(requireAuth, requireRole("admin"));

// Liste + Erstellen (Create form + Tabelle)
router.get("/", (req, res, next) => {
  db.all(
    // Nur sichere/standard Spalten auswählen, damit fehlende optionale Spalten keine Fehler verursachen
    "SELECT id, email, role, status FROM users ORDER BY id DESC",
    [],
    (err, users) => {
      if (err) {
        console.error("DB error fetching users (admin.index):", err);
        return next(err);
      }
      res.render("admin/index", { users, csrfToken: req.csrfToken() });
    }
  );
});

// Create user
router.post("/users", (req, res, next) => {
  const { email, role, password } = req.body || {};
  if (!email || !role || !password) return res.status(400).render("error", {
    message: "Fehlende Felder beim Erstellen eines Nutzers.",
    status: 400,
    backUrl: "/admin",
    csrfToken: req.csrfToken()
  });
  const hash = hashPassword(password);
  db.run(
    "INSERT INTO users (email, password_hash, role, status, created_at) VALUES (?,?,?,?, datetime('now'))",
    [email, hash, role, "active"],
    function (err) {
      if (err) {
        console.error("DB error inserting user:", err);
        if (String(err).includes("UNIQUE")) {
          return res.status(409).render("error", {
            message: "E‑Mail existiert bereits.",
            status: 409,
            backUrl: "/admin",
            csrfToken: req.csrfToken()
          });
        }
        return next(err);
      }
      res.redirect("/admin");
    }
  );
});

// Edit form
router.get("/users/:id/edit", (req, res, next) => {
  const id = req.params.id;
  db.get(
    "SELECT id, email, role, status FROM users WHERE id = ?",
    [id],
    (err, user) => {
      if (err) {
        console.error("DB error fetching user for edit:", err);
        return next(err);
      }
      if (!user) return res.status(404).render("error", {
        message: "Nutzer nicht gefunden.",
        status: 404,
        backUrl: "/admin",
        csrfToken: req.csrfToken()
      });
      res.render("admin/edit", { user, csrfToken: req.csrfToken() });
    }
  );
});

// Update user (E-Mail/Role/Status)
router.post("/users/:id", (req, res, next) => {
  const id = req.params.id;
  const { email, role, status } = req.body || {};
  if (!email || !role || !status) return res.status(400).render("error", {
    message: "Fehlende Felder beim Aktualisieren.",
    status: 400,
    backUrl: `/admin/users/${id}/edit`,
    csrfToken: req.csrfToken()
  });
  db.run(
    "UPDATE users SET email = ?, role = ?, status = ? WHERE id = ?",
    [email, role, status, id],
    function (err) {
      if (err) {
        console.error("DB error updating user:", err);
        if (String(err).includes("UNIQUE")) {
          return res.status(409).render("error", {
            message: "E‑Mail existiert bereits.",
            status: 409,
            backUrl: `/admin/users/${id}/edit`,
            csrfToken: req.csrfToken()
          });
        }
        return next(err);
      }
      res.redirect("/admin");
    }
  );
});

// Reset password (setzt neues Passwort aus Form)
router.post("/users/:id/reset", (req, res, next) => {
  const id = req.params.id;
  const { password } = req.body || {};
  if (!password) return res.status(400).render("error", {
    message: "Kein Passwort angegeben.",
    status: 400,
    backUrl: `/admin/users/${id}/edit`,
    csrfToken: req.csrfToken()
  });
  const hash = hashPassword(password);
  db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, id], function (err) {
    if (err) {
      console.error("DB error resetting password:", err);
      return next(err);
    }
    res.redirect("/admin");
  });
});

// Soft-delete (status = 'deleted')
router.post("/users/:id/delete", (req, res, next) => {
  const id = req.params.id;
  db.run("UPDATE users SET status = 'deleted' WHERE id = ?", [id], function (err) {
    if (err) {
      console.error("DB error deleting user:", err);
      return next(err);
    }
    res.redirect("/admin");
  });
});

module.exports = router;