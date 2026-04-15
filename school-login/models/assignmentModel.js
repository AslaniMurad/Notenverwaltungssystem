const { allAsync, getAsync, runAsync } = require("../utils/dbAsync");

async function listClasses() {
  return allAsync(
    `SELECT c.id, c.name, c.subject, c.subject_id, c.school_year_id
     FROM classes c
     JOIN school_years sy ON sy.id = c.school_year_id
     WHERE sy.is_active = ?
     ORDER BY c.name ASC, c.id ASC`
    ,
    [true]
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

async function countAssignmentsForSubject(subjectId) {
  if (!Number.isInteger(Number(subjectId)) || Number(subjectId) <= 0) return { count: 0 };
  return getAsync(
    "SELECT COUNT(*) AS count FROM class_subject_teacher WHERE subject_id = ?",
    [subjectId]
  );
}

async function countTeacherExclusionsForSubject(subjectId) {
  if (!Number.isInteger(Number(subjectId)) || Number(subjectId) <= 0) return { count: 0 };
  return getAsync(
    "SELECT COUNT(*) AS count FROM teacher_student_exclusions WHERE subject_id = ?",
    [subjectId]
  );
}

async function listClassSubjects(classId) {
  if (!Number.isInteger(Number(classId)) || Number(classId) <= 0) return [];
  return allAsync(
    `SELECT cst.subject_id,
            s.name AS subject_name,
            COUNT(*) AS teacher_count
     FROM class_subject_teacher cst
     JOIN school_years sy ON sy.id = cst.school_year_id
     JOIN subjects s ON s.id = cst.subject_id
     WHERE cst.class_id = ? AND sy.is_active = ?
     GROUP BY cst.subject_id, s.name
     ORDER BY s.name ASC`,
    [classId, true]
  );
}

async function listAssignedTeachersForClassSubject(classId, subjectId) {
  if (!Number.isInteger(Number(classId)) || Number(classId) <= 0) return [];
  if (!Number.isInteger(Number(subjectId)) || Number(subjectId) <= 0) return [];
  return allAsync(
    `SELECT u.id, u.email
     FROM class_subject_teacher cst
     JOIN school_years sy ON sy.id = cst.school_year_id
     JOIN users u ON u.id = cst.teacher_id
     WHERE cst.class_id = ? AND cst.subject_id = ? AND sy.is_active = ?
     ORDER BY u.email ASC`,
    [classId, subjectId, true]
  );
}

async function countTeacherSearchResults({ search = "", excludeIds = [] } = {}) {
  const normalizedSearch = String(search || "").trim();
  const params = [];
  const whereParts = ["role = 'teacher'", "status = 'active'"];

  if (normalizedSearch) {
    whereParts.push("LOWER(email) LIKE LOWER(?)");
    params.push(`%${normalizedSearch}%`);
  }

  if (excludeIds.length) {
    whereParts.push(`id NOT IN (${excludeIds.map(() => "?").join(",")})`);
    params.push(...excludeIds);
  }

  return getAsync(
    `SELECT COUNT(*) AS count
     FROM users
     WHERE ${whereParts.join(" AND ")}`,
    params
  );
}

async function listTeacherSearchResults({ search = "", excludeIds = [], limit = 50, offset = 0 } = {}) {
  const normalizedSearch = String(search || "").trim();
  const safeLimit = Math.max(Math.min(Number(limit) || 50, 200), 1);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const params = [];
  const whereParts = ["role = 'teacher'", "status = 'active'"];

  if (normalizedSearch) {
    whereParts.push("LOWER(email) LIKE LOWER(?)");
    params.push(`%${normalizedSearch}%`);
  }

  if (excludeIds.length) {
    whereParts.push(`id NOT IN (${excludeIds.map(() => "?").join(",")})`);
    params.push(...excludeIds);
  }

  return allAsync(
    `SELECT id, email
     FROM users
     WHERE ${whereParts.join(" AND ")}
     ORDER BY email ASC
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );
}

async function getClassById(classId) {
  return getAsync("SELECT id, name, subject, subject_id, school_year_id FROM classes WHERE id = ?", [classId]);
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
     JOIN school_years sy ON sy.id = cst.school_year_id
     JOIN classes c ON c.id = cst.class_id
     JOIN subjects s ON s.id = cst.subject_id
     JOIN users u ON u.id = cst.teacher_id
     WHERE sy.is_active = ?
     GROUP BY cst.class_id, cst.subject_id, c.name, s.name
     ORDER BY c.name ASC, s.name ASC`,
    [true]
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
     JOIN school_years sy ON sy.id = cst.school_year_id
     JOIN classes c ON c.id = cst.class_id
     JOIN subjects s ON s.id = cst.subject_id
     JOIN users u ON u.id = cst.teacher_id
     WHERE sy.is_active = ?
     ORDER BY c.name ASC, s.name ASC, u.email ASC`
    ,
    [true]
  );
}

async function createAssignments({ classId, subjectId, teacherIds, schoolYearId }) {
  let created = 0;
  let duplicates = 0;

  // Insert each selected teacher separately so the unique constraint can reject duplicates cleanly.
  for (const teacherId of teacherIds) {
    try {
      await runAsync(
        "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES (?,?,?,?)",
        [classId, subjectId, teacherId, schoolYearId]
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

async function listAssignedTeacherIdsForClass(classId) {
  return allAsync(
    `SELECT cst.teacher_id
     FROM class_subject_teacher cst
     JOIN school_years sy ON sy.id = cst.school_year_id
     WHERE cst.class_id = ? AND sy.is_active = ?`,
    [classId, true]
  );
}

async function deleteAssignment(assignmentId) {
  return runAsync("DELETE FROM class_subject_teacher WHERE id = ?", [assignmentId]);
}

async function deleteSubject(subjectId) {
  return runAsync("DELETE FROM subjects WHERE id = ?", [subjectId]);
}

module.exports = {
  countAssignmentsForSubject,
  countTeacherExclusionsForSubject,
  createAssignments,
  deleteAssignment,
  deleteSubject,
  getClassById,
  getSubjectById,
  countTeacherSearchResults,
  listAssignedTeachersForClassSubject,
  listAssignedTeacherIdsForClass,
  listAssignmentGroups,
  listAssignmentRows,
  listClassSubjects,
  listClasses,
  listSubjects,
  listTeacherSearchResults,
  listTeachers,
  listValidTeacherIds
};
