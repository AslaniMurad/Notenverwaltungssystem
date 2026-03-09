const schoolYearModel = require("../models/schoolYearModel");

function groupAssignments(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = `${row.class_id}:${row.subject_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        class_name: row.class_name,
        subject_name: row.subject_name,
        teacher_names: []
      });
    }
    groups.get(key).teacher_names.push(row.teacher_email);
  });

  return [...groups.values()].map((group) => ({
    ...group,
    teacher_names: [...new Set(group.teacher_names)].join(", ")
  }));
}

async function showArchive(req, res, next) {
  try {
    const schoolYears = await schoolYearModel.listSchoolYears();
    const selectedSchoolYearId = Number(req.query.school_year_id) || Number(schoolYears[0]?.id || 0);
    const selectedSchoolYear = schoolYears.find((entry) => Number(entry.id) === selectedSchoolYearId) || null;
    const activeSchoolYear = schoolYears.find((entry) => Boolean(entry.is_active)) || null;

    let classes = [];
    let assignments = [];
    let grades = [];
    let archiveEntries = [];

    if (selectedSchoolYear) {
      const [classRows, assignmentRows, gradeRows, archiveRows] = await Promise.all([
        schoolYearModel.listClassesBySchoolYear(selectedSchoolYear.id),
        schoolYearModel.listAssignmentRowsBySchoolYear(selectedSchoolYear.id),
        schoolYearModel.listGradesBySchoolYear(selectedSchoolYear.id),
        schoolYearModel.listArchivesBySchoolYear(selectedSchoolYear.id)
      ]);
      classes = classRows;
      assignments = groupAssignments(assignmentRows);
      grades = gradeRows;
      archiveEntries = archiveRows;
    }

    return res.render("admin/archive", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: "/archive",
      activeSchoolYear,
      schoolYears,
      selectedSchoolYear,
      classes,
      assignments,
      grades,
      archiveEntries
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  showArchive
};
