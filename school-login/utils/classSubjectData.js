const { getAsync, runAsync } = require("./dbAsync");

function normalizePositiveId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

async function countClassSubjectAssignments(classId, subjectId) {
  const resolvedClassId = normalizePositiveId(classId);
  const resolvedSubjectId = normalizePositiveId(subjectId);
  if (!resolvedClassId || !resolvedSubjectId) return 0;

  const row = await getAsync(
    "SELECT COUNT(*) AS count FROM class_subject_teacher WHERE class_id = ? AND subject_id = ?",
    [resolvedClassId, resolvedSubjectId]
  );
  return Number(row?.count || 0);
}

async function deleteClassSubjectData(classId, subjectId) {
  const resolvedClassId = normalizePositiveId(classId);
  const resolvedSubjectId = normalizePositiveId(subjectId);
  if (!resolvedClassId || !resolvedSubjectId) return false;

  await runAsync(
    `DELETE FROM grade_messages
     WHERE grade_id IN (
       SELECT g.id
       FROM grades g
       JOIN grade_templates gt ON gt.id = g.grade_template_id
       WHERE g.class_id = ? AND gt.subject_id = ?
     )`,
    [resolvedClassId, resolvedSubjectId]
  );
  await runAsync(
    `DELETE FROM grades
     WHERE class_id = ?
       AND grade_template_id IN (
         SELECT id FROM grade_templates WHERE class_id = ? AND subject_id = ?
       )`,
    [resolvedClassId, resolvedClassId, resolvedSubjectId]
  );
  await runAsync("DELETE FROM grade_templates WHERE class_id = ? AND subject_id = ?", [
    resolvedClassId,
    resolvedSubjectId
  ]);
  await runAsync("DELETE FROM special_assessments WHERE class_id = ? AND subject_id = ?", [
    resolvedClassId,
    resolvedSubjectId
  ]);
  await runAsync("DELETE FROM participation_marks WHERE class_id = ? AND subject_id = ?", [
    resolvedClassId,
    resolvedSubjectId
  ]);
  await runAsync("DELETE FROM teacher_student_exclusions WHERE class_id = ? AND subject_id = ?", [
    resolvedClassId,
    resolvedSubjectId
  ]);
  await runAsync("DELETE FROM teacher_grading_profiles WHERE class_id = ? AND subject_id = ?", [
    resolvedClassId,
    resolvedSubjectId
  ]);

  return true;
}

async function deleteClassSubjectDataIfUnassigned(classId, subjectId) {
  const remainingAssignments = await countClassSubjectAssignments(classId, subjectId);
  if (remainingAssignments > 0) return false;
  return deleteClassSubjectData(classId, subjectId);
}

module.exports = {
  countClassSubjectAssignments,
  deleteClassSubjectData,
  deleteClassSubjectDataIfUnassigned
};
