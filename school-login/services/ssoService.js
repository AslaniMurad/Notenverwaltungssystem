const crypto = require("crypto");
const oidc = require("openid-client");
const { hashPassword } = require("../db");
const { getAsync, runAsync } = require("../utils/dbAsync");

const oidcConfigCache = new Map();
const mockAuthorizationCodes = new Map();
const mockAccessTokens = new Map();

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function pickFirstValue(...values) {
  for (const value of values) {
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeClaimBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function buildAbsoluteUrl(req, pathname) {
  return new URL(pathname, `${getBaseUrl(req)}/`).toString();
}

function sanitizeReturnTo(returnTo) {
  const value = String(returnTo || "").trim();
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/auth/sso")) return null;
  if (value.startsWith("/dev/mock-oidc")) return null;
  return value;
}

function getSsoSettings(req) {
  const simulationEnabled = parseBoolean(process.env.SSO_SIMULATION_ENABLED, false);
  const enabled = parseBoolean(process.env.SSO_ENABLED, false) || simulationEnabled;
  const issuer = process.env.SSO_ISSUER || (simulationEnabled ? buildAbsoluteUrl(req, "/dev/mock-oidc") : "");
  const discoveryUrl =
    process.env.SSO_DISCOVERY_URL ||
    (simulationEnabled ? buildAbsoluteUrl(req, "/dev/mock-oidc/.well-known/openid-configuration") : "");

  return {
    enabled,
    simulationEnabled,
    allowLocalLogin: parseBoolean(process.env.SSO_ALLOW_LOCAL_LOGIN, true),
    displayName: process.env.SSO_DISPLAY_NAME || "LogoDIDACT",
    providerKey: process.env.SSO_PROVIDER_KEY || "logodidact",
    issuer,
    discoveryUrl,
    clientId: process.env.SSO_CLIENT_ID || (simulationEnabled ? "school-login-local" : ""),
    clientSecret: process.env.SSO_CLIENT_SECRET || (simulationEnabled ? "school-login-local-secret" : ""),
    redirectUri: process.env.SSO_REDIRECT_URI || buildAbsoluteUrl(req, "/auth/sso/callback"),
    postLogoutRedirectUri:
      process.env.SSO_POST_LOGOUT_REDIRECT_URI || buildAbsoluteUrl(req, "/login"),
    scope: process.env.SSO_SCOPE || process.env.SSO_SCOPES || "openid profile email",
    emailClaim: process.env.SSO_EMAIL_CLAIM || "email",
    usernameClaim: process.env.SSO_USERNAME_CLAIM || "preferred_username",
    roleClaim: process.env.SSO_ROLE_CLAIM || "role",
    autoLinkByEmail: parseBoolean(process.env.SSO_AUTO_LINK_BY_EMAIL, true),
    autoCreateUsers: parseBoolean(process.env.SSO_AUTO_CREATE_USERS, false),
    autoCreateRole: process.env.SSO_AUTO_CREATE_ROLE || "student",
    requireVerifiedEmail: parseBoolean(process.env.SSO_REQUIRE_VERIFIED_EMAIL, false),
    allowInsecureHttp:
      simulationEnabled || parseBoolean(process.env.SSO_ALLOW_INSECURE_HTTP, false)
  };
}

function getSsoLoginViewModel(req) {
  const settings = getSsoSettings(req);
  const params = new URLSearchParams();
  const returnTo = sanitizeReturnTo(req.query?.returnTo);
  if (returnTo) params.set("returnTo", returnTo);

  return {
    enabled: settings.enabled,
    allowLocalLogin: settings.allowLocalLogin,
    displayName: settings.displayName,
    startPath: `/auth/sso/start${params.toString() ? `?${params.toString()}` : ""}`,
    simulationEnabled: settings.simulationEnabled
  };
}

function ensureSsoConfigured(req) {
  const settings = getSsoSettings(req);
  if (!settings.enabled) {
    const err = new Error("SSO ist nicht aktiviert.");
    err.exposeToLogin = true;
    throw err;
  }
  const missing = [];
  if (!settings.discoveryUrl && !settings.issuer) missing.push("SSO_DISCOVERY_URL oder SSO_ISSUER");
  if (!settings.clientId) missing.push("SSO_CLIENT_ID");
  if (!settings.clientSecret) missing.push("SSO_CLIENT_SECRET");
  if (!settings.redirectUri) missing.push("SSO_REDIRECT_URI");
  if (missing.length) {
    const err = new Error(`SSO-Konfiguration unvollstaendig: ${missing.join(", ")}`);
    err.exposeToLogin = true;
    throw err;
  }
  return settings;
}

async function getOidcConfiguration(req, settings = ensureSsoConfigured(req)) {
  const discoveryTarget = settings.discoveryUrl || settings.issuer;
  const cacheKey = `${discoveryTarget}|${settings.clientId}|${settings.clientSecret}`;
  if (!oidcConfigCache.has(cacheKey)) {
    const discoveryOptions = settings.allowInsecureHttp
      ? { execute: [oidc.allowInsecureRequests] }
      : undefined;
    const promise = oidc
      .discovery(
        new URL(discoveryTarget),
        settings.clientId,
        settings.clientSecret,
        undefined,
        discoveryOptions
      )
      .then((config) => {
        if (settings.allowInsecureHttp) {
          oidc.allowInsecureRequests(config);
        }
        return config;
      })
      .catch((err) => {
        oidcConfigCache.delete(cacheKey);
        throw err;
      });
    oidcConfigCache.set(cacheKey, promise);
  }

  return {
    settings,
    config: await oidcConfigCache.get(cacheKey)
  };
}

async function beginSsoAuthorization(req) {
  const { settings, config } = await getOidcConfiguration(req);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const returnTo = sanitizeReturnTo(req.query?.returnTo);

  req.session.oidc = {
    state,
    nonce,
    codeVerifier,
    returnTo,
    startedAt: Date.now()
  };

  const authorizationUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: settings.redirectUri,
    scope: settings.scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce
  });

  return authorizationUrl.toString();
}

