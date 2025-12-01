const { db } = require('./db');

function info() {
  db.all("PRAGMA table_info(users)", [], (err, cols) => {
    if (err) {
      console.error("PRAGMA error:", err);
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
  });
}

info();