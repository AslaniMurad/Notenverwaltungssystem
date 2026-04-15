const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createAuditLogMiddleware } = require("../middleware/audit");
const archiveController = require("../controllers/archiveController");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));
router.use(createAuditLogMiddleware());

router.get("/archive", archiveController.showArchive);
router.get("/archive/export/:dataset", archiveController.downloadArchiveCsv);
router.get("/archive/purge", archiveController.showArchiveDeletePage);
router.post("/archive/purge/preview", archiveController.previewArchiveDelete);
router.post("/archive/purge/execute", archiveController.executeArchiveDelete);
router.get("/archive/graduates", archiveController.showGraduateCleanupPage);
router.post("/archive/graduates/preview", archiveController.previewGraduateCleanup);
router.post("/archive/graduates/execute", archiveController.executeGraduateCleanup);

module.exports = router;
