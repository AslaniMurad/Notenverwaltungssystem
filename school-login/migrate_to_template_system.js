// migrate_to_template_system.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_FILE = path.join(__dirname, "data", "app.sqlite");
const db = new sqlite3.Database(DB_FILE);

console.log("🔄 Migriere zum Template-basierten Notensystem...\n");

db.serialize(() => {
  // 1. Erstelle grade_templates Tabelle
  console.log("📝 Erstelle grade_templates Tabelle...");
  db.run(`
    CREATE TABLE IF NOT EXISTS grade_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('Schularbeit', 'Test', 'Wiederholung', 'Mitarbeit', 'Projekt', 'Hausübung')),
      weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 100),
      date TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    )
  `, (err) => {
    if (err) {
      console.error("❌ Fehler bei grade_templates:", err);
      process.exit(1);
    }
    console.log("✅ grade_templates Tabelle erstellt\n");

    // 2. Sichere alte Noten
    console.log("💾 Sichere alte Noten...");
    db.all("SELECT * FROM grades", (err, oldGrades) => {
      if (err) {
        console.error("❌ Fehler beim Sichern:", err);
        process.exit(1);
      }
      console.log(`✅ ${oldGrades.length} alte Noten gesichert\n`);

      // 3. Lösche alte grades Tabelle
      console.log("🗑️ Lösche alte grades Tabelle...");
      db.run("DROP TABLE IF EXISTS grades", (err) => {
        if (err) {
          console.error("❌ Fehler beim Löschen:", err);
          process.exit(1);
        }
        console.log("✅ Alte Tabelle gelöscht\n");

        // 4. Erstelle neue grades Tabelle mit grade_template_id
        console.log("📝 Erstelle neue grades Tabelle...");
        db.run(`
          CREATE TABLE grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            grade_template_id INTEGER NOT NULL,
            grade REAL NOT NULL CHECK (grade >= 1 AND grade <= 5),
            note TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
            FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
            FOREIGN KEY (grade_template_id) REFERENCES grade_templates(id) ON DELETE CASCADE,
            UNIQUE(student_id, grade_template_id)
          )
        `, (err) => {
          if (err) {
            console.error("❌ Fehler bei neuer grades:", err);
            process.exit(1);
          }
          console.log("✅ Neue grades Tabelle erstellt\n");

          // 5. Zeige Strukturen
          db.all("PRAGMA table_info(grade_templates)", (err, templCols) => {
            console.log("📋 Struktur grade_templates:");
            console.table(templCols);

            db.all("PRAGMA table_info(grades)", (err, gradeCols) => {
              console.log("\n📋 Struktur grades:");
              console.table(gradeCols);

              db.close();
              console.log("\n✅ Migration abgeschlossen!");
              console.log("⚠️ Alte Noten wurden nicht übertragen (neues System benötigt Templates)");
              console.log("💡 Starte den Server und erstelle Templates für deine Klassen!");
            });
          });
        });
      });
    });
  });
});
