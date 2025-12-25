const express = require("express");
const router = express.Router();
const { db } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

router.use(requireAuth, requireRole("teacher"));

function renderError(res, req, message, status, backUrl) {
  return res.status(status).render("error", {
    message,
    status,
    backUrl,
    csrfToken: req.csrfToken()
  });
}

async function loadClassForTeacher(classId, teacherId) {
  return getAsync(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, teacherId]
  );
}

async function loadStudents(classId) {
  return allAsync("SELECT id, name, email FROM students WHERE class_id = ? ORDER BY name", [classId]);
}

async function loadTemplates(classId) {
  return allAsync(
    "SELECT id, name, category, weight, date, description FROM grade_templates WHERE class_id = ? ORDER BY date, name",
    [classId]
  );
}

async function loadStudentGrades(studentId) {
  return allAsync(
    `SELECT g.id, g.grade, g.note, g.created_at, g.grade_template_id as template_id, gt.name, gt.category, gt.weight, gt.date, c.subject as class_subject
     FROM grades g
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     JOIN classes c ON c.id = g.class_id
     WHERE g.student_id = ?`,
    [studentId]
  );
}

function computeWeightedAverage(grades) {
  let weightedSum = 0;
  let weightTotal = 0;

  grades.forEach((grade) => {
    const value = Number(grade.grade);
    const weight = Number(grade.weight || 1);
    if (Number.isNaN(value) || Number.isNaN(weight)) return;
    weightedSum += value * weight;
    weightTotal += weight;
  });

  return weightTotal ? Number((weightedSum / weightTotal).toFixed(2)) : null;
}

