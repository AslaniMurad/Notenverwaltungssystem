const assignmentModel = require("../models/assignmentModel");

function toUniqueIds(values) {
  const rawValues = Array.isArray(values) ? values : [values].filter(Boolean);
  return [...new Set(
    rawValues
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];
}

function buildGroupKey(classId, subjectId) {
  return `${Number(classId)}:${Number(subjectId)}`;
}

function groupAssignmentRows(rows) {
  // Keep grouped table rows while still exposing single assignment ids for deletes.
  return rows.reduce((groupMap, row) => {
    const key = buildGroupKey(row.class_id, row.subject_id);
    const currentRows = groupMap.get(key) || [];
    currentRows.push(row);
    groupMap.set(key, currentRows);
    return groupMap;
  }, new Map());
}

async function loadAssignmentFormData() {
  const [classes, subjects, teachers] = await Promise.all([
    assignmentModel.listClasses(),
    assignmentModel.listSubjects(),
    assignmentModel.listTeachers()
  ]);

  return { classes, subjects, teachers };
}

async function renderAssignmentList(req, res, next) {
  try {
    const [groups, rows] = await Promise.all([
      assignmentModel.listAssignmentGroups(),
      assignmentModel.listAssignmentRows()
    ]);
    const rowMap = groupAssignmentRows(rows);
    const assignments = groups.map((group) => ({
      ...group,
      rows: rowMap.get(buildGroupKey(group.class_id, group.subject_id)) || []
    }));

    res.render("admin/assignments/index", {
      assignments,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
      message: String(req.query.message || "").trim(),
      error: String(req.query.error || "").trim()
    });
  } catch (err) {
    console.error("DB error loading assignments:", err);
    next(err);
  }
}

async function renderNewAssignmentForm(req, res, next) {
  try {
    const formData = await loadAssignmentFormData();

    res.render("admin/assignments/new", {
      ...formData,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
      message: String(req.query.message || "").trim(),
      error: String(req.query.error || "").trim()
    });
  } catch (err) {
    console.error("DB error loading assignment form:", err);
    next(err);
  }
}

async function createAssignment(req, res, next) {
  try {
    const classId = Number(req.body?.class_id);
    const subjectId = Number(req.body?.subject_id);
    const teacherIds = toUniqueIds(req.body?.teacher_ids);

    if (!Number.isInteger(classId) || !Number.isInteger(subjectId) || teacherIds.length === 0) {
      return res.redirect("/admin/assignments/new?error=Bitte+Klasse%2C+Fach+und+mindestens+einen+Lehrer+waehlen.");
    }

    const [classRow, subjectRow] = await Promise.all([
      assignmentModel.getClassById(classId),
      assignmentModel.getSubjectById(subjectId)
    ]);

    if (!classRow || !subjectRow) {
      return res.redirect("/admin/assignments/new?error=Klasse+oder+Fach+nicht+gefunden.");
    }

    if (Number(classRow.subject_id) !== subjectId) {
      return res.redirect("/admin/assignments/new?error=Das+gewaehlte+Fach+passt+nicht+zur+Klasse.");
    }

    const teacherRows = await assignmentModel.listValidTeacherIds(teacherIds);
    const validTeacherIds = teacherRows.map((row) => Number(row.id));
    if (!validTeacherIds.length) {
      return res.redirect("/admin/assignments/new?error=Keine+gueltigen+Lehrer+ausgewaehlt.");
    }

    const { created, duplicates } = await assignmentModel.createAssignments({
      classId,
      subjectId,
      teacherIds: validTeacherIds,
      schoolYearId: classRow.school_year_id
    });

    const message = `${created} Zuordnung(en) erstellt${duplicates ? `, ${duplicates} bereits vorhanden` : ""}.`;
    return res.redirect(`/admin/assignments?message=${encodeURIComponent(message)}`);
  } catch (err) {
    console.error("DB error creating assignment:", err);
    next(err);
  }
}

async function deleteAssignment(req, res, next) {
  try {
    const assignmentId = Number(req.body?.assignment_id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
      return res.redirect("/admin/assignments?error=Ungueltige+Zuordnung.");
    }

    await assignmentModel.deleteAssignment(assignmentId);
    return res.redirect("/admin/assignments?message=Zuordnung+entfernt.");
  } catch (err) {
    console.error("DB error deleting assignment:", err);
    next(err);
  }
}

module.exports = {
  createAssignment,
  deleteAssignment,
  renderAssignmentList,
  renderNewAssignmentForm
};
