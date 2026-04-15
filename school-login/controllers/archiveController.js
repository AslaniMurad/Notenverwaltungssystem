const crypto = require("crypto");
const { verifyPassword } = require("../db");
const schoolYearModel = require("../models/schoolYearModel");
const archiveDangerService = require("../services/archiveDangerService");
const { getAsync } = require("../utils/dbAsync");

const DANGER_PREVIEW_TTL_MS = 10 * 60 * 1000;

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

function getArchivePreviewStore(req) {
  if (!req.session.archiveDangerPreviews) {
    req.session.archiveDangerPreviews = {};
  }
  return req.session.archiveDangerPreviews;
}

function saveArchivePreviewState(req, key, value) {
  const store = getArchivePreviewStore(req);
  store[key] = value;
}

function readArchivePreviewState(req, key) {
  return req.session?.archiveDangerPreviews?.[key] || null;
}

function clearArchivePreviewState(req, key) {
  if (req.session?.archiveDangerPreviews) {
    delete req.session.archiveDangerPreviews[key];
  }
}

function createArchivePreviewToken() {
  return crypto.randomBytes(24).toString("hex");
}

function isArchivePreviewStateValid(state, token) {
  if (!state || !token || state.token !== token) return false;
  const createdAt = Number(state.createdAt || 0);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  return Date.now() - createdAt <= DANGER_PREVIEW_TTL_MS;
}

function setArchiveDangerFlash(req, type, message) {
  req.session.archiveDangerFlash = { type, message };
}

function consumeArchiveDangerFlash(req) {
  const flash = req.session?.archiveDangerFlash || null;
  if (req.session?.archiveDangerFlash) {
    delete req.session.archiveDangerFlash;
  }
  return flash;
}

async function verifyAdminPasswordForRequest(req, password) {
  const normalizedPassword = String(password || "");
  if (!normalizedPassword) return false;

  const userRow = await getAsync(
    "SELECT id, email, password_hash, role, status, must_change_password FROM users WHERE email = ?",
    [req.session?.user?.email]
  );

  if (!userRow) return false;
  if (String(userRow.role || "").toLowerCase() !== "admin") return false;
  if (String(userRow.status || "").toLowerCase() !== "active") return false;

  return verifyPassword(userRow.password_hash, normalizedPassword);
}

function archiveDangerBaseViewModel(req) {
  return {
    csrfToken: req.csrfToken(),
    currentUser: req.session.user,
    activePath: "/archive"
  };
}

async function renderArchiveDeletePage(req, res, options = {}) {
  const schoolYearId = options.schoolYearId ?? req.query.school_year_id ?? req.body?.school_year_id ?? null;
  const pageData = options.pageData || await archiveDangerService.getArchiveDeletePageData({ schoolYearId });

  return res.render("admin/archive-delete", {
    ...archiveDangerBaseViewModel(req),
    ...pageData,
    error: options.error || null,
    preview: options.preview || pageData.preview || null,
    previewToken: options.previewToken || null,
    flash: options.flash ?? consumeArchiveDangerFlash(req)
  });
}

async function renderGraduateCleanupPage(req, res, options = {}) {
  const schoolYearId = options.schoolYearId ?? req.query.school_year_id ?? req.body?.school_year_id ?? null;
  const pageData = options.pageData || await archiveDangerService.getGraduateCleanupPageData({ schoolYearId });

  return res.render("admin/archive-graduates", {
    ...archiveDangerBaseViewModel(req),
    ...pageData,
    error: options.error || null,
    preview: options.preview || pageData.preview || null,
    previewToken: options.previewToken || null,
    flash: options.flash ?? consumeArchiveDangerFlash(req)
  });
}

const archiveCsvConfigs = {
  archives: {
    filenameSuffix: "archivstatus",
    load: (schoolYearId) => schoolYearModel.listArchivesBySchoolYear(schoolYearId),
    columns: [
      { header: "ID", key: "id" },
      { header: "Archivtyp", key: "archive_type" },
      { header: "Anzahl Einträge", key: "entity_count" },
      { header: "Erstellt am", key: "created_at" }
    ]
  },
  assignments: {
    filenameSuffix: "zuordnungen",
    load: async (schoolYearId) => groupAssignments(await schoolYearModel.listAssignmentRowsBySchoolYear(schoolYearId)),
    columns: [
      { header: "Klasse", key: "class_name" },
      { header: "Fach", key: "subject_name" },
      { header: "Lehrkräfte", key: "teacher_names" }
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
      { header: "Schüler", key: "student_name" },
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
      archiveStats,
      dangerFlash: consumeArchiveDangerFlash(req)
    });
  } catch (err) {
    return next(err);
  }
}

async function showArchiveDeletePage(req, res, next) {
  try {
    return await renderArchiveDeletePage(req, res);
  } catch (err) {
    return next(err);
  }
}

async function previewArchiveDelete(req, res, next) {
  try {
    const pageData = await archiveDangerService.buildArchiveDeletePreview({
      schoolYearId: req.body?.school_year_id
    });
    const previewToken = createArchivePreviewToken();

    saveArchivePreviewState(req, "archiveDelete", {
      token: previewToken,
      createdAt: Date.now(),
      schoolYearId: Number(pageData.selectedSchoolYear.id),
      confirmationText: pageData.preview.confirmationText
    });

    return await renderArchiveDeletePage(req, res, {
      pageData,
      preview: pageData.preview,
      previewToken
    });
  } catch (err) {
    return await renderArchiveDeletePage(req, res, {
      schoolYearId: req.body?.school_year_id,
      error: err.message || "Archiv konnte nicht geprüft werden."
    });
  }
}