function buildClaimProfile(claims, settings) {
  const username = pickFirstValue(claims?.[settings.usernameClaim], claims?.preferred_username);
  const rawEmail = pickFirstValue(claims?.[settings.emailClaim], claims?.email, username);
  const resolvedEmail = isEmailLike(rawEmail) ? normalizeEmail(rawEmail) : "";

  return {
    subject: pickFirstValue(claims?.sub),
    email: resolvedEmail,
    username,
    role: pickFirstValue(claims?.[settings.roleClaim], claims?.role),
    emailVerified: normalizeClaimBoolean(claims?.email_verified, Boolean(resolvedEmail)),
    claims
  };
}

function buildMockUsers() {
  const fromEnv = String(process.env.SSO_SIMULATION_USERS_JSON || "").trim();
  if (fromEnv) {
    try {
      const parsed = JSON.parse(fromEnv);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .map((entry, index) => ({
            email: normalizeEmail(entry.email),
            label: String(entry.label || entry.name || entry.email || `Mock User ${index + 1}`),
            role: String(entry.role || "student"),
            name: String(entry.name || entry.label || entry.email || `Mock User ${index + 1}`),
            sub: String(entry.sub || `mock-${index + 1}`)
          }))
          .filter((entry) => entry.email);
      }
    } catch (err) {
      console.error("Invalid SSO_SIMULATION_USERS_JSON:", err);
    }
  }

  return [
    {
      email: normalizeEmail(process.env.ADMIN_EMAIL || "admin@test.local"),
      label: "Admin Demo",
      role: "admin",
      name: "Admin Demo",
      sub: "mock-admin"
    },
    {
      email: normalizeEmail(process.env.DEMO_TEACHER_EMAIL || "teacher@example.com"),
      label: "Lehrkraft Demo",
      role: "teacher",
      name: "Lehrkraft Demo",
      sub: "mock-teacher"
    },
    {
      email: normalizeEmail(process.env.DEMO_STUDENT_EMAIL || "student@example.com"),
      label: "Schueler Demo",
      role: "student",
      name: "Schueler Demo",
      sub: "mock-student"
    }
  ];
}

function getMockUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  return buildMockUsers().find((entry) => entry.email === normalizedEmail) || null;
}

