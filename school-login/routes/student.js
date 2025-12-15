const express = require("express");
const {
  getStudentProfileByEmail,
  listSubjects,
  getStudentGrades,
  calculateSubjectAverages,
  getClassAverages,
  analyzeTrend,
  getNotifications,
  buildCsv,
  buildPdfBuffer,
  getAssignmentsForClass,
  getAssignmentDetail,
  getAssignmentFileForStudent
} = require("../services/studentService");
const { requireAuth, requireRole } = require("../middleware/auth");
const path = require("path");
const fs = require("fs");

const router = express.Router();

router.use(requireAuth, requireRole("student"));

function buildFilters(query) {
  const filters = {
    subject: query.subject || undefined,
    startDate: query.startDate || undefined,
    endDate: query.endDate || undefined,
    sortBy: query.sortBy || "grade_date",
    order: query.order || "DESC"
  };
  if (filters.sortBy !== "grade_value" && filters.sortBy !== "grade_date") filters.sortBy = "grade_date";
  if (!filters.order || !["ASC", "DESC", "asc", "desc"].includes(filters.order)) filters.order = "DESC";
  return filters;
}

router.get("/", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) {
      return res.status(404).render("error", {
        status: 404,
        message: "Schülerprofil nicht gefunden.",
        backUrl: "/login",
        csrfToken: req.csrfToken()
      });
    }

    const filters = buildFilters(req.query || {});
    const subjects = await listSubjects(profile.id);
    const grades = await getStudentGrades(profile.id, filters);
    const { subjectAverages, overallAverage } = await calculateSubjectAverages(profile.id);
    const classAverages = await getClassAverages(profile.classId);
    const trend = analyzeTrend(grades);
    const notifications = await getNotifications(profile.id, 6);
    const assignments = await getAssignmentsForClass(profile.classId);
    const latestGrades = grades.slice(0, 5);

    const hero = {
      headline: "Dein Dashboard",
      statement: "Alles Wichtige für deinen Schultag.",
      summary: "Aktuelle Noten, Fortschritt und Benachrichtigungen im Überblick.",
      badges: ["Schüler-Sicht", profile.className]
    };

    const studentProfile = {
      name: profile.name,
      class: profile.className,
      schoolYear: profile.schoolYear,
      meta: [
        { label: "Klasse", value: profile.className },
        { label: "Schuljahr", value: profile.schoolYear },
        { label: "Fächer", value: subjects.length || "–" },
        { label: "⌀ Note", value: overallAverage ? overallAverage.toFixed(2) : "–" }
      ]
    };

    const focusStats = [
      { label: "Noten insgesamt", value: grades.length, detail: "inkl. Filter" },
      { label: "Fächer", value: subjects.length || "–", detail: "aktive Fächer" },
      { label: "Letzte Änderung", value: grades[0]?.grade_date || "–", detail: "neueste Note" }
    ];

    const classComparison = {
      overall: classAverages.overallAverage,
      subjects: classAverages.subjectAverages
    };

    res.render("student-dashboard", {
      email: req.session.user.email,
      hero,
      studentProfile,
      focusStats,
      tasks: assignments,
      returns: [],
      grades,
      latestGrades,
      materials: [],
      messages: notifications,
      subjectAverages,
      overallAverage,
      classComparison,
      filters,
      subjects,
      trend,
      csrfToken: req.csrfToken()
    });
  } catch (error) {
    next(error);
  }
});

router.get("/profile", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).json({ error: "Profil nicht gefunden" });
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

router.get("/grades", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).json({ error: "Profil nicht gefunden" });
    const filters = buildFilters(req.query || {});
    const grades = await getStudentGrades(profile.id, filters);
    res.json({ grades, filters });
  } catch (error) {
    next(error);
  }
});

router.get("/averages", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).json({ error: "Profil nicht gefunden" });
    const averages = await calculateSubjectAverages(profile.id);
    res.json(averages);
  } catch (error) {
    next(error);
  }
});

router.get("/class-averages", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).json({ error: "Profil nicht gefunden" });
    const classAverages = await getClassAverages(profile.classId);
    res.json(classAverages);
  } catch (error) {
    next(error);
  }
});

router.get("/notifications", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).json({ error: "Profil nicht gefunden" });
    const notifications = await getNotifications(profile.id, 20);
    res.json({ notifications });
  } catch (error) {
    next(error);
  }
});

router.get("/assignments", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).json({ error: "Profil nicht gefunden" });
    const assignments = await getAssignmentsForClass(profile.classId);
    res.json({ assignments });
  } catch (error) {
    next(error);
  }
});

router.get("/assignments/:assignmentId", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).json({ error: "Profil nicht gefunden" });
    const assignmentId = Number(req.params.assignmentId);
    const assignment = await getAssignmentDetail(assignmentId, profile.classId);
    if (!assignment) return res.status(404).json({ error: "Aufgabe nicht gefunden" });
    res.json({ assignment });
  } catch (error) {
    next(error);
  }
});

router.get("/assignments/:assignmentId/files/:fileId", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).send("Profil nicht gefunden");
    const assignmentId = Number(req.params.assignmentId);
    const fileId = Number(req.params.fileId);
    const result = await getAssignmentFileForStudent(assignmentId, profile.classId, fileId);
    if (!result) return res.status(404).send("Datei nicht gefunden oder Zugriff nicht erlaubt");

    const baseDir = path.join(__dirname, "..", "data", "assignments");
    const safePath = path.join(baseDir, path.basename(result.file.stored_name));
    if (!safePath.startsWith(baseDir)) return res.status(403).send("Zugriff verweigert");
    if (!fs.existsSync(safePath)) return res.status(404).send("Datei fehlt");

    const download = req.query.download === "1";
    res.setHeader(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(result.file.file_name)}"`
    );
    res.type(result.file.mime_type || "application/pdf");
    res.sendFile(safePath);
  } catch (error) {
    next(error);
  }
});

router.get("/export/csv", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).send("Profil nicht gefunden");
    const filters = buildFilters(req.query || {});
    const grades = await getStudentGrades(profile.id, filters);
    const csv = buildCsv(grades, profile);
    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment(`noten_${profile.className}.csv`);
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

router.get("/export/pdf", async (req, res, next) => {
  try {
    const profile = await getStudentProfileByEmail(req.session.user.email);
    if (!profile) return res.status(404).send("Profil nicht gefunden");
    const filters = buildFilters(req.query || {});
    const grades = await getStudentGrades(profile.id, filters);
    const { subjectAverages, overallAverage } = await calculateSubjectAverages(profile.id);
    const pdfBuffer = await buildPdfBuffer(grades, profile, overallAverage, subjectAverages);
    res.header("Content-Type", "application/pdf");
    res.attachment(`noten_${profile.className}.pdf`);
    res.send(pdfBuffer);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
