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

function resolveSelectedSchoolYear(schoolYears, queryValue) {
  const requestedId = Number(queryValue);
  if (Number.isFinite(requestedId) && requestedId > 0) {
    const selected = schoolYears.find((entry) => Number(entry.id) === requestedId);
    if (selected) return selected;
  }
  return schoolYears[0] || null;
}

function getLatestTimestamp(values) {
  return values.reduce((latest, value) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return latest;
    if (!latest) return parsed.toISOString();
    return parsed.getTime() > new Date(latest).getTime() ? parsed.toISOString() : latest;
  }, null);
}

function buildArchiveStats({ classes, assignments, grades, archiveEntries }) {
  const teacherSet = new Set();
  assignments.forEach((entry) => {
    String(entry.teacher_names || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => teacherSet.add(value));
  });

  const studentSet = new Set(
    grades
      .map((entry) => String(entry.student_name || "").trim())
      .filter(Boolean)
  );

  const archiveTypeSet = new Set(
    archiveEntries
      .map((entry) => String(entry.archive_type || "").trim())
      .filter(Boolean)
  );

  const gradeValues = grades
    .map((entry) => Number(entry.grade))
    .filter((value) => Number.isFinite(value));

  const averageGrade = gradeValues.length
    ? Number((gradeValues.reduce((sum, value) => sum + value, 0) / gradeValues.length).toFixed(2))
    : null;

  const latestActivityAt = getLatestTimestamp([
    ...classes.map((entry) => entry.created_at),
    ...grades.map((entry) => entry.created_at),
    ...archiveEntries.map((entry) => entry.created_at)
  ]);

  return {
    totalRecords: classes.length + assignments.length + grades.length + archiveEntries.length,
    uniqueTeachers: teacherSet.size,
    uniqueStudents: studentSet.size,
    archiveTypes: archiveTypeSet.size,
    averageGrade,
    latestActivityAt
  };
}

function escapeCsvValue(value) {
  const normalized = value == null ? "" : String(value);
  return `"${normalized.replace(/"/g, "\"\"")}"`;
}

function buildCsv(columns, rows) {
  const header = columns.map((column) => escapeCsvValue(column.header)).join(";");
  const body = rows.map((row) =>
    columns
      .map((column) => {
        const rawValue = typeof column.value === "function" ? column.value(row) : row[column.key];
        return escapeCsvValue(rawValue);
      })
      .join(";")
  );
  return [header, ...body].join("\r\n");
}

function toFilenamePart(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "export";
}

const archiveCsvConfigs = {
  archives: {
    filenameSuffix: "archivstatus",
    load: (schoolYearId) => schoolYearModel.listArchivesBySchoolYear(schoolYearId),
    columns: [
      { header: "ID", key: "id" },
      { header: "Archivtyp", key: "archive_type" },
      { header: "Anzahl Eintraege", key: "entity_count" },
      { header: "Erstellt am", key: "created_at" }
    ]
  },
  assignments: {
    filenameSuffix: "zuordnungen",
    load: async (schoolYearId) => groupAssignments(await schoolYearModel.listAssignmentRowsBySchoolYear(schoolYearId)),
    columns: [
      { header: "Klasse", key: "class_name" },
      { header: "Fach", key: "subject_name" },
      { header: "Lehrkraefte", key: "teacher_names" }
    ]
  },
  classes: {
    filenameSuffix: "klassen",
    load: (schoolYearId) => schoolYearModel.listClassesBySchoolYear(schoolYearId),
    columns: [
      { header: "ID", key: "id" },
      { header: "Klasse", key: "name" },
      { header: "Fach", key: "subject" },
      { header: "Fach-ID", key: "subject_id" },
      { header: "Erstellt am", key: "created_at" }
    ]
  },
  grades: {
    filenameSuffix: "noten",
    load: (schoolYearId) => schoolYearModel.listGradesBySchoolYear(schoolYearId),
    columns: [
      { header: "ID", key: "id" },
      { header: "Klasse", key: "class_name" },
      { header: "Schueler", key: "student_name" },
      { header: "Fach", key: "subject" },
      { header: "Note", key: "grade" },
      { header: "Kommentar", value: (row) => row.note || "" },
      { header: "Erstellt am", key: "created_at" }
    ]
  }
};

async function showArchive(req, res, next) {
  try {
    const schoolYears = await schoolYearModel.listSchoolYears();
    const selectedSchoolYear = resolveSelectedSchoolYear(schoolYears, req.query.school_year_id);
    const activeSchoolYear = schoolYears.find((entry) => Boolean(entry.is_active)) || null;

    let classes = [];
    let assignments = [];
    let grades = [];
    let archiveEntries = [];
    let archiveStats = buildArchiveStats({ classes, assignments, grades, archiveEntries });

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
      archiveStats = buildArchiveStats({ classes, assignments, grades, archiveEntries });
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
      archiveEntries,
      archiveStats
    });
  } catch (err) {
    return next(err);
  }
}

async function downloadArchiveCsv(req, res, next) {
  try {
    const datasetKey = String(req.params.dataset || "").trim().toLowerCase();
    const config = archiveCsvConfigs[datasetKey];

    if (!config) {
      return res.status(404).render("error", {
        message: "Archiv-Export nicht gefunden.",
        status: 404,
        backUrl: "/archive"
      });
    }

    const schoolYears = await schoolYearModel.listSchoolYears();
    const selectedSchoolYear = resolveSelectedSchoolYear(schoolYears, req.query.school_year_id);

    if (!selectedSchoolYear) {
      return res.status(404).render("error", {
        message: "Kein Schuljahr fuer den Export verfuegbar.",
        status: 404,
        backUrl: "/archive"
      });
    }

    const rows = await config.load(selectedSchoolYear.id);
    const csv = buildCsv(config.columns, rows);
    const filename = `archiv-${toFilenamePart(selectedSchoolYear.name)}-${config.filenameSuffix}.csv`;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(`\uFEFF${csv}`);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  downloadArchiveCsv,
  showArchive
};
