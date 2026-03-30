const fs = require("fs/promises");
const path = require("path");
const { pool, isFakeDb } = require("../db");
const { allAsync, runAsync } = require("../utils/dbAsync");
const schoolYearModel = require("../models/schoolYearModel");
const {
  buildSchoolYearName,
  getNextSchoolYear,
  parseSchoolYearName,
  promoteClassName,
  toSqlDate
} = require("../utils/schoolYear");
const { formatNameFromEmail } = require("../utils/userDisplay");

const BACKUP_DIR = path.join(__dirname, "..", "backups");
const WIZARD_VERSION = 2;
const ROLLOVER_ARCHIVE_TYPES = ["classes", "assignments", "students", "grades"];

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function toPositiveInteger(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null;
}

function getLastFormValue(value) {
  if (Array.isArray(value)) {
    return value.length ? value[value.length - 1] : "";
  }
  return value;
}

function isTruthy(value) {
  const normalizedValue = getLastFormValue(value);
  return normalizedValue === true || normalizedValue === "true" || normalizedValue === "1" || normalizedValue === 1 || normalizedValue === "on";
}

function getCollectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  return Object.values(collection);
}

function formatClassSubjectLabel(classRow) {
  const name = normalizeText(classRow?.name || classRow?.current_name || classRow?.targetName);
  const subject = normalizeText(classRow?.subject || classRow?.sourceSubject);
  if (name && subject) return `${name} / ${subject}`;
  return name || subject || "Klasse";
}

function buildPlanLabel(plan) {
  const targetName = normalizeText(plan?.targetName);
  const subject = normalizeText(plan?.subject || plan?.sourceSubject);
  if (targetName && subject) return `${targetName} / ${subject}`;
  return targetName || subject || "Zielklasse";
}

function getPlanKindLabel(kind) {
  if (kind === "promote") return "Hochstufung";
  if (kind === "intake") return "Neueinstieg";
  if (kind === "extra") return "Zusatzklasse";
  return "Zielklasse";
}

function isIntakeTemplateClass(name) {
  const normalizedName = normalizeText(name);
  const match = normalizedName.match(/^(\d+)/);
  return Number(match?.[1]) === 1;
}

function buildPromotePlanKey(classId) {
  return `promote_${classId}`;
}

function buildIntakePlanKey(classId) {
  return `intake_${classId}`;
}

function buildExtraPlanKey(sequence) {
  return `extra_${sequence}`;
}

function getDateParts(value) {
  const match = normalizeText(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function toUtcDateValue(value) {
  const parts = getDateParts(value);
  if (!parts) return null;
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function normalizeSqlDateInput(value, fieldLabel) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    throw new Error(`${fieldLabel} fehlt.`);
  }

  const sqlDate = toSqlDate(normalizedValue);
  if (!sqlDate || !getDateParts(sqlDate)) {
    throw new Error(`${fieldLabel} ist ungueltig.`);
  }

  return sqlDate;
}

function resolveNextSchoolYearConfig(activeSchoolYear, options = {}) {
  const fallbackSchoolYear = getNextSchoolYear(activeSchoolYear);
  const providedName = normalizeText(options.schoolYearName ?? options.school_year_name ?? options.name);
  const startDate = normalizeSqlDateInput(
    options.startDate ?? options.start_date ?? fallbackSchoolYear.startDate,
    "Startdatum des Zielschuljahrs"
  );
  const endDate = normalizeSqlDateInput(
    options.endDate ?? options.end_date ?? fallbackSchoolYear.endDate,
    "Enddatum des Zielschuljahrs"
  );

  if (toUtcDateValue(endDate) <= toUtcDateValue(startDate)) {
    throw new Error("Enddatum muss nach dem Startdatum liegen.");
  }

  const parsedStartDate = getDateParts(startDate);
  const schoolYearName = providedName || buildSchoolYearName(parsedStartDate.year);
  const parsedName = parseSchoolYearName(schoolYearName);

  if (!parsedName) {
    throw new Error("Bezeichnung des Zielschuljahrs muss im Format JJJJ/JJJJ sein.");
  }

  if (parsedName.startYear !== parsedStartDate.year) {
    throw new Error("Bezeichnung und Startdatum des Zielschuljahrs passen nicht zusammen.");
  }

  const parsedEndDate = getDateParts(endDate);
  if (parsedEndDate.year !== parsedName.endYear) {
    throw new Error("Bezeichnung und Enddatum des Zielschuljahrs passen nicht zusammen.");
  }

  return {
    name: schoolYearName,
    startDate,
    endDate,
    startYear: parsedName.startYear,
    endYear: parsedName.endYear
  };
}

function parseStudentImportLine(line) {
  const normalizedLine = normalizeText(line);
  if (!normalizedLine) {
    return { error: "Leere Zeile." };
  }

  let name = "";
  let email = "";

  const angleBracketMatch = normalizedLine.match(/^(.*?)<([^>]+)>$/);
  if (angleBracketMatch) {
    name = normalizeText(angleBracketMatch[1]);
    email = normalizeText(angleBracketMatch[2]);
  } else {
    const separator = normalizedLine.includes(";") ? ";" : normalizedLine.includes(",") ? "," : null;
    if (separator) {
      const parts = normalizedLine
        .split(separator)
        .map((part) => normalizeText(part))
        .filter(Boolean);
      if (parts.length === 1) {
        email = parts[0];
      } else if (parts.length >= 2) {
        const emailIndex = parts.findIndex((part) => part.includes("@"));
        if (emailIndex >= 0) {
          email = parts[emailIndex];
          name = parts.filter((_, index) => index !== emailIndex).join(" ");
        } else {
          name = parts[0];
          email = parts[1];
        }
      }
    } else if (normalizedLine.includes("@")) {
      email = normalizedLine;
    } else {
      name = normalizedLine;
    }
  }

  email = normalizeText(email);
  if (!email || !email.includes("@")) {
    return { error: "E-Mail fehlt oder ist ungueltig." };
  }

  if (!name) {
    name = formatNameFromEmail(email);
  }

  if (!name) {
    return { error: "Name fehlt. Verwende Name;E-Mail oder eine E-Mail im Format vorname.nachname@... ." };
  }

  return { name, email };
}

async function readBackupSnapshotTables() {
  if (pool && !isFakeDb) {
    const tableNames = [
      "school_years",
      "classes",
      "class_subject_teacher",
      "students",
      "grades",
      "archives",
      "rollover_logs"
    ];
    const snapshot = {};
    for (const tableName of tableNames) {
      const result = await pool.query(`SELECT * FROM ${tableName}`);
      snapshot[tableName] = result.rows;
    }
    return snapshot;
  }

  const [schoolYears, classes, assignments, grades, logs] = await Promise.all([
    schoolYearModel.listSchoolYears(),
    allAsync("SELECT id, name, subject, subject_id, school_year_id, created_at FROM classes ORDER BY id ASC"),
    allAsync("SELECT id, class_id, subject_id, teacher_id, school_year_id FROM class_subject_teacher ORDER BY id ASC"),
    allAsync("SELECT id, class_id, student_id, grade, note, school_year_id, created_at FROM grades ORDER BY id ASC"),
    schoolYearModel.listRolloverLogs()
  ]);
  const archiveLists = await Promise.all(
    schoolYears.map((schoolYear) => schoolYearModel.listArchivesBySchoolYear(schoolYear.id))
  );
  const studentLists = await Promise.all(
    classes.map((classRow) => schoolYearModel.listStudentsByClassId(classRow.id))
  );
  const students = classes.flatMap((classRow, index) =>
    (studentLists[index] || []).map((studentRow) => ({
      ...studentRow,
      class_id: classRow.id,
      school_year: classRow.school_year || null
    }))
  );

  return {
    school_years: schoolYears,
    classes,
    class_subject_teacher: assignments,
    students,
    grades,
    archives: archiveLists.flatMap((archiveRows) => archiveRows || []),
    rollover_logs: logs
  };
}

async function createBackupSnapshot({ executedBy, preview, draft = null }) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `rollover-${preview.activeSchoolYear.name.replace(/\//g, "-")}-to-${preview.nextSchoolYear.name.replace(/\//g, "-")}-${safeTimestamp}.json`;
  const filePath = path.join(BACKUP_DIR, fileName);
  const snapshot = await readBackupSnapshotTables();

  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        meta: {
          executedBy,
          createdAt: new Date().toISOString(),
          activeSchoolYear: preview.activeSchoolYear,
          nextSchoolYear: preview.nextSchoolYear
        },
        rolloverPlan: draft ? cloneValue(draft) : null,
        snapshot
      },
      null,
      2
    ),
    "utf8"
  );

  return filePath;
}

