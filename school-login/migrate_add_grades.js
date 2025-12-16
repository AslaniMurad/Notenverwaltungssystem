// migrate_add_grades.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_FILE = path.join(__dirname, "data", "app.sqlite");
const db = new sqlite3.Database(DB_FILE);

console.log("🔄 Migriere Datenbank: Füge grades Tabelle hinzu...\n");

db.serialize(() => {
  // Prüfe, ob grades Tabelle bereits existiert
  db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='grades'", (err, row) => {
    if (err) {
      console.error("❌ Fehler beim Prüfen:", err);
      process.exit(1);
    }

    if (row) {
      console.log("✅ Tabelle 'grades' existiert bereits.");
      db.close();
      process.exit(0);
    }

    // Erstelle grades Tabelle
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
        console.error("❌ Fehler beim Erstellen der Tabelle:", err);
        process.exit(1);
      }

      console.log("✅ Tabelle 'grades' erfolgreich erstellt!");

      // Zeige Struktur
      db.all("PRAGMA table_info(grades)", (err, columns) => {
        if (err) {
          console.error("❌ Fehler beim Abrufen der Struktur:", err);
        } else {
          console.log("\n📋 Struktur der grades Tabelle:");
          console.table(columns);
        }

        db.close();
        console.log("\n✅ Migration abgeschlossen!");
      });
    });
  });
});
