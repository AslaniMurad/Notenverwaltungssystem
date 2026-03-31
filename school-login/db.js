// db.js
const crypto = require("crypto");
const { Pool } = require("pg");
const { getDefaultSchoolYearWindow } = require("./utils/schoolYear");

// --- Password-Hashing via scrypt (ohne externe Lib)
// Wir speichern die Parameter im Hash, damit verify immer passt.
// Kosten so gewählt, dass sie auf allen Rechnern stabil laufen.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 1 << 14;        // 16384 (etwas niedriger als 32768, dafür stabil)
  const r = 8;
  const p = 1;
  const keylen = 64;

  const derivedKey = crypto.scryptSync(password, salt, keylen, {
    N, r, p,
    // Begrenze RAM-Verbrauch, um "memory limit exceeded" zu vermeiden
    maxmem: 128 * 1024 * 1024 // 128 MB
  });

  // Format: scrypt$N$r$p$saltB64$hashB64
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

function verifyPassword(stored, password) {
  try {
    const [alg, Ns, rs, ps, saltB64, hashB64] = String(stored).split("$");
    if (alg !== "scrypt") return false;
    const N = parseInt(Ns, 10);
    const r = parseInt(rs, 10);
    const p = parseInt(ps, 10);
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");

    const derived = crypto.scryptSync(password, salt, expected.length, {
      N, r, p,
      maxmem: 128 * 1024 * 1024
    });

    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

const useFakeDb = process.env.USE_FAKE_DB === "true";
const seedAdminEnabled = process.env.SEED_ADMIN === "true";
const seedDemoEnabled = process.env.SEED_DEMO === "true";

function createFakeDb() {
  const users = [];
  const schoolYears = [];
  const classes = [];
  const students = [];
  const gradeTemplates = [];
  const grades = [];
  const gradeMessages = [];
  const specialAssessments = [];
  const notifications = [];
  const auditLogs = [];
  const participationMarks = [];
  const teacherStudentExclusions = [];
  const subjects = [];
  const teachingAssignments = [];
  const archives = [];
  const rolloverLogs = [];
  const teacherGradingProfiles = [];
  const teacherGradingProfileItems = [];
  let userId = 1;
  let schoolYearId = 1;
  let classId = 1;
  let studentId = 1;
  let gradeTemplateId = 1;
  let gradeId = 1;
  let gradeMessageId = 1;
  let specialAssessmentId = 1;
  let notificationId = 1;
  let auditLogId = 1;
  let participationMarkId = 1;
  let teacherStudentExclusionId = 1;
  let subjectId = 1;
  let teachingAssignmentId = 1;
  let archiveId = 1;
  let rolloverLogId = 1;
  let gradingProfileId = 1;
  let gradingProfileItemId = 1;

  function ensureActiveSchoolYear() {
    const active = schoolYears.find((entry) => Boolean(entry.is_active));
    if (active) return active;

    const defaultWindow = getDefaultSchoolYearWindow();
    const newYear = {
      id: schoolYearId++,
      name: defaultWindow.name,
      start_date: defaultWindow.startDate,
      end_date: defaultWindow.endDate,
      is_active: true
    };
    schoolYears.push(newYear);
    return newYear;
  }

  function getAssignmentsForClassSubject(targetClassId, targetSubjectId) {
    return teachingAssignments.filter(
      (entry) =>
        entry.class_id === Number(targetClassId) &&
        entry.subject_id === Number(targetSubjectId)
    );
  }

  function getTeacherEmailsForClassSubject(targetClassId, targetSubjectId) {
    return getAssignmentsForClassSubject(targetClassId, targetSubjectId)
      .map((entry) => users.find((user) => user.id === entry.teacher_id)?.email)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  function getSubjectNameById(targetSubjectId) {
    const subjectRow = subjects.find((entry) => entry.id === Number(targetSubjectId));
    return subjectRow ? String(subjectRow.name || "").trim() : "";
  }

  function getClassSubjectLabel(targetClassId, targetSubjectId) {
    const subjectName = getSubjectNameById(targetSubjectId);
    if (subjectName) return subjectName;
    const classRow = classes.find((entry) => entry.id === Number(targetClassId));
    return String(classRow?.subject || "").trim();
  }

  function normalizeOptionalId(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  const activeSchoolYear = ensureActiveSchoolYear();

  const db = {
    serialize(fn) {
      fn();
    },
    run(sql, params = [], cb) {
      let err = null;
      let lastID;

      if (/INSERT INTO users/i.test(sql)) {
        const [email, password_hash, role, status, must_change_password] = params;
        const resolvedRole =
          role || (/\'teacher\'/i.test(sql) ? "teacher" : /\'student\'/i.test(sql) ? "student" : /\'admin\'/i.test(sql) ? "admin" : undefined);
        const resolvedStatus = status || (/\'active\'/i.test(sql) ? "active" : undefined) || "active";
        if (users.some((u) => u.email === email)) {
          err = new Error("UNIQUE constraint failed: users.email");
        } else {
          const newUser = {
            id: userId++,
            email,
            password_hash,
            role: resolvedRole,
            status: resolvedStatus,
            created_at: new Date().toISOString(),
            must_change_password: must_change_password ? 1 : 0
          };
          users.push(newUser);
          lastID = newUser.id;
        }
      } else if (/UPDATE users SET email = \?, role = \?, status = \? WHERE id = \?/i.test(sql)) {
        const [email, role, status, id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.email = email;
          user.role = role;
          user.status = status;
        }
      } else if (/UPDATE users SET password_hash = \?, must_change_password = \? WHERE id = \?/i.test(sql)) {
        const [password_hash, must_change_password, id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.password_hash = password_hash;
          user.must_change_password = must_change_password;
        }
      } else if (/UPDATE users SET status = 'deleted' WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.status = "deleted";
        }
      } else if (/UPDATE users SET must_change_password = \? WHERE id = \?/i.test(sql)) {
        const [must_change_password, id] = params;
        const user = users.find((u) => u.id === Number(id));
        if (user) {
          user.must_change_password = must_change_password;
        }
      } else if (/INSERT INTO school_years/i.test(sql)) {
        const [name, start_date, end_date, is_active] = params;
        const duplicate = schoolYears.find((entry) => entry.name === String(name));
        if (duplicate) {
          err = new Error("UNIQUE constraint failed: school_years.name");
        } else {
          if (is_active) {
            schoolYears.forEach((entry) => {
              entry.is_active = false;
            });
          }
          const schoolYear = {
            id: schoolYearId++,
            name: String(name),
            start_date: start_date || null,
            end_date: end_date || null,
            is_active: Boolean(is_active)
          };
          schoolYears.push(schoolYear);
          lastID = schoolYear.id;
        }
      } else if (/UPDATE school_years SET is_active = \? WHERE id = \?/i.test(sql)) {
        const [is_active, id] = params;
        if (is_active) {
          schoolYears.forEach((entry) => {
            entry.is_active = false;
          });
        }
        const schoolYear = schoolYears.find((entry) => entry.id === Number(id));
        if (schoolYear) {
          schoolYear.is_active = Boolean(is_active);
        }
      } else if (/DELETE FROM school_years WHERE id = \?/i.test(sql)) {
        const [id] = params;
        for (let i = schoolYears.length - 1; i >= 0; i -= 1) {
          if (schoolYears[i].id === Number(id)) schoolYears.splice(i, 1);
        }
      } else if (/INSERT INTO archives/i.test(sql)) {
        const [school_year_id, archive_type, entity_count] = params;
        const archiveEntry = {
          id: archiveId++,
          school_year_id: Number(school_year_id),
          archive_type: String(archive_type),
          entity_count: Number(entity_count),
          created_at: new Date().toISOString()
        };
        archives.push(archiveEntry);
        lastID = archiveEntry.id;
      } else if (/DELETE FROM archives WHERE id = \?/i.test(sql)) {
        const [id] = params;
        for (let i = archives.length - 1; i >= 0; i -= 1) {
          if (archives[i].id === Number(id)) archives.splice(i, 1);
        }
      } else if (/INSERT INTO rollover_logs/i.test(sql)) {
        const [executed_by, old_school_year, new_school_year, status, backup_path] = params;
        const logEntry = {
          id: rolloverLogId++,
          executed_by: Number(executed_by),
          old_school_year: String(old_school_year),
          new_school_year: String(new_school_year),
          status: String(status),
          backup_path: backup_path || null,
          executed_at: new Date().toISOString()
        };
        rolloverLogs.push(logEntry);
        lastID = logEntry.id;
      } else if (/INSERT INTO subjects/i.test(sql)) {
        const [name] = params;
        const existing = subjects.find((entry) => String(entry.name).toLowerCase() === String(name).toLowerCase());
        if (existing) {
          err = new Error("UNIQUE constraint failed: subjects.name");
        } else {
          const newSubject = {
            id: subjectId++,
            name: String(name || "").trim()
          };
          subjects.push(newSubject);
          lastID = newSubject.id;
        }
      } else if (/UPDATE classes SET name = \?, subject = \?, subject_id = \?, head_teacher_id = \? WHERE id = \?/i.test(sql)) {
        const [name, subject, subjId, headTeacherId, id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          classRow.name = name;
          classRow.subject = subject || null;
          classRow.subject_id = normalizeOptionalId(subjId);
          classRow.head_teacher_id = normalizeOptionalId(headTeacherId);
        }
      } else if (/UPDATE classes SET name = \?, subject = \?, subject_id = \? WHERE id = \?/i.test(sql)) {
        const [name, subject, subjId, id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          classRow.name = name;
          classRow.subject = subject || null;
          classRow.subject_id = normalizeOptionalId(subjId);
        }
      } else if (/UPDATE classes SET name = \?, subject = \?, subject_id = \?, teacher_id = \? WHERE id = \?/i.test(sql)) {
        const [name, subject, subjId, teacher_id, id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          classRow.name = name;
          classRow.subject = subject || null;
          classRow.subject_id = normalizeOptionalId(subjId);
          classRow.teacher_id = Number(teacher_id);
        }
      } else if (/UPDATE classes SET name = \?, subject = \?, teacher_id = \? WHERE id = \?/i.test(sql)) {
        const [name, subject, teacher_id, id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          classRow.name = name;
          classRow.subject = subject;
          classRow.teacher_id = Number(teacher_id);
        }
      } else if (/INSERT INTO classes/i.test(sql)) {
        const [name, subject, thirdParam, fourthParam, fifthParam] = params;
        const isSchoolYearInsert = /school_year_id/i.test(sql);
        const hasTeacherId = params.length >= 4 && !isSchoolYearInsert;
        const hasSubjectId = params.length >= 3;
        const teacher_id = hasTeacherId ? Number(fourthParam) : null;
        const resolvedSchoolYearId = isSchoolYearInsert
          ? Number(fourthParam)
          : Number(activeSchoolYear.id);
        const head_teacher_id = isSchoolYearInsert && params.length >= 5
          ? normalizeOptionalId(fifthParam)
          : null;
        let resolvedSubjectId = hasSubjectId ? normalizeOptionalId(thirdParam) : null;
        if (!resolvedSubjectId && subject) {
          const existingSubject = subjects.find(
            (entry) => String(entry.name).toLowerCase() === String(subject).toLowerCase()
          );
          if (existingSubject) {
            resolvedSubjectId = existingSubject.id;
          } else {
            const newSubject = { id: subjectId++, name: String(subject) };
            subjects.push(newSubject);
            resolvedSubjectId = newSubject.id;
          }
        }
        const newClass = {
          id: classId++,
          name,
          subject: subject || null,
          subject_id: resolvedSubjectId == null ? null : Number(resolvedSubjectId),
          school_year_id: Number.isFinite(resolvedSchoolYearId) ? resolvedSchoolYearId : Number(activeSchoolYear.id),
          head_teacher_id,
          teacher_id: Number.isFinite(teacher_id) ? teacher_id : null,
          created_at: new Date().toISOString()
        };
        classes.push(newClass);
        lastID = newClass.id;
        if (Number.isFinite(teacher_id) && newClass.subject_id != null) {
          const existsAssignment = teachingAssignments.some(
            (entry) =>
              entry.teacher_id === teacher_id &&
              entry.class_id === newClass.id &&
              entry.subject_id === Number(newClass.subject_id)
          );
          if (!existsAssignment) {
            teachingAssignments.push({
              id: teachingAssignmentId++,
              teacher_id,
              class_id: newClass.id,
              subject_id: Number(newClass.subject_id),
              school_year_id: newClass.school_year_id,
              created_at: new Date().toISOString()
            });
          }
        }
      } else if (/INSERT INTO (teaching_assignments|class_subject_teacher)/i.test(sql)) {
        const usesNewOrder = /INSERT INTO class_subject_teacher/i.test(sql);
        const [firstId, secondId, thirdId, fourthId] = params;
        const resolvedClassId = usesNewOrder ? firstId : secondId;
        const subjId = usesNewOrder ? secondId : thirdId;
        const teacher_id = usesNewOrder ? thirdId : firstId;
        const school_year_id = params.length >= 4
          ? Number(fourthId)
          : Number(classes.find((entry) => entry.id === Number(resolvedClassId))?.school_year_id || activeSchoolYear.id);
        const duplicate = teachingAssignments.find(
          (entry) =>
            entry.teacher_id === Number(teacher_id) &&
            entry.class_id === Number(resolvedClassId) &&
            entry.subject_id === Number(subjId)
        );
        if (duplicate) {
          err = new Error("UNIQUE constraint failed: class_subject_teacher.class_id, class_subject_teacher.subject_id, class_subject_teacher.teacher_id");
        } else {
          const newAssignment = {
            id: teachingAssignmentId++,
            teacher_id: Number(teacher_id),
            class_id: Number(resolvedClassId),
            subject_id: Number(subjId),
            school_year_id,
            created_at: new Date().toISOString()
          };
          teachingAssignments.push(newAssignment);
          lastID = newAssignment.id;
        }
      } else if (/DELETE FROM (teaching_assignments|class_subject_teacher) WHERE id = \?/i.test(sql)) {
        const [id] = params;
        for (let i = teachingAssignments.length - 1; i >= 0; i -= 1) {
          if (teachingAssignments[i].id === Number(id)) teachingAssignments.splice(i, 1);
        }
      } else if (/INSERT INTO teacher_student_exclusions/i.test(sql)) {
        const [teacher_id, class_id, subject_id, student_id, school_year_id] = params;
        const duplicate = teacherStudentExclusions.find(
          (entry) =>
            entry.teacher_id === Number(teacher_id) &&
            entry.class_id === Number(class_id) &&
            entry.subject_id === Number(subject_id) &&
            entry.student_id === Number(student_id)
        );
        if (!duplicate) {
          const newExclusion = {
            id: teacherStudentExclusionId++,
            teacher_id: Number(teacher_id),
            class_id: Number(class_id),
            subject_id: Number(subject_id),
            student_id: Number(student_id),
            school_year_id: Number(school_year_id),
            excluded_at: new Date().toISOString()
          };
          teacherStudentExclusions.push(newExclusion);
          lastID = newExclusion.id;
        }
      } else if (/DELETE FROM teacher_student_exclusions WHERE teacher_id = \? AND class_id = \? AND subject_id = \? AND student_id = \?/i.test(sql)) {
        const [teacher_id, class_id, subject_id, student_id] = params;
        for (let i = teacherStudentExclusions.length - 1; i >= 0; i -= 1) {
          const entry = teacherStudentExclusions[i];
          if (
            entry.teacher_id === Number(teacher_id) &&
            entry.class_id === Number(class_id) &&
            entry.subject_id === Number(subject_id) &&
            entry.student_id === Number(student_id)
          ) {
            teacherStudentExclusions.splice(i, 1);
          }
        }
      } else if (/DELETE FROM grade_notifications WHERE student_id IN \(SELECT id FROM students WHERE class_id = \?\)/i.test(sql)) {
        const [classIdParam] = params;
        const studentIds = new Set(
          students
            .filter((entry) => entry.class_id === Number(classIdParam))
            .map((entry) => Number(entry.id))
        );
        for (let i = notifications.length - 1; i >= 0; i -= 1) {
          if (studentIds.has(Number(notifications[i].student_id))) notifications.splice(i, 1);
        }
      } else if (/DELETE FROM grade_notifications WHERE student_id = \?/i.test(sql)) {
        const [studentIdParam] = params;
        for (let i = notifications.length - 1; i >= 0; i -= 1) {
          if (notifications[i].student_id === Number(studentIdParam)) notifications.splice(i, 1);
        }
      } else if (/DELETE FROM students WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [idParam, classIdParam] = params;
        for (let i = students.length - 1; i >= 0; i -= 1) {
          if (students[i].id === Number(idParam) && students[i].class_id === Number(classIdParam)) {
            students.splice(i, 1);
          }
        }
        for (let i = notifications.length - 1; i >= 0; i -= 1) {
          if (notifications[i].student_id === Number(idParam)) notifications.splice(i, 1);
        }
        for (let i = grades.length - 1; i >= 0; i -= 1) {
          if (grades[i].student_id === Number(idParam)) grades.splice(i, 1);
        }
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (specialAssessments[i].student_id === Number(idParam)) specialAssessments.splice(i, 1);
        }
        for (let i = participationMarks.length - 1; i >= 0; i -= 1) {
          if (
            participationMarks[i].student_id === Number(idParam) &&
            participationMarks[i].class_id === Number(classIdParam)
          ) {
            participationMarks.splice(i, 1);
          }
        }
        for (let i = teacherStudentExclusions.length - 1; i >= 0; i -= 1) {
          if (
            teacherStudentExclusions[i].student_id === Number(idParam) &&
            teacherStudentExclusions[i].class_id === Number(classIdParam)
          ) {
            teacherStudentExclusions.splice(i, 1);
          }
        }
      } else if (/DELETE FROM students WHERE class_id = \?/i.test(sql)) {
        const [classIdParam] = params;
        const studentIds = new Set(
          students
            .filter((entry) => entry.class_id === Number(classIdParam))
            .map((entry) => Number(entry.id))
        );
        for (let i = students.length - 1; i >= 0; i -= 1) {
          if (students[i].class_id === Number(classIdParam)) students.splice(i, 1);
        }
        for (let i = notifications.length - 1; i >= 0; i -= 1) {
          if (studentIds.has(Number(notifications[i].student_id))) notifications.splice(i, 1);
        }
        for (let i = grades.length - 1; i >= 0; i -= 1) {
          if (studentIds.has(Number(grades[i].student_id)) || grades[i].class_id === Number(classIdParam)) {
            grades.splice(i, 1);
          }
        }
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (specialAssessments[i].class_id === Number(classIdParam)) specialAssessments.splice(i, 1);
        }
        for (let i = participationMarks.length - 1; i >= 0; i -= 1) {
          if (participationMarks[i].class_id === Number(classIdParam)) {
            participationMarks.splice(i, 1);
          }
        }
        for (let i = teacherStudentExclusions.length - 1; i >= 0; i -= 1) {
          if (teacherStudentExclusions[i].class_id === Number(classIdParam)) {
            teacherStudentExclusions.splice(i, 1);
          }
        }
      } else if (/DELETE FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        for (let i = classes.length - 1; i >= 0; i -= 1) {
          if (classes[i].id === Number(id)) classes.splice(i, 1);
        }
        for (let i = teachingAssignments.length - 1; i >= 0; i -= 1) {
          if (teachingAssignments[i].class_id === Number(id)) teachingAssignments.splice(i, 1);
        }
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (specialAssessments[i].class_id === Number(id)) specialAssessments.splice(i, 1);
        }
        for (let i = teacherStudentExclusions.length - 1; i >= 0; i -= 1) {
          if (teacherStudentExclusions[i].class_id === Number(id)) {
            teacherStudentExclusions.splice(i, 1);
          }
        }
        for (let i = participationMarks.length - 1; i >= 0; i -= 1) {
          if (participationMarks[i].class_id === Number(id)) {
            participationMarks.splice(i, 1);
          }
        }
      } else if (/INSERT INTO students/i.test(sql)) {
        const [name, email, class_id] = params;
        if (students.some((s) => s.email === email && s.class_id === Number(class_id))) {
          err = new Error("UNIQUE constraint failed: students.email, students.class_id");
        } else {
          const newStudent = {
            id: studentId++,
            name,
            email,
            class_id: Number(class_id),
            school_year: params[3] || "2024/25",
            created_at: new Date().toISOString()
          };
          students.push(newStudent);
          lastID = newStudent.id;
        }
      } else if (/INSERT INTO teacher_grading_profiles/i.test(sql)) {
        const teacher_id = params[0];
        const name = params[1];
        const weight_mode = params[2] || "points";
        let scoring_mode = "points_or_grade";
        let absence_mode = "include_zero";
        let grade1_min_percent = 88.5;
        let grade2_min_percent = 75;
        let grade3_min_percent = 62.5;
        let grade4_min_percent = 50;
        let ma_enabled = false;
        let ma_weight = 5;
        let ma_grade_plus = 1.5;
        let ma_grade_plus_tilde = 2.5;
        let ma_grade_neutral = 3;
        let ma_grade_minus_tilde = 3.5;
        let ma_grade_minus = 4.5;
        let is_active = params[3];

        if (params.length >= 17) {
          scoring_mode = params[3] || "points_or_grade";
          absence_mode = params[4] || "include_zero";
          grade1_min_percent = Number(params[5]);
          grade2_min_percent = Number(params[6]);
          grade3_min_percent = Number(params[7]);
          grade4_min_percent = Number(params[8]);
          ma_enabled = Boolean(params[9]);
          ma_weight = Number(params[10]);
          ma_grade_plus = Number(params[11]);
          ma_grade_plus_tilde = Number(params[12]);
          ma_grade_neutral = Number(params[13]);
          ma_grade_minus_tilde = Number(params[14]);
          ma_grade_minus = Number(params[15]);
          is_active = params[16];
        } else if (params.length >= 16) {
          scoring_mode = params[3] || "points_or_grade";
          grade1_min_percent = Number(params[4]);
          grade2_min_percent = Number(params[5]);
          grade3_min_percent = Number(params[6]);
          grade4_min_percent = Number(params[7]);
          ma_enabled = Boolean(params[8]);
          ma_weight = Number(params[9]);
          ma_grade_plus = Number(params[10]);
          ma_grade_plus_tilde = Number(params[11]);
          ma_grade_neutral = Number(params[12]);
          ma_grade_minus_tilde = Number(params[13]);
          ma_grade_minus = Number(params[14]);
          is_active = params[15];
        } else if (params.length >= 9) {
          scoring_mode = params[3] || "points_or_grade";
          grade1_min_percent = Number(params[4]);
          grade2_min_percent = Number(params[5]);
          grade3_min_percent = Number(params[6]);
          grade4_min_percent = Number(params[7]);
          is_active = params[8];
        }

        if (
          teacherGradingProfiles.some(
            (profile) =>
              profile.teacher_id === Number(teacher_id) &&
              String(profile.name).toLowerCase() === String(name).toLowerCase()
          )
        ) {
          err = new Error("UNIQUE constraint failed: teacher_grading_profiles.teacher_id, teacher_grading_profiles.name");
        } else {
          const profile = {
            id: gradingProfileId++,
            teacher_id: Number(teacher_id),
            name,
            weight_mode: String(weight_mode || "points"),
            scoring_mode: String(scoring_mode || "points_or_grade"),
            absence_mode: String(absence_mode || "include_zero"),
            grade1_min_percent,
            grade2_min_percent,
            grade3_min_percent,
            grade4_min_percent,
            ma_enabled: Boolean(ma_enabled),
            ma_weight: Number.isFinite(ma_weight) ? ma_weight : 5,
            ma_grade_plus: Number.isFinite(ma_grade_plus) ? ma_grade_plus : 1.5,
            ma_grade_plus_tilde: Number.isFinite(ma_grade_plus_tilde) ? ma_grade_plus_tilde : 2.5,
            ma_grade_neutral: Number.isFinite(ma_grade_neutral) ? ma_grade_neutral : 3,
            ma_grade_minus_tilde: Number.isFinite(ma_grade_minus_tilde) ? ma_grade_minus_tilde : 3.5,
            ma_grade_minus: Number.isFinite(ma_grade_minus) ? ma_grade_minus : 4.5,
            is_active: Boolean(is_active),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          teacherGradingProfiles.push(profile);
          lastID = profile.id;
        }
      } else if (/UPDATE teacher_grading_profiles\s+SET name = \?, weight_mode = \?, scoring_mode = \?, absence_mode = \?, grade1_min_percent = \?, grade2_min_percent = \?, grade3_min_percent = \?, grade4_min_percent = \?, ma_enabled = \?, ma_weight = \?, ma_grade_plus = \?, ma_grade_plus_tilde = \?, ma_grade_neutral = \?, ma_grade_minus_tilde = \?, ma_grade_minus = \?, updated_at = current_timestamp\s+WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [
          name,
          weight_mode,
          scoring_mode,
          absence_mode,
          grade1_min_percent,
          grade2_min_percent,
          grade3_min_percent,
          grade4_min_percent,
          ma_enabled,
          ma_weight,
          ma_grade_plus,
          ma_grade_plus_tilde,
          ma_grade_neutral,
          ma_grade_minus_tilde,
          ma_grade_minus,
          id,
          teacher_id
        ] = params;
        const profile = teacherGradingProfiles.find(
          (entry) => entry.id === Number(id) && entry.teacher_id === Number(teacher_id)
        );
        if (profile) {
          profile.name = String(name);
          profile.weight_mode = String(weight_mode || "points");
          profile.scoring_mode = String(scoring_mode || "points_or_grade");
          profile.absence_mode = String(absence_mode || "include_zero");
          profile.grade1_min_percent = Number(grade1_min_percent);
          profile.grade2_min_percent = Number(grade2_min_percent);
          profile.grade3_min_percent = Number(grade3_min_percent);
          profile.grade4_min_percent = Number(grade4_min_percent);
          profile.ma_enabled = Boolean(ma_enabled);
          profile.ma_weight = Number(ma_weight);
          profile.ma_grade_plus = Number(ma_grade_plus);
          profile.ma_grade_plus_tilde = Number(ma_grade_plus_tilde);
          profile.ma_grade_neutral = Number(ma_grade_neutral);
          profile.ma_grade_minus_tilde = Number(ma_grade_minus_tilde);
          profile.ma_grade_minus = Number(ma_grade_minus);
          profile.updated_at = new Date().toISOString();
        }
      } else if (/UPDATE teacher_grading_profiles\s+SET name = \?, weight_mode = \?, scoring_mode = \?, grade1_min_percent = \?, grade2_min_percent = \?, grade3_min_percent = \?, grade4_min_percent = \?, updated_at = current_timestamp\s+WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [name, weight_mode, scoring_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, id, teacher_id] = params;
        const profile = teacherGradingProfiles.find(
          (entry) => entry.id === Number(id) && entry.teacher_id === Number(teacher_id)
        );
        if (profile) {
          profile.name = String(name);
          profile.weight_mode = String(weight_mode || "points");
          profile.scoring_mode = String(scoring_mode || "points_or_grade");
          profile.grade1_min_percent = Number(grade1_min_percent);
          profile.grade2_min_percent = Number(grade2_min_percent);
          profile.grade3_min_percent = Number(grade3_min_percent);
          profile.grade4_min_percent = Number(grade4_min_percent);
          profile.updated_at = new Date().toISOString();
        }
      } else if (/UPDATE teacher_grading_profiles\s+SET name = \?, weight_mode = \?, updated_at = current_timestamp\s+WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [name, weight_mode, id, teacher_id] = params;
        const profile = teacherGradingProfiles.find(
          (entry) => entry.id === Number(id) && entry.teacher_id === Number(teacher_id)
        );
        if (profile) {
          profile.name = name;
          profile.weight_mode = "points";
          profile.updated_at = new Date().toISOString();
        }
      } else if (/UPDATE teacher_grading_profiles SET is_active = \? WHERE teacher_id = \?/i.test(sql)) {
        const [is_active, teacher_id] = params;
        teacherGradingProfiles.forEach((profile) => {
          if (profile.teacher_id === Number(teacher_id)) {
            profile.is_active = Boolean(is_active);
            profile.updated_at = new Date().toISOString();
          }
        });
      } else if (/UPDATE teacher_grading_profiles SET is_active = \?, updated_at = current_timestamp WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [is_active, id, teacher_id] = params;
        const profile = teacherGradingProfiles.find(
          (entry) => entry.id === Number(id) && entry.teacher_id === Number(teacher_id)
        );
        if (profile) {
          profile.is_active = Boolean(is_active);
          profile.updated_at = new Date().toISOString();
        }
      } else if (/DELETE FROM teacher_grading_profiles WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        for (let i = teacherGradingProfiles.length - 1; i >= 0; i -= 1) {
          const profile = teacherGradingProfiles[i];
          if (profile.id === Number(id) && profile.teacher_id === Number(teacher_id)) {
            teacherGradingProfiles.splice(i, 1);
          }
        }
        for (let i = teacherGradingProfileItems.length - 1; i >= 0; i -= 1) {
          if (teacherGradingProfileItems[i].profile_id === Number(id)) {
            teacherGradingProfileItems.splice(i, 1);
          }
        }
      } else if (/DELETE FROM teacher_grading_profile_items WHERE profile_id = \?/i.test(sql)) {
        const [profile_id] = params;
        for (let i = teacherGradingProfileItems.length - 1; i >= 0; i -= 1) {
          if (teacherGradingProfileItems[i].profile_id === Number(profile_id)) {
            teacherGradingProfileItems.splice(i, 1);
          }
        }
      } else if (/INSERT INTO teacher_grading_profile_items/i.test(sql)) {
        const [profile_id, category, weight] = params;
        const existing = teacherGradingProfileItems.find(
          (entry) =>
            entry.profile_id === Number(profile_id) &&
            String(entry.category).toLowerCase() === String(category).toLowerCase()
        );
        if (existing) {
          existing.weight = Number(weight);
          existing.updated_at = new Date().toISOString();
          lastID = existing.id;
        } else {
          const item = {
            id: gradingProfileItemId++,
            profile_id: Number(profile_id),
            category,
            weight: Number(weight),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          };
          teacherGradingProfileItems.push(item);
          lastID = item.id;
        }
      } else if (/INSERT INTO grade_templates/i.test(sql)) {
        const hasSubjectId = /\(\s*class_id\s*,\s*subject_id\s*,/i.test(sql);
        const class_id = params[0];
        const subject_id = hasSubjectId ? normalizeOptionalId(params[1]) : null;
        const baseIndex = hasSubjectId ? 1 : 0;
        const name = params[baseIndex + 1];
        const category = params[baseIndex + 2];
        const weight = params[baseIndex + 3];
        const remaining = params.length - (baseIndex + 4);
        const hasMaxPoints = remaining >= 4;
        const hasWeightMode = remaining >= 3;
        const weight_mode = hasWeightMode ? params[baseIndex + 4] : "points";
        const max_points = hasMaxPoints ? params[baseIndex + 5] : null;
        const date = hasMaxPoints
          ? params[baseIndex + 6]
          : hasWeightMode
          ? params[baseIndex + 5]
          : params[baseIndex + 4];
        const description = hasMaxPoints
          ? params[baseIndex + 7]
          : hasWeightMode
          ? params[baseIndex + 6]
          : params[baseIndex + 5];
        const template = {
          id: gradeTemplateId++,
          class_id: Number(class_id),
          subject_id,
          name,
          category,
          weight: Number(weight),
          weight_mode: String(weight_mode || "points"),
          max_points: max_points != null && max_points !== "" ? Number(max_points) : null,
          date: date || null,
          description: description || null,
          created_at: new Date().toISOString(),
          archived_at: null
        };
        gradeTemplates.push(template);
        lastID = template.id;
      } else if (/UPDATE grade_templates SET name = \?, category = \?, weight = \?, max_points = \?, date = \?, description = \? WHERE id = \? AND class_id = \?( AND subject_id = \?)?/i.test(sql)) {
        const [name, category, weight, max_points, date, description, id, class_id, subject_id] = params;
        const template = gradeTemplates.find(
          (entry) =>
            entry.id === Number(id) &&
            entry.class_id === Number(class_id) &&
            (subject_id == null || entry.subject_id === normalizeOptionalId(subject_id))
        );
        if (template) {
          template.name = String(name);
          template.category = String(category);
          template.weight = Number(weight);
          template.max_points =
            max_points != null && max_points !== "" ? Number(max_points) : null;
          template.date = date || null;
          template.description = description || null;
        }
      } else if (/UPDATE grade_templates\s+SET archived_at = \?\s+WHERE class_id = \? AND archived_at IS NULL AND COALESCE\(date, created_at\) < \?/i.test(sql)) {
        const [archivedAt, classId, cutoff] = params;
        const cutoffTime = new Date(cutoff).getTime();
        gradeTemplates.forEach((template) => {
          const effectiveTime = new Date(template.date || template.created_at).getTime();
          if (
            template.class_id === Number(classId) &&
            !template.archived_at &&
            Number.isFinite(effectiveTime) &&
            effectiveTime < cutoffTime
          ) {
            template.archived_at = archivedAt;
          }
        });
      } else if (/UPDATE grade_templates\s+SET archived_at = \?\s+WHERE archived_at IS NULL AND COALESCE\(date, created_at\) < \?/i.test(sql)) {
        const [archivedAt, cutoff] = params;
        const cutoffTime = new Date(cutoff).getTime();
        gradeTemplates.forEach((template) => {
          const effectiveTime = new Date(template.date || template.created_at).getTime();
          if (!template.archived_at && Number.isFinite(effectiveTime) && effectiveTime < cutoffTime) {
            template.archived_at = archivedAt;
          }
        });
      } else if (/DELETE FROM grade_templates WHERE archived_at IS NOT NULL AND archived_at <= \?/i.test(sql)) {
        const [cutoff] = params;
        const cutoffTime = new Date(cutoff).getTime();
        const deletedTemplateIds = [];
        for (let i = gradeTemplates.length - 1; i >= 0; i -= 1) {
          const archivedTime = new Date(gradeTemplates[i].archived_at || "").getTime();
          if (Number.isFinite(archivedTime) && archivedTime <= cutoffTime) {
            deletedTemplateIds.push(gradeTemplates[i].id);
            gradeTemplates.splice(i, 1);
          }
        }
        if (deletedTemplateIds.length) {
          for (let i = grades.length - 1; i >= 0; i -= 1) {
            if (deletedTemplateIds.includes(grades[i].grade_template_id)) {
              grades.splice(i, 1);
            }
          }
        }
      } else if (/INSERT INTO grades/i.test(sql)) {
        const student_id = params[0];
        const class_id = params[1];
        const grade_template_id = params[2];
        const grade = params[3];
        const hasPoints = params.length >= 12;
        const points_achieved = hasPoints ? params[4] : null;
        const points_max = hasPoints ? params[5] : null;
        const note = hasPoints ? params[6] : params[4];
        const attachment_path = hasPoints ? params[7] : params[5];
        const attachment_original_name = hasPoints ? params[8] : params[6];
        const attachment_mime = hasPoints ? params[9] : params[7];
        const attachment_size = hasPoints ? params[10] : params[8];
        const external_link = hasPoints ? params[11] : params[9];
        const is_absent = hasPoints && params.length >= 13 ? params[12] : 0;
        const school_year_id = hasPoints && params.length >= 14
          ? Number(params[13])
          : Number(classes.find((entry) => entry.id === Number(class_id))?.school_year_id || activeSchoolYear.id);
        const duplicate = grades.find(
          (entry) =>
            entry.student_id === Number(student_id) &&
            entry.grade_template_id === Number(grade_template_id)
        );
        if (duplicate) {
          err = new Error("UNIQUE constraint failed: grades.student_id, grades.grade_template_id");
        } else {
          const newGrade = {
            id: gradeId++,
            student_id: Number(student_id),
            class_id: Number(class_id),
            grade_template_id: Number(grade_template_id),
            grade: Number(grade),
            points_achieved:
              points_achieved != null && points_achieved !== "" ? Number(points_achieved) : null,
            points_max: points_max != null && points_max !== "" ? Number(points_max) : null,
            note: note || null,
            attachment_path: attachment_path || null,
            attachment_original_name: attachment_original_name || null,
            attachment_mime: attachment_mime || null,
            attachment_size: attachment_size ? Number(attachment_size) : null,
            external_link: external_link || null,
            is_absent: Boolean(is_absent),
            school_year_id,
            created_at: new Date().toISOString()
          };
          grades.push(newGrade);
          lastID = newGrade.id;
        }
      } else if (/INSERT INTO special_assessments/i.test(sql)) {
        const hasSubjectId = /\(\s*student_id\s*,\s*class_id\s*,\s*subject_id\s*,/i.test(sql);
        const [student_id, class_id] = params;
        const subject_id = hasSubjectId ? normalizeOptionalId(params[2]) : null;
        const offset = hasSubjectId ? 1 : 0;
        const [type, name, description, weight, grade] = params.slice(2 + offset);
        const assessment = {
          id: specialAssessmentId++,
          student_id: Number(student_id),
          class_id: Number(class_id),
          subject_id,
          type,
          name,
          description: description || null,
          weight: Number(weight),
          grade: Number(grade),
          created_at: new Date().toISOString()
        };
        specialAssessments.push(assessment);
        lastID = assessment.id;
      } else if (/DELETE FROM special_assessments WHERE id = \? AND class_id = \?( AND subject_id = \?)?/i.test(sql)) {
        const [idParam, classIdParam, subjectIdParam] = params;
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (
            specialAssessments[i].id === Number(idParam) &&
            specialAssessments[i].class_id === Number(classIdParam) &&
            (subjectIdParam == null ||
              specialAssessments[i].subject_id === normalizeOptionalId(subjectIdParam))
          ) {
            specialAssessments.splice(i, 1);
          }
        }
      } else if (/INSERT INTO participation_marks/i.test(sql)) {
        const hasSubjectId = /\(\s*student_id\s*,\s*class_id\s*,\s*subject_id\s*,/i.test(sql);
        const [student_id, class_id] = params;
        const subject_id = hasSubjectId ? normalizeOptionalId(params[2]) : null;
        const offset = hasSubjectId ? 1 : 0;
        const [teacher_id, symbol, note] = params.slice(2 + offset);
        const mark = {
          id: participationMarkId++,
          student_id: Number(student_id),
          class_id: Number(class_id),
          subject_id,
          teacher_id: Number(teacher_id),
          symbol: String(symbol),
          note: note || null,
          created_at: new Date().toISOString()
        };
        participationMarks.push(mark);
        lastID = mark.id;
      } else if (/DELETE FROM participation_marks WHERE id = \? AND class_id = \?( AND subject_id = \?)? AND student_id = \?/i.test(sql)) {
        const [idParam, classIdParam, thirdParam, fourthParam] = params;
        const hasSubjectId = params.length >= 4;
        const subjectIdParam = hasSubjectId ? thirdParam : null;
        const studentIdParam = hasSubjectId ? fourthParam : thirdParam;
        for (let i = participationMarks.length - 1; i >= 0; i -= 1) {
          if (
            participationMarks[i].id === Number(idParam) &&
            participationMarks[i].class_id === Number(classIdParam) &&
            (subjectIdParam == null ||
              participationMarks[i].subject_id === normalizeOptionalId(subjectIdParam)) &&
            participationMarks[i].student_id === Number(studentIdParam)
          ) {
            participationMarks.splice(i, 1);
          }
        }
      } else if (/INSERT INTO grade_messages/i.test(sql)) {
        const [grade_id, student_id, student_message] = params;
        const message = {
          id: gradeMessageId++,
          grade_id: Number(grade_id),
          student_id: Number(student_id),
          student_message: String(student_message || ""),
          teacher_reply: null,
          teacher_reply_by_email: null,
          teacher_reply_seen_at: null,
          student_hidden_at: null,
          created_at: new Date().toISOString(),
          replied_at: null
        };
        gradeMessages.push(message);
        lastID = message.id;
      } else if (/UPDATE grade_messages SET teacher_reply = \?, teacher_reply_by_email = \?, replied_at = current_timestamp, teacher_reply_seen_at = NULL WHERE id = \?/i.test(sql)) {
        const [teacher_reply, teacher_reply_by_email, id] = params;
        const message = gradeMessages.find((entry) => entry.id === Number(id));
        if (message) {
          message.teacher_reply = String(teacher_reply || "");
          message.teacher_reply_by_email = String(teacher_reply_by_email || "") || null;
          message.replied_at = new Date().toISOString();
          message.teacher_reply_seen_at = null;
        }
      } else if (/UPDATE grade_messages\s+SET teacher_reply_seen_at = current_timestamp\s+WHERE grade_id = \? AND student_id = \? AND teacher_reply IS NOT NULL AND teacher_reply_seen_at IS NULL/i.test(sql)) {
        const [grade_id, student_id] = params;
        const seenAt = new Date().toISOString();
        gradeMessages.forEach((entry) => {
          if (
            entry.grade_id === Number(grade_id) &&
            entry.student_id === Number(student_id) &&
            entry.teacher_reply &&
            !entry.teacher_reply_seen_at
          ) {
            entry.teacher_reply_seen_at = seenAt;
          }
        });
      } else if (/UPDATE grade_messages\s+SET student_hidden_at = NULL\s+WHERE grade_id = \? AND student_id = \? AND student_hidden_at IS NOT NULL/i.test(sql)) {
        const [grade_id, student_id] = params;
        gradeMessages.forEach((entry) => {
          if (
            entry.grade_id === Number(grade_id) &&
            entry.student_id === Number(student_id) &&
            entry.student_hidden_at
          ) {
            entry.student_hidden_at = null;
          }
        });
      } else if (/UPDATE grade_messages\s+SET student_hidden_at = current_timestamp\s+WHERE grade_id = \? AND student_id = \? AND student_hidden_at IS NULL/i.test(sql)) {
        const [grade_id, student_id] = params;
        const hiddenAt = new Date().toISOString();
        gradeMessages.forEach((entry) => {
          if (
            entry.grade_id === Number(grade_id) &&
            entry.student_id === Number(student_id) &&
            !entry.student_hidden_at
          ) {
            entry.student_hidden_at = hiddenAt;
          }
        });
      } else if (/INSERT INTO grade_notifications/i.test(sql)) {
        const [student_id, message, type, created_at] = params;
        const notification = {
          id: notificationId++,
          student_id: Number(student_id),
          message,
          type: type || "info",
          created_at: created_at || new Date().toISOString(),
          read_at: null
        };
        notifications.push(notification);
        lastID = notification.id;
      } else if (/INSERT INTO audit_logs/i.test(sql)) {
        const [
          actor_user_id,
          actor_email,
          actor_role,
          action,
          entity_type,
          entity_id,
          http_method,
          route_path,
          status_code,
          ip_address,
          user_agent,
          payload
        ] = params;
        const auditEntry = {
          id: auditLogId++,
          actor_user_id: actor_user_id == null ? null : Number(actor_user_id),
          actor_email: actor_email || null,
          actor_role: actor_role || null,
          action,
          entity_type: entity_type || null,
          entity_id: entity_id || null,
          http_method: http_method || null,
          route_path: route_path || null,
          status_code: status_code == null ? null : Number(status_code),
          ip_address: ip_address || null,
          user_agent: user_agent || null,
          payload: payload || null,
          created_at: new Date().toISOString()
        };
        auditLogs.push(auditEntry);
        lastID = auditEntry.id;
      } else if (/UPDATE grade_notifications SET read_at = current_timestamp WHERE id = \? AND student_id = \?/i.test(sql)) {
        const [id, student_id] = params.map(Number);
        const note = notifications.find((n) => n.id === id && n.student_id === student_id);
        if (note) note.read_at = new Date().toISOString();
      }

      if (typeof cb === "function") {
        if (err) cb(err);
        else cb.call({ lastID }, null);
      }
    },
    get(sql, params = [], cb) {
      let row;
      if (/SELECT id FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user ? { id: user.id } : undefined;
      } else if (/SELECT id, name, start_date, end_date, is_active\s+FROM school_years\s+WHERE is_active = \?\s+ORDER BY id DESC\s+LIMIT 1/i.test(sql)) {
        const [is_active] = params;
        row = schoolYears
          .filter((entry) => Boolean(entry.is_active) === Boolean(is_active))
          .sort((a, b) => b.id - a.id)[0];
      } else if (/SELECT id, name, start_date, end_date, is_active\s+FROM school_years\s+WHERE id = \?/i.test(sql)) {
        const [id] = params;
        row = schoolYears.find((entry) => entry.id === Number(id));
      } else if (/SELECT id, name, start_date, end_date, is_active\s+FROM school_years\s+WHERE name = \?/i.test(sql)) {
        const [name] = params;
        row = schoolYears.find((entry) => entry.name === String(name));
      } else if (/SELECT cst\.class_id,\s*cst\.subject_id\s+FROM class_subject_teacher cst\s+WHERE cst\.teacher_id = \? AND cst\.school_year_id = \?/i.test(sql)) {
        const [teacher_id, school_year_id] = params;
        row = teachingAssignments
          .filter(
            (entry) =>
              entry.teacher_id === Number(teacher_id) &&
              Number(entry.school_year_id) === Number(school_year_id)
          )
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)[0];
      } else if (/SELECT id, email, password_hash, role, status, must_change_password FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user
          ? {
              id: user.id,
              email: user.email,
              password_hash: user.password_hash,
              role: user.role,
              status: user.status,
              must_change_password: user.must_change_password || 0
            }
          : undefined;
      } else if (/SELECT id, role FROM users WHERE email = \?/i.test(sql)) {
        const [email] = params;
        const user = users.find((u) => u.email === email);
        row = user ? { id: user.id, role: user.role } : undefined;
      } else if (/SELECT id FROM subjects WHERE LOWER\(name\) = LOWER\(\?\)/i.test(sql)) {
        const [name] = params;
        const subject = subjects.find((entry) => String(entry.name).toLowerCase() === String(name).toLowerCase());
        row = subject ? { id: subject.id } : undefined;
      } else if (/SELECT id FROM subjects WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const subject = subjects.find((entry) => entry.id === Number(id));
        row = subject ? { id: subject.id } : undefined;
      } else if (/SELECT id, subject_id FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((entry) => entry.id === Number(id));
        row = classRow ? { id: classRow.id, subject_id: classRow.subject_id } : undefined;
      } else if (/SELECT id, email, role, status, created_at, must_change_password FROM users WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        row = user
          ? {
              id: user.id,
              email: user.email,
              role: user.role,
              status: user.status,
              created_at: user.created_at,
              must_change_password: user.must_change_password || 0
            }
          : undefined;
      } else if (/SELECT id, email, role, status, must_change_password FROM users WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const user = users.find((u) => u.id === Number(id));
        row = user
          ? { id: user.id, email: user.email, role: user.role, status: user.status, must_change_password: user.must_change_password || 0 }
          : undefined;
      } else if (/SELECT id, name, subject FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow ? { id: classRow.id, name: classRow.name, subject: classRow.subject } : undefined;
      } else if (/SELECT id, name, subject, subject_id, school_year_id, created_at FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow
          ? {
              id: classRow.id,
              name: classRow.name,
              subject: classRow.subject,
              subject_id: classRow.subject_id,
              school_year_id: classRow.school_year_id,
              head_teacher_id: classRow.head_teacher_id ?? classRow.teacher_id ?? null,
              created_at: classRow.created_at
            }
          : undefined;
      } else if (/SELECT .*FROM classes\s+WHERE id = \? AND school_year_id = \?/i.test(sql)) {
        const [id, school_year_id] = params;
        const classRow = classes.find(
          (entry) => entry.id === Number(id) && Number(entry.school_year_id) === Number(school_year_id)
        );
        row = classRow
          ? {
              id: classRow.id,
              name: classRow.name,
              subject: classRow.subject,
              subject_id: classRow.subject_id,
              school_year_id: classRow.school_year_id,
              head_teacher_id: classRow.head_teacher_id ?? classRow.teacher_id ?? null,
              created_at: classRow.created_at
            }
          : undefined;
      } else if (/SELECT id, name, subject, subject_id, school_year_id FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow
          ? {
              id: classRow.id,
              name: classRow.name,
              subject: classRow.subject,
              subject_id: classRow.subject_id,
              school_year_id: classRow.school_year_id,
              head_teacher_id: classRow.head_teacher_id ?? classRow.teacher_id ?? null
            }
          : undefined;
      } else if (/SELECT id, name, subject, subject_id(, created_at)? FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow
          ? {
              id: classRow.id,
              name: classRow.name,
              subject: classRow.subject,
              subject_id: classRow.subject_id,
              head_teacher_id: classRow.head_teacher_id ?? classRow.teacher_id ?? null,
              created_at: classRow.created_at
            }
          : undefined;
      } else if (/SELECT c\.id, c\.name, c\.subject, c\.subject_id\s+FROM classes c\s+WHERE c\.id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow
          ? {
              id: classRow.id,
              name: classRow.name,
              subject: classRow.subject,
              subject_id: classRow.subject_id
            }
          : undefined;
      } else if (/SELECT id, name FROM subjects WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const subjectRow = subjects.find((entry) => entry.id === Number(id));
        row = subjectRow ? { id: subjectRow.id, name: subjectRow.name } : undefined;
      } else if (/SELECT id FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow ? { id: classRow.id } : undefined;
      } else if (/SELECT COUNT\(\*\) AS count FROM class_subject_teacher WHERE teacher_id = \?/i.test(sql)) {
        const [teacher_id] = params;
        row = {
          count: teachingAssignments.filter((entry) => entry.teacher_id === Number(teacher_id)).length
        };
      } else if (/SELECT COUNT\(\*\) AS count\s+FROM grades\s+WHERE school_year_id = \?/i.test(sql)) {
        const [school_year_id] = params;
        row = {
          count: grades.filter((entry) => Number(entry.school_year_id) === Number(school_year_id)).length
        };
      } else if (/SELECT cst\.class_id, cst\.subject_id\s+FROM class_subject_teacher cst\s+WHERE cst\.teacher_id = \?/i.test(sql)) {
        const [teacher_id] = params;
        row = teachingAssignments
          .filter((entry) => entry.teacher_id === Number(teacher_id))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      } else if (/SELECT 1 AS allowed\s+FROM class_subject_teacher\s+WHERE teacher_id = \? AND class_id = \? AND school_year_id = \?\s+LIMIT 1/i.test(sql)) {
        const [teacher_id, class_id, school_year_id] = params;
        const match = teachingAssignments.find(
          (entry) =>
            entry.teacher_id === Number(teacher_id) &&
            entry.class_id === Number(class_id) &&
            Number(entry.school_year_id) === Number(school_year_id)
        );
        row = match ? { allowed: 1 } : undefined;
      } else if (/SELECT 1 AS allowed\s+FROM class_subject_teacher\s+WHERE teacher_id = \? AND class_id = \?\s+LIMIT 1/i.test(sql)) {
        const [teacher_id, class_id] = params;
        const match = teachingAssignments.find(
          (entry) => entry.teacher_id === Number(teacher_id) && entry.class_id === Number(class_id)
        );
        row = match ? { allowed: 1 } : undefined;
      } else if (/SELECT 1 AS allowed\s+FROM class_subject_teacher\s+WHERE teacher_id = \? AND class_id = \? AND subject_id = \? AND school_year_id = \?\s+LIMIT 1/i.test(sql)) {
        const [teacher_id, class_id, subject_id, school_year_id] = params;
        const match = teachingAssignments.find(
          (entry) =>
            entry.teacher_id === Number(teacher_id) &&
            entry.class_id === Number(class_id) &&
            entry.subject_id === Number(subject_id) &&
            Number(entry.school_year_id) === Number(school_year_id)
        );
        row = match ? { allowed: 1 } : undefined;
      } else if (/SELECT 1 AS allowed\s+FROM class_subject_teacher\s+WHERE teacher_id = \? AND class_id = \? AND subject_id = \?\s+LIMIT 1/i.test(sql)) {
        const [teacher_id, class_id, subject_id] = params;
        const match = teachingAssignments.find(
          (entry) =>
            entry.teacher_id === Number(teacher_id) &&
            entry.class_id === Number(class_id) &&
            entry.subject_id === Number(subject_id)
        );
        row = match ? { allowed: 1 } : undefined;
      } else if (/SELECT c\.id, c\.name, c\.subject,\s+COALESCE\(\(/i.test(sql) && /FROM classes c\s+WHERE c\.id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          const teacherEmails =
            getTeacherEmailsForClassSubject(classRow.id, classRow.subject_id).join(", ") ||
            users.find((u) => u.id === classRow.teacher_id)?.email ||
            "";
          const alias = /AS teacher_emails/i.test(sql) ? "teacher_emails" : "teacher_email";
          row = {
            id: classRow.id,
            name: classRow.name,
            subject: classRow.subject,
            [alias]: teacherEmails
          };
        }
      } else if (/SELECT c.id, c.name, c.subject, u.email AS teacher_email FROM classes c/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          const teacher = users.find((u) => u.id === classRow.teacher_id);
          row = {
            id: classRow.id,
            name: classRow.name,
            subject: classRow.subject,
            teacher_email: teacher ? teacher.email : null,
            teacher_id: classRow.teacher_id
          };
        }
      } else if (/SELECT COUNT\(\*\) AS count FROM users/i.test(sql)) {
        row = { count: users.length };
      } else if (/SELECT COUNT\(\*\) AS count FROM classes/i.test(sql)) {
        row = { count: classes.length };
      } else if (/SELECT COUNT\(\*\) AS count FROM students/i.test(sql)) {
        row = { count: students.length };
      } else if (/SELECT COUNT\(\*\) AS count\s+FROM audit_logs/i.test(sql)) {
        const hasActorFilter = /LOWER\(actor_email\) LIKE LOWER\(\?\)/i.test(sql);
        const hasActionFilter = /LOWER\(action\) LIKE LOWER\(\?\)/i.test(sql);
        const hasEntityFilter = /LOWER\(entity_type\) = LOWER\(\?\)/i.test(sql);
        let index = 0;
        const actorNeedle = hasActorFilter
          ? String(params[index++] || "").replace(/%/g, "").toLowerCase()
          : null;
        const actionNeedle = hasActionFilter
          ? String(params[index++] || "").replace(/%/g, "").toLowerCase()
          : null;
        const entityNeedle = hasEntityFilter ? String(params[index++] || "").toLowerCase() : null;

        row = {
          count: auditLogs
            .filter((entry) =>
              !actorNeedle ? true : String(entry.actor_email || "").toLowerCase().includes(actorNeedle)
            )
            .filter((entry) =>
              !actionNeedle ? true : String(entry.action || "").toLowerCase().includes(actionNeedle)
            )
            .filter((entry) =>
              !entityNeedle ? true : String(entry.entity_type || "").toLowerCase() === entityNeedle
            ).length
        };
      } else if (/SELECT id FROM classes WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const classRow = classes.find((c) => c.id === Number(id) && c.teacher_id === Number(teacher_id));
        row = classRow ? { id: classRow.id } : undefined;
      } else if (/SELECT id, name, subject FROM classes WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const classRow = classes.find((c) => c.id === Number(id) && c.teacher_id === Number(teacher_id));
        row = classRow ? { id: classRow.id, name: classRow.name, subject: classRow.subject } : undefined;
      } else if (/FROM classes c\s+JOIN (teaching_assignments ta|class_subject_teacher cst) ON (ta|cst)\.class_id = c.id AND (ta|cst)\.subject_id = c.subject_id/i.test(sql) && /WHERE c.id = \? AND (ta|cst)\.teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const classRow = classes.find((entry) => entry.id === Number(id));
        if (classRow) {
          const hasAssignment = teachingAssignments.some(
            (entry) =>
              entry.class_id === classRow.id &&
              entry.subject_id === Number(classRow.subject_id) &&
              entry.teacher_id === Number(teacher_id)
          );
          if (hasAssignment) {
            const subject = subjects.find((entry) => entry.id === Number(classRow.subject_id));
            row = {
              id: classRow.id,
              name: classRow.name,
              subject: subject ? subject.name : classRow.subject,
              subject_id: classRow.subject_id
            };
          }
        }
      } else if (/SELECT id, name FROM classes WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const classRow = classes.find((c) => c.id === Number(id) && c.teacher_id === Number(teacher_id));
        row = classRow ? { id: classRow.id, name: classRow.name } : undefined;
      } else if (/SELECT gp\.absence_mode FROM class_subject_teacher cst[\s\S]*WHERE c\.id = \?/i.test(sql)) {
        const [is_active, classId] = params;
        const classRow = classes.find((entry) => entry.id === Number(classId));
        if (classRow) {
          const assignment = teachingAssignments.find(
            (entry) =>
              entry.class_id === classRow.id &&
              entry.subject_id === Number(classRow.subject_id) &&
              Boolean(
                teacherGradingProfiles.find(
                  (profile) =>
                    profile.teacher_id === entry.teacher_id &&
                    Boolean(profile.is_active) === Boolean(is_active)
                )
              )
          );
          const teacherId = assignment?.teacher_id ?? classRow.teacher_id;
          if (teacherId != null) {
            const activeProfile = teacherGradingProfiles
              .filter(
                (entry) =>
                  entry.teacher_id === Number(teacherId) &&
                  Boolean(entry.is_active) === Boolean(is_active)
              )
              .sort((a, b) => {
                if (a.created_at === b.created_at) return a.id - b.id;
                return new Date(a.created_at) - new Date(b.created_at);
              })[0];
            row = { absence_mode: activeProfile?.absence_mode || "include_zero" };
          }
        }
      } else if (/SELECT gp\.absence_mode FROM classes c[\s\S]*WHERE c\.id = \?/i.test(sql)) {
        const [is_active, classId] = params;
        const classRow = classes.find((entry) => entry.id === Number(classId));
        if (classRow) {
          const activeProfile = teacherGradingProfiles
            .filter(
              (entry) =>
                entry.teacher_id === Number(classRow.teacher_id) &&
                Boolean(entry.is_active) === Boolean(is_active)
            )
            .sort((a, b) => {
              if (a.created_at === b.created_at) return a.id - b.id;
              return new Date(a.created_at) - new Date(b.created_at);
            })[0];
          row = { absence_mode: activeProfile?.absence_mode || "include_zero" };
        }
      } else if (/SELECT id, name, category, weight, (weight_mode, )?max_points, date, description FROM grade_templates WHERE id = \? AND class_id = \?( AND subject_id = \?)?/i.test(sql)) {
        const [templateId, clsId, subjectId] = params;
        const template = gradeTemplates.find(
          (entry) =>
            entry.id === Number(templateId) &&
            entry.class_id === Number(clsId) &&
            (subjectId == null || entry.subject_id === normalizeOptionalId(subjectId))
        );
        row = template
          ? {
              id: template.id,
              name: template.name,
              category: template.category,
              weight: template.weight,
              weight_mode: template.weight_mode || "points",
              max_points: template.max_points ?? null,
              date: template.date || null,
              description: template.description || null
            }
          : undefined;
      } else if (/FROM teacher_grading_profiles\s+WHERE id = \? AND teacher_id = \?/i.test(sql)) {
        const [id, teacher_id] = params;
        const profile = teacherGradingProfiles.find(
          (entry) => entry.id === Number(id) && entry.teacher_id === Number(teacher_id)
        );
        row = profile ? { ...profile } : undefined;
      } else if (/FROM teacher_grading_profiles\s+WHERE teacher_id = \? AND is_active = \?/i.test(sql)) {
        const [teacher_id, is_active] = params;
        const profile = teacherGradingProfiles
          .filter(
            (entry) =>
              entry.teacher_id === Number(teacher_id) &&
              Boolean(entry.is_active) === Boolean(is_active)
          )
          .sort((a, b) => {
            if (a.created_at === b.created_at) return a.id - b.id;
            return new Date(a.created_at) - new Date(b.created_at);
          })[0];
        row = profile ? { ...profile } : undefined;
      } else if (/FROM teacher_grading_profiles\s+WHERE teacher_id = \?\s+ORDER BY created_at ASC, id ASC\s+LIMIT 1/i.test(sql)) {
        const [teacher_id] = params;
        const profile = teacherGradingProfiles
          .filter((entry) => entry.teacher_id === Number(teacher_id))
          .sort((a, b) => {
            if (a.created_at === b.created_at) return a.id - b.id;
            return new Date(a.created_at) - new Date(b.created_at);
          })[0];
        row = profile ? { ...profile } : undefined;
      } else if (/SELECT id FROM teacher_grading_profiles WHERE teacher_id = \? AND is_active = \? LIMIT 1/i.test(sql)) {
        const [teacher_id, is_active] = params;
        const profile = teacherGradingProfiles.find(
          (entry) =>
            entry.teacher_id === Number(teacher_id) &&
            Boolean(entry.is_active) === Boolean(is_active)
        );
        row = profile ? { id: profile.id } : undefined;
      } else if (/SELECT id FROM students WHERE email = \? AND class_id = \?/i.test(sql)) {
        const [email, class_id] = params;
        const student = students.find((s) => s.email === email && s.class_id === Number(class_id));
        row = student ? { id: student.id } : undefined;
      } else if (/SELECT id FROM special_assessments WHERE id = \? AND class_id = \?( AND subject_id = \?)?/i.test(sql)) {
        const [assessmentId, clsId, subjectId] = params;
        const assessment = specialAssessments.find(
          (entry) =>
            entry.id === Number(assessmentId) &&
            entry.class_id === Number(clsId) &&
            (subjectId == null || entry.subject_id === normalizeOptionalId(subjectId))
        );
        row = assessment ? { id: assessment.id } : undefined;
      } else if (/SELECT id, max_points FROM grade_templates WHERE id = \? AND class_id = \?( AND subject_id = \?)?/i.test(sql)) {
        const [templateId, clsId, subjectId] = params;
        const template = gradeTemplates.find(
          (entry) =>
            entry.id === Number(templateId) &&
            entry.class_id === Number(clsId) &&
            (subjectId == null || entry.subject_id === normalizeOptionalId(subjectId))
        );
        row = template ? { id: template.id, max_points: template.max_points ?? null } : undefined;
      } else if (/SELECT id FROM grade_templates WHERE id = \? AND class_id = \?( AND subject_id = \?)?/i.test(sql)) {
        const [templateId, clsId, subjectId] = params;
        const template = gradeTemplates.find(
          (entry) =>
            entry.id === Number(templateId) &&
            entry.class_id === Number(clsId) &&
            (subjectId == null || entry.subject_id === normalizeOptionalId(subjectId))
        );
        row = template ? { id: template.id } : undefined;
      } else if (/SELECT g\.attachment_path\s+FROM grades g\s+JOIN grade_templates gt ON gt\.id = g\.grade_template_id\s+WHERE g\.id = \? AND g\.class_id = \? AND gt\.subject_id = \?/i.test(sql)) {
        const [gradeId, clsId, subjectId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.class_id === Number(clsId)
        );
        const template = gradeTemplates.find(
          (entry) => entry.id === Number(grade?.grade_template_id)
        );
        row =
          grade && template && template.subject_id === normalizeOptionalId(subjectId)
            ? { attachment_path: grade.attachment_path || null }
            : undefined;
      } else if (/SELECT attachment_path FROM grades WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [gradeId, clsId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.class_id === Number(clsId)
        );
        row = grade ? { attachment_path: grade.attachment_path || null } : undefined;
      } else if (/SELECT id, student_id, grade_template_id FROM grades WHERE id = \? AND student_id = \?/i.test(sql)) {
        const [gradeId, studentId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.student_id === Number(studentId)
        );
        row = grade
          ? {
              id: grade.id,
              student_id: grade.student_id,
              grade_template_id: grade.grade_template_id
            }
          : undefined;
      } else if (/SELECT id FROM grades WHERE id = \? AND student_id = \?/i.test(sql)) {
        const [gradeId, studentId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.student_id === Number(studentId)
        );
        row = grade ? { id: grade.id } : undefined;
      } else if (/SELECT attachment_path, attachment_original_name, attachment_mime FROM grades WHERE id = \? AND student_id = \?/i.test(sql)) {
        const [gradeId, studentId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.student_id === Number(studentId)
        );
        row = grade
          ? {
              attachment_path: grade.attachment_path || null,
              attachment_original_name: grade.attachment_original_name || null,
              attachment_mime: grade.attachment_mime || null
            }
          : undefined;
      } else if (/SELECT gm\.id, gm\.student_id, gm\.student_hidden_at\s+FROM grade_messages gm\s+JOIN grades g ON g\.id = gm\.grade_id[\s\S]*WHERE gm\.id = \? AND g\.class_id = \?/i.test(sql)) {
        const [messageId, classIdParam, subjectId] = params;
        const message = gradeMessages.find((entry) => entry.id === Number(messageId));
        if (message) {
          const grade = grades.find(
            (entry) =>
              entry.id === Number(message.grade_id) && entry.class_id === Number(classIdParam)
          );
          const template = gradeTemplates.find(
            (entry) => entry.id === Number(grade?.grade_template_id)
          );
          row = grade
            && (subjectId == null || template?.subject_id === normalizeOptionalId(subjectId))
            ? {
                id: message.id,
                student_id: message.student_id,
                student_hidden_at: message.student_hidden_at || null
              }
            : undefined;
        }
      } else if (/SELECT s\.\*, c\.name as class_name, c\.subject as class_subject, c\.id as class_id FROM students s (LEFT )?JOIN classes c ON c.id = s.class_id WHERE s.email = \?/i.test(sql)) {
        const [email] = params;
        const student = students.find((s) => s.email === email);
        if (student) {
          const cls = classes.find((c) => c.id === student.class_id);
          row = {
            ...student,
            class_name: cls?.name,
            class_subject: cls?.subject,
            class_id: cls?.id
          };
        }
      }

      if (typeof cb === "function") cb(null, row);
    },
    all(sql, params = [], cb) {
      let rows = [];
      if (/SELECT id, name, start_date, end_date, is_active\s+FROM school_years\s+ORDER BY start_date DESC, id DESC/i.test(sql)) {
        rows = [...schoolYears]
          .sort((a, b) => {
            const dateComparison = String(b.start_date || "").localeCompare(String(a.start_date || ""));
            return dateComparison || b.id - a.id;
          })
          .map((entry) => ({ ...entry }));
      } else if (/SELECT id, school_year_id, archive_type, entity_count, created_at\s+FROM archives\s+WHERE school_year_id = \?/i.test(sql)) {
        const [school_year_id] = params;
        rows = archives
          .filter((entry) => entry.school_year_id === Number(school_year_id))
          .sort((a, b) => `${a.archive_type}`.localeCompare(`${b.archive_type}`))
          .map((entry) => ({ ...entry }));
      } else if (/SELECT rl\.id,[\s\S]*FROM rollover_logs rl[\s\S]*ORDER BY rl\.executed_at DESC, rl\.id DESC/i.test(sql)) {
        rows = [...rolloverLogs]
          .sort((a, b) => {
            const timeDiff = new Date(b.executed_at) - new Date(a.executed_at);
            return timeDiff || b.id - a.id;
          })
          .map((entry) => {
            const user = users.find((userEntry) => userEntry.id === entry.executed_by);
            return {
              ...entry,
              executed_by_email: user?.email || null
            };
          });
      } else if (/SELECT id, email, role, status, created_at, must_change_password FROM users ORDER BY id DESC/i.test(sql)) {
        rows = [...users]
          .sort((a, b) => b.id - a.id)
          .map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, created_at: u.created_at, must_change_password: u.must_change_password || 0 }));
      } else if (/SELECT id, name FROM subjects ORDER BY name ASC/i.test(sql)) {
        rows = [...subjects]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => ({ id: entry.id, name: entry.name }));
      } else if (/SELECT id, name, subject, subject_id, school_year_id, head_teacher_id, created_at\s+FROM classes\s+WHERE school_year_id = \?/i.test(sql)) {
        const [school_year_id] = params;
        rows = classes
          .filter((entry) => Number(entry.school_year_id) === Number(school_year_id))
          .sort((a, b) => `${a.name} ${a.subject}`.localeCompare(`${b.name} ${b.subject}`))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            subject: entry.subject,
            subject_id: entry.subject_id,
            school_year_id: entry.school_year_id,
            head_teacher_id: entry.head_teacher_id ?? entry.teacher_id ?? null,
            created_at: entry.created_at
          }));
      } else if (/SELECT id, name, subject, subject_id, school_year_id, created_at\s+FROM classes\s+ORDER BY id ASC/i.test(sql)) {
        rows = [...classes]
          .sort((a, b) => a.id - b.id)
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            subject: entry.subject,
            subject_id: entry.subject_id,
            school_year_id: entry.school_year_id,
            created_at: entry.created_at
          }));
      } else if (/SELECT c.id, c.name, c.subject, c.subject_id, c.school_year_id\s+FROM classes c\s+JOIN school_years sy ON sy.id = c.school_year_id\s+WHERE sy.is_active = \?/i.test(sql)) {
        const [is_active] = params;
        const activeYearIds = schoolYears
          .filter((entry) => Boolean(entry.is_active) === Boolean(is_active))
          .map((entry) => Number(entry.id));
        rows = classes
          .filter((entry) => activeYearIds.includes(Number(entry.school_year_id)))
          .sort((a, b) => `${a.name} ${a.subject}`.localeCompare(`${b.name} ${b.subject}`))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            subject: entry.subject,
            subject_id: entry.subject_id,
            school_year_id: entry.school_year_id
          }));
      } else if (/SELECT c.id, c.name, c.subject, c.subject_id\s+FROM classes c/i.test(sql)) {
        rows = [...classes]
          .sort((a, b) => `${a.name} ${a.subject}`.localeCompare(`${b.name} ${b.subject}`))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            subject: entry.subject,
            subject_id: entry.subject_id
          }));
      } else if (/SELECT cst.subject_id,\s*COALESCE\(s.name, c.subject\) AS subject_name\s+FROM class_subject_teacher cst[\s\S]*WHERE cst.class_id = \? AND cst.school_year_id = c.school_year_id/i.test(sql)) {
        const [classIdParam] = params;
        const classRow = classes.find((entry) => entry.id === Number(classIdParam));
        const seenSubjects = new Set();
        rows = teachingAssignments
          .filter(
            (entry) =>
              entry.class_id === Number(classIdParam) &&
              (!classRow || Number(entry.school_year_id) === Number(classRow.school_year_id))
          )
          .map((entry) => {
            const subjectRow = subjects.find((s) => s.id === entry.subject_id) || {};
            return {
              subject_id: entry.subject_id,
              subject_name: subjectRow.name || classRow?.subject || ""
            };
          })
          .filter((entry) => {
            const key = `${entry.subject_id}:${entry.subject_name}`;
            if (seenSubjects.has(key)) return false;
            seenSubjects.add(key);
            return true;
          })
          .sort((a, b) => `${a.subject_name}`.localeCompare(`${b.subject_name}`));
      } else if (/SELECT cst.subject_id,\s*COALESCE\(s.name, c.subject\) AS subject_name\s+FROM class_subject_teacher cst[\s\S]*WHERE cst.teacher_id = \? AND cst.class_id = \? AND cst.school_year_id = \?/i.test(sql)) {
        const [teacherIdParam, classIdParam, schoolYearIdParam] = params;
        rows = teachingAssignments
          .filter(
            (entry) =>
              entry.teacher_id === Number(teacherIdParam) &&
              entry.class_id === Number(classIdParam) &&
              Number(entry.school_year_id) === Number(schoolYearIdParam)
          )
          .map((entry) => {
            const classRow = classes.find((c) => c.id === entry.class_id) || {};
            const subjectRow = subjects.find((s) => s.id === entry.subject_id) || {};
            return {
              subject_id: entry.subject_id,
              subject_name: subjectRow.name || classRow.subject || ""
            };
          })
          .sort((a, b) => `${a.subject_name}`.localeCompare(`${b.subject_name}`));
      } else if (/SELECT cst.id AS assignment_id, c.id, c.name, s.name AS subject\s+FROM class_subject_teacher cst/i.test(sql)) {
        const [teacherIdParam] = params;
        rows = teachingAssignments
          .filter((entry) => entry.teacher_id === Number(teacherIdParam))
          .map((entry) => {
            const classRow = classes.find((c) => c.id === entry.class_id) || {};
            const subjectRow = subjects.find((s) => s.id === entry.subject_id) || {};
            return {
              assignment_id: entry.id,
              id: entry.class_id,
              name: classRow.name,
              subject: subjectRow.name
            };
          })
          .sort((a, b) => Number(b.assignment_id) - Number(a.assignment_id));
      } else if (/SELECT cst.id, cst.class_id, cst.subject_id, c.name AS class_name, c.created_at, s.name AS subject_name\s+FROM class_subject_teacher cst/i.test(sql) || /SELECT ta.id, ta.class_id, ta.subject_id, c.name AS class_name, c.created_at, s.name AS subject_name\s+FROM teaching_assignments ta/i.test(sql)) {
        const [teacherIdParam] = params;
        rows = teachingAssignments
          .filter((entry) => entry.teacher_id === Number(teacherIdParam))
          .map((entry) => {
            const classRow = classes.find((c) => c.id === entry.class_id) || {};
            const subjectRow = subjects.find((s) => s.id === entry.subject_id) || {};
            return {
              id: entry.id,
              class_id: entry.class_id,
              subject_id: entry.subject_id,
              class_name: classRow.name,
              created_at: classRow.created_at,
              subject_name: subjectRow.name
            };
          })
          .sort((a, b) => `${a.class_name} ${a.subject_name}`.localeCompare(`${b.class_name} ${b.subject_name}`));
      } else if (/SELECT cst.class_id,\s*cst.subject_id,\s*c.name AS class_name,\s*s.name AS subject_name,\s*STRING_AGG/i.test(sql) && /FROM class_subject_teacher cst/i.test(sql)) {
        const groupMap = new Map();
        teachingAssignments.forEach((entry) => {
          const classRow = classes.find((c) => c.id === entry.class_id) || {};
          const subjectRow = subjects.find((s) => s.id === entry.subject_id) || {};
          const teacher = users.find((u) => u.id === entry.teacher_id) || {};
          const key = `${entry.class_id}:${entry.subject_id}`;
          if (!groupMap.has(key)) {
            groupMap.set(key, {
              class_id: entry.class_id,
              subject_id: entry.subject_id,
              class_name: classRow.name,
              subject_name: subjectRow.name,
              teacherNames: []
            });
          }
          if (teacher.email) {
            groupMap.get(key).teacherNames.push(teacher.email);
          }
        });
        rows = [...groupMap.values()]
          .map((entry) => {
            const teacherNames = [...new Set(entry.teacherNames)].sort((a, b) => a.localeCompare(b));
            return {
              class_id: entry.class_id,
              subject_id: entry.subject_id,
              class_name: entry.class_name,
              subject_name: entry.subject_name,
              teacher_names: teacherNames.join(", "),
              teacher_count: teacherNames.length
            };
          })
          .sort((a, b) => `${a.class_name} ${a.subject_name}`.localeCompare(`${b.class_name} ${b.subject_name}`));
      } else if (/SELECT cst.id,\s*cst.class_id,\s*cst.subject_id,\s*cst.teacher_id,\s*cst.school_year_id,/i.test(sql) && /FROM class_subject_teacher cst/i.test(sql)) {
        const [school_year_id] = params;
        rows = teachingAssignments
          .filter((entry) => Number(entry.school_year_id) === Number(school_year_id))
          .map((entry) => {
            const classRow = classes.find((c) => c.id === entry.class_id) || {};
            const subjectRow = subjects.find((s) => s.id === entry.subject_id) || {};
            const teacher = users.find((u) => u.id === entry.teacher_id) || {};
            return {
              id: entry.id,
              class_id: entry.class_id,
              subject_id: entry.subject_id,
              teacher_id: entry.teacher_id,
              school_year_id: entry.school_year_id,
              class_name: classRow.name,
              subject_name: subjectRow.name,
              teacher_email: teacher.email
            };
          })
          .sort((a, b) => `${a.class_name} ${a.subject_name} ${a.teacher_email}`.localeCompare(`${b.class_name} ${b.subject_name} ${b.teacher_email}`));
      } else if (/SELECT id, class_id, subject_id, teacher_id, school_year_id\s+FROM class_subject_teacher ORDER BY id ASC/i.test(sql)) {
        rows = [...teachingAssignments]
          .sort((a, b) => a.id - b.id)
          .map((entry) => ({
            id: entry.id,
            class_id: entry.class_id,
            subject_id: entry.subject_id,
            teacher_id: entry.teacher_id,
            school_year_id: entry.school_year_id
          }));
      } else if (/SELECT cst.id,\s*cst.class_id,\s*cst.subject_id,\s*cst.teacher_id,/i.test(sql) && /FROM class_subject_teacher cst/i.test(sql) || /SELECT ta.id, ta.class_id, ta.subject_id, ta.teacher_id, ta.created_at,/i.test(sql) && /FROM teaching_assignments ta/i.test(sql)) {
        rows = teachingAssignments
          .map((entry) => {
            const classRow = classes.find((c) => c.id === entry.class_id) || {};
            const subjectRow = subjects.find((s) => s.id === entry.subject_id) || {};
            const teacher = users.find((u) => u.id === entry.teacher_id) || {};
            return {
              id: entry.id,
              class_id: entry.class_id,
              subject_id: entry.subject_id,
              teacher_id: entry.teacher_id,
              created_at: entry.created_at,
              class_name: classRow.name,
              subject_name: subjectRow.name,
              teacher_email: teacher.email
            };
          })
          .sort((a, b) => `${a.class_name} ${a.subject_name} ${a.teacher_email}`.localeCompare(`${b.class_name} ${b.subject_name} ${b.teacher_email}`));
      } else if (/SELECT g.id,\s*g.class_id,\s*g.student_id,\s*g.grade,\s*g.note,\s*g.created_at,[\s\S]*FROM grades g[\s\S]*WHERE g.school_year_id = \?/i.test(sql)) {
        const [school_year_id] = params;
        rows = grades
          .filter((entry) => Number(entry.school_year_id) === Number(school_year_id))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)
          .map((entry) => {
            const student = students.find((studentEntry) => studentEntry.id === entry.student_id) || {};
            const classRow = classes.find((classEntry) => classEntry.id === entry.class_id) || {};
            return {
              id: entry.id,
              class_id: entry.class_id,
              student_id: entry.student_id,
              grade: entry.grade,
              note: entry.note,
              created_at: entry.created_at,
              student_name: student.name,
              class_name: classRow.name,
              subject: classRow.subject
            };
          });
      } else if (/SELECT id, class_id, student_id, grade, note, school_year_id, created_at\s+FROM grades ORDER BY id ASC/i.test(sql)) {
        rows = [...grades]
          .sort((a, b) => a.id - b.id)
          .map((entry) => ({
            id: entry.id,
            class_id: entry.class_id,
            student_id: entry.student_id,
            grade: entry.grade,
            note: entry.note,
            school_year_id: entry.school_year_id,
            created_at: entry.created_at
          }));
      } else if (/SELECT s.id AS student_id, s.name AS student_name, s.email AS student_email, s.school_year,[\s\S]*AS teacher_emails[\s\S]*FROM students s/i.test(sql)) {
        const [email] = params;
        rows = students
          .filter((student) => student.email === email)
          .map((student) => {
            const classRow = classes.find((entry) => entry.id === student.class_id) || {};
            return {
              student_id: student.id,
              student_name: student.name,
              student_email: student.email,
              school_year: student.school_year,
              class_id: classRow.id,
              class_name: classRow.name,
              subject: classRow.subject,
              teacher_emails: getTeacherEmailsForClassSubject(classRow.id, classRow.subject_id).join(", ")
            };
          })
          .sort((a, b) => (a.class_name || "").localeCompare(b.class_name || ""));
      } else if (/SELECT c.id, c.name, c.subject, c.created_at,\s+\(/i.test(sql) && /FROM classes c/i.test(sql)) {
        rows = classes
          .map((c) => {
            const teacherEmails = getTeacherEmailsForClassSubject(c.id, c.subject_id);
            return {
              id: c.id,
              name: c.name,
              subject: c.subject,
              created_at: c.created_at,
              teacher_emails: teacherEmails.join(", "),
              teacher_count: teacherEmails.length
            };
          });
      } else if (/SELECT id, name, subject FROM classes WHERE teacher_id = \? ORDER BY created_at DESC/i.test(sql)) {
        const [teacher_id] = params;
        rows = classes
          .filter((c) => c.teacher_id === Number(teacher_id))
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .map((c) => ({ id: c.id, name: c.name, subject: c.subject }));
      } else if (/SELECT id, email FROM users WHERE role = 'teacher' AND status = 'active'/i.test(sql)) {
        rows = users
          .filter((u) => u.role === "teacher" && u.status === "active")
          .sort((a, b) => a.email.localeCompare(b.email))
          .map((u) => ({ id: u.id, email: u.email }));
      } else if (/SELECT id\s+FROM users\s+WHERE role = 'teacher' AND status = 'active' AND id IN/i.test(sql)) {
        const ids = params.map((entry) => Number(entry));
        rows = users
          .filter((u) => u.role === "teacher" && u.status === "active" && ids.includes(Number(u.id)))
          .map((u) => ({ id: u.id }));
      } else if (/FROM teacher_grading_profiles\s+WHERE teacher_id = \?\s+ORDER BY is_active DESC, created_at ASC, id ASC/i.test(sql)) {
        const [teacher_id] = params;
        rows = teacherGradingProfiles
          .filter((profile) => profile.teacher_id === Number(teacher_id))
          .sort((a, b) => {
            if (Boolean(a.is_active) !== Boolean(b.is_active)) {
              return Boolean(a.is_active) ? -1 : 1;
            }
            if (a.created_at === b.created_at) return a.id - b.id;
            return new Date(a.created_at) - new Date(b.created_at);
          })
          .map((profile) => ({ ...profile }));
      } else if (/SELECT category, weight FROM teacher_grading_profile_items WHERE profile_id = \?/i.test(sql)) {
        const [profile_id] = params;
        rows = teacherGradingProfileItems
          .filter((item) => item.profile_id === Number(profile_id))
          .map((item) => ({ category: item.category, weight: item.weight }));
      } else if (/SELECT c.id, c.name, c.subject, c.created_at, u.email AS teacher_email, u.id AS teacher_id/i.test(sql)) {
        rows = classes
          .filter((c) => {
            if (!params.length) return true;
            const [like] = params;
            const teacher = users.find((u) => u.id === c.teacher_id);
            const haystack = `${c.name} ${c.subject} ${teacher?.email || ''}`.toLowerCase();
            return haystack.includes(String(like).replace(/%/g, '').toLowerCase());
          })
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
          .map((c) => {
            const teacher = users.find((u) => u.id === c.teacher_id);
            return {
              id: c.id,
              name: c.name,
              subject: c.subject,
              created_at: c.created_at,
              teacher_email: teacher ? teacher.email : null,
              teacher_id: teacher ? teacher.id : null
            };
          });
      } else if (/FROM students s\s+JOIN classes c ON c.id = s.class_id\s+LEFT JOIN users u ON u.id = c.teacher_id\s+WHERE s.email = \?/i.test(sql)) {
        const [email] = params;
        rows = students
          .filter((s) => s.email === email)
          .map((s) => {
            const cls = classes.find((c) => c.id === s.class_id) || {};
            const teacher = users.find((u) => u.id === cls.teacher_id);
            return {
              student_id: s.id,
              student_name: s.name,
              student_email: s.email,
              school_year: s.school_year,
              class_id: cls.id,
              class_name: cls.name,
              subject: cls.subject,
              teacher_email: teacher ? teacher.email : null
            };
          })
          .sort((a, b) => (a.class_name || "").localeCompare(b.class_name || ""));
      } else if (/SELECT student_id,\s*excluded_at\s+FROM teacher_student_exclusions\s+WHERE teacher_id = \? AND class_id = \? AND subject_id = \?/i.test(sql)) {
        const [teacher_id, class_id, subject_id] = params;
        rows = teacherStudentExclusions
          .filter(
            (entry) =>
              entry.teacher_id === Number(teacher_id) &&
              entry.class_id === Number(class_id) &&
              entry.subject_id === normalizeOptionalId(subject_id)
          )
          .map((entry) => ({
            student_id: entry.student_id,
            excluded_at: entry.excluded_at
          }));
      } else if (/SELECT id, name, email FROM students WHERE class_id = \?/i.test(sql) && /ORDER BY name/i.test(sql)) {
        const hasNameFilter = /LOWER\(name\) LIKE LOWER\(\?\)/i.test(sql);
        const hasEmailFilter = /LOWER\(email\) LIKE LOWER\(\?\)/i.test(sql);
        let index = 0;
        const class_id = params[index++];
        const nameLike = hasNameFilter ? params[index++] : null;
        const emailLike = hasEmailFilter ? params[index++] : null;
        const nameNeedle = nameLike ? String(nameLike).replace(/%/g, "").toLowerCase() : null;
        const emailNeedle = emailLike ? String(emailLike).replace(/%/g, "").toLowerCase() : null;

        rows = students
          .filter((s) => s.class_id === Number(class_id))
          .filter((s) => (!nameNeedle ? true : s.name.toLowerCase().includes(nameNeedle)))
          .filter((s) => (!emailNeedle ? true : s.email.toLowerCase().includes(emailNeedle)))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({ id: s.id, name: s.name, email: s.email }));
      } else if (/SELECT g\.grade_template_id\s+FROM grades g\s+JOIN grade_templates gt ON gt\.id = g\.grade_template_id\s+WHERE g\.class_id = \? AND gt\.subject_id = \? AND g\.student_id = \?/i.test(sql)) {
        const [class_id, subject_id, student_id] = params;
        rows = grades
          .filter(
            (entry) =>
              entry.class_id === Number(class_id) &&
              entry.student_id === Number(student_id) &&
              (gradeTemplates.find((template) => template.id === entry.grade_template_id)?.subject_id ??
                null) === normalizeOptionalId(subject_id)
          )
          .map((entry) => ({ grade_template_id: entry.grade_template_id }));
      } else if (/SELECT grade_template_id FROM grades WHERE class_id = \? AND student_id = \?/i.test(sql)) {
        const [class_id, student_id] = params;
        rows = grades
          .filter(
            (entry) =>
              entry.class_id === Number(class_id) && entry.student_id === Number(student_id)
          )
          .map((entry) => ({ grade_template_id: entry.grade_template_id }));
      } else if (/SELECT id, student_id, grade, points_achieved, points_max, note, is_absent\s+FROM grades g\s+JOIN grade_templates gt ON gt\.id = g\.grade_template_id\s+WHERE g\.class_id = \? AND gt\.subject_id = \? AND g\.grade_template_id = \?/i.test(sql)) {
        const [class_id, subject_id, grade_template_id] = params;
        rows = grades
          .filter(
            (entry) =>
              entry.class_id === Number(class_id) &&
              entry.grade_template_id === Number(grade_template_id) &&
              (gradeTemplates.find((template) => template.id === entry.grade_template_id)?.subject_id ??
                null) === normalizeOptionalId(subject_id)
          )
          .map((entry) => ({
            id: entry.id,
            student_id: entry.student_id,
            grade: entry.grade,
            points_achieved: entry.points_achieved ?? null,
            points_max: entry.points_max ?? null,
            note: entry.note || null,
            is_absent: entry.is_absent ? 1 : 0
          }));
      } else if (/SELECT id, student_id, grade, points_achieved, points_max, note, is_absent\s+FROM grades\s+WHERE class_id = \? AND grade_template_id = \?/i.test(sql)) {
        const [class_id, grade_template_id] = params;
        rows = grades
          .filter(
            (entry) =>
              entry.class_id === Number(class_id) &&
              entry.grade_template_id === Number(grade_template_id)
          )
          .map((entry) => ({
            id: entry.id,
            student_id: entry.student_id,
            grade: entry.grade,
            points_achieved: entry.points_achieved ?? null,
            points_max: entry.points_max ?? null,
            note: entry.note || null,
            is_absent: entry.is_absent ? 1 : 0
          }));
      } else if (/FROM grades g[\s\S]*UNION ALL[\s\S]*special_assessments/i.test(sql) && /WHERE g\.student_id = \?/i.test(sql)) {
        const hasTeacherScope = /WHERE g\.student_id = \? AND g\.class_id = \? AND gt\.subject_id = \?/i.test(sql);
        const student_id = params[0];
        const class_id = hasTeacherScope ? params[1] : null;
        const subject_id = hasTeacherScope ? normalizeOptionalId(params[2]) : null;
        const baseRows = grades
          .filter((g) => g.student_id === Number(student_id))
          .filter((g) => (!Number.isFinite(Number(class_id)) ? true : g.class_id === Number(class_id)))
          .map((g) => {
            const template = gradeTemplates.find((t) => t.id === g.grade_template_id) || {};
            const cls = classes.find((c) => c.id === g.class_id) || {};
            if (hasTeacherScope && template.subject_id !== subject_id) return null;
            const subjectName = getClassSubjectLabel(g.class_id, template.subject_id);
            return {
              id: g.id,
              grade: g.grade,
              points_achieved: g.points_achieved ?? null,
              points_max: g.points_max ?? null,
              note: g.note,
              created_at: g.created_at,
              template_id: template.id,
              name: template.name,
              category: template.category,
              weight: template.weight,
              weight_mode: template.weight_mode || "points",
              template_max_points: template.max_points ?? null,
              date: template.date,
              description: template.description,
              subject_name: subjectName,
              class_subject: cls.subject,
              teacher_email: getTeacherEmailsForClassSubject(g.class_id, template.subject_id).join(", "),
              attachment_path: g.attachment_path || null,
              attachment_original_name: g.attachment_original_name || null,
              attachment_mime: g.attachment_mime || null,
              attachment_size: g.attachment_size || null,
              external_link: g.external_link || null,
              is_absent: g.is_absent ? 1 : 0,
              is_special: 0
            };
          })
          .filter(Boolean);
        const specialRows = specialAssessments
          .filter((entry) => entry.student_id === Number(student_id))
          .filter((entry) => (!Number.isFinite(Number(class_id)) ? true : entry.class_id === Number(class_id)))
          .filter((entry) => (!hasTeacherScope ? true : entry.subject_id === subject_id))
          .map((entry) => {
            const cls = classes.find((c) => c.id === entry.class_id) || {};
            const subjectName = getClassSubjectLabel(entry.class_id, entry.subject_id);
            return {
              id: entry.id,
              grade: entry.grade,
              points_achieved: null,
              points_max: null,
              note: entry.description || null,
              created_at: entry.created_at,
              template_id: null,
              name: entry.name,
              category: entry.type,
              weight: entry.weight,
              weight_mode: null,
              template_max_points: null,
              date: entry.created_at,
              description: entry.description,
              subject_name: subjectName,
              class_subject: cls.subject,
              teacher_email: getTeacherEmailsForClassSubject(entry.class_id, entry.subject_id).join(", "),
              attachment_path: null,
              attachment_original_name: null,
              attachment_mime: null,
              attachment_size: null,
              external_link: null,
              is_absent: 0,
              is_special: 1
            };
          });
        rows = [...baseRows, ...specialRows];
      } else if (/FROM grades g[\s\S]*UNION ALL[\s\S]*special_assessments/i.test(sql) && /WHERE student\.class_id = \?/i.test(sql)) {
        const [class_id] = params;
        const studentIds = students.filter((s) => s.class_id === Number(class_id)).map((s) => s.id);
        const regularRows = grades
          .filter((g) => studentIds.includes(g.student_id))
          .map((g) => {
            const template = gradeTemplates.find((t) => t.id === g.grade_template_id) || {};
            return {
              subject: getClassSubjectLabel(g.class_id, template.subject_id),
              value: g.grade,
              weight: template.weight,
              is_absent: g.is_absent ? 1 : 0
            };
          });
        const specialRows = specialAssessments
          .filter((entry) => entry.class_id === Number(class_id))
          .map((entry) => ({
            subject: getClassSubjectLabel(entry.class_id, entry.subject_id),
            value: entry.grade,
            weight: entry.weight,
            is_absent: 0
          }));
        rows = [...regularRows, ...specialRows];
      } else if (/FROM participation_marks\s+WHERE class_id = \? AND subject_id = \? AND student_id = \?\s+ORDER BY created_at DESC/i.test(sql)) {
        const [class_id, subject_id, student_id] = params;
        rows = participationMarks
          .filter(
            (entry) =>
              entry.class_id === Number(class_id) &&
              entry.subject_id === normalizeOptionalId(subject_id) &&
              entry.student_id === Number(student_id)
          )
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((entry) => ({
            id: entry.id,
            student_id: entry.student_id,
            class_id: entry.class_id,
            subject_id: entry.subject_id,
            symbol: entry.symbol,
            note: entry.note,
            created_at: entry.created_at
          }));
      } else if (/FROM participation_marks\s+WHERE class_id = \? AND student_id = \?\s+ORDER BY created_at DESC/i.test(sql)) {
        const [class_id, student_id] = params;
        rows = participationMarks
          .filter(
            (entry) =>
              entry.class_id === Number(class_id) && entry.student_id === Number(student_id)
          )
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((entry) => ({
            id: entry.id,
            student_id: entry.student_id,
            class_id: entry.class_id,
            symbol: entry.symbol,
            note: entry.note,
            created_at: entry.created_at
          }));
      } else if (/SELECT gm\.id, gm\.grade_id, gm\.student_message, gm\.teacher_reply, gm\.teacher_reply_by_email, gm\.teacher_reply_seen_at, gm\.student_hidden_at, gm\.created_at, gm\.replied_at\s+FROM grade_messages gm\s+JOIN grades g ON g\.id = gm\.grade_id\s+WHERE gm\.student_id = \? AND g\.student_id = \?\s+ORDER BY gm\.created_at ASC/i.test(sql)) {
        const [student_id, gradeStudentId] = params;
        rows = gradeMessages
          .filter((entry) => entry.student_id === Number(student_id))
          .filter((entry) => {
            const grade = grades.find((gradeEntry) => gradeEntry.id === Number(entry.grade_id));
            return grade && grade.student_id === Number(gradeStudentId);
          })
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .map((entry) => ({
            id: entry.id,
            grade_id: entry.grade_id,
            student_message: entry.student_message,
            teacher_reply: entry.teacher_reply,
            teacher_reply_by_email: entry.teacher_reply_by_email || null,
            teacher_reply_seen_at: entry.teacher_reply_seen_at,
            student_hidden_at: entry.student_hidden_at || null,
            created_at: entry.created_at,
            replied_at: entry.replied_at
          }));
      } else if (/SELECT gm\.id, gm\.grade_id, gm\.student_id, gm\.student_message, gm\.teacher_reply, gm\.teacher_reply_by_email, gm\.student_hidden_at, gm\.created_at, gm\.replied_at,\s+s\.name AS student_name, s\.email AS student_email, gt\.name AS test_name, g\.grade AS grade_value\s+FROM grade_messages gm\s+JOIN grades g ON g\.id = gm\.grade_id\s+JOIN students s ON s\.id = gm\.student_id\s+LEFT JOIN grade_templates gt ON gt\.id = g\.grade_template_id\s+WHERE g\.class_id = \? AND s\.class_id = \?( AND gt\.subject_id = \?)?\s+ORDER BY gm\.created_at ASC/i.test(sql)) {
        const [class_id, studentClassId, subject_id] = params;
        rows = gradeMessages
          .filter((entry) => {
            const grade = grades.find((gradeEntry) => gradeEntry.id === Number(entry.grade_id));
            const student = students.find((studentEntry) => studentEntry.id === Number(entry.student_id));
            const template = gradeTemplates.find(
              (templateEntry) => templateEntry.id === Number(grade?.grade_template_id)
            );
            return (
              grade &&
              student &&
              grade.class_id === Number(class_id) &&
              student.class_id === Number(studentClassId) &&
              (subject_id == null || template?.subject_id === normalizeOptionalId(subject_id))
            );
          })
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .map((entry) => {
            const grade = grades.find((gradeEntry) => gradeEntry.id === Number(entry.grade_id));
            const student = students.find((studentEntry) => studentEntry.id === Number(entry.student_id));
            const template = gradeTemplates.find(
              (templateEntry) => templateEntry.id === Number(grade?.grade_template_id)
            );
            return {
              id: entry.id,
              grade_id: entry.grade_id,
              student_id: entry.student_id,
              student_message: entry.student_message,
              teacher_reply: entry.teacher_reply,
              teacher_reply_by_email: entry.teacher_reply_by_email || null,
              student_hidden_at: entry.student_hidden_at || null,
              created_at: entry.created_at,
              replied_at: entry.replied_at,
              student_name: student?.name || "",
              student_email: student?.email || "",
              test_name: template?.name || null,
              grade_value: grade?.grade ?? null
            };
          });
      } else if (/SELECT gm\.id, gm\.grade_id, gm\.student_message, gm\.teacher_reply, gm\.teacher_reply_by_email, gm\.student_hidden_at, gm\.created_at, gm\.replied_at\s+FROM grade_messages gm\s+JOIN grades g ON g\.id = gm\.grade_id\s+JOIN grade_templates gt ON gt\.id = g\.grade_template_id\s+WHERE g\.class_id = \? AND gt\.subject_id = \? AND g\.student_id = \? AND gm\.student_id = \?\s+ORDER BY gm\.created_at ASC/i.test(sql)) {
        const [class_id, subject_id, gradeStudentId, messageStudentId] = params;
        rows = gradeMessages
          .filter((entry) => entry.student_id === Number(messageStudentId))
          .filter((entry) => {
            const grade = grades.find((gradeEntry) => gradeEntry.id === Number(entry.grade_id));
            const template = gradeTemplates.find(
              (templateEntry) => templateEntry.id === Number(grade?.grade_template_id)
            );
            return (
              grade &&
              template &&
              grade.class_id === Number(class_id) &&
              template.subject_id === normalizeOptionalId(subject_id) &&
              grade.student_id === Number(gradeStudentId)
            );
          })
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
          .map((entry) => ({
            id: entry.id,
            grade_id: entry.grade_id,
            student_message: entry.student_message,
            teacher_reply: entry.teacher_reply,
            teacher_reply_by_email: entry.teacher_reply_by_email || null,
            student_hidden_at: entry.student_hidden_at || null,
            created_at: entry.created_at,
            replied_at: entry.replied_at
          }));
      } else if (/SELECT id, message, type, created_at, read_at FROM grade_notifications WHERE student_id = \? ORDER BY created_at DESC/i.test(sql)) {
        const [student_id] = params;
        rows = notifications
          .filter((n) => n.student_id === Number(student_id))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((n) => ({ ...n }));
      } else if (/FROM audit_logs/i.test(sql)) {
        const hasActorFilter = /LOWER\(actor_email\) LIKE LOWER\(\?\)/i.test(sql);
        const hasActionFilter = /LOWER\(action\) LIKE LOWER\(\?\)/i.test(sql);
        const hasEntityFilter = /LOWER\(entity_type\) = LOWER\(\?\)/i.test(sql);
        const hasBeforeIdFilter = /id < \?/i.test(sql);
        const hasAfterIdFilter = /id > \?/i.test(sql);
        const hasLimit = /LIMIT \?/i.test(sql);
        let index = 0;
        const actorNeedle = hasActorFilter
          ? String(params[index++] || "").replace(/%/g, "").toLowerCase()
          : null;
        const actionNeedle = hasActionFilter
          ? String(params[index++] || "").replace(/%/g, "").toLowerCase()
          : null;
        const entityNeedle = hasEntityFilter ? String(params[index++] || "").toLowerCase() : null;
        const beforeId = hasBeforeIdFilter ? Number(params[index++]) : null;
        const afterId = hasAfterIdFilter ? Number(params[index++]) : null;
        const limit = hasLimit ? Number(params[index++]) : 300;

        rows = auditLogs
          .filter((entry) =>
            !actorNeedle ? true : String(entry.actor_email || "").toLowerCase().includes(actorNeedle)
          )
          .filter((entry) =>
            !actionNeedle ? true : String(entry.action || "").toLowerCase().includes(actionNeedle)
          )
          .filter((entry) =>
            !entityNeedle ? true : String(entry.entity_type || "").toLowerCase() === entityNeedle
          )
          .filter((entry) => (!Number.isFinite(beforeId) ? true : Number(entry.id) < beforeId))
          .filter((entry) => (!Number.isFinite(afterId) ? true : Number(entry.id) > afterId))
          .sort((a, b) => Number(b.id) - Number(a.id))
          .slice(0, Number.isFinite(limit) ? Math.max(1, limit) : 300)
          .map((entry) => ({ ...entry }));
      } else if (/SELECT id, name, subject, teacher_id FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const cls = classes.find((c) => c.id === Number(id));
        rows = cls ? [{ ...cls }] : [];
      } else if (/SELECT .* FROM grade_templates/i.test(sql) && /WHERE (gt\.)?class_id = \?/i.test(sql)) {
        const [clsId, subjectId] = params;
        const wantsArchived = /archived_at IS NOT NULL/i.test(sql);
        const wantsActiveOnly = /archived_at IS NULL/i.test(sql) && !wantsArchived;
        const sortDescending = /ORDER BY date DESC, name/i.test(sql);
        const hasSubjectFilter = /subject_id = \?/i.test(sql) && params.length > 1;
        rows = gradeTemplates
          .filter((t) => t.class_id === Number(clsId))
          .filter((t) => (!hasSubjectFilter ? true : t.subject_id === normalizeOptionalId(subjectId)))
          .filter((t) => (wantsArchived ? Boolean(t.archived_at) : wantsActiveOnly ? !t.archived_at : true))
          .sort((a, b) => {
            if (a.date && b.date && a.date !== b.date) {
              const delta = new Date(a.date) - new Date(b.date);
              return sortDescending ? -delta : delta;
            }
            if (a.date && !b.date) return sortDescending ? -1 : 1;
            if (!a.date && b.date) return sortDescending ? 1 : -1;
            return a.name.localeCompare(b.name);
          })
          .map((t) => ({
            ...t,
            subject_name: getClassSubjectLabel(t.class_id, t.subject_id),
            weight_mode: t.weight_mode || "points",
            max_points: t.max_points ?? null
          }));
      } else if (/FROM special_assessments sa\s+JOIN students s ON s\.id = sa\.student_id\s+WHERE sa\.class_id = \?( AND sa\.subject_id = \?)?/i.test(sql)) {
        const [clsId, subjectId] = params;
        rows = specialAssessments
          .filter((entry) => entry.class_id === Number(clsId))
          .filter((entry) => (subjectId == null ? true : entry.subject_id === normalizeOptionalId(subjectId)))
          .map((entry) => {
            const student = students.find((s) => s.id === entry.student_id);
            return {
              id: entry.id,
              student_id: entry.student_id,
              student_name: student?.name || "",
              type: entry.type,
              name: entry.name,
              description: entry.description,
              weight: entry.weight,
              grade: entry.grade,
              subject_id: entry.subject_id,
              created_at: entry.created_at
            };
          })
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      } else if (/SELECT id FROM grade_templates WHERE id = \? AND class_id = \?( AND subject_id = \?)?/i.test(sql)) {
        const [templateId, clsId, subjectId] = params;
        const template = gradeTemplates.find(
          (t) =>
            t.id === Number(templateId) &&
            t.class_id === Number(clsId) &&
            (subjectId == null || t.subject_id === normalizeOptionalId(subjectId))
        );
        rows = template ? [{ id: template.id }] : [];
      } else if (/PRAGMA table_info\(users\)/i.test(sql) || /PRAGMA table_info\(students\)/i.test(sql)) {
        rows = [];
      }

      if (typeof cb === "function") cb(null, rows);
    }
  };

  function seedAdmin() {
    if (!seedAdminEnabled) return;
    const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
    const ADMIN_PASS = process.env.ADMIN_PASS;
    if (!ADMIN_EMAIL || !ADMIN_PASS) {
      throw new Error("SEED_ADMIN requires ADMIN_EMAIL and ADMIN_PASS.");
    }
    if (users.some((u) => u.role === "admin")) return;
    const hash = hashPassword(ADMIN_PASS);
    db.run(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [ADMIN_EMAIL, hash, "admin", "active", 1],
      () => {}
    );
  }

  function seedDemoStudent() {
    if (!seedDemoEnabled) return;
    const teacherEmail = process.env.DEMO_TEACHER_EMAIL || "teacher@example.com";
    const studentEmail = process.env.DEMO_STUDENT_EMAIL || "student@example.com";
    const teacherPass = process.env.DEMO_TEACHER_PASS;
    const studentPass = process.env.DEMO_STUDENT_PASS;
    if (!teacherPass || !studentPass) {
      throw new Error(
        "SEED_DEMO requires DEMO_TEACHER_PASS and DEMO_STUDENT_PASS."
      );
    }
    if (users.some((u) => u.email === teacherEmail || u.email === studentEmail)) return;

    const teacherHash = hashPassword(teacherPass);
    const studentHash = hashPassword(studentPass);

    db.run(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [teacherEmail, teacherHash, "teacher", "active", 1],
      function () {
        const teacherId = this.lastID;
        db.run(
          "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
          [studentEmail, studentHash, "student", "active", 1],
          function () {
            db.run("INSERT INTO subjects (name) VALUES (?)", ["Informatik"], function () {
              const createdSubjectId = this.lastID;
              db.run(
                "INSERT INTO classes (name, subject, subject_id) VALUES (?,?,?)",
                ["3AHWII", "Informatik", createdSubjectId],
                function () {
                  const createdClassId = this.lastID;
                  db.run(
                    "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id) VALUES (?,?,?)",
                    [createdClassId, createdSubjectId, teacherId],
                    function () {
                      db.run(
                        "INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)",
                        ["Max Muster", studentEmail, createdClassId, "2024/25"],
                        function () {
                          const studentId = this.lastID;
                          const now = new Date();

                          db.run(
                            "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?,?)",
                            [
                              createdClassId,
                              createdSubjectId,
                              "SA 1",
                              "Schularbeit",
                              40,
                              new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString(),
                              "Schularbeit 1"
                            ]
                          );
                          db.run(
                            "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?,?)",
                            [
                              createdClassId,
                              createdSubjectId,
                              "Test 1",
                              "Test",
                              30,
                              new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString(),
                              "Wochentlicher Test"
                            ]
                          );
                          db.run(
                            "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?,?)",
                            [
                              createdClassId,
                              createdSubjectId,
                              "Mitarbeit",
                              "Mitarbeit",
                              30,
                              now.toISOString(),
                              "Aktive Teilnahme"
                            ]
                          );

                          db.run(
                            "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
                            [studentId, createdClassId, 1, 2, "Gute Struktur"]
                          );
                          db.run(
                            "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
                            [studentId, createdClassId, 2, 1.5, "Sauberer Code"]
                          );
                          db.run(
                            "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
                            [studentId, createdClassId, 3, 3, "Mehr Quellenangaben"]
                          );

                          db.run(
                            "INSERT INTO grade_notifications (student_id, message, type, created_at) VALUES (?,?,?,?)",
                            [studentId, "Neue Note in Informatik eingetragen.", "grade", now.toISOString()]
                          );
                        }
                      );
                    }
                  );
                }
              );
            });
          }
        );
      }
    );
  }

  seedAdmin();
  seedDemoStudent();
  return db;
}