async function buildRolloverSourceData(options = {}) {
  const activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
  if (!activeSchoolYear) {
    throw new Error("Kein aktives Schuljahr vorhanden.");
  }

  const nextSchoolYear = resolveNextSchoolYearConfig(activeSchoolYear, options);
  const [classes, assignmentRows, gradeCountRow, existingNextSchoolYear] = await Promise.all([
    schoolYearModel.listClassesBySchoolYear(activeSchoolYear.id),
    schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id),
    schoolYearModel.countGradesBySchoolYear(activeSchoolYear.id),
    schoolYearModel.getSchoolYearByName(nextSchoolYear.name)
  ]);

  const studentsByClassId = new Map();
  const studentLists = await Promise.all(
    classes.map((classRow) => schoolYearModel.listStudentsByClassId(classRow.id))
  );
  classes.forEach((classRow, index) => {
    studentsByClassId.set(Number(classRow.id), studentLists[index] || []);
  });

  const assignmentsByClassId = new Map();
  assignmentRows.forEach((assignmentRow) => {
    const classId = Number(assignmentRow.class_id);
    const rows = assignmentsByClassId.get(classId) || [];
    rows.push({
      id: Number(assignmentRow.id),
      class_id: Number(assignmentRow.class_id),
      subject_id: toPositiveInteger(assignmentRow.subject_id),
      teacher_id: Number(assignmentRow.teacher_id),
      school_year_id: Number(assignmentRow.school_year_id),
      class_name: assignmentRow.class_name,
      subject_name: assignmentRow.subject_name,
      teacher_email: assignmentRow.teacher_email
    });
    assignmentsByClassId.set(classId, rows);
  });

  const sourceClasses = classes.map((classRow) => {
    const promotion = promoteClassName(classRow.name);
    const classId = Number(classRow.id);
    const students = (studentsByClassId.get(classId) || []).map((studentRow) => ({
      id: Number(studentRow.id),
      name: normalizeText(studentRow.name),
      email: normalizeText(studentRow.email),
      sourceClassId: classId
    }));
    const assignments = assignmentsByClassId.get(classId) || [];

    return {
      id: classId,
      name: normalizeText(classRow.name),
      current_name: promotion.currentName,
      next_name: promotion.nextName,
      changed: Boolean(promotion.changed),
      subject: normalizeText(classRow.subject),
      subject_id: toPositiveInteger(classRow.subject_id),
      school_year_id: Number(classRow.school_year_id),
      created_at: classRow.created_at || null,
      students,
      assignments
    };
  });

  const teacherIds = new Set(assignmentRows.map((row) => Number(row.teacher_id)));
  const studentCount = sourceClasses.reduce((sum, classRow) => sum + classRow.students.length, 0);

  return {
    activeSchoolYear: cloneValue(activeSchoolYear),
    nextSchoolYear: cloneValue(nextSchoolYear),
    nextSchoolYearExists: Boolean(existingNextSchoolYear),
    sourceClasses,
    classCount: sourceClasses.length,
    assignmentsCopied: assignmentRows.length,
    teachersAffected: teacherIds.size,
    gradeCount: Number(gradeCountRow?.count || 0),
    studentCount
  };
}

function buildRolloverPreviewFromSource(sourceData) {
  return {
    activeSchoolYear: sourceData.activeSchoolYear,
    nextSchoolYear: sourceData.nextSchoolYear,
    classes: sourceData.sourceClasses.map((classRow) => ({
      ...classRow,
      current_name: classRow.current_name,
      next_name: classRow.next_name,
      changed: classRow.changed
    })),
    assignments: sourceData.sourceClasses.flatMap((classRow) => classRow.assignments),
    classCount: sourceData.classCount,
    assignmentsCopied: sourceData.assignmentsCopied,
    teachersAffected: sourceData.teachersAffected,
    gradeCount: sourceData.gradeCount,
    studentCount: sourceData.studentCount,
    nextSchoolYearExists: sourceData.nextSchoolYearExists
  };
}

