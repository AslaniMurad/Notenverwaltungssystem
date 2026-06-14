const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { once } = require("node:events");

process.env.NODE_ENV = "test";
process.env.DB_FILE = ":memory:";
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASS = "StrongPass123!";
process.env.SEED_ADMIN = "true";
process.env.SEED_DEMO = "true";
process.env.DEMO_TEACHER_PASS = "teacherDemo123!";
process.env.DEMO_STUDENT_PASS = "studentDemo123!";
process.env.USE_FAKE_DB = "true";
process.env.MICROSOFT_CLIENT_ID = "test-microsoft-client";
process.env.MICROSOFT_CLIENT_SECRET = "test-microsoft-secret";
process.env.MICROSOFT_TENANT_ID = "test-tenant-id";
process.env.MICROSOFT_REDIRECT_URI = "http://127.0.0.1/auth/microsoft/callback";
process.env.MICROSOFT_ALLOWED_DOMAIN = "test.local";
process.env.TEAMS_MICROSOFT_LOGIN_ONLY = "true";
process.env.EMAIL_DELIVERY_MODE = "console";
process.env.SSO_ENABLED = "true";
process.env.SSO_HEADER = "x-remote-user";
process.env.SSO_REALM = "HTLWYDEV";
process.env.SSO_EMAIL_DOMAIN = "example.com";

const app = require("./server");
const { db, hashPassword } = require("./db");
const { updateRuntimeSettings } = require("./services/appSettings");
const { clearTestOutbox, getTestOutbox } = require("./services/mailService");

let server;
let baseUrl;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

