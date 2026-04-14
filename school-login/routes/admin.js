const express = require("express");
const router = express.Router();
const { db, hashPassword } = require("../db");
const schoolYearModel = require("../models/schoolYearModel");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createAuditLogMiddleware } = require("../middleware/audit");
const { getPasswordValidationError } = require("../utils/password");
const { deriveNameFromEmail } = require("../utils/studentName");
const { getDisplayName } = require("../utils/userDisplay");

const INITIAL_PASSWORD = process.env.INITIAL_PASSWORD || null;
const AUDIT_PAGE_SIZE = 50;
const AUDIT_ENTITY_LABELS = {
  user: "Benutzer",
  class: "Klasse",
  student: "Schüler",
  assignment: "Fachzuordnung",
  exam_template: "Prüfung",
  grade: "Note",
  special_assessment: "Sonderleistung",
  participation: "Mitarbeit",
  student_subject_exclusion: "Fachausschluss"
};
const AUDIT_CATEGORY_OPTIONS = {
  all: { label: "Hauptlog", role: null },
  admin: { label: "Logs-Admin", role: "admin" },
  teacher: { label: "Logs-Teacher", role: "teacher" },
  student: { label: "Logs-Student", role: "student" }
};
const AUDIT_SEARCH_MODE_OPTIONS = {
  contains: { label: "Contains (Case-insensitive)" },
  regex: { label: "Regex" },
  exact: { label: "Exact" },
  starts_with: { label: "Starts with" }
};
const AUDIT_METHOD_OPTIONS = ["", "POST", "PUT", "PATCH", "DELETE"];
const AUDIT_TEXT_SEARCH_SQL = `COALESCE(action, '') || ' ' ||
      COALESCE(scope_label, '') || ' ' ||
      COALESCE(action_title, '') || ' ' ||
      COALESCE(target_label, '') || ' ' ||
      COALESCE(detail_summary, '') || ' ' ||
      COALESCE(route_path, '')`;
const AUDIT_FIELD_LABELS = {
  email: "E-Mail",
  role: "Rolle",
  status: "Status",
  name: "Name",
  subject: "Fach",
  subject_id: "Fach",
  teacher_id: "Lehrer",
  head_teacher_id: "Klassenvorstand",
  bulkRole: "Rolle",
  bulkEmails: "E-Mails",
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
  action: "Aktion",
  ma_symbol: "Mitarbeit",
  ma_note: "Kommentar",
  grade_template_id: "Vorlage",
  id: "ID",
  classId: "Klasse",
  class_id: "Klasse",
  studentId: "Schüler",
  profileId: "Profil",
  gradeId: "Note",
  templateId: "Vorlage",
  assessmentId: "Sonderleistung",
  markId: "Mitarbeit",
  useInitial: "Initialpasswort"
};
const AUDIT_VALUE_LABELS = {
  admin: "Admin",
  teacher: "Teacher",
  student: "Student",
  active: "Aktiv",
  locked: "Gesperrt",
  deleted: "Gelöscht",
  points_or_grade: "Punkte oder Note",
  points_and_grade: "Punkte und Note",
  points_only: "Nur Punkte",
  grade_only: "Nur Note",
  include_zero: "Mit 0 bewerten",
  exclude: "Nicht werten",
  include: "Einschließen",
  Schularbeit: "Schularbeit",
  Test: "Test",
  Wiederholung: "Wiederholung",
  Mitarbeit: "Mitarbeit",
  Projekt: "Projekt",
  Hausübung: "Hausübung",
  Hausaufgabe: "Hausaufgabe",
  Präsentation: "Präsentation",
  Wunschprüfung: "Wunschprüfung",
  Benutzerdefiniert: "Benutzerdefiniert",
  plus: "+",
  plus_tilde: "+/-",
  neutral: "neutral",
  minus_tilde: "-/+",
  minus: "-"
};
const AUDIT_HIDDEN_PAYLOAD_KEYS = new Set([
  "_csrf",
  "password",
  "bulkPassword",
  "password_hash",
  "must_change_password"
]);

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

function parseAuditFilters(req) {
  const actor = String(req.query.actor || "").trim();
  const action = String(req.query.action || "").trim();
  const route = String(req.query.route || "").trim();
  const entity = String(req.query.entity || "").trim();
  const category = parseAuditCategory(req.query.category);
  const searchMode = parseAuditSearchMode(req.query.searchMode);
  const method = parseAuditMethod(req.query.method);
  const status = parseAuditStatus(req.query.status);
  return { actor, action, route, entity, category, searchMode, method, status };
}

