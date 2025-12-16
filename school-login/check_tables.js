// check_tables.js
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const DB_FILE = path.join(__dirname, "data", "app.sqlite");
const db = new sqlite3.Database(DB_FILE);

console.log("📋 Alle Tabellen in der Datenbank:\n");

db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
  if (err) {
    console.error("Fehler:", err);
    process.exit(1);
  }

  console.table(tables);

  // Prüfe grades Tabelle
  db.all("PRAGMA table_info(grades)", (err, columns) => {
    if (err) {
      console.error("\n❌ Fehler bei grades:", err);
    } else if (columns.length === 0) {
      console.log("\n❌ Tabelle 'grades' existiert NICHT!");
    } else {
      console.log("\n✅ Tabelle 'grades' Struktur:");
      console.table(columns);
    }
    db.close();
  });
});