function extractHiddenInput(html, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`name="${escapedName}"\\s+value="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

function extractDataAttribute(html, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escapedName}="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

function extractMicrosoftPopupToken(html) {
  const match = html.match(/"token":"([^"]+)"/);
  return match ? match[1] : null;
}

function extractStudentInitialData(html) {
  const match = html.match(
    /<script type="application\/json" id="student-initial-data">([\s\S]*?)<\/script>/
  );
  assert.ok(match, "Student initial data missing");
  return JSON.parse(match[1]);
}

function buildCookieHeader(cookies) {
  if (!cookies.length) return {};
  const latestCookiesByName = new Map();
  cookies.forEach((cookie) => {
    const cookiePair = cookie.split(";", 1)[0];
    const separatorIndex = cookiePair.indexOf("=");
    const cookieName = separatorIndex >= 0 ? cookiePair.slice(0, separatorIndex) : cookiePair;
    latestCookiesByName.set(cookieName, cookiePair);
  });
  const cookieValue = [...latestCookiesByName.values()].join("; ");
  return { cookie: cookieValue };
}

function mergeCookies(existingCookies, incomingCookies) {
  const cookieMap = new Map();
  [...existingCookies, ...incomingCookies].forEach((cookie) => {
    const pair = cookie.split(";", 1)[0];
    const [name] = pair.split("=");
    cookieMap.set(name, cookie);
  });
  return Array.from(cookieMap.values());
}

function buildMockIdToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

async function startServer() {
  server = http.createServer(app);
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
}

async function stopServer() {
  if (server) {
    server.close();
  }
}

async function fetchWithCookies(path, options = {}, cookies = []) {
  const headers = { ...(options.headers || {}), ...buildCookieHeader(cookies) };
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.text();
  const setCookieHeader = response.headers.get("set-cookie");
  const setCookies = response.headers.getSetCookie?.() || (setCookieHeader ? [setCookieHeader] : []);
  return { response, body, cookies: mergeCookies(cookies, setCookies) };
}

async function loginAndChangePassword(email, password, newPassword) {
  const loginPage = await fetchWithCookies("/login");
  const csrfToken = extractCsrfToken(loginPage.body);
  assert.ok(csrfToken, "CSRF token missing in login page");

  const params = new URLSearchParams({
    _csrf: csrfToken,
    email,
    password
  });

  const loginResponse = await fetchWithCookies(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    },
    loginPage.cookies
  );

  const location = loginResponse.response.headers.get("location");
  if (location !== "/changepw") {
    return { cookies: loginResponse.cookies, redirect: location };
  }

  const forcePage = await fetchWithCookies("/changepw", {}, loginResponse.cookies);
  const forceToken = extractCsrfToken(forcePage.body);
  assert.ok(forceToken, "CSRF token missing in changepw page");

  const changeParams = new URLSearchParams({
    _csrf: forceToken,
    newPassword
  });

  const changeResponse = await fetchWithCookies(
    "/changepw",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: changeParams.toString(),
      redirect: "manual"
    },
    forcePage.cookies
  );

  return {
    cookies: changeResponse.cookies,
    redirect: changeResponse.response.headers.get("location")
  };
}

async function fetchCsrfToken(path, cookies) {
  const page = await fetchWithCookies(path, {}, cookies);
  assert.strictEqual(page.response.status, 200);
  const csrfToken = extractCsrfToken(page.body);
  assert.ok(csrfToken, `CSRF token missing for ${path}`);
  return csrfToken;
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function loginAdmin() {
  let loginResult = await loginAndChangePassword(
    process.env.ADMIN_EMAIL,
    "NewPass12345",
    "NewPass12345"
  );

  if (loginResult.redirect === "/admin") {
    return loginResult;
  }

  loginResult = await loginAndChangePassword(
    process.env.ADMIN_EMAIL,
    process.env.ADMIN_PASS,
    "NewPass12345"
  );
  assert.strictEqual(loginResult.redirect, "/admin");
  return loginResult;
}

async function loginStudent() {
  let loginResult = await loginAndChangePassword(
    "student@example.com",
    "NewPass12345",
    "NewPass12345"
  );

  if (loginResult.redirect === "/student") {
    return loginResult;
  }

  loginResult = await loginAndChangePassword(
    "student@example.com",
    process.env.DEMO_STUDENT_PASS,
    "NewPass12345"
  );
  assert.strictEqual(loginResult.redirect, "/student");
  return loginResult;
}

async function loginTeacher() {
  let loginResult = await loginAndChangePassword(
    "teacher@example.com",
    "NewPass12345",
    "NewPass12345"
  );

  if (loginResult.redirect === "/teacher") {
    return loginResult;
  }

  loginResult = await loginAndChangePassword(
    "teacher@example.com",
    process.env.DEMO_TEACHER_PASS,
    "NewPass12345"
  );
  assert.strictEqual(loginResult.redirect, "/teacher");
  return loginResult;
}

test.before(async () => {
  await startServer();
});

test.after(async () => {
  await stopServer();
});

test("GET /login renders the login form with a CSRF token", async () => {
  const { response, body } = await fetchWithCookies("/login");
  assert.strictEqual(response.status, 200);
  assert.ok(extractCsrfToken(body));
});

test("GET /login renders the Microsoft login option when configured", async () => {
  const { response, body } = await fetchWithCookies("/login");
  assert.strictEqual(response.status, 200);
  assert.match(body, /Mit Microsoft anmelden/);
});

test("Teams login entry renders a Microsoft popup launcher", async () => {
  const loginStart = await fetchWithCookies("/login?teams=1");
  assert.strictEqual(loginStart.response.status, 200);
  assert.match(loginStart.body, /data-microsoft-popup-login/);
  assert.match(loginStart.body, /href="\/auth\/microsoft\?popup=1"/);
  assert.doesNotMatch(loginStart.body, /name="password"/);

  const authStart = await fetchWithCookies(
    "/auth/microsoft?popup=1",
    { redirect: "manual" },
    loginStart.cookies
  );
  const authLocation = authStart.response.headers.get("location");
  assert.ok(authLocation, "Microsoft authorization redirect missing");
  assert.ok(
    authLocation.startsWith("https://login.microsoftonline.com/"),
    "Teams login should continue with Microsoft authorization"
  );
});

test("Teams Microsoft popup handoff completes login in the parent session", { concurrency: false }, async () => {
  const microsoftTeamsEmail = "microsoft-teams-admin@test.local";
  const insertResult = await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [
      microsoftTeamsEmail,
      hashPassword("UnusedPass123!"),
      "admin",
      "active",
      0
    ]
  );
  await dbRun(
    "UPDATE users SET microsoft_oid = ?, microsoft_tenant_id = ?, microsoft_email = ?, microsoft_connected_at = current_timestamp WHERE id = ?",
    ["oid-teams-1", "tenant-teams-1", microsoftTeamsEmail, insertResult.lastID]
  );

  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const requestUrl = typeof input === "string"
      ? input
      : String(input?.url || input);

    if (
      requestUrl.startsWith("https://login.microsoftonline.com/")
      && requestUrl.endsWith("/oauth2/v2.0/token")
    ) {
      return new Response(
        JSON.stringify({
          access_token: "microsoft-teams-access-token",
          id_token: buildMockIdToken({
            email: microsoftTeamsEmail,
            preferred_username: microsoftTeamsEmail,
            oid: "oid-teams-1",
            tid: "tenant-teams-1"
          })
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (requestUrl === "https://graph.microsoft.com/oidc/userinfo") {
      return new Response(
        JSON.stringify({
          email: microsoftTeamsEmail,
          preferred_username: microsoftTeamsEmail,
          name: "Teams Admin",
          sub: "oid-teams-1"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const parentLoginPage = await fetchWithCookies("/login?teams=1");
    assert.strictEqual(parentLoginPage.response.status, 200);
    const parentCsrfToken = extractDataAttribute(parentLoginPage.body, "data-csrf-token");
    assert.ok(parentCsrfToken, "CSRF token missing on Teams login launcher");

    const popupAuthStart = await fetchWithCookies("/auth/microsoft?popup=1", { redirect: "manual" });
    assert.strictEqual(popupAuthStart.response.status, 302);
    const popupAuthLocation = popupAuthStart.response.headers.get("location");
    assert.ok(popupAuthLocation, "Microsoft popup authorization redirect missing");
    const popupAuthUrl = new URL(popupAuthLocation);
    const popupAuthState = popupAuthUrl.searchParams.get("state");
    assert.ok(popupAuthState, "Microsoft popup auth state missing");

    const popupCallback = await fetchWithCookies(
      `/auth/microsoft/callback?code=test-code&state=${encodeURIComponent(popupAuthState)}`,
      { redirect: "manual" },
      popupAuthStart.cookies
    );
    assert.strictEqual(popupCallback.response.status, 200);
    assert.match(popupCallback.body, /Anmeldung abgeschlossen/);
    const completionToken = extractMicrosoftPopupToken(popupCallback.body);
    assert.ok(completionToken, "Popup completion token missing");

    const completionResponse = await fetchWithCookies(
      "/auth/microsoft/popup/complete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": parentCsrfToken
        },
        body: JSON.stringify({ token: completionToken }),
        redirect: "manual"
      },
      parentLoginPage.cookies
    );
    assert.strictEqual(completionResponse.response.status, 200);
    assert.deepStrictEqual(JSON.parse(completionResponse.body), { redirect: "/admin" });

    const adminPage = await fetchWithCookies("/admin", {}, completionResponse.cookies);
    assert.strictEqual(adminPage.response.status, 200);
    assert.match(adminPage.body, /microsoft-teams-admin@test\.local/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("runtime settings can disable Microsoft login without restart", async () => {
  await updateRuntimeSettings({
    microsoftLoginEnabled: false,
    maintenanceModeEnabled: false
  });

  try {
    const { response, body } = await fetchWithCookies("/login");
    assert.strictEqual(response.status, 200);
    assert.doesNotMatch(body, /href="\/auth\/microsoft"/);

    const authStart = await fetchWithCookies("/auth/microsoft", { redirect: "manual" });
    assert.strictEqual(authStart.response.status, 503);
  } finally {
    await updateRuntimeSettings({
      microsoftLoginEnabled: true,
      maintenanceModeEnabled: false
    });
  }
});

test("maintenance mode limits login to admins and kicks existing non-admin sessions", async () => {
  await updateRuntimeSettings({
    microsoftLoginEnabled: true,
    maintenanceModeEnabled: false
  });
  const teacherLogin = await loginTeacher();
  assert.strictEqual(teacherLogin.redirect, "/teacher");

  await updateRuntimeSettings({
    microsoftLoginEnabled: true,
    maintenanceModeEnabled: true
  });

  try {
    const kickedTeacher = await fetchWithCookies(
      "/teacher/classes",
      { redirect: "manual" },
      teacherLogin.cookies
    );
    assert.strictEqual(kickedTeacher.response.status, 302);
    assert.strictEqual(kickedTeacher.response.headers.get("location"), "/login");

    const maintenanceLogin = await fetchWithCookies("/login");
    assert.strictEqual(maintenanceLogin.response.status, 200);
    assert.match(maintenanceLogin.body, /Wartungsarbeiten/);
    assert.match(maintenanceLogin.body, /Erweitert/);
    assert.doesNotMatch(maintenanceLogin.body, /href="\/auth\/microsoft"/);

    const teacherToken = extractCsrfToken(maintenanceLogin.body);
    const teacherMaintenanceToken = extractHiddenInput(maintenanceLogin.body, "_maintenance_csrf");
    const blockedTeacher = await fetchWithCookies(
      "/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _csrf: teacherToken,
          _maintenance_csrf: teacherMaintenanceToken,
          email: "teacher@example.com",
          password: "NewPass12345"
        }).toString(),
        redirect: "manual"
      },
      maintenanceLogin.cookies
    );
    assert.strictEqual(blockedTeacher.response.status, 503);

    const adminLogin = await fetchWithCookies("/login");
    const adminToken = extractCsrfToken(adminLogin.body);
    const maintenanceToken = extractHiddenInput(adminLogin.body, "_maintenance_csrf");
    assert.ok(maintenanceToken, "maintenance login token missing");
    const adminResponse = await fetchWithCookies(
      "/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _csrf: adminToken,
          _maintenance_csrf: maintenanceToken,
          email: process.env.ADMIN_EMAIL,
          password: process.env.ADMIN_PASS
        }).toString(),
        redirect: "manual"
      },
      adminLogin.cookies
    );
    assert.strictEqual(adminResponse.response.status, 302);
    assert.strictEqual(adminResponse.response.headers.get("location"), "/changepw");

    const statelessAdminResponse = await fetchWithCookies("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _maintenance_csrf: maintenanceToken,
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASS
      }).toString(),
      redirect: "manual"
    });
    assert.strictEqual(statelessAdminResponse.response.status, 302);
  } finally {
    await updateRuntimeSettings({
      microsoftLoginEnabled: true,
      maintenanceModeEnabled: false
    });
  }
});

test("Microsoft account can be linked and used for login", { concurrency: false }, async () => {
  const microsoftAdminEmail = "microsoft-linked-admin@test.local";
  await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [microsoftAdminEmail, hashPassword("UnusedPass123!"), "admin", "active", 0]
  );

  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const requestUrl = typeof input === "string"
      ? input
      : String(input?.url || input);

    if (
      requestUrl.startsWith("https://login.microsoftonline.com/")
      && requestUrl.endsWith("/oauth2/v2.0/token")
    ) {
      return new Response(
        JSON.stringify({
          access_token: "microsoft-access-token",
          id_token: buildMockIdToken({
            email: microsoftAdminEmail,
            preferred_username: microsoftAdminEmail,
            oid: "oid-admin-1",
            tid: "tenant-admin-1"
          })
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    if (requestUrl === "https://graph.microsoft.com/oidc/userinfo") {
      return new Response(
        JSON.stringify({
          email: microsoftAdminEmail,
          preferred_username: microsoftAdminEmail,
          name: "Admin Test",
          sub: "oid-admin-1"
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    return originalFetch(input, init);
  };

  try {
    const passwordLoginPage = await fetchWithCookies("/login");
    const passwordLoginToken = extractCsrfToken(passwordLoginPage.body);
    assert.ok(passwordLoginToken, "CSRF token missing for password login");

    const passwordLoginResponse = await fetchWithCookies(
      "/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _csrf: passwordLoginToken,
          email: microsoftAdminEmail,
          password: "UnusedPass123!"
        }).toString(),
        redirect: "manual"
      },
      passwordLoginPage.cookies
    );
    assert.strictEqual(passwordLoginResponse.response.headers.get("location"), "/admin");

    const linkPage = await fetchWithCookies("/account/microsoft-link", {}, passwordLoginResponse.cookies);
    assert.strictEqual(linkPage.response.status, 200);
    const linkToken = extractCsrfToken(linkPage.body);
    assert.ok(linkToken, "CSRF token missing on Microsoft link page");

    const linkStart = await fetchWithCookies(
      "/account/microsoft-link",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          _csrf: linkToken,
          email: microsoftAdminEmail,
          password: "UnusedPass123!"
        }).toString(),
        redirect: "manual"
      },
      linkPage.cookies
    );
    assert.strictEqual(linkStart.response.status, 302);

    const linkLocation = linkStart.response.headers.get("location");
    assert.ok(linkLocation, "Microsoft connect redirect missing");
    const linkUrl = new URL(linkLocation);
    const linkState = linkUrl.searchParams.get("state");
    assert.ok(linkState, "Microsoft connect state missing");

    const linkCallbackResponse = await fetchWithCookies(
      `/auth/microsoft/callback?code=test-code&state=${encodeURIComponent(linkState)}`,
      { redirect: "manual" },
      linkStart.cookies
    );
    assert.strictEqual(linkCallbackResponse.response.status, 302);
    assert.strictEqual(linkCallbackResponse.response.headers.get("location"), "/account/microsoft-link?linked=1");

    const authStart = await fetchWithCookies("/auth/microsoft", { redirect: "manual" });
    assert.strictEqual(authStart.response.status, 302);
    const authLocation = authStart.response.headers.get("location");
    assert.ok(authLocation, "Microsoft authorization redirect missing");
    const authUrl = new URL(authLocation);
    const authState = authUrl.searchParams.get("state");
    assert.ok(authState, "Microsoft auth state missing");

    const callbackResponse = await fetchWithCookies(
      `/auth/microsoft/callback?code=test-code&state=${encodeURIComponent(authState)}`,
      { redirect: "manual" },
      authStart.cookies
    );

    assert.strictEqual(callbackResponse.response.status, 302);
    assert.strictEqual(callbackResponse.response.headers.get("location"), "/admin");

    const adminPage = await fetchWithCookies("/admin", {}, callbackResponse.cookies);
    assert.strictEqual(adminPage.response.status, 200);
    assert.match(adminPage.body, /microsoft-linked-admin@test\.local/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin can inspect and unlink a user's Microsoft account", { concurrency: false }, async () => {
  const linkedUserEmail = "microsoft-unlink-target@test.local";
  const insertResult = await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [linkedUserEmail, hashPassword("UnusedPass123!"), "admin", "active", 0]
  );
  const userId = insertResult.lastID;

  await dbRun(
    "UPDATE users SET microsoft_oid = ?, microsoft_tenant_id = ?, microsoft_email = ?, microsoft_connected_at = current_timestamp WHERE id = ?",
    ["oid-unlink-target", "tenant-unlink-target", "microsoft.person@test.local", userId]
  );

  const loginResult = await loginAdmin();
  const editPage = await fetchWithCookies(`/admin/users/${userId}/edit`, {}, loginResult.cookies);
  assert.strictEqual(editPage.response.status, 200);
  assert.match(editPage.body, /microsoft\.person@test\.local/);
  assert.match(editPage.body, /tenant-unlink-target/);
  assert.match(editPage.body, /oid-unlink-target/);
  assert.match(editPage.body, /Microsoft entbinden/);

  const csrfToken = extractCsrfToken(editPage.body);
  assert.ok(csrfToken, "CSRF token missing on user edit page");

  const unlinkResponse = await fetchWithCookies(
    `/admin/users/${userId}/microsoft-unlink`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfToken }).toString(),
      redirect: "manual"
    },
    editPage.cookies
  );

  assert.strictEqual(unlinkResponse.response.status, 302);
  assert.strictEqual(
    unlinkResponse.response.headers.get("location"),
    `/admin/users/${userId}/edit?microsoft=unlinked`
  );

  const user = await dbGet(
    "SELECT id, email, status, microsoft_oid, microsoft_tenant_id, microsoft_email FROM users WHERE id = ?",
    [userId]
  );
  assert.strictEqual(user.microsoft_oid, null);
  assert.strictEqual(user.microsoft_tenant_id, null);
  assert.strictEqual(user.microsoft_email, null);

  const refreshedPage = await fetchWithCookies(
    unlinkResponse.response.headers.get("location"),
    {},
    unlinkResponse.cookies
  );
  assert.strictEqual(refreshedPage.response.status, 200);
  assert.match(refreshedPage.body, /Microsoft-Konto wurde entbunden/);
  assert.match(refreshedPage.body, /Keine Verknüpfung/);
});

test("admin can email a one-time password reset that is consumed on login", { concurrency: false }, async () => {
  clearTestOutbox();
  const targetEmail = `reset.student.${Date.now()}@test.local`;
  const insertResult = await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [targetEmail, hashPassword("OldPass12345"), "student", "active", 0]
  );
  const userId = insertResult.lastID;
  const adminEmail = `reset.admin.${Date.now()}@test.local`;
  await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [adminEmail, hashPassword("ResetAdminPass123"), "admin", "active", 0]
  );

  const adminLoginPage = await fetchWithCookies("/login");
  const adminLoginToken = extractCsrfToken(adminLoginPage.body);
  const adminLogin = await fetchWithCookies(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: adminLoginToken,
        email: adminEmail,
        password: "ResetAdminPass123"
      }).toString(),
      redirect: "manual"
    },
    adminLoginPage.cookies
  );
  assert.strictEqual(adminLogin.response.headers.get("location"), "/admin");

  const editPage = await fetchWithCookies(`/admin/users/${userId}/edit`, {}, adminLogin.cookies);
  assert.strictEqual(editPage.response.status, 200);
  assert.match(editPage.body, /Einmalpasswort senden/);

  const csrfToken = extractCsrfToken(editPage.body);
  assert.ok(csrfToken, "CSRF token missing on user edit page");

  const resetResponse = await fetchWithCookies(
    `/admin/users/${userId}/email-reset`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrfToken }).toString(),
      redirect: "manual"
    },
    editPage.cookies
  );

  assert.strictEqual(resetResponse.response.status, 302);
  assert.strictEqual(
    resetResponse.response.headers.get("location"),
    `/admin/users/${userId}/edit?passwordReset=sent`
  );

  const resetMail = getTestOutbox().find((message) => message.to === targetEmail);
  assert.ok(resetMail, "Password reset email was not captured");
  const passwordMatch = resetMail.text.match(/Einmalpasswort:\s*([A-Za-z0-9]+)/);
  assert.ok(passwordMatch, "One-time password missing in reset email");
  const oneTimePassword = passwordMatch[1];

  const loginPage = await fetchWithCookies("/login");
  const loginToken = extractCsrfToken(loginPage.body);
  const oneTimeLogin = await fetchWithCookies(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: loginToken,
        email: targetEmail,
        password: oneTimePassword
      }).toString(),
      redirect: "manual"
    },
    loginPage.cookies
  );

  assert.strictEqual(oneTimeLogin.response.status, 302);
  assert.strictEqual(oneTimeLogin.response.headers.get("location"), "/changepw");

  const replayPage = await fetchWithCookies("/login");
  const replayToken = extractCsrfToken(replayPage.body);
  const replayLogin = await fetchWithCookies(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: replayToken,
        email: targetEmail,
        password: oneTimePassword
      }).toString(),
      redirect: "manual"
    },
    replayPage.cookies
  );
  assert.strictEqual(replayLogin.response.status, 401);

  const forcePage = await fetchWithCookies("/changepw", {}, oneTimeLogin.cookies);
  assert.strictEqual(forcePage.response.status, 200);
  const forceToken = extractCsrfToken(forcePage.body);
  assert.ok(forceToken, "CSRF token missing on changepw page");

  const changeResponse = await fetchWithCookies(
    "/changepw",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: forceToken,
        newPassword: "StudentNewPass123"
      }).toString(),
      redirect: "manual"
    },
    forcePage.cookies
  );

  assert.strictEqual(changeResponse.response.status, 302);
  assert.strictEqual(changeResponse.response.headers.get("location"), "/student");

  const freshLoginPage = await fetchWithCookies("/login");
  const freshLoginToken = extractCsrfToken(freshLoginPage.body);
  const freshLogin = await fetchWithCookies(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: freshLoginToken,
        email: targetEmail,
        password: "StudentNewPass123"
      }).toString(),
      redirect: "manual"
    },
    freshLoginPage.cookies
  );

  assert.strictEqual(freshLogin.response.status, 302);
  assert.strictEqual(freshLogin.response.headers.get("location"), "/student");
});

test("admin can log in with seeded credentials", async () => {
  const adminRow = await dbGet("SELECT id FROM users WHERE email = ?", [process.env.ADMIN_EMAIL]);
  assert.ok(adminRow?.id, "seeded admin missing");

  await dbRun(
    "UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?",
    [hashPassword(process.env.ADMIN_PASS), 1, adminRow.id]
  );

  const loginResult = await loginAndChangePassword(
    process.env.ADMIN_EMAIL,
    process.env.ADMIN_PASS,
    "NewPass12345"
  );

  assert.strictEqual(loginResult.redirect, "/admin");

  const dashboard = await fetchWithCookies("/admin", {}, loginResult.cookies);
  assert.strictEqual(dashboard.response.status, 200);
  assert.match(dashboard.body, /admin@test\.local/);
  assert.match(dashboard.body, /Schnellstart/);
  assert.match(dashboard.body, /Verwaltung/);
  assert.match(dashboard.body, /System/);
  assert.match(dashboard.body, /Nutzer anlegen/);
  assert.match(dashboard.body, /Audit-Log/);
});

test("admin user list paginates users in batches of fifty", async () => {
  const loginResult = await loginAdmin();
  const prefix = `page-users-${Date.now()}`;

  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index).padStart(2, "0");
    await dbRun(
      "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
      [`${prefix}-${suffix}@example.com`, "placeholder-hash", "student", "active", 0]
    );
  }

  const filter = encodeURIComponent(prefix);
  const firstPage = await fetchWithCookies(`/admin/users?email=${filter}`, {}, loginResult.cookies);
  assert.strictEqual(firstPage.response.status, 200);
  assert.doesNotMatch(firstPage.body, /Zeige\s*<strong>/);
  assert.match(firstPage.body, /Seite\s*1\s*\/\s*2/);
  assert.match(firstPage.body, /Max\.\s*50 pro Seite/);
  assert.match(firstPage.body, new RegExp(`href="/admin/users\\?email=${prefix}&amp;page=2"`));
  assert.match(firstPage.body, new RegExp(`${prefix}-54@example\\.com`));
  assert.doesNotMatch(firstPage.body, new RegExp(`${prefix}-00@example\\.com`));

  const secondPage = await fetchWithCookies(
    `/admin/users?email=${filter}&page=2`,
    {},
    loginResult.cookies
  );
  assert.strictEqual(secondPage.response.status, 200);
  assert.doesNotMatch(secondPage.body, /Zeige\s*<strong>/);
  assert.match(secondPage.body, /Seite\s*2\s*\/\s*2/);
  assert.match(secondPage.body, new RegExp(`href="/admin/users\\?email=${prefix}"`));
  assert.match(secondPage.body, new RegExp(`${prefix}-00@example\\.com`));
  assert.doesNotMatch(secondPage.body, new RegExp(`${prefix}-54@example\\.com`));
});

test("admin user creation rejects invalid email addresses", async () => {
  const loginResult = await loginAdmin();
  const csrfToken = await fetchCsrfToken("/admin/users/new", loginResult.cookies);

  const response = await fetchWithCookies(
    "/admin/users",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfToken,
        email: "not-an-email",
        role: "student",
        password: "ValidPass123!"
      }).toString(),
      redirect: "manual"
    },
    loginResult.cookies
  );

  assert.strictEqual(response.response.status, 400);
  assert.match(response.body, /gültige E-Mail-Adresse/);
  const user = await dbGet("SELECT id FROM users WHERE email = ?", ["not-an-email"]);
  assert.strictEqual(user, undefined);
});

test("admin bulk user creation prechecks failures before consuming user ids", async () => {
  const loginResult = await loginAdmin();
  const markerEmail = `bulk.marker.${Date.now()}@test.local`;
  const markerInsert = await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [markerEmail, hashPassword("MarkerPass123!"), "student", "active", 0]
  );
  const csrfToken = await fetchCsrfToken("/admin/users/new", loginResult.cookies);

  const response = await fetchWithCookies(
    "/admin/users/bulk",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfToken,
        bulkEmails: `${markerEmail}\nnot-an-email`,
        bulkRole: "student",
        bulkPassword: "ValidPass123!",
        bulkDelimiter: "paragraph"
      }).toString()
    },
    loginResult.cookies
  );

  assert.strictEqual(response.response.status, 200);
  assert.match(response.body, /E-Mail existiert bereits/);
  assert.match(response.body, /Ungültige E-Mail-Adresse/);

  const afterInsert = await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    [`bulk.after.${Date.now()}@test.local`, hashPassword("MarkerPass123!"), "student", "active", 0]
  );
  assert.strictEqual(afterInsert.lastID, markerInsert.lastID + 1);
});

test("Kerberos reverse proxy header can create an app session", async () => {
  const teacher = await dbGet("SELECT id FROM users WHERE email = ?", ["teacher@example.com"]);
  assert.ok(teacher, "seeded teacher missing");
  await dbRun("UPDATE users SET must_change_password = ? WHERE id = ?", [0, teacher.id]);

  const ssoPage = await fetchWithCookies("/teacher/settings", {
    headers: { "x-remote-user": "HTLWYDEV\\teacher" }
  });
  assert.strictEqual(ssoPage.response.status, 200);
  assert.match(ssoPage.body, /teacher@example\.com/);

  const sessionPage = await fetchWithCookies("/teacher/classes", {}, ssoPage.cookies);
  assert.strictEqual(sessionPage.response.status, 200);
});

test("teacher class overview renders assigned subjects", async () => {
  const loginResult = await loginTeacher();
  assert.strictEqual(loginResult.redirect, "/teacher");

  const classesPage = await fetchWithCookies("/teacher/classes", {}, loginResult.cookies);
  assert.strictEqual(classesPage.response.status, 200);
  assert.match(classesPage.body, /Aktive Fachzuordnungen/);
  assert.doesNotMatch(classesPage.body, /classId is not defined/);
});

test("teacher settings allow safe edits on locked class schemas", async () => {
  const loginResult = await loginTeacher();
  assert.strictEqual(loginResult.redirect, "/teacher");

  const teacherRow = await dbGet("SELECT id FROM users WHERE email = ?", ["teacher@example.com"]);
  const classRow = await dbGet("SELECT id, subject_id FROM classes WHERE id = ?", [1]);
  assert.ok(teacherRow?.id);
  assert.ok(classRow?.subject_id);

  const profileInsert = await dbRun(
    `INSERT INTO teacher_grading_profiles
     (teacher_id, class_id, subject_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_points_plus, ma_points_plus_tilde, ma_points_neutral, ma_points_minus_tilde, ma_points_minus, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      teacherRow.id,
      classRow.id,
      classRow.subject_id,
      "Locked Safe Edit",
      "points",
      "points_only",
      "include_zero",
      88.5,
      75,
      62.5,
      50,
      0,
      5,
      5,
      4,
      3,
      2,
      0,
      0
    ]
  );
  const profileId = profileInsert.lastID;

  try {
    const settingsPage = await fetchWithCookies(
      `/teacher/settings?class_id=${classRow.id}&subject_id=${classRow.subject_id}`,
      {},
      loginResult.cookies
    );
    assert.strictEqual(settingsPage.response.status, 200);
    assert.match(settingsPage.body, /Änderungen speichern/);
    assert.match(settingsPage.body, /ma_enabled" name="ma_enabled" value="1"[^>]*disabled/);

    const csrfToken = extractCsrfToken(settingsPage.body);
    const params = new URLSearchParams({
      _csrf: csrfToken,
      profile_id: String(profileId),
      class_id: String(classRow.id),
      subject_id: String(classRow.subject_id),
      weight_mode: "percent",
      scoring_mode: "grade_only",
      profile_name: "Locked Safe Edit Updated",
      absence_mode: "exclude",
      grade1_min_percent: "90",
      grade2_min_percent: "80",
      grade3_min_percent: "65",
      grade4_min_percent: "50",
      ma_enabled: "1",
      ma_weight: "9",
      ma_points_plus: "9",
      ma_points_plus_tilde: "7",
      ma_points_neutral: "5",
      ma_points_minus_tilde: "3",
      ma_points_minus: "1",
      weight_schularbeit: "42",
      weight_test: "18",
      weight_projekt: "20",
      weight_hausaufgabe: "10",
      weight_mitarbeit: "10",
      weight_wiederholung: "0"
    });

    const saveResponse = await fetchWithCookies(
      "/teacher/settings/save-profile",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        redirect: "manual"
      },
      settingsPage.cookies
    );
    assert.strictEqual(saveResponse.response.status, 302);

    const updatedProfile = await dbGet(
      `SELECT tgp.id, tgp.name, tgp.weight_mode, tgp.scoring_mode, tgp.absence_mode, tgp.ma_enabled, tgp.ma_weight, tgp.ma_points_plus
       FROM teacher_grading_profiles tgp
       WHERE tgp.class_id = ? AND tgp.subject_id = ?`,
      [classRow.id, classRow.subject_id]
    );
    assert.strictEqual(updatedProfile.name, "Locked Safe Edit Updated");
    assert.strictEqual(updatedProfile.absence_mode, "exclude");
    assert.strictEqual(updatedProfile.weight_mode, "points");
    assert.strictEqual(updatedProfile.scoring_mode, "points_only");
    assert.strictEqual(Boolean(updatedProfile.ma_enabled), false);
    assert.strictEqual(Number(updatedProfile.ma_weight), 5);
    assert.strictEqual(Number(updatedProfile.ma_points_plus), 5);
  } finally {
    if (profileId) {
      await dbRun("DELETE FROM teacher_grading_profiles WHERE id = ? AND teacher_id = ?", [
        profileId,
        teacherRow.id
      ]);
    }
  }
});