if (useFakeDb) {
  const db = createFakeDb();
  const ready = Promise.resolve();
  module.exports = { db, hashPassword, verifyPassword, ready, pool: null, isFakeDb: true };
  return;
}

const useSsl = String(process.env.PGSSL || "true").toLowerCase() !== "false";
const verifySsl = String(process.env.PGSSL_VERIFY || "true").toLowerCase() !== "false";
const ssl = useSsl ? { rejectUnauthorized: verifySsl } : undefined;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  const missing = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    throw new Error(
      `Fehlende PostgreSQL-Umgebungsvariablen: ${missing.join(", ")}`
    );
  }
}


const pool = new Pool(
  connectionString
    ? { connectionString, ssl }
    : {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl,
        keepAlive:true,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      }
);

/*
const pool = new Pool(
   {
        host: process.env.PGHOST,
        port: Number(process.env.PGPORT),
        database: process.env.PGDATABASE,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,

      }
);
*/
// Prevent unhandled pool errors from crashing the process.
pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

function normalizeArgs(params, cb) {
  if (typeof params === "function") {
    return { params: [], cb: params };
  }
  return { params: params || [], cb };
}

function convertSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

const db = {
  serialize(fn) {
    fn();
  },
  run(sql, params, cb) {
    const { params: resolvedParams, cb: resolvedCb } = normalizeArgs(params, cb);
    const convertedSql = convertSql(sql);
    const needsReturning = /^\s*INSERT\s+/i.test(sql) && !/RETURNING\s+/i.test(sql);
    const querySql = needsReturning ? `${convertedSql} RETURNING id` : convertedSql;
    pool
      .query(querySql, resolvedParams)
      .then((result) => {
        if (typeof resolvedCb === "function") {
          const lastID = needsReturning ? result.rows[0]?.id : undefined;
          resolvedCb.call({ lastID }, null);
        }
      })
      .catch((err) => {
        if (typeof resolvedCb === "function") {
          resolvedCb(err);
        } else {
          console.error("DB run error:", err);
        }
      });
  },
  get(sql, params, cb) {
    const { params: resolvedParams, cb: resolvedCb } = normalizeArgs(params, cb);
    pool
      .query(convertSql(sql), resolvedParams)
      .then((result) => {
        resolvedCb(null, result.rows[0]);
      })
      .catch((err) => resolvedCb(err));
  },
  all(sql, params, cb) {
    const { params: resolvedParams, cb: resolvedCb } = normalizeArgs(params, cb);
    pool
      .query(convertSql(sql), resolvedParams)
      .then((result) => {
        resolvedCb(null, result.rows);
      })
      .catch((err) => resolvedCb(err));
  }
};

