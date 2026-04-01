const { db } = require("../db");

const SENSITIVE_KEY_PATTERN = /(password|pass|token|csrf|secret|hash)/i;
const ALLOWED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ENTITY_PATTERNS = [
  { regex: /\/users(\/|$)/i, entity: "user" },
  { regex: /\/classes(\/|$)/i, entity: "class" },
  { regex: /\/students(\/|$)/i, entity: "student" },
  { regex: /\/assignments(\/|$)/i, entity: "assignment" },
  { regex: /\/grade-templates(\/|$)/i, entity: "exam_template" },
  { regex: /\/add-grade(\/|$)/i, entity: "grade" },
  { regex: /\/special-assessments(\/|$)/i, entity: "special_assessment" },
  { regex: /\/participation(\/|$)/i, entity: "participation" },
  { regex: /\/student-exclusion(\/|$)/i, entity: "student_subject_exclusion" }
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
  student_id: "Schueler",
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
  action: "Aktion",
  ma_symbol: "Mitarbeit",
  ma_note: "Kommentar",
  grade_template_id: "Vorlage",
  subject_id: "Fach",
  head_teacher_id: "Klassenvorstand",
  id: "ID",
  classId: "Klasse",
  studentId: "Schueler",
  profileId: "Profil",
  gradeId: "Note",
  templateId: "Vorlage",
  assessmentId: "Sonderleistung",
  markId: "Mitarbeit"
};
const VALUE_LABELS = {
  admin: "Admin",
  teacher: "Lehrer",
  student: "Schueler",
  active: "Aktiv",
  locked: "Gesperrt",
  deleted: "Geloescht",
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
  Hausuebung: "Hausuebung",
  Hausaufgabe: "Hausaufgabe",
  Praesentation: "Praesentation",
  Wunschpruefung: "Wunschpruefung",
  Benutzerdefiniert: "Benutzerdefiniert",
  include: "Einschliessen",
  exclude: "Ausschliessen",
  plus: "+",
  plus_tilde: "+/-",
  neutral: "neutral",
  minus_tilde: "-/+",
  minus: "-"
};
const ENTITY_LABELS = {
  user: "Benutzer",
  class: "Klasse",
  student: "Schueler",
  assignment: "Fachzuordnung",
  exam_template: "Pruefung",
  grade: "Note",
  special_assessment: "Sonderleistung",
  participation: "Mitarbeit",
  student_subject_exclusion: "Fachausschluss"
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
    return value.length ? `${value.length} Eintraege` : null;
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

function joinSummaryEntries(entries = [], maxEntries = 4) {
  return entries
    .flat(Infinity)
    .filter(Boolean)
    .slice(0, maxEntries)
    .join(", ");
}

function getFormattedSourceValue(source, key) {
  if (!source || typeof source !== "object") return null;
  if (source[key] == null || source[key] === "") return null;
  return formatSummaryValue(key, source[key]);
}

function buildTargetLabel(...candidates) {
  for (const candidate of candidates.flat(Infinity)) {
    const text = formatText(candidate, 120);
    if (text) return text;
  }
  return null;
}

function buildEntityTarget(entityType, entityId) {
  if (entityId == null || entityId === "") return null;
  const label = ENTITY_LABELS[entityType] || "Eintrag";
  return `${label} ID ${String(entityId).trim()}`;
}

function buildActionText(actionTitle, targetLabel, detailSummary) {
  if (targetLabel && detailSummary) return `${actionTitle}: ${targetLabel} (${detailSummary})`;
  if (targetLabel) return `${actionTitle}: ${targetLabel}`;
  if (detailSummary) return `${actionTitle} (${detailSummary})`;
  return actionTitle;
}

function buildScopeLabel(routePath, entityType) {
  const normalizedPath = String(routePath || "").toLowerCase();
  if (normalizedPath.startsWith("/admin/users")) return "Admin / Benutzer";
  if (normalizedPath.startsWith("/admin/classes")) return "Admin / Klassen";
  if (normalizedPath.startsWith("/admin/assignments")) return "Admin / Fachzuordnungen";
  if (normalizedPath.startsWith("/admin/audit-logs")) return "Admin / Audit";
  if (normalizedPath.startsWith("/teacher/settings")) return "Teacher / Einstellungen";
  if (normalizedPath.startsWith("/teacher/grade-templates") || normalizedPath.startsWith("/teacher/create-template") || normalizedPath.startsWith("/teacher/edit-template") || normalizedPath.startsWith("/teacher/bulk-grade-template")) return "Teacher / Pruefungen";
  if (normalizedPath.startsWith("/teacher/add-grade") || normalizedPath.startsWith("/teacher/grades") || normalizedPath.startsWith("/teacher/delete-grade")) return "Teacher / Noten";
  if (normalizedPath.startsWith("/teacher/special-assessments")) return "Teacher / Sonderleistungen";
  if (normalizedPath.startsWith("/teacher/students") || normalizedPath.startsWith("/teacher/add-student") || normalizedPath.startsWith("/teacher/delete-student") || normalizedPath.startsWith("/teacher/student-exclusion")) return "Teacher / Schueler";
  if (normalizedPath.startsWith("/teacher/classes") || normalizedPath.startsWith("/teacher/create-class") || normalizedPath.startsWith("/teacher/delete-class")) return "Teacher / Faecher";
  if (normalizedPath.startsWith("/teacher/test-questions")) return "Teacher / Rueckfragen";
  if (normalizedPath.startsWith("/student/returns")) return "Student / Rueckgaben";
  if (normalizedPath.startsWith("/student/notifications")) return "Student / Benachrichtigungen";

  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0] === "admin" ? "Admin" : parts[0] === "teacher" ? "Teacher" : parts[0] === "student" ? "Student" : formatText(parts[0]);
    const second = formatText(parts[1].replace(/-/g, " "));
    return [first, second].filter(Boolean).join(" / ");
  }
  return ENTITY_LABELS[entityType] || "System";
}

