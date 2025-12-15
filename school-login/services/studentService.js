const { db } = require("../db");

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function useFakeStore() {
  return Boolean(db.isFake && db.__data);
}

function computeWeightedAverage(grades) {
  const sums = grades.reduce(
    (acc, grade) => {
      const weight = Number(grade.weight) || 1;
      acc.weightedSum += (Number(grade.grade_value) || 0) * weight;
      acc.totalWeight += weight;
      return acc;
    },
    { weightedSum: 0, totalWeight: 0 }
  );
  if (!sums.totalWeight) return null;
  return sums.weightedSum / sums.totalWeight;
}

function deriveAssignmentStatus(assignment) {
  const due = assignment.due_date ? new Date(assignment.due_date) : null;
  const now = new Date();
  if (assignment.status === "submitted" || assignment.submitted_at) return "submitted";
  if (assignment.status === "overdue") return "overdue";
  if (due && due < now) return "overdue";
  return "open";
}

async function getStudentProfileByEmail(email) {
  if (useFakeStore()) {
    const { students, classes } = db.__data;
    const student = students.find((s) => s.email === email);
    if (!student) return null;
    const classData = classes.find((c) => c.id === student.class_id);
    if (!classData) return null;
    return {
      id: student.id,
      name: student.name,
      email: student.email,
      classId: classData.id,
      className: classData.name,
      classSubject: classData.subject,
      schoolYear: new Date().getFullYear()
    };
  }
  const row = await dbGet(
    `SELECT s.id as student_id, s.name as student_name, s.email, s.class_id, c.name as class_name, c.subject as class_subject
     FROM students s JOIN classes c ON c.id = s.class_id WHERE s.email = ?`,
    [email]
  );
  if (!row) return null;
  return {
    id: row.student_id,
    name: row.student_name,
    email: row.email,
    classId: row.class_id,
    className: row.class_name,
    classSubject: row.class_subject,
    schoolYear: new Date().getFullYear()
  };
}

async function listSubjects(studentId) {
  if (useFakeStore()) {
    const { grades } = db.__data;
    return Array.from(new Set(grades.filter((g) => g.student_id === studentId).map((g) => g.subject)));
  }
  const rows = await dbAll("SELECT DISTINCT subject FROM grades WHERE student_id = ? ORDER BY subject", [studentId]);
  return rows.map((r) => r.subject);
}

async function getStudentGrades(studentId, { subject, startDate, endDate, sortBy = "grade_date", order = "DESC" } = {}) {
  if (useFakeStore()) {
    const { grades } = db.__data;
    const filtered = grades
      .filter((g) => g.student_id === studentId)
      .filter((g) => (!subject ? true : g.subject === subject))
      .filter((g) => (!startDate ? true : g.grade_date >= startDate))
      .filter((g) => (!endDate ? true : g.grade_date <= endDate));
    const sortKey = sortBy === "grade_value" ? "grade_value" : "grade_date";
    const sorted = filtered.sort((a, b) => {
      const factor = order.toUpperCase() === "ASC" ? 1 : -1;
      if (sortKey === "grade_value") return (a.grade_value - b.grade_value) * factor;
      return String(a.grade_date).localeCompare(String(b.grade_date)) * factor;
    });
    return sorted.map((g) => ({ ...g }));
  }

  let sql = `SELECT id, subject, grade_value, grade_date, weight, teacher_comment, teacher_id, created_at
             FROM grades WHERE student_id = ?`;
  const params = [studentId];
  if (subject) {
    sql += " AND subject = ?";
    params.push(subject);
  }
  if (startDate) {
    sql += " AND grade_date >= ?";
    params.push(startDate);
  }
  if (endDate) {
    sql += " AND grade_date <= ?";
    params.push(endDate);
  }
  const allowedSort = sortBy === "grade_value" ? "grade_value" : "grade_date";
  const direction = order && order.toUpperCase() === "ASC" ? "ASC" : "DESC";
  sql += ` ORDER BY ${allowedSort} ${direction}`;
  return dbAll(sql, params);
}

async function calculateSubjectAverages(studentId) {
  const grades = await getStudentGrades(studentId, {});
  const map = new Map();
  grades.forEach((grade) => {
    const key = grade.subject;
    const entry = map.get(key) || [];
    entry.push(grade);
    map.set(key, entry);
  });
  const subjectAverages = Array.from(map.entries()).map(([subject, gradesForSubject]) => ({
    subject,
    average: computeWeightedAverage(gradesForSubject)
  }));
  const overallAverage = computeWeightedAverage(grades);
  return { subjectAverages, overallAverage };
}