async function buildRolloverPreview(options = {}) {
  const sourceData = await buildRolloverSourceData(options);
  return buildRolloverPreviewFromSource(sourceData);
}

function buildDefaultClassPlans(sourceData) {
  const classPlans = [];

  sourceData.sourceClasses.forEach((classRow) => {
    classPlans.push({
      key: buildPromotePlanKey(classRow.id),
      kind: "promote",
      sourceClassId: classRow.id,
      templateSourceClassId: classRow.id,
      sourceName: classRow.name,
      sourceSubject: classRow.subject,
      subject: classRow.subject,
      subjectId: classRow.subject_id,
      targetName: classRow.next_name,
      enabled: true,
      copyTeachers: true,
      autoCreated: true
    });

    if (isIntakeTemplateClass(classRow.name)) {
      classPlans.push({
        key: buildIntakePlanKey(classRow.id),
        kind: "intake",
        sourceClassId: classRow.id,
        templateSourceClassId: classRow.id,
        sourceName: classRow.name,
        sourceSubject: classRow.subject,
        subject: classRow.subject,
        subjectId: classRow.subject_id,
        targetName: classRow.current_name,
        enabled: true,
        copyTeachers: true,
        autoCreated: true
      });
    }
  });

  return classPlans;
}

function buildSourceSummary(sourceData) {
  return {
    classCount: sourceData.classCount,
    assignmentCount: sourceData.assignmentsCopied,
    teacherCount: sourceData.teachersAffected,
    gradeCount: sourceData.gradeCount,
    studentCount: sourceData.studentCount
  };
}

function getEnabledTargetPlans(draft) {
  return (draft.classPlans || []).filter((plan) => Boolean(plan.enabled) && normalizeText(plan.targetName));
}

function getDefaultTargetForSourceClass(draft, sourceClassId) {
  return getEnabledTargetPlans(draft).find(
    (plan) => plan.kind === "promote" && Number(plan.sourceClassId) === Number(sourceClassId)
  );
}

function createWizardDraftFromSource(sourceData) {
  const draft = {
    version: WIZARD_VERSION,
    createdAt: new Date().toISOString(),
    activeSchoolYear: cloneValue(sourceData.activeSchoolYear),
    nextSchoolYear: cloneValue(sourceData.nextSchoolYear),
    sourceSummary: buildSourceSummary(sourceData),
    sourceClasses: cloneValue(sourceData.sourceClasses),
    classPlans: buildDefaultClassPlans(sourceData),
    studentDefaults: {},
    studentPlans: [],
    intakeStudents: {},
    nextExtraClassSequence: 1
  };

  return rebaseStudentDraft(draft);
}

function restoreWizardDraft(rawDraft) {
  if (!rawDraft || Number(rawDraft.version) !== WIZARD_VERSION) {
    return null;
  }

  const draft = cloneValue(rawDraft);
  draft.activeSchoolYear = draft.activeSchoolYear || null;
  draft.nextSchoolYear = draft.nextSchoolYear || null;
  draft.sourceSummary = draft.sourceSummary || {};
  draft.sourceClasses = Array.isArray(draft.sourceClasses) ? draft.sourceClasses : [];
  draft.classPlans = Array.isArray(draft.classPlans) ? draft.classPlans : [];
  draft.studentDefaults = draft.studentDefaults || {};
  draft.studentPlans = Array.isArray(draft.studentPlans) ? draft.studentPlans : [];
  draft.intakeStudents = draft.intakeStudents || {};
  draft.nextExtraClassSequence = Math.max(Number(draft.nextExtraClassSequence) || 1, 1);
  return rebaseStudentDraft(draft);
}

function rebaseStudentDraft(draft) {
  const enabledTargetPlans = getEnabledTargetPlans(draft);
  const validTargetKeys = new Set(enabledTargetPlans.map((plan) => plan.key));
  const previousDefaults = draft.studentDefaults || {};
  const previousPlanMap = new Map((draft.studentPlans || []).map((plan) => [Number(plan.sourceStudentId), plan]));
  const nextDefaults = {};
  const nextStudentPlans = [];
  const nextIntakeStudents = {};

  Object.entries(draft.intakeStudents || {}).forEach(([planKey, intakeState]) => {
    if (validTargetKeys.has(planKey)) {
      nextIntakeStudents[planKey] = {
        rawText: normalizeText(intakeState?.rawText),
        students: Array.isArray(intakeState?.students) ? intakeState.students : []
      };
    }
  });

  draft.sourceClasses.forEach((classRow) => {
    const sourceClassId = Number(classRow.id);
    const defaultPlan = getDefaultTargetForSourceClass(draft, sourceClassId);
    const previousDefault = previousDefaults[sourceClassId] || {};

    let defaultAction = previousDefault.defaultAction === "graduate" ? "graduate" : "promote";
    let defaultTargetClassKey = validTargetKeys.has(previousDefault.defaultTargetClassKey)
      ? previousDefault.defaultTargetClassKey
      : defaultPlan?.key || "";

    if (defaultAction === "promote" && !defaultTargetClassKey) {
      defaultAction = "graduate";
      defaultTargetClassKey = "";
    }

    nextDefaults[sourceClassId] = {
      defaultAction,
      defaultTargetClassKey
    };

    (classRow.students || []).forEach((studentRow) => {
      const previousPlan = previousPlanMap.get(Number(studentRow.id)) || {};
      const mode = previousPlan.mode === "manual" ? "manual" : "inherit";

      let action = previousPlan.action === "graduate" ? "graduate" : defaultAction;
      let targetClassKey = validTargetKeys.has(previousPlan.targetClassKey)
        ? previousPlan.targetClassKey
        : defaultTargetClassKey;

      if (mode === "inherit") {
        action = defaultAction;
        targetClassKey = defaultTargetClassKey;
      }

      if (action === "promote" && !targetClassKey) {
        action = "graduate";
        targetClassKey = "";
      }

      nextStudentPlans.push({
        sourceStudentId: Number(studentRow.id),
        sourceClassId,
        studentName: normalizeText(studentRow.name),
        studentEmail: normalizeText(studentRow.email),
        mode,
        action,
        targetClassKey: action === "promote" ? targetClassKey : ""
      });
    });
  });

  draft.studentDefaults = nextDefaults;
  draft.studentPlans = nextStudentPlans;
  draft.intakeStudents = nextIntakeStudents;
  return draft;
}

