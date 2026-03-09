// db.js
const crypto = require("crypto");
const { Pool } = require("pg");

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
  const classes = [];
  const students = [];
  const gradeTemplates = [];
  const grades = [];
  const specialAssessments = [];
  const notifications = [];
  const participationMarks = [];
  const subjects = [];
  const teachingAssignments = [];
  const teacherGradingProfiles = [];
  const teacherGradingProfileItems = [];
  let userId = 1;
  let classId = 1;
  let studentId = 1;
  let gradeTemplateId = 1;
  let gradeId = 1;
  let specialAssessmentId = 1;
  let notificationId = 1;
  let participationMarkId = 1;
  let subjectId = 1;
  let teachingAssignmentId = 1;
  let gradingProfileId = 1;
  let gradingProfileItemId = 1;

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
      } else if (/UPDATE classes SET name = \?, subject = \?, subject_id = \? WHERE id = \?/i.test(sql)) {
        const [name, subject, subjId, id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          classRow.name = name;
          classRow.subject = subject;
          classRow.subject_id = Number(subjId);
        }
      } else if (/UPDATE classes SET name = \?, subject = \?, subject_id = \?, teacher_id = \? WHERE id = \?/i.test(sql)) {
        const [name, subject, subjId, teacher_id, id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        if (classRow) {
          classRow.name = name;
          classRow.subject = subject;
          classRow.subject_id = Number(subjId);
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
        const [name, subject, maybeSubjectId, maybeTeacherId] = params;
        const hasTeacherId = params.length >= 4;
        const hasSubjectId = params.length >= 3;
        const teacher_id = hasTeacherId ? Number(maybeTeacherId) : null;
        let resolvedSubjectId = hasSubjectId ? Number(maybeSubjectId) : null;
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
          subject,
          subject_id: resolvedSubjectId == null ? null : Number(resolvedSubjectId),
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
              created_at: new Date().toISOString()
            });
          }
        }
      } else if (/INSERT INTO (teaching_assignments|class_subject_teacher)/i.test(sql)) {
        const usesNewOrder = /INSERT INTO class_subject_teacher/i.test(sql);
        const [firstId, secondId, thirdId] = params;
        const resolvedClassId = usesNewOrder ? firstId : secondId;
        const subjId = usesNewOrder ? secondId : thirdId;
        const teacher_id = usesNewOrder ? thirdId : firstId;
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
      } else if (/DELETE FROM students WHERE class_id = \?/i.test(sql)) {
        const [classIdParam] = params;
        for (let i = students.length - 1; i >= 0; i -= 1) {
          if (students[i].class_id === Number(classIdParam)) students.splice(i, 1);
        }
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (specialAssessments[i].class_id === Number(classIdParam)) specialAssessments.splice(i, 1);
        }
        for (let i = participationMarks.length - 1; i >= 0; i -= 1) {
          if (participationMarks[i].class_id === Number(classIdParam)) {
            participationMarks.splice(i, 1);
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
        const [class_id, name, category, weight] = params;
        const hasMaxPoints = params.length >= 8;
        const hasWeightMode = params.length >= 7;
        const weight_mode = hasWeightMode ? params[4] : "points";
        const max_points = hasMaxPoints ? params[5] : null;
        const date = hasMaxPoints ? params[6] : hasWeightMode ? params[5] : params[4];
        const description = hasMaxPoints ? params[7] : hasWeightMode ? params[6] : params[5];
        const template = {
          id: gradeTemplateId++,
          class_id: Number(class_id),
          name,
          category,
          weight: Number(weight),
          weight_mode: String(weight_mode || "points"),
          max_points: max_points != null && max_points !== "" ? Number(max_points) : null,
          date: date || null,
          description: description || null,
          created_at: new Date().toISOString()
        };
        gradeTemplates.push(template);
        lastID = template.id;
      } else if (/UPDATE grade_templates SET name = \?, category = \?, weight = \?, max_points = \?, date = \?, description = \? WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [name, category, weight, max_points, date, description, id, class_id] = params;
        const template = gradeTemplates.find(
          (entry) => entry.id === Number(id) && entry.class_id === Number(class_id)
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
            created_at: new Date().toISOString()
          };
          grades.push(newGrade);
          lastID = newGrade.id;
        }
      } else if (/INSERT INTO special_assessments/i.test(sql)) {
        const [student_id, class_id, type, name, description, weight, grade] = params;
        const assessment = {
          id: specialAssessmentId++,
          student_id: Number(student_id),
          class_id: Number(class_id),
          type,
          name,
          description: description || null,
          weight: Number(weight),
          grade: Number(grade),
          created_at: new Date().toISOString()
        };
        specialAssessments.push(assessment);
        lastID = assessment.id;
      } else if (/DELETE FROM special_assessments WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [idParam, classIdParam] = params;
        for (let i = specialAssessments.length - 1; i >= 0; i -= 1) {
          if (
            specialAssessments[i].id === Number(idParam) &&
            specialAssessments[i].class_id === Number(classIdParam)
          ) {
            specialAssessments.splice(i, 1);
          }
        }
      } else if (/INSERT INTO participation_marks/i.test(sql)) {
        const [student_id, class_id, teacher_id, symbol, note] = params;
        const mark = {
          id: participationMarkId++,
          student_id: Number(student_id),
          class_id: Number(class_id),
          teacher_id: Number(teacher_id),
          symbol: String(symbol),
          note: note || null,
          created_at: new Date().toISOString()
        };
        participationMarks.push(mark);
        lastID = mark.id;
      } else if (/DELETE FROM participation_marks WHERE id = \? AND class_id = \? AND student_id = \?/i.test(sql)) {
        const [idParam, classIdParam, studentIdParam] = params;
        for (let i = participationMarks.length - 1; i >= 0; i -= 1) {
          if (
            participationMarks[i].id === Number(idParam) &&
            participationMarks[i].class_id === Number(classIdParam) &&
            participationMarks[i].student_id === Number(studentIdParam)
          ) {
            participationMarks.splice(i, 1);
          }
        }
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
      } else if (/SELECT id, name, subject, subject_id(, created_at)? FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const classRow = classes.find((c) => c.id === Number(id));
        row = classRow
          ? {
              id: classRow.id,
              name: classRow.name,
              subject: classRow.subject,
              subject_id: classRow.subject_id,
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
      } else if (/SELECT cst\.class_id, cst\.subject_id\s+FROM class_subject_teacher cst\s+WHERE cst\.teacher_id = \?/i.test(sql)) {
        const [teacher_id] = params;
        row = teachingAssignments
          .filter((entry) => entry.teacher_id === Number(teacher_id))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      } else if (/SELECT 1 AS allowed\s+FROM class_subject_teacher\s+WHERE teacher_id = \? AND class_id = \?\s+LIMIT 1/i.test(sql)) {
        const [teacher_id, class_id] = params;
        const match = teachingAssignments.find(
          (entry) => entry.teacher_id === Number(teacher_id) && entry.class_id === Number(class_id)
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
          const teacherEmails = getTeacherEmailsForClassSubject(classRow.id, classRow.subject_id).join(", ");
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
          if (assignment) {
            const activeProfile = teacherGradingProfiles
              .filter(
                (entry) =>
                  entry.teacher_id === Number(assignment.teacher_id) &&
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
      } else if (/SELECT id, name, category, weight, max_points, date, description FROM grade_templates WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [templateId, clsId] = params;
        const template = gradeTemplates.find(
          (entry) => entry.id === Number(templateId) && entry.class_id === Number(clsId)
        );
        row = template
          ? {
              id: template.id,
              name: template.name,
              category: template.category,
              weight: template.weight,
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
      } else if (/SELECT id FROM special_assessments WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [assessmentId, clsId] = params;
        const assessment = specialAssessments.find(
          (entry) => entry.id === Number(assessmentId) && entry.class_id === Number(clsId)
        );
        row = assessment ? { id: assessment.id } : undefined;
      } else if (/SELECT id, max_points FROM grade_templates WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [templateId, clsId] = params;
        const template = gradeTemplates.find(
          (entry) => entry.id === Number(templateId) && entry.class_id === Number(clsId)
        );
        row = template ? { id: template.id, max_points: template.max_points ?? null } : undefined;
      } else if (/SELECT id FROM grade_templates WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [templateId, clsId] = params;
        const template = gradeTemplates.find(
          (entry) => entry.id === Number(templateId) && entry.class_id === Number(clsId)
        );
        row = template ? { id: template.id } : undefined;
      } else if (/SELECT attachment_path FROM grades WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [gradeId, clsId] = params;
        const grade = grades.find(
          (entry) => entry.id === Number(gradeId) && entry.class_id === Number(clsId)
        );
        row = grade ? { attachment_path: grade.attachment_path || null } : undefined;
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
      if (/SELECT id, email, role, status, created_at, must_change_password FROM users ORDER BY id DESC/i.test(sql)) {
        rows = [...users]
          .sort((a, b) => b.id - a.id)
          .map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, created_at: u.created_at, must_change_password: u.must_change_password || 0 }));
      } else if (/SELECT id, name FROM subjects ORDER BY name ASC/i.test(sql)) {
        rows = [...subjects]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => ({ id: entry.id, name: entry.name }));
      } else if (/SELECT c.id, c.name, c.subject, c.subject_id\s+FROM classes c/i.test(sql)) {
        rows = [...classes]
          .sort((a, b) => `${a.name} ${a.subject}`.localeCompare(`${b.name} ${b.subject}`))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            subject: entry.subject,
            subject_id: entry.subject_id
          }));
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
      } else if (/SELECT grade_template_id FROM grades WHERE class_id = \? AND student_id = \?/i.test(sql)) {
        const [class_id, student_id] = params;
        rows = grades
          .filter(
            (entry) =>
              entry.class_id === Number(class_id) && entry.student_id === Number(student_id)
          )
          .map((entry) => ({ grade_template_id: entry.grade_template_id }));
      } else if (/FROM grades g[\s\S]*UNION ALL[\s\S]*special_assessments/i.test(sql) && /WHERE g\.student_id = \?/i.test(sql)) {
        const [student_id] = params;
        const baseRows = grades
          .filter((g) => g.student_id === Number(student_id))
          .map((g) => {
            const template = gradeTemplates.find((t) => t.id === g.grade_template_id) || {};
            const cls = classes.find((c) => c.id === g.class_id) || {};
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
              class_subject: cls.subject,
              attachment_path: g.attachment_path || null,
              attachment_original_name: g.attachment_original_name || null,
              attachment_mime: g.attachment_mime || null,
              attachment_size: g.attachment_size || null,
              external_link: g.external_link || null,
              is_absent: g.is_absent ? 1 : 0,
              is_special: 0
            };
          });
        const specialRows = specialAssessments
          .filter((entry) => entry.student_id === Number(student_id))
          .map((entry) => {
            const cls = classes.find((c) => c.id === entry.class_id) || {};
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
              class_subject: cls.subject,
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
      } else if (/FROM grades g[\s\S]*UNION ALL[\s\S]*special_assessments/i.test(sql) && /WHERE s\.class_id = \?/i.test(sql)) {
        const [class_id] = params;
        const studentIds = students.filter((s) => s.class_id === Number(class_id)).map((s) => s.id);
        const regularRows = grades
          .filter((g) => studentIds.includes(g.student_id))
          .map((g) => {
            const template = gradeTemplates.find((t) => t.id === g.grade_template_id) || {};
            return {
              subject: template.name,
              value: g.grade,
              weight: template.weight,
              is_absent: g.is_absent ? 1 : 0
            };
          });
        const specialRows = specialAssessments
          .filter((entry) => entry.class_id === Number(class_id))
          .map((entry) => ({
            subject: entry.name,
            value: entry.grade,
            weight: entry.weight,
            is_absent: 0
          }));
        rows = [...regularRows, ...specialRows];
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
      } else if (/SELECT id, message, type, created_at, read_at FROM grade_notifications WHERE student_id = \? ORDER BY created_at DESC/i.test(sql)) {
        const [student_id] = params;
        rows = notifications
          .filter((n) => n.student_id === Number(student_id))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          .map((n) => ({ ...n }));
      } else if (/SELECT id, name, subject, teacher_id FROM classes WHERE id = \?/i.test(sql)) {
        const [id] = params;
        const cls = classes.find((c) => c.id === Number(id));
        rows = cls ? [{ ...cls }] : [];
      } else if (/SELECT id, name, category, weight, (weight_mode, )?(max_points, )?date, description FROM grade_templates WHERE class_id = \? ORDER BY date, name/i.test(sql)) {
        const [clsId] = params;
        rows = gradeTemplates
          .filter((t) => t.class_id === Number(clsId))
          .sort((a, b) => {
            if (a.date && b.date && a.date !== b.date) return new Date(a.date) - new Date(b.date);
            return a.name.localeCompare(b.name);
          })
          .map((t) => ({
            ...t,
            weight_mode: t.weight_mode || "points",
            max_points: t.max_points ?? null
          }));
      } else if (/FROM special_assessments sa\s+JOIN students s ON s\.id = sa\.student_id\s+WHERE sa\.class_id = \?/i.test(sql)) {
        const [clsId] = params;
        rows = specialAssessments
          .filter((entry) => entry.class_id === Number(clsId))
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
              created_at: entry.created_at
            };
          })
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      } else if (/SELECT id FROM grade_templates WHERE id = \? AND class_id = \?/i.test(sql)) {
        const [templateId, clsId] = params;
        const template = gradeTemplates.find((t) => t.id === Number(templateId) && t.class_id === Number(clsId));
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
                            "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
                            [
                              createdClassId,
                              "SA 1",
                              "Schularbeit",
                              40,
                              new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString(),
                              "Schularbeit 1"
                            ]
                          );
                          db.run(
                            "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
                            [
                              createdClassId,
                              "Test 1",
                              "Test",
                              30,
                              new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString(),
                              "Wochentlicher Test"
                            ]
                          );
                          db.run(
                            "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
                            [
                              createdClassId,
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

  const classInsert = await pool.query(
    "INSERT INTO classes (name, subject, subject_id) VALUES ($1, $2, $3) RETURNING id",
    ["3AHWII", "Informatik", subjectId]
  );
  const classId = classInsert.rows[0].id;
  await pool.query(
    "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id) VALUES ($1, $2, $3) ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING",
    [classId, subjectId, teacherId]
  );

  const studentInsert = await pool.query(
    "INSERT INTO students (name, email, class_id, school_year) VALUES ($1, $2, $3, $4) RETURNING id",
    ["Max Muster", studentEmail, classId, "2024/25"]
  );
  const studentId = studentInsert.rows[0].id;

  const now = new Date();
  const fourteenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 14).toISOString();
  const sevenDays = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString();

  const templateOne = await pool.query(
    "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [classId, "SA 1", "Schularbeit", 40, fourteenDays, "Schularbeit 1"]
  );
  const templateTwo = await pool.query(
    "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [classId, "Test 1", "Test", 30, sevenDays, "Wöchentlicher Test"]
  );
  const templateThree = await pool.query(
    "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [classId, "Mitarbeit", "Mitarbeit", 30, now.toISOString(), "Aktive Teilnahme"]
  );

  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES ($1, $2, $3, $4, $5)",
    [studentId, classId, templateOne.rows[0].id, 2, "Gute Struktur"]
  );
  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES ($1, $2, $3, $4, $5)",
    [studentId, classId, templateTwo.rows[0].id, 1.5, "Sauberer Code"]
  );
  await pool.query(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES ($1, $2, $3, $4, $5)",
    [studentId, classId, templateThree.rows[0].id, 3, "Mehr Quellenangaben"]
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
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS class_subject_teacher (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (class_id, subject_id, teacher_id)
    )
  `);
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
        INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id)
        SELECT ta.class_id, ta.subject_id, ta.teacher_id
        FROM teaching_assignments ta
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
        INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id)
        SELECT c.id, c.subject_id, c.teacher_id
        FROM classes c
        WHERE c.teacher_id IS NOT NULL AND c.subject_id IS NOT NULL
        ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING;
      END IF;
    END $$;
  `);
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
    "UPDATE grade_templates SET weight_mode = 'points' WHERE weight_mode IS NULL"
  );
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grades (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      grade_template_id INTEGER NOT NULL REFERENCES grade_templates(id) ON DELETE CASCADE,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_messages (
      id SERIAL PRIMARY KEY,
      grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      student_message TEXT NOT NULL,
      teacher_reply TEXT,
      teacher_reply_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      replied_at TIMESTAMPTZ
    )
  `);
  await pool.query(
    "ALTER TABLE grade_messages ADD COLUMN IF NOT EXISTS teacher_reply_seen_at TIMESTAMPTZ"
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
    "CREATE INDEX IF NOT EXISTS participation_marks_class_student_idx ON participation_marks (class_id, student_id, created_at)"
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS grade_notifications (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    )
  `);

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
