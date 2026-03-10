const { allAsync, getAsync, runAsync } = require("../utils/dbAsync");

async function getActiveSchoolYear() {
  return getAsync(
    `SELECT id, name, start_date, end_date, is_active
     FROM school_years
     WHERE is_active = ?
     ORDER BY id DESC
     LIMIT 1`,
    [true]
  );
}

async function listSchoolYears() {
  return allAsync(
    `SELECT id, name, start_date, end_date, is_active
     FROM school_years
     ORDER BY start_date DESC, id DESC`
  );
}

async function getSchoolYearById(schoolYearId) {
  return getAsync(
    `SELECT id, name, start_date, end_date, is_active
     FROM school_years
     WHERE id = ?`,
    [schoolYearId]
  );
}

async function getSchoolYearByName(name) {
  return getAsync(
    `SELECT id, name, start_date, end_date, is_active
     FROM school_years
     WHERE name = ?`,
    [name]
  );
}

async function listClassesBySchoolYear(schoolYearId) {
  return allAsync(
    `SELECT id, name, subject, subject_id, school_year_id, created_at
     FROM classes
     WHERE school_year_id = ?
     ORDER BY name ASC, subject ASC`,
    [schoolYearId]
  );
}

async function listAssignmentRowsBySchoolYear(schoolYearId) {
  return allAsync(
    `SELECT cst.id,
            cst.class_id,
            cst.subject_id,
            cst.teacher_id,
            cst.school_year_id,
            c.name AS class_name,
            s.name AS subject_name,
            u.email AS teacher_email
     FROM class_subject_teacher cst
     JOIN classes c ON c.id = cst.class_id
     JOIN subjects s ON s.id = cst.subject_id
     JOIN users u ON u.id = cst.teacher_id
     WHERE cst.school_year_id = ?
     ORDER BY c.name ASC, s.name ASC, u.email ASC`,
    [schoolYearId]
  );
}

async function listGradesBySchoolYear(schoolYearId) {
  return allAsync(
    `SELECT g.id,
            g.class_id,
            g.student_id,
            g.grade,
            g.note,
            g.created_at,
            s.name AS student_name,
            c.name AS class_name,
            c.subject
     FROM grades g
     JOIN students s ON s.id = g.student_id
     JOIN classes c ON c.id = g.class_id
     WHERE g.school_year_id = ?
     ORDER BY g.created_at DESC, g.id DESC`,
    [schoolYearId]
  );
}

async function countGradesBySchoolYear(schoolYearId) {
  return getAsync(
    `SELECT COUNT(*) AS count
     FROM grades
     WHERE school_year_id = ?`,
    [schoolYearId]
  );
}

async function listArchivesBySchoolYear(schoolYearId) {
  return allAsync(
    `SELECT id, school_year_id, archive_type, entity_count, created_at
     FROM archives
     WHERE school_year_id = ?
     ORDER BY archive_type ASC, id ASC`,
    [schoolYearId]
  );
}

async function listRolloverLogs() {
  return allAsync(
    `SELECT rl.id,
            rl.executed_by,
            rl.executed_at,
            rl.old_school_year,
            rl.new_school_year,
            rl.status,
            rl.backup_path,
            u.email AS executed_by_email
     FROM rollover_logs rl
     LEFT JOIN users u ON u.id = rl.executed_by
     ORDER BY rl.executed_at DESC, rl.id DESC`
  );
}

async function createRolloverLog({ executedBy, oldSchoolYear, newSchoolYear, status, backupPath = null }) {
  return runAsync(
    `INSERT INTO rollover_logs (executed_by, old_school_year, new_school_year, status, backup_path)
     VALUES (?,?,?,?,?)`,
    [executedBy, oldSchoolYear, newSchoolYear, status, backupPath]
  );
}

module.exports = {
  countGradesBySchoolYear,
  createRolloverLog,
  getActiveSchoolYear,
  getSchoolYearById,
  getSchoolYearByName,
  listArchivesBySchoolYear,
  listAssignmentRowsBySchoolYear,
  listClassesBySchoolYear,
  listGradesBySchoolYear,
  listRolloverLogs,
  listSchoolYears
};