function buildAuditEntry({ scopeLabel, actionTitle, targetLabel = null, detailEntries = [] }) {
  const detailSummary = joinSummaryEntries(detailEntries);
  return {
    scopeLabel: scopeLabel || null,
    actionTitle,
    targetLabel: targetLabel || null,
    detailSummary: detailSummary || null,
    action: buildActionText(actionTitle, targetLabel, detailSummary)
  };
}

function buildAuditDescription(req, routePath, entityType, entityId) {
  const body = sanitizeValue(req.body || {});
  const params = sanitizeValue(req.params || {});
  const hasFile = Boolean(req.file);
  const scopeLabel = buildScopeLabel(routePath, entityType);
  const entityTarget = buildEntityTarget(entityType, entityId);

  if (/^\/admin\/users$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Benutzer erstellt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "email"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["role"])
    });
  }
  if (/^\/admin\/users\/bulk$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Benutzer gesammelt erstellt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "bulkEmails"), "Mehrere Benutzer"),
      detailEntries: buildSummaryFromSource(body, ["bulkRole"])
    });
  }
  if (/^\/admin\/users\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Benutzer bearbeitet",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "email"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["role", "status"])
    });
  }
  if (/^\/admin\/users\/[^/]+\/reset$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: body.useInitial === "1" ? "Passwort auf Initial-Passwort gesetzt" : "Passwort geaendert",
      targetLabel: entityTarget
    });
  }
  if (/^\/admin\/users\/[^/]+\/delete$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Benutzer geloescht",
      targetLabel: entityTarget
    });
  }
  if (/^\/admin\/classes$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Klasse erstellt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "name"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["head_teacher_id"])
    });
  }
  if (/^\/admin\/classes\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Klasse bearbeitet",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "name"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["head_teacher_id"])
    });
  }
  if (/^\/admin\/classes\/[^/]+\/delete$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Klasse geloescht",
      targetLabel: entityTarget
    });
  }
  if (/^\/admin\/classes\/[^/]+\/students\/add$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Schueler zur Klasse hinzugefuegt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "email"), getFormattedSourceValue(body, "name"), buildEntityTarget("student", params.studentId)),
      detailEntries: buildSummaryFromSource(params, ["id"])
    });
  }
  if (/^\/admin\/classes\/[^/]+\/students\/add-bulk$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Schueler gesammelt zur Klasse hinzugefuegt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "bulkEmails"), "Mehrere Schueler"),
      detailEntries: buildSummaryFromSource(params, ["id"])
    });
  }
  if (/^\/admin\/classes\/[^/]+\/students\/[^/]+\/delete$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Schueler aus Klasse entfernt",
      targetLabel: buildEntityTarget("student", params.studentId),
      detailEntries: buildSummaryFromSource(params, ["classId"])
    });
  }
  if (/^\/admin\/assignments/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Fachzuordnung gespeichert",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "subject"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["classId", "teacher_id", "subject_id"])
    });
  }
  if (/^\/teacher\/create-class$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Fach erstellt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "subject"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["class_id"])
    });
  }
  if (/^\/teacher\/delete-class\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Fach verlassen",
      targetLabel: entityTarget
    });
  }
  if (/^\/teacher\/add-student\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Schueler hinzugefuegt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "email"), getFormattedSourceValue(body, "name"), entityTarget)
    });
  }
  if (/^\/teacher\/delete-student\/[^/]+\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Schueler entfernt",
      targetLabel: buildEntityTarget("student", params.studentId),
      detailEntries: buildSummaryFromSource(params, ["classId"])
    });
  }
  if (/^\/teacher\/student-exclusion\/[^/]+\/[^/]+$/i.test(routePath)) {
    const actionValue = String(body.action || "").trim().toLowerCase();
    return buildAuditEntry({
      scopeLabel,
      actionTitle: actionValue === "include" ? "Schueler im Fach eingeschlossen" : "Schueler im Fach ausgeschlossen",
      targetLabel: buildEntityTarget("student", params.studentId),
      detailEntries: [
        buildSummaryFromSource(params, ["classId"]),
        buildSummaryFromSource(body, ["subject_id"])
      ]
    });
  }
  if (/^\/teacher\/settings\/save-profile$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: body.profile_id ? "Benotungsprofil bearbeitet" : "Benotungsprofil erstellt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "profile_name"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["scoring_mode", "absence_mode"])
    });
  }
  if (/^\/teacher\/settings\/activate-profile\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Benotungsprofil aktiviert",
      targetLabel: buildEntityTarget("system", params.profileId)
    });
  }
  if (/^\/teacher\/settings\/delete-profile\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Benotungsprofil geloescht",
      targetLabel: buildEntityTarget("system", params.profileId)
    });
  }
  if (/^\/teacher\/students\/[^/]+\/messages\/[^/]+\/reply$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Antwort auf Rueckfrage gesendet",
      targetLabel: buildEntityTarget("student", params.studentId) || "Rueckfrage",
      detailEntries: buildSummaryFromSource(body, ["reply"])
    });
  }
  if (/^\/teacher\/grades\/[^/]+\/participation$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Mitarbeit eingetragen",
      targetLabel: buildEntityTarget("student", body.student_id),
      detailEntries: buildSummaryFromSource(body, ["ma_symbol", "ma_note"])
    });
  }
  if (/^\/teacher\/delete-participation\/[^/]+\/[^/]+\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Mitarbeit geloescht",
      targetLabel: buildEntityTarget("student", params.studentId),
      detailEntries: buildSummaryFromSource(params, ["markId"])
    });
  }
  if (/^\/teacher\/delete-grade\/[^/]+\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Note geloescht",
      targetLabel: buildEntityTarget("grade", params.gradeId),
      detailEntries: buildSummaryFromSource(params, ["classId"])
    });
  }
  if (/^\/teacher\/delete-grade-attachment\/[^/]+\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Anhang von Note entfernt",
      targetLabel: buildEntityTarget("grade", params.gradeId)
    });
  }
  if (/^\/teacher\/add-grade\/[^/]+\/[^/]+$/i.test(routePath)) {
    const detailEntries = buildSummaryFromSource(body, ["grade", "points_achieved", "is_absent", "note", "external_link"]);
    if (hasFile) detailEntries.push("Datei: hochgeladen");
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Note eingetragen",
      targetLabel: buildEntityTarget("student", params.studentId),
      detailEntries
    });
  }
  if (/^\/teacher\/create-template\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Pruefung erstellt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "name"), entityTarget),
      detailEntries: buildSummaryFromSource(body, ["category", "weight", "max_points", "date"])
    });
  }
  if (/^\/teacher\/edit-template\/[^/]+\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Pruefung bearbeitet",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "name"), buildEntityTarget("exam_template", params.templateId)),
      detailEntries: buildSummaryFromSource(body, ["category", "weight", "max_points", "date"])
    });
  }
  if (/^\/teacher\/delete-template\/[^/]+\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Pruefung geloescht",
      targetLabel: buildEntityTarget("exam_template", params.templateId)
    });
  }
  if (/^\/teacher\/special-assessments\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Sonderleistung erstellt",
      targetLabel: buildTargetLabel(getFormattedSourceValue(body, "name"), buildEntityTarget("student", body.student_id)),
      detailEntries: buildSummaryFromSource(body, ["type", "grade", "weight"])
    });
  }
  if (/^\/teacher\/delete-special-assessment\/[^/]+\/[^/]+$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Sonderleistung geloescht",
      targetLabel: buildEntityTarget("special_assessment", params.assessmentId)
    });
  }
  if (/^\/student\/returns\/[^/]+\/message$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Nachricht zur Rueckgabe gesendet",
      targetLabel: buildEntityTarget("grade", params.gradeId),
      detailEntries: buildSummaryFromSource(body, ["message"])
    });
  }
  if (/^\/student\/returns\/[^/]+\/messages\/seen$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Rueckgabe-Nachrichten gelesen",
      targetLabel: buildEntityTarget("grade", params.gradeId)
    });
  }
  if (/^\/student\/notifications\/[^/]+\/read$/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Benachrichtigung gelesen",
      targetLabel: entityTarget
    });
  }

  const fallbackSummary = buildFallbackSummary(body);
  if (/delete|remove/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Eintrag geloescht",
      targetLabel: entityTarget,
      detailEntries: fallbackSummary
    });
  }
  if (/create|add|save/i.test(routePath)) {
    return buildAuditEntry({
      scopeLabel,
      actionTitle: "Eintrag gespeichert",
      targetLabel: entityTarget,
      detailEntries: fallbackSummary
    });
  }
  return buildAuditEntry({
    scopeLabel,
    actionTitle: "Eintrag bearbeitet",
    targetLabel: entityTarget,
    detailEntries: fallbackSummary
  });
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
      const auditEntry = buildAuditDescription(req, routePath, entityType, entityId);

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
           http_method, route_path, status_code, ip_address, user_agent, payload,
           scope_label, action_title, target_label, detail_summary
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          actor.id || null,
          actor.email || null,
          actor.role || null,
          auditEntry.action,
          entityType,
          entityId,
          req.method,
          routePath,
          res.statusCode,
          ipAddress,
          userAgent,
          payload,
          auditEntry.scopeLabel,
          auditEntry.actionTitle,
          auditEntry.targetLabel,
          auditEntry.detailSummary
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
