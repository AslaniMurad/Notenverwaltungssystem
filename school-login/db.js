// db.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// --- Password-Hashing via scrypt (ohne externe Lib)
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

const useFakeDb = process.env.USE_FAKE_DB === "true";

function createFakeDb() {
  const users = [];
  const classes = [];
  const students = [];
  let userId = 1;
  let classId = 1;
  let studentId = 1;

  const db = {
    serialize(fn) {
      fn();
    },
    run(sql, params = [], cb) {
      let err = null;
      let lastID;

      if (/INSERT INTO users/i.test(sql)) {
        const [email, password_hash, role, status, must_change_password] = params;
        if (users.some((u) => u.email === email)) {
          err = new Error("UNIQUE constraint failed: users.email");
        } else {
          const newUser = {
            id: userId++,
            email,
            password_hash,
            role,
            status: status || "active",
            created_at: new Date().toISOString(),
            must_change_password: must_change_password ? 1 : 0
          };
          users.push(newUser);
          lastID = newUser.id;
        }
      } else if (/UPDATE users SET email = \?, role = \?, status = \? WHERE id = \?/i.test(sql)) {
        const [email, role, status, id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.email = email;
          user.role = role;
          user.status = status;
        }
      } else if (/UPDATE users SET password_hash = \?, must_change_password = \? WHERE id = \?/i.test(sql)) {
        const [password_hash, must_change_password, id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.password_hash = password_hash;
          user.must_change_password = must_change_password;
        }
      } else if (/UPDATE users SET status = 'deleted' WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.status = "deleted";
        }
      } else if (/UPDATE users SET must_change_password = \? WHERE id = \?/i.test(sql)) {
        const [must_change_password, id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.must_change_password = must_change_password;
        }
      } else if (/UPDATE classes SET name = \?, subject = \?, teacher_id = \? WHERE id = \?/i.test(sql)) {
        const [name, subject, teacher_id, id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          classRow.name = name;
          classRow.subject = subject;
          classRow.teacher_id = Number(teacher_id);
        }
      } else if (/INSERT INTO classes/i.test(sql)) {
        const [name, subject, teacher_id] = params;
        const newClass = {
          id: classId++,
          name,
          subject,
          teacher_id: Number(teacher_id),
          created_at: new Date().toISOString()
        };
        classes.push(newClass);
        lastID = newClass.id;
      } else if (/DELETE FROM students WHERE class_id = \?/i.test(sql)) {
        const [classIdParam] = params;
        for (let i = students.length - 1; i >= 0; i -= 1) {
          if (students[i].class_id === Number(classIdParam)) students.splice(i, 1);
        }
      } else if (/DELETE FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        for (let i = classes.length - 1; i >= 0; i -= 1) {
          if (classes[i].id === Number(id)) classes.splice(i, 1);
        }
      } else if (/INSERT INTO students/i.test(sql)) {
        const [name, email, class_id] = params;
        if (students.some((s) => s.email === email && s.class_id === Number(class_id))) {
          err = new Error("UNIQUE constraint failed: students.email, students.class_id");
        } else {
          const newStudent = {
            id: studentId++,
            name,
            email,
            class_id: Number(class_id),
            created_at: new Date().toISOString()
          };
          students.push(newStudent);
          lastID = newStudent.id;
        }
      }

      if (typeof cb === "function") {
        if (err) cb(err);
        else cb.call({ lastID }, null);
      }
    },
    get(sql, params = [], cb) {
      let row;
      if (/SELECT id FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user ? { id: user.id } : undefined;
      } else if (/SELECT id, email, password_hash, role, status, must_change_password FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user
          ? {
              id: user.id,
              email: user.email,
              password_hash: user.password_hash,
              role: user.role,
              status: user.status,
              must_change_password: user.must_change_password || 0
            }
          : undefined;
      } else if (/SELECT id, role FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user ? { id: user.id, role: user.role } : undefined;
      } else if (/SELECT id, email, role, status, must_change_password FROM users WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        row = user
          ? { id: user.id, email: user.email, role: user.role, status: user.status, must_change_password: user.must_change_password || 0 }
          : undefined;
      } else if (/SELECT id, name, subject FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow ? { id: classRow.id, name: classRow.name, subject: classRow.subject } : undefined;
      } else if (/SELECT c.id, c.name, c.subject, u.email AS teacher_email FROM classes c/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          const teacher = users.find((u) => u.id === classRow.teacher_id);
          row = {
            id: classRow.id,
            name: classRow.name,
            subject: classRow.subject,
            teacher_email: teacher ? teacher.email : null,
            teacher_id: classRow.teacher_id
          };
        }
      } else if (/SELECT COUNT\(\*\) AS count FROM users/i.test(sql)) {
        row = { count: users.length };
      } else if (/SELECT COUNT\(\*\) AS count FROM classes/i.test(sql)) {
        row = { count: classes.length };
      } else if (/SELECT COUNT\(\*\) AS count FROM students/i.test(sql)) {
        row = { count: students.length };
      } else if (/SELECT id FROM classes WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const classRow = classes.find((c) => c.id === Number(id) && c.teacher_id === Number(teacher_id));
        row = classRow ? { id: classRow.id } : undefined;
      } else if (/SELECT id, name, subject FROM classes WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const classRow = classes.find((c) => c.id === Number(id) && c.teacher_id === Number(teacher_id));
        row = classRow ? { id: classRow.id, name: classRow.name, subject: classRow.subject } : undefined;
      } else if (/SELECT id, name FROM classes WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const classRow = classes.find((c) => c.id === Number(id) && c.teacher_id === Number(teacher_id));
        row = classRow ? { id: classRow.id, name: classRow.name } : undefined;
      } else if (/SELECT id FROM students WHERE email = \? AND class_id = \?/i.test(sql)) {
        const [email, class_id] = params;
        const student = students.find((s) => s.email === email && s.class_id === Number(class_id));
        row = student ? { id: student.id } : undefined;
      }

      if (typeof cb === "function") cb(null, row);
    },
    all(sql, params = [], cb) {
      let rows = [];
      if (/SELECT id, email, role, status, created_at, must_change_password FROM users ORDER BY id DESC/i.test(sql)) {
        rows = [...users]
          .sort((a, b) => b.id - a.id)
          .map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, created_at: u.created_at, must_change_password: u.must_change_password || 0 }));
      } else if (/SELECT id, name, subject FROM classes WHERE teacher_id = \? ORDER BY created_at DESC/i.test(sql)) {
        const [teacher_id] = params;
        rows = classes
          .filter((c) => c.teacher_id === Number(teacher_id))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .map((c) => ({ id: c.id, name: c.name, subject: c.subject }));
      } else if (/SELECT id, email FROM users WHERE role = 'teacher' AND status = 'active'/i.test(sql)) {
        rows = users
          .filter((u) => u.role === "teacher" && u.status === "active")
          .sort((a, b) => a.email.localeCompare(b.email))
          .map((u) => ({ id: u.id, email: u.email }));
      } else if (/SELECT c.id, c.name, c.subject, c.created_at, u.email AS teacher_email, u.id AS teacher_id/i.test(sql)) {
        rows = classes
          .filter((c) => {
            if (!params.length) return true;
            const [like] = params;
            const teacher = users.find((u) => u.id === c.teacher_id);
            const haystack = `${c.name} ${c.subject} ${teacher?.email || ''}`.toLowerCase();
            return haystack.includes(String(like).replace(/%/g, '').toLowerCase());
          })
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .map((c) => {
            const teacher = users.find((u) => u.id === c.teacher_id);
            return {
              id: c.id,
              name: c.name,
              subject: c.subject,
              created_at: c.created_at,
              teacher_email: teacher ? teacher.email : null,
              teacher_id: teacher ? teacher.id : null
            };
          });
      } else if (/SELECT id, name, email FROM students WHERE class_id = \? ORDER BY name/i.test(sql)) {
        const [class_id] = params;
        rows = students
          .filter((s) => s.class_id === Number(class_id))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({ id: s.id, name: s.name, email: s.email }));
      } else if (/PRAGMA table_info\(users\)/i.test(sql)) {
        rows = [];
      }

      if (typeof cb === "function") cb(null, rows);
    }
  };

  function seedAdmin() {
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
    const ADMIN_PASS = process.env.ADMIN_PASS || "admin1234!ChangeMe";
    const hash = hashPassword(ADMIN_PASS);
    db.run(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?, 'active', 0)",
      [ADMIN_EMAIL, hash, "admin", "active"],
      () => {}
    );
  }

  seedAdmin();
  return db;
}