function updateClassPlansFromForm(draft, body) {
  const sourceClassMap = new Map((draft.sourceClasses || []).map((classRow) => [Number(classRow.id), classRow]));
  const classPlanInput = body?.class_plan || {};
  const nextClassPlans = [];

  (draft.classPlans || [])
    .filter((plan) => plan.kind !== "extra")
    .forEach((plan) => {
      const input = classPlanInput[plan.key] || {};
      nextClassPlans.push({
        ...plan,
        targetName: normalizeText(input.target_name ?? plan.targetName),
        enabled: isTruthy(input.enabled),
        copyTeachers: isTruthy(input.copy_teachers)
      });
    });

  const extraRows = getCollectionValues(body?.extra_rows);
  extraRows.forEach((row) => {
    const targetName = normalizeText(row?.target_name);
    const templateSourceClassId = toPositiveInteger(row?.template_source_class_id);
    const enabled = isTruthy(row?.enabled);
    const copyTeachers = isTruthy(row?.copy_teachers);

    if (!targetName && !templateSourceClassId) {
      return;
    }

    if (!templateSourceClassId) {
      return;
    }

    const templateClass = sourceClassMap.get(templateSourceClassId);
    if (!templateClass) {
      return;
    }

    const existingPlanKey = normalizeText(row?.plan_key);
    const nextPlanKey = existingPlanKey || buildExtraPlanKey(draft.nextExtraClassSequence++);
    nextClassPlans.push({
      key: nextPlanKey,
      kind: "extra",
      sourceClassId: null,
      templateSourceClassId,
      sourceName: templateClass.name,
      sourceSubject: templateClass.subject,
      subject: templateClass.subject,
      subjectId: templateClass.subject_id,
      targetName,
      enabled,
      copyTeachers,
      autoCreated: false
    });
  });

  draft.classPlans = nextClassPlans;
  return rebaseStudentDraft(draft);
}

function updateStudentPlansFromForm(draft, body) {
  const enabledTargetPlans = getEnabledTargetPlans(draft);
  const validTargetKeys = new Set(enabledTargetPlans.map((plan) => plan.key));
  const studentDefaultsInput = body?.student_defaults || {};
  const studentOverridesInput = body?.student_overrides || {};
  const nextDefaults = {};
  const nextPlans = [];

  draft.sourceClasses.forEach((classRow) => {
    const sourceClassId = Number(classRow.id);
    const defaultPlan = getDefaultTargetForSourceClass(draft, sourceClassId);
    const input = studentDefaultsInput[sourceClassId] || {};
    let defaultAction = input.default_action === "graduate" ? "graduate" : "promote";
    let defaultTargetClassKey = validTargetKeys.has(input.default_target_class_key)
      ? input.default_target_class_key
      : defaultPlan?.key || "";

    if (defaultAction === "promote" && !defaultTargetClassKey) {
      defaultAction = "graduate";
      defaultTargetClassKey = "";
    }

    nextDefaults[sourceClassId] = {
      defaultAction,
      defaultTargetClassKey
    };

    (classRow.students || []).forEach((studentRow) => {
      const override = studentOverridesInput[studentRow.id] || {};
      const mode = override.mode === "manual" ? "manual" : "inherit";
      let action = defaultAction;
      let targetClassKey = defaultTargetClassKey;

      if (mode === "manual") {
        action = override.action === "graduate" ? "graduate" : "promote";
        const manualTargetKey = validTargetKeys.has(override.target_class_key)
          ? override.target_class_key
          : defaultTargetClassKey;
        targetClassKey = action === "promote" ? manualTargetKey : "";
      }

      if (action === "promote" && !targetClassKey) {
        action = "graduate";
        targetClassKey = "";
      }

      nextPlans.push({
        sourceStudentId: Number(studentRow.id),
        sourceClassId,
        studentName: normalizeText(studentRow.name),
        studentEmail: normalizeText(studentRow.email),
        mode,
        action,
        targetClassKey
      });
    });
  });

  const intakeStudents = {};
  const intakeParseErrors = [];
  const intakeStudentsInput = body?.intake_students || {};
  enabledTargetPlans.forEach((plan) => {
    const rawText = normalizeText(intakeStudentsInput[plan.key]?.raw_text);
    if (!rawText) {
      if (plan.kind !== "promote") {
        intakeStudents[plan.key] = { rawText: "", students: [] };
      }
      return;
    }

    const parsedStudents = [];
    rawText
      .split(/\r?\n/)
      .map((line) => normalizeText(line))
      .forEach((line, index) => {
        if (!line) return;
        const parsedLine = parseStudentImportLine(line);
        if (parsedLine.error) {
          intakeParseErrors.push(`${buildPlanLabel(plan)}: Zeile ${index + 1} - ${parsedLine.error}`);
          return;
        }
        parsedStudents.push({
          name: parsedLine.name,
          email: parsedLine.email,
          targetClassKey: plan.key
        });
      });

    intakeStudents[plan.key] = {
      rawText,
      students: parsedStudents
    };
  });

  draft.studentDefaults = nextDefaults;
  draft.studentPlans = nextPlans;
  draft.intakeStudents = intakeStudents;

  const validation = validateWizardDraft(draft);
  return {
    draft,
    intakeParseErrors,
    validation
  };
}

