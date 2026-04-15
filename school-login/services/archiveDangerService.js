const { pool, isFakeDb } = require("../db");
const schoolYearModel = require("../models/schoolYearModel");
const { allAsync, getAsync, runAsync } = require("../utils/dbAsync");

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function formatClassLabel(classRow) {
  const className = normalizeText(classRow?.name);
  const subject = normalizeText(classRow?.subject);
  if (className && subject) return `${className} / ${subject}`;
  return className || subject || "-";
}

function encodeSelectionKey(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64url");
}

function decodeSelectionKey(value) {
  try {
    return Buffer.from(String(value || ""), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function parseArrayInput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeText(entry)).filter(Boolean);
  }
  const singleValue = normalizeText(value);
  return singleValue ? [singleValue] : [];
}

function normalizePersonAction(value) {
  const normalized = normalizeKey(value);
  if (normalized === "include" || normalized === "exclude") return normalized;
  return "inherit";
}

function buildPersonSelectionMap(rawInput) {
  if (!rawInput || typeof rawInput !== "object") return {};
  return Object.fromEntries(
    Object.entries(rawInput)
      .map(([selectionKey, action]) => [normalizeText(selectionKey), normalizePersonAction(action)])
      .filter(([selectionKey]) => Boolean(selectionKey))
  );
}

function createQuestionSql(sql) {
  let parameterIndex = 0;
  return String(sql).replace(/\?/g, () => `$${++parameterIndex}`);
}

