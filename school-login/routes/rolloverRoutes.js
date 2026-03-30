const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const rolloverController = require("../controllers/rolloverController");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

router.get("/rollover", rolloverController.showRolloverPage);
router.post("/rollover/start", rolloverController.startWizard);
router.post("/rollover/classes", rolloverController.saveClassStep);
router.post("/rollover/students", rolloverController.saveStudentStep);
router.post("/rollover/reset", rolloverController.resetWizard);
router.post("/rollover/restore", rolloverController.restoreSchoolYear);
router.post("/rollover/execute", rolloverController.executeRollover);

module.exports = router;