function validateWizardDraft(draft) {
  const errors = [];
  const enabledPlans = getEnabledTargetPlans(draft);
  const planMap = new Map((draft.classPlans || []).map((plan) => [plan.key, plan]));
  const targetOptions = enabledPlans.map((plan) => ({
    key: plan.key,
    label: buildPlanLabel(plan),
    kind: plan.kind,
    sourceClassId: plan.sourceClassId != null ? Number(plan.sourceClassId) : null
  }));
  const duplicateClassKeys = new Map();

  if (!draft?.activeSchoolYear?.id) {
    errors.push("Aktives Schuljahr fehlt im Wizard-Entwurf.");
  }
  if (!draft?.nextSchoolYear?.name) {
    errors.push("Zielschuljahr fehlt im Wizard-Entwurf.");
  }
  if (!enabledPlans.length) {
    errors.push("Mindestens eine Zielklasse muss aktiviert sein.");
  }

  enabledPlans.forEach((plan) => {
    const targetName = normalizeText(plan.targetName);
    if (!targetName) {
      errors.push(`${buildPlanLabel(plan)} hat keinen Zielnamen.`);
      return;
    }
    const duplicateKey = `${targetName.toLowerCase()}::${normalizeText(plan.subjectId || plan.subject).toLowerCase()}`;
    const labels = duplicateClassKeys.get(duplicateKey) || [];
    labels.push(buildPlanLabel(plan));
    duplicateClassKeys.set(duplicateKey, labels);
  });

  duplicateClassKeys.forEach((labels) => {
    if (labels.length > 1) {
      errors.push(`Doppelte Zielklasse erkannt: ${labels.join(" | ")}`);
    }
  });

  const studentCountsBySourceClassId = new Map();
  const targetEmailMap = new Map();

  (draft.studentPlans || []).forEach((studentPlan) => {
    const sourceClassId = Number(studentPlan.sourceClassId);
    studentCountsBySourceClassId.set(
      sourceClassId,
      (studentCountsBySourceClassId.get(sourceClassId) || 0) + 1
    );

    if (studentPlan.action === "promote") {
      if (!planMap.has(studentPlan.targetClassKey) || !enabledPlans.some((plan) => plan.key === studentPlan.targetClassKey)) {
        errors.push(`${studentPlan.studentName || studentPlan.studentEmail}: Zielklasse fehlt.`);
        return;
      }

      const dedupeKey = `${studentPlan.targetClassKey}::${normalizeEmail(studentPlan.studentEmail)}`;
      const labels = targetEmailMap.get(dedupeKey) || [];
      labels.push(studentPlan.studentName || studentPlan.studentEmail);
      targetEmailMap.set(dedupeKey, labels);
    }
  });

  (draft.sourceClasses || []).forEach((classRow) => {
    const expectedStudentCount = Array.isArray(classRow.students) ? classRow.students.length : 0;
    const plannedStudentCount = studentCountsBySourceClassId.get(Number(classRow.id)) || 0;
    if (plannedStudentCount !== expectedStudentCount) {
      errors.push(`Schuelerplanung fuer ${formatClassSubjectLabel(classRow)} ist unvollstaendig.`);
    }
  });

  Object.entries(draft.intakeStudents || {}).forEach(([planKey, intakeState]) => {
    if (!enabledPlans.some((plan) => plan.key === planKey)) return;
    (intakeState.students || []).forEach((studentRow) => {
      const dedupeKey = `${planKey}::${normalizeEmail(studentRow.email)}`;
      const labels = targetEmailMap.get(dedupeKey) || [];
      labels.push(studentRow.name || studentRow.email);
      targetEmailMap.set(dedupeKey, labels);
    });
  });

  targetEmailMap.forEach((labels, dedupeKey) => {
    if (labels.length > 1) {
      const [targetClassKey] = dedupeKey.split("::");
      const targetPlan = planMap.get(targetClassKey);
      errors.push(`Doppelte E-Mail in ${buildPlanLabel(targetPlan)}: ${labels.join(", ")}`);
    }
  });

  const reviewStats = {
    targetClassCount: enabledPlans.length,
    promotedClassCount: enabledPlans.filter((plan) => plan.kind === "promote").length,
    intakeClassCount: enabledPlans.filter((plan) => plan.kind === "intake").length,
    extraClassCount: enabledPlans.filter((plan) => plan.kind === "extra").length,
    promotedStudentCount: (draft.studentPlans || []).filter((plan) => plan.action === "promote").length,
    graduatedStudentCount: (draft.studentPlans || []).filter((plan) => plan.action === "graduate").length,
    intakeStudentCount: Object.values(draft.intakeStudents || {}).reduce(
      (sum, intakeState) => sum + ((intakeState.students || []).length),
      0
    ),
    teacherAssignmentCount: enabledPlans.reduce((sum, plan) => {
      if (!plan.copyTeachers) return sum;
      const sourceClass = (draft.sourceClasses || []).find(
        (classRow) => Number(classRow.id) === Number(plan.templateSourceClassId)
      );
      return sum + (sourceClass?.assignments?.length || 0);
    }, 0)
  };

  return {
    valid: errors.length === 0,
    errors,
    targetOptions,
    reviewStats
  };
}

