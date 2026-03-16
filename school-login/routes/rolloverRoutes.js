const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const rolloverController = require("../controllers/rolloverController");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

router.get("/rollover", rolloverController.showRolloverPage);
router.post("/rollover/execute", rolloverController.executeRollover);

module.exports = router;
