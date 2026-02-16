// check_tables.js
const { db, ready } = require("./db");

console.log("📋 Alle Tabellen in der Datenbank:\n");

async function run() {
  await ready;
  db.all(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    (err, tables) => {
      if (err) {
        console.error("Fehler:", err);
        process.exit(1);
      }

      console.table(tables);

      db.all(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'grades' ORDER BY ordinal_position",
        (colErr, columns) => {
          if (colErr) {
            console.error("\n❌ Fehler bei grades:", colErr);
          } else if (!columns.length) {
            console.log("\n❌ Tabelle 'grades' existiert NICHT!");
          } else {
            console.log("\n✅ Tabelle 'grades' Struktur:");
            console.table(columns);
          }
          process.exit(0);
        }
      );
    }
  );
}

run().catch((err) => {
  console.error("Fehler beim Prüfen der Tabellen:", err);
  process.exit(1);
});
