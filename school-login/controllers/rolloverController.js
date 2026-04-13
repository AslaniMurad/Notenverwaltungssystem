const schoolYearModel = require("../models/schoolYearModel");
const rolloverService = require("../services/rolloverService");

const ROLLOVER_WIZARD_SESSION_KEY = "rolloverWizard";
const ROLLOVER_STEPS = [
  { key: "start", label: "Start" },
  { key: "classes", label: "Klassen" },
  { key: "students", label: "Schüler" },
  { key: "review", label: "Prüfen" }
];

function normalizeStep(value) {
  const normalizedValue = String(value || "").trim().toLowerCase();
  return ROLLOVER_STEPS.some((step) => step.key === normalizedValue) ? normalizedValue : "start";
}

function getWizardDraft(req) {
  return rolloverService.restoreWizardDraft(req.session?.[ROLLOVER_WIZARD_SESSION_KEY]);
}

function setWizardDraft(req, draft) {
  req.session[ROLLOVER_WIZARD_SESSION_KEY] = draft;
}

function clearWizardDraft(req) {
  delete req.session[ROLLOVER_WIZARD_SESSION_KEY];
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) return reject(err);
      return resolve();
    });
  });
}

function extractStartWizardOptions(body = {}) {
  return {
    schoolYearName: body.school_year_name,
    startDate: body.start_date,
    endDate: body.end_date
  };
}

function buildStartFormState({ wizardDraft, rolloverPreview, startForm }) {
  if (wizardDraft?.nextSchoolYear) {
    return {
      schoolYearName: wizardDraft.nextSchoolYear.name || "",
      startDate: wizardDraft.nextSchoolYear.startDate || "",
      endDate: wizardDraft.nextSchoolYear.endDate || ""
    };
  }

  if (startForm) {
    return {
      schoolYearName: String(startForm.schoolYearName || "").trim(),
      startDate: String(startForm.startDate || "").trim(),
      endDate: String(startForm.endDate || "").trim()
    };
  }

  return {
    schoolYearName: rolloverPreview?.nextSchoolYear?.name || "",
    startDate: rolloverPreview?.nextSchoolYear?.startDate || "",
    endDate: rolloverPreview?.nextSchoolYear?.endDate || ""
  };
}

async function loadPageData(req, options = {}) {
  const wizardDraft = getWizardDraft(req);
  const [schoolYears, logs] = await Promise.all([
    schoolYearModel.listSchoolYears(),
    schoolYearModel.listRolloverLogs()
  ]);

  let rolloverPreview = null;
  let activeSchoolYear = wizardDraft?.activeSchoolYear || schoolYears.find((schoolYear) => Boolean(schoolYear?.is_active)) || null;
  let defaultError = "";

  if (!wizardDraft) {
    try {
      rolloverPreview = await rolloverService.buildRolloverPreview(options.previewOptions);
      activeSchoolYear = rolloverPreview?.activeSchoolYear || null;
    } catch (err) {
      const errorMessage = String(err.message || "");
      const isWizardConfigError =
        errorMessage.includes("Kein aktives Schuljahr") ||
        errorMessage.includes("Startdatum") ||
        errorMessage.includes("Enddatum") ||
        errorMessage.includes("Bezeichnung") ||
        errorMessage.includes("existiert bereits") ||
        errorMessage.includes("passen nicht zusammen");

      if (!isWizardConfigError) {
        throw err;
      }

      defaultError = errorMessage || "Vorschau konnte nicht geladen werden.";
    }
  }

  return {
    wizardDraft,
    wizardView: wizardDraft ? rolloverService.buildWizardViewData(wizardDraft) : null,
    rolloverPreview,
    activeSchoolYear,
    schoolYears,
    logs,
    defaultError
  };
}

async function renderRolloverPage(req, res, next, options = {}) {
  try {
    const pageData = await loadPageData(req, { previewOptions: options.previewOptions });
    const wizardDraft = pageData.wizardDraft;
    let wizardStep = normalizeStep(options.step || req.query.step || (wizardDraft ? "classes" : "start"));

    if (!wizardDraft && wizardStep !== "start") {
      wizardStep = "start";
    }

    return res.render("admin/rollover", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: "/admin/rollover",
      activeSchoolYear: pageData.activeSchoolYear,
      schoolYears: pageData.schoolYears,
      logs: pageData.logs.slice(0, 10),
      rolloverPreview: pageData.rolloverPreview,
      wizardDraft,
      wizardView: pageData.wizardView,
      wizardStep,
      wizardSteps: ROLLOVER_STEPS,
      startForm: buildStartFormState({
        wizardDraft,
        rolloverPreview: pageData.rolloverPreview,
        startForm: options.startForm
      }),
      message: options.message || String(req.query.message || "").trim(),
      error: options.error || String(req.query.error || "").trim() || pageData.defaultError,
      intakeParseErrors: options.intakeParseErrors || []
    });
  } catch (err) {
    return next(err);
  }
}

async function showRolloverPage(req, res, next) {
  return renderRolloverPage(req, res, next);
}