async function withDangerTransaction(callback) {
  if (!pool || isFakeDb) {
    return callback({
      run: (sql, params = []) => runAsync(sql, params),
      get: (sql, params = []) => getAsync(sql, params),
      all: (sql, params = []) => allAsync(sql, params)
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback({
      run: (sql, params = []) => client.query(createQuestionSql(sql), params),
      get: async (sql, params = []) => {
        const response = await client.query(createQuestionSql(sql), params);
        return response.rows[0] || null;
      },
      all: async (sql, params = []) => {
        const response = await client.query(createQuestionSql(sql), params);
        return response.rows;
      }
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listStudentMembershipsForClasses(classes) {
  const studentLists = await Promise.all(
    (classes || []).map((classRow) => schoolYearModel.listStudentsByClassId(classRow.id))
  );

  return (classes || []).flatMap((classRow, index) =>
    (studentLists[index] || []).map((studentRow) => ({
      id: Number(studentRow.id),
      name: normalizeText(studentRow.name),
      email: normalizeText(studentRow.email),
      emailKey: normalizeKey(studentRow.email),
      classId: Number(classRow.id),
      className: normalizeText(classRow.name),
      subject: normalizeText(classRow.subject),
      classLabel: formatClassLabel(classRow),
      schoolYearId: Number(classRow.school_year_id)
    }))
  );
}

async function loadAllStudentMemberships() {
  const schoolYears = await schoolYearModel.listSchoolYears();
  const classLists = await Promise.all(
    schoolYears.map((schoolYear) => schoolYearModel.listClassesBySchoolYear(schoolYear.id))
  );
  const classes = classLists.flat();
  return listStudentMembershipsForClasses(classes);
}

async function loadStudentUsers() {
  const rows = await allAsync(
    "SELECT id, email, role, status, created_at, must_change_password FROM users ORDER BY id DESC"
  );
  return (rows || [])
    .filter((row) => normalizeKey(row.role) === "student")
    .map((row) => ({
      id: Number(row.id),
      email: normalizeText(row.email),
      emailKey: normalizeKey(row.email),
      status: normalizeText(row.status) || "active"
    }));
}

function resolveSelectedArchivedSchoolYear(archivedSchoolYears, requestedSchoolYearId) {
  const requestedId = Number(requestedSchoolYearId);
  if (Number.isInteger(requestedId) && requestedId > 0) {
    const selected = archivedSchoolYears.find((schoolYear) => Number(schoolYear.id) === requestedId);
    if (selected) return selected;
  }
  return archivedSchoolYears[0] || null;
}

async function loadArchivedSchoolYearContext(requestedSchoolYearId) {
  const schoolYears = await schoolYearModel.listSchoolYears();
  const archivedSchoolYears = schoolYears.filter((schoolYear) => !schoolYear.is_active);
  const activeSchoolYear = schoolYears.find((schoolYear) => Boolean(schoolYear.is_active)) || null;
  const selectedSchoolYear = resolveSelectedArchivedSchoolYear(archivedSchoolYears, requestedSchoolYearId);

  return {
    schoolYears,
    archivedSchoolYears,
    activeSchoolYear,
    selectedSchoolYear
  };
}

async function loadArchivedSnapshot(schoolYearId) {
  const context = await loadArchivedSchoolYearContext(schoolYearId);
  const selectedSchoolYear = context.selectedSchoolYear;

  if (!selectedSchoolYear) {
    return {
      ...context,
      classes: [],
      students: [],
      assignments: [],
      grades: [],
      archiveEntries: []
    };
  }

  const [classes, assignments, grades, archiveEntries] = await Promise.all([
    schoolYearModel.listClassesBySchoolYear(selectedSchoolYear.id),
    schoolYearModel.listAssignmentRowsBySchoolYear(selectedSchoolYear.id),
    schoolYearModel.listGradesBySchoolYear(selectedSchoolYear.id),
    schoolYearModel.listArchivesBySchoolYear(selectedSchoolYear.id)
  ]);
  const students = await listStudentMembershipsForClasses(classes);

  return {
    ...context,
    classes,
    students,
    assignments,
    grades,
    archiveEntries
  };
}

function ensureArchivedSchoolYearSelected(snapshot) {
  if (!snapshot.selectedSchoolYear) {
    throw new Error("Es ist kein archiviertes Schuljahr verfügbar.");
  }
}

function buildClassStudentCounts(students) {
  const counts = new Map();
  (students || []).forEach((studentRow) => {
    const count = counts.get(studentRow.classId) || 0;
    counts.set(studentRow.classId, count + 1);
  });
  return counts;
}

function buildDeactivatedUserPreview({ selectedEmails, selectedMembershipIds, allMemberships, studentUsers }) {
  const selectedEmailSet = new Set((selectedEmails || []).map((entry) => normalizeKey(entry)));
  const selectedMembershipIdSet = new Set((selectedMembershipIds || []).map((entry) => Number(entry)));
  const membershipsByEmail = new Map();
  const userByEmail = new Map();

  (allMemberships || []).forEach((membership) => {
    const emailKey = normalizeKey(membership.email);
    const rows = membershipsByEmail.get(emailKey) || [];
    rows.push(membership);
    membershipsByEmail.set(emailKey, rows);
  });

  (studentUsers || []).forEach((userRow) => {
    if (!userByEmail.has(userRow.emailKey)) {
      userByEmail.set(userRow.emailKey, userRow);
    }
  });

  return [...selectedEmailSet]
    .map((emailKey) => {
      const allRows = membershipsByEmail.get(emailKey) || [];
      const userRow = userByEmail.get(emailKey);
      if (!allRows.length || !userRow) return null;

      const remainingRows = allRows.filter((row) => !selectedMembershipIdSet.has(Number(row.id)));
      if (remainingRows.length > 0) return null;

      return {
        id: Number(userRow.id),
        email: userRow.email,
        status: userRow.status
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.email.localeCompare(right.email, "de", { sensitivity: "base" }));
}

function buildArchiveDeleteConfirmationText(schoolYear) {
  return `ARCHIV LOESCHEN ${normalizeText(schoolYear?.name)}`;
}

function buildGraduateCleanupConfirmationText(schoolYear) {
  return `SCHULABGAENGER BEREINIGEN ${normalizeText(schoolYear?.name)}`;
}

async function getArchiveDeletePageData({ schoolYearId = null } = {}) {
  return loadArchivedSchoolYearContext(schoolYearId);
}

async function buildArchiveDeletePreview({ schoolYearId }) {
  const snapshot = await loadArchivedSnapshot(schoolYearId);
  ensureArchivedSchoolYearSelected(snapshot);

  const [allMemberships, studentUsers] = await Promise.all([
    loadAllStudentMemberships(),
    loadStudentUsers()
  ]);

  const classStudentCounts = buildClassStudentCounts(snapshot.students);
  const uniqueStudentEmails = [...new Set(snapshot.students.map((studentRow) => studentRow.emailKey))];
  const deactivatedUsers = buildDeactivatedUserPreview({
    selectedEmails: uniqueStudentEmails,
    selectedMembershipIds: snapshot.students.map((studentRow) => studentRow.id),
    allMemberships,
    studentUsers
  });

  return {
    ...snapshot,
    preview: {
      confirmationText: buildArchiveDeleteConfirmationText(snapshot.selectedSchoolYear),
      counts: {
        classCount: snapshot.classes.length,
        assignmentCount: snapshot.assignments.length,
        archiveEntryCount: snapshot.archiveEntries.length,
        gradeCount: snapshot.grades.length,
        membershipCount: snapshot.students.length,
        studentCount: uniqueStudentEmails.length,
        deactivatedUserCount: deactivatedUsers.length
      },
      classRows: snapshot.classes
        .map((classRow) => ({
          id: Number(classRow.id),
          classLabel: formatClassLabel(classRow),
          studentCount: Number(classStudentCounts.get(Number(classRow.id)) || 0),
          createdAt: classRow.created_at || null
        }))
        .sort((left, right) => left.classLabel.localeCompare(right.classLabel, "de", { sensitivity: "base" })),
      studentRows: [...snapshot.students.reduce((map, studentRow) => {
        if (!map.has(studentRow.emailKey)) {
          map.set(studentRow.emailKey, {
            name: studentRow.name,
            email: studentRow.email,
            classLabels: new Set()
          });
        }
        map.get(studentRow.emailKey).classLabels.add(studentRow.classLabel);
        return map;
      }, new Map()).values()]
        .map((entry) => ({
          name: entry.name,
          email: entry.email,
          classLabels: [...entry.classLabels].sort((left, right) => left.localeCompare(right, "de", { sensitivity: "base" }))
        }))
        .sort((left, right) => {
          const byName = left.name.localeCompare(right.name, "de", { sensitivity: "base" });
          if (byName !== 0) return byName;
          return left.email.localeCompare(right.email, "de", { sensitivity: "base" });
        }),
      deactivatedUsers
    }
  };
}

function buildGraduateClassGroups(studentRows) {
  const groups = new Map();

  (studentRows || []).forEach((studentRow) => {
    const className = normalizeText(studentRow.className);
    const classKey = normalizeKey(className);
    if (!className) return;

    if (!groups.has(classKey)) {
      groups.set(classKey, {
        className,
        selectionKey: encodeSelectionKey(className),
        emailKeys: new Set(),
        subjects: new Set(),
        membershipCount: 0
      });
    }

    const group = groups.get(classKey);
    group.emailKeys.add(studentRow.emailKey);
    if (studentRow.subject) group.subjects.add(studentRow.subject);
    group.membershipCount += 1;
  });

  return [...groups.values()]
    .map((group) => ({
      className: group.className,
      selectionKey: group.selectionKey,
      emailKeys: [...group.emailKeys],
      studentCount: group.emailKeys.size,
      membershipCount: group.membershipCount,
      subjects: [...group.subjects].sort((left, right) => left.localeCompare(right, "de", { sensitivity: "base" }))
    }))
    .sort((left, right) => left.className.localeCompare(right.className, "de", { sensitivity: "base" }));
}

function buildGraduatePersonRows(studentRows) {
  const people = new Map();

  (studentRows || []).forEach((studentRow) => {
    const emailKey = normalizeKey(studentRow.email);
    if (!emailKey) return;

    if (!people.has(emailKey)) {
      people.set(emailKey, {
        selectionKey: encodeSelectionKey(emailKey),
        email: studentRow.email,
        emailKey,
        name: studentRow.name,
        membershipIds: [],
        classLabels: new Set(),
        classNames: new Set()
      });
    }

    const person = people.get(emailKey);
    if (!person.name && studentRow.name) {
      person.name = studentRow.name;
    }
    person.membershipIds.push(Number(studentRow.id));
    person.classLabels.add(studentRow.classLabel);
    if (studentRow.className) person.classNames.add(studentRow.className);
  });

  return [...people.values()]
    .map((person) => ({
      selectionKey: person.selectionKey,
      email: person.email,
      emailKey: person.emailKey,
      name: person.name || person.email,
      membershipIds: person.membershipIds,
      membershipCount: person.membershipIds.length,
      classLabels: [...person.classLabels].sort((left, right) => left.localeCompare(right, "de", { sensitivity: "base" })),
      classNames: [...person.classNames].sort((left, right) => left.localeCompare(right, "de", { sensitivity: "base" }))
    }))
    .sort((left, right) => {
      const byName = left.name.localeCompare(right.name, "de", { sensitivity: "base" });
      if (byName !== 0) return byName;
      return left.email.localeCompare(right.email, "de", { sensitivity: "base" });
    });
}

async function getGraduateCleanupPageData({ schoolYearId = null } = {}) {
  const snapshot = await loadArchivedSnapshot(schoolYearId);

  return {
    ...snapshot,
    classGroups: buildGraduateClassGroups(snapshot.students),
    personRows: buildGraduatePersonRows(snapshot.students),
    selection: {
      includedClassKeys: [],
      personActions: {}
    },
    preview: null
  };
}

function resolveGraduateSelection({ classGroups, personRows, includedClassKeys, personActions }) {
  const classGroupByKey = new Map(classGroups.map((group) => [group.selectionKey, group]));
  const personByKey = new Map(personRows.map((person) => [person.selectionKey, person]));
  const selectedEmailKeys = new Set();
  const resolvedIncludedClasses = [];
  const resolvedPersonActions = {};

  parseArrayInput(includedClassKeys).forEach((selectionKey) => {
    const group = classGroupByKey.get(selectionKey);
    if (!group) return;
    resolvedIncludedClasses.push(group);
    group.emailKeys.forEach((emailKey) => selectedEmailKeys.add(emailKey));
  });

  Object.entries(personActions || {}).forEach(([selectionKey, action]) => {
    const normalizedAction = normalizePersonAction(action);
    if (normalizedAction === "inherit") return;
    const person = personByKey.get(selectionKey);
    if (!person) return;

    resolvedPersonActions[selectionKey] = normalizedAction;
    if (normalizedAction === "include") {
      selectedEmailKeys.add(person.emailKey);
      return;
    }
    selectedEmailKeys.delete(person.emailKey);
  });

  const selectedPeople = personRows.filter((person) => selectedEmailKeys.has(person.emailKey));

  return {
    selectedEmailKeys: [...selectedEmailKeys],
    selectedPeople,
    resolvedIncludedClasses,
    resolvedPersonActions
  };
}

async function buildGraduateCleanupPreview({ schoolYearId, includedClassKeys, personActions }) {
  const pageData = await getGraduateCleanupPageData({ schoolYearId });
  ensureArchivedSchoolYearSelected(pageData);

  const selection = resolveGraduateSelection({
    classGroups: pageData.classGroups,
    personRows: pageData.personRows,
    includedClassKeys,
    personActions: buildPersonSelectionMap(personActions)
  });

  if (!selection.selectedPeople.length) {
    throw new Error("Bitte mindestens eine Klasse oder eine Person für die Bereinigung auswählen.");
  }

  const selectedEmailKeySet = new Set(selection.selectedEmailKeys);
  const selectedMemberships = pageData.students.filter((studentRow) => selectedEmailKeySet.has(studentRow.emailKey));
  const selectedMembershipIdSet = new Set(selectedMemberships.map((studentRow) => Number(studentRow.id)));
  const selectedGrades = pageData.grades.filter((gradeRow) => selectedMembershipIdSet.has(Number(gradeRow.student_id)));
  const [allMemberships, studentUsers] = await Promise.all([
    loadAllStudentMemberships(),
    loadStudentUsers()
  ]);
  const deactivatedUsers = buildDeactivatedUserPreview({
    selectedEmails: selection.selectedEmailKeys,
    selectedMembershipIds: selectedMemberships.map((studentRow) => studentRow.id),
    allMemberships,
    studentUsers
  });

  return {
    ...pageData,
    selection: {
      includedClassKeys: selection.resolvedIncludedClasses.map((entry) => entry.selectionKey),
      personActions: selection.resolvedPersonActions
    },
    preview: {
      confirmationText: buildGraduateCleanupConfirmationText(pageData.selectedSchoolYear),
      counts: {
        selectedClassCount: selection.resolvedIncludedClasses.length,
        selectedPersonCount: selection.selectedPeople.length,
        membershipCount: selectedMemberships.length,
        gradeCount: selectedGrades.length,
        deactivatedUserCount: deactivatedUsers.length
      },
      selectedClassNames: selection.resolvedIncludedClasses.map((entry) => entry.className),
      selectedPeople: selection.selectedPeople.map((person) => ({
        name: person.name,
        email: person.email,
        membershipCount: person.membershipCount,
        classLabels: person.classLabels
      })),
      affectedClassLabels: [...new Set(selectedMemberships.map((entry) => entry.classLabel))].sort((left, right) =>
        left.localeCompare(right, "de", { sensitivity: "base" })
      ),
      selectedEmails: selection.selectedPeople.map((person) => person.email),
      selectedEmailKeys: selection.selectedPeople.map((person) => person.emailKey),
      selectedMemberships,
      deactivatedUsers
    }
  };
}

async function executeArchiveDelete({ schoolYearId }) {
  const previewData = await buildArchiveDeletePreview({ schoolYearId });
  ensureArchivedSchoolYearSelected(previewData);

  await withDangerTransaction(async ({ run }) => {
    for (const classRow of previewData.classes) {
      await run("DELETE FROM students WHERE class_id = ?", [classRow.id]);
    }

    for (const classRow of previewData.classes) {
      await run("DELETE FROM classes WHERE id = ?", [classRow.id]);
    }

    for (const archiveRow of previewData.archiveEntries) {
      await run("DELETE FROM archives WHERE id = ?", [archiveRow.id]);
    }

    await run("DELETE FROM school_years WHERE id = ?", [previewData.selectedSchoolYear.id]);

    for (const userRow of previewData.preview.deactivatedUsers || []) {
      await run("UPDATE users SET status = 'deleted' WHERE id = ?", [userRow.id]);
    }
  });

  return {
    deletedSchoolYearName: previewData.selectedSchoolYear.name
  };
}

async function executeGraduateCleanup({ schoolYearId, selectedEmailKeys }) {
  const previewData = await buildGraduateCleanupPreview({
    schoolYearId,
    includedClassKeys: [],
    personActions: Object.fromEntries(
      (selectedEmailKeys || []).map((emailKey) => [encodeSelectionKey(emailKey), "include"])
    )
  });
  ensureArchivedSchoolYearSelected(previewData);

  await withDangerTransaction(async ({ run }) => {
    for (const membership of previewData.preview.selectedMemberships || []) {
      await run("DELETE FROM students WHERE id = ? AND class_id = ?", [membership.id, membership.classId]);
    }

    for (const userRow of previewData.preview.deactivatedUsers || []) {
      await run("UPDATE users SET status = 'deleted' WHERE id = ?", [userRow.id]);
    }
  });

  return {
    cleanedSchoolYearName: previewData.selectedSchoolYear.name,
    cleanedPersonCount: previewData.preview.counts.selectedPersonCount
  };
}

module.exports = {
  buildArchiveDeleteConfirmationText,
  buildArchiveDeletePreview,
  buildGraduateCleanupConfirmationText,
  buildGraduateCleanupPreview,
  decodeSelectionKey,
  encodeSelectionKey,
  executeArchiveDelete,
  executeGraduateCleanup,
  getArchiveDeletePageData,
  getGraduateCleanupPageData
};
