const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { once } = require("node:events");

process.env.DB_FILE = ":memory:";
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASS = "StrongPass123!";
process.env.SEED_ADMIN = "true";
process.env.SEED_DEMO = "true";
process.env.DEMO_TEACHER_PASS = "teacherDemo123!";
process.env.DEMO_STUDENT_PASS = "studentDemo123!";
process.env.USE_FAKE_DB = "true";

const app = require("./server");

let server;
let baseUrl;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
}

function buildCookieHeader(cookies) {
  if (!cookies.length) return {};
  const cookieValue = cookies.map((c) => c.split(";", 1)[0]).join("; ");
  return { cookie: cookieValue };
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
  return { response, body, cookies: [...cookies, ...setCookies] };
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
  if (location !== "/force-password-change") {
    return { cookies: loginResponse.cookies, redirect: location };
  }

  const forcePage = await fetchWithCookies("/force-password-change", {}, loginResponse.cookies);
  const forceToken = extractCsrfToken(forcePage.body);
  assert.ok(forceToken, "CSRF token missing in force-password-change page");

  const changeParams = new URLSearchParams({
    _csrf: forceToken,
    newPassword
  });

  const changeResponse = await fetchWithCookies(
    "/force-password-change",
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

test("admin can log in with seeded credentials", async () => {
  const loginResult = await loginAndChangePassword(
    process.env.ADMIN_EMAIL,
    process.env.ADMIN_PASS,
    "NewPass12345"
  );

  assert.strictEqual(loginResult.redirect, "/admin");

  const dashboard = await fetchWithCookies("/", {}, loginResult.cookies);
  assert.strictEqual(dashboard.response.status, 200);
  assert.match(dashboard.body, /admin@test\.local/);
});

test("student can view grades and profile after login", async () => {
  const loginResult = await loginAndChangePassword(
    "student@example.com",
    process.env.DEMO_STUDENT_PASS,
    "NewPass12345"
  );

  assert.strictEqual(loginResult.redirect, "/student");

  const gradesResponse = await fetchWithCookies("/student/grades", {}, loginResult.cookies);
  assert.strictEqual(gradesResponse.response.status, 200);
  const gradesData = JSON.parse(gradesResponse.body);
  assert.ok(Array.isArray(gradesData.grades));
  assert.ok(gradesData.grades.length > 0, "Seeded grades missing");

  const profileResponse = await fetchWithCookies("/student/profile", {}, loginResult.cookies);
  assert.strictEqual(profileResponse.response.status, 200);
  const profile = JSON.parse(profileResponse.body);
  assert.strictEqual(profile.class, "3AHWII");
});

test("student routes redirect when unauthenticated", async () => {
  const res = await fetchWithCookies("/student/grades", { redirect: "manual" });
  assert.strictEqual(res.response.status, 302);
  assert.strictEqual(res.response.headers.get("location"), "/login");
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
  assert.ok(Number(liveData.totalCount) >= baselineData.logs.length + liveData.logs.length);
  assert.ok(
    liveData.logs.every((entry) => entry.route_path === "/admin/classes/1"),
    "Expected class update audit entries"
  );
});
