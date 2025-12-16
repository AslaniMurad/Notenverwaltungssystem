// fix_grades_table.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_FILE = path.join(__dirname, "data", "app.sqlite");
const db = new sqlite3.Database(DB_FILE);

console.log("🔄 Lösche alte grades Tabelle und erstelle neue...\n");

db.serialize(() => {
  // Lösche alte Tabelle
  db.run("DROP TABLE IF EXISTS grades", (err) => {
    if (err) {
      console.error("❌ Fehler beim Löschen:", err);
      process.exit(1);
    }
    console.log("✅ Alte grades Tabelle gelöscht");

    // Erstelle neue Tabelle mit korrekter Struktur
    db.run(`
      CREATE TABLE IF NOT EXISTS grades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('Test', 'Hausaufgabe', 'Mündlich', 'Projekt', 'Sonstiges')),
        grade REAL NOT NULL CHECK (grade >= 1 AND grade <= 5),
        description TEXT,
        date TEXT NOT NULL DEFAULT (date('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
      )
    `, (err) => {
      if (err) {
        console.error("❌ Fehler beim Erstellen:", err);
        process.exit(1);
      }

      console.log("✅ Neue grades Tabelle erstellt\n");

      // Zeige neue Struktur
      db.all("PRAGMA table_info(grades)", (err, columns) => {
        if (err) {
          console.error("❌ Fehler:", err);
        } else {
          console.log("📋 Neue Struktur:");
          console.table(columns);
        }
        db.close();
        console.log("\n✅ Fertig! Server kann jetzt gestartet werden.");
      });
    });
  });
});
