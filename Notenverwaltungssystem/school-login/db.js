// db.js
const crypto = require("crypto");
const { Pool } = require("pg");

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
const seedAdminEnabled = process.env.SEED_ADMIN === "true";
const seedDemoEnabled = process.env.SEED_DEMO === "true";

function createFakeDb() {
  const users = [];
  const classes = [];
  const students = [];
  const gradeTemplates = [];
  const grades = [];
  const specialAssessments = [];
  const notifications = [];
  let userId = 1;
  let classId = 1;
  let studentId = 1;
  let gradeTemplateId = 1;
  let gradeId = 1;
  let specialAssessmentId = 1;
  let notificationId = 1;

  const db = {
    serialize(fn) {
      fn();
    },
    run(sql, params = [], cb) {
      let err = null;
      let lastID;

      if (/INSERT INTO users/i.test(sql)) {
        const [email, password_hash, role, status, must_change_password] = params;
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
      } else if (/DELETE FROM grade_notifications WHERE student_id = \?/i.test(sql)) {
        const [studentIdParam] = params;
        for (let i = notifications.length - 1; i >= 0; i -= 1) {
          if (notifications[i].student_id === Number(studentIdParam)) notifications.splice(i, 1);
        }
      } else if (/DELETE FROM students WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [idParam, classIdParam] = params;
        for (let i = students.length - 1; i >= 0; i -= 1) {
          if (students[i].id === Number(idParam) && students[i].class_id === Number(classIdParam)) {
            students.splice(i, 1);
          }
        }
        for (let i = grades.length - 1; i >= 0; i -= 1) {
          if (grades[i].student_id === Number(idParam)) grades.splice(i, 1);
        }
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (specialAssessments[i].student_id === Number(idParam)) specialAssessments.splice(i, 1);
        }
      } else if (/DELETE FROM students WHERE class_id = \?/i.test(sql)) {
        const [classIdParam] = params;
        for (let i = students.length - 1; i >= 0; i -= 1) {
          if (students[i].class_id === Number(classIdParam)) students.splice(i, 1);
        }
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (specialAssessments[i].class_id === Number(classIdParam)) specialAssessments.splice(i, 1);
        }
      } else if (/DELETE FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        for (let i = classes.length - 1; i >= 0; i -= 1) {
          if (classes[i].id === Number(id)) classes.splice(i, 1);
        }
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (specialAssessments[i].class_id === Number(id)) specialAssessments.splice(i, 1);
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
      } else if (/INSERT INTO grade_templates/i.test(sql)) {
        const [class_id, name, category, weight, date, description] = params;
        const template = {
          id: gradeTemplateId++,
          class_id: Number(class_id),
          name,
          category,
          weight: Number(weight),
          date: date || null,
          description: description || null,
          created_at: new Date().toISOString()
        };
        gradeTemplates.push(template);
        lastID = template.id;
      } else if (/INSERT INTO grades/i.test(sql)) {
        const [
          student_id,
          class_id,
          grade_template_id,
          grade,
          note,
          attachment_path,
          attachment_original_name,
          attachment_mime,
          attachment_size,
          external_link
        ] = params;
        const newGrade = {
          id: gradeId++,
          student_id: Number(student_id),
          class_id: Number(class_id),
          grade_template_id: Number(grade_template_id),
          grade: Number(grade),
          note: note || null,
          attachment_path: attachment_path || null,
          attachment_original_name: attachment_original_name || null,
          attachment_mime: attachment_mime || null,
          attachment_size: attachment_size ? Number(attachment_size) : null,
          external_link: external_link || null,
          created_at: new Date().toISOString()
        };
        grades.push(newGrade);
        lastID = newGrade.id;
      } else if (/INSERT INTO special_assessments/i.test(sql)) {
        const [student_id, class_id, type, name, description, weight, grade] = params;
        const assessment = {
          id: specialAssessmentId++,
          student_id: Number(student_id),
          class_id: Number(class_id),
          type,
          name,
          description: description || null,
          weight: Number(weight),
          grade: Number(grade),
          created_at: new Date().toISOString()
        };
        specialAssessments.push(assessment);
        lastID = assessment.id;
      } else if (/DELETE FROM special_assessments WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [idParam, classIdParam] = params;
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (
            specialAssessments[i].id === Number(idParam) &&
            specialAssessments[i].class_id === Number(classIdParam)
          ) {
            specialAssessments.splice(i, 1);
          }
        }
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
      } else if (/SELECT id, email, role, status, created_at, must_change_password FROM users WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        row = user
          ? {
              id: user.id,
              email: user.email,
              role: user.role,
              status: user.status,
              created_at: user.created_at,
              must_change_password: user.must_change_password || 0
            }
          : undefined;
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
      } else if (/SELECT id FROM special_assessments WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [assessmentId, clsId] = params;
        const assessment = specialAssessments.find(
          (entry) => entry.id === Number(assessmentId) && entry.class_id === Number(clsId)
        );
        row = assessment ? { id: assessment.id } : undefined;
      } else if (/SELECT attachment_path FROM grades WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [gradeId, clsId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.class_id === Number(clsId)
        );
        row = grade ? { attachment_path: grade.attachment_path || null } : undefined;
      } else if (/SELECT attachment_path, attachment_original_name, attachment_mime FROM grades WHERE id = \? AND student_id = \?/i.test(sql)) {
        const [gradeId, studentId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.student_id === Number(studentId)
        );
        row = grade
          ? {
              attachment_path: grade.attachment_path || null,
              attachment_original_name: grade.attachment_original_name || null,
              attachment_mime: grade.attachment_mime || null
            }
          : undefined;
      } else if (/SELECT s\.\*, c\.name as class_name, c\.subject as class_subject, c\.id as class_id FROM students s (LEFT )?JOIN classes c ON c.id = s.class_id WHERE s.email = \?/i.test(sql)) {
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
      } else if (/FROM students s\s+JOIN classes c ON c.id = s.class_id\s+LEFT JOIN users u ON u.id = c.teacher_id\s+WHERE s.email = \?/i.test(sql)) {
        const [email] = params;
        rows = students
          .filter((s) => s.email === email)
          .map((s) => {
            const cls = classes.find((c) => c.id === s.class_id) || {};
            const teacher = users.find((u) => u.id === cls.teacher_id);
            return {
              student_id: s.id,
              student_name: s.name,
              student_email: s.email,
              school_year: s.school_year,
              class_id: cls.id,
              class_name: cls.name,
              subject: cls.subject,
              teacher_email: teacher ? teacher.email : null
            };
          })
          .sort((a, b) => (a.class_name || "").localeCompare(b.class_name || ""));
      } else if (/SELECT id, name, email FROM students WHERE class_id = \?/i.test(sql) && /ORDER BY name/i.test(sql)) {
        const hasNameFilter = /LOWER\(name\) LIKE LOWER\(\?\)/i.test(sql);
        const hasEmailFilter = /LOWER\(email\) LIKE LOWER\(\?\)/i.test(sql);
        let index = 0;
        const class_id = params[index++];
        const nameLike = hasNameFilter ? params[index++] : null;
        const emailLike = hasEmailFilter ? params[index++] : null;
        const nameNeedle = nameLike ? String(nameLike).replace(/%/g, "").toLowerCase() : null;
        const emailNeedle = emailLike ? String(emailLike).replace(/%/g, "").toLowerCase() : null;

        rows = students
          .filter((s) => s.class_id === Number(class_id))
          .filter((s) => (!nameNeedle ? true : s.name.toLowerCase().includes(nameNeedle)))
          .filter((s) => (!emailNeedle ? true : s.email.toLowerCase().includes(emailNeedle)))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({ id: s.id, name: s.name, email: s.email }));
      } else if (/FROM grades g[\s\S]*UNION ALL[\s\S]*special_assessments/i.test(sql) && /WHERE g\.student_id = \?/i.test(sql)) {
        const [student_id] = params;
        const baseRows = grades
          .filter((g) => g.student_id === Number(student_id))
          .map((g) => {
            const template = gradeTemplates.find((t) => t.id === g.grade_template_id) || {};
            const cls = classes.find((c) => c.id === g.class_id) || {};
            return {
              id: g.id,
              grade: g.grade,
              note: g.note,
              created_at: g.created_at,
              template_id: template.id,
              name: template.name,
              category: template.category,
              weight: template.weight,
              date: template.date,
              description: template.description,
              class_subject: cls.subject,
              attachment_path: g.attachment_path || null,
              attachment_original_name: g.attachment_original_name || null,
              attachment_mime: g.attachment_mime || null,
              attachment_size: g.attachment_size || null,
              external_link: g.external_link || null,
              is_special: 0
            };
          });
        const specialRows = specialAssessments
          .filter((entry) => entry.student_id === Number(student_id))
          .map((entry) => {
            const cls = classes.find((c) => c.id === entry.class_id) || {};
            return {
              id: entry.id,
              grade: entry.grade,
              note: entry.description || null,
              created_at: entry.created_at,
              template_id: null,
              name: entry.name,
              category: entry.type,
              weight: entry.weight,
              date: entry.created_at,
              description: entry.description,
              class_subject: cls.subject,
              attachment_path: null,
              attachment_original_name: null,
              attachment_mime: null,
              attachment_size: null,
              external_link: null,
              is_special: 1
            };
          });
        rows = [...baseRows, ...specialRows];
      } else if (/FROM grades g[\s\S]*UNION ALL[\s\S]*special_assessments/i.test(sql) && /WHERE s\.class_id = \?/i.test(sql)) {
        const [class_id] = params;
        const studentIds = students.filter((s) => s.class_id === Number(class_id)).map((s) => s.id);
        const regularRows = grades
          .filter((g) => studentIds.includes(g.student_id))
          .map((g) => {
            const template = gradeTemplates.find((t) => t.id === g.grade_template_id) || {};
            return { subject: template.name, value: g.grade, weight: template.weight };
          });
        const specialRows = specialAssessments
          .filter((entry) => entry.class_id === Number(class_id))
          .map((entry) => ({
            subject: entry.name,
            value: entry.grade,
            weight: entry.weight
          }));
        rows = [...regularRows, ...specialRows];
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
      } else if (/SELECT id, name, category, weight, date, description FROM grade_templates WHERE class_id = \? ORDER BY date, name/i.test(sql)) {
        const [clsId] = params;
        rows = gradeTemplates
          .filter((t) => t.class_id === Number(clsId))
          .sort((a, b) => {
            if (a.date && b.date && a.date !== b.date) return new Date(a.date) - new Date(b.date);
            return a.name.localeCompare(b.name);
          })
          .map((t) => ({ ...t }));
      } else if (/FROM special_assessments sa\s+JOIN students s ON s\.id = sa\.student_id\s+WHERE sa\.class_id = \?/i.test(sql)) {
        const [clsId] = params;
        rows = specialAssessments
          .filter((entry) => entry.class_id === Number(clsId))
          .map((entry) => {
            const student = students.find((s) => s.id === entry.student_id);
            return {
              id: entry.id,
              student_id: entry.student_id,
              student_name: student?.name || "",
              type: entry.type,
              name: entry.name,
              description: entry.description,
              weight: entry.weight,
              grade: entry.grade,
              created_at: entry.created_at
            };
          })
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      } else if (/SELECT id FROM grade_templates WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [templateId, clsId] = params;
        const template = gradeTemplates.find((t) => t.id === Number(templateId) && t.class_id === Number(clsId));
        rows = template ? [{ id: template.id }] : [];
      } else if (/PRAGMA table_info\(users\)/i.test(sql) || /PRAGMA table_info\(students\)/i.test(sql)) {
        rows = [];
      }

      if (typeof cb === "function") cb(null, rows);
    }
  };

  function seedAdmin() {
    if (!seedAdminEnabled) return;
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const ADMIN_PASS = process.env.ADMIN_PASS;
    if (!ADMIN_EMAIL || !ADMIN_PASS) {
      throw new Error("SEED_ADMIN requires ADMIN_EMAIL and ADMIN_PASS.");
    }
    if (users.some((u) => u.role === "admin")) return;
    const hash = hashPassword(ADMIN_PASS);
    db.run(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [ADMIN_EMAIL, hash, "admin", "active", 1],
      () => {}
    );
  }

  function seedDemoStudent() {
    if (!seedDemoEnabled) return;
    const teacherEmail = process.env.DEMO_TEACHER_EMAIL || "teacher@example.com";
    const studentEmail = process.env.DEMO_STUDENT_EMAIL || "student@example.com";
    const teacherPass = process.env.DEMO_TEACHER_PASS;
    const studentPass = process.env.DEMO_STUDENT_PASS;
    if (!teacherPass || !studentPass) {
      throw new Error(
        "SEED_DEMO requires DEMO_TEACHER_PASS and DEMO_STUDENT_PASS."
      );
    }
    if (users.some((u) => u.email === teacherEmail || u.email === studentEmail)) return;

    const teacherHash = hashPassword(teacherPass);
    const studentHash = hashPassword(studentPass);

    db.run(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [teacherEmail, teacherHash, "teacher", "active", 1],
      function () {
        const teacherId = this.lastID;
        db.run(
          "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
          [studentEmail, studentHash, "student", "active", 1],
          function () {
            db.run(
              "INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)",
              ["3AHWII", "Informatik", teacherId],
              function () {
                const createdClassId = this.lastID;
                db.run(
                  "INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)",
                  ["Max Muster", studentEmail, createdClassId, "2024/25"],
                  function () {
                    const studentId = this.lastID;
                    const now = new Date();

                    db.run(
                      "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
                      [
                        createdClassId,
                        "SA 1",
                        "Schularbeit",
                        40,
                        new Date(
                          now.getTime() - 1000 * 60 * 60 * 24 * 14
                        ).toISOString(),
                        "Schularbeit 1"
                      ]
                    );
                    db.run(
                      "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
                      [
                        createdClassId,
                        "Test 1",
                        "Test",
                        30,
                        new Date(
                          now.getTime() - 1000 * 60 * 60 * 24 * 7
                        ).toISOString(),
                        "Wochentlicher Test"
                      ]
                    );
                    db.run(
                      "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
                      [
                        createdClassId,
                        "Mitarbeit",
                        "Mitarbeit",
                        30,
                        now.toISOString(),
                        "Aktive Teilnahme"
                      ]
                    );

                    db.run(
                      "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
                      [studentId, createdClassId, 1, 2, "Gute Struktur"]
                    );
                    db.run(
                      "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
                      [studentId, createdClassId, 2, 1.5, "Sauberer Code"]
                    );
                    db.run(
                      "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
                      [studentId, createdClassId, 3, 3, "Mehr Quellenangaben"]
                    );

                    db.run(
                      "INSERT INTO grade_notifications (student_id, message, type, created_at) VALUES (?,?,?,?)",
                      [studentId, "Neue Note in Informatik eingetragen.", "grade", now.toISOString()]
                    );
                  }
                );
              }
            );
          }
        );
      }
    );
  }

  seedAdmin();
  seedDemoStudent();
  return db;
}