function parseAuditPage(req) {
  const value = Number.parseInt(String(req.query.page || "1"), 10);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function parseAuditCategory(value) {
  const normalized = String(value || "all").trim().toLowerCase();
  return AUDIT_CATEGORY_OPTIONS[normalized] ? normalized : "all";
}

function parseAuditSearchMode(value) {
  const normalized = String(value || "contains").trim().toLowerCase();
  return AUDIT_SEARCH_MODE_OPTIONS[normalized] ? normalized : "contains";
}

function parseAuditMethod(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return AUDIT_METHOD_OPTIONS.includes(normalized) ? normalized : "";
}

function parseAuditStatus(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return /^\d{3}$/.test(text) ? text : "";
}

function getAuditOffset(page = 1) {
  const safePage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : 1;
  return (safePage - 1) * AUDIT_PAGE_SIZE;
}

function getAuditTotalPages(totalCount = 0) {
  const safeCount = Math.max(0, Number(totalCount || 0));
  return Math.max(1, Math.ceil(safeCount / AUDIT_PAGE_SIZE) || 1);
}

function normalizeAuditReturnPath(value) {
  const text = String(value || "").trim();
  if (!text || !text.startsWith("/") || text.startsWith("//")) return null;
  if (text.startsWith("/admin/audit-logs")) return null;
  return text;
}

function getAuditRefererPath(req) {
  const referer = String(req.get("referer") || "").trim();
  const host = String(req.get("host") || "").trim();
  if (!referer || !host) return null;

  try {
    const base = `${req.protocol}://${host}`;
    const url = new URL(referer, base);
    if (url.host !== host) return null;
    return `${url.pathname}${url.search || ""}`;
  } catch {
    return null;
  }
}

function resolveAuditReturnTo(req) {
  const queryTarget = normalizeAuditReturnPath(req.query.returnTo);
  const refererTarget = normalizeAuditReturnPath(getAuditRefererPath(req));
  const sessionTarget = normalizeAuditReturnPath(req.session?.adminAuditReturnTo);
  const resolved = queryTarget || refererTarget || sessionTarget || "/admin";

  if (req.session) {
    req.session.adminAuditReturnTo = resolved;
  }

  return resolved;
}

function validateAuditRegexFilters(filters = {}) {
  if (filters.searchMode !== "regex") return null;

  const regexFields = [
    ["Akteur", filters.actor],
    ["Suchtext", filters.action],
    ["Route", filters.route]
  ];

  for (const [label, value] of regexFields) {
    if (!value) continue;
    try {
      new RegExp(value, "i");
    } catch {
      return `Ungültiger Regex in ${label}.`;
    }
  }

  return null;
}

function pushAuditTextFilter(where, params, expression, value, mode = "contains") {
  const text = String(value || "").trim();
  if (!text) return;

  if (mode === "regex") {
    where.push(`${expression} ~* ?`);
    params.push(text);
    return;
  }

  if (mode === "exact") {
    where.push(`LOWER(${expression}) = LOWER(?)`);
    params.push(text);
    return;
  }

  if (mode === "starts_with") {
    where.push(`LOWER(${expression}) LIKE LOWER(?)`);
    params.push(`${text}%`);
    return;
  }

  where.push(`LOWER(${expression}) LIKE LOWER(?)`);
  params.push(`%${text}%`);
}

function buildAuditWhereClause(filters = {}) {
  const where = [];
  const params = [];

  pushAuditTextFilter(where, params, "COALESCE(actor_email, '')", filters.actor, filters.searchMode);
  pushAuditTextFilter(where, params, AUDIT_TEXT_SEARCH_SQL, filters.action, filters.searchMode);
  pushAuditTextFilter(where, params, "COALESCE(route_path, '')", filters.route, filters.searchMode);

  if (filters.entity) {
    where.push("LOWER(entity_type) = LOWER(?)");
    params.push(filters.entity);
  }
  if (filters.category && filters.category !== "all") {
    const role = AUDIT_CATEGORY_OPTIONS[filters.category]?.role;
    if (role) {
      where.push("LOWER(actor_role) = LOWER(?)");
      params.push(role);
    }
  }
  if (filters.method) {
    where.push("LOWER(http_method) = LOWER(?)");
    params.push(filters.method);
  }
  if (filters.status) {
    where.push("status_code = ?");
    params.push(Number(filters.status));
  }

  return {
    whereClause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    params
  };
}

async function fetchAuditCategoryCounts(filters = {}) {
  const baseFilters = { ...filters, category: "all" };
  const entries = await Promise.all(
    Object.keys(AUDIT_CATEGORY_OPTIONS).map(async (categoryKey) => {
      const count = await fetchAuditLogCount({ ...baseFilters, category: categoryKey });
      return [categoryKey, count];
    })
  );

  return Object.fromEntries(entries);
}

async function fetchAuditLogCount(filters) {
  const { whereClause, params } = buildAuditWhereClause(filters);
  const row = await getAsync(
    `SELECT COUNT(*) AS count
     FROM audit_logs
     ${whereClause}`,
    params
  );
  return Number(row?.count || 0);
}

async function fetchAuditLogsPage({ filters, beforeId = null, afterId = null, limit = 100 }) {
  const { whereClause, params } = buildAuditWhereClause(filters);
  const clauses = whereClause ? [whereClause.slice(6)] : [];
  const queryParams = [...params];
  const safeLimit = Number.isFinite(Number(limit))
    ? Math.max(1, Math.min(AUDIT_PAGE_SIZE, Number(limit)))
    : AUDIT_PAGE_SIZE;

  if (beforeId != null) {
    clauses.push("id < ?");
    queryParams.push(Number(beforeId));
  }
  if (afterId != null) {
    clauses.push("id > ?");
    queryParams.push(Number(afterId));
  }

  const combinedWhere = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await allAsync(
    `SELECT id, actor_email, actor_role, action, scope_label, action_title, target_label, detail_summary,
            entity_type, entity_id, http_method, route_path, status_code, ip_address, user_agent, payload, created_at
     FROM audit_logs
     ${combinedWhere}
     ORDER BY id DESC
     LIMIT ?`,
    [...queryParams, safeLimit]
  );

  return rows;
}

async function fetchAuditLogsByPage({ filters, page = 1 }) {
  const safePage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : 1;
  const pageSize = AUDIT_PAGE_SIZE;
  const offset = getAuditOffset(safePage);
  const { whereClause, params } = buildAuditWhereClause(filters);
  return allAsync(
    `SELECT id, actor_email, actor_role, action, scope_label, action_title, target_label, detail_summary,
            entity_type, entity_id, http_method, route_path, status_code, ip_address, user_agent, payload, created_at
     FROM audit_logs
     ${whereClause}
     ORDER BY id DESC
     LIMIT ?
     OFFSET ?`,
    [...params, pageSize, offset]
  );
}

function parseStoredAuditAction(action) {
  const text = String(action || "").trim();
  if (!text) return { title: "", detailSummary: "" };
  const match = text.match(/^(.*?)(?:\s+\((.*)\))?$/);
  return {
    title: match?.[1] ? String(match[1]).trim() : text,
    detailSummary: match?.[2] ? String(match[2]).trim() : ""
  };
}

function buildAuditScopeFallback(routePath, entityType) {
  const normalized = String(routePath || "").toLowerCase();
  if (normalized.startsWith("/admin/users")) return "Admin / Benutzer";
  if (normalized.startsWith("/admin/classes")) return "Admin / Klassen";
  if (normalized.startsWith("/admin/assignments")) return "Admin / Fachzuordnungen";
  if (normalized.startsWith("/teacher/settings")) return "Teacher / Einstellungen";
  if (normalized.startsWith("/teacher/create-template") || normalized.startsWith("/teacher/edit-template") || normalized.startsWith("/teacher/grade-templates") || normalized.startsWith("/teacher/bulk-grade-template")) return "Teacher / Prüfungen";
  if (normalized.startsWith("/teacher/add-grade") || normalized.startsWith("/teacher/grades") || normalized.startsWith("/teacher/delete-grade")) return "Teacher / Noten";
  if (normalized.startsWith("/teacher/students") || normalized.startsWith("/teacher/add-student") || normalized.startsWith("/teacher/delete-student") || normalized.startsWith("/teacher/student-exclusion")) return "Teacher / Schüler";
  if (normalized.startsWith("/teacher/special-assessments")) return "Teacher / Sonderleistungen";
  if (normalized.startsWith("/teacher/classes") || normalized.startsWith("/teacher/create-class")) return "Teacher / Fächer";
  if (normalized.startsWith("/teacher/test-questions")) return "Teacher / Rückfragen";

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0] === "admin" ? "Admin" : parts[0] === "teacher" ? "Teacher" : parts[0];
    const second = String(parts[1] || "").replace(/-/g, " ");
    return `${first} / ${second}`;
  }
  return AUDIT_ENTITY_LABELS[entityType] || "System";
}

function parseAuditPayload(payload) {
  if (!payload) return null;
  try {
    return typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return null;
  }
}

function humanizeAuditFieldLabel(key) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return "Feld";
  if (AUDIT_FIELD_LABELS[normalizedKey]) return AUDIT_FIELD_LABELS[normalizedKey];

  const text = normalizedKey
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Feld";
}

function formatAuditText(value, maxLength = 180) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function formatAuditFieldValue(key, value) {
  if (value == null || value === "") return null;

  if (Array.isArray(value)) {
    return value.length ? `${value.length} Einträge` : null;
  }

  if (typeof value === "boolean") {
    return value ? "Ja" : "Nein";
  }

  if (typeof value === "object") {
    return formatAuditText(JSON.stringify(value), 220);
  }

  const normalizedKey = String(key || "").trim();
  const rawText = String(value).trim();
  if (!rawText) return null;

  if (normalizedKey === "bulkEmails") {
    const amount = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length;
    return amount ? `${amount} E-Mails` : null;
  }

  if (normalizedKey === "is_absent") {
    return rawText === "on" ? "Ja" : AUDIT_VALUE_LABELS[rawText] || rawText;
  }

  if (/(_id|Id)$/.test(normalizedKey) && /^\d+$/.test(rawText)) {
    return `ID ${rawText}`;
  }

  return AUDIT_VALUE_LABELS[rawText] || formatAuditText(rawText, 220);
}

