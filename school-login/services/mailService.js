const nodemailer = require("nodemailer");

const testOutbox = [];

function parseBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getDeliveryMode() {
  return String(process.env.EMAIL_DELIVERY_MODE || "smtp").trim().toLowerCase();
}

function shouldUseConsoleDelivery() {
  return getDeliveryMode() === "console";
}

function getDefaultFromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || "NVS <no-reply@nvs.htlwydev.at>";
}

function getSmtpTransportConfig() {
  const host = process.env.SMTP_HOST || "localhost";
  const port = Number(process.env.SMTP_PORT || 25);
  const secure = parseBoolean(process.env.SMTP_SECURE, port === 465);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const tlsRejectUnauthorized = parseBoolean(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true);

  return {
    host,
    port,
    secure,
    requireTLS: parseBoolean(process.env.SMTP_REQUIRE_TLS, false),
    auth: user ? { user, pass } : undefined,
    tls: {
      rejectUnauthorized: tlsRejectUnauthorized
    }
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatExpiry(expiresAt) {
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return String(expiresAt || "");
  return date.toLocaleString("de-AT", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: process.env.TZ || "Europe/Vienna"
  });
}

async function sendMail(message) {
  const normalizedMessage = {
    from: message.from || getDefaultFromAddress(),
    ...message
  };

  if (shouldUseConsoleDelivery()) {
    testOutbox.push({
      ...normalizedMessage,
      sentAt: new Date().toISOString()
    });
    return {
      accepted: [normalizedMessage.to],
      rejected: [],
      response: "console-delivery"
    };
  }

  const transporter = nodemailer.createTransport(getSmtpTransportConfig());
  return transporter.sendMail(normalizedMessage);
}

async function sendPasswordResetEmail({
  to,
  oneTimePassword,
  expiresAt,
  loginUrl,
  requestedByEmail
}) {
  const expiryLabel = formatExpiry(expiresAt);
  const subject = "NVS Passwort zuruecksetzen";
  const requesterLine = requestedByEmail
    ? `Diese Zuruecksetzung wurde von ${requestedByEmail} erstellt.`
    : "Diese Zuruecksetzung wurde von der Administration erstellt.";

  const text = [
    "Hallo,",
    "",
    "fuer dein NVS-Konto wurde ein Einmalpasswort erstellt.",
    "",
    `Einmalpasswort: ${oneTimePassword}`,
    `Gueltig bis: ${expiryLabel}`,
    `Login: ${loginUrl}`,
    "",
    "Verwende dieses Passwort genau einmal beim naechsten Login.",
    "Danach musst du sofort ein neues Passwort setzen.",
    "",
    requesterLine,
    "",
    "Falls du diese E-Mail nicht erwartet hast, melde dich bitte bei der Administration."
  ].join("\n");

  const html = `
    <p>Hallo,</p>
    <p>fuer dein NVS-Konto wurde ein Einmalpasswort erstellt.</p>
    <p>
      <strong>Einmalpasswort:</strong>
      <code style="font-size: 16px;">${escapeHtml(oneTimePassword)}</code>
    </p>
    <p><strong>Gueltig bis:</strong> ${escapeHtml(expiryLabel)}</p>
    <p><a href="${escapeHtml(loginUrl)}">Zum Login</a></p>
    <p>Verwende dieses Passwort genau einmal beim naechsten Login. Danach musst du sofort ein neues Passwort setzen.</p>
    <p>${escapeHtml(requesterLine)}</p>
    <p>Falls du diese E-Mail nicht erwartet hast, melde dich bitte bei der Administration.</p>
  `;

  return sendMail({
    to,
    subject,
    text,
    html
  });
}

function getTestOutbox() {
  return testOutbox;
}

function clearTestOutbox() {
  testOutbox.splice(0, testOutbox.length);
}

module.exports = {
  sendMail,
  sendPasswordResetEmail,
  getTestOutbox,
  clearTestOutbox
};