if (useFakeDb) {
  const db = createFakeDb();
  const ready = Promise.resolve();
  module.exports = { db, hashPassword, verifyPassword, ready, pool: null, isFakeDb: true };
  return;
}

const useSsl = String(process.env.PGSSL || "true").toLowerCase() !== "false";
const verifySsl = String(process.env.PGSSL_VERIFY || "true").toLowerCase() !== "false";
const ssl = useSsl ? { rejectUnauthorized: verifySsl } : undefined;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  const missing = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    throw new Error(
      `Fehlende PostgreSQL-Umgebungsvariablen: ${missing.join(", ")}`
    );
  }
}


const pool = new Pool(
  connectionString
    ? { connectionString, ssl }
    : {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl,
        keepAlive:true,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
);

/*
const pool = new Pool(
   {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,

      }
);
*/
// Prevent unhandled pool errors from crashing the process.
pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

function normalizeArgs(params, cb) {
  if (typeof params === "function") {
    return { params: [], cb: params };
  }
  return { params: params || [], cb };
}

function convertSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

const db = {
  serialize(fn) {
    fn();
  },
  run(sql, params, cb) {
    const { params: resolvedParams, cb: resolvedCb } = normalizeArgs(params, cb);
    const convertedSql = convertSql(sql);
    const needsReturning = /^\s*INSERT\s+/i.test(sql) && !/RETURNING\s+/i.test(sql);
    const querySql = needsReturning ? `${convertedSql} RETURNING id` : convertedSql;
    pool
      .query(querySql, resolvedParams)
      .then((result) => {
        if (typeof resolvedCb === "function") {
          const lastID = needsReturning ? result.rows[0]?.id : undefined;
          resolvedCb.call({ lastID }, null);
        }
      })
      .catch((err) => {
        if (typeof resolvedCb === "function") {
          resolvedCb(err);
        } else {
          console.error("DB run error:", err);
        }
      });
  },
  get(sql, params, cb) {
    const { params: resolvedParams, cb: resolvedCb } = normalizeArgs(params, cb);
    pool
      .query(convertSql(sql), resolvedParams)
      .then((result) => {
        resolvedCb(null, result.rows[0]);
      })
      .catch((err) => resolvedCb(err));
  },
  all(sql, params, cb) {
    const { params: resolvedParams, cb: resolvedCb } = normalizeArgs(params, cb);
    pool
      .query(convertSql(sql), resolvedParams)
      .then((result) => {
        resolvedCb(null, result.rows);
      })
      .catch((err) => resolvedCb(err));
  }
};

async function seedAdmin() {
  if (!seedAdminEnabled) return;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_EMAIL || !ADMIN_PASS) {
    throw new Error("SEED_ADMIN requires ADMIN_EMAIL and ADMIN_PASS.");
  }

  const existing = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing.rowCount > 0) return;

  const hash = hashPassword(ADMIN_PASS);
  await pool.query(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES ($1, $2, 'admin', 'active', true)",
    [ADMIN_EMAIL, hash]
  );
  console.log("Seed-Admin angelegt:", ADMIN_EMAIL);
}

