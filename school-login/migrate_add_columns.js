const { db } = require("./db");

function columnExists(cols, name) {
  return cols.some(c => c.name === name);
}

db.all("PRAGMA table_info(users)", [], (err, cols) => {
  if (err) {
    console.error("PRAGMA error:", err);
    process.exit(1);
  }
  console.log("users table columns:", cols.map(c => c.name).join(", "));
  const toAdd = [];
  if (!columnExists(cols, "created_at")) toAdd.push({ name: "created_at", sql: "ALTER TABLE users ADD COLUMN created_at TEXT" });
  if (!columnExists(cols, "last_login")) toAdd.push({ name: "last_login", sql: "ALTER TABLE users ADD COLUMN last_login TEXT" });

  if (toAdd.length === 0) {
    console.log("Keine Migration nötig.");
    process.exit(0);
  }

  (async () => {
    for (const col of toAdd) {
      await new Promise((resolve) => {
        console.log("Adding column:", col.name);
        db.run(col.sql, [], function (e) {
          if (e) {
            console.error("Fehler beim Hinzufügen von", col.name, e);
          } else {
            console.log("Spalte hinzugefügt:", col.name);
          }
          resolve();
        });
      });
    }
    console.log("Migration abgeschlossen.");
    process.exit(0);
  })();
});