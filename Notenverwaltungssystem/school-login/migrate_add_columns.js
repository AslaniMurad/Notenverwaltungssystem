const { db, ready } = require("./db");

async function migrate() {
  await ready;
  const statements = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ"
  ];

  for (const sql of statements) {
    await new Promise((resolve, reject) => {
      db.run(sql, [], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  console.log("Migration abgeschlossen.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration fehlgeschlagen:", err);
  process.exit(1);
});
