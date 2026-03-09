const { allAsync, getAsync, runAsync } = require("../utils/dbAsync");

async function listClasses() {
  return allAsync(
    `SELECT c.id, c.name, c.subject, c.subject_id
     FROM classes c
     ORDER BY c.name ASC, c.subject ASC`
  );
}

async function listSubjects() {
  return allAsync("SELECT id, name FROM subjects ORDER BY name ASC");
}

async function listTeachers() {
  return allAsync(
    "SELECT id, email FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY email ASC"
  );
}

async function getClassById(classId) {
  return getAsync("SELECT id, name, subject, subject_id FROM classes WHERE id = ?", [classId]);
}

async function getSubjectById(subjectId) {
  return getAsync("SELECT id, name FROM subjects WHERE id = ?", [subjectId]);
}

async function listValidTeacherIds(teacherIds) {
  if (!teacherIds.length) return [];
  return allAsync(
    `SELECT id
     FROM users
     WHERE role = 'teacher' AND status = 'active' AND id IN (${teacherIds.map(() => "?").join(",")})`,
    teacherIds
  );
}

async function listAssignmentGroups() {
  return allAsync(
    `SELECT cst.class_id,
            cst.subject_id,
            c.name AS class_name,
            s.name AS subject_name,
            STRING_AGG(u.email, ', ' ORDER BY u.email) AS teacher_names,
            COUNT(*) AS teacher_count
     FROM class_subject_teacher cst
     JOIN classes c ON c.id = cst.class_id
     JOIN subjects s ON s.id = cst.subject_id
     JOIN users u ON u.id = cst.teacher_id
     GROUP BY cst.class_id, cst.subject_id, c.name, s.name
     ORDER BY c.name ASC, s.name ASC`
  );
}

async function listAssignmentRows() {
  return allAsync(
    `SELECT cst.id,
            cst.class_id,
            cst.subject_id,
            cst.teacher_id,
            c.name AS class_name,
            s.name AS subject_name,
            u.email AS teacher_email
     FROM class_subject_teacher cst
     JOIN classes c ON c.id = cst.class_id
     JOIN subjects s ON s.id = cst.subject_id
     JOIN users u ON u.id = cst.teacher_id
     ORDER BY c.name ASC, s.name ASC, u.email ASC`
  );
}

async function createAssignments({ classId, subjectId, teacherIds }) {
  let created = 0;
  let duplicates = 0;

  // Insert each selected teacher separately so the unique constraint can reject duplicates cleanly.
  for (const teacherId of teacherIds) {
    try {
      await runAsync(
        "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id) VALUES (?,?,?)",
        [classId, subjectId, teacherId]
      );
      created += 1;
    } catch (err) {
      if (String(err.message || err).includes("UNIQUE")) {
        duplicates += 1;
        continue;
      }
      throw err;
    }
  }

  return { created, duplicates };
}

async function deleteAssignment(assignmentId) {
  return runAsync("DELETE FROM class_subject_teacher WHERE id = ?", [assignmentId]);
}

module.exports = {
  createAssignments,
  deleteAssignment,
  getClassById,
  getSubjectById,
  listAssignmentGroups,
  listAssignmentRows,
  listClasses,
  listSubjects,
  listTeachers,
  listValidTeacherIds
};
