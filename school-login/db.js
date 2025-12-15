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
  const grades = [];
  const notifications = [];
  let userId = 1;
  let classId = 1;
  let studentId = 1;
  let gradeId = 1;
  let notificationId = 1;

  const db = {
    serialize(fn) {
      fn();
    },
    run(sql, params = [], cb) {
      let err = null;
      let lastID;

      if (/INSERT INTO users/i.test(sql)) {
        const [email, password_hash, role, status] = params;
        const resolvedRole =
          role || (/\'teacher\'/i.test(sql) ? "teacher" : /\'student\'/i.test(sql) ? "student" : /\'admin\'/i.test(sql) ? "admin" : undefined);
        const resolvedStatus = status || (/\'active\'/i.test(sql) ? "active" : undefined) || "active";
        if (users.some((u) => u.email === email)) {
          err = new Error("UNIQUE constraint failed: users.email");
        } else {
          const newUser = {
            id: userId++,
            email,
            password_hash,
            role: resolvedRole,
            status: resolvedStatus,
            created_at: new Date().toISOString()
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
      } else if (/UPDATE users SET password_hash = \? WHERE id = \?/i.test(sql)) {
        const [password_hash, id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.password_hash = password_hash;
        }
      } else if (/UPDATE users SET status = 'deleted' WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.status = "deleted";
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
            school_year: params[3] || "2024/25",
            created_at: new Date().toISOString()
          };
          students.push(newStudent);
          lastID = newStudent.id;
        }
      } else if (/INSERT INTO grades/i.test(sql)) {
        const [student_id, subject, value, weight, comment, teacher, graded_at] = params;
        const newGrade = {
          id: gradeId++,
          student_id: Number(student_id),
          subject,
          value: Number(value),
          weight: weight != null ? Number(weight) : 1,
          comment: comment || null,
          teacher: teacher || null,
          graded_at: graded_at || new Date().toISOString(),
          created_at: new Date().toISOString()
        };
        grades.push(newGrade);
        lastID = newGrade.id;
      } else if (/INSERT INTO grade_notifications/i.test(sql)) {
        const [student_id, message, type, created_at] = params;
        const notification = {
          id: notificationId++,
          student_id: Number(student_id),
          message,
          type: type || "info",
          created_at: created_at || new Date().toISOString(),
          read_at: null
        };
        notifications.push(notification);
        lastID = notification.id;
      } else if (/UPDATE grade_notifications SET read_at = current_timestamp WHERE id = \? AND student_id = \?/i.test(sql)) {
        const [id, student_id] = params.map(Number);
        const note = notifications.find((n) => n.id === id && n.student_id === student_id);
        if (note) note.read_at = new Date().toISOString();
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
      } else if (/SELECT id, email, password_hash, role, status FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user
          ? {
              id: user.id,
              email: user.email,
              password_hash: user.password_hash,
              role: user.role,
              status: user.status
            }
          : undefined;
      } else if (/SELECT id, role FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user ? { id: user.id, role: user.role } : undefined;
      } else if (/SELECT id, email, role, status FROM users WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        row = user
          ? { id: user.id, email: user.email, role: user.role, status: user.status }
          : undefined;
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
      } else if (/SELECT s\.\*, c\.name as class_name, c\.subject as class_subject, c\.id as class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.email = \?/i.test(sql)) {
        const [email] = params;
        const student = students.find((s) => s.email === email);
        if (student) {
          const cls = classes.find((c) => c.id === student.class_id);
          row = {
            ...student,
            class_name: cls?.name,
            class_subject: cls?.subject,
            class_id: cls?.id
          };
        }
      }

      if (typeof cb === "function") cb(null, row);
    },
    all(sql, params = [], cb) {
      let rows = [];
      if (/SELECT id, email, role, status FROM users ORDER BY id DESC/i.test(sql)) {
        rows = [...users]
          .sort((a, b) => b.id - a.id)
          .map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status }));
      } else if (/SELECT id, name, subject FROM classes WHERE teacher_id = \? ORDER BY created_at DESC/i.test(sql)) {
        const [teacher_id] = params;
        rows = classes
          .filter((c) => c.teacher_id === Number(teacher_id))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .map((c) => ({ id: c.id, name: c.name, subject: c.subject }));
      } else if (/SELECT id, name, email FROM students WHERE class_id = \? ORDER BY name/i.test(sql)) {
        const [class_id] = params;
        rows = students
          .filter((s) => s.class_id === Number(class_id))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({ id: s.id, name: s.name, email: s.email }));
      } else if (/SELECT id, subject, value, weight, comment, teacher, graded_at, created_at FROM grades WHERE student_id = \?/i.test(sql)) {
        const [student_id] = params;
        rows = grades
          .filter((g) => g.student_id === Number(student_id))
          .map((g) => ({ ...g }));
      } else if (/SELECT g\.subject, g\.value, g\.weight FROM grades g JOIN students s ON s.id = g.student_id WHERE s.class_id = \?/i.test(sql)) {
        const [class_id] = params;
        const studentIds = students.filter((s) => s.class_id === Number(class_id)).map((s) => s.id);
        rows = grades
          .filter((g) => studentIds.includes(g.student_id))
          .map((g) => ({ subject: g.subject, value: g.value, weight: g.weight }));
      } else if (/SELECT id, message, type, created_at, read_at FROM grade_notifications WHERE student_id = \? ORDER BY created_at DESC/i.test(sql)) {
        const [student_id] = params;
        rows = notifications
          .filter((n) => n.student_id === Number(student_id))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((n) => ({ ...n }));
      } else if (/SELECT id, name, subject, teacher_id FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const cls = classes.find((c) => c.id === Number(id));
        rows = cls ? [{ ...cls }] : [];
      } else if (/PRAGMA table_info\(users\)/i.test(sql) || /PRAGMA table_info\(students\)/i.test(sql)) {
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
      "INSERT INTO users (email, password_hash, role, status) VALUES (?,?,?, 'active')",
      [ADMIN_EMAIL, hash, "admin", "active"],
      () => {}
    );
  }

  function seedDemoStudent() {
    const teacherHash = hashPassword("teacherDemo123!");
    const studentHash = hashPassword("studentDemo123!");

    db.run("INSERT INTO users (email, password_hash, role, status) VALUES (?,?, 'teacher', 'active')", ["teacher@example.com", teacherHash]);
    db.run("INSERT INTO users (email, password_hash, role, status) VALUES (?,?, 'student', 'active')", ["student@example.com", studentHash]);

    db.run("INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)", ["3AHWII", "Informatik", 2], function () {
      const createdClassId = this.lastID;
      db.run("INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)", ["Max Muster", "student@example.com", createdClassId, "2024/25"], function () {
        const studentId = this.lastID;
        const now = new Date();
        db.run(
          "INSERT INTO grades (student_id, subject, value, weight, comment, teacher, graded_at) VALUES (?,?,?,?,?,?,?)",
          [studentId, "Mathematik", 2, 0.4, "Gute Struktur", "Frau König", new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString()]
        );
        db.run(
          "INSERT INTO grades (student_id, subject, value, weight, comment, teacher, graded_at) VALUES (?,?,?,?,?,?,?)",
          [studentId, "Informatik", 1.5, 0.35, "Sauberer Code", "Herr Leitner", new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString()]
        );
        db.run(
          "INSERT INTO grades (student_id, subject, value, weight, comment, teacher, graded_at) VALUES (?,?,?,?,?,?,?)",
          [studentId, "Deutsch", 3, 0.25, "Mehr Quellenangaben", "Frau Bauer", now.toISOString()]
        );
        db.run(
          "INSERT INTO grade_notifications (student_id, message, type, created_at) VALUES (?,?,?,?)",
          [studentId, "Neue Note in Informatik eingetragen.", "grade", now.toISOString()]
        );
      });
    });
  }

  seedAdmin();
  seedDemoStudent();
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
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

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
        "INSERT INTO users (email, password_hash, role, status) VALUES (?,?, 'admin','active')",
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
      school_year TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES classes(id),
      UNIQUE(email, class_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      value REAL NOT NULL,
      weight REAL DEFAULT 1,
      comment TEXT,
      teacher TEXT,
      graded_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (student_id) REFERENCES students(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS grade_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      FOREIGN KEY (student_id) REFERENCES students(id)
    )
  `);
});

// --- Ensure new columns exist for legacy DBs ---
db.all("PRAGMA table_info(students)", [], (err, cols) => {
  if (err) return;
  const hasSchoolYear = cols.some((c) => c.name === "school_year");
  if (!hasSchoolYear) {
    db.run("ALTER TABLE students ADD COLUMN school_year TEXT", [], () => {});
  }
});

// --- Seed demo users and sample data for local testing ---
function seedDemoData() {
  const teacherEmail = "teacher@example.com";
  const studentEmail = "student@example.com";

  db.get("SELECT id FROM users WHERE email = ?", [teacherEmail], (err, teacherRow) => {
    if (err || teacherRow) return;
    const teacherHash = hashPassword("teacherDemo123!");
    db.run("INSERT INTO users (email, password_hash, role, status) VALUES (?,?, 'teacher','active')", [teacherEmail, teacherHash], function () {
      const teacherId = this.lastID;
      db.run("INSERT INTO users (email, password_hash, role, status) VALUES (?,?, 'student','active')", [studentEmail, hashPassword("studentDemo123!")], function () {
        const studentUserId = this.lastID;
        db.run("INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)", ["3AHWII", "Informatik", teacherId], function () {
          const classId = this.lastID;
          db.run("INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)", ["Max Muster", studentEmail, classId, "2024/25"], function () {
            const studentId = this.lastID;
            const now = new Date();
            const fourteenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString();
            const sevenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString();

            db.run("INSERT INTO grades (student_id, subject, value, weight, comment, teacher, graded_at) VALUES (?,?,?,?,?,?,?)", [studentId, "Mathematik", 2, 0.4, "Gute Struktur", "Frau König", fourteenDays]);
            db.run("INSERT INTO grades (student_id, subject, value, weight, comment, teacher, graded_at) VALUES (?,?,?,?,?,?,?)", [studentId, "Informatik", 1.5, 0.35, "Sauberer Code", "Herr Leitner", sevenDays]);
            db.run("INSERT INTO grades (student_id, subject, value, weight, comment, teacher, graded_at) VALUES (?,?,?,?,?,?,?)", [studentId, "Deutsch", 3, 0.25, "Mehr Quellenangaben", "Frau Bauer", now.toISOString()]);
            db.run("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [studentId, "Neue Note in Informatik eingetragen.", "grade"]);
            db.run("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [studentId, "Dein Notendurchschnitt hat sich verbessert!", "average"]);
          });
        });
      });
    });
  });
}

seedDemoData();

module.exports = {
  db,
  hashPassword,
  verifyPassword
};