test("teacher settings save selected scoring mode for new class schemas", async () => {
  const loginResult = await loginTeacher();
  assert.strictEqual(loginResult.redirect, "/teacher");

  const teacherRow = await dbGet("SELECT id FROM users WHERE email = ?", ["teacher@example.com"]);
  const classRow = await dbGet("SELECT id, subject_id FROM classes WHERE id = ?", [1]);
  assert.ok(teacherRow?.id);
  assert.ok(classRow?.subject_id);

  const existingProfile = await dbGet(
    `SELECT tgp.id
     FROM teacher_grading_profiles tgp
     WHERE tgp.class_id = ? AND tgp.subject_id = ?`,
    [classRow.id, classRow.subject_id]
  );
  if (existingProfile?.id) {
    await dbRun("DELETE FROM teacher_grading_profiles WHERE id = ? AND teacher_id = ?", [
      existingProfile.id,
      teacherRow.id
    ]);
  }

  let profileId = null;
  try {
    const settingsPage = await fetchWithCookies(
      `/teacher/settings?class_id=${classRow.id}&subject_id=${classRow.subject_id}&setup=1`,
      {},
      loginResult.cookies
    );
    assert.strictEqual(settingsPage.response.status, 200);
    assert.match(settingsPage.body, /name="scoring_mode"/);
    assert.match(settingsPage.body, /Nur Noten/);

    const csrfToken = extractCsrfToken(settingsPage.body);
    const params = new URLSearchParams({
      _csrf: csrfToken,
      class_id: String(classRow.id),
      subject_id: String(classRow.subject_id),
      weight_mode: "points",
      scoring_mode: "grade_only",
      profile_name: "Scoring Mode Auswahl",
      absence_mode: "include_zero",
      grade1_min_percent: "88.5",
      grade2_min_percent: "75",
      grade3_min_percent: "62.5",
      grade4_min_percent: "50",
      ma_weight: "5",
      ma_points_plus: "5",
      ma_points_plus_tilde: "4",
      ma_points_neutral: "3",
      ma_points_minus_tilde: "2",
      ma_points_minus: "0",
      weight_schularbeit: "40",
      weight_test: "20",
      weight_projekt: "20",
      weight_hausaufgabe: "10",
      weight_mitarbeit: "10",
      weight_wiederholung: "0"
    });

    const saveResponse = await fetchWithCookies(
      "/teacher/settings/save-profile",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        redirect: "manual"
      },
      settingsPage.cookies
    );
    assert.strictEqual(saveResponse.response.status, 302);

    const savedProfile = await dbGet(
      `SELECT tgp.id, tgp.scoring_mode
       FROM teacher_grading_profiles tgp
       WHERE tgp.class_id = ? AND tgp.subject_id = ?`,
      [classRow.id, classRow.subject_id]
    );
    assert.ok(savedProfile?.id);
    profileId = savedProfile.id;
    assert.strictEqual(savedProfile.scoring_mode, "grade_only");
  } finally {
    if (profileId) {
      await dbRun("DELETE FROM teacher_grading_profiles WHERE id = ? AND teacher_id = ?", [
        profileId,
        teacherRow.id
      ]);
    }
  }
});

