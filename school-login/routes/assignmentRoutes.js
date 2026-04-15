const express = require("express");
const { requireAuth, requireRole } = require("../middleware/auth");
const assignmentController = require("../controllers/assignmentController");

const router = express.Router();

router.use(requireAuth, requireRole("admin"));

router.get("/assignments", assignmentController.renderAssignmentList);
router.get("/assignments/new", assignmentController.renderNewAssignmentForm);
router.get("/assignments/api/class/:classId/teachers", assignmentController.getClassTeachers);
router.post("/assignments", assignmentController.createAssignment);
router.post("/assignments/delete", assignmentController.deleteAssignment);
router.post("/assignments/delete-group", assignmentController.deleteAssignmentGroup);

module.exports = router;
