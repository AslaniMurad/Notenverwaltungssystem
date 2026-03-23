const { db } = require("../db");

const SENSITIVE_KEY_PATTERN = /(password|pass|token|csrf|secret|hash)/i;
const ALLOWED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ENTITY_PATTERNS = [
  { regex: /\/users(\/|$)/i, entity: "user" },
  { regex: /\/classes(\/|$)/i, entity: "class" },
  { regex: /\/students(\/|$)/i, entity: "student" },
  { regex: /\/grade-templates(\/|$)/i, entity: "exam_template" },
  { regex: /\/add-grade(\/|$)/i, entity: "grade" },
  { regex: /\/special-assessments(\/|$)/i, entity: "special_assessment" },
  { regex: /\/participation(\/|$)/i, entity: "participation" }
];
const SUMMARY_LABELS = {
  email: "E-Mail",
  role: "Rolle",
  status: "Status",
  name: "Name",
  subject: "Fach",
  teacher_id: "Lehrer",
  bulkRole: "Rolle",
  profile_name: "Profil",
  scoring_mode: "Bewertung",
  absence_mode: "Abwesenheit",
  student_id: "Schüler",
  type: "Typ",
  category: "Kategorie",
  weight: "Gewichtung",
  max_points: "Max. Punkte",
  date: "Datum",
  description: "Beschreibung",
  grade: "Note",
  points_achieved: "Punkte",
  external_link: "Link",
  is_absent: "Abwesend",
  note: "Kommentar",
  message: "Nachricht",
  reply: "Antwort",
  ma_symbol: "Mitarbeit",
  ma_note: "Kommentar",
  grade_template_id: "Vorlage",
  id: "ID",
  classId: "Klasse",
  studentId: "Schüler",
  profileId: "Profil",
  gradeId: "Note",
  templateId: "Vorlage",
  assessmentId: "Sonderleistung",
  markId: "Mitarbeit"
};
const VALUE_LABELS = {
  admin: "Admin",
  teacher: "Lehrer",
  student: "Schüler",
  active: "Aktiv",
  locked: "Gesperrt",
  deleted: "Gelöscht",
  points_or_grade: "Punkte oder Note",
  points_and_grade: "Punkte und Note",
  points_only: "Nur Punkte",
  grade_only: "Nur Note",
  include_zero: "Mit 0 bewerten",
  exclude: "Nicht werten",
  Schularbeit: "Schularbeit",
  Test: "Test",
  Wiederholung: "Wiederholung",
  Mitarbeit: "Mitarbeit",
  Projekt: "Projekt",
  Hausuebung: "Hausübung",
  Hausaufgabe: "Hausaufgabe",
  Praesentation: "Präsentation",
  Wunschpruefung: "Wunschprüfung",
  Benutzerdefiniert: "Benutzerdefiniert",
  plus: "+",
  plus_tilde: "+/-",
  neutral: "neutral",
  minus_tilde: "-/+",
  minus: "-"
};
const SKIPPED_SUMMARY_KEYS = new Set([
  "_csrf",
  "password",
  "useInitial",
  "bulkUseInitial",
  "profile_id",
  "set_active"
]);

function detectEntityType(routePath) {
  for (const pattern of ENTITY_PATTERNS) {
    if (pattern.regex.test(routePath)) return pattern.entity;
  }
  return "system";
}

function getEntityIdFromParams(params = {}) {
  const candidateKeys = ["id", "classId", "studentId", "templateId", "assessmentId", "gradeId", "profileId"];
  for (const key of candidateKeys) {
    if (params[key] == null) continue;
    const value = String(params[key]).trim();
    if (value) return value;
  }
  return null;
}

function sanitizeValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 3) return "[max-depth]";

  if (Array.isArray(value)) {
    return value.slice(0, 30).map((entry) => sanitizeValue(entry, depth + 1));
  }

  if (typeof value === "object") {
    const cleaned = {};
    const keys = Object.keys(value).slice(0, 50);
    for (const key of keys) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        cleaned[key] = "[redacted]";
        continue;
      }
      cleaned[key] = sanitizeValue(value[key], depth + 1);
    }
    return cleaned;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
  }

  return value;
}

function getRoutePath(req) {
  const originalPath = String(req.originalUrl || req.url || "").split("?")[0];
  return originalPath || "/";
}

function formatRole(value) {
  return VALUE_LABELS[value] || value;
}

function formatText(value, maxLength = 80) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function countLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function formatSummaryValue(key, value) {
  if (value == null || value === "") return null;

  if (Array.isArray(value)) {
    return value.length ? `${value.length} Einträge` : null;
  }

  if (typeof value === "boolean") {
    return value ? "Ja" : "Nein";
  }

  const trimmed = formatText(value);
  if (!trimmed) return null;

  if (key === "bulkEmails") {
    const amount = countLines(value);
    return amount ? `${amount} E-Mails` : null;
  }

  if (key === "is_absent") {
    return value === "on" || value === true ? "Ja" : "Nein";
  }

  if (key === "teacher_id" || key === "student_id" || key === "grade_template_id") {
    return `ID ${trimmed}`;
  }

  return VALUE_LABELS[trimmed] || trimmed;
}

