-- Migration: replace legacy teacher assignment storage with class_subject_teacher (SQLite)
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO subjects (name)
SELECT DISTINCT subject
FROM classes
WHERE subject IS NOT NULL AND TRIM(subject) <> '';

-- Add this column manually first if your SQLite version does not support ADD COLUMN idempotently.
ALTER TABLE classes ADD COLUMN subject_id INTEGER REFERENCES subjects(id);

UPDATE classes
SET subject_id = (
  SELECT s.id
  FROM subjects s
  WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(classes.subject))
  LIMIT 1
)
WHERE subject_id IS NULL;

CREATE TABLE IF NOT EXISTS class_subject_teacher (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (class_id, subject_id, teacher_id)
);

INSERT OR IGNORE INTO class_subject_teacher (class_id, subject_id, teacher_id)
SELECT class_id, subject_id, teacher_id
FROM teaching_assignments;

INSERT OR IGNORE INTO class_subject_teacher (class_id, subject_id, teacher_id)
SELECT id, subject_id, teacher_id
FROM classes
WHERE teacher_id IS NOT NULL AND subject_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_class_subject_teacher_teacher ON class_subject_teacher (teacher_id);
CREATE INDEX IF NOT EXISTS idx_class_subject_teacher_class_subject ON class_subject_teacher (class_id, subject_id);

ALTER TABLE classes RENAME TO classes_legacy;

CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO classes (id, name, subject, subject_id, created_at)
SELECT id, name, subject, subject_id, COALESCE(created_at, CURRENT_TIMESTAMP)
FROM classes_legacy;

DROP TABLE classes_legacy;
DROP TABLE IF EXISTS teaching_assignments;

COMMIT;

PRAGMA foreign_keys = ON;
