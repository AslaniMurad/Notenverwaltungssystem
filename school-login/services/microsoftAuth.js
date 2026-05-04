const crypto = require("crypto");

const MICROSOFT_SCOPE = "openid profile email";
const USERINFO_URL = "https://graph.microsoft.com/oidc/userinfo";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDomain(value) {
  return normalizeEmail(value).replace(/^@+/, "");
}

function buildMicrosoftAuthConfig() {
  const clientId = String(process.env.MICROSOFT_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.MICROSOFT_CLIENT_SECRET || "").trim();
  const tenantId = String(process.env.MICROSOFT_TENANT_ID || "").trim();
  const redirectUri = String(process.env.MICROSOFT_REDIRECT_URI || "").trim();
  const allowedDomain = normalizeDomain(process.env.MICROSOFT_ALLOWED_DOMAIN);
  const enabled = Boolean(clientId && clientSecret && tenantId && redirectUri);
  const baseUrl = enabled
    ? `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0`
    : "";

  return {
    clientId,
    clientSecret,
    tenantId,
    redirectUri,
    allowedDomain,
    enabled,
    authorizeUrl: enabled ? `${baseUrl}/authorize` : "",
    tokenUrl: enabled ? `${baseUrl}/token` : ""
  };
}

const microsoftAuthConfig = buildMicrosoftAuthConfig();

function createMicrosoftAuthorizationRequest() {
  if (!microsoftAuthConfig.enabled) {
    return null;
  }

  const state = crypto.randomBytes(24).toString("hex");
  const nonce = crypto.randomBytes(24).toString("hex");
  const params = new URLSearchParams({
    client_id: microsoftAuthConfig.clientId,
    response_type: "code",
    redirect_uri: microsoftAuthConfig.redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPE,
    prompt: "select_account",
    state,
    nonce
  });

  return {
    state,
    nonce,
    url: `${microsoftAuthConfig.authorizeUrl}?${params.toString()}`
  };
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") {
    return {};
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const json = Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (err) {
    return {};
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    const error = new Error("Microsoft response was not valid JSON.");
    error.isMicrosoftAuthError = true;
    error.status = 502;
    throw error;
  }
}

async function fetchMicrosoftUserInfo(accessToken) {
  const response = await fetch(USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    return {};
  }
  return payload;
}

function extractEmail(userInfo, claims) {
  const candidates = [
    userInfo.email,
    userInfo.preferred_username,
    claims.email,
    claims.preferred_username,
    claims.upn
  ];

  for (const candidate of candidates) {
    const email = normalizeEmail(candidate);
    if (email.includes("@")) {
      return email;
    }
  }

  return "";
}

function isAllowedMicrosoftDomain(email) {
  if (!microsoftAuthConfig.allowedDomain) {
    return true;
  }

  return normalizeEmail(email).endsWith(`@${microsoftAuthConfig.allowedDomain}`);
}

async function exchangeMicrosoftCodeForProfile(code) {
  if (!microsoftAuthConfig.enabled) {
    const error = new Error("Microsoft login is not configured.");
    error.isMicrosoftAuthError = true;
    error.status = 503;
    throw error;
  }

  const tokenParams = new URLSearchParams({
    client_id: microsoftAuthConfig.clientId,
    client_secret: microsoftAuthConfig.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: microsoftAuthConfig.redirectUri,
    scope: MICROSOFT_SCOPE
  });

  const tokenResponse = await fetch(microsoftAuthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: tokenParams.toString()
  });

  const tokenPayload = await parseJsonResponse(tokenResponse);
  if (!tokenResponse.ok) {
    const error = new Error("Microsoft login could not be completed.");
    error.isMicrosoftAuthError = true;
    error.status = 502;
    error.details = tokenPayload;
    throw error;
  }

  const claims = decodeJwtPayload(tokenPayload.id_token);
  const userInfo = tokenPayload.access_token
    ? await fetchMicrosoftUserInfo(tokenPayload.access_token)
    : {};
  const email = extractEmail(userInfo, claims);

  if (!email) {
    const error = new Error("Microsoft did not return a usable email address.");
    error.isMicrosoftAuthError = true;
    error.status = 401;
    throw error;
  }

  return {
    email,
    displayName: userInfo.name || claims.name || email,
    oid: claims.oid || userInfo.sub || null,
    tid: claims.tid || null
  };
}

module.exports = {
  microsoftAuthConfig,
  createMicrosoftAuthorizationRequest,
  exchangeMicrosoftCodeForProfile,
  isAllowedMicrosoftDomain,
  normalizeEmail
};