function buildWizardViewData(draft) {
  const restoredDraft = restoreWizardDraft(draft);
  if (!restoredDraft) return null;

  const validation = validateWizardDraft(restoredDraft);
  const enabledPlans = getEnabledTargetPlans(restoredDraft);
  const targetOptions = enabledPlans.map((plan) => ({
    key: plan.key,
    label: buildPlanLabel(plan),
    kind: plan.kind,
    kindLabel: getPlanKindLabel(plan.kind),
    sourceClassId: plan.sourceClassId != null ? Number(plan.sourceClassId) : null
  }));
  const targetOptionMap = new Map(targetOptions.map((option) => [option.key, option]));
  const groupedStudentPlans = new Map();

  (restoredDraft.studentPlans || []).forEach((studentPlan) => {
    const sourceClassId = Number(studentPlan.sourceClassId);
    const rows = groupedStudentPlans.get(sourceClassId) || [];
    rows.push({
      ...studentPlan,
      targetLabel: targetOptionMap.get(studentPlan.targetClassKey)?.label || ""
    });
    groupedStudentPlans.set(sourceClassId, rows);
  });

  const sourceClassGroups = restoredDraft.sourceClasses.map((classRow) => {
    const sourceClassId = Number(classRow.id);
    const defaults = restoredDraft.studentDefaults[sourceClassId] || {
      defaultAction: "graduate",
      defaultTargetClassKey: ""
    };
    const students = groupedStudentPlans.get(sourceClassId) || [];
    return {
      classRow,
      defaults,
      targetOptions,
      promoteCount: students.filter((studentPlan) => studentPlan.action === "promote").length,
      graduateCount: students.filter((studentPlan) => studentPlan.action === "graduate").length,
      manualCount: students.filter((studentPlan) => studentPlan.mode === "manual").length,
      students
    };
  });

  const intakeTargets = enabledPlans
    .filter((plan) => plan.kind !== "promote")
    .map((plan) => ({
      plan,
      label: buildPlanLabel(plan),
      students: restoredDraft.intakeStudents?.[plan.key]?.students || [],
      rawText: restoredDraft.intakeStudents?.[plan.key]?.rawText || ""
    }));

  const reviewClassRows = enabledPlans.map((plan) => {
    const sourceClass = (restoredDraft.sourceClasses || []).find(
      (classRow) => Number(classRow.id) === Number(plan.templateSourceClassId)
    );
    return {
      plan,
      targetLabel: buildPlanLabel(plan),
      sourceLabel: sourceClass ? formatClassSubjectLabel(sourceClass) : "-",
      teacherCount: plan.copyTeachers ? sourceClass?.assignments?.length || 0 : 0,
      promotedStudents: (restoredDraft.studentPlans || []).filter(
        (studentPlan) => studentPlan.action === "promote" && studentPlan.targetClassKey === plan.key
      ).length,
      intakeStudents: restoredDraft.intakeStudents?.[plan.key]?.students?.length || 0
    };
  });

  return {
    draft: restoredDraft,
    validation,
    targetOptions,
    enabledPlans,
    baseClassPlans: restoredDraft.classPlans.filter((plan) => plan.kind !== "extra"),
    extraClassPlans: restoredDraft.classPlans.filter((plan) => plan.kind === "extra"),
    sourceClassGroups,
    intakeTargets,
    reviewClassRows
  };
}

async function createWizardDraft(options = {}) {
  const sourceData = await buildRolloverSourceData(options);
  if (sourceData.nextSchoolYearExists) {
    throw new Error(`Das Schuljahr ${sourceData.nextSchoolYear.name} existiert bereits.`);
  }
  return createWizardDraftFromSource(sourceData);
}

async function createArchiveEntries({ schoolYearId, summary, queryRunner }) {
  const archiveEntries = [
    { archiveType: "classes", entityCount: summary.targetClassCount || 0 },
    { archiveType: "assignments", entityCount: summary.teacherAssignmentCount || 0 },
    { archiveType: "students", entityCount: (summary.promotedStudentCount || 0) + (summary.intakeStudentCount || 0) },
    { archiveType: "grades", entityCount: summary.gradeCount || 0 }
  ];

  for (const entry of archiveEntries) {
    await queryRunner(
      "INSERT INTO archives (school_year_id, archive_type, entity_count) VALUES (?,?,?)",
      [schoolYearId, entry.archiveType, entry.entityCount]
    );
  }
}

function buildExecutionRows(draft) {
  const validation = validateWizardDraft(draft);
  if (!validation.valid) {
    throw new Error(validation.errors[0] || "Wizard-Entwurf ist ungueltig.");
  }

  const enabledPlans = getEnabledTargetPlans(draft);
  const planMap = new Map(enabledPlans.map((plan) => [plan.key, plan]));
  const sourceClassMap = new Map((draft.sourceClasses || []).map((classRow) => [Number(classRow.id), classRow]));

  const classRows = enabledPlans.map((plan) => ({
    key: plan.key,
    name: normalizeText(plan.targetName),
    subject: normalizeText(plan.subject),
    subjectId: toPositiveInteger(plan.subjectId),
    templateSourceClassId: Number(plan.templateSourceClassId),
    copyTeachers: Boolean(plan.copyTeachers)
  }));

  const teacherAssignmentRows = [];
  enabledPlans.forEach((plan) => {
    if (!plan.copyTeachers) return;
    const sourceClass = sourceClassMap.get(Number(plan.templateSourceClassId));
    (sourceClass?.assignments || []).forEach((assignmentRow) => {
      teacherAssignmentRows.push({
        planKey: plan.key,
        subjectId: toPositiveInteger(assignmentRow.subject_id) || toPositiveInteger(plan.subjectId),
        teacherId: Number(assignmentRow.teacher_id)
      });
    });
  });

  const studentRows = [];
  (draft.studentPlans || []).forEach((studentPlan) => {
    if (studentPlan.action !== "promote") return;
    if (!planMap.has(studentPlan.targetClassKey)) return;
    studentRows.push({
      planKey: studentPlan.targetClassKey,
      name: normalizeText(studentPlan.studentName),
      email: normalizeText(studentPlan.studentEmail)
    });
  });

  Object.entries(draft.intakeStudents || {}).forEach(([planKey, intakeState]) => {
    if (!planMap.has(planKey)) return;
    (intakeState.students || []).forEach((studentRow) => {
      studentRows.push({
        planKey,
        name: normalizeText(studentRow.name),
        email: normalizeText(studentRow.email)
      });
    });
  });

  return {
    validation,
    classRows,
    teacherAssignmentRows,
    studentRows
  };
}

