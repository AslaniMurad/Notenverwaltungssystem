const { runAsync, getAsync } = require("./dbAsync");

async function ensureSubjectIdByName(subjectName) {
  const normalized = String(subjectName || "").trim();
  if (!normalized) return null;

  const existing = await getAsync(
    "SELECT id FROM subjects WHERE LOWER(name) = LOWER(?)",
    [normalized]
  );
  if (existing) return existing.id;

  try {
    const result = await runAsync("INSERT INTO subjects (name) VALUES (?)", [normalized]);
    return result?.lastID || null;
  } catch (err) {
    if (!String(err).includes("UNIQUE")) throw err;

    const row = await getAsync(
      "SELECT id FROM subjects WHERE LOWER(name) = LOWER(?)",
      [normalized]
    );
    return row?.id || null;
  }
}

module.exports = {
  ensureSubjectIdByName
};
