// migrate_to_template_system.js
const { db, ready } = require("./db");

console.log("🔄 Prüfe Template-basiertes Notenschema (PostgreSQL)...\n");

async function migrate() {
  await ready;
  db.run(
    `
      CREATE TABLE IF NOT EXISTS grade_templates (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('Schularbeit', 'Test', 'Wiederholung', 'Mitarbeit', 'Projekt', 'Hausübung')),
        weight NUMERIC NOT NULL CHECK (weight >= 0 AND weight <= 100),
        date TIMESTAMPTZ,
        description TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    (templErr) => {
      if (templErr) {
        console.error("❌ Fehler beim Erstellen von grade_templates:", templErr);
        process.exit(1);
      }

      db.run(
        `
          CREATE TABLE IF NOT EXISTS grades (
            id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
            grade_template_id INTEGER NOT NULL REFERENCES grade_templates(id) ON DELETE CASCADE,
            grade NUMERIC NOT NULL CHECK (grade >= 1 AND grade <= 5),
            note TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (student_id, grade_template_id)
          )
        `,
        (gradeErr) => {
          if (gradeErr) {
            console.error("❌ Fehler beim Erstellen von grades:", gradeErr);
            process.exit(1);
          }
          console.log("✅ Template-basiertes Schema ist bereit.");
          process.exit(0);
        }
      );
    }
  );
}

migrate().catch((err) => {
  console.error("❌ Migration fehlgeschlagen:", err);
  process.exit(1);
});