async function executeArchiveDelete(req, res, next) {
  const previewToken = String(req.body?.preview_token || "");
  const previewState = readArchivePreviewState(req, "archiveDelete");

  try {
    if (!isArchivePreviewStateValid(previewState, previewToken)) {
      clearArchivePreviewState(req, "archiveDelete");
      return await renderArchiveDeletePage(req, res, {
        schoolYearId: req.body?.school_year_id,
        error: "Die Bestätigung ist abgelaufen. Bitte die Vorschau erneut laden."
      });
    }

    const pageData = await archiveDangerService.buildArchiveDeletePreview({
      schoolYearId: previewState.schoolYearId
    });

    if (String(req.body?.confirmation_text || "").trim() !== previewState.confirmationText) {
      return await renderArchiveDeletePage(req, res, {
        pageData,
        preview: pageData.preview,
        previewToken: previewState.token,
        error: "Die Sicherheitsbestätigung stimmt nicht exakt überein."
      });
    }

    const passwordValid = await verifyAdminPasswordForRequest(req, req.body?.admin_password);
    if (!passwordValid) {
      return await renderArchiveDeletePage(req, res, {
        pageData,
        preview: pageData.preview,
        previewToken: previewState.token,
        error: "Das Admin-Passwort ist ungültig."
      });
    }

    const result = await archiveDangerService.executeArchiveDelete({
      schoolYearId: previewState.schoolYearId
    });

    clearArchivePreviewState(req, "archiveDelete");
    setArchiveDangerFlash(req, "success", `Archiv ${result.deletedSchoolYearName} wurde endgültig gelöscht.`);
    return res.redirect("/archive");
  } catch (err) {
    if (previewState?.schoolYearId) {
      return await renderArchiveDeletePage(req, res, {
        schoolYearId: previewState.schoolYearId,
        error: err.message || "Archiv konnte nicht gelöscht werden."
      });
    }
    return next(err);
  }
}

async function showGraduateCleanupPage(req, res, next) {
  try {
    return await renderGraduateCleanupPage(req, res);
  } catch (err) {
    return next(err);
  }
}

async function previewGraduateCleanup(req, res, next) {
  try {
    const pageData = await archiveDangerService.buildGraduateCleanupPreview({
      schoolYearId: req.body?.school_year_id,
      includedClassKeys: req.body?.included_class_keys,
      personActions: req.body?.person_actions
    });
    const previewToken = createArchivePreviewToken();

    saveArchivePreviewState(req, "graduateCleanup", {
      token: previewToken,
      createdAt: Date.now(),
      schoolYearId: Number(pageData.selectedSchoolYear.id),
      confirmationText: pageData.preview.confirmationText,
      includedClassKeys: pageData.selection.includedClassKeys,
      personActions: pageData.selection.personActions,
      selectedEmailKeys: pageData.preview.selectedEmailKeys
    });

    return await renderGraduateCleanupPage(req, res, {
      pageData,
      preview: pageData.preview,
      previewToken
    });
  } catch (err) {
    return await renderGraduateCleanupPage(req, res, {
      schoolYearId: req.body?.school_year_id,
      error: err.message || "Schulabgänger-Bereinigung konnte nicht geprüft werden."
    });
  }
}

async function executeGraduateCleanup(req, res, next) {
  const previewToken = String(req.body?.preview_token || "");
  const previewState = readArchivePreviewState(req, "graduateCleanup");

  try {
    if (!isArchivePreviewStateValid(previewState, previewToken)) {
      clearArchivePreviewState(req, "graduateCleanup");
      return await renderGraduateCleanupPage(req, res, {
        schoolYearId: req.body?.school_year_id,
        error: "Die Bestätigung ist abgelaufen. Bitte die Vorschau erneut laden."
      });
    }

    const pageData = await archiveDangerService.buildGraduateCleanupPreview({
      schoolYearId: previewState.schoolYearId,
      includedClassKeys: previewState.includedClassKeys,
      personActions: previewState.personActions
    });

    if (String(req.body?.confirmation_text || "").trim() !== previewState.confirmationText) {
      return await renderGraduateCleanupPage(req, res, {
        pageData,
        preview: pageData.preview,
        previewToken: previewState.token,
        error: "Die Sicherheitsbestätigung stimmt nicht exakt überein."
      });
    }

    const passwordValid = await verifyAdminPasswordForRequest(req, req.body?.admin_password);
    if (!passwordValid) {
      return await renderGraduateCleanupPage(req, res, {
        pageData,
        preview: pageData.preview,
        previewToken: previewState.token,
        error: "Das Admin-Passwort ist ungültig."
      });
    }

    const result = await archiveDangerService.executeGraduateCleanup({
      schoolYearId: previewState.schoolYearId,
      selectedEmailKeys: previewState.selectedEmailKeys
    });

    clearArchivePreviewState(req, "graduateCleanup");
    setArchiveDangerFlash(
      req,
      "success",
      `${result.cleanedPersonCount} Schulabgänger aus ${result.cleanedSchoolYearName} wurden bereinigt.`
    );
    return res.redirect("/archive");
  } catch (err) {
    if (previewState?.schoolYearId) {
      return await renderGraduateCleanupPage(req, res, {
        schoolYearId: previewState.schoolYearId,
        error: err.message || "Schulabgänger konnten nicht bereinigt werden."
      });
    }
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
        message: "Kein Schuljahr für den Export verfügbar.",
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
  executeArchiveDelete,
  executeGraduateCleanup,
  previewArchiveDelete,
  previewGraduateCleanup,
  showArchive,
  showArchiveDeletePage,
  showGraduateCleanupPage
};