test("student can view grades and profile after login", async () => {
  const loginResult = await loginStudent();
  assert.strictEqual(loginResult.redirect, "/student");

  const gradesResponse = await fetchWithCookies("/student/grades?format=json", {}, loginResult.cookies);
  assert.strictEqual(gradesResponse.response.status, 200);
  const gradesData = JSON.parse(gradesResponse.body);
  assert.ok(Array.isArray(gradesData.grades));
  assert.ok(gradesData.grades.length > 0, "Seeded grades missing");

  const profileResponse = await fetchWithCookies("/student/profile", {}, loginResult.cookies);
  assert.strictEqual(profileResponse.response.status, 200);
  const profile = JSON.parse(profileResponse.body);
  assert.strictEqual(profile.class, "3AHWII");
});

test("student grade subject overview includes assigned subjects without returns", async () => {
  const loginResult = await loginStudent();
  assert.strictEqual(loginResult.redirect, "/student");

  const teacherRow = await dbGet("SELECT id FROM users WHERE email = ?", ["teacher@example.com"]);
  assert.ok(teacherRow?.id, "Teacher user missing");

  const studentRow = await dbGet(
    "SELECT s.*, c.name as class_name, c.subject as class_subject, c.id as class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.email = ?",
    ["student@example.com"]
  );
  assert.ok(studentRow?.class_id, "Student class missing");

  const classRow = await dbGet(
    "SELECT id, name, subject, subject_id, school_year_id FROM classes WHERE id = ?",
    [studentRow.class_id]
  );
  assert.ok(classRow?.school_year_id, "Student class school year missing");

  const subjectName = `Keine Rueckgabe ${Date.now()}`;
  const subjectInsert = await dbRun("INSERT INTO subjects (name) VALUES (?)", [subjectName]);
  let assignmentId = null;

  try {
    const assignmentInsert = await dbRun(
      "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES (?,?,?,?)",
      [classRow.id, subjectInsert.lastID, teacherRow.id, classRow.school_year_id]
    );
    assignmentId = assignmentInsert.lastID;

    const gradesPage = await fetchWithCookies("/student/grades", {}, loginResult.cookies);
    assert.strictEqual(gradesPage.response.status, 200);

    const initialData = extractStudentInitialData(gradesPage.body);
    assert.ok(
      initialData.subjects.includes(subjectName),
      "Assigned subject without returns should be visible"
    );
    assert.strictEqual(
      initialData.grades.some((grade) => grade.subject === subjectName),
      false,
      "Subject without returns should not create a fake grade"
    );
  } finally {
    if (assignmentId) {
      await dbRun("DELETE FROM class_subject_teacher WHERE id = ?", [assignmentId]);
    }
    await dbRun("DELETE FROM subjects WHERE id = ?", [subjectInsert.lastID]);
  }
});

