// fix_grades_table.js
const { db, ready } = require("./db");

console.log("🔄 Lösche grades Tabelle und erstelle neue (PostgreSQL)...\n");

async function rebuild() {
  await ready;
  db.run("DROP TABLE IF EXISTS grades", (err) => {
    if (err) {
      console.error("❌ Fehler beim Löschen:", err);
      process.exit(1);
    }
    console.log("✅ Alte grades Tabelle gelöscht");

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
      (createErr) => {
        if (createErr) {
          console.error("❌ Fehler beim Erstellen:", createErr);
          process.exit(1);
        }

        console.log("✅ Neue grades Tabelle erstellt\n");

        db.all(
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grades' ORDER BY ordinal_position",
          (colErr, columns) => {
            if (colErr) {
              console.error("❌ Fehler:", colErr);
            } else {
              console.log("📋 Neue Struktur:");
              console.table(columns);
            }
            console.log("\n✅ Fertig! Server kann jetzt gestartet werden.");
            process.exit(0);
          }
        );
      }
    );
  });
}

rebuild().catch((err) => {
  console.error("❌ Fehler beim Neuaufbau:", err);
  process.exit(1);
});
