const fs = require("fs/promises");
const path = require("path");
const { pool, isFakeDb } = require("../db");
const { allAsync, runAsync } = require("../utils/dbAsync");
const schoolYearModel = require("../models/schoolYearModel");
const {
  getNextSchoolYear,
  promoteClassName
} = require("../utils/schoolYear");

const BACKUP_DIR = path.join(__dirname, "..", "backups");

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

  // Fake DB fallback keeps the backup lightweight but still preserves the rollover inputs and outputs.
  const [schoolYears, classes, assignments, grades, logs] = await Promise.all([
    schoolYearModel.listSchoolYears(),
    allAsync("SELECT id, name, subject, subject_id, school_year_id, created_at FROM classes ORDER BY id ASC"),
    allAsync("SELECT id, class_id, subject_id, teacher_id, school_year_id FROM class_subject_teacher ORDER BY id ASC"),
    allAsync("SELECT id, class_id, student_id, grade, note, school_year_id, created_at FROM grades ORDER BY id ASC"),
    schoolYearModel.listRolloverLogs()
  ]);

  return {
    school_years: schoolYears,
    classes,
    class_subject_teacher: assignments,
    grades,
    rollover_logs: logs
  };
}

async function createBackupSnapshot({ executedBy, preview }) {
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
        snapshot
      },
      null,
      2
    ),
    "utf8"
  );

  return filePath;
}

async function buildRolloverPreview() {
  const activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
  if (!activeSchoolYear) {
    throw new Error("Kein aktives Schuljahr vorhanden.");
  }

  const nextSchoolYear = getNextSchoolYear(activeSchoolYear);
  const [classes, assignmentRows, gradeCountRow, existingNextSchoolYear] = await Promise.all([
    schoolYearModel.listClassesBySchoolYear(activeSchoolYear.id),
    schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id),
    schoolYearModel.countGradesBySchoolYear(activeSchoolYear.id),
    schoolYearModel.getSchoolYearByName(nextSchoolYear.name)
  ]);

  const promotedClasses = classes.map((classRow) => {
    const promotion = promoteClassName(classRow.name);
    return {
      ...classRow,
      current_name: promotion.currentName,
      next_name: promotion.nextName,
      changed: promotion.changed
    };
  });

  const teacherIds = new Set(assignmentRows.map((row) => Number(row.teacher_id)));

  return {
    activeSchoolYear,
    nextSchoolYear,
    classes: promotedClasses,
    assignments: assignmentRows,
    classCount: promotedClasses.length,
    assignmentsCopied: assignmentRows.length,
    teachersAffected: teacherIds.size,
    gradeCount: Number(gradeCountRow?.count || 0),
    nextSchoolYearExists: Boolean(existingNextSchoolYear)
  };
}

async function createArchiveEntries({ schoolYearId, preview, queryRunner }) {
  // Archive records track which historical areas are now read-only for the previous year.
  const archiveEntries = [
    { archiveType: "classes", entityCount: preview.classCount },
    { archiveType: "assignments", entityCount: preview.assignmentsCopied },
    { archiveType: "grades", entityCount: preview.gradeCount }
  ];

  for (const entry of archiveEntries) {
    await queryRunner(
      "INSERT INTO archives (school_year_id, archive_type, entity_count) VALUES (?,?,?)",
      [schoolYearId, entry.archiveType, entry.entityCount]
    );
  }
}

