const { db, ready } = require("./db");

async function info() {
  await ready;
  db.all(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position",
    (err, cols) => {
      if (err) {
        console.error("Schema-Fehler:", err);
        process.exit(1);
      }
      console.log("users table columns:");
      console.table(cols);
      db.get("SELECT * FROM users LIMIT 1", [], (e, row) => {
        if (e) {
          console.error("select sample error:", e);
        } else {
          console.log("sample row:", row);
        }
        process.exit(0);
      });
    }
  );
}

info().catch((err) => {
  console.error("Fehler beim Prüfen der DB:", err);
  process.exit(1);
});
