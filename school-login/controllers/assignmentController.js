const assignmentModel = require("../models/assignmentModel");
const { getDisplayName } = require("../utils/userDisplay");

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
  return rows.reduce((groupMap, row) => {
    const key = buildGroupKey(row.class_id, row.subject_id);
    const currentRows = groupMap.get(key) || [];
    currentRows.push(row);
    groupMap.set(key, currentRows);
    return groupMap;
  }, new Map());
}

function addDisplayNames(teachers) {
  return teachers.map((t) => ({
    ...t,
    display_name: getDisplayName({ email: t.email }) || t.email
  }));
}

function consumeFlash(req) {
  const message = req.session._flash_message || "";
  const error = req.session._flash_error || "";
  delete req.session._flash_message;
  delete req.session._flash_error;
  return { message, error };
}

function flashAndRedirect(req, res, url, { message, error } = {}) {
  if (message) req.session._flash_message = message;
  if (error) req.session._flash_error = error;
  req.session.save(() => res.redirect(url));
}

async function renderAssignmentList(req, res, next) {
  try {
    const [groups, rows] = await Promise.all([
      assignmentModel.listAssignmentGroups(),
      assignmentModel.listAssignmentRows()
    ]);

    const rowMap = groupAssignmentRows(
      rows.map((row) => ({
        ...row,
        teacher_display_name: getDisplayName({ email: row.teacher_email }) || row.teacher_email
      }))
    );

    const assignments = groups.map((group) => ({
      ...group,
      rows: rowMap.get(buildGroupKey(group.class_id, group.subject_id)) || []
    }));

    const flash = consumeFlash(req);

    res.render("admin/assignments/index", {
      assignments,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
      message: flash.message,
      error: flash.error
    });
  } catch (err) {
    console.error("DB error loading assignments:", err);
    next(err);
  }
}

async function renderNewAssignmentForm(req, res, next) {
  try {
    const [classes, teachers] = await Promise.all([
      assignmentModel.listClasses(),
      assignmentModel.listTeachers()
    ]);

    const teachersWithNames = addDisplayNames(teachers);

    const requestedClassId = Number(req.query.class) || null;
    const initialClassId = (requestedClassId && classes.some((c) => c.id === requestedClassId))
      ? requestedClassId
      : (classes.length ? classes[0].id : null);

    let assignedTeacherIds = [];
    if (initialClassId) {
      const assigned = await assignmentModel.listAssignedTeacherIdsForClass(initialClassId);
      assignedTeacherIds = assigned.map((r) => r.teacher_id);
    }

    const flash = consumeFlash(req);

    res.render("admin/assignments/new", {
      classes,
      teachers: teachersWithNames,
      assignedTeacherIds,
      selectedClassId: initialClassId,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
      message: flash.message,
      error: flash.error
    });
  } catch (err) {
    console.error("DB error loading assignment form:", err);
    next(err);
  }
}

async function getClassTeachers(req, res, next) {
  try {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId) || classId <= 0) {
      return res.status(400).json({ error: "Ungueltige Klasse." });
    }
    const rows = await assignmentModel.listAssignedTeacherIdsForClass(classId);
    return res.json({ teacherIds: rows.map((r) => r.teacher_id) });
  } catch (err) {
    console.error("DB error loading class teachers:", err);
    next(err);
  }
}

async function createAssignment(req, res, next) {
  try {
    const classId = Number(req.body?.class_id);
    const teacherIds = toUniqueIds(req.body?.teacher_ids);

    if (!Number.isInteger(classId) || teacherIds.length === 0) {
      return flashAndRedirect(req, res, "/admin/assignments/new", {
        error: "Bitte Klasse und mindestens einen Lehrer waehlen."
      });
    }

    const classRow = await assignmentModel.getClassById(classId);
    if (!classRow) {
      return flashAndRedirect(req, res, "/admin/assignments/new", {
        error: "Klasse nicht gefunden."
      });
    }

    const subjectId = Number(classRow.subject_id);
    if (!subjectId) {
      return flashAndRedirect(req, res, "/admin/assignments/new", {
        error: "Klasse hat kein zugeordnetes Fach."
      });
    }

    const teacherRows = await assignmentModel.listValidTeacherIds(teacherIds);
    const validTeacherIds = teacherRows.map((row) => Number(row.id));
    if (!validTeacherIds.length) {
      return flashAndRedirect(req, res, "/admin/assignments/new", {
        error: "Keine gueltigen Lehrer ausgewaehlt."
      });
    }

    const { created, duplicates } = await assignmentModel.createAssignments({
      classId,
      subjectId,
      teacherIds: validTeacherIds,
      schoolYearId: classRow.school_year_id
    });

    const message = `${created} Zuordnung(en) erstellt${duplicates ? `, ${duplicates} bereits vorhanden` : ""}.`;
    return flashAndRedirect(req, res, "/admin/assignments", { message });
  } catch (err) {
    console.error("DB error creating assignment:", err);
    next(err);
  }
}

async function deleteAssignment(req, res, next) {
  try {
    const assignmentId = Number(req.body?.assignment_id);
    if (!Number.isInteger(assignmentId) || assignmentId <= 0) {
      return flashAndRedirect(req, res, "/admin/assignments", {
        error: "Ungueltige Zuordnung."
      });
    }

    await assignmentModel.deleteAssignment(assignmentId);
    return flashAndRedirect(req, res, "/admin/assignments", {
      message: "Zuordnung entfernt."
    });
  } catch (err) {
    console.error("DB error deleting assignment:", err);
    next(err);
  }
}

module.exports = {
  createAssignment,
  deleteAssignment,
  getClassTeachers,
  renderAssignmentList,
  renderNewAssignmentForm
};
