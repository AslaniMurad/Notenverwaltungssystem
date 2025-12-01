// db.js
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

// --- Pfade/DB-Datei ---
const DB_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DB_DIR, "app.sqlite");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// --- DB öffnen ---
const db = new sqlite3.Database(DB_FILE);

// --- Password-Hashing via scrypt (ohne externe Lib) ---
// Wir speichern die Parameter im Hash, damit verify immer passt.
// Kosten so gewählt, dass sie auf allen Rechnern stabil laufen.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 1 << 14;        // 16384 (etwas niedriger als 32768, dafür stabil)
  const r = 8;
  const p = 1;
  const keylen = 64;

  const derivedKey = crypto.scryptSync(password, salt, keylen, {
    N, r, p,
    // Begrenze RAM-Verbrauch, um "memory limit exceeded" zu vermeiden
    maxmem: 128 * 1024 * 1024 // 128 MB
  });

  // Format: scrypt$N$r$p$saltB64$hashB64
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

function verifyPassword(stored, password) {
  try {
    const [alg, Ns, rs, ps, saltB64, hashB64] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const N = parseInt(Ns, 10);
    const r = parseInt(rs, 10);
    const p = parseInt(ps, 10);
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");

    const derived = crypto.scryptSync(password, salt, expected.length, {
      N, r, p,
      maxmem: 128 * 1024 * 1024
    });

    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

// --- Tabellen anlegen & Seed-Admin erstellen ---
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
  // Generiere ein starkes Initial-Passwort zur Laufzeit, falls keines via ENV gesetzt wurde.
  // Dadurch vermeiden wir ein hartkodiertes Default-Passwort im Repository.
  const ADMIN_PASS = process.env.ADMIN_PASS || (function(){
    const raw = crypto.randomBytes(12).toString('base64');
    // Entferne problematische Zeichen, begrenze Länge auf 16
    return raw.replace(/[^A-Za-z0-9]/g,'A').slice(0,16);
  })();

  db.get("SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL], (err, row) => {
    if (err) {
      console.error("Fehler beim Prüfen des Seed-Admins:", err);
      return;
    }
    if (!row) {
      const hash = hashPassword(ADMIN_PASS);
      db.run(
        "INSERT INTO users (email, password_hash, role, status) VALUES (?,?, 'admin','active')",
        [ADMIN_EMAIL, hash],
        (e) => {
          if (e) {
            console.error("Seed-Admin konnte nicht angelegt werden:", e);
          } else {
            console.log("Seed-Admin angelegt:", ADMIN_EMAIL);
            if (!process.env.ADMIN_PASS) {
              console.log("Initial-Passwort (nur Laufzeit, bitte setzen Sie ADMIN_PASS für Wiederholbarkeit):", ADMIN_PASS);
            } else {
              console.log("Admin-Passwort aus Umgebungsvariable verwendet.");
            }
          }
        }
      );
    }
  });
});

module.exports = {
  db,
  hashPassword,
  verifyPassword
};
