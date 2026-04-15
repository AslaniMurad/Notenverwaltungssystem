const assignmentModel = require("../models/assignmentModel");
const { ensureSubjectIdByName } = require("../utils/subjects");
const { getDisplayName } = require("../utils/userDisplay");

const TEACHER_PAGE_SIZE = 50;
const UNASSIGNED_CLASS_LABEL = "Keine Klasse";

function toUniqueIds(values) {
  const rawValues = Array.isArray(values) ? values : [values].filter(Boolean);
  return [...new Set(
    rawValues
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];
}

function buildGroupKey(classId, subjectId) {
  const normalizedClassId = classId == null || classId === "" ? "none" : Number(classId);
  const normalizedSubjectId = subjectId == null || subjectId === "" ? "none" : Number(subjectId);
  return `${normalizedClassId}:${normalizedSubjectId}`;
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
  return teachers.map((teacher) => ({
    ...teacher,
    display_name: getDisplayName({ email: teacher.email }) || teacher.email
  }));
}

function normalizePositiveId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeSearchQuery(value) {
  return String(value || "").trim().slice(0, 100);
}

function normalizeLimit(value, fallback = TEACHER_PAGE_SIZE) {
  return Math.max(Math.min(Number(value) || fallback, 200), 1);
}

function normalizeOffset(value) {
  return Math.max(Number(value) || 0, 0);
}

function compareAssignmentGroups(a, b) {
  const aHasClass = Number.isInteger(Number(a.class_id)) && Number(a.class_id) > 0;
  const bHasClass = Number.isInteger(Number(b.class_id)) && Number(b.class_id) > 0;
  if (aHasClass !== bHasClass) return aHasClass ? -1 : 1;

  const classCompare = String(a.class_name || "").localeCompare(String(b.class_name || ""), "de", {
    sensitivity: "base"
  });
  if (classCompare !== 0) return classCompare;

  return String(a.subject_name || "").localeCompare(String(b.subject_name || ""), "de", {
    sensitivity: "base"
  });
}

function consumeFlash(req) {
  const message = req.session._flash_message || "";
  const error = req.session._flash_error || "";
  const formData = req.session._flash_form_data || null;
  delete req.session._flash_message;
  delete req.session._flash_error;
  delete req.session._flash_form_data;
  return { message, error, formData };
}

function flashAndRedirect(req, res, url, { message, error, formData } = {}) {
  if (message) req.session._flash_message = message;
  if (error) req.session._flash_error = error;
  if (formData) req.session._flash_form_data = formData;
  req.session.save(() => res.redirect(url));
}

async function renderAssignmentList(req, res, next) {
  try {
    const [groups, rows, subjects, classes] = await Promise.all([
      assignmentModel.listAssignmentGroups(),
      assignmentModel.listAssignmentRows(),
      assignmentModel.listSubjects(),
      assignmentModel.listClasses()
    ]);

    const rowMap = groupAssignmentRows(
      rows.map((row) => ({
        ...row,
        teacher_display_name: getDisplayName({ email: row.teacher_email }) || row.teacher_email
      }))
    );

    const assignedSubjectIds = new Set(
      groups
        .map((group) => Number(group.subject_id))
        .filter((subjectId) => Number.isInteger(subjectId) && subjectId > 0)
    );
    const classSubjectIds = new Set(
      classes
        .map((classRow) => Number(classRow.subject_id))
        .filter((subjectId) => Number.isInteger(subjectId) && subjectId > 0)
    );

    const subjectOnlyGroups = subjects
      .filter((subject) => {
        const subjectId = Number(subject.id);
        return !assignedSubjectIds.has(subjectId) && !classSubjectIds.has(subjectId);
      })
      .map((subject) => ({
        class_id: null,
        subject_id: subject.id,
        class_name: UNASSIGNED_CLASS_LABEL,
        subject_name: subject.name,
        teacher_names: "",
        teacher_count: 0
      }));

    const assignments = [...groups, ...subjectOnlyGroups]
      .map((group) => ({
        ...group,
        rows: rowMap.get(buildGroupKey(group.class_id, group.subject_id)) || []
      }))
      .sort(compareAssignmentGroups);

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
    const classes = await assignmentModel.listClasses();
    const requestedClassId = normalizePositiveId(req.query.class);
    const requestedSubjectId = normalizePositiveId(req.query.subject);
    const explicitCreateSubjectMode = String(req.query.create_subject || "").trim() === "1";
    const initialClassId =
      requestedClassId && classes.some((entry) => Number(entry.id) === requestedClassId)
        ? requestedClassId
        : null;

    let classSubjects = [];
    if (initialClassId) {
      classSubjects = await assignmentModel.listClassSubjects(initialClassId);
    }

    let prefilledSubjectName = "";
    if (requestedSubjectId) {
      const requestedSubject = await assignmentModel.getSubjectById(requestedSubjectId);
      prefilledSubjectName = String(requestedSubject?.name || "").trim();
    }

    const createSubjectMode =
      explicitCreateSubjectMode ||
      Boolean(
        requestedSubjectId &&
        prefilledSubjectName &&
        (!initialClassId ||
          !classSubjects.some((entry) => Number(entry.subject_id) === requestedSubjectId))
      );

    const initialSubjectId =
      !createSubjectMode && requestedSubjectId && classSubjects.some((entry) => Number(entry.subject_id) === requestedSubjectId)
        ? requestedSubjectId
        : (!createSubjectMode && classSubjects.length ? Number(classSubjects[0].subject_id) : null);

    const flash = consumeFlash(req);
    const formData = {
      ...(flash.formData || {})
    };
    if (!String(formData.new_subject || "").trim() && prefilledSubjectName) {
      formData.new_subject = prefilledSubjectName;
    }

    res.render("admin/assignments/new", {
      classes,
      classSubjects,
      selectedClassId: initialClassId,
      selectedSubjectId: initialSubjectId,
      createSubjectMode,
      formData,
      teacherPageSize: TEACHER_PAGE_SIZE,
      subjectPrefillId: prefilledSubjectName ? requestedSubjectId : null,
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
    const classId = normalizePositiveId(req.params.classId);
    const rawSubjectId = String(req.query.subject_id || "").trim();
    const subjectId = rawSubjectId ? normalizePositiveId(rawSubjectId) : null;
    const query = normalizeSearchQuery(req.query.q);
    const limit = normalizeLimit(req.query.limit);
    const offset = normalizeOffset(req.query.offset);

    if (!classId) {
      return res.status(400).json({ error: "Ungültige Klasse." });
    }
    if (rawSubjectId && !subjectId) {
      return res.status(400).json({ error: "Ungültiges Fach." });
    }

    const classRow = await assignmentModel.getClassById(classId);
    if (!classRow) {
      return res.status(404).json({ error: "Klasse nicht gefunden." });
    }

    if (subjectId) {
      const subjectRow = await assignmentModel.getSubjectById(subjectId);
      if (!subjectRow) {
        return res.status(404).json({ error: "Fach nicht gefunden." });
      }
    }

    const assignedTeachers = subjectId
      ? addDisplayNames(await assignmentModel.listAssignedTeachersForClassSubject(classId, subjectId))
      : [];
    const assignedTeacherIds = assignedTeachers.map((entry) => Number(entry.id));

    const [countRow, availableTeacherRows] = await Promise.all([
      assignmentModel.countTeacherSearchResults({
        search: query,
        excludeIds: assignedTeacherIds
      }),
      assignmentModel.listTeacherSearchResults({
        search: query,
        excludeIds: assignedTeacherIds,
        limit,
        offset
      })
    ]);

    const availableTeachers = addDisplayNames(availableTeacherRows);
    const totalAvailable = Number(countRow?.count || 0);

    return res.json({
      teacherIds: assignedTeacherIds,
      assignedTeachers,
      availableTeachers,
      totalAvailable,
      limit,
      offset,
      hasMore: offset + availableTeachers.length < totalAvailable
    });
  } catch (err) {
    console.error("DB error loading class teachers:", err);
    next(err);
  }
}

async function createAssignment(req, res, next) {
  try {
    const classId = Number(req.body?.class_id);
    const requestedSubjectId = Number(req.body?.subject_id);
    const newSubjectName = String(req.body?.new_subject || "").trim();
    const teacherIds = toUniqueIds(req.body?.teacher_ids);
    const createSubjectMode = String(req.body?.create_subject || "").trim() === "1";
    const redirectUrl =
      `/admin/assignments/new?class=${Number.isInteger(classId) ? classId : ""}` +
      `${Number.isInteger(requestedSubjectId) ? `&subject=${requestedSubjectId}` : ""}` +
      `${createSubjectMode ? "&create_subject=1" : ""}`;
    const flashFormData = {
      new_subject: newSubjectName
    };

    if (!Number.isInteger(classId) || teacherIds.length === 0) {
      return flashAndRedirect(req, res, redirectUrl, {
        error: "Bitte Klasse und mindestens einen Lehrer wählen.",
        formData: flashFormData
      });
    }

    const classRow = await assignmentModel.getClassById(classId);
    if (!classRow) {
      return flashAndRedirect(req, res, redirectUrl, {
        error: "Klasse nicht gefunden.",
        formData: flashFormData
      });
    }

    let subjectId = Number.isInteger(requestedSubjectId) ? requestedSubjectId : null;
    if (newSubjectName) {
      subjectId = await ensureSubjectIdByName(newSubjectName);
    }

    if (!subjectId) {
      return flashAndRedirect(req, res, redirectUrl, {
        error: newSubjectName
          ? "Fach konnte nicht angelegt werden."
          : "Bitte ein bestehendes Fach wählen oder ein neues Fach anlegen.",
        formData: flashFormData
      });
    }

    const subjectRow = await assignmentModel.getSubjectById(subjectId);
    if (!subjectRow) {
      return flashAndRedirect(req, res, redirectUrl, {
        error: "Fach nicht gefunden.",
        formData: flashFormData
      });
    }

    const teacherRows = await assignmentModel.listValidTeacherIds(teacherIds);
    const validTeacherIds = teacherRows.map((row) => Number(row.id));
    if (!validTeacherIds.length) {
      return flashAndRedirect(req, res, redirectUrl, {
        error: "Keine gültigen Lehrer ausgewählt.",
        formData: flashFormData
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
        error: "Ungültige Zuordnung."
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

async function deleteAssignmentGroup(req, res, next) {
  try {
    const classId = normalizePositiveId(req.body?.class_id);
    const subjectId = normalizePositiveId(req.body?.subject_id);

    if (!subjectId) {
      return flashAndRedirect(req, res, "/admin/assignments", {
        error: "Ungültiges Fach."
      });
    }

    const subjectRow = await assignmentModel.getSubjectById(subjectId);
    if (!subjectRow) {
      return flashAndRedirect(req, res, "/admin/assignments", {
        error: "Fach nicht gefunden."
      });
    }

    if (classId) {
      const classRow = await assignmentModel.getClassById(classId);
      if (!classRow) {
        return flashAndRedirect(req, res, "/admin/assignments", {
          error: "Klasse nicht gefunden."
        });
      }

      const matchingRows = (await assignmentModel.listAssignmentRows()).filter(
        (row) => Number(row.class_id) === classId && Number(row.subject_id) === subjectId
      );

      if (!matchingRows.length) {
        return flashAndRedirect(req, res, "/admin/assignments", {
          error: "Keine passende Fachgruppe gefunden."
        });
      }

      for (const row of matchingRows) {
        await assignmentModel.deleteAssignment(row.id);
      }

      return flashAndRedirect(req, res, "/admin/assignments", {
        message: `Fachgruppe entfernt. ${matchingRows.length} Lehrerzuordnung(en) gelöscht.`
      });
    }

    const [assignmentCountRow, exclusionCountRow] = await Promise.all([
      assignmentModel.countAssignmentsForSubject(subjectId),
      assignmentModel.countTeacherExclusionsForSubject(subjectId)
    ]);

    if (Number(assignmentCountRow?.count || 0) > 0 || Number(exclusionCountRow?.count || 0) > 0) {
      return flashAndRedirect(req, res, "/admin/assignments", {
        error: "Dieses Fach wird noch verwendet und kann hier nicht gelöscht werden."
      });
    }

    try {
      await assignmentModel.deleteSubject(subjectId);
    } catch (err) {
      if (String(err.message || err).includes("FOREIGN KEY")) {
        return flashAndRedirect(req, res, "/admin/assignments", {
          error: "Dieses Fach wird noch an anderer Stelle verwendet und kann nicht gelöscht werden."
        });
      }
      throw err;
    }

    return flashAndRedirect(req, res, "/admin/assignments", {
      message: "Unzugeordnetes Fach gelöscht."
    });
  } catch (err) {
    console.error("DB error deleting assignment group:", err);
    next(err);
  }
}

module.exports = {
  createAssignment,
  deleteAssignment,
  deleteAssignmentGroup,
  getClassTeachers,
  renderAssignmentList,
  renderNewAssignmentForm
};