async function startWizard(req, res, next) {
  try {
    const startOptions = extractStartWizardOptions(req.body);
    const wizardDraft = await rolloverService.createWizardDraft(startOptions);
    setWizardDraft(req, wizardDraft);
    await saveSession(req);
    return res.redirect("/admin/rollover?step=classes");
  } catch (err) {
    const startOptions = extractStartWizardOptions(req.body);
    return renderRolloverPage(req, res, next, {
      step: "start",
      previewOptions: startOptions,
      startForm: startOptions,
      error: err.message || "Assistent konnte nicht gestartet werden."
    });
  }
}

async function saveClassStep(req, res, next) {
  try {
    const wizardDraft = getWizardDraft(req);
    if (!wizardDraft) {
      return res.redirect("/admin/rollover?step=start&error=Assistent bitte zuerst starten.");
    }

    const updatedDraft = rolloverService.updateClassPlansFromForm(wizardDraft, req.body);
    setWizardDraft(req, updatedDraft);
    await saveSession(req);

    const nextStep = req.body?.intent === "stay" ? "classes" : "students";
    return res.redirect(`/admin/rollover?step=${nextStep}`);
  } catch (err) {
    return renderRolloverPage(req, res, next, {
      step: "classes",
      error: err.message || "Klassenplanung konnte nicht gespeichert werden."
    });
  }
}

async function saveStudentStep(req, res, next) {
  try {
    const wizardDraft = getWizardDraft(req);
    if (!wizardDraft) {
      return res.redirect("/admin/rollover?step=start&error=Assistent bitte zuerst starten.");
    }

    const result = rolloverService.updateStudentPlansFromForm(wizardDraft, req.body);
    setWizardDraft(req, result.draft);
    await saveSession(req);

    const shouldAdvance = req.body?.intent !== "back";
    const hasBlockingErrors = result.intakeParseErrors.length > 0 || !result.validation.valid;

    if (shouldAdvance && hasBlockingErrors) {
      return renderRolloverPage(req, res, next, {
        step: "students",
        error: result.validation.errors[0] || "Bitte Eingaben im Schüler-Schritt prüfen.",
        intakeParseErrors: result.intakeParseErrors
      });
    }

    return res.redirect(`/admin/rollover?step=${shouldAdvance ? "review" : "classes"}`);
  } catch (err) {
    return renderRolloverPage(req, res, next, {
      step: "students",
      error: err.message || "Schülerplanung konnte nicht gespeichert werden."
    });
  }
}

async function resetWizard(req, res, next) {
  try {
    clearWizardDraft(req);
    await saveSession(req);
    return res.redirect("/admin/rollover?step=start&message=Rollover-Assistent wurde zurückgesetzt.");
  } catch (err) {
    return renderRolloverPage(req, res, next, {
      step: "start",
      error: err.message || "Assistent konnte nicht zurückgesetzt werden."
    });
  }
}

async function executeRollover(req, res, next) {
  try {
    const wizardDraft = getWizardDraft(req);
    const executionResult = await rolloverService.executeWizardRollover({
      draft: wizardDraft,
      executedBy: req.session.user.id,
      confirmationText: req.body?.confirmation_text
    });

    clearWizardDraft(req);
    await saveSession(req);

    return res.redirect(`/admin/rollover?step=start&message=${encodeURIComponent(
      `Schuljahreswechsel nach ${executionResult.preview.nextSchoolYear.name} erfolgreich ausgeführt.`
    )}`);
  } catch (err) {
    return renderRolloverPage(req, res, next, {
      step: "review",
      error: err.message || "Schuljahreswechsel konnte nicht ausgeführt werden."
    });
  }
}

async function restoreSchoolYear(req, res, next) {
  try {
    const logId = Number(req.body?.log_id);
    const logs = await schoolYearModel.listRolloverLogs();
    const logRow = logs.find((entry) => Number(entry.id) === logId);

    if (!logRow || !logRow.backup_path) {
      throw new Error("Ausgewählter Backup-Eintrag wurde nicht gefunden.");
    }

    if (String(logRow.status || "").toLowerCase() !== "success") {
      throw new Error("Nur erfolgreiche Schuljahreswechsel können wiederhergestellt werden.");
    }

    const restoreResult = await rolloverService.restoreSchoolYearFromBackup({
      backupPath: logRow.backup_path,
      executedBy: req.session.user.id
    });

    clearWizardDraft(req);
    await saveSession(req);

    return res.redirect(`/admin/rollover?step=start&message=${encodeURIComponent(
      `${restoreResult.targetSchoolYearName} wurde auf ${restoreResult.previousSchoolYearName} zurückgesetzt.`
    )}`);
  } catch (err) {
    return renderRolloverPage(req, res, next, {
      step: "start",
      error: err.message || "Schuljahr konnte nicht wiederhergestellt werden."
    });
  }
}

module.exports = {
  executeRollover,
  resetWizard,
  restoreSchoolYear,
  saveClassStep,
  saveStudentStep,
  showRolloverPage,
  startWizard
};
