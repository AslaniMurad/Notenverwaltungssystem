const schoolYearModel = require("../models/schoolYearModel");
const rolloverService = require("../services/rolloverService");

async function loadRolloverPageData() {
  const [schoolYears, logs] = await Promise.all([
    schoolYearModel.listSchoolYears(),
    schoolYearModel.listRolloverLogs()
  ]);

  try {
    const rollover = await rolloverService.buildRolloverPreview();
    return {
      rollover,
      activeSchoolYear: rollover?.activeSchoolYear || null,
      schoolYears,
      logs,
      defaultError: ""
    };
  } catch (err) {
    if (String(err.message || "").includes("Kein aktives Schuljahr")) {
      return {
        rollover: null,
        activeSchoolYear: null,
        schoolYears,
        logs,
        defaultError: err.message
      };
    }
    throw err;
  }
}

async function renderRolloverPage(req, res, next, options = {}) {
  try {
    const pageData = await loadRolloverPageData();

    return res.render("admin/rollover", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: "/admin/rollover",
      rollover: pageData.rollover,
      activeSchoolYear: pageData.activeSchoolYear,
      schoolYears: pageData.schoolYears,
      logs: pageData.logs.slice(0, 10),
      message: options.message || String(req.query.message || "").trim(),
      error: options.error || String(req.query.error || "").trim() || pageData.defaultError
    });
  } catch (err) {
    return next(err);
  }
}

async function showRolloverPage(req, res, next) {
  return renderRolloverPage(req, res, next);
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
  showRolloverPage
};
