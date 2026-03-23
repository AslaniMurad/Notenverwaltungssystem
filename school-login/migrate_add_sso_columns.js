const { db, ready } = require("./db");

async function migrate() {
  await ready;
  const statements = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_subject TEXT",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS local_login_enabled BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sso_login TIMESTAMPTZ",
    "CREATE UNIQUE INDEX IF NOT EXISTS users_auth_identity_idx ON users (auth_provider, auth_subject) WHERE auth_provider IS NOT NULL AND auth_subject IS NOT NULL"
  ];

  for (const sql of statements) {
    await new Promise((resolve, reject) => {
      db.run(sql, [], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  console.log("SSO-Migration abgeschlossen.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("SSO-Migration fehlgeschlagen:", err);
  process.exit(1);
});
