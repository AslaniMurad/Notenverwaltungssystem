const schoolYearModel = require("../models/schoolYearModel");
const rolloverService = require("../services/rolloverService");

async function renderRolloverPage(req, res, next, options = {}) {
  try {
    const [preview, schoolYears, logs] = await Promise.all([
      rolloverService.buildRolloverPreview(),
      schoolYearModel.listSchoolYears(),
      schoolYearModel.listRolloverLogs()
    ]);

    return res.render("admin/rollover", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: "/admin/rollover",
      preview,
      activeSchoolYear: preview?.activeSchoolYear || null,
      schoolYears,
      logs: logs.slice(0, 10),
      message: options.message || String(req.query.message || "").trim(),
      error: options.error || String(req.query.error || "").trim(),
      testMode: Boolean(options.testMode),
      executionResult: options.executionResult || null
    });
  } catch (err) {
    if (String(err.message || "").includes("Kein aktives Schuljahr")) {
      return res.render("admin/rollover", {
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: "/admin/rollover",
        preview: null,
        activeSchoolYear: null,
        schoolYears: [],
        logs: [],
        message: "",
        error: err.message,
        testMode: false,
        executionResult: null
      });
    }
    return next(err);
  }
}

async function showRolloverPage(req, res, next) {
  return renderRolloverPage(req, res, next);
}

async function testRollover(req, res, next) {
  try {
    const preview = await rolloverService.buildRolloverPreview();
    const [schoolYears, logs] = await Promise.all([
      schoolYearModel.listSchoolYears(),
      schoolYearModel.listRolloverLogs()
    ]);

    return res.render("admin/rollover", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: "/admin/rollover",
      preview,
      activeSchoolYear: preview?.activeSchoolYear || null,
      schoolYears,
      logs: logs.slice(0, 10),
      message: "",
      error: preview.nextSchoolYearExists
        ? `Das naechste Schuljahr ${preview.nextSchoolYear.name} existiert bereits.`
        : "",
      testMode: true,
      executionResult: null
    });
  } catch (err) {
    return renderRolloverPage(req, res, next, {
      error: err.message || "Rollover-Vorschau konnte nicht erstellt werden.",
      testMode: true
    });
  }
}

async function executeRollover(req, res, next) {
  try {
    const executionResult = await rolloverService.rolloverSchoolYear({
      executedBy: req.session.user.id,
      confirmationText: req.body?.confirmation_text
    });

    return res.redirect(`/admin/rollover?message=${encodeURIComponent(
      `Schuljahreswechsel nach ${executionResult.preview.nextSchoolYear.name} erfolgreich ausgefuehrt.`
    )}`);
  } catch (err) {
    return renderRolloverPage(req, res, next, {
      error: err.message || "Schuljahreswechsel konnte nicht ausgefuehrt werden."
    });
  }
}

module.exports = {
  executeRollover,
  showRolloverPage,
  testRollover
};