async function executeWithDbWrapper({ preview }) {
  const newSchoolYearResult = await runAsync(
    "INSERT INTO school_years (name, start_date, end_date, is_active) VALUES (?,?,?,?)",
    [preview.nextSchoolYear.name, preview.nextSchoolYear.startDate, preview.nextSchoolYear.endDate, false]
  );
  const newSchoolYearId = newSchoolYearResult?.lastID;
  const classIdMap = new Map();

  // Copy only the class shell into the new school year. Students and grades stay in history.
  for (const classRow of preview.classes) {
    const insertedClass = await runAsync(
      "INSERT INTO classes (name, subject, subject_id, school_year_id) VALUES (?,?,?,?)",
      [classRow.next_name, classRow.subject, classRow.subject_id, newSchoolYearId]
    );
    classIdMap.set(Number(classRow.id), insertedClass?.lastID);
  }

  for (const assignmentRow of preview.assignments) {
    const newClassId = classIdMap.get(Number(assignmentRow.class_id));
    if (!newClassId) continue;
    await runAsync(
      "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES (?,?,?,?)",
      [newClassId, assignmentRow.subject_id, assignmentRow.teacher_id, newSchoolYearId]
    );
  }

  await createArchiveEntries({
    schoolYearId: preview.activeSchoolYear.id,
    preview,
    queryRunner: runAsync
  });
  await runAsync("UPDATE school_years SET is_active = ? WHERE id = ?", [false, preview.activeSchoolYear.id]);
  await runAsync("UPDATE school_years SET is_active = ? WHERE id = ?", [true, newSchoolYearId]);

  return { newSchoolYearId };
}

async function executeWithTransaction({ preview }) {
  if (!pool || isFakeDb) {
    return executeWithDbWrapper({ preview });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const newSchoolYearInsert = await client.query(
      `INSERT INTO school_years (name, start_date, end_date, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [preview.nextSchoolYear.name, preview.nextSchoolYear.startDate, preview.nextSchoolYear.endDate, false]
    );
    const newSchoolYearId = Number(newSchoolYearInsert.rows[0].id);
    const classIdMap = new Map();

    for (const classRow of preview.classes) {
      const insertedClass = await client.query(
        `INSERT INTO classes (name, subject, subject_id, school_year_id)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [classRow.next_name, classRow.subject, classRow.subject_id, newSchoolYearId]
      );
      classIdMap.set(Number(classRow.id), Number(insertedClass.rows[0].id));
    }

    for (const assignmentRow of preview.assignments) {
      const newClassId = classIdMap.get(Number(assignmentRow.class_id));
      if (!newClassId) continue;
      await client.query(
        `INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (class_id, subject_id, teacher_id) DO NOTHING`,
        [newClassId, assignmentRow.subject_id, assignmentRow.teacher_id, newSchoolYearId]
      );
    }

    await createArchiveEntries({
      schoolYearId: preview.activeSchoolYear.id,
      preview,
      queryRunner: (sql, params) => {
        let parameterIndex = 0;
        const querySql = sql.replace(/\?/g, () => `$${++parameterIndex}`);
        return client.query(querySql, params);
      }
    });

    await client.query("UPDATE school_years SET is_active = FALSE WHERE id = $1", [preview.activeSchoolYear.id]);
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

async function rolloverSchoolYear({ executedBy, confirmationText }) {
  const preview = await buildRolloverPreview();
  if (preview.nextSchoolYearExists) {
    throw new Error(`Das Schuljahr ${preview.nextSchoolYear.name} existiert bereits.`);
  }

  const normalizedConfirmation = String(confirmationText || "").trim();
  if (normalizedConfirmation !== preview.nextSchoolYear.name) {
    throw new Error(`Bestaetigung fehlt. Bitte ${preview.nextSchoolYear.name} exakt eingeben.`);
  }

  const backupPath = await createBackupSnapshot({ executedBy, preview });

  try {
    const result = await executeWithTransaction({ preview });
    await schoolYearModel.createRolloverLog({
      executedBy,
      oldSchoolYear: preview.activeSchoolYear.name,
      newSchoolYear: preview.nextSchoolYear.name,
      status: "success",
      backupPath
    });

    return {
      ...result,
      backupPath,
      preview
    };
  } catch (err) {
    await schoolYearModel.createRolloverLog({
      executedBy,
      oldSchoolYear: preview.activeSchoolYear.name,
      newSchoolYear: preview.nextSchoolYear.name,
      status: "failed",
      backupPath
    }).catch(() => {});
    throw err;
  }
}

module.exports = {
  buildRolloverPreview,
  createBackupSnapshot,
  rolloverSchoolYear
};