function buildAuditFieldItems(source, options = {}) {
  if (!source || typeof source !== "object") return [];

  const {
    skipKeys = AUDIT_HIDDEN_PAYLOAD_KEYS,
    maxItems = 12
  } = options;

  const keys = Object.keys(source).filter((key) => {
    if (skipKeys?.has(key)) return false;
    const value = source[key];
    return value != null && value !== "";
  });

  const visibleKeys = keys.slice(0, maxItems);
  const items = visibleKeys
    .map((key) => {
      const value = formatAuditFieldValue(key, source[key]);
      if (!value) return null;
      return {
        label: humanizeAuditFieldLabel(key),
        value
      };
    })
    .filter(Boolean);

  const remaining = keys.length - visibleKeys.length;
  if (remaining > 0) {
    items.push({
      label: "Weitere Felder",
      value: `${remaining} weitere Felder`
    });
  }

  return items;
}

function buildAuditFieldSummary(source, options = {}) {
  const items = buildAuditFieldItems(source, options);
  if (!items.length) return "-";
  return items.map((item) => `${item.label}: ${item.value}`).join(" | ");
}

function buildAuditEntityLabel(entry) {
  if (!entry?.entity_type) return null;
  const label = AUDIT_ENTITY_LABELS[entry.entity_type] || "Eintrag";
  if (entry.entity_id != null && entry.entity_id !== "") {
    return `${label} ID ${entry.entity_id}`;
  }
  return label;
}

function getAuditCategoryLabel(actorRole) {
  const normalized = String(actorRole || "").trim().toLowerCase();
  if (AUDIT_CATEGORY_OPTIONS[normalized]) {
    return AUDIT_CATEGORY_OPTIONS[normalized].label;
  }
  return "Hauptlog";
}

function buildAuditClientSummary(entry) {
  const parts = [
    entry.ip_address ? `IP: ${entry.ip_address}` : null,
    entry.user_agent ? `Client: ${formatAuditText(entry.user_agent, 120)}` : null
  ].filter(Boolean);

  return parts.length ? parts.join(" | ") : "-";
}

function buildAuditCategoryTabs(filters, counts = {}, returnTo = null) {
  return Object.entries(AUDIT_CATEGORY_OPTIONS).map(([key, option]) => ({
    key,
    label: option.label,
    count: Number(counts[key] || 0),
    isCurrent: parseAuditCategory(filters.category) === key,
    href: buildAuditQuery({ ...filters, category: key }, 1, returnTo)
  }));
}

function buildAuditTargetFallback(entry, payload) {
  if (entry.entity_type && entry.entity_id) {
    const label = AUDIT_ENTITY_LABELS[entry.entity_type] || "Eintrag";
    return `${label} ID ${entry.entity_id}`;
  }

  const candidates = [
    payload?.body?.email,
    payload?.body?.name,
    payload?.body?.profile_name,
    payload?.body?.subject,
    payload?.body?.type,
    payload?.params?.id ? `ID ${payload.params.id}` : null,
    payload?.params?.classId ? `Klasse ID ${payload.params.classId}` : null,
    payload?.params?.studentId ? `Schüler ID ${payload.params.studentId}` : null
  ];

  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }
  return null;
}

function buildAuditDetailFallback(payload) {
  const body = payload?.body;
  if (!body || typeof body !== "object") return null;

  const ignoredKeys = new Set(["_csrf", "password", "bulkPassword", "bulkEmails", "reply", "message"]);
  const entries = Object.keys(body)
    .filter((key) => !ignoredKeys.has(key))
    .slice(0, 4)
    .map((key) => `${key}: ${String(body[key] ?? "").trim()}`)
    .filter((entry) => entry && !entry.endsWith(":"));

  return entries.length ? entries.join(", ") : null;
}

function normalizeAuditLogRow(entry) {
  const parsedAction = parseStoredAuditAction(entry.action);
  const payload = parseAuditPayload(entry.payload);
  const createdAt = entry.created_at ? new Date(entry.created_at) : null;
  const createdAtLabel =
    createdAt && !Number.isNaN(createdAt.getTime())
      ? createdAt.toLocaleString("de-DE")
      : "-";
  const actorEmail = String(entry.actor_email || "").trim();
  const actorRole = String(entry.actor_role || "").trim();
  const actorRoleLabel =
    actorRole === "admin" ? "Admin" :
    actorRole === "teacher" ? "Teacher" :
    actorRole === "student" ? "Student" :
    (actorRole || "-");
  const scopeLabel = entry.scope_label || buildAuditScopeFallback(entry.route_path, entry.entity_type);
  const actionTitle = entry.action_title || parsedAction.title || entry.action || "-";
  const targetLabel = entry.target_label || buildAuditTargetFallback(entry, payload) || "-";
  const detailSummary = entry.detail_summary || parsedAction.detailSummary || buildAuditDetailFallback(payload) || "-";
  const normalizedEntry = {
    ...entry,
    scope_label: scopeLabel,
    action_title: actionTitle,
    target_label: targetLabel,
    detail_summary: detailSummary,
    request_label: [entry.http_method, entry.route_path].filter(Boolean).join(" "),
    created_at_label: createdAtLabel,
    actor_label: actorEmail || "-",
    actor_role_label: actorRoleLabel
  };

  return {
    ...normalizedEntry,
    entity_label: buildAuditEntityLabel(normalizedEntry) || "-",
    role_log_label: getAuditCategoryLabel(actorRole),
    params_summary: buildAuditFieldSummary(payload?.params, { maxItems: 6 }),
    query_summary: buildAuditFieldSummary(payload?.query, { maxItems: 6 }),
    body_summary: buildAuditFieldSummary(payload?.body, { maxItems: 10 }),
    client_summary: buildAuditClientSummary(normalizedEntry)
  };
}

function buildAuditQuery(filters = {}, page = 1, returnTo = null) {
  const params = new URLSearchParams();
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.action) params.set("action", filters.action);
  if (filters.route) params.set("route", filters.route);
  if (filters.entity) params.set("entity", filters.entity);
  if (filters.searchMode && filters.searchMode !== "contains") params.set("searchMode", filters.searchMode);
  if (filters.method) params.set("method", filters.method);
  if (filters.status) params.set("status", filters.status);
  if (filters.category && filters.category !== "all") params.set("category", filters.category);
  if (page > 1) params.set("page", String(page));
  if (returnTo) params.set("returnTo", returnTo);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function buildAuditPagination(filters, currentPage, totalCount, returnTo = null) {
  const totalPages = getAuditTotalPages(totalCount);
  const safePage = Math.min(Math.max(1, Number(currentPage || 1)), totalPages);
  const pageSize = AUDIT_PAGE_SIZE;
  const offset = getAuditOffset(safePage);
  const startPage = Math.max(1, safePage - 2);
  const endPage = Math.min(totalPages, safePage + 2);
  const pages = [];

  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    pages.push({
      number: pageNumber,
      isCurrent: pageNumber === safePage,
      href: buildAuditQuery(filters, pageNumber, returnTo)
    });
  }

  return {
    currentPage: safePage,
    totalPages,
    pageSize,
    maxPageSize: AUDIT_PAGE_SIZE,
    rangeStart: totalCount > 0 ? offset + 1 : 0,
    rangeEnd: Math.min(totalCount, offset + pageSize),
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    prevHref: buildAuditQuery(filters, safePage - 1, returnTo),
    nextHref: buildAuditQuery(filters, safePage + 1, returnTo),
    firstHref: buildAuditQuery(filters, 1, returnTo),
    lastHref: buildAuditQuery(filters, totalPages, returnTo),
    pages
  };
}