async function seedAdmin() {
  if (!seedAdminEnabled) return;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  if (!ADMIN_EMAIL || !ADMIN_PASS) {
    throw new Error("SEED_ADMIN requires ADMIN_EMAIL and ADMIN_PASS.");
  }

  const existing = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing.rowCount > 0) return;

  const hash = hashPassword(ADMIN_PASS);
  await pool.query(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES ($1, $2, 'admin', 'active', true)",
    [ADMIN_EMAIL, hash]
  );
  console.log("Seed-Admin angelegt:", ADMIN_EMAIL);
}

async function seedDemoData() {
  if (!seedDemoEnabled) return;
  const teacherEmail = process.env.DEMO_TEACHER_EMAIL || "teacher@example.com";
  const studentEmail = process.env.DEMO_STUDENT_EMAIL || "student@example.com";
  const teacherPass = process.env.DEMO_TEACHER_PASS;
  const studentPass = process.env.DEMO_STUDENT_PASS;
  if (!teacherPass || !studentPass) {
    throw new Error("SEED_DEMO requires DEMO_TEACHER_PASS and DEMO_STUDENT_PASS.");
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1 OR email = $2", [teacherEmail, studentEmail]);
  if (existing.rowCount > 0) return;

  const teacherHash = hashPassword(teacherPass);
  const teacherInsert = await pool.query(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES ($1, $2, 'teacher', 'active', true) RETURNING id",
    [teacherEmail, teacherHash]
  );
  const teacherId = teacherInsert.rows[0].id;

  const studentUser = await pool.query(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES ($1, $2, 'student', 'active', true) RETURNING id",
    [studentEmail, hashPassword(studentPass)]
  );
  const studentUserId = studentUser.rows[0].id;

  const subjectInsert = await pool.query(
    "INSERT INTO subjects (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    ["Informatik"]
  );
  const subjectId = subjectInsert.rows[0].id;
  const activeSchoolYearResult = await pool.query(
    "SELECT id, name FROM school_years WHERE is_active = TRUE ORDER BY id DESC LIMIT 1"
  );
  const activeSchoolYear = activeSchoolYearResult.rows[0];

  const classInsert = await pool.query(
    "INSERT INTO classes (name, subject, subject_id, school_year_id) VALUES ($1, $2, $3, $4) RETURNING id",
    ["3AHWII", "Informatik", subjectId, activeSchoolYear.id]
  );
  const classId = classInsert.rows[0].id;
  await pool.query(
    "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES ($1, $2, $3, $4) ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING",
    [classId, subjectId, teacherId, activeSchoolYear.id]
  );

  const studentInsert = await pool.query(
    "INSERT INTO students (name, email, class_id, school_year) VALUES ($1, $2, $3, $4) RETURNING id",
    ["Max Muster", studentEmail, classId, activeSchoolYear.name]
  );
  const studentId = studentInsert.rows[0].id;

  const now = new Date();
  const fourteenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString();
  const sevenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString();

  const templateOne = await pool.query(
    "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [classId, subjectId, "SA 1", "Schularbeit", 40, fourteenDays, "Schularbeit 1"]
  );
  const templateTwo = await pool.query(
    "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [classId, subjectId, "Test 1", "Test", 30, sevenDays, "Wöchentlicher Test"]
  );
  const templateThree = await pool.query(
    "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [classId, subjectId, "Mitarbeit", "Mitarbeit", 30, now.toISOString(), "Aktive Teilnahme"]
  );

  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note, school_year_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [studentId, classId, templateOne.rows[0].id, 2, "Gute Struktur", activeSchoolYear.id]
  );
  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note, school_year_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [studentId, classId, templateTwo.rows[0].id, 1.5, "Sauberer Code", activeSchoolYear.id]
  );
  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note, school_year_id) VALUES ($1, $2, $3, $4, $5, $6)",
    [studentId, classId, templateThree.rows[0].id, 3, "Mehr Quellenangaben", activeSchoolYear.id]
  );
  await pool.query(
    "INSERT INTO grade_notifications (student_id, message, type) VALUES ($1, $2, $3)",
    [studentId, "Neue Note in Informatik eingetragen.", "grade"]
  );
  await pool.query(
    "INSERT INTO grade_notifications (student_id, message, type) VALUES ($1, $2, $3)",
    [studentId, "Dein Notendurchschnitt hat sich verbessert!", "average"]
  );

  console.log("Demo-Daten für Teacher/Student angelegt:", studentUserId);
}