async function seedDemoData() {
  if (!seedDemoEnabled) return;
  const teacherEmail = process.env.DEMO_TEACHER_EMAIL || "teacher@example.com";
  const studentEmail = process.env.DEMO_STUDENT_EMAIL || "student@example.com";
  const teacherPass = process.env.DEMO_TEACHER_PASS;
  const studentPass = process.env.DEMO_STUDENT_PASS;
  if (!teacherPass || !studentPass) {
    throw new Error("SEED_DEMO requires DEMO_TEACHER_PASS and DEMO_STUDENT_PASS.");
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1 OR email = $2", [teacherEmail, studentEmail]);
  if (existing.rowCount > 0) return;

  const teacherHash = hashPassword(teacherPass);
  const teacherInsert = await pool.query(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES ($1, $2, 'teacher', 'active', true) RETURNING id",
    [teacherEmail, teacherHash]
  );
  const teacherId = teacherInsert.rows[0].id;

  const studentUser = await pool.query(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES ($1, $2, 'student', 'active', true) RETURNING id",
    [studentEmail, hashPassword(studentPass)]
  );
  const studentUserId = studentUser.rows[0].id;

  const classInsert = await pool.query(
    "INSERT INTO classes (name, subject, teacher_id) VALUES ($1, $2, $3) RETURNING id",
    ["3AHWII", "Informatik", teacherId]
  );
  const classId = classInsert.rows[0].id;

  const studentInsert = await pool.query(
    "INSERT INTO students (name, email, class_id, school_year) VALUES ($1, $2, $3, $4) RETURNING id",
    ["Max Muster", studentEmail, classId, "2024/25"]
  );
  const studentId = studentInsert.rows[0].id;

  const now = new Date();
  const fourteenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString();
  const sevenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString();

  const templateOne = await pool.query(
    "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [classId, "SA 1", "Schularbeit", 40, fourteenDays, "Schularbeit 1"]
  );
  const templateTwo = await pool.query(
    "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [classId, "Test 1", "Test", 30, sevenDays, "Wöchentlicher Test"]
  );
  const templateThree = await pool.query(
    "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [classId, "Mitarbeit", "Mitarbeit", 30, now.toISOString(), "Aktive Teilnahme"]
  );

  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES ($1, $2, $3, $4, $5)",
    [studentId, classId, templateOne.rows[0].id, 2, "Gute Struktur"]
  );
  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES ($1, $2, $3, $4, $5)",
    [studentId, classId, templateTwo.rows[0].id, 1.5, "Sauberer Code"]
  );
  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES ($1, $2, $3, $4, $5)",
    [studentId, classId, templateThree.rows[0].id, 3, "Mehr Quellenangaben"]
  );
  await pool.query(
    "INSERT INTO grade_notifications (student_id, message, type) VALUES ($1, $2, $3)",
    [studentId, "Neue Note in Informatik eingetragen.", "grade"]
  );
  await pool.query(
    "INSERT INTO grade_notifications (student_id, message, type) VALUES ($1, $2, $3)",
    [studentId, "Dein Notendurchschnitt hat sich verbessert!", "average"]
  );

  console.log("Demo-Daten für Teacher/Student angelegt:", studentUserId);
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleted')),
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      teacher_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      school_year TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (email, class_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_templates (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('Schularbeit', 'Test', 'Wiederholung', 'Mitarbeit', 'Projekt', 'Hausübung')),
      weight NUMERIC NOT NULL CHECK (weight >= 0 AND weight <= 100),
      date TIMESTAMPTZ,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS description TEXT"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS date TIMESTAMPTZ"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grades (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      grade_template_id INTEGER NOT NULL REFERENCES grade_templates(id) ON DELETE CASCADE,
      grade NUMERIC NOT NULL CHECK (grade >= 1 AND grade <= 5),
      note TEXT,
      attachment_path TEXT,
      attachment_original_name TEXT,
      attachment_mime TEXT,
      attachment_size INTEGER,
      external_link TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, grade_template_id)
    )
  `);

  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_path TEXT"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_original_name TEXT"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_mime TEXT"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_size INTEGER"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS external_link TEXT"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS special_assessments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('Präsentation', 'Wunschprüfung', 'Benutzerdefiniert')),
      name TEXT NOT NULL,
      description TEXT,
      weight NUMERIC NOT NULL CHECK (weight >= 0 AND weight <= 100),
      grade NUMERIC NOT NULL CHECK (grade >= 1 AND grade <= 5),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_notifications (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire)"
  );

  await seedAdmin();
  await seedDemoData();
}

const ready = initializeDatabase().catch((err) => {
  console.error("Fehler beim Initialisieren der PostgreSQL-Datenbank:", err);
});

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  ready,
  pool,
  isFakeDb: false
};