function buildSummaryFromSource(source, keys = []) {
  if (!source || typeof source !== "object") return [];

  return keys
    .filter((key) => !SKIPPED_SUMMARY_KEYS.has(key) && source[key] != null && source[key] !== "")
    .map((key) => {
      const value = formatSummaryValue(key, source[key]);
      if (!value) return null;
      return `${SUMMARY_LABELS[key] || key}: ${value}`;
    })
    .filter(Boolean);
}

function buildFallbackSummary(body) {
  if (!body || typeof body !== "object") return [];

  return Object.keys(body)
    .filter((key) => !SKIPPED_SUMMARY_KEYS.has(key))
    .slice(0, 3)
    .map((key) => {
      const value = formatSummaryValue(key, body[key]);
      if (!value) return null;
      return `${SUMMARY_LABELS[key] || key}: ${value}`;
    })
    .filter(Boolean);
}

function withSummary(text, summaryEntries = []) {
  if (!summaryEntries.length) return text;
  return `${text} (${summaryEntries.join(", ")})`;
}

function buildAuditDescription(req, routePath) {
  const body = sanitizeValue(req.body || {});
  const params = sanitizeValue(req.params || {});
  const hasFile = Boolean(req.file);

  if (/^\/admin\/users$/i.test(routePath)) {
    return withSummary("Benutzer wurde erstellt", buildSummaryFromSource(body, ["email", "role"]));
  }
  if (/^\/admin\/users\/bulk$/i.test(routePath)) {
    return withSummary(
      "Benutzer wurden gesammelt erstellt",
      buildSummaryFromSource(body, ["bulkRole", "bulkEmails"])
    );
  }
  if (/^\/admin\/users\/[^/]+$/i.test(routePath)) {
    return withSummary("Benutzer wurde bearbeitet", buildSummaryFromSource(body, ["email", "role", "status"]));
  }
  if (/^\/admin\/users\/[^/]+\/reset$/i.test(routePath)) {
    return body.useInitial === "1"
      ? "Passwort wurde auf Initial-Passwort zurückgesetzt"
      : "Passwort wurde geändert";
  }
  if (/^\/admin\/users\/[^/]+\/delete$/i.test(routePath)) {
    return withSummary("Benutzer wurde gelöscht", buildSummaryFromSource(params, ["id"]));
  }
  if (/^\/admin\/classes$/i.test(routePath) || /^\/teacher\/create-class$/i.test(routePath)) {
    return withSummary("Klasse wurde erstellt", buildSummaryFromSource(body, ["name", "subject"]));
  }
  if (/^\/admin\/classes\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Klasse wurde bearbeitet",
      buildSummaryFromSource(body, ["name", "subject", "teacher_id"])
    );
  }
  if (/^\/admin\/classes\/[^/]+\/delete$/i.test(routePath) || /^\/teacher\/delete-class\/[^/]+$/i.test(routePath)) {
    return withSummary("Klasse wurde gelöscht", buildSummaryFromSource(params, ["id"]));
  }
  if (/^\/admin\/classes\/[^/]+\/students\/add$/i.test(routePath) || /^\/teacher\/add-student\/[^/]+$/i.test(routePath)) {
    return withSummary("Schüler wurde hinzugefügt", buildSummaryFromSource(body, ["name", "email"]));
  }
  if (/^\/admin\/classes\/[^/]+\/students\/add-bulk$/i.test(routePath)) {
    return withSummary(
      "Schüler wurden gesammelt hinzugefügt",
      buildSummaryFromSource(body, ["bulkEmails"])
    );
  }
  if (
    /^\/admin\/classes\/[^/]+\/students\/[^/]+\/delete$/i.test(routePath) ||
    /^\/teacher\/delete-student\/[^/]+\/[^/]+$/i.test(routePath)
  ) {
    return withSummary(
      "Schüler wurde entfernt",
      buildSummaryFromSource(params, ["classId", "studentId"])
    );
  }
  if (/^\/teacher\/settings\/save-profile$/i.test(routePath)) {
    return withSummary(
      body.profile_id ? "Benotungsprofil wurde bearbeitet" : "Benotungsprofil wurde erstellt",
      buildSummaryFromSource(body, ["profile_name", "scoring_mode", "absence_mode"])
    );
  }
  if (/^\/teacher\/settings\/activate-profile\/[^/]+$/i.test(routePath)) {
    return withSummary("Benotungsprofil wurde aktiviert", buildSummaryFromSource(params, ["profileId"]));
  }
  if (/^\/teacher\/settings\/delete-profile\/[^/]+$/i.test(routePath)) {
    return withSummary("Benotungsprofil wurde geloescht", buildSummaryFromSource(params, ["profileId"]));
  }
  if (/^\/teacher\/students\/[^/]+\/messages\/[^/]+\/reply$/i.test(routePath)) {
    return withSummary("Antwort auf Schülernachricht wurde gesendet", buildSummaryFromSource(body, ["reply"]));
  }
  if (/^\/teacher\/grades\/[^/]+\/participation$/i.test(routePath)) {
    return withSummary(
      "Mitarbeitsbewertung wurde eingetragen",
      buildSummaryFromSource(body, ["student_id", "ma_symbol", "ma_note"])
    );
  }
  if (/^\/teacher\/delete-participation\/[^/]+\/[^/]+\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Mitarbeitsbewertung wurde gelöscht",
      buildSummaryFromSource(params, ["classId", "studentId", "markId"])
    );
  }
  if (/^\/teacher\/delete-grade\/[^/]+\/[^/]+$/i.test(routePath)) {
    return withSummary("Note wurde gelöscht", buildSummaryFromSource(params, ["classId", "gradeId"]));
  }
  if (/^\/teacher\/delete-grade-attachment\/[^/]+\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Datei bei Note wurde entfernt",
      buildSummaryFromSource(params, ["classId", "gradeId"])
    );
  }
  if (/^\/teacher\/add-grade\/[^/]+\/[^/]+$/i.test(routePath)) {
    const summary = buildSummaryFromSource(body, ["grade", "points_achieved", "is_absent", "note", "external_link"]);
    if (hasFile) summary.push("Datei: hochgeladen");
    return withSummary("Note wurde eingetragen", summary);
  }
  if (/^\/teacher\/create-template\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Prüfungsvorlage wurde erstellt",
      buildSummaryFromSource(body, ["name", "category", "weight", "max_points", "date"])
    );
  }
  if (/^\/teacher\/edit-template\/[^/]+\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Prüfungsvorlage wurde bearbeitet",
      buildSummaryFromSource(body, ["name", "category", "weight", "max_points", "date"])
    );
  }
  if (/^\/teacher\/delete-template\/[^/]+\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Prüfungsvorlage wurde gelöscht",
      buildSummaryFromSource(params, ["classId", "templateId"])
    );
  }
  if (/^\/teacher\/special-assessments\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Sonderleistung wurde erstellt",
      buildSummaryFromSource(body, ["student_id", "type", "name", "grade", "weight"])
    );
  }
  if (/^\/teacher\/delete-special-assessment\/[^/]+\/[^/]+$/i.test(routePath)) {
    return withSummary(
      "Sonderleistung wurde gelöscht",
      buildSummaryFromSource(params, ["classId", "assessmentId"])
    );
  }
  if (/^\/student\/returns\/[^/]+\/message$/i.test(routePath)) {
    return withSummary("Nachricht zur Rückgabe wurde gesendet", buildSummaryFromSource(body, ["message"]));
  }
  if (/^\/student\/returns\/[^/]+\/messages\/seen$/i.test(routePath)) {
    return withSummary("Rückgabe-Nachrichten wurden als gelesen markiert", buildSummaryFromSource(params, ["gradeId"]));
  }
  if (/^\/student\/notifications\/[^/]+\/read$/i.test(routePath)) {
    return withSummary("Benachrichtigung wurde als gelesen markiert", buildSummaryFromSource(params, ["id"]));
  }

  const fallbackSummary = buildFallbackSummary(body);
  if (/delete|remove/i.test(routePath)) {
    return withSummary("Eintrag wurde gelöscht", fallbackSummary);
  }
  if (/create|add|save/i.test(routePath)) {
    return withSummary("Eintrag wurde gespeichert", fallbackSummary);
  }
  return withSummary("Eintrag wurde geändert", fallbackSummary);
}