async function executeWithDbWrapper({ draft, executionRows }) {
  const newSchoolYearResult = await runAsync(
    "INSERT INTO school_years (name, start_date, end_date, is_active) VALUES (?,?,?,?)",
    [draft.nextSchoolYear.name, draft.nextSchoolYear.startDate, draft.nextSchoolYear.endDate, false]
  );
  const newSchoolYearId = newSchoolYearResult?.lastID;
  const classIdMap = new Map();

  for (const classRow of executionRows.classRows) {
    const insertedClass = await runAsync(
      "INSERT INTO classes (name, subject, subject_id, school_year_id) VALUES (?,?,?,?)",
      [classRow.name, classRow.subject, classRow.subjectId, newSchoolYearId]
    );
    classIdMap.set(classRow.key, insertedClass?.lastID);
  }

  for (const assignmentRow of executionRows.teacherAssignmentRows) {
    const newClassId = classIdMap.get(assignmentRow.planKey);
    if (!newClassId) continue;
    await runAsync(
      "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES (?,?,?,?)",
      [newClassId, assignmentRow.subjectId, assignmentRow.teacherId, newSchoolYearId]
    );
  }

  for (const studentRow of executionRows.studentRows) {
    const newClassId = classIdMap.get(studentRow.planKey);
    if (!newClassId) continue;
    await runAsync(
      "INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)",
      [studentRow.name, studentRow.email, newClassId, draft.nextSchoolYear.name]
    );
  }

  await createArchiveEntries({
    schoolYearId: draft.activeSchoolYear.id,
    summary: {
      ...executionRows.validation.reviewStats,
      gradeCount: Number(draft.sourceSummary?.gradeCount || 0)
    },
    queryRunner: runAsync
  });

  await runAsync("UPDATE school_years SET is_active = ? WHERE id = ?", [false, draft.activeSchoolYear.id]);
  await runAsync("UPDATE school_years SET is_active = ? WHERE id = ?", [true, newSchoolYearId]);

  return { newSchoolYearId };
}

