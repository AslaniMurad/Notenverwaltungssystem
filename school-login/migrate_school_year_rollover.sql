-- Migration: add school year rollover support for SQLite
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS school_years (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
);

INSERT INTO school_years (name, start_date, end_date, is_active)
SELECT '2025/2026', '2025-09-01', '2026-08-31', 1
WHERE NOT EXISTS (SELECT 1 FROM school_years);

ALTER TABLE classes RENAME TO classes_legacy_rollover;

CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE RESTRICT,
  school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO classes (id, name, subject, subject_id, school_year_id, created_at)
SELECT
  id,
  name,
  subject,
  subject_id,
  COALESCE(
    school_year_id,
    (SELECT id FROM school_years WHERE is_active = 1 ORDER BY id DESC LIMIT 1)
  ),
  COALESCE(created_at, CURRENT_TIMESTAMP)
FROM classes_legacy_rollover;

DROP TABLE classes_legacy_rollover;

ALTER TABLE class_subject_teacher RENAME TO class_subject_teacher_legacy_rollover;

CREATE TABLE class_subject_teacher (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE RESTRICT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (class_id, subject_id, teacher_id)
);

INSERT OR IGNORE INTO class_subject_teacher (id, class_id, subject_id, teacher_id, school_year_id, created_at)
SELECT
  id,
  class_id,
  subject_id,
  teacher_id,
  COALESCE(
    school_year_id,
    (SELECT c.school_year_id FROM classes c WHERE c.id = class_subject_teacher_legacy_rollover.class_id)
  ),
  COALESCE(created_at, CURRENT_TIMESTAMP)
FROM class_subject_teacher_legacy_rollover;

DROP TABLE class_subject_teacher_legacy_rollover;

ALTER TABLE grades RENAME TO grades_legacy_rollover;

CREATE TABLE grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  grade_template_id INTEGER NOT NULL REFERENCES grade_templates(id) ON DELETE CASCADE,
  school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE RESTRICT,
  grade NUMERIC NOT NULL,
  is_absent INTEGER NOT NULL DEFAULT 0,
  points_achieved NUMERIC,
  points_max NUMERIC,
  note TEXT,
  attachment_path TEXT,
  attachment_original_name TEXT,
  attachment_mime TEXT,
  attachment_size INTEGER,
  external_link TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, grade_template_id)
);

INSERT INTO grades (
  id,
  student_id,
  class_id,
  grade_template_id,
  school_year_id,
  grade,
  is_absent,
  points_achieved,
  points_max,
  note,
  attachment_path,
  attachment_original_name,
  attachment_mime,
  attachment_size,
  external_link,
  created_at
)
SELECT
  id,
  student_id,
  class_id,
  grade_template_id,
  COALESCE(
    school_year_id,
    (SELECT c.school_year_id FROM classes c WHERE c.id = grades_legacy_rollover.class_id)
  ),
  grade,
  COALESCE(is_absent, 0),
  points_achieved,
  points_max,
  note,
  attachment_path,
  attachment_original_name,
  attachment_mime,
  attachment_size,
  external_link,
  COALESCE(created_at, CURRENT_TIMESTAMP)
FROM grades_legacy_rollover;

DROP TABLE grades_legacy_rollover;

CREATE TABLE IF NOT EXISTS archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_year_id INTEGER NOT NULL REFERENCES school_years(id) ON DELETE CASCADE,
  archive_type TEXT NOT NULL,
  entity_count INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rollover_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  executed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  old_school_year TEXT NOT NULL,
  new_school_year TEXT NOT NULL,
  status TEXT NOT NULL,
  backup_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_school_years_active ON school_years (is_active);
CREATE INDEX IF NOT EXISTS idx_classes_school_year_id ON classes (school_year_id);
CREATE INDEX IF NOT EXISTS idx_class_subject_teacher_school_year_id ON class_subject_teacher (school_year_id);
CREATE INDEX IF NOT EXISTS idx_grades_school_year_id ON grades (school_year_id);
CREATE INDEX IF NOT EXISTS idx_archives_school_year_id ON archives (school_year_id);

COMMIT;

PRAGMA foreign_keys = ON;
