// migrate_add_grades.js
const { db, ready } = require("./db");

console.log("🔄 Migriere Datenbank: Stelle sicher, dass grades Tabelle existiert...\n");

async function migrate() {
  await ready;
  db.run(
    `
      CREATE TABLE IF NOT EXISTS grades (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        grade_template_id INTEGER NOT NULL REFERENCES grade_templates(id) ON DELETE CASCADE,
        grade NUMERIC NOT NULL CHECK (grade >= 1 AND grade <= 5),
        note TEXT,
        attachment_path TEXT,
        attachment_original_name TEXT,
        attachment_mime TEXT,
        attachment_size INTEGER,
        external_link TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (student_id, grade_template_id)
      )
    `,
    (err) => {
      if (err) {
        console.error("❌ Fehler beim Erstellen der Tabelle:", err);
        process.exit(1);
      }

      console.log("✅ Tabelle 'grades' ist vorhanden.");
      process.exit(0);
    }
  );
}

migrate().catch((err) => {
  console.error("❌ Migration fehlgeschlagen:", err);
  process.exit(1);
});
