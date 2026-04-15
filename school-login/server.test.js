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

const app = require("./server");
const { db } = require("./db");

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
  assert.match(dashboard.body, /Schnellstart/);
  assert.match(dashboard.body, /Verwaltung/);
  assert.match(dashboard.body, /System/);
  assert.match(dashboard.body, /Platzhalter fuer spaeter/);
  assert.match(dashboard.body, /Nutzer anlegen/);
  assert.match(dashboard.body, /Audit-Log/);
});

test("student can view grades and profile after login", async () => {
  const loginResult = await loginStudent();
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

test("admin archive renders the optimized overview and exports CSV", async () => {
  const loginResult = await loginAdmin();

  const archivePage = await fetchWithCookies("/archive", {}, loginResult.cookies);
  assert.strictEqual(archivePage.response.status, 200);
  assert.match(archivePage.body, /Historische Schuljahre für viel Datenvolumen aufbereitet/);
  assert.match(archivePage.body, /CSV Noten/);
  assert.match(archivePage.body, /Danger-Zone/);

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
  assert.match(assignmentForm.body, /Klassenfach wählen/);
  assert.match(assignmentForm.body, /Informatik \(1 Lehrer\)/);
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
  assert.match(assignmentsPage.body, /Fachgruppe entfernt\. 1 Lehrerzuordnung\(en\) gelöscht\./);
  assert.doesNotMatch(assignmentsPage.body, /teacher@example\.com/);
  assert.match(assignmentsPage.body, /Noch keine Zuordnungen vorhanden\./);

  const assignmentForm = await fetchWithCookies("/admin/assignments/new?class=1", {}, loginResult.cookies);
  assert.strictEqual(assignmentForm.response.status, 200);
  assert.match(assignmentForm.body, /Diese Klasse hat noch keine Fächer\./);
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
  assert.ok(Number(liveData.totalCount) >= baselineData.logs.length + liveData.logs.length);
  assert.ok(
    liveData.logs.every((entry) => entry.route_path === "/admin/classes/1"),
    "Expected class update audit entries"
  );
});
