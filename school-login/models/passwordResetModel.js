const { db, hashPassword, verifyPassword } = require("../db");

const DEFAULT_PASSWORD_RESET_TTL_HOURS = Math.max(
  Number(process.env.PASSWORD_RESET_TTL_HOURS) || 24,
  1
);

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });

function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function parseTimestamp(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getPasswordResetExpiry(now = Date.now()) {
  return new Date(now + DEFAULT_PASSWORD_RESET_TTL_HOURS * 60 * 60 * 1000);
}

function getResetRequestStatus(request, now = Date.now()) {
  if (request.used_at) return "used";
  if (request.invalidated_at) return "invalidated";
  if (!request.sent_at) return "pending";

  const expiresAt = parseTimestamp(request.expires_at);
  if (expiresAt && expiresAt.getTime() <= now) return "expired";
  return "active";
}

function getResetRequestStatusLabel(status) {
  const labels = {
    active: "Aktiv",
    used: "Verbraucht",
    expired: "Abgelaufen",
    invalidated: "Ungueltig",
    pending: "Mail offen"
  };
  return labels[status] || status;
}

function decorateResetRequest(row) {
  const status = getResetRequestStatus(row);
  return {
    ...row,
    expires_at: toIsoString(row.expires_at),
    sent_at: toIsoString(row.sent_at),
    used_at: toIsoString(row.used_at),
    invalidated_at: toIsoString(row.invalidated_at),
    created_at: toIsoString(row.created_at),
    status,
    status_label: getResetRequestStatusLabel(status)
  };
}

async function invalidateActiveRequestsForUser(userId) {
  await runAsync(
    `UPDATE password_reset_requests
     SET invalidated_at = current_timestamp
     WHERE user_id = ? AND used_at IS NULL AND invalidated_at IS NULL`,
    [userId]
  );
}

async function createOneTimePasswordRequest({ userId, requestedByUserId, oneTimePassword }) {
  const expiresAt = getPasswordResetExpiry();
  await invalidateActiveRequestsForUser(userId);

  const insertResult = await runAsync(
    `INSERT INTO password_reset_requests
       (user_id, requested_by_user_id, password_hash, expires_at)
     VALUES (?,?,?,?)`,
    [
      userId,
      requestedByUserId || null,
      hashPassword(oneTimePassword),
      expiresAt.toISOString()
    ]
  );

  return {
    id: insertResult.lastID,
    expiresAt
  };
}

async function markRequestSent(requestId) {
  await runAsync(
    "UPDATE password_reset_requests SET sent_at = current_timestamp WHERE id = ?",
    [requestId]
  );
}

async function invalidateRequest(requestId) {
  await runAsync(
    `UPDATE password_reset_requests
     SET invalidated_at = current_timestamp
     WHERE id = ? AND used_at IS NULL AND invalidated_at IS NULL`,
    [requestId]
  );
}

async function listActiveRequestsForUser(userId, now = Date.now()) {
  const rows = await allAsync(
    `SELECT id, user_id, requested_by_user_id, password_hash, expires_at,
            sent_at, used_at, invalidated_at, created_at
     FROM password_reset_requests
     WHERE user_id = ?
       AND used_at IS NULL
       AND invalidated_at IS NULL
       AND sent_at IS NOT NULL
       AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, new Date(now).toISOString(), 5]
  );

  return rows;
}

async function consumeMatchingOneTimePassword(userId, password) {
  if (!password) return false;

  const activeRequests = await listActiveRequestsForUser(userId);
  for (const request of activeRequests) {
    if (!verifyPassword(request.password_hash, password)) continue;

    await runAsync(
      `UPDATE password_reset_requests
       SET used_at = current_timestamp
       WHERE id = ? AND used_at IS NULL AND invalidated_at IS NULL`,
      [request.id]
    );
    await invalidateActiveRequestsForUser(userId);
    await runAsync("UPDATE users SET must_change_password = ? WHERE id = ?", [true, userId]);
    return true;
  }

  return false;
}

async function listRecentRequestsForUser(userId, limit = 5) {
  const rows = await allAsync(
    `SELECT pr.id, pr.user_id, pr.requested_by_user_id, pr.expires_at,
            pr.sent_at, pr.used_at, pr.invalidated_at, pr.created_at,
            u.email AS requested_by_email
     FROM password_reset_requests pr
     LEFT JOIN users u ON u.id = pr.requested_by_user_id
     WHERE pr.user_id = ?
     ORDER BY pr.created_at DESC
     LIMIT ?`,
    [userId, limit]
  );

  return rows.map(decorateResetRequest);
}

module.exports = {
  DEFAULT_PASSWORD_RESET_TTL_HOURS,
  getPasswordResetExpiry,
  createOneTimePasswordRequest,
  markRequestSent,
  invalidateRequest,
  invalidateActiveRequestsForUser,
  consumeMatchingOneTimePassword,
  listRecentRequestsForUser
};