async function getClassAverages(classId) {
  if (useFakeStore()) {
    const { grades, students } = db.__data;
    const ids = students.filter((s) => s.class_id === classId).map((s) => s.id);
    const filtered = grades.filter((g) => ids.includes(g.student_id));
    const map = new Map();
    filtered.forEach((g) => {
      const entry = map.get(g.subject) || [];
      entry.push(g);
      map.set(g.subject, entry);
    });
    const subjectAverages = Array.from(map.entries()).map(([subject, gradesForSubject]) => ({
      subject,
      average: computeWeightedAverage(gradesForSubject)
    }));
    return {
      subjectAverages,
      overallAverage: computeWeightedAverage(filtered)
    };
  }

  const rows = await dbAll(
    `SELECT g.subject, SUM(g.grade_value * g.weight) AS weightedSum, SUM(g.weight) AS totalWeight
     FROM grades g
     JOIN students s ON g.student_id = s.id
     WHERE s.class_id = ?
     GROUP BY g.subject`,
    [classId]
  );
  const subjectAverages = rows.map((row) => ({
    subject: row.subject,
    average: row.totalWeight ? row.weightedSum / row.totalWeight : null
  }));
  const totalWeightedSum = rows.reduce((acc, r) => acc + (Number(r.weightedSum) || 0), 0);
  const totalWeight = rows.reduce((acc, r) => acc + (Number(r.totalWeight) || 0), 0);
  return {
    subjectAverages,
    overallAverage: totalWeight ? totalWeightedSum / totalWeight : null
  };
}

function analyzeTrend(grades) {
  if (!grades || grades.length < 2) return { direction: "stable", delta: 0, message: "Noch zu wenige Noten für eine Tendenz." };
  const sorted = [...grades].sort((a, b) => String(a.grade_date).localeCompare(String(b.grade_date)));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const delta = (Number(first.grade_value) || 0) - (Number(last.grade_value) || 0);
  const direction = delta > 0.1 ? "improving" : delta < -0.1 ? "declining" : "stable";
  let message = "Entwicklung stabil.";
  if (direction === "improving") message = "Du verbesserst dich – weiter so!";
  if (direction === "declining") message = "Leichte Verschlechterung – prüfe Lernplan.";
  return { direction, delta: Math.round(delta * 100) / 100, message };
}

async function getAssignmentsForClass(classId) {
  if (useFakeStore()) {
    const { assignments, assignmentFiles } = db.__data;
    return assignments
      .filter((a) => a.class_id === classId)
      .sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")))
      .map((assignment) => ({
        ...assignment,
        status: deriveAssignmentStatus(assignment),
        attachments: assignmentFiles.filter((f) => f.assignment_id === assignment.id)
      }));
  }

  const assignments = await dbAll(
    `SELECT id, class_id, title, description, subject, due_date, status, submitted_at, created_at, updated_at
     FROM assignments WHERE class_id = ?
     ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date`,
    [classId]
  );
  const ids = assignments.map((a) => a.id);
  const files = ids.length
    ? await dbAll(
        `SELECT id, assignment_id, file_name, stored_name, mime_type, file_size
         FROM assignment_files WHERE assignment_id IN (${ids.map(() => "?").join(",")})`,
        ids
      )
    : [];
  const fileMap = new Map();
  files.forEach((file) => {
    const list = fileMap.get(file.assignment_id) || [];
    list.push(file);
    fileMap.set(file.assignment_id, list);
  });
  return assignments.map((assignment) => ({
    ...assignment,
    status: deriveAssignmentStatus(assignment),
    attachments: fileMap.get(assignment.id) || []
  }));
}

async function getAssignmentDetail(assignmentId, classId) {
  if (useFakeStore()) {
    const { assignments, assignmentFiles } = db.__data;
    const assignment = assignments.find((a) => a.id === assignmentId && a.class_id === classId);
    if (!assignment) return null;
    return {
      ...assignment,
      status: deriveAssignmentStatus(assignment),
      attachments: assignmentFiles.filter((f) => f.assignment_id === assignment.id)
    };
  }

  const assignment = await dbGet(
    `SELECT id, class_id, title, description, subject, due_date, status, submitted_at, created_at, updated_at
     FROM assignments WHERE id = ? AND class_id = ?`,
    [assignmentId, classId]
  );
  if (!assignment) return null;
  const attachments = await dbAll(
    `SELECT id, assignment_id, file_name, stored_name, mime_type, file_size FROM assignment_files WHERE assignment_id = ?`,
    [assignment.id]
  );
  return { ...assignment, status: deriveAssignmentStatus(assignment), attachments };
}

