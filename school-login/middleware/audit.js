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
          `${req.method} ${routePath}`,
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
