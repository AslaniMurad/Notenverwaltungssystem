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
const { db } = require("./db");

let server;
let baseUrl;

function extractCsrfToken(html) {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
  return match ? match[1] : null;
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

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
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

  const dashboard = await fetchWithCookies("/admin", {}, loginResult.cookies);
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

test("student returns include entries from multiple classes for the same email", async () => {
  await runDb("INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)", ["3BHIT", "ITP", 2]);
  await runDb(
    "INSERT INTO students (name, email, class_id, school_year) VALUES (?,?,?,?)",
    ["Max Muster", "student@example.com", 2, "2024/25"]
  );
  await runDb(
    "INSERT INTO grade_templates (class_id, name, category, weight, date, description) VALUES (?,?,?,?,?,?)",
    [2, "ITP Test", "Test", 20, new Date().toISOString(), "Rueckgabe aus ITP"]
  );
  await runDb(
    "INSERT INTO grades (student_id, class_id, grade_template_id, grade, note) VALUES (?,?,?,?,?)",
    [2, 2, 4, 1.5, "ITP Rueckgabe"]
  );

  const loginResult = await loginAndChangePassword(
    "student@example.com",
    "NewPass12345",
    "AnotherPass12345"
  );

  assert.strictEqual(loginResult.redirect, "/student");

  const returnsResponse = await fetchWithCookies("/student/returns", {}, loginResult.cookies);
  assert.strictEqual(returnsResponse.response.status, 200);

  const data = JSON.parse(returnsResponse.body);
  const subjects = new Set((data.returns || []).map((entry) => entry.subject));
  assert.ok(subjects.has("Informatik"));
  assert.ok(subjects.has("ITP"));
  assert.ok((data.returns || []).length >= 4);
});

test("teacher bulk grading saves entries for numeric student ids", async () => {
  const loginResult = await loginAndChangePassword(
    "teacher@example.com",
    process.env.DEMO_TEACHER_PASS,
    "TeacherPass12345"
  );

  assert.strictEqual(loginResult.redirect, "/teacher/classes");
  await runDb(
    `INSERT INTO teacher_grading_profiles
     (teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [2, "Standardprofil", "points", "points_or_grade", "include_zero", 88.5, 75, 62.5, 50, 0, 5, 1.5, 2.5, 3, 3.5, 4.5, 1]
  );
  const templateId = 1;

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

test("student routes redirect when unauthenticated", async () => {
  const res = await fetchWithCookies("/student/grades", { redirect: "manual" });
  assert.strictEqual(res.response.status, 302);
  assert.strictEqual(res.response.headers.get("location"), "/login");
});