async function getAssignmentFileForStudent(assignmentId, classId, fileId) {
  if (useFakeStore()) {
    const assignment = db.__data.assignments.find((a) => a.id === assignmentId && a.class_id === classId);
    if (!assignment) return null;
    const file = db.__data.assignmentFiles.find((f) => f.id === fileId && f.assignment_id === assignmentId);
    return file ? { assignment: { ...assignment }, file } : null;
  }
  const assignment = await dbGet(
    `SELECT id, class_id, title FROM assignments WHERE id = ? AND class_id = ?`,
    [assignmentId, classId]
  );
  if (!assignment) return null;
  const file = await dbGet(
    `SELECT id, assignment_id, file_name, stored_name, mime_type, file_size FROM assignment_files WHERE id = ? AND assignment_id = ?`,
    [fileId, assignmentId]
  );
  if (!file) return null;
  return { assignment, file };
}

async function getNotifications(studentId, limit = 10) {
  if (useFakeStore()) {
    const { notifications } = db.__data;
    return notifications
      .filter((n) => n.student_id === studentId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  return dbAll("SELECT id, type, message, is_read, created_at FROM notifications WHERE student_id = ? ORDER BY created_at DESC LIMIT ?", [
    studentId,
    limit
  ]);
}

async function addNotification(studentId, type, message) {
  return dbRun("INSERT INTO notifications (student_id, type, message) VALUES (?,?,?)", [studentId, type, message]);
}

function buildCsv(grades, student) {
  const header = "Fach;Note;Datum;Gewichtung;Kommentar";
  const rows = grades.map((g) => {
    const comment = (g.teacher_comment || "").replace(/[\n\r]+/g, " ");
    return `${g.subject};${g.grade_value};${g.grade_date};${g.weight};${comment}`;
  });
  return [
    `Schüler;${student.name}`,
    `Klasse;${student.className}`,
    header,
    ...rows
  ].join("\n");
}

function escapePdfText(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

async function buildPdfBuffer(grades, student, overallAverage, subjectAverages) {
  const infoLines = [];
  infoLines.push("Notenübersicht");
  infoLines.push(`Schüler: ${student.name}`);
  infoLines.push(`Klasse: ${student.className || ''}`);
  infoLines.push(`Exportiert: ${new Date().toLocaleString("de-DE")}`);
  infoLines.push("");
  if (overallAverage !== null && overallAverage !== undefined) {
    infoLines.push(`Gesamtschnitt: ${overallAverage.toFixed(2)}`);
  }
  subjectAverages
    .filter((s) => s.average !== null && s.average !== undefined)
    .forEach((s) => infoLines.push(`${s.subject}: ${s.average.toFixed(2)}`));

  infoLines.push("");
  grades.forEach((g) => {
    infoLines.push(`${g.subject}: ${g.grade_value} (${g.weight || 1}x) – ${g.grade_date}`);
    if (g.teacher_comment) infoLines.push(`Kommentar: ${g.teacher_comment}`);
  });

  const textLines = infoLines.map(escapePdfText);
  const textStreamParts = [
    "BT",
    "/F1 12 Tf",
    "14 TL",
    "50 780 Td",
    ...(textLines.flatMap((line, idx) => (idx === 0 ? [`(${line}) Tj`] : ["T*", `(${line}) Tj`]))),
    "ET"
  ];
  const textStream = textStreamParts.join("\n");

  let pdf = "%PDF-1.4\n";
  const objects = [];
  function addObject(id, body) {
    const offset = Buffer.byteLength(pdf, "utf8");
    objects.push({ offset });
    pdf += `${id} 0 obj${body.endsWith("\n") ? body : body + "\n"}endobj\n`;
  }

  addObject(1, `<< /Type /Catalog /Pages 2 0 R >>\n`);
  addObject(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n`);
  addObject(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\n`
  );
  addObject(4, `<< /Length ${Buffer.byteLength(textStream, "utf8")} >>\nstream\n${textStream}\nendstream\n`);
  addObject(5, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n`);

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += "xref\n";
  pdf += `0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  objects.forEach((obj) => {
    pdf += `${String(obj.offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

module.exports = {
  getStudentProfileByEmail,
  listSubjects,
  getStudentGrades,
  calculateSubjectAverages,
  getClassAverages,
  analyzeTrend,
  getNotifications,
  addNotification,
  getAssignmentsForClass,
  getAssignmentDetail,
  getAssignmentFileForStudent,
  buildCsv,
  buildPdfBuffer
};