test("student and teacher can complete the full grade message workflow", async () => {
  const studentLogin = await loginStudent();
  assert.strictEqual(studentLogin.redirect, "/student");

  const returnsBefore = await fetchWithCookies(
    "/student/returns",
    { headers: { Accept: "application/json" } },
    studentLogin.cookies
  );
  assert.strictEqual(returnsBefore.response.status, 200);
  const returnsBeforeData = JSON.parse(returnsBefore.body);
  const targetReturn = returnsBeforeData.returns.find((entry) => entry.can_message);
  assert.ok(targetReturn, "Expected at least one return that supports messages");

  const studentCsrf = await fetchCsrfToken("/student/requests", studentLogin.cookies);
  const messageText = "Warum wurde Aufgabe 3 als falsch gewertet?";
  const createMessageResponse = await fetchWithCookies(
    `/student/returns/${targetReturn.id}/message`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": studentCsrf
      },
      body: JSON.stringify({ message: messageText })
    },
    studentLogin.cookies
  );
  assert.strictEqual(createMessageResponse.response.status, 200);
  assert.deepStrictEqual(JSON.parse(createMessageResponse.body), { ok: true });

  const returnsWithMessage = await fetchWithCookies(
    "/student/returns",
    { headers: { Accept: "application/json" } },
    studentLogin.cookies
  );
  const returnsWithMessageData = JSON.parse(returnsWithMessage.body);
  const studentThread = returnsWithMessageData.returns.find((entry) => entry.id === targetReturn.id);
  assert.ok(studentThread);
  assert.strictEqual(studentThread.messages.length, 1);
  assert.strictEqual(studentThread.messages[0].student_message, messageText);

  const teacherLogin = await loginTeacher();
  assert.strictEqual(teacherLogin.redirect, "/teacher");

  const teacherPage = await fetchWithCookies(
    "/teacher/test-questions/1",
    {},
    teacherLogin.cookies
  );
  assert.strictEqual(teacherPage.response.status, 200);
  assert.match(teacherPage.body, new RegExp(messageText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const teacherCsrf = await fetchCsrfToken("/teacher/test-questions/1", teacherLogin.cookies);
  const messageId = studentThread.messages[0].id;
  const replyText = "Teilaufgabe 3 war unvollständig, deshalb wurden Punkte abgezogen.";
  const replyParams = new URLSearchParams({
    _csrf: teacherCsrf,
    reply: replyText
  });
  const replyResponse = await fetchWithCookies(
    `/teacher/students/1/messages/${messageId}/reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: replyParams.toString(),
      redirect: "manual"
    },
    teacherLogin.cookies
  );
  assert.strictEqual(replyResponse.response.status, 302);
  assert.strictEqual(replyResponse.response.headers.get("location"), "/teacher/test-questions/1");

  const returnsWithReply = await fetchWithCookies(
    "/student/returns",
    { headers: { Accept: "application/json" } },
    studentLogin.cookies
  );
  const returnsWithReplyData = JSON.parse(returnsWithReply.body);
  const repliedThread = returnsWithReplyData.returns.find((entry) => entry.id === targetReturn.id);
  assert.ok(repliedThread);
  assert.strictEqual(repliedThread.messages.length, 1);
  assert.strictEqual(repliedThread.messages[0].teacher_reply, replyText);
  assert.strictEqual(repliedThread.messages[0].teacher_reply_seen_at, null);

  const markSeenResponse = await fetchWithCookies(
    `/student/returns/${targetReturn.id}/messages/seen`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": studentCsrf
      }
    },
    studentLogin.cookies
  );
  assert.strictEqual(markSeenResponse.response.status, 200);
  assert.deepStrictEqual(JSON.parse(markSeenResponse.body), { ok: true });

  const returnsAfterSeen = await fetchWithCookies(
    "/student/returns",
    { headers: { Accept: "application/json" } },
    studentLogin.cookies
  );
  const returnsAfterSeenData = JSON.parse(returnsAfterSeen.body);
  const seenThread = returnsAfterSeenData.returns.find((entry) => entry.id === targetReturn.id);
  assert.ok(seenThread?.messages[0].teacher_reply_seen_at, "Reply should be marked as seen");

  const notificationsResponse = await fetchWithCookies(
    "/student/notifications",
    { headers: { Accept: "application/json" } },
    studentLogin.cookies
  );
  assert.strictEqual(notificationsResponse.response.status, 200);
  const notifications = JSON.parse(notificationsResponse.body).notifications;
  const replyNotification = notifications.find((entry) =>
    String(entry.message || "").includes("Lehrkraft hat auf deine")
  );
  assert.ok(replyNotification, "Reply notification missing");
  assert.strictEqual(replyNotification.read_at, null);

  const readNotificationResponse = await fetchWithCookies(
    `/student/notifications/${replyNotification.id}/read`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": studentCsrf
      }
    },
    studentLogin.cookies
  );
  assert.strictEqual(readNotificationResponse.response.status, 200);
  assert.deepStrictEqual(JSON.parse(readNotificationResponse.body), { ok: true });

  const notificationsAfterRead = await fetchWithCookies(
    "/student/notifications",
    { headers: { Accept: "application/json" } },
    studentLogin.cookies
  );
  const notificationsAfterReadData = JSON.parse(notificationsAfterRead.body).notifications;
  const readNotification = notificationsAfterReadData.find(
    (entry) => entry.id === replyNotification.id
  );
  assert.ok(readNotification?.read_at, "Notification should be marked as read");
});

test("teacher bulk grading saves entries for numeric student ids", async () => {
  const loginResult = await loginTeacher();
  assert.strictEqual(loginResult.redirect, "/teacher");

  await dbRun(
    `INSERT INTO teacher_grading_profiles
     (teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [2, "Bulkprofil", "points", "points_or_grade", "include_zero", 88.5, 75, 62.5, 50, 0, 5, 1.5, 2.5, 3, 3.5, 4.5, 1]
  );
  const templateId = 1;
  await dbRun("UPDATE grade_templates SET max_points = ? WHERE id = ?", [20, templateId]);

  const bulkPage = await fetchWithCookies(
    `/teacher/bulk-grade-template/1/${templateId}`,
    {},
    loginResult.cookies
  );
  assert.strictEqual(bulkPage.response.status, 200);
  assert.match(bulkPage.body, /name="grade\[s_1\]"/);

  const csrfToken = extractCsrfToken(bulkPage.body);
  assert.ok(csrfToken, "CSRF token missing in bulk grading form");

  const params = new URLSearchParams({
    _csrf: csrfToken,
    "grade[s_1]": "2.5",
    "note[s_1]": "Per Test gespeichert"
  });

  const submitResponse = await fetchWithCookies(
    `/teacher/bulk-grade-template/1/${templateId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    },
    bulkPage.cookies
  );

  assert.strictEqual(submitResponse.response.status, 302);
  const location = submitResponse.response.headers.get("location");
  assert.ok(location, "Bulk grading redirect missing");

  const redirectUrl = new URL(location, baseUrl);
  assert.strictEqual(redirectUrl.pathname, `/teacher/bulk-grade-template/1/${templateId}`);
  assert.strictEqual(redirectUrl.searchParams.get("saved"), "0");
  assert.strictEqual(redirectUrl.searchParams.get("updated"), "1");

  const resultPage = await fetchWithCookies(location, {}, submitResponse.cookies);
  assert.strictEqual(resultPage.response.status, 200);
  assert.match(resultPage.body, /1 Bewertung aktualisiert\./);
  assert.doesNotMatch(resultPage.body, /Keine neuen Bewertungen zum Speichern gefunden\./);
});

test("teacher bulk grading resolves templates for the correct subject on multi-subject classes", async () => {
  const loginResult = await loginTeacher();
  assert.strictEqual(loginResult.redirect, "/teacher");

  const teacherRow = await dbGet("SELECT id FROM users WHERE email = ?", ["teacher@example.com"]);
  assert.ok(teacherRow?.id, "Teacher user missing");

  const activeProfile = await dbGet(
    "SELECT id FROM teacher_grading_profiles WHERE teacher_id = ? AND is_active = ? ORDER BY id ASC LIMIT 1",
    [teacherRow.id, 1]
  );
  if (!activeProfile) {
    await dbRun(
      `INSERT INTO teacher_grading_profiles
       (teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [teacherRow.id, "Bulkprofil Mehrfachfach", "points", "points_or_grade", "include_zero", 88.5, 75, 62.5, 50, 0, 5, 1.5, 2.5, 3, 3.5, 4.5, 1]
    );
  }

  const activeSchoolYear = await dbGet(
    "SELECT id, name, start_date, end_date, is_active FROM school_years WHERE is_active = ? ORDER BY id DESC LIMIT 1",
    [1]
  );
  assert.ok(activeSchoolYear?.id, "Active school year missing");

  const subjectInsert = await dbRun("INSERT INTO subjects (name) VALUES (?)", ["Mehrfachfach Mathematik"]);
  await dbRun(
    "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES (?,?,?,?)",
    [1, subjectInsert.lastID, teacherRow.id, activeSchoolYear.id]
  );
  const templateInsert = await dbRun(
    "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, weight_mode, max_points, date, description) VALUES (?,?,?,?,?,?,?,?,?)",
    [1, subjectInsert.lastID, "Mehrfachfach-Test", "Test", 1, "points", 20, "2026-04-20", "Regression fuer Bulk-Benotung"]
  );

  const bulkPage = await fetchWithCookies(
    `/teacher/bulk-grade-template/1/${templateInsert.lastID}`,
    {},
    loginResult.cookies
  );
  assert.strictEqual(bulkPage.response.status, 200);
  assert.match(bulkPage.body, /Mehrfachfach-Test/);
  assert.match(bulkPage.body, /Mehrfachfach Mathematik/);
});

test('teacher student grades treat "nicht da" with absence_mode=exclude as ohne Gewichtung', async () => {
  const loginResult = await loginTeacher();
  assert.strictEqual(loginResult.redirect, "/teacher");

  const teacherRow = await dbGet("SELECT id FROM users WHERE email = ?", ["teacher@example.com"]);
  assert.ok(teacherRow?.id, "Teacher user missing");

  const classRow = await dbGet("SELECT id, subject_id FROM classes WHERE id = ?", [1]);
  assert.ok(classRow?.subject_id, "Class subject missing");

  const activeSchoolYear = await dbGet(
    "SELECT id, name, start_date, end_date, is_active FROM school_years WHERE is_active = ? ORDER BY id DESC LIMIT 1",
    [1]
  );
  assert.ok(activeSchoolYear?.id, "Active school year missing");

  await dbRun("UPDATE teacher_grading_profiles SET is_active = ? WHERE teacher_id = ?", [
    0,
    teacherRow.id
  ]);
  await dbRun(
    `INSERT INTO teacher_grading_profiles
     (teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      teacherRow.id,
      `Abwesenheit Neutral ${Date.now()}`,
      "points",
      "points_or_grade",
      "exclude",
      88.5,
      75,
      62.5,
      50,
      0,
      5,
      1.5,
      2.5,
      3,
      3.5,
      4.5,
      1
    ]
  );

  const templateInsert = await dbRun(
    "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, weight_mode, max_points, date, description) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      1,
      classRow.subject_id,
      `Abwesenheitstest ${Date.now()}`,
      "Test",
      10,
      "points",
      20,
      "2026-04-20",
      "Regression fuer nicht da"
    ]
  );

  await dbRun(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, points_achieved, points_max, note, attachment_path, attachment_original_name, attachment_mime, attachment_size, external_link, is_absent, school_year_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [1, 1, templateInsert.lastID, 5, null, null, "War nicht da", null, null, null, null, null, 1, activeSchoolYear.id]
  );

  const studentGradesPage = await fetchWithCookies("/teacher/student-grades/1/1", {}, loginResult.cookies);
  assert.strictEqual(studentGradesPage.response.status, 200);
  assert.match(studentGradesPage.body, /Ohne Gewichtung/);
  assert.match(studentGradesPage.body, /Nicht gewichtet laut Einstellung bei &quot;nicht da&quot;|Nicht gewichtet laut Einstellung bei "nicht da"/);

  const detailsPage = await fetchWithCookies("/teacher/student-grades/1/1/details", {}, loginResult.cookies);
  assert.strictEqual(detailsPage.response.status, 200);
  assert.match(detailsPage.body, /Nicht gewichtet \(Abwesenheit laut Profil\)\./);
});

test("student routes redirect when unauthenticated", async () => {
  const res = await fetchWithCookies("/student/grades", { redirect: "manual" });
  assert.strictEqual(res.response.status, 302);
  assert.strictEqual(res.response.headers.get("location"), "/login");
});

test("webuntis student grade target survives login", async () => {
  const studentUser = await dbGet(
    "SELECT id, email, password_hash, role, status, must_change_password, microsoft_oid, microsoft_tenant_id, microsoft_email FROM users WHERE email = ?",
    ["student@example.com"]
  );
  assert.ok(studentUser, "Seeded student missing");

  await dbRun(
    "UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?",
    [hashPassword("WebUntisPass123!"), 0, studentUser.id]
  );

  const target =
    "/student/grades?subject=AM&from=webuntis&returnUrl=https%3A%2F%2Fhtlwy.webuntis.com%2Ftimetable%2Fmy-student";
  const protectedPage = await fetchWithCookies(target, { redirect: "manual" });
  assert.strictEqual(protectedPage.response.status, 302);
  assert.strictEqual(protectedPage.response.headers.get("location"), "/login");

  const loginPage = await fetchWithCookies("/login", {}, protectedPage.cookies);
  const csrfToken = extractCsrfToken(loginPage.body);
  assert.ok(csrfToken, "CSRF token missing in login page");

  const params = new URLSearchParams({
    _csrf: csrfToken,
    email: "student@example.com",
    password: "WebUntisPass123!"
  });

  const loginResponse = await fetchWithCookies(
    "/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual"
    },
    loginPage.cookies
  );

  assert.strictEqual(loginResponse.response.status, 302);
  assert.strictEqual(loginResponse.response.headers.get("location"), target);
});

test("admin archive renders the optimized overview and exports CSV", async () => {
  const loginResult = await loginAdmin();

  const archivePage = await fetchWithCookies("/archive", {}, loginResult.cookies);
  assert.strictEqual(archivePage.response.status, 200);
  assert.match(archivePage.body, /Archivdaten/);
  assert.match(archivePage.body, /CSV Noten/);
  assert.match(archivePage.body, /Sicherheitsbereich/);

  const csvResponse = await fetchWithCookies(
    "/archive/export/grades",
    { redirect: "manual" },
    loginResult.cookies
  );
  assert.strictEqual(csvResponse.response.status, 200);
  assert.match(csvResponse.response.headers.get("content-type") || "", /text\/csv/);
  assert.match(csvResponse.response.headers.get("content-disposition") || "", /archiv-.*-noten\.csv/);
  assert.match(csvResponse.body, /"Schüler"/);
  assert.match(csvResponse.body, /"Kommentar"/);
});

test("admin can delete an archived school year through the archive danger flow", async () => {
  const loginResult = await loginAdmin();
  const schoolYearName = "2023/2024";
  const schoolYearInsert = await dbRun(
    "INSERT INTO school_years (name, start_date, end_date, is_active) VALUES (?,?,?,?)",
    [schoolYearName, "2023-09-01", "2024-06-30", 0]
  );
  const archivedSchoolYearId = schoolYearInsert.lastID;
  const classInsert = await dbRun(
    "INSERT INTO classes (name, subject, subject_id, school_year_id) VALUES (?,?,?,?)",
    ["5AHIT", "Informatik", 1, archivedSchoolYearId]
  );
  await dbRun(
    "INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)",
    ["Archiv Schüler", "archiv.schueler@example.com", classInsert.lastID, schoolYearName]
  );
  const studentRow = await dbGet(
    "SELECT s.*, c.name as class_name, c.subject as class_subject, c.id as class_id FROM students s JOIN classes c ON c.id = s.class_id WHERE s.email = ?",
    ["archiv.schueler@example.com"]
  );
  const teacherRow = await dbGet("SELECT id FROM users WHERE email = ?", ["teacher@example.com"]);
  const assignmentInsert = await dbRun(
    "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES (?,?,?,?)",
    [classInsert.lastID, 1, teacherRow.id, archivedSchoolYearId]
  );
  const templateInsert = await dbRun(
    "INSERT INTO grade_templates (class_id, subject_id, name, category, weight, weight_mode, max_points, date, description) VALUES (?,?,?,?,?,?,?,?,?)",
    [classInsert.lastID, 1, "Archiv Test", "Test", 10, "points", 20, "2024-05-15", "Archivdaten"]
  );
  const gradeInsert = await dbRun(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, points_achieved, points_max, note, attachment_path, attachment_original_name, attachment_mime, attachment_size, external_link, is_absent, school_year_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    [studentRow.id, classInsert.lastID, templateInsert.lastID, 2, 18, 20, "Archivnote", null, null, null, null, null, 0, archivedSchoolYearId]
  );
  await dbRun(
    "INSERT INTO grade_messages (grade_id, student_id, student_message) VALUES (?,?,?)",
    [gradeInsert.lastID, studentRow.id, "Bitte pruefen"]
  );
  await dbRun(
    "INSERT INTO special_assessments (student_id, class_id, subject_id, type, name, description, weight, grade) VALUES (?,?,?,?,?,?,?,?)",
    [studentRow.id, classInsert.lastID, 1, "Präsentation", "Archiv Referat", "", 10, 2]
  );
  await dbRun(
    "INSERT INTO participation_marks (student_id, class_id, subject_id, teacher_id, symbol, note) VALUES (?,?,?,?,?,?)",
    [studentRow.id, classInsert.lastID, 1, teacherRow.id, "plus", "Archiv Mitarbeit"]
  );
  await dbRun(
    "INSERT INTO teacher_student_exclusions (teacher_id, class_id, subject_id, student_id, school_year_id) VALUES (?,?,?,?,?)",
    [teacherRow.id, classInsert.lastID, 1, studentRow.id, archivedSchoolYearId]
  );
  await dbRun(
    "INSERT INTO archives (school_year_id, archive_type, entity_count) VALUES (?,?,?)",
    [archivedSchoolYearId, "grades", 1]
  );

  const purgePage = await fetchWithCookies(`/archive/purge?school_year_id=${archivedSchoolYearId}`, {}, loginResult.cookies);
  assert.strictEqual(purgePage.response.status, 200);
  assert.match(purgePage.body, /Einzelnes Archiv löschen/);

  const previewCsrf = extractCsrfToken(purgePage.body);
  assert.ok(previewCsrf, "CSRF token missing on archive purge page");

  const previewParams = new URLSearchParams({
    _csrf: previewCsrf,
    school_year_id: String(archivedSchoolYearId)
  });
  const previewResponse = await fetchWithCookies(
    "/archive/purge/preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: previewParams.toString()
    },
    purgePage.cookies
  );
  assert.strictEqual(previewResponse.response.status, 200);
  assert.match(previewResponse.body, /ARCHIV LOESCHEN 2023\/2024/);

  const executeCsrf = extractCsrfToken(previewResponse.body);
  const previewToken = extractHiddenInput(previewResponse.body, "preview_token");
  assert.ok(executeCsrf, "CSRF token missing on archive purge preview");
  assert.ok(previewToken, "Preview token missing on archive purge preview");

  const executeParams = new URLSearchParams({
    _csrf: executeCsrf,
    preview_token: previewToken,
    school_year_id: String(archivedSchoolYearId),
    confirmation_text: `ARCHIV LOESCHEN ${schoolYearName}`,
    admin_password: "NewPass12345"
  });
  const executeResponse = await fetchWithCookies(
    "/archive/purge/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: executeParams.toString(),
      redirect: "manual"
    },
    previewResponse.cookies
  );
  assert.strictEqual(executeResponse.response.status, 302);
  assert.strictEqual(executeResponse.response.headers.get("location"), "/archive");

  const deletedSchoolYear = await dbGet("SELECT id, name, start_date, end_date, is_active FROM school_years WHERE id = ?", [archivedSchoolYearId]);
  assert.strictEqual(deletedSchoolYear, undefined);
  const deletedStudent = await dbGet("SELECT id FROM students WHERE email = ? AND class_id = ?", ["archiv.schueler@example.com", classInsert.lastID]);
  assert.strictEqual(deletedStudent, undefined);
  const deletedAssignment = await dbGet("SELECT id, class_id, subject_id, teacher_id FROM class_subject_teacher WHERE id = ?", [assignmentInsert.lastID]);
  assert.strictEqual(deletedAssignment, undefined);
  const deletedTemplate = await dbGet("SELECT id FROM grade_templates WHERE id = ? AND class_id = ?", [templateInsert.lastID, classInsert.lastID]);
  assert.strictEqual(deletedTemplate, undefined);
  const deletedGrade = await dbGet("SELECT id, student_id, grade_template_id FROM grades WHERE id = ? AND student_id = ?", [gradeInsert.lastID, studentRow.id]);
  assert.strictEqual(deletedGrade, undefined);
});

test("graduate cleanup can remove all memberships of a selected class name and deactivate orphaned student logins", async () => {
  const loginResult = await loginAdmin();
  const schoolYearName = "2022/2023";
  const schoolYearInsert = await dbRun(
    "INSERT INTO school_years (name, start_date, end_date, is_active) VALUES (?,?,?,?)",
    [schoolYearName, "2022-09-01", "2023-06-30", 0]
  );
  const archivedSchoolYearId = schoolYearInsert.lastID;
  const secondSubject = await dbRun("INSERT INTO subjects (name) VALUES (?)", ["Mathematik"]);
  const firstClass = await dbRun(
    "INSERT INTO classes (name, subject, subject_id, school_year_id) VALUES (?,?,?,?)",
    ["5CHIT", "Informatik", 1, archivedSchoolYearId]
  );
  const secondClass = await dbRun(
    "INSERT INTO classes (name, subject, subject_id, school_year_id) VALUES (?,?,?,?)",
    ["5CHIT", "Mathematik", secondSubject.lastID, archivedSchoolYearId]
  );
  const studentUser = await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    ["grad.clean@example.com", "placeholder-hash", "student", "active", 0]
  );
  await dbRun(
    "INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)",
    ["Grad Clean", "grad.clean@example.com", firstClass.lastID, schoolYearName]
  );
  await dbRun(
    "INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)",
    ["Grad Clean", "grad.clean@example.com", secondClass.lastID, schoolYearName]
  );

  const cleanupPage = await fetchWithCookies(`/archive/graduates?school_year_id=${archivedSchoolYearId}`, {}, loginResult.cookies);
  assert.strictEqual(cleanupPage.response.status, 200);
  assert.match(cleanupPage.body, /Schulabgänger bereinigen/);

  const previewCsrf = extractCsrfToken(cleanupPage.body);
  assert.ok(previewCsrf, "CSRF token missing on graduate cleanup page");
  const classSelectionKey = Buffer.from("5CHIT", "utf8").toString("base64url");
  const previewParams = new URLSearchParams({
    _csrf: previewCsrf,
    school_year_id: String(archivedSchoolYearId),
    included_class_keys: classSelectionKey
  });
  const previewResponse = await fetchWithCookies(
    "/archive/graduates/preview",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: previewParams.toString()
    },
    cleanupPage.cookies
  );
  assert.strictEqual(previewResponse.response.status, 200);
  assert.match(previewResponse.body, /SCHULABGAENGER BEREINIGEN 2022\/2023/);
  assert.match(previewResponse.body, /Grad Clean/);

  const executeCsrf = extractCsrfToken(previewResponse.body);
  const previewToken = extractHiddenInput(previewResponse.body, "preview_token");
  assert.ok(executeCsrf, "CSRF token missing on graduate cleanup preview");
  assert.ok(previewToken, "Preview token missing on graduate cleanup preview");

  const executeParams = new URLSearchParams({
    _csrf: executeCsrf,
    preview_token: previewToken,
    school_year_id: String(archivedSchoolYearId),
    confirmation_text: `SCHULABGAENGER BEREINIGEN ${schoolYearName}`,
    admin_password: "NewPass12345"
  });
  const executeResponse = await fetchWithCookies(
    "/archive/graduates/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: executeParams.toString(),
      redirect: "manual"
    },
    previewResponse.cookies
  );
  assert.strictEqual(executeResponse.response.status, 302);
  assert.strictEqual(executeResponse.response.headers.get("location"), "/archive");

  const firstMembership = await dbGet("SELECT id FROM students WHERE email = ? AND class_id = ?", ["grad.clean@example.com", firstClass.lastID]);
  const secondMembership = await dbGet("SELECT id FROM students WHERE email = ? AND class_id = ?", ["grad.clean@example.com", secondClass.lastID]);
  assert.strictEqual(firstMembership, undefined);
  assert.strictEqual(secondMembership, undefined);

  const studentUserRow = await dbGet("SELECT id, email, role, status, must_change_password FROM users WHERE id = ?", [studentUser.lastID]);
  assert.strictEqual(studentUserRow.status, "deleted");
});

test("admin assignments page lists subjects without classes or teachers", async () => {
  const loginResult = await loginAdmin();
  const subjectName = "Biologie ohne Zuordnung";

  const insertResult = await dbRun("INSERT INTO subjects (name) VALUES (?)", [subjectName]);

  const assignmentsPage = await fetchWithCookies("/admin/assignments", {}, loginResult.cookies);
  assert.strictEqual(assignmentsPage.response.status, 200);
  assert.match(assignmentsPage.body, /Fächer verwalten/);
  assert.match(assignmentsPage.body, new RegExp(subjectName));
  assert.match(assignmentsPage.body, /Keine Klasse/);
  assert.match(assignmentsPage.body, /Keine Lehrer zugeordnet\./);
  await dbRun("DELETE FROM subjects WHERE id = ?", [insertResult.lastID]);
});

test("admin assignment table can delete an unassigned subject with confirmation flow", async () => {
  const loginResult = await loginAdmin();
  const subjectName = "Darstellende Geometrie ohne Zuordnung";
  const insertResult = await dbRun("INSERT INTO subjects (name) VALUES (?)", [subjectName]);
  const csrfToken = await fetchCsrfToken("/admin/assignments", loginResult.cookies);

  const deleteResponse = await fetchWithCookies(
    "/admin/assignments/delete-group",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfToken,
        subject_id: String(insertResult.lastID)
      }).toString(),
      redirect: "manual"
    },
    loginResult.cookies
  );

  assert.strictEqual(deleteResponse.response.status, 302);
  assert.strictEqual(deleteResponse.response.headers.get("location"), "/admin/assignments");

  const refreshedPage = await fetchWithCookies("/admin/assignments", {}, loginResult.cookies);
  assert.strictEqual(refreshedPage.response.status, 200);
  assert.match(refreshedPage.body, /Unzugeordnetes Fach gelöscht\./);
  assert.doesNotMatch(refreshedPage.body, new RegExp(subjectName));
});

test("admin assignment form only offers subjects from the selected class", async () => {
  const loginResult = await loginAdmin();
  const unrelatedSubject = "Deutsch ohne Klassenbezug";

  const insertResult = await dbRun("INSERT INTO subjects (name) VALUES (?)", [unrelatedSubject]);

  const assignmentForm = await fetchWithCookies("/admin/assignments/new?class=1", {}, loginResult.cookies);
  assert.strictEqual(assignmentForm.response.status, 200);
  assert.match(assignmentForm.body, /Klassenfach suchen/);
  assert.match(assignmentForm.body, /Informatik/);
  assert.doesNotMatch(assignmentForm.body, new RegExp(unrelatedSubject));
  await dbRun("DELETE FROM subjects WHERE id = ?", [insertResult.lastID]);
});

test("admin assignment teacher api paginates available teachers", async () => {
  const loginResult = await loginAdmin();

  await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    ["teacher.one@example.com", "hash", "teacher", "active", 0]
  );
  await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    ["teacher.two@example.com", "hash", "teacher", "active", 0]
  );
  await dbRun(
    "INSERT INTO users (email, password_hash, role, status, must_change_password) VALUES (?,?,?,?,?)",
    ["teacher.three@example.com", "hash", "teacher", "active", 0]
  );

  const teacherApiResponse = await fetchWithCookies(
    "/admin/assignments/api/class/1/teachers?subject_id=1&limit=2",
    { headers: { Accept: "application/json" } },
    loginResult.cookies
  );
  assert.strictEqual(teacherApiResponse.response.status, 200);

  const teacherApiData = JSON.parse(teacherApiResponse.body);
  assert.ok(Array.isArray(teacherApiData.assignedTeachers));
  assert.ok(Array.isArray(teacherApiData.availableTeachers));
  assert.strictEqual(teacherApiData.assignedTeachers.length, 1);
  assert.strictEqual(teacherApiData.availableTeachers.length, 2);
  assert.strictEqual(Number(teacherApiData.totalAvailable), 3);
  assert.strictEqual(teacherApiData.hasMore, true);
});

test("admin assignment table can delete a class subject group", async () => {
  const loginResult = await loginAdmin();
  const csrfToken = await fetchCsrfToken("/admin/assignments", loginResult.cookies);
  const activeSchoolYear = await dbGet(
    "SELECT id, name, start_date, end_date, is_active FROM school_years WHERE is_active = ? ORDER BY id DESC LIMIT 1",
    [true]
  );
  const teacherRow = await dbGet("SELECT id, role FROM users WHERE email = ?", ["teacher@example.com"]);

  try {
  const deleteResponse = await fetchWithCookies(
    "/admin/assignments/delete-group",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfToken,
        class_id: "1",
        subject_id: "1"
      }).toString(),
      redirect: "manual"
    },
    loginResult.cookies
  );

  assert.strictEqual(deleteResponse.response.status, 302);
  assert.strictEqual(deleteResponse.response.headers.get("location"), "/admin/assignments");

  const assignmentsPage = await fetchWithCookies("/admin/assignments", {}, loginResult.cookies);
  assert.strictEqual(assignmentsPage.response.status, 200);
  assert.match(assignmentsPage.body, /Fachgruppe entfernt\. 1 Lehrerzuordnung\(en\)/);
  assert.doesNotMatch(assignmentsPage.body, /<td class="assign-col-subject">Informatik<\/td>/);
  assert.match(assignmentsPage.body, /Zuordnungen und offene Fächer/);

  const assignmentForm = await fetchWithCookies("/admin/assignments/new?class=1", {}, loginResult.cookies);
  assert.strictEqual(assignmentForm.response.status, 200);
  assert.doesNotMatch(assignmentForm.body, /value="Informatik"/);
  } finally {
    await dbRun(
      "INSERT INTO class_subject_teacher (class_id, subject_id, teacher_id, school_year_id) VALUES (?,?,?,?)",
      [1, 1, teacherRow.id, activeSchoolYear.id]
    );
  }
});

test("audit logs keep appended changes and return live updates in descending order", async () => {
  const loginResult = await loginAdmin();

  const firstToken = await fetchCsrfToken("/admin/classes/1/edit", loginResult.cookies);
  const firstUpdate = new URLSearchParams({
    _csrf: firstToken,
    name: "3AHWII",
    subject: "Informatik Basis",
    teacher_id: "2"
  });

  const firstUpdateResponse = await fetchWithCookies(
    "/admin/classes/1",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: firstUpdate.toString(),
      redirect: "manual"
    },
    loginResult.cookies
  );

  assert.strictEqual(firstUpdateResponse.response.status, 302);

  const baselineResponse = await fetchWithCookies(
    "/admin/audit-logs/data",
    { headers: { Accept: "application/json" } },
    loginResult.cookies
  );
  assert.strictEqual(baselineResponse.response.status, 200);

  const baselineData = JSON.parse(baselineResponse.body);
  assert.ok(Array.isArray(baselineData.logs));
  assert.ok(baselineData.logs.length >= 1);
  const newestId = Number(baselineData.logs[0].id);
  assert.ok(Number.isFinite(newestId));

  const secondToken = await fetchCsrfToken("/admin/classes/1/edit", loginResult.cookies);
  const secondUpdate = new URLSearchParams({
    _csrf: secondToken,
    name: "3AHWII",
    subject: "Informatik Aufbau",
    teacher_id: "2"
  });

  const secondUpdateResponse = await fetchWithCookies(
    "/admin/classes/1",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: secondUpdate.toString(),
      redirect: "manual"
    },
    loginResult.cookies
  );
  assert.strictEqual(secondUpdateResponse.response.status, 302);

  const thirdToken = await fetchCsrfToken("/admin/classes/1/edit", loginResult.cookies);
  const thirdUpdate = new URLSearchParams({
    _csrf: thirdToken,
    name: "3AHWII",
    subject: "Informatik Live",
    teacher_id: "2"
  });

  const thirdUpdateResponse = await fetchWithCookies(
    "/admin/classes/1",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: thirdUpdate.toString(),
      redirect: "manual"
    },
    loginResult.cookies
  );
  assert.strictEqual(thirdUpdateResponse.response.status, 302);

  const liveResponse = await fetchWithCookies(
    `/admin/audit-logs/data?afterId=${newestId}`,
    { headers: { Accept: "application/json" } },
    loginResult.cookies
  );
  assert.strictEqual(liveResponse.response.status, 200);

  const liveData = JSON.parse(liveResponse.body);
  assert.ok(Array.isArray(liveData.logs));
  assert.ok(liveData.logs.length >= 2, "Expected multiple appended audit entries");
  assert.ok(Number(liveData.logs[0].id) > Number(liveData.logs[1].id), "Expected newest logs first");
  assert.ok(Number(liveData.totalCount) >= liveData.logs.length);
  const classUpdateLogs = liveData.logs.filter((entry) => entry.route_path === "/admin/classes/1");
  assert.ok(classUpdateLogs.length >= 2, "Expected class update audit entries");
});