async function initializeDatabase() {
  const defaultSchoolYear = getDefaultSchoolYearWindow();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','deleted')),
      must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS school_years (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS school_years_single_active_idx ON school_years (is_active) WHERE is_active = TRUE"
  );
  await pool.query(
    `INSERT INTO school_years (name, start_date, end_date, is_active)
     SELECT $1, $2, $3, TRUE
     WHERE NOT EXISTS (SELECT 1 FROM school_years)`,
    [defaultSchoolYear.name, defaultSchoolYear.startDate, defaultSchoolYear.endDate]
  );
  await pool.query(`
    UPDATE school_years
    SET is_active = TRUE
    WHERE id = (
      SELECT id
      FROM school_years
      ORDER BY start_date DESC, id DESC
      LIMIT 1
    )
    AND NOT EXISTS (
      SELECT 1 FROM school_years WHERE is_active = TRUE
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT,
      school_year_id INTEGER REFERENCES school_years(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "ALTER TABLE classes ALTER COLUMN subject DROP NOT NULL"
  );
  await pool.query(
    "ALTER TABLE classes ADD COLUMN IF NOT EXISTS teacher_id INTEGER"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS classes_teacher_id_idx ON classes (teacher_id)"
  );
  await pool.query(
    "ALTER TABLE classes ADD COLUMN IF NOT EXISTS head_teacher_id INTEGER"
  );

  const legacyClassTeacherTable = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'class_subject_teacher'
    ) AS exists
  `);

  if (legacyClassTeacherTable.rows[0]?.exists) {
    await pool.query(`
      UPDATE classes c
      SET teacher_id = legacy.teacher_id
      FROM (
        SELECT class_id, MIN(teacher_id) AS teacher_id
        FROM class_subject_teacher
        GROUP BY class_id
      ) AS legacy
      WHERE c.id = legacy.class_id AND c.teacher_id IS NULL
    `);
  }
  await pool.query(`
    UPDATE classes
    SET head_teacher_id = teacher_id
    WHERE head_teacher_id IS NULL AND teacher_id IS NOT NULL
  `);

  const missingTeacherIds = await pool.query(
    "SELECT id FROM classes WHERE teacher_id IS NULL LIMIT 1"
  );
  if (missingTeacherIds.rowCount > 0) {
    console.warn(
      `Warning: classes.teacher_id is NULL for class ${missingTeacherIds.rows[0].id}. ` +
      "Assigning placeholder via first active teacher."
    );
    await pool.query(`
      UPDATE classes
      SET teacher_id = (
        SELECT id FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY id LIMIT 1
      )
      WHERE teacher_id IS NULL
    `);
  }

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'classes_head_teacher_id_fkey'
      ) THEN
        ALTER TABLE classes
        ADD CONSTRAINT classes_head_teacher_id_fkey
        FOREIGN KEY (head_teacher_id) REFERENCES users(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS classes_head_teacher_id_idx ON classes (head_teacher_id)"
  );

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE t.relname = 'classes'
          AND c.contype = 'f'
          AND a.attname = 'teacher_id'
      ) THEN
        ALTER TABLE classes
        ADD CONSTRAINT classes_teacher_id_fkey
        FOREIGN KEY (teacher_id) REFERENCES users(id);
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE classes ALTER COLUMN teacher_id SET NOT NULL"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subjects (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "ALTER TABLE classes ADD COLUMN IF NOT EXISTS subject_id INTEGER"
  );
  await pool.query(
    "INSERT INTO subjects (name) SELECT DISTINCT subject FROM classes WHERE subject IS NOT NULL AND TRIM(subject) <> '' ON CONFLICT (name) DO NOTHING"
  );
  await pool.query(`
    UPDATE classes c
    SET subject_id = s.id
    FROM subjects s
    WHERE c.subject_id IS NULL
      AND LOWER(TRIM(c.subject)) = LOWER(TRIM(s.name))
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'classes_subject_id_fkey'
      ) THEN
        ALTER TABLE classes
        ADD CONSTRAINT classes_subject_id_fkey
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE classes ADD COLUMN IF NOT EXISTS school_year_id INTEGER"
  );
  await pool.query(`
    UPDATE classes
    SET school_year_id = (
      SELECT id
      FROM school_years
      WHERE is_active = TRUE
      ORDER BY id DESC
      LIMIT 1
    )
    WHERE school_year_id IS NULL
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'classes_school_year_id_fkey'
      ) THEN
        ALTER TABLE classes
        ADD CONSTRAINT classes_school_year_id_fkey
        FOREIGN KEY (school_year_id) REFERENCES school_years(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE classes ALTER COLUMN school_year_id SET NOT NULL"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS classes_school_year_idx ON classes (school_year_id)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS class_subject_teacher (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      school_year_id INTEGER REFERENCES school_years(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (class_id, subject_id, teacher_id)
    )
  `);
  await pool.query(
    "ALTER TABLE class_subject_teacher ADD COLUMN IF NOT EXISTS school_year_id INTEGER"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS class_subject_teacher_teacher_idx ON class_subject_teacher (teacher_id)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS class_subject_teacher_class_subject_idx ON class_subject_teacher (class_id, subject_id)"
  );
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'teaching_assignments'
      ) THEN
        INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id)
        SELECT ta.class_id, ta.subject_id, ta.teacher_id, c.school_year_id
        FROM teaching_assignments ta
        JOIN classes c ON c.id = ta.class_id
        ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING;
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'classes' AND column_name = 'teacher_id'
      ) THEN
        INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id)
        SELECT c.id, c.subject_id, c.teacher_id, c.school_year_id
        FROM classes c
        WHERE c.teacher_id IS NOT NULL AND c.subject_id IS NOT NULL
        ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING;
      END IF;
    END $$;
  `);
  await pool.query(`
    UPDATE class_subject_teacher cst
    SET school_year_id = c.school_year_id
    FROM classes c
    WHERE c.id = cst.class_id AND cst.school_year_id IS NULL
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'class_subject_teacher_school_year_id_fkey'
      ) THEN
        ALTER TABLE class_subject_teacher
        ADD CONSTRAINT class_subject_teacher_school_year_id_fkey
        FOREIGN KEY (school_year_id) REFERENCES school_years(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE class_subject_teacher ALTER COLUMN school_year_id SET NOT NULL"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS class_subject_teacher_school_year_idx ON class_subject_teacher (school_year_id)"
  );
  await pool.query("DROP TABLE IF EXISTS teaching_assignments");
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'classes' AND column_name = 'teacher_id'
      ) THEN
        ALTER TABLE classes DROP COLUMN teacher_id;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS archives (
      id SERIAL PRIMARY KEY,
      school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
      archive_type TEXT NOT NULL,
      entity_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rollover_logs (
      id SERIAL PRIMARY KEY,
      executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      old_school_year TEXT NOT NULL,
      new_school_year TEXT NOT NULL,
      status TEXT NOT NULL,
      backup_path TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      school_year TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (email, class_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teacher_grading_profiles (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      weight_mode TEXT NOT NULL DEFAULT 'points' CHECK (weight_mode IN ('percent', 'points')),
      scoring_mode TEXT NOT NULL DEFAULT 'points_or_grade' CHECK (scoring_mode IN ('grade_only', 'points_only', 'points_or_grade', 'points_and_grade')),
      absence_mode TEXT NOT NULL DEFAULT 'include_zero' CHECK (absence_mode IN ('include_zero', 'exclude')),
      grade1_min_percent NUMERIC NOT NULL DEFAULT 88.5,
      grade2_min_percent NUMERIC NOT NULL DEFAULT 75,
      grade3_min_percent NUMERIC NOT NULL DEFAULT 62.5,
      grade4_min_percent NUMERIC NOT NULL DEFAULT 50,
      ma_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ma_weight NUMERIC NOT NULL DEFAULT 5,
      ma_grade_plus NUMERIC NOT NULL DEFAULT 1.5,
      ma_grade_plus_tilde NUMERIC NOT NULL DEFAULT 2.5,
      ma_grade_neutral NUMERIC NOT NULL DEFAULT 3,
      ma_grade_minus_tilde NUMERIC NOT NULL DEFAULT 3.5,
      ma_grade_minus NUMERIC NOT NULL DEFAULT 4.5,
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS scoring_mode TEXT"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET scoring_mode = 'points_or_grade' WHERE scoring_mode IS NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN scoring_mode SET DEFAULT 'points_or_grade'"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN scoring_mode SET NOT NULL"
  );
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'teacher_grading_profiles_scoring_mode_check'
      ) THEN
        ALTER TABLE teacher_grading_profiles
        ADD CONSTRAINT teacher_grading_profiles_scoring_mode_check
        CHECK (scoring_mode IN ('grade_only', 'points_only', 'points_or_grade', 'points_and_grade'));
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS absence_mode TEXT"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET absence_mode = 'include_zero' WHERE absence_mode IS NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN absence_mode SET DEFAULT 'include_zero'"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN absence_mode SET NOT NULL"
  );
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'teacher_grading_profiles_absence_mode_check'
      ) THEN
        ALTER TABLE teacher_grading_profiles
        ADD CONSTRAINT teacher_grading_profiles_absence_mode_check
        CHECK (absence_mode IN ('include_zero', 'exclude'));
      END IF;
    END $$;
  `);

  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS grade1_min_percent NUMERIC DEFAULT 88.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS grade2_min_percent NUMERIC DEFAULT 75"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS grade3_min_percent NUMERIC DEFAULT 62.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS grade4_min_percent NUMERIC DEFAULT 50"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET grade1_min_percent = 88.5 WHERE grade1_min_percent IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET grade2_min_percent = 75 WHERE grade2_min_percent IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET grade3_min_percent = 62.5 WHERE grade3_min_percent IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET grade4_min_percent = 50 WHERE grade4_min_percent IS NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade1_min_percent SET DEFAULT 88.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade2_min_percent SET DEFAULT 75"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade3_min_percent SET DEFAULT 62.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade4_min_percent SET DEFAULT 50"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade1_min_percent SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade2_min_percent SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade3_min_percent SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN grade4_min_percent SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS ma_enabled BOOLEAN DEFAULT FALSE"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS ma_weight NUMERIC DEFAULT 5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS ma_grade_plus NUMERIC DEFAULT 1.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS ma_grade_plus_tilde NUMERIC DEFAULT 2.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS ma_grade_neutral NUMERIC DEFAULT 3"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS ma_grade_minus_tilde NUMERIC DEFAULT 3.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD COLUMN IF NOT EXISTS ma_grade_minus NUMERIC DEFAULT 4.5"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET ma_enabled = FALSE WHERE ma_enabled IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET ma_weight = 5 WHERE ma_weight IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET ma_grade_plus = 1.5 WHERE ma_grade_plus IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET ma_grade_plus_tilde = 2.5 WHERE ma_grade_plus_tilde IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET ma_grade_neutral = 3 WHERE ma_grade_neutral IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET ma_grade_minus_tilde = 3.5 WHERE ma_grade_minus_tilde IS NULL"
  );
  await pool.query(
    "UPDATE teacher_grading_profiles SET ma_grade_minus = 4.5 WHERE ma_grade_minus IS NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_enabled SET DEFAULT FALSE"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_weight SET DEFAULT 5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_plus SET DEFAULT 1.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_plus_tilde SET DEFAULT 2.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_neutral SET DEFAULT 3"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_minus_tilde SET DEFAULT 3.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_minus SET DEFAULT 4.5"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_enabled SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_weight SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_plus SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_plus_tilde SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_neutral SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_minus_tilde SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ALTER COLUMN ma_grade_minus SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles DROP CONSTRAINT IF EXISTS teacher_grading_profiles_ma_weight_check"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD CONSTRAINT teacher_grading_profiles_ma_weight_check CHECK (ma_weight >= 0)"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles DROP CONSTRAINT IF EXISTS teacher_grading_profiles_ma_grade_plus_check"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD CONSTRAINT teacher_grading_profiles_ma_grade_plus_check CHECK (ma_grade_plus >= 1 AND ma_grade_plus <= 5)"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles DROP CONSTRAINT IF EXISTS teacher_grading_profiles_ma_grade_plus_tilde_check"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD CONSTRAINT teacher_grading_profiles_ma_grade_plus_tilde_check CHECK (ma_grade_plus_tilde >= 1 AND ma_grade_plus_tilde <= 5)"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles DROP CONSTRAINT IF EXISTS teacher_grading_profiles_ma_grade_neutral_check"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD CONSTRAINT teacher_grading_profiles_ma_grade_neutral_check CHECK (ma_grade_neutral >= 1 AND ma_grade_neutral <= 5)"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles DROP CONSTRAINT IF EXISTS teacher_grading_profiles_ma_grade_minus_tilde_check"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD CONSTRAINT teacher_grading_profiles_ma_grade_minus_tilde_check CHECK (ma_grade_minus_tilde >= 1 AND ma_grade_minus_tilde <= 5)"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles DROP CONSTRAINT IF EXISTS teacher_grading_profiles_ma_grade_minus_check"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profiles ADD CONSTRAINT teacher_grading_profiles_ma_grade_minus_check CHECK (ma_grade_minus >= 1 AND ma_grade_minus <= 5)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teacher_grading_profile_items (
      id SERIAL PRIMARY KEY,
      profile_id INTEGER NOT NULL REFERENCES teacher_grading_profiles(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      weight NUMERIC NOT NULL CHECK (weight >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (profile_id, category)
    )
  `);
  await pool.query(
    "ALTER TABLE teacher_grading_profile_items DROP CONSTRAINT IF EXISTS teacher_grading_profile_items_weight_check"
  );
  await pool.query(
    "ALTER TABLE teacher_grading_profile_items ADD CONSTRAINT teacher_grading_profile_items_weight_check CHECK (weight >= 0)"
  );

  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS teacher_grading_profiles_name_idx ON teacher_grading_profiles (teacher_id, name)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_templates (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('Schularbeit', 'Test', 'Wiederholung', 'Mitarbeit', 'Projekt', 'Hausübung')),
      weight NUMERIC NOT NULL CHECK (weight >= 0),
      max_points NUMERIC,
      date TIMESTAMPTZ,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    "ALTER TABLE grade_templates DROP CONSTRAINT IF EXISTS grade_templates_weight_check"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD CONSTRAINT grade_templates_weight_check CHECK (weight >= 0)"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS description TEXT"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS date TIMESTAMPTZ"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS weight_mode TEXT"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS max_points NUMERIC"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD COLUMN IF NOT EXISTS subject_id INTEGER"
  );
  await pool.query(
    "UPDATE grade_templates SET weight_mode = 'points' WHERE weight_mode IS NULL"
  );
  await pool.query(`
    UPDATE grade_templates gt
    SET subject_id = c.subject_id
    FROM classes c
    WHERE c.id = gt.class_id
      AND gt.subject_id IS NULL
      AND c.subject_id IS NOT NULL
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'grade_templates_subject_id_fkey'
      ) THEN
        ALTER TABLE grade_templates
        ADD CONSTRAINT grade_templates_subject_id_fkey
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE grade_templates ALTER COLUMN weight_mode SET DEFAULT 'points'"
  );
  await pool.query(
    "ALTER TABLE grade_templates ALTER COLUMN weight_mode SET NOT NULL"
  );
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'grade_templates_weight_mode_check'
      ) THEN
        ALTER TABLE grade_templates
        ADD CONSTRAINT grade_templates_weight_mode_check
        CHECK (weight_mode IN ('percent', 'points'));
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE grade_templates DROP CONSTRAINT IF EXISTS grade_templates_max_points_check"
  );
  await pool.query(
    "ALTER TABLE grade_templates ADD CONSTRAINT grade_templates_max_points_check CHECK (max_points IS NULL OR max_points > 0)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS grade_templates_archived_at_idx ON grade_templates (archived_at)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS grade_templates_class_subject_idx ON grade_templates (class_id, subject_id, date)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grades (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      grade_template_id INTEGER NOT NULL REFERENCES grade_templates(id) ON DELETE CASCADE,
      school_year_id INTEGER REFERENCES school_years(id),
      grade NUMERIC NOT NULL CHECK (grade >= 1 AND grade <= 5),
      is_absent BOOLEAN NOT NULL DEFAULT FALSE,
      points_achieved NUMERIC,
      points_max NUMERIC,
      note TEXT,
      attachment_path TEXT,
      attachment_original_name TEXT,
      attachment_mime TEXT,
      attachment_size INTEGER,
      external_link TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, grade_template_id)
    )
  `);

  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS points_achieved NUMERIC"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS is_absent BOOLEAN DEFAULT FALSE"
  );
  await pool.query(
    "UPDATE grades SET is_absent = FALSE WHERE is_absent IS NULL"
  );
  await pool.query(
    "ALTER TABLE grades ALTER COLUMN is_absent SET DEFAULT FALSE"
  );
  await pool.query(
    "ALTER TABLE grades ALTER COLUMN is_absent SET NOT NULL"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS points_max NUMERIC"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_path TEXT"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_original_name TEXT"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_mime TEXT"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS attachment_size INTEGER"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS external_link TEXT"
  );
  await pool.query(
    "ALTER TABLE grades ADD COLUMN IF NOT EXISTS school_year_id INTEGER"
  );
  await pool.query(`
    UPDATE grades g
    SET school_year_id = c.school_year_id
    FROM classes c
    WHERE c.id = g.class_id AND g.school_year_id IS NULL
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'grades_school_year_id_fkey'
      ) THEN
        ALTER TABLE grades
        ADD CONSTRAINT grades_school_year_id_fkey
        FOREIGN KEY (school_year_id) REFERENCES school_years(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "ALTER TABLE grades ALTER COLUMN school_year_id SET NOT NULL"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS grades_school_year_idx ON grades (school_year_id)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_messages (
      id SERIAL PRIMARY KEY,
      grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      student_message TEXT NOT NULL,
      teacher_reply TEXT,
      teacher_reply_by_email TEXT,
      teacher_reply_seen_at TIMESTAMPTZ,
      student_hidden_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      replied_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    "ALTER TABLE grade_messages ADD COLUMN IF NOT EXISTS teacher_reply_by_email TEXT"
  );
  await pool.query(
    "ALTER TABLE grade_messages ADD COLUMN IF NOT EXISTS teacher_reply_seen_at TIMESTAMPTZ"
  );
  await pool.query(
    "ALTER TABLE grade_messages ADD COLUMN IF NOT EXISTS student_hidden_at TIMESTAMPTZ"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS grade_messages_student_idx ON grade_messages (student_id)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS grade_messages_grade_idx ON grade_messages (grade_id)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS special_assessments (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('Präsentation', 'Wunschprüfung', 'Benutzerdefiniert')),
      name TEXT NOT NULL,
      description TEXT,
      weight NUMERIC NOT NULL CHECK (weight >= 0),
      grade NUMERIC NOT NULL CHECK (grade >= 1 AND grade <= 5),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    "ALTER TABLE special_assessments DROP CONSTRAINT IF EXISTS special_assessments_weight_check"
  );
  await pool.query(
    "ALTER TABLE special_assessments ADD CONSTRAINT special_assessments_weight_check CHECK (weight >= 0)"
  );
  await pool.query(
    "ALTER TABLE special_assessments ADD COLUMN IF NOT EXISTS subject_id INTEGER"
  );
  await pool.query(`
    UPDATE special_assessments sa
    SET subject_id = c.subject_id
    FROM classes c
    WHERE c.id = sa.class_id
      AND sa.subject_id IS NULL
      AND c.subject_id IS NOT NULL
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'special_assessments_subject_id_fkey'
      ) THEN
        ALTER TABLE special_assessments
        ADD CONSTRAINT special_assessments_subject_id_fkey
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS special_assessments_class_subject_idx ON special_assessments (class_id, subject_id, created_at)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS participation_marks (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL CHECK (symbol IN ('plus', 'plus_tilde', 'neutral', 'minus_tilde', 'minus')),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "ALTER TABLE participation_marks DROP CONSTRAINT IF EXISTS participation_marks_symbol_check"
  );
  await pool.query(
    "ALTER TABLE participation_marks ADD CONSTRAINT participation_marks_symbol_check CHECK (symbol IN ('plus', 'plus_tilde', 'neutral', 'minus_tilde', 'minus'))"
  );
  await pool.query(
    "ALTER TABLE participation_marks ADD COLUMN IF NOT EXISTS subject_id INTEGER"
  );
  await pool.query(`
    UPDATE participation_marks pm
    SET subject_id = c.subject_id
    FROM classes c
    WHERE c.id = pm.class_id
      AND pm.subject_id IS NULL
      AND c.subject_id IS NOT NULL
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'participation_marks_subject_id_fkey'
      ) THEN
        ALTER TABLE participation_marks
        ADD CONSTRAINT participation_marks_subject_id_fkey
        FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS participation_marks_class_student_idx ON participation_marks (class_id, student_id, created_at)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS participation_marks_class_subject_student_idx ON participation_marks (class_id, subject_id, student_id, created_at)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS teacher_student_exclusions (
      id SERIAL PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      school_year_id INTEGER REFERENCES school_years(id) ON DELETE RESTRICT,
      excluded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (teacher_id, class_id, subject_id, student_id)
    )
  `);
  await pool.query(
    "ALTER TABLE teacher_student_exclusions ADD COLUMN IF NOT EXISTS school_year_id INTEGER"
  );
  await pool.query(`
    UPDATE teacher_student_exclusions tse
    SET school_year_id = c.school_year_id
    FROM classes c
    WHERE c.id = tse.class_id AND tse.school_year_id IS NULL
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'teacher_student_exclusions_school_year_id_fkey'
      ) THEN
        ALTER TABLE teacher_student_exclusions
        ADD CONSTRAINT teacher_student_exclusions_school_year_id_fkey
        FOREIGN KEY (school_year_id) REFERENCES school_years(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS teacher_student_exclusions_lookup_idx ON teacher_student_exclusions (teacher_id, class_id, subject_id, student_id)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS teacher_student_exclusions_class_subject_idx ON teacher_student_exclusions (class_id, subject_id)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_notifications (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    "ALTER TABLE grade_notifications DROP CONSTRAINT IF EXISTS grade_notifications_student_id_fkey"
  );
  await pool.query(`
    ALTER TABLE grade_notifications
    ADD CONSTRAINT grade_notifications_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS grade_notifications_student_idx ON grade_notifications (student_id)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      actor_user_id INTEGER REFERENCES users(id),
      actor_email TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      http_method TEXT NOT NULL,
      route_path TEXT NOT NULL,
      status_code INTEGER,
      ip_address TEXT,
      user_agent TEXT,
      payload TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at DESC)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_email, created_at DESC)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess JSONB NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire)"
  );

  await seedAdmin();
  await seedDemoData();
}

const ready = initializeDatabase().catch((err) => {
  console.error("Fehler beim Initialisieren der PostgreSQL-Datenbank:", err);
});

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  ready,
  pool,
  isFakeDb: false
};