async function executeWithTransaction({ draft, executionRows }) {
  if (!pool || isFakeDb) {
    return executeWithDbWrapper({ draft, executionRows });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const newSchoolYearInsert = await client.query(
      `INSERT INTO school_years (name, start_date, end_date, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [draft.nextSchoolYear.name, draft.nextSchoolYear.startDate, draft.nextSchoolYear.endDate, false]
    );
    const newSchoolYearId = Number(newSchoolYearInsert.rows[0].id);
    const classIdMap = new Map();

    for (const classRow of executionRows.classRows) {
      const insertedClass = await client.query(
        `INSERT INTO classes (name, subject, subject_id, school_year_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [classRow.name, classRow.subject, classRow.subjectId, newSchoolYearId]
      );
      classIdMap.set(classRow.key, Number(insertedClass.rows[0].id));
    }

    for (const assignmentRow of executionRows.teacherAssignmentRows) {
      const newClassId = classIdMap.get(assignmentRow.planKey);
      if (!newClassId) continue;
      await client.query(
        `INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING`,
        [newClassId, assignmentRow.subjectId, assignmentRow.teacherId, newSchoolYearId]
      );
    }

    for (const studentRow of executionRows.studentRows) {
      const newClassId = classIdMap.get(studentRow.planKey);
      if (!newClassId) continue;
      await client.query(
        `INSERT INTO students (name, email, class_id, school_year)
         VALUES ($1, $2, $3, $4)`,
        [studentRow.name, studentRow.email, newClassId, draft.nextSchoolYear.name]
      );
    }

    await createArchiveEntries({
      schoolYearId: draft.activeSchoolYear.id,
      summary: {
        ...executionRows.validation.reviewStats,
        gradeCount: Number(draft.sourceSummary?.gradeCount || 0)
      },
      queryRunner: (sql, params) => {
        let parameterIndex = 0;
        const querySql = sql.replace(/\?/g, () => `$${++parameterIndex}`);
        return client.query(querySql, params);
      }
    });

    await client.query("UPDATE school_years SET is_active = FALSE WHERE id = $1", [draft.activeSchoolYear.id]);
    await client.query("UPDATE school_years SET is_active = TRUE WHERE id = $1", [newSchoolYearId]);

    await client.query("COMMIT");
    return { newSchoolYearId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function executeWizardRollover({ draft, executedBy, confirmationText }) {
  const restoredDraft = restoreWizardDraft(draft);
  if (!restoredDraft) {
    throw new Error("Rollover-Assistent muss zuerst gestartet werden.");
  }

  const liveSource = await buildRolloverSourceData({
    schoolYearName: restoredDraft.nextSchoolYear?.name,
    startDate: restoredDraft.nextSchoolYear?.startDate,
    endDate: restoredDraft.nextSchoolYear?.endDate
  });
  if (Number(liveSource.activeSchoolYear.id) !== Number(restoredDraft.activeSchoolYear.id)) {
    throw new Error("Das aktive Schuljahr hat sich geaendert. Assistent bitte neu starten.");
  }
  if (liveSource.nextSchoolYearExists) {
    throw new Error(`Das Schuljahr ${liveSource.nextSchoolYear.name} existiert bereits.`);
  }

  const normalizedConfirmation = normalizeText(confirmationText);
  if (normalizedConfirmation !== restoredDraft.nextSchoolYear.name) {
    throw new Error(`Bestaetigung fehlt. Bitte ${restoredDraft.nextSchoolYear.name} exakt eingeben.`);
  }

  const executionRows = buildExecutionRows(restoredDraft);
  const backupPath = await createBackupSnapshot({
    executedBy,
    preview: {
      activeSchoolYear: restoredDraft.activeSchoolYear,
      nextSchoolYear: restoredDraft.nextSchoolYear
    },
    draft: restoredDraft
  });

  try {
    const result = await executeWithTransaction({
      draft: restoredDraft,
      executionRows
    });
    await schoolYearModel.createRolloverLog({
      executedBy,
      oldSchoolYear: restoredDraft.activeSchoolYear.name,
      newSchoolYear: restoredDraft.nextSchoolYear.name,
      status: "success",
      backupPath
    });

    return {
      ...result,
      backupPath,
      reviewStats: executionRows.validation.reviewStats,
      preview: {
        activeSchoolYear: restoredDraft.activeSchoolYear,
        nextSchoolYear: restoredDraft.nextSchoolYear
      }
    };
  } catch (err) {
    await schoolYearModel.createRolloverLog({
      executedBy,
      oldSchoolYear: restoredDraft.activeSchoolYear.name,
      newSchoolYear: restoredDraft.nextSchoolYear.name,
      status: "failed",
      backupPath
    }).catch(() => {});
    throw err;
  }
}

function ensureBackupPathInDirectory(filePath) {
  const resolvedPath = path.resolve(String(filePath || ""));
  const resolvedBackupDir = path.resolve(BACKUP_DIR);
  const isInsideBackupDir =
    resolvedPath === resolvedBackupDir || resolvedPath.startsWith(`${resolvedBackupDir}${path.sep}`);

  if (!isInsideBackupDir) {
    throw new Error("Backup-Pfad ist ungueltig.");
  }

  return resolvedPath;
}

async function readBackupSnapshot(backupPath) {
  const resolvedPath = ensureBackupPathInDirectory(backupPath);
  let payload;

  try {
    payload = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error("Backup-Datei wurde nicht gefunden.");
    }
    throw new Error("Backup-Datei konnte nicht gelesen werden.");
  }

  const previousSchoolYearName = normalizeText(payload?.meta?.activeSchoolYear?.name);
  const targetSchoolYearName = normalizeText(payload?.meta?.nextSchoolYear?.name);
  if (!previousSchoolYearName || !targetSchoolYearName) {
    throw new Error("Backup-Datei ist unvollstaendig.");
  }

  return {
    filePath: resolvedPath,
    payload
  };
}

function collectArchiveIdsToDelete(archiveRows, previousSchoolYearId, backupCreatedAt) {
  const backupCreatedAtMs = new Date(backupCreatedAt).getTime();
  return (archiveRows || [])
    .filter((archiveRow) => {
      if (Number(archiveRow.school_year_id) !== Number(previousSchoolYearId)) return false;
      if (!ROLLOVER_ARCHIVE_TYPES.includes(normalizeText(archiveRow.archive_type))) return false;
      if (!Number.isFinite(backupCreatedAtMs)) return true;
      const archiveCreatedAtMs = new Date(archiveRow.created_at).getTime();
      return Number.isFinite(archiveCreatedAtMs) && archiveCreatedAtMs >= backupCreatedAtMs;
    })
    .map((archiveRow) => Number(archiveRow.id))
    .filter((archiveId) => Number.isInteger(archiveId) && archiveId > 0);
}

async function restoreWithDbWrapper({ previousSchoolYearId, targetSchoolYearId, archiveIdsToDelete, targetClassIds }) {
  await runAsync("UPDATE school_years SET is_active = ? WHERE id = ?", [true, previousSchoolYearId]);

  for (const archiveId of archiveIdsToDelete) {
    await runAsync("DELETE FROM archives WHERE id = ?", [archiveId]);
  }

  for (const classId of targetClassIds) {
    await runAsync("DELETE FROM students WHERE class_id = ?", [classId]);
    await runAsync("DELETE FROM classes WHERE id = ?", [classId]);
  }

  await runAsync("DELETE FROM school_years WHERE id = ?", [targetSchoolYearId]);
}

async function restoreWithTransaction({ previousSchoolYearId, targetSchoolYearId, archiveIdsToDelete, targetClassIds }) {
  if (!pool || isFakeDb) {
    return restoreWithDbWrapper({
      previousSchoolYearId,
      targetSchoolYearId,
      archiveIdsToDelete,
      targetClassIds
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE school_years SET is_active = FALSE WHERE id = $1", [targetSchoolYearId]);

    for (const archiveId of archiveIdsToDelete) {
      await client.query("DELETE FROM archives WHERE id = $1", [archiveId]);
    }

    for (const classId of targetClassIds) {
      await client.query("DELETE FROM students WHERE class_id = $1", [classId]);
      await client.query("DELETE FROM classes WHERE id = $1", [classId]);
    }

    await client.query("DELETE FROM school_years WHERE id = $1", [targetSchoolYearId]);
    await client.query("UPDATE school_years SET is_active = TRUE WHERE id = $1", [previousSchoolYearId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function restoreSchoolYearFromBackup({ backupPath, executedBy }) {
  const backupSnapshot = await readBackupSnapshot(backupPath);
  const previousSchoolYearName = normalizeText(backupSnapshot.payload.meta.activeSchoolYear.name);
  const targetSchoolYearName = normalizeText(backupSnapshot.payload.meta.nextSchoolYear.name);
  const [currentActiveSchoolYear, previousSchoolYear, targetSchoolYear] = await Promise.all([
    schoolYearModel.getActiveSchoolYear(),
    schoolYearModel.getSchoolYearByName(previousSchoolYearName),
    schoolYearModel.getSchoolYearByName(targetSchoolYearName)
  ]);

  if (!targetSchoolYear) {
    if (normalizeText(currentActiveSchoolYear?.name) === previousSchoolYearName) {
      throw new Error(`Das Schuljahr ${targetSchoolYearName} wurde bereits wiederhergestellt.`);
    }
    throw new Error(`Das Zielschuljahr ${targetSchoolYearName} ist nicht mehr vorhanden.`);
  }

  if (normalizeText(currentActiveSchoolYear?.name) !== targetSchoolYearName) {
    throw new Error(`Wiederherstellen ist nur moeglich, wenn ${targetSchoolYearName} aktuell aktiv ist.`);
  }

  if (!previousSchoolYear) {
    throw new Error(`Das vorherige Schuljahr ${previousSchoolYearName} konnte nicht gefunden werden.`);
  }

  const [targetClasses, previousYearArchives] = await Promise.all([
    schoolYearModel.listClassesBySchoolYear(targetSchoolYear.id),
    schoolYearModel.listArchivesBySchoolYear(previousSchoolYear.id)
  ]);
  const archiveIdsToDelete = collectArchiveIdsToDelete(
    previousYearArchives,
    previousSchoolYear.id,
    backupSnapshot.payload.meta.createdAt
  );

  await restoreWithTransaction({
    previousSchoolYearId: previousSchoolYear.id,
    targetSchoolYearId: targetSchoolYear.id,
    archiveIdsToDelete,
    targetClassIds: (targetClasses || []).map((classRow) => Number(classRow.id))
  });

  await schoolYearModel.createRolloverLog({
    executedBy,
    oldSchoolYear: targetSchoolYearName,
    newSchoolYear: previousSchoolYearName,
    status: "restored",
    backupPath: backupSnapshot.filePath
  });

  return {
    previousSchoolYearName,
    targetSchoolYearName
  };
}

module.exports = {
  buildRolloverPreview,
  buildRolloverSourceData,
  buildWizardViewData,
  createBackupSnapshot,
  createWizardDraft,
  executeWizardRollover,
  restoreSchoolYearFromBackup,
  restoreWizardDraft,
  updateClassPlansFromForm,
  updateStudentPlansFromForm,
  validateWizardDraft
};