function createAuditLogMiddleware() {
  return function auditLogMiddleware(req, res, next) {
    if (!ALLOWED_METHODS.has(req.method)) return next();
    if (!req.session?.user) return next();

    const actor = {
      id: req.session.user.id,
      email: req.session.user.email,
      role: req.session.user.role
    };
    const routePath = getRoutePath(req);
    const entityType = detectEntityType(routePath);
    const entityId = getEntityIdFromParams(req.params || {});
    const ipAddress =
      String(req.headers["x-forwarded-for"] || "")
        .split(",")[0]
        .trim() || req.ip || null;
    const userAgent = req.get("user-agent") || null;

    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const description = buildAuditDescription(req, routePath);

      const payload = JSON.stringify(
        sanitizeValue({
          params: req.params || {},
          query: req.query || {},
          body: req.body || {}
        })
      );

      db.run(
        `INSERT INTO audit_logs (
           actor_user_id, actor_email, actor_role, action, entity_type, entity_id,
           http_method, route_path, status_code, ip_address, user_agent, payload
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          actor.id || null,
          actor.email || null,
          actor.role || null,
          description,
          entityType,
          entityId,
          req.method,
          routePath,
          res.statusCode,
          ipAddress,
          userAgent,
          payload
        ],
        (err) => {
          if (err) {
            console.error("Audit log insert failed:", err.message || err);
          }
        }
      );
    });

    next();
  };
}

module.exports = {
  createAuditLogMiddleware
};
