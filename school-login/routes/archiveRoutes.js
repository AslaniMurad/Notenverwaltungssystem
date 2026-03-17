const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const archiveController = require("../controllers/archiveController");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

router.get("/archive", archiveController.showArchive);
router.get("/archive/export/:dataset", archiveController.downloadArchiveCsv);

module.exports = router;
