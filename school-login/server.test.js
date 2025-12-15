const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { once } = require("node:events");

process.env.DB_FILE = ":memory:";
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASS = "StrongPass123!";
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
  const loginPage = await fetchWithCookies("/login");
  const csrfToken = extractCsrfToken(loginPage.body);
  assert.ok(csrfToken, "CSRF token missing in login page");

  const params = new URLSearchParams({
    _csrf: csrfToken,
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASS
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
  assert.strictEqual(loginResponse.response.headers.get("location"), "/admin");

  const dashboard = await fetchWithCookies("/", {}, loginResponse.cookies);
  assert.strictEqual(dashboard.response.status, 200);
  assert.match(dashboard.body, /admin@test\.local/);
});

test("student can view grades and profile after login", async () => {
  const loginPage = await fetchWithCookies("/login");
  const csrfToken = extractCsrfToken(loginPage.body);
  const params = new URLSearchParams({
    _csrf: csrfToken,
    email: "student@example.com",
    password: "studentDemo123!"
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
  assert.strictEqual(loginResponse.response.headers.get("location"), "/student");

  const gradesResponse = await fetchWithCookies("/student/grades", {}, loginResponse.cookies);
  assert.strictEqual(gradesResponse.response.status, 200);
  const gradesData = JSON.parse(gradesResponse.body);
  assert.ok(Array.isArray(gradesData.grades));
  assert.ok(gradesData.grades.length > 0, "Seeded grades missing");

  const profileResponse = await fetchWithCookies("/student/profile", {}, loginResponse.cookies);
  assert.strictEqual(profileResponse.response.status, 200);
  const profile = JSON.parse(profileResponse.body);
  assert.strictEqual(profile.class, "3AHWII");
});

test("student routes redirect when unauthenticated", async () => {
  const res = await fetchWithCookies("/student/grades", { redirect: "manual" });
  assert.strictEqual(res.response.status, 302);
  assert.strictEqual(res.response.headers.get("location"), "/login");
});