router.get("/classes", async (req, res, next) => {
  try {
    const classes = await allAsync(
      "SELECT id, name, subject FROM classes WHERE teacher_id = ? ORDER BY created_at DESC",
      [req.session.user.id]
    );

    res.render("teacher/teacher-classes", {
      email: req.session.user.email,
      classes,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/create-class", (req, res) => {
  res.render("teacher/teacher-create-class", {
    email: req.session.user.email,
    csrfToken: req.csrfToken()
  });
});

router.post("/create-class", async (req, res, next) => {
  try {
    const { name, subject } = req.body || {};
    if (!name || !subject) {
      return renderError(res, req, "Bitte alle Pflichtfelder ausfüllen.", 400, "/teacher/create-class");
    }

    await runAsync("INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)", [
      name,
      subject,
      req.session.user.id
    ]);
    res.redirect("/teacher/classes");
  } catch (err) {
    next(err);
  }
});

router.post("/delete-class/:id", async (req, res, next) => {
  try {
    const classId = req.params.id;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    await runAsync("DELETE FROM students WHERE class_id = ?", [classId]);
    await runAsync("DELETE FROM classes WHERE id = ?", [classId]);
    res.redirect("/teacher/classes");
  } catch (err) {
    next(err);
  }
});

router.get("/students/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    res.render("teacher/teacher-students", {
      email: req.session.user.email,
      classData,
      students,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/add-student/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    res.render("teacher/teacher-add-student", {
      email: req.session.user.email,
      classData,
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/add-student/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const { name, email } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    if (!name || !email) {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Bitte Name und E-Mail angeben."
      });
    }

    const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [email]);
    if (!userRow || userRow.role !== "student") {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "E-Mail nicht gefunden oder nicht als Schüler registriert."
      });
    }

    const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [email, classId]);
    if (duplicate) {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Dieser Schüler ist bereits in der Klasse."
      });
    }

    await runAsync("INSERT INTO students (name, email, class_id) VALUES (?,?,?)", [name, email, classId]);
    res.redirect(`/teacher/students/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-student/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    await runAsync("DELETE FROM students WHERE id = ? AND class_id = ?", [studentId, classId]);
    res.redirect(`/teacher/students/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/grades/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const studentsWithGrades = await Promise.all(
      students.map(async (student) => {
        const grades = await loadStudentGrades(student.id);
        const average = computeWeightedAverage(grades);
        return {
          ...student,
          grade_count: grades.length,
          average_grade: average
        };
      })
    );

    res.render("teacher/teacher-grades", {
      email: req.session.user.email,
      classData,
      students: studentsWithGrades,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/student-grades/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const gradeRows = await loadStudentGrades(student.id);
    const grades = gradeRows.map((row) => ({
      id: row.id,
      grade: row.grade,
      note: row.note,
      category: row.category,
      weight: row.weight,
      template_name: row.name,
      template_date: row.date
    }));
    const average = computeWeightedAverage(gradeRows);

    res.render("teacher/teacher-student-grades", {
      email: req.session.user.email,
      classData,
      student,
      grades,
      average,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/delete-grade/:classId/:gradeId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const gradeId = req.params.gradeId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    await runAsync("DELETE FROM grades WHERE id = ? AND class_id = ?", [gradeId, classId]);
    const backUrl = req.get("referer") || `/teacher/grades/${classId}`;
    res.redirect(backUrl);
  } catch (err) {
    next(err);
  }
});

router.get("/add-grade/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const templates = await loadTemplates(classId);
    res.render("teacher/teacher-add-grade", {
      email: req.session.user.email,
      classData,
      student,
      templates,
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/add-grade/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const { grade_template_id, grade, note } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const templates = await loadTemplates(classId);
    if (!grade_template_id || !grade) {
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: "Bitte alle Pflichtfelder ausfüllen."
      });
    }

    const gradeValue = Number(grade);
    if (!Number.isFinite(gradeValue) || gradeValue < 1 || gradeValue > 5) {
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: "Note muss zwischen 1 und 5 liegen."
      });
    }

    const templateRow = await getAsync(
      "SELECT id FROM grade_templates WHERE id = ? AND class_id = ?",
      [grade_template_id, classId]
    );
    if (!templateRow) {
      return res.status(400).render("teacher/teacher-add-grade", {
        email: req.session.user.email,
        classData,
        student,
        templates,
        csrfToken: req.csrfToken(),
        error: "Prüfungsvorlage nicht gefunden."
      });
    }

    try {
      await runAsync(
        "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
        [studentId, classId, grade_template_id, gradeValue, note || null]
      );
      await runAsync("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [
        studentId,
        "Neue Note eingetragen.",
        "grade"
      ]);
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        return res.status(409).render("teacher/teacher-add-grade", {
          email: req.session.user.email,
          classData,
          student,
          templates,
          csrfToken: req.csrfToken(),
          error: "Diese Prüfung wurde bereits benotet."
        });
      }
      throw err;
    }

    res.redirect(`/teacher/student-grades/${classId}/${studentId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/grade-templates/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const templates = await loadTemplates(classId);
    const totalWeight = Number(
      templates.reduce((sum, template) => sum + Number(template.weight || 0), 0).toFixed(2)
    );

    res.render("teacher/teacher-grade-templates", {
      email: req.session.user.email,
      classData,
      templates,
      totalWeight,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/create-template/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    res.render("teacher/teacher-create-template", {
      email: req.session.user.email,
      classData,
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/create-template/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const { name, category, weight, date, description } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const weightValue = Number(weight);
    if (!name || !category || !Number.isFinite(weightValue)) {
      return res.status(400).render("teacher/teacher-create-template", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Bitte alle Pflichtfelder ausfüllen."
      });
    }
    if (weightValue < 0 || weightValue > 100) {
      return res.status(400).render("teacher/teacher-create-template", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Gewichtung muss zwischen 0 und 100 liegen."
      });
    }

    await runAsync(
      "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
      [classId, name, category, weightValue, date || null, description || null]
    );
    res.redirect(`/teacher/grade-templates/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-template/:classId/:templateId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const templateId = req.params.templateId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const templateRow = await getAsync(
      "SELECT id FROM grade_templates WHERE id = ? AND class_id = ?",
      [templateId, classId]
    );
    if (!templateRow) {
      return renderError(res, req, "Prüfung nicht gefunden.", 404, `/teacher/grade-templates/${classId}`);
    }

    await runAsync("DELETE FROM grade_templates WHERE id = ? AND class_id = ?", [templateId, classId]);
    res.redirect(`/teacher/grade-templates/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/class-statistics/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const templates = await loadTemplates(classId);
    const studentMap = new Map(students.map((student) => [String(student.id), student]));
    const gradesByStudent = new Map();

    for (const student of students) {
      const grades = await loadStudentGrades(student.id);
      gradesByStudent.set(String(student.id), grades);
    }

    const templateStats = templates.map((template) => {
      const templateGrades = [];

      gradesByStudent.forEach((grades, studentId) => {
        const student = studentMap.get(studentId);
        grades.forEach((grade) => {
          const matchesById =
            grade.template_id && Number(grade.template_id) === Number(template.id);
          const matchesByName = !grade.template_id && grade.name === template.name;
          if (!matchesById && !matchesByName) return;

          const value = Number(grade.grade);
          if (Number.isNaN(value)) return;
          templateGrades.push({ value, studentName: student?.name || "" });
        });
      });

      const values = templateGrades.map((entry) => entry.value);
      const average = values.length
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
        : null;
      const bestGrade = values.length ? Math.min(...values) : null;
      const worstGrade = values.length ? Math.max(...values) : null;

      const bestStudents =
        bestGrade == null
          ? []
          : templateGrades
              .filter((entry) => entry.value === bestGrade)
              .map((entry) => entry.studentName)
              .filter(Boolean);
      const worstStudents =
        worstGrade == null
          ? []
          : templateGrades
              .filter((entry) => entry.value === worstGrade)
              .map((entry) => entry.studentName)
              .filter(Boolean);

      return {
        ...template,
        average,
        graded_count: values.length,
        best_grade: bestGrade,
        worst_grade: worstGrade,
        best_students: bestStudents,
        worst_students: worstStudents
      };
    });

    const allValues = [];
    let weightedSum = 0;
    let weightTotal = 0;

    gradesByStudent.forEach((grades) => {
      grades.forEach((grade) => {
        const value = Number(grade.grade);
        const weight = Number(grade.weight || 1);
        if (Number.isNaN(value) || Number.isNaN(weight)) return;
        allValues.push(value);
        weightedSum += value * weight;
        weightTotal += weight;
      });
    });

    const overallAverage = allValues.length
      ? Number((allValues.reduce((sum, value) => sum + value, 0) / allValues.length).toFixed(2))
      : null;
    const overallWeightedAverage = weightTotal
      ? Number((weightedSum / weightTotal).toFixed(2))
      : null;

    res.render("teacher/teacher-class-statistics", {
      email: req.session.user.email,
      classData,
      studentCount: students.length,
      overallWeightedAverage,
      overallAverage,
      templateStats,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