if (useFakeDb) {
  const db = createFakeDb();
  module.exports = { db, hashPassword, verifyPassword };
  return;
}

const sqlite3 = require("sqlite3").verbose();

// --- Pfade/DB-Datei ---
const DB_DIR = path.join(__dirname, "data");
const configuredDbFile = process.env.DB_FILE;
const DB_FILE = configuredDbFile || path.join(DB_DIR, "app.sqlite");
const isMemoryDb = DB_FILE === ":memory:";
const targetDir = configuredDbFile ? path.dirname(DB_FILE) : DB_DIR;

if (!isMemoryDb && targetDir && !fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// --- DB öffnen ---
const db = new sqlite3.Database(DB_FILE);

// --- Tabellen anlegen & Seed-Admin erstellen ---
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleted')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.all("PRAGMA table_info(users)", (infoErr, columns) => {
    if (infoErr) {
      console.error("Konnte user-Spalten nicht prüfen:", infoErr);
      return;
    }
    const hasMustChange = columns.some((col) => col.name === "must_change_password");
    if (!hasMustChange) {
      db.run("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
    }
    const hasStatusDeleted = columns.some((col) => col.name === "status");
    if (hasStatusDeleted) {
      db.run("UPDATE users SET status = 'active' WHERE status NOT IN ('active','locked','deleted')");
    }
  });

  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
  const ADMIN_PASS  = process.env.ADMIN_PASS  || "admin1234!ChangeMe";

  db.get("SELECT id FROM users WHERE email = ?", [ADMIN_EMAIL], (err, row) => {
    if (err) {
      console.error("Fehler beim Prüfen des Seed-Admins:", err);
      return;
    }
    if (!row) {
      const hash = hashPassword(ADMIN_PASS);
      db.run(
        "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?, 'admin','active', 0)",
        [ADMIN_EMAIL, hash],
        (e) => {
          if (e) {
            console.error("Seed-Admin konnte nicht angelegt werden:", e);
          } else {
            console.log("Seed-Admin angelegt:", ADMIN_EMAIL);
            console.log("Initial-Passwort:", ADMIN_PASS);
          }
        }
      );
    }
  });

  // Klassen-Tabelle
  db.run(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      teacher_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (teacher_id) REFERENCES users(id)
    )
  `);

  // Schüler-Tabelle
  db.run(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      class_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES classes(id),
      UNIQUE(email, class_id)
    )
  `);
});


module.exports = {
  db,
  hashPassword,
  verifyPassword
};