function buildMockProviderMetadata(req, settings) {
  const issuer = buildAbsoluteUrl(req, "/dev/mock-oidc");
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    end_session_endpoint: `${issuer}/logout`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "profile", "email"],
    claims_supported: ["sub", "email", "email_verified", "preferred_username", "name", "role"],
    id_token_signing_alg_values_supported: ["HS256"],
    authorization_response_iss_parameter_supported: false,
    registration_endpoint: null,
    introspection_endpoint: null,
    revocation_endpoint: null,
    client_id: settings.clientId
  };
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signMockIdToken(payload, clientSecret) {
  const header = {
    alg: "HS256",
    typ: "JWT"
  };
  const encodedHeader = base64urlJson(header);
  const encodedPayload = base64urlJson(payload);
  const signature = crypto
    .createHmac("sha256", clientSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function calculateMockCodeChallenge(codeVerifier) {
  return crypto.createHash("sha256").update(String(codeVerifier || "")).digest("base64url");
}

function cleanupMockState() {
  const now = Date.now();
  for (const [code, entry] of mockAuthorizationCodes.entries()) {
    if (entry.expiresAt <= now) mockAuthorizationCodes.delete(code);
  }
  for (const [token, entry] of mockAccessTokens.entries()) {
    if (entry.expiresAt <= now) mockAccessTokens.delete(token);
  }
}

function validateMockClient(req, settings) {
  const authHeader = String(req.headers.authorization || "");
  let clientId = String(req.body?.client_id || "");
  let clientSecret = String(req.body?.client_secret || "");

  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    clientId = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
    clientSecret = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";
  }

  if (clientId !== settings.clientId || clientSecret !== settings.clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
}

function buildMockAuthorizeParams(query = {}) {
  const preserved = {};
  const keys = [
    "client_id",
    "redirect_uri",
    "response_type",
    "scope",
    "state",
    "nonce",
    "code_challenge",
    "code_challenge_method"
  ];
  keys.forEach((key) => {
    if (query[key] != null) preserved[key] = String(query[key]);
  });
  return preserved;
}

function issueMockAuthorizationCode(req, res, settings, mockUser) {
  cleanupMockState();

  const clientId = String(req.query.client_id || "");
  const redirectUri = String(req.query.redirect_uri || "");
  const responseType = String(req.query.response_type || "");
  const state = String(req.query.state || "");
  const scope = String(req.query.scope || "");
  const codeChallenge = String(req.query.code_challenge || "");
  const codeChallengeMethod = String(req.query.code_challenge_method || "");

  if (clientId !== settings.clientId) {
    return res.status(400).send("Invalid client_id.");
  }
  if (!redirectUri) {
    return res.status(400).send("Missing redirect_uri.");
  }
  if (responseType !== "code") {
    return res.status(400).send("Unsupported response_type.");
  }
  if (!scope.split(/\s+/).includes("openid")) {
    return res.status(400).send("Missing openid scope.");
  }
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    return res.status(400).send("PKCE is required.");
  }

  const code = crypto.randomUUID();
  mockAuthorizationCodes.set(code, {
    clientId,
    redirectUri,
    scope,
    subject: mockUser.sub,
    nonce: String(req.query.nonce || ""),
    codeChallenge,
    email: mockUser.email,
    role: mockUser.role,
    name: mockUser.name,
    preferred_username: mockUser.email,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  const redirectTarget = new URL(redirectUri);
  redirectTarget.searchParams.set("code", code);
  if (state) redirectTarget.searchParams.set("state", state);
  return res.redirect(redirectTarget.toString());
}

function renderMockUserChooser(req, res, settings) {
  return res.render("mock-oidc-login", {
    csrfToken: req.csrfToken(),
    users: buildMockUsers(),
    originalParams: buildMockAuthorizeParams(req.query),
    issuer: buildAbsoluteUrl(req, "/dev/mock-oidc"),
    displayName: settings.displayName
  });
}

function buildMockClaims(req, codeEntry) {
  const issuer = buildAbsoluteUrl(req, "/dev/mock-oidc");
  return {
    iss: issuer,
    aud: getSsoSettings(req).clientId,
    sub: codeEntry.subject,
    email: codeEntry.email,
    email_verified: true,
    preferred_username: codeEntry.preferred_username,
    name: codeEntry.name,
    role: codeEntry.role
  };
}

async function resolveLocalUserFromClaims(profile, settings) {
  if (!profile.subject) {
    const err = new Error("SSO-Antwort enthaelt keine gueltige Benutzerkennung.");
    err.exposeToLogin = true;
    throw err;
  }

  let user = await getAsync(
    "SELECT id, email, role, status, must_change_password, auth_provider, auth_subject, local_login_enabled FROM users WHERE auth_provider = ? AND auth_subject = ?",
    [settings.providerKey, profile.subject]
  );

  if (!user && settings.autoLinkByEmail) {
    if (!profile.email) {
      const err = new Error(
        "SSO-Antwort enthaelt keine E-Mail-Adresse. Bitte den LogoDIDACT-Admin um das Claim 'email' oder 'preferred_username' bitten."
      );
      err.exposeToLogin = true;
      throw err;
    }

    user = await getAsync(
      "SELECT id, email, role, status, must_change_password, auth_provider, auth_subject, local_login_enabled FROM users WHERE email = ?",
      [profile.email]
    );

    if (user && user.auth_provider && user.auth_subject) {
      if (user.auth_provider !== settings.providerKey || user.auth_subject !== profile.subject) {
        const err = new Error(
          "Der Benutzer ist bereits mit einer anderen SSO-Identitaet verknuepft. Bitte die Schuladministration kontaktieren."
        );
        err.exposeToLogin = true;
        throw err;
      }
    }

    if (user && (!user.auth_provider || !user.auth_subject)) {
      await runAsync(
        "UPDATE users SET auth_provider = ?, auth_subject = ?, email_verified = ? WHERE id = ?",
        [settings.providerKey, profile.subject, profile.emailVerified ? 1 : 0, user.id]
      );
      user.auth_provider = settings.providerKey;
      user.auth_subject = profile.subject;
    }
  }

  if (!user && settings.autoCreateUsers) {
    if (!profile.email) {
      const err = new Error("Automatisches Anlegen ist ohne E-Mail-Adresse nicht moeglich.");
      err.exposeToLogin = true;
      throw err;
    }

    const role = ["admin", "teacher", "student"].includes(profile.role)
      ? profile.role
      : settings.autoCreateRole;
    const passwordHash = hashPassword(`SSO-${crypto.randomUUID()}-${crypto.randomUUID()}`);
    const insertResult = await runAsync(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [profile.email, passwordHash, role, "active", 0]
    );

    await runAsync(
      "UPDATE users SET auth_provider = ?, auth_subject = ?, email_verified = ?, local_login_enabled = ?, last_sso_login = current_timestamp WHERE id = ?",
      [settings.providerKey, profile.subject, profile.emailVerified ? 1 : 0, 0, insertResult.lastID]
    );

    user = {
      id: insertResult.lastID,
      email: profile.email,
      role,
      status: "active",
      must_change_password: 0,
      auth_provider: settings.providerKey,
      auth_subject: profile.subject,
      local_login_enabled: 0
    };
  }

  if (!user) {
    const err = new Error(
      "Kein passender Benutzer gefunden. Bitte die E-Mail-Adresse in LogoDIDACT und im Projekt abstimmen."
    );
    err.exposeToLogin = true;
    throw err;
  }

  if (settings.requireVerifiedEmail && !profile.emailVerified) {
    const err = new Error("SSO-Benutzer besitzt keine verifizierte E-Mail-Adresse.");
    err.exposeToLogin = true;
    throw err;
  }

  if (user.status !== "active") {
    const err = new Error("Der Benutzer ist nicht aktiv geschaltet.");
    err.exposeToLogin = true;
    throw err;
  }

  await runAsync(
    "UPDATE users SET email_verified = ?, last_sso_login = current_timestamp WHERE id = ?",
    [profile.emailVerified ? 1 : 0, user.id]
  );

  return user;
}

function buildLogoutUrl(metadata, settings, idToken) {
  const endSessionEndpoint = metadata?.end_session_endpoint;
  if (!endSessionEndpoint) return null;

  const logoutUrl = new URL(endSessionEndpoint);
  if (idToken) logoutUrl.searchParams.set("id_token_hint", idToken);
  if (settings.postLogoutRedirectUri) {
    logoutUrl.searchParams.set("post_logout_redirect_uri", settings.postLogoutRedirectUri);
  }
  if (settings.clientId) logoutUrl.searchParams.set("client_id", settings.clientId);
  return logoutUrl.toString();
}

async function completeSsoAuthorization(req) {
  const sessionState = req.session?.oidc;
  if (!sessionState) {
    const err = new Error("Die SSO-Anmeldung ist abgelaufen. Bitte erneut starten.");
    err.exposeToLogin = true;
    throw err;
  }

  const { settings, config } = await getOidcConfiguration(req);
  const callbackUrl = new URL(`${getBaseUrl(req)}${req.originalUrl}`);
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: sessionState.codeVerifier,
    expectedNonce: sessionState.nonce,
    expectedState: sessionState.state,
    idTokenExpected: true
  });

  const tokenClaims = tokens.claims() || {};
  let userInfo = {};
  if (tokens.access_token && tokenClaims.sub) {
    try {
      userInfo = await oidc.fetchUserInfo(config, tokens.access_token, tokenClaims.sub);
    } catch (err) {
      console.warn("OIDC userinfo fetch failed:", err.message);
    }
  }

  const mergedClaims = { ...tokenClaims, ...userInfo };
  const profile = buildClaimProfile(mergedClaims, settings);
  const user = await resolveLocalUserFromClaims(profile, settings);
  const logoutUrl = buildLogoutUrl(config.serverMetadata(), settings, tokens.id_token);
  const returnTo = sessionState.returnTo;

  delete req.session.oidc;

  return {
    user,
    profile,
    idToken: tokens.id_token || null,
    logoutUrl,
    returnTo
  };
}

function buildSsoLogoutUrl(req) {
  return req.session?.sso?.logoutUrl || null;
}

function createMockOidcRouter() {
  const express = require("express");
  const router = express.Router();

  router.get("/.well-known/openid-configuration", (req, res) => {
    const settings = getSsoSettings(req);
    if (!settings.simulationEnabled) {
      return res.status(404).send("Not found");
    }
    return res.json(buildMockProviderMetadata(req, settings));
  });

  router.get("/jwks", (req, res) => {
    const settings = getSsoSettings(req);
    if (!settings.simulationEnabled) {
      return res.status(404).send("Not found");
    }
    return res.json({ keys: [] });
  });

  router.get("/authorize", (req, res) => {
    const settings = getSsoSettings(req);
    if (!settings.simulationEnabled) {
      return res.status(404).send("Not found");
    }

    const mockUser = getMockUserByEmail(req.query.mock_user);
    if (mockUser) {
      return issueMockAuthorizationCode(req, res, settings, mockUser);
    }

    return renderMockUserChooser(req, res, settings);
  });

  router.post("/token", (req, res) => {
    const settings = getSsoSettings(req);
    if (!settings.simulationEnabled) {
      return res.status(404).send("Not found");
    }

    cleanupMockState();
    const clientCredentials = validateMockClient(req, settings);
    if (!clientCredentials) {
      return res.status(401).json({
        error: "invalid_client"
      });
    }

    if (String(req.body?.grant_type || "") !== "authorization_code") {
      return res.status(400).json({
        error: "unsupported_grant_type"
      });
    }

    const code = String(req.body?.code || "");
    const redirectUri = String(req.body?.redirect_uri || "");
    const codeVerifier = String(req.body?.code_verifier || "");
    const codeEntry = mockAuthorizationCodes.get(code);

    if (!codeEntry) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (codeEntry.clientId !== clientCredentials.clientId || codeEntry.redirectUri !== redirectUri) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (codeEntry.codeChallenge !== calculateMockCodeChallenge(codeVerifier)) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    mockAuthorizationCodes.delete(code);

    const accessToken = crypto.randomUUID();
    const claims = buildMockClaims(req, codeEntry);
    const now = Math.floor(Date.now() / 1000);
    const idToken = signMockIdToken(
      {
        ...claims,
        nonce: codeEntry.nonce || undefined,
        iat: now,
        exp: now + 5 * 60
      },
      settings.clientSecret
    );

    mockAccessTokens.set(accessToken, {
      claims,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    return res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 300,
      scope: codeEntry.scope,
      id_token: idToken
    });
  });

  const userInfoHandler = (req, res) => {
    const settings = getSsoSettings(req);
    if (!settings.simulationEnabled) {
      return res.status(404).send("Not found");
    }

    cleanupMockState();
    const authHeader = String(req.headers.authorization || "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const tokenEntry = mockAccessTokens.get(token);
    if (!tokenEntry) {
      return res.status(401).json({ error: "invalid_token" });
    }

    return res.json(tokenEntry.claims);
  };

  router.get("/userinfo", userInfoHandler);
  router.post("/userinfo", userInfoHandler);

  router.get("/logout", (req, res) => {
    const settings = getSsoSettings(req);
    if (!settings.simulationEnabled) {
      return res.status(404).send("Not found");
    }

    const redirectTarget =
      String(req.query.post_logout_redirect_uri || "").trim() || buildAbsoluteUrl(req, "/login");
    return res.redirect(redirectTarget);
  });

  return router;
}

module.exports = {
  beginSsoAuthorization,
  buildSsoLogoutUrl,
  completeSsoAuthorization,
  createMockOidcRouter,
  getSsoLoginViewModel,
  getSsoSettings,
  sanitizeReturnTo
};
