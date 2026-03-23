#!/usr/bin/env node
const readline = require("readline/promises");
const { stdin, stdout } = require("process");
require("dotenv").config();

const { getPasswordValidationError } = require("./utils/password");

const VALID_ROLES = new Set(["admin", "teacher", "student"]);
const VALID_STATUSES = new Set(["active", "locked", "deleted"]);
let dbModule = null;

function loadDbModule() {
  if (!dbModule) {
    dbModule = require("./db");
  }
  return dbModule;
}

function parseOptionalBoolean(value) {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

function printUsage() {
  console.log(`Usage:
  node create_user.js --email <email> [options]

Options:
  --email <email>                    Required if CREATE_USER_EMAIL is not set
  --password <password>              Optional; omit to enter it securely via prompt
  --role <admin|teacher|student>    Defaults to student
  --status <active|locked|deleted>  Defaults to active
  --must-change-password            Force password change on next login
  --no-must-change-password         Disable forced password change
  --help                            Show this message

Examples:
  node create_user.js --email admin@nvs.proj --role admin
  npm run create:admin -- --email admin@nvs.proj

Security:
  Avoid passing passwords via --password when possible because shell history and process listings can expose them.
`);
}

function parseArgs(argv) {
  const envMustChange = parseOptionalBoolean(process.env.CREATE_USER_MUST_CHANGE_PASSWORD);
  const options = {
    email: process.env.CREATE_USER_EMAIL || "",
    password: process.env.CREATE_USER_PASSWORD || "",
    role: process.env.CREATE_USER_ROLE || "student",
    status: process.env.CREATE_USER_STATUS || "active",
    mustChangePassword: envMustChange ?? true,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--must-change-password") {
      options.mustChangePassword = true;
      continue;
    }
    if (arg === "--no-must-change-password") {
      options.mustChangePassword = false;
      continue;
    }

    const value = argv[index + 1];
    if (value == null) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === "--email") {
      options.email = value;
    } else if (arg === "--password") {
      options.password = value;
    } else if (arg === "--role") {
      options.role = value;
    } else if (arg === "--status") {
      options.status = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
    index += 1;
  }

  return options;
}

function promptSecret(label) {
  if (!stdin.isTTY) {
    return Promise.reject(new Error("Password is missing and stdin is not interactive."));
  }

  return new Promise((resolve, reject) => {
    stdout.write(label);
    let value = "";

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function onData(chunk) {
      const char = chunk.toString("utf8");

      if (char === "\u0003") {
        cleanup();
        reject(new Error("Input aborted."));
        return;
      }

      if (char === "\r" || char === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(value);
        return;
      }

      if (char === "\u007f" || char === "\b") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }

      if (char === "\u001b") {
        return;
      }

      value += char;
      stdout.write("*");
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function promptMissingOptions(options) {
  if (!stdin.isTTY) {
    const missing = [];
    if (!options.email) missing.push("--email");
    if (!options.password) missing.push("--password");
    if (missing.length) {
      throw new Error(`Missing required options: ${missing.join(", ")}`);
    }
    return options;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (!options.email) {
      options.email = await rl.question("E-Mail: ");
    }
    if (!options.role) {
      const roleInput = await rl.question("Rolle [student]: ");
      options.role = roleInput || "student";
    }
    if (!options.status) {
      const statusInput = await rl.question("Status [active]: ");
      options.status = statusInput || "active";
    }
  } finally {
    rl.close();
  }

  if (!options.password) {
    options.password = await promptSecret("Passwort: ");
  }

  return options;
}

function dbGet(sql, params = []) {
  const { db } = loadDbModule();
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  const { db } = loadDbModule();
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ lastID: this?.lastID });
    });
  });
}

async function upsertUser(options) {
  const email = String(options.email || "").trim();
  const password = String(options.password || "");
  const role = String(options.role || "").trim().toLowerCase();
  const status = String(options.status || "").trim().toLowerCase();
  const mustChangePassword = Boolean(options.mustChangePassword);

  if (!email) {
    throw new Error("E-Mail is required.");
  }
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }

  const passwordError = getPasswordValidationError(password);
  if (passwordError) {
    throw new Error(passwordError);
  }

  const { ready, hashPassword } = loadDbModule();
  await ready;

  const existing = await dbGet(
    "SELECT id, email, role, status, must_change_password FROM users WHERE email = ?",
    [email]
  );
  const passwordHash = hashPassword(password);

  if (existing) {
    await dbRun("UPDATE users SET email = ?, role = ?, status = ? WHERE id = ?", [
      email,
      role,
      status,
      existing.id
    ]);
    await dbRun("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?", [
      passwordHash,
      mustChangePassword ? 1 : 0,
      existing.id
    ]);
    return { action: "updated", id: existing.id };
  }

  const result = await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [email, passwordHash, role, status, mustChangePassword ? 1 : 0]
  );
  return { action: "created", id: result.lastID };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  await promptMissingOptions(options);
  const result = await upsertUser(options);
  const createdUser = await dbGet(
    "SELECT id, email, role, status, must_change_password FROM users WHERE id = ?",
    [result.id]
  );

  console.log(`User ${result.action}:`);
  console.table([createdUser]);
}

main()
  .catch((err) => {
    console.error("Fehler beim Erstellen des Users:", err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dbModule?.pool) {
      try {
        await dbModule.pool.end();
      } catch {}
    }
  });