async function getActiveSchoolYearOrThrow() {
  const activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
  if (!activeSchoolYear) {
    throw new Error("Kein aktives Schuljahr vorhanden.");
  }
  return activeSchoolYear;
}

async function getActiveClassById(classId, columns = "id, name") {
  const activeSchoolYear = await getActiveSchoolYearOrThrow();
  return getAsync(
    `SELECT ${columns}
     FROM classes
     WHERE id = ? AND school_year_id = ?`,
    [classId, activeSchoolYear.id]
  );
}

async function listActiveTeachers() {
  return allAsync(
    "SELECT id, email FROM users WHERE role = 'teacher' AND status = 'active' ORDER BY email ASC"
  );
}

function buildTeacherDirectory(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    map.set(Number(row.id), {
      id: Number(row.id),
      email: String(row.email || "").trim(),
      display_name: getDisplayName({ email: row.email }) || String(row.email || "").trim()
    });
  });
  return map;
}

function normalizeOptionalTeacherId(value) {
  if (value == null || String(value).trim() === "") return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function summarizeAssignmentsByClass(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const classId = Number(row.class_id);
    if (!map.has(classId)) {
      map.set(classId, {
        subjectSet: new Set(),
        teacherSet: new Set(),
        assignmentCount: 0
      });
    }
    const entry = map.get(classId);
    if (row.subject_name) entry.subjectSet.add(String(row.subject_name));
    if (row.teacher_email) entry.teacherSet.add(String(row.teacher_email));
    entry.assignmentCount += 1;
  });
  return map;
}

function decorateClassWithAssignments(classRow, assignmentSummary, teacherDirectory = new Map()) {
  const summary = assignmentSummary.get(Number(classRow.id));
  const assignedSubjects = summary ? [...summary.subjectSet].sort((a, b) => a.localeCompare(b)) : [];
  const teacherEmails = summary ? [...summary.teacherSet].sort((a, b) => a.localeCompare(b)) : [];
  const headTeacher = teacherDirectory.get(Number(classRow.head_teacher_id));

  return {
    ...classRow,
    assigned_subjects: assignedSubjects,
    assigned_subjects_label: assignedSubjects.length ? assignedSubjects.join(", ") : "Keine Fachzuordnungen",
    teacher_emails: teacherEmails.length ? teacherEmails.join(", ") : "",
    head_teacher_email: headTeacher?.email || "",
    head_teacher_display_name: headTeacher?.display_name || "",
    teacher_count: teacherEmails.length,
    assignment_count: summary ? summary.assignmentCount : 0
  };
}

function buildClassDetailTables(classId, assignmentRows = [], students = [], teacherDirectory = new Map()) {
  const subjectMap = new Map();
  const teacherMap = new Map();

  assignmentRows
    .filter((row) => Number(row.class_id) === Number(classId))
    .forEach((row) => {
      const subjectName = String(row.subject_name || "").trim();
      const teacherEmail = String(row.teacher_email || "").trim();
      if (!subjectName || !teacherEmail) return;

      if (!subjectMap.has(subjectName)) {
        subjectMap.set(subjectName, {
          name: subjectName,
          teacherSet: new Set()
        });
      }
      subjectMap.get(subjectName).teacherSet.add(teacherEmail);

      if (!teacherMap.has(teacherEmail)) {
        teacherMap.set(teacherEmail, {
          email: teacherEmail,
          display_name: getDisplayName({ email: teacherEmail }) || teacherEmail,
          subjectSet: new Set()
        });
      }
      teacherMap.get(teacherEmail).subjectSet.add(subjectName);
    });

  const subjectRows = [...subjectMap.values()]
    .map((entry) => {
      const teachers = [...entry.teacherSet].sort((a, b) => a.localeCompare(b));
      return {
        name: entry.name,
        teacher_count: teachers.length,
        teacher_emails: teachers.join(", ")
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const teacherRows = [...teacherMap.values()]
    .map((entry) => {
      const subjects = [...entry.subjectSet].sort((a, b) => a.localeCompare(b));
      return {
        email: entry.email,
        display_name: entry.display_name,
        subject_count: subjects.length,
        subjects_label: subjects.join(", "),
        is_head_teacher: false
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));

  const studentRows = [...students].sort((a, b) => {
    const nameResult = String(a.name || "").localeCompare(String(b.name || ""));
    if (nameResult !== 0) return nameResult;
    return String(a.email || "").localeCompare(String(b.email || ""));
  });

  return {
    subjectRows,
    teacherRows,
    studentRows,
    stats: {
      teacher_count: teacherRows.length,
      student_count: studentRows.length,
      subject_count: subjectRows.length
    }
  };
}

function normalizeCreateMode(value, fallback = "single") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "bulk" ? "bulk" : fallback;
}

function normalizeUserRole(value, fallback = "student") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["student", "teacher", "admin"].includes(normalized) ? normalized : fallback;
}

function normalizeBulkDelimiter(value, fallback = "paragraph") {
  const normalized = String(value || "").trim().toLowerCase();
  return ["paragraph", "comma", "semicolon", "tab"].includes(normalized) ? normalized : fallback;
}

function splitBulkEmails(rawValue, delimiter = "paragraph") {
  const text = String(rawValue || "").replace(/\r/g, "");
  const normalizedDelimiter = normalizeBulkDelimiter(delimiter);

  if (!text.trim()) return [];

  if (normalizedDelimiter === "comma") {
    return text.split(/[,\n]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  if (normalizedDelimiter === "semicolon") {
    return text.split(/[;\n]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  if (normalizedDelimiter === "tab") {
    return text.split(/[\t\n]+/).map((entry) => entry.trim()).filter(Boolean);
  }

  return text.split(/\n+/).map((entry) => entry.trim()).filter(Boolean);
}

function renderCreateUserPage(req, res, options = {}) {
  const {
    bulkResult = null,
    error = null,
    mode = bulkResult ? "bulk" : "single",
    singleForm = {},
    bulkForm = {}
  } = options;

  return res.render("admin/create-user", {
    csrfToken: req.csrfToken(),
    currentUser: req.session.user,
    activePath: "/admin/users/new",
    bulkResult,
    error,
    mode: normalizeCreateMode(mode),
    singleForm: {
      email: String(singleForm.email || "").trim(),
      role: normalizeUserRole(singleForm.role),
      useInitial: Boolean(singleForm.useInitial)
    },
    bulkForm: {
      bulkEmails: String(bulkForm.bulkEmails || "").trim(),
      bulkRole: normalizeUserRole(bulkForm.bulkRole),
      bulkUseInitial: Boolean(bulkForm.bulkUseInitial),
      bulkDelimiter: normalizeBulkDelimiter(bulkForm.bulkDelimiter)
    }
  });
}

function renderAddStudentPage(req, res, classData, options = {}) {
  const {
    error = null,
    bulkResult = null,
    mode = bulkResult ? "bulk" : "single",
    singleForm = {},
    bulkForm = {}
  } = options;

  return res.render("admin/add-student", {
    classData,
    csrfToken: req.csrfToken(),
    currentUser: req.session.user,
    activePath: `/admin/classes/${classData.id}/students/add`,
    error,
    bulkResult,
    mode: normalizeCreateMode(mode),
    singleForm: {
      name: String(singleForm.name || "").trim(),
      email: String(singleForm.email || "").trim()
    },
    bulkForm: {
      bulkEmails: String(bulkForm.bulkEmails || "").trim()
    }
  });
}

router.use(requireAuth, requireRole("admin"));
router.use(createAuditLogMiddleware());
router.use(async (req, res, next) => {
  try {
    res.locals.activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
  } catch (err) {
    res.locals.activeSchoolYear = null;
  }
  next();
});

router.get("/", async (req, res, next) => {
  try {
    const activeSchoolYear = await schoolYearModel.getActiveSchoolYear();

    res.render("admin/home-school-year", {
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl,
      activeSchoolYear
    });
  } catch (err) {
    console.error("DB error fetching admin home stats:", err);
    next(err);
  }
});

router.get("/users", async (req, res, next) => {
  try {
    const idQuery = String(req.query.id || "").trim();
    const emailQuery = String(req.query.email || "").trim();
    const roleQuery = String(req.query.role || "").trim();

    const filters = [];
    const params = [];

    if (idQuery) {
      const idValue = Number.parseInt(idQuery, 10);
      if (!Number.isNaN(idValue)) {
        filters.push("id = ?");
        params.push(idValue);
      }
    }

    if (emailQuery) {
      filters.push("LOWER(email) LIKE LOWER(?)");
      params.push(`%${emailQuery}%`);
    }

    if (["admin", "teacher", "student"].includes(roleQuery)) {
      filters.push("role = ?");
      params.push(roleQuery);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const users = await allAsync(
      `SELECT id, email, role, status, created_at, must_change_password FROM users ${whereClause} ORDER BY id DESC`,
      params
    );
    res.render("admin/users", {
      users,
      query: { id: idQuery, email: emailQuery, role: roleQuery },
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching users (admin list):", err);
    next(err);
  }
});

router.get("/users/new", (req, res) => renderCreateUserPage(req, res));

router.post("/users", async (req, res, next) => {
  const { email, role, password, useInitial } = req.body || {};
  const wantsInitial = useInitial === "on";
  const singleForm = {
    email,
    role,
    useInitial: wantsInitial
  };
  const normalizedRole = normalizeUserRole(role, "");

  if (!email || !normalizedRole || (!password && !wantsInitial)) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Bitte E-Mail, Rolle und eine gültige Passwort-Option angeben.",
      mode: "single",
      singleForm
    });
  }
  if (normalizedRole === "teacher" && wantsInitial) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Für Lehrer darf kein Initial-Passwort vergeben werden.",
      mode: "single",
      singleForm
    });
  }
  if (wantsInitial && !INITIAL_PASSWORD) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
      mode: "single",
      singleForm
    });
  }
  if (wantsInitial) {
    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      res.status(400);
      return renderCreateUserPage(req, res, {
        error: `Initial-Passwort ist zu schwach: ${initialError}`,
        mode: "single",
        singleForm
      });
    }
  } else {
    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      res.status(400);
      return renderCreateUserPage(req, res, {
        error: passwordError,
        mode: "single",
        singleForm
      });
    }
  }

  if (!email || !role || (!password && !wantsInitial)) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Bitte E-Mail, Rolle und eine gültige Passwort-Option angeben.",
      mode: "single",
      singleForm
    });
  }
  if (role === "teacher" && wantsInitial) {
    return res.status(400).render("error", {
      message: "Für Lehrer darf kein Initial-Passwort vergeben werden.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }

  if (wantsInitial) {
    if (!INITIAL_PASSWORD) {
      return res.status(400).render("error", {
        message: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      return res.status(400).render("error", {
        message: `Initial-Passwort ist zu schwach: ${initialError}`,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  } else {
    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return res.status(400).render("error", {
        message: passwordError,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  }

  const chosenPassword = wantsInitial ? INITIAL_PASSWORD : password;
  const mustChange = wantsInitial ? 1 : 0;
  const hash = hashPassword(chosenPassword);

  try {
    await runAsync(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [email, hash, role, "active", mustChange]
    );
    res.redirect("/admin/users?created=1");
  } catch (err) {
    console.error("DB error inserting user:", err);
    if (String(err).includes("UNIQUE")) {
      res.status(409);
      return renderCreateUserPage(req, res, {
        error: "E-Mail existiert bereits.",
        mode: "single",
        singleForm
      });
    }
    next(err);
  }
});

router.post("/users/bulk", async (req, res, next) => {
  const { bulkEmails, bulkRole, bulkPassword, bulkUseInitial, bulkDelimiter } = req.body || {};
  const wantsInitial = bulkUseInitial === "on";
  const normalizedBulkDelimiter = normalizeBulkDelimiter(bulkDelimiter);
  const bulkForm = {
    bulkEmails,
    bulkRole,
    bulkUseInitial: wantsInitial,
    bulkDelimiter: normalizedBulkDelimiter
  };
  const normalizedBulkRole = normalizeUserRole(bulkRole, "");

  if (!normalizedBulkRole) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Bitte wähle eine Rolle für neue Nutzer.",
      mode: "bulk",
      bulkForm
    });
  }
  if (wantsInitial && normalizedBulkRole === "teacher") {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Lehrer dürfen kein Initial-Passwort erhalten.",
      mode: "bulk",
      bulkForm
    });
  }

  if (!bulkRole) {
    return res.status(400).render("error", {
      message: "Bitte wähle eine Rolle für neue Nutzer.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }
  if (wantsInitial && bulkRole === "teacher") {
    return res.status(400).render("error", {
      message: "Lehrer dürfen kein Initial-Passwort erhalten.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }

  const lines = splitBulkEmails(bulkEmails, normalizedBulkDelimiter);

  if (lines.length === 0) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Keine E-Mails zum Anlegen gefunden.",
      mode: "bulk",
      bulkForm
    });
  }
  if (!wantsInitial && !bulkPassword) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Bitte Passwort eingeben oder Initial-Kennwort nutzen.",
      mode: "bulk",
      bulkForm
    });
  }
  if (wantsInitial && !INITIAL_PASSWORD) {
    res.status(400);
    return renderCreateUserPage(req, res, {
      error: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
      mode: "bulk",
      bulkForm
    });
  }
  if (wantsInitial) {
    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      res.status(400);
      return renderCreateUserPage(req, res, {
        error: `Initial-Passwort ist zu schwach: ${initialError}`,
        mode: "bulk",
        bulkForm
      });
    }
  } else {
    const passwordError = getPasswordValidationError(bulkPassword);
    if (passwordError) {
      res.status(400);
      return renderCreateUserPage(req, res, {
        error: passwordError,
        mode: "bulk",
        bulkForm
      });
    }
  }

  if (lines.length === 0) {
    return res.status(400).render("error", {
      message: "Keine E-Mails zum Anlegen gefunden.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }
  if (!wantsInitial && !bulkPassword) {
    return res.status(400).render("error", {
      message: "Bitte Passwort eingeben oder Initial-Kennwort nutzen.",
      status: 400,
      backUrl: "/admin/users/new",
      csrfToken: req.csrfToken()
    });
  }

  if (wantsInitial) {
    if (!INITIAL_PASSWORD) {
      return res.status(400).render("error", {
        message: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      return res.status(400).render("error", {
        message: `Initial-Passwort ist zu schwach: ${initialError}`,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  } else {
    const passwordError = getPasswordValidationError(bulkPassword);
    if (passwordError) {
      return res.status(400).render("error", {
        message: passwordError,
        status: 400,
        backUrl: "/admin/users/new",
        csrfToken: req.csrfToken()
      });
    }
  }

  const chosenPassword = wantsInitial ? INITIAL_PASSWORD : bulkPassword;
  const mustChange = wantsInitial ? 1 : 0;
  const hash = hashPassword(chosenPassword);

  const bulkResult = { success: [], failed: [] };

  for (const line of lines) {
    try {
      await runAsync(
        "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
        [line, hash, normalizedBulkRole, "active", mustChange]
      );
      bulkResult.success.push(line);
    } catch (err) {
      bulkResult.failed.push({ email: line, reason: String(err) });
    }
  }

  return renderCreateUserPage(req, res, {
    bulkResult,
    mode: "bulk",
    bulkForm
  });
});

router.get("/users/:id", async (req, res, next) => {
  const id = req.params.id;
  try {
    const user = await getAsync(
      "SELECT id, email, role, status, created_at, must_change_password FROM users WHERE id = ?",
      [id]
    );
    if (!user) {
      return res.status(404).render("error", {
        message: "Nutzer nicht gefunden.",
        status: 404,
        backUrl: "/admin/users",
        csrfToken: req.csrfToken()
      });
    }

    let classes = [];
    const activeSchoolYear = await schoolYearModel.getActiveSchoolYear();
    if (user.role === "teacher") {
      classes = await allAsync(
        `SELECT cst.id AS assignment_id, c.id, c.name, s.name AS subject
         FROM class_subject_teacher cst
         JOIN classes c ON c.id = cst.class_id
         JOIN subjects s ON s.id = cst.subject_id
         WHERE cst.teacher_id = ? AND cst.school_year_id = ?
         ORDER BY c.created_at DESC`,
        [user.id, activeSchoolYear?.id || 0]
      );
    } else if (user.role === "student") {
      classes = await allAsync(
        `SELECT s.id AS student_id, s.name AS student_name, s.email AS student_email, s.school_year,
                c.id AS class_id, c.name AS class_name, c.subject,
                COALESCE((
                  SELECT STRING_AGG(u2.email, ', ' ORDER BY u2.email)
                  FROM class_subject_teacher cst2
                  JOIN users u2 ON u2.id = cst2.teacher_id
                  WHERE cst2.class_id = c.id
                ), '') AS teacher_emails
         FROM students s
         JOIN classes c ON c.id = s.class_id
         WHERE s.email = ? AND c.school_year_id = ?
         ORDER BY c.name`,
        [user.email, activeSchoolYear?.id || 0]
      );
    }

    res.render("admin/user-details", {
      user,
      classes,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching user detail:", err);
    next(err);
  }
});

router.get("/users/:id/edit", async (req, res, next) => {
  const id = req.params.id;
  try {
    const user = await getAsync(
      "SELECT id, email, role, status, must_change_password FROM users WHERE id = ?",
      [id]
    );
    if (!user)
      return res.status(404).render("error", {
        message: "Nutzer nicht gefunden.",
        status: 404,
        backUrl: "/admin/users",
        csrfToken: req.csrfToken()
      });

    res.render("admin/edit", {
      user,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching user for edit:", err);
    next(err);
  }
});

router.post("/users/:id", async (req, res, next) => {
  const id = req.params.id;
  const { email, role, status } = req.body || {};
  if (!email || !role || !status) {
    return res.status(400).render("error", {
      message: "Fehlende Felder beim Aktualisieren.",
      status: 400,
      backUrl: `/admin/users/${id}/edit`,
      csrfToken: req.csrfToken()
    });
  }

  try {
    await runAsync("UPDATE users SET email = ?, role = ?, status = ? WHERE id = ?", [email, role, status, id]);
    res.redirect("/admin/users");
  } catch (err) {
    console.error("DB error updating user:", err);
    if (String(err).includes("UNIQUE")) {
      return res.status(409).render("error", {
        message: "E-Mail existiert bereits.",
        status: 409,
        backUrl: `/admin/users/${id}/edit`,
        csrfToken: req.csrfToken()
      });
    }
    next(err);
  }
});

router.post("/users/:id/reset", async (req, res, next) => {
  const id = req.params.id;
  const { password, useInitial } = req.body || {};
  const wantsInitial = useInitial === "1";
  const backUrl = wantsInitial ? "/admin/users" : `/admin/users/${id}/edit`;

  if (!wantsInitial && !password) {
    return res.status(400).render("error", {
      message: "Kein Passwort angegeben.",
      status: 400,
      backUrl,
      csrfToken: req.csrfToken()
    });
  }

  if (wantsInitial) {
    if (!INITIAL_PASSWORD) {
      return res.status(400).render("error", {
        message: "Initial-Passwort ist nicht konfiguriert (ENV INITIAL_PASSWORD).",
        status: 400,
        backUrl,
        csrfToken: req.csrfToken()
      });
    }

    const initialError = getPasswordValidationError(INITIAL_PASSWORD);
    if (initialError) {
      return res.status(400).render("error", {
        message: `Initial-Passwort ist zu schwach: ${initialError}`,
        status: 400,
        backUrl,
        csrfToken: req.csrfToken()
      });
    }
  } else {
    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return res.status(400).render("error", {
        message: passwordError,
        status: 400,
        backUrl,
        csrfToken: req.csrfToken()
      });
    }
  }

  const chosenPassword = wantsInitial ? INITIAL_PASSWORD : password;
  const mustChange = wantsInitial ? 1 : 0;
  const hash = hashPassword(chosenPassword);

  try {
    await runAsync("UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?", [hash, mustChange, id]);
    res.redirect("/admin/users");
  } catch (err) {
    console.error("DB error resetting password:", err);
    next(err);
  }
});

router.post("/users/:id/delete", async (req, res, next) => {
  const id = req.params.id;
  try {
    await runAsync("UPDATE users SET status = 'deleted' WHERE id = ?", [id]);
    res.redirect("/admin/users");
  } catch (err) {
    console.error("DB error deleting user:", err);
    next(err);
  }
});

router.get("/classes", async (req, res, next) => {
  try {
    const queryValue = String(req.query.q || "").trim();
    const queryNormalized = queryValue.toLowerCase();
    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    const [classRows, assignmentRows, teachers] = await Promise.all([
      schoolYearModel.listClassesBySchoolYear(activeSchoolYear.id),
      schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id),
      listActiveTeachers()
    ]);
    const teacherDirectory = buildTeacherDirectory(teachers);
    const assignmentSummary = summarizeAssignmentsByClass(assignmentRows);
    const classes = classRows
      .map((row) => decorateClassWithAssignments(row, assignmentSummary, teacherDirectory))
      .filter((row) => {
        if (!queryNormalized) return true;
        return [
          row.name,
          row.assigned_subjects_label,
          row.teacher_emails,
          row.head_teacher_email,
          row.head_teacher_display_name
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(queryNormalized));
      });

    res.render("admin/classes", {
      classes,
      query: queryValue,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching classes:", err);
    next(err);
  }
});

router.get("/classes/new", async (req, res, next) => {
  try {
    const teachers = await listActiveTeachers();
    res.render("admin/create-class", {
      teachers,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    next(err);
  }
});

router.post("/classes", async (req, res, next) => {
  const name = String(req.body?.name || "").trim();
  const headTeacherId = normalizeOptionalTeacherId(req.body?.head_teacher_id);
  if (!name) {
    return res.status(400).render("error", {
      message: "Bitte alle Pflichtfelder ausfüllen.",
      status: 400,
      backUrl: "/admin/classes/new",
      csrfToken: req.csrfToken()
    });
  }
  try {
    const teacherDirectory = buildTeacherDirectory(await listActiveTeachers());
    if (headTeacherId && !teacherDirectory.has(Number(headTeacherId))) {
      return res.status(400).render("error", {
        message: "Klassenvorstand nicht gefunden.",
        status: 400,
        backUrl: "/admin/classes/new",
        csrfToken: req.csrfToken()
      });
    }

    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    await runAsync("INSERT INTO classes (name, subject, subject_id, school_year_id, head_teacher_id) VALUES (?,?,?,?,?)", [
      name,
      null,
      null,
      activeSchoolYear.id,
      headTeacherId
    ]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error creating class:", err);
    next(err);
  }
});

router.get("/classes/:id", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    const [classRow, assignmentRows, students, teachers] = await Promise.all([
      getActiveClassById(classId, "id, name, head_teacher_id, created_at"),
      schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id),
      schoolYearModel.listStudentsByClassId(classId),
      listActiveTeachers()
    ]);

    if (!classRow) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    const teacherDirectory = buildTeacherDirectory(teachers);
    const classAssignments = assignmentRows.filter((row) => Number(row.class_id) === Number(classId));
    const classData = decorateClassWithAssignments(
      classRow,
      summarizeAssignmentsByClass(classAssignments),
      teacherDirectory
    );
    const detailData = buildClassDetailTables(classId, classAssignments, students, teacherDirectory);
    const teacherRows = detailData.teacherRows.map((row) => ({
      ...row,
      is_head_teacher: classData.head_teacher_email
        ? row.email.toLowerCase() === classData.head_teacher_email.toLowerCase()
        : false
    }));

    res.render("admin/class-detail", {
      classData,
      stats: detailData.stats,
      subjectRows: detailData.subjectRows,
      teacherRows,
      students: detailData.studentRows,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error loading class detail:", err);
    next(err);
  }
});

router.get("/classes/:id/edit", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const [classData, teachers] = await Promise.all([
      getActiveClassById(classId, "id, name, head_teacher_id"),
      listActiveTeachers()
    ]);

    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    res.render("admin/edit-class", {
      classData,
      teachers,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error fetching class for edit:", err);
    next(err);
  }
});

router.post("/classes/:id", async (req, res, next) => {
  const classId = req.params.id;
  const name = String(req.body?.name || "").trim();
  const headTeacherId = normalizeOptionalTeacherId(req.body?.head_teacher_id);
  if (!name) {
    return res.status(400).render("error", {
      message: "Bitte alle Pflichtfelder ausfüllen.",
      status: 400,
      backUrl: `/admin/classes/${classId}/edit`,
      csrfToken: req.csrfToken()
    });
  }

  try {
    const teacherDirectory = buildTeacherDirectory(await listActiveTeachers());
    if (headTeacherId && !teacherDirectory.has(Number(headTeacherId))) {
      return res.status(400).render("error", {
        message: "Klassenvorstand nicht gefunden.",
        status: 400,
        backUrl: `/admin/classes/${classId}/edit`,
        csrfToken: req.csrfToken()
      });
    }

    const classData = await getActiveClassById(classId, "id");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    await runAsync("UPDATE classes SET name = ?, subject = ?, subject_id = ?, head_teacher_id = ? WHERE id = ?", [
      name,
      null,
      null,
      headTeacherId,
      classId
    ]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error updating class:", err);
    next(err);
  }
});

router.post("/classes/:id/delete", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const classData = await getActiveClassById(classId, "id");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }
    await runAsync(
      "DELETE FROM grade_notifications WHERE student_id IN (SELECT id FROM students WHERE class_id = ?)",
      [classId]
    );
    await runAsync("DELETE FROM students WHERE class_id = ?", [classId]);
    await runAsync("DELETE FROM classes WHERE id = ?", [classId]);
    res.redirect("/admin/classes");
  } catch (err) {
    console.error("DB error deleting class:", err);
    next(err);
  }
});

router.get("/classes/:id/students", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const nameQuery = String(req.query.name || "").trim();
    const emailQuery = String(req.query.email || "").trim();

    const activeSchoolYear = await getActiveSchoolYearOrThrow();
    const [classRow, assignmentRows] = await Promise.all([
      getActiveClassById(classId, "id, name"),
      schoolYearModel.listAssignmentRowsBySchoolYear(activeSchoolYear.id)
    ]);
    const classData = classRow
      ? decorateClassWithAssignments(
          classRow,
          summarizeAssignmentsByClass(assignmentRows.filter((row) => Number(row.class_id) === Number(classId)))
        )
      : null;

    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    const filters = ["class_id = ?"];
    const params = [classId];

    if (nameQuery) {
      filters.push("LOWER(name) LIKE LOWER(?)");
      params.push(`%${nameQuery}%`);
    }

    if (emailQuery) {
      filters.push("LOWER(email) LIKE LOWER(?)");
      params.push(`%${emailQuery}%`);
    }

    const whereClause = `WHERE ${filters.join(" AND ")}`;
    const students = await allAsync(
      `SELECT id, name, email FROM students ${whereClause} ORDER BY name`,
      params
    );

    res.render("admin/class-students", {
      classData,
      students,
      query: { name: nameQuery, email: emailQuery },
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error loading students:", err);
    next(err);
  }
});

router.post("/classes/:classId/students/:studentId/delete", async (req, res, next) => {
  const { classId, studentId } = req.params;
  try {
    const classData = await getActiveClassById(classId, "id, name");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    await runAsync("DELETE FROM grade_notifications WHERE student_id = ?", [studentId]);
    await runAsync("DELETE FROM students WHERE id = ? AND class_id = ?", [studentId, classId]);
    res.redirect(`/admin/classes/${classId}/students`);
  } catch (err) {
    console.error("DB error deleting student from class:", err);
    next(err);
  }
});

router.get("/classes/:id/students/add", async (req, res, next) => {
  const classId = req.params.id;
  try {
    const classData = await getActiveClassById(classId, "id, name");
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    return renderAddStudentPage(req, res, classData);
  } catch (err) {
    next(err);
  }
});

router.post("/classes/:id/students/add", async (req, res, next) => {
  const classId = req.params.id;
  const { name, email } = req.body || {};
  const resolvedEmail = String(email || "").trim();
  let resolvedName = String(name || "").trim();

  if (!resolvedEmail) {
    const classData = await getActiveClassById(classId, "id, name");
    if (classData) {
      res.status(400);
      return renderAddStudentPage(req, res, classData, {
        error: "Bitte E-Mail angeben.",
        mode: "single",
        singleForm: { name: resolvedName, email: resolvedEmail }
      });
    }
  }

  if (!resolvedEmail) {
    return res.status(400).render("error", {
      message: "Bitte E-Mail angeben.",
      status: 400,
      backUrl: `/admin/classes/${classId}/students/add`,
      csrfToken: req.csrfToken()
    });
  }
  if (!resolvedName) {
    const derived = deriveNameFromEmail(resolvedEmail);
    if (derived) {
      resolvedName = derived;
    } else {
      const classData = await getActiveClassById(classId, "id, name");
      if (classData) {
        res.status(400);
        return renderAddStudentPage(req, res, classData, {
          error: "Bitte Name angeben oder eine E-Mail im Format vorname.nachname@xy verwenden.",
          mode: "single",
          singleForm: { name: "", email: resolvedEmail }
        });
      }
      return res.status(400).render("error", {
        message: "Bitte Name angeben (oder E-Mail im Format vorname.nachname@xy).",
        status: 400,
        backUrl: `/admin/classes/${classId}/students/add`,
        csrfToken: req.csrfToken()
      });
    }
  }
  try {
    const [classData, activeSchoolYear] = await Promise.all([
      getActiveClassById(classId, "id, name"),
      getActiveSchoolYearOrThrow()
    ]);
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    const legacyUserRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [resolvedEmail]);
    if (!legacyUserRow || legacyUserRow.role !== "student") {
      return renderAddStudentPage(req, res, classData, {
        error: "E-Mail nicht gefunden oder nicht als Schüler registriert.",
        mode: "single",
        singleForm: { name: resolvedName, email: resolvedEmail }
      });
    }

    const legacyDuplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [resolvedEmail, classId]);
    if (legacyDuplicate) {
      return renderAddStudentPage(req, res, classData, {
        error: "Dieser Schüler ist bereits in der Klasse.",
        mode: "single",
        singleForm: { name: resolvedName, email: resolvedEmail }
      });
    }

    const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [resolvedEmail]);
    if (!userRow || userRow.role !== "student") {
      return res.render("admin/add-student", {
        classData,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: `/admin/classes/${classId}/students/add`,
        error: "E-Mail nicht gefunden oder nicht als Schüler registriert.",
        bulkResult: null
      });
    }

    const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [resolvedEmail, classId]);
    if (duplicate) {
      return res.render("admin/add-student", {
        classData,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: `/admin/classes/${classId}/students/add`,
        error: "Dieser Schüler ist bereits in der Klasse.",
        bulkResult: null
      });
    }

    await runAsync("INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)", [
      resolvedName,
      resolvedEmail,
      classId,
      activeSchoolYear.name
    ]);
    res.redirect(`/admin/classes/${classId}/students`);
  } catch (err) {
    console.error("DB error adding student:", err);
    next(err);
  }
});

router.post("/classes/:id/students/add-bulk", async (req, res, next) => {
  const classId = req.params.id;
  const bulkEmailsRaw = String((req.body && req.body.bulkEmails) || "");
  const lines = bulkEmailsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  try {
    const [classData, activeSchoolYear] = await Promise.all([
      getActiveClassById(classId, "id, name"),
      getActiveSchoolYearOrThrow()
    ]);
    if (!classData) {
      return res.status(404).render("error", {
        message: "Klasse nicht gefunden.",
        status: 404,
        backUrl: "/admin/classes",
        csrfToken: req.csrfToken()
      });
    }

    if (lines.length === 0) {
      res.status(400);
      return renderAddStudentPage(req, res, classData, {
        error: "Bitte E-Mails angeben.",
        mode: "bulk",
        bulkForm: { bulkEmails: bulkEmailsRaw }
      });
    }

    const bulkResult = { success: [], failed: [] };

    for (const line of lines) {
      const email = line;
      const derivedName = deriveNameFromEmail(email);
      if (!derivedName) {
        bulkResult.failed.push({
          email,
          reason: "Name fehlt (E-Mail Format vorname.nachname@xy)."
        });
        continue;
      }

      const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [email]);
      if (!userRow || userRow.role !== "student") {
        bulkResult.failed.push({
          email,
          reason: "E-Mail nicht gefunden oder nicht als Student registriert."
        });
        continue;
      }

      const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [email, classId]);
      if (duplicate) {
        bulkResult.failed.push({
          email,
          reason: "Schüler ist bereits in der Klasse."
        });
        continue;
      }

      try {
        await runAsync("INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)", [
          derivedName,
          email,
          classId,
          activeSchoolYear.name
        ]);
        bulkResult.success.push(email);
      } catch (err) {
        bulkResult.failed.push({ email, reason: String(err) });
      }
    }

    return renderAddStudentPage(req, res, classData, {
      bulkResult,
      mode: "bulk"
    });
  } catch (err) {
    console.error("DB error adding students in bulk:", err);
    next(err);
  }
});

router.get("/audit-logs", async (req, res, next) => {
  try {
    const backHref = resolveAuditReturnTo(req);
    const filters = parseAuditFilters(req);
    const filterError = validateAuditRegexFilters(filters);
    if (filterError) {
      const emptyPagination = buildAuditPagination(filters, 1, 0, backHref);
      const emptyCounts = Object.fromEntries(Object.keys(AUDIT_CATEGORY_OPTIONS).map((key) => [key, 0]));
      return res.render("admin/audit-logs", {
        logs: [],
        totalCount: 0,
        categoryCounts: emptyCounts,
        categoryTabs: buildAuditCategoryTabs(filters, emptyCounts, backHref),
        activeCategoryLabel: AUDIT_CATEGORY_OPTIONS[filters.category]?.label || AUDIT_CATEGORY_OPTIONS.all.label,
        pagination: emptyPagination,
        backHref,
        query: filters,
        auditFilterError: filterError,
        auditSearchModes: AUDIT_SEARCH_MODE_OPTIONS,
        auditMethodOptions: AUDIT_METHOD_OPTIONS,
        csrfToken: req.csrfToken(),
        currentUser: req.session.user,
        activePath: req.originalUrl
      });
    }
    const requestedPage = parseAuditPage(req);
    const [totalCount, categoryCounts] = await Promise.all([
      fetchAuditLogCount(filters),
      fetchAuditCategoryCounts(filters)
    ]);
    const totalPages = getAuditTotalPages(totalCount);
    const currentPage = Math.min(requestedPage, totalPages);
    const rawLogs = await fetchAuditLogsByPage({
      filters,
      page: currentPage
    });
    const logs = rawLogs.map(normalizeAuditLogRow);
    const pagination = buildAuditPagination(filters, currentPage, totalCount, backHref);
    const categoryTabs = buildAuditCategoryTabs(filters, categoryCounts, backHref);

    res.render("admin/audit-logs", {
      logs,
      totalCount,
      categoryCounts,
      categoryTabs,
      activeCategoryLabel: AUDIT_CATEGORY_OPTIONS[filters.category]?.label || AUDIT_CATEGORY_OPTIONS.all.label,
      pagination,
      backHref,
      query: filters,
      auditFilterError: null,
      auditSearchModes: AUDIT_SEARCH_MODE_OPTIONS,
      auditMethodOptions: AUDIT_METHOD_OPTIONS,
      csrfToken: req.csrfToken(),
      currentUser: req.session.user,
      activePath: req.originalUrl
    });
  } catch (err) {
    console.error("DB error loading audit logs:", err);
    next(err);
  }
});

router.get("/audit-logs/data", async (req, res, next) => {
  try {
    const filters = parseAuditFilters(req);
    const filterError = validateAuditRegexFilters(filters);
    if (filterError) {
      return res.status(400).json({
        error: filterError,
        logs: [],
        totalCount: 0,
        categoryCounts: Object.fromEntries(Object.keys(AUDIT_CATEGORY_OPTIONS).map((key) => [key, 0])),
        category: filters.category,
        page: 1,
        totalPages: 1,
        pageSize: AUDIT_PAGE_SIZE
      });
    }
    const requestedPage = parseAuditPage(req);
    const [totalCount, categoryCounts] = await Promise.all([
      fetchAuditLogCount(filters),
      fetchAuditCategoryCounts(filters)
    ]);
    const totalPages = getAuditTotalPages(totalCount);
    const currentPage = Math.min(requestedPage, totalPages);
    const logs = (await fetchAuditLogsByPage({
      filters,
      page: currentPage
    })).map(normalizeAuditLogRow);

    return res.json({
      logs,
      totalCount,
      categoryCounts,
      category: filters.category,
      page: currentPage,
      totalPages,
      pageSize: AUDIT_PAGE_SIZE
    });
  } catch (err) {
    console.error("DB error loading audit logs data:", err);
    next(err);
  }
});

module.exports = router;

