(() => {
  const initialDataEl = document.getElementById("student-initial-data");
  let initialData = {};

  if (initialDataEl?.textContent) {
    try {
      initialData = JSON.parse(initialDataEl.textContent);
    } catch (err) {
      console.error("Konnte initiale Studentendaten nicht laden:", err);
    }
  }

  const csrfToken = initialData.csrfToken;
  const currentUserEmail = initialData.currentUserEmail || "";

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeGrade(grade) {
    return {
      ...grade,
      title: grade.title || grade.subject || "Leistung",
      category: grade.category || "",
      subject: grade.subject || "",
      teacher: grade.teacher || null,
      comment: grade.comment || "",
      value: grade.value == null ? null : Number(grade.value),
      weight: Number(grade.weight || 1),
      weight_label: grade.weight_label || "",
      is_absent: Boolean(grade.is_absent),
      excluded_from_average: Boolean(grade.excluded_from_average)
    };
  }

  function normalizeTask(task) {
    return {
      ...task,
      title: task.title || "Leistung",
      category: task.category || "",
      subject: task.subject || "",
      description: task.description || "",
      note: task.note || "",
      weight: Number(task.weight || 0),
      grade: task.grade == null ? null : Number(task.grade),
      graded: Boolean(task.graded)
    };
  }

  function normalizeReturn(entry) {
    return {
      ...entry,
      title: entry.title || "Rückgabe",
      category: entry.category || "",
      subject: entry.subject || "",
      note: entry.note || "",
      thread_closed_at: entry.thread_closed_at || null,
      weight: Number(entry.weight || 0),
      grade: entry.grade == null ? null : Number(entry.grade),
      attachment_download_url: entry.attachment_download_url || null,
      attachment_name: entry.attachment_name || null,
      external_link: entry.external_link || null,
      can_message: Boolean(entry.can_message),
      messages: Array.isArray(entry.messages)
        ? entry.messages.map((message) => ({
            id: message.id,
            student_message: message.student_message || "",
            teacher_reply: message.teacher_reply || null,
            teacher_reply_by_email: message.teacher_reply_by_email || null,
            teacher_reply_seen_at: message.teacher_reply_seen_at || null,
            student_hidden_at: message.student_hidden_at || null,
            created_at: message.created_at || null,
            replied_at: message.replied_at || null
          }))
        : []
    };
  }

  const state = {
    allGrades: (initialData.grades || []).map(normalizeGrade),
    grades: (initialData.grades || []).map(normalizeGrade),
    averages: initialData.averages || { subjects: [], overall: null },
    classAverages: initialData.classAverages || [],
    notifications: initialData.notifications || [],
    trend: initialData.trend || { direction: "steady", change: 0 },
    tasks: (initialData.tasks || []).map(normalizeTask),
    archivedTasks: (initialData.archivedTasks || []).map(normalizeTask),
    returns: (initialData.returns || []).map(normalizeReturn),
    openReturnDetails: new Set()
  };

  const needsOverview = Boolean(
    document.getElementById("overview-average") ||
      document.getElementById("overview-upcoming") ||
      document.getElementById("overview-recent-returns") ||
      document.getElementById("overview-latest-grades")
  );
  const needsTasks = Boolean(document.getElementById("task-list"));
  const needsArchive = Boolean(document.getElementById("archive-list"));
  const needsReturns = Boolean(document.getElementById("return-list"));
  const needsRequests = Boolean(document.getElementById("request-list"));
  const needsGradeOverview = Boolean(document.getElementById("grade-subject-overview"));
  const needsGrades = Boolean(document.getElementById("grade-list"));
  const needsClassAverages = Boolean(document.getElementById("class-average"));
  const needsNotifications = Boolean(document.getElementById("notification-list"));
  let requestFocusGradeId = new URLSearchParams(window.location.search).get("gradeId");
  let gradeRefreshTimer = null;

  document.querySelectorAll(".accordion").forEach((accordion) => {
    accordion.addEventListener("click", () => {
      const content = accordion.querySelector(".accordion-content");
      if (!content) return;
      content.style.display = content.style.display === "block" ? "none" : "block";
    });
  });

  function gradeColor(value) {
    if (!Number.isFinite(value)) return "danger";
    if (value <= 1.5) return "success";
    if (value <= 2.5) return "warning";
    return "danger";
  }

  function formatDate(value, withTime = false) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return withTime ? date.toLocaleString() : date.toLocaleDateString();
  }

  function dateSortValue(value, fallback) {
    if (!value) return fallback;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? fallback : time;
  }

  function normalizeText(value) {
    return String(value || "").toLowerCase();
  }

  function matchesSubject(item, subject) {
    if (!subject) return true;
    return String(item.subject || "") === subject;
  }

  function matchesQuery(item, query, fields) {
    if (!query) return true;
    const needle = normalizeText(query);
    return fields.some((field) => normalizeText(item[field]).includes(needle));
  }

  function hasUnreadTeacherReplies(entry) {
    return (entry.messages || []).some(
      (message) => message.teacher_reply && !message.teacher_reply_seen_at
    );
  }

  function getThreadClosedAt(entry) {
    if (entry?.thread_closed_at) return entry.thread_closed_at;
    const messages = Array.isArray(entry?.messages) ? entry.messages : [];
    return messages.reduce((latest, message) => {
      const hiddenAt = message?.student_hidden_at || null;
      if (!hiddenAt) return latest;
      if (!latest) return hiddenAt;
      return new Date(hiddenAt) > new Date(latest) ? hiddenAt : latest;
    }, null);
  }

  function getReturnMessageStats(entry) {
    const messages = Array.isArray(entry?.messages) ? entry.messages : [];
    let unansweredCount = 0;
    let unreadReplyCount = 0;
    let lastActivityTs = 0;
    const closedAt = getThreadClosedAt(entry);

    messages.forEach((message) => {
      const studentTs = dateSortValue(message.created_at, 0);
      const replyTs = dateSortValue(message.replied_at, 0);
      lastActivityTs = Math.max(lastActivityTs, studentTs, replyTs);
      if (!message.teacher_reply) {
        unansweredCount += 1;
      } else if (!message.teacher_reply_seen_at) {
        unreadReplyCount += 1;
      }
    });

    if (closedAt) {
      lastActivityTs = Math.max(lastActivityTs, dateSortValue(closedAt, 0));
      unansweredCount = 0;
      unreadReplyCount = 0;
    }

    return {
      totalCount: messages.length,
      unansweredCount,
      unreadReplyCount,
      closedAt,
      lastActivityAt: lastActivityTs ? new Date(lastActivityTs).toISOString() : null
    };
  }

  function getReturnStatus(stats) {
    if (stats.closedAt) {
      return { label: "Geschlossen", className: "closed" };
    }
    if (stats.unreadReplyCount > 0) {
      return { label: "Neue Antwort", className: "new" };
    }
    if (stats.unansweredCount > 0) {
      return { label: "Antwort ausstehend", className: "pending" };
    }
    if (stats.totalCount > 0) {
      return { label: "Beantwortet", className: "answered" };
    }
    return { label: "Noch keine Rückfrage", className: "idle" };
  }

  function getTaskStatus(task) {
    if (task.graded) {
      return { label: "Benotet", className: "graded" };
    }
    const due = task.due_at ? new Date(task.due_at) : null;
    if (due && !Number.isNaN(due.getTime()) && due < new Date()) {
      return { label: "Überfällig", className: "overdue" };
    }
    return { label: "Offen", className: "open" };
  }

  function computeAveragesClient(grades) {
    const subjectMap = new Map();
    let weightedSum = 0;
    let weightTotal = 0;

    grades.forEach((grade) => {
      if (grade?.excluded_from_average) return;
      if (grade?.is_absent) return;
      const value = Number(grade?.value);
      const weight = Number(grade?.weight || 1);
      if (!Number.isFinite(value) || !Number.isFinite(weight) || weight < 0) return;

      weightedSum += value * weight;
      weightTotal += weight;

      const bucket = subjectMap.get(grade.subject) || { weightedSum: 0, weightTotal: 0 };
      bucket.weightedSum += value * weight;
      bucket.weightTotal += weight;
      subjectMap.set(grade.subject, bucket);
    });

    const subjects = Array.from(subjectMap.entries())
      .map(([subject, info]) => ({
        subject,
        average: info.weightTotal ? Number((info.weightedSum / info.weightTotal).toFixed(2)) : null
      }))
      .sort((a, b) => String(a.subject || "").localeCompare(String(b.subject || "")));

    return {
      subjects,
      overall: weightTotal ? Number((weightedSum / weightTotal).toFixed(2)) : null
    };
  }

  function getGradeFilterValues() {
    return {
      query: document.getElementById("filter-query")?.value.trim() || "",
      subject: document.getElementById("filter-subject")?.value || "",
      startDate: document.getElementById("filter-start")?.value || "",
      endDate: document.getElementById("filter-end")?.value || "",
      sort: document.getElementById("filter-sort")?.value || "date"
    };
  }

  function sortGrades(grades, sort) {
    const ordered = [...grades];
    if (sort === "value") {
      ordered.sort((a, b) => {
        const aValue = Number.isFinite(a.value) ? a.value : Number.POSITIVE_INFINITY;
        const bValue = Number.isFinite(b.value) ? b.value : Number.POSITIVE_INFINITY;
        if (aValue !== bValue) return aValue - bValue;
        return dateSortValue(b.graded_at, 0) - dateSortValue(a.graded_at, 0);
      });
      return ordered;
    }
    ordered.sort((a, b) => dateSortValue(b.graded_at, 0) - dateSortValue(a.graded_at, 0));
    return ordered;
  }

  function getBaseFilteredGrades() {
    const { query, startDate, endDate } = getGradeFilterValues();
    let items = [...state.allGrades];

    if (query) {
      items = items.filter((grade) =>
        [grade.subject, grade.title, grade.category, grade.comment, grade.teacher]
          .map((value) => String(value || "").toLowerCase())
          .some((value) => value.includes(query.toLowerCase()))
      );
    }

    if (startDate) {
      const start = new Date(startDate);
      if (!Number.isNaN(start.getTime())) {
        items = items.filter((grade) => grade.graded_at && new Date(grade.graded_at) >= start);
      }
    }

    if (endDate) {
      const end = new Date(endDate);
      if (!Number.isNaN(end.getTime())) {
        end.setHours(23, 59, 59, 999);
        items = items.filter((grade) => grade.graded_at && new Date(grade.graded_at) <= end);
      }
    }

    return items;
  }

  function getVisibleGrades(baseGrades = getBaseFilteredGrades()) {
    const { subject, sort } = getGradeFilterValues();
    const filtered = subject
      ? baseGrades.filter((grade) => String(grade.subject || "") === subject)
      : baseGrades;
    return sortGrades(filtered, sort);
  }

  function getSubjectStandingLabel(average) {
    if (!Number.isFinite(average)) return "Noch keine Bewertung";
    if (average <= 1.5) return "Sehr guter Stand";
    if (average <= 2.5) return "Guter Stand";
    if (average <= 3.5) return "Stabiler Stand";
    return "Kritischer Stand";
  }

  function getClassAverageForSubject(subject) {
    return (state.classAverages || []).find((item) => String(item.subject || "") === String(subject));
  }

  function getSubjectOverviewItems(baseGrades = getBaseFilteredGrades()) {
    const subjectMap = new Map();

    baseGrades.forEach((grade) => {
      const key = String(grade.subject || "Ohne Fach");
      const bucket = subjectMap.get(key) || {
        subject: key,
        count: 0,
        weightedSum: 0,
        weightTotal: 0,
        latestAt: null,
        latestTitle: "",
        latestValue: null
      };
      bucket.count += 1;
      if (
        !grade.excluded_from_average &&
        !grade.is_absent &&
        Number.isFinite(grade.value) &&
        Number.isFinite(grade.weight)
      ) {
        bucket.weightedSum += grade.value * grade.weight;
        bucket.weightTotal += grade.weight;
      }
      if (
        !bucket.latestAt ||
        dateSortValue(grade.graded_at, 0) > dateSortValue(bucket.latestAt, 0)
      ) {
        bucket.latestAt = grade.graded_at || null;
        bucket.latestTitle = grade.title || "";
        bucket.latestValue = grade.value;
      }
      subjectMap.set(key, bucket);
    });

    return Array.from(subjectMap.values())
      .map((item) => {
        const average = item.weightTotal
          ? Number((item.weightedSum / item.weightTotal).toFixed(2))
          : null;
        return {
          ...item,
          average,
          standingLabel: getSubjectStandingLabel(average),
          classAverage: getClassAverageForSubject(item.subject)?.average ?? null
        };
      })
      .sort((a, b) => String(a.subject || "").localeCompare(String(b.subject || "")));
  }

  function syncGradeSubjectSelection(baseGrades = getBaseFilteredGrades()) {
    const select = document.getElementById("filter-subject");
    if (!select) return "";
    if (select.dataset.gradeSubjectLocked === "true") {
      return select.value || "";
    }

    const availableSubjects = new Set(
      getSubjectOverviewItems(baseGrades).map((item) => String(item.subject || ""))
    );
    if (select.value && !availableSubjects.has(String(select.value))) {
      select.value = "";
    }
    return select.value || "";
  }

  function renderGradeSubjectOverview(baseGrades = getBaseFilteredGrades()) {
    const container = document.getElementById("grade-subject-overview");
    if (!container) return;

    const items = getSubjectOverviewItems(baseGrades);

    if (!items.length) {
      container.innerHTML =
        '<p class="empty-state">Keine Fachdaten für die aktuellen Filter vorhanden.</p>';
      return;
    }

    container.innerHTML = `
      <div class="subject-list-header">
        <span>Fach</span>
        <span>Durchschnitt</span>
        <span>Einträge</span>
        <span>Letztes Update</span>
      </div>
    ` + items
      .map((item) => {
        const avgText = item.average == null ? "-" : Number(item.average).toFixed(2);
        const latestText = item.latestAt ? formatDate(item.latestAt) : "-";
        const subjectUrl = `/student/grades?subject=${encodeURIComponent(item.subject)}`;
        return `
          <a class="subject-list-row" href="${subjectUrl}">
            <span>${escapeHtml(item.subject)}</span>
            <span class="subject-list-avg ${gradeColor(item.average)}">${avgText}</span>
            <span class="subject-list-count">${item.count}</span>
            <span class="subject-list-date">${latestText}</span>
          </a>
        `;
      })
      .join("");
  }

  function renderGradeSubjectDetail(baseGrades = getBaseFilteredGrades()) {
    const container = document.getElementById("grade-subject-detail");
    if (!container) return;

    const selectedSubject = syncGradeSubjectSelection(baseGrades);
    if (!selectedSubject) {
      container.innerHTML = `
        <div class="grade-subject-detail-empty">
          <strong>Fach auswählen</strong>
          <p>Wähle oben ein Fach, um den aktuellen Stand und das Beurteilungsprotokoll im Detail zu sehen.</p>
        </div>
      `;
      return;
    }

    const subjectGrades = baseGrades.filter(
      (grade) => String(grade.subject || "") === String(selectedSubject)
    );
    const averages = computeAveragesClient(subjectGrades);
    const latest = sortGrades(subjectGrades, "date")[0] || null;
    const classAverage = getClassAverageForSubject(selectedSubject)?.average ?? null;
    const delta =
      averages.overall != null && classAverage != null
        ? Number((averages.overall - classAverage).toFixed(2))
        : null;
    const standing = getSubjectStandingLabel(averages.overall);

    container.innerHTML = `
      <div class="grade-subject-detail-compact">
        <div class="grade-subject-detail-head-compact">
          ${buildSubjectBadge(selectedSubject)}
          <strong>${escapeHtml(standing)}</strong>
        </div>
        <div class="overview-stats-strip">
          <div class="stat-inline"><span class="stat-inline-label">Fachdurchschnitt</span><strong class="stat-inline-value">${averages.overall == null ? "-" : Number(averages.overall).toFixed(2)}</strong></div>
          <div class="stat-inline"><span class="stat-inline-label">Einträge</span><strong class="stat-inline-value">${subjectGrades.length}</strong></div>
          <div class="stat-inline"><span class="stat-inline-label">Letzte Bewertung</span><strong class="stat-inline-value">${latest?.value == null ? "-" : formatGradeValue(latest.value)}</strong></div>
          <div class="stat-inline"><span class="stat-inline-label">Klassenvergleich</span><strong class="stat-inline-value">${classAverage == null ? "-" : Number(classAverage).toFixed(2)}</strong></div>
        </div>
      </div>
    `;
  }

  function renderGradeProtocolHeader(baseGrades = getBaseFilteredGrades()) {
    const selectedSubject = syncGradeSubjectSelection(baseGrades);
    const visibleGrades = getVisibleGrades(baseGrades);
    const title = document.getElementById("grade-protocol-title");
    const copy = document.getElementById("grade-protocol-copy");
    if (!title || !copy) return;

    if (!selectedSubject) {
      const subjectCount = getSubjectOverviewItems(baseGrades).length;
      const subjectLabel = subjectCount === 1 ? "Fach" : "Fächer";
      title.textContent = "Beurteilungsprotokoll";
      copy.textContent = !visibleGrades.length
        ? "Keine sichtbaren Einträge für die aktuellen Filter."
        : `${visibleGrades.length} sichtbare Einträge über ${subjectCount} ${subjectLabel}. Wähle oben ein Fach für Details und deinen aktuellen Stand.`;
      return;
    }

    const averages = computeAveragesClient(visibleGrades);
    const classAverage = getClassAverageForSubject(selectedSubject)?.average ?? null;
    const averageText = averages.overall == null ? "-" : Number(averages.overall).toFixed(2);
    const classAverageText =
      classAverage == null ? "kein Klassenschnitt verfügbar" : `Klassenschnitt ${Number(classAverage).toFixed(2)}`;
    title.textContent = `Beurteilungsprotokoll: ${selectedSubject}`;
    copy.textContent = !visibleGrades.length
      ? `Keine sichtbaren Einträge für ${selectedSubject}.`
      : `${visibleGrades.length} sichtbare Einträge, aktueller Stand ${averageText}, ${classAverageText}.`;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value;
    }
  }

  function setCount(id, count) {
    setText(id, String(Number.isFinite(count) ? count : 0));
  }

  function formatGradeValue(value) {
    return Number.isFinite(value) ? Number(value).toFixed(2) : "-";
  }

  function formatWeight(weight) {
    return Number.isFinite(weight) && weight ? `${weight}%` : "-";
  }

  function buildSubjectBadge(subject) {
    return `<span class="subject-badge">${escapeHtml(subject || "Ohne Fach")}</span>`;
  }

  function buildCategoryBadge(category) {
    if (!category) return "";
    return `<span class="pill">${escapeHtml(category)}</span>`;
  }

  function buildMetaLine(parts) {
    const items = parts.filter(Boolean);
    if (!items.length) return "";
    return `<div class="task-meta row-meta">${items
      .map((part) => `<span>${escapeHtml(part)}</span>`)
      .join("")}</div>`;
  }

  function buildRowHead(title, subject, category) {
    return `
      <div class="row-head task-title">
        ${buildSubjectBadge(subject)}
        <strong>${escapeHtml(title || "Eintrag")}</strong>
        ${buildCategoryBadge(category)}
      </div>
    `;
  }

  function getOpenRequestCount() {
    return state.returns.filter((entry) => {
      const stats = getReturnMessageStats(entry);
      return stats.unreadReplyCount > 0 || stats.unansweredCount > 0;
    }).length;
  }

  function getSubjectCount() {
    const subjectSet = new Set();
    state.grades.forEach((grade) => {
      if (grade.subject) subjectSet.add(grade.subject);
    });
    state.tasks.forEach((task) => {
      if (task.subject) subjectSet.add(task.subject);
    });
    state.returns.forEach((entry) => {
      if (entry.subject) subjectSet.add(entry.subject);
    });
    return subjectSet.size;
  }

  function renderGrades() {
    const baseGrades = getBaseFilteredGrades();
    syncGradeSubjectSelection(baseGrades);
    state.grades = getVisibleGrades(baseGrades);
    state.averages = computeAveragesClient(state.grades);

    const container = document.getElementById("grade-list");
    if (!container) return;

    setCount("grade-count", state.grades.length);
    renderGradeSubjectDetail(baseGrades);
    renderGradeProtocolHeader(baseGrades);

    if (!state.grades.length) {
      const selectedSubject = getGradeFilterValues().subject;
      container.innerHTML = `<p class="empty-state">${
        selectedSubject
          ? `Keine Noten für ${escapeHtml(selectedSubject)} mit den aktuellen Filtern vorhanden.`
          : "Keine Noten vorhanden."
      }</p>`;
      return;
    }

    container.innerHTML = state.grades
      .map((grade) => {
        const gradeText = formatGradeValue(grade.value);
        const dateText = formatDate(grade.graded_at);
        const teacherText = grade.teacher || "Lehrkraft unbekannt";
        const weightText = grade.weight_label || formatWeight(grade.weight);
        const noteHtml = grade.comment
          ? `<div class="nav-note">${escapeHtml(grade.comment)}</div>`
          : "";

        return `
          <article class="grade-row dataset-row">
            <div class="row-main">
              ${buildRowHead(grade.title, grade.subject, grade.category)}
              ${buildMetaLine([
                `Lehrkraft: ${teacherText}`,
                `Datum: ${dateText}`,
                `Gewichtung: ${weightText}`
              ])}
              ${noteHtml}
            </div>
            <div class="row-side grade-side">
              <div class="grade-value">${grade.is_absent ? "n.a." : gradeText}</div>
              <span class="grade-pill ${gradeColor(grade.value)}">${
                grade.is_absent ? "Abwesend" : `Note ${gradeText}`
              }</span>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderAverages() {
    const overall = state.averages?.overall;
    setText("avg-overall", overall == null ? "-" : Number(overall).toFixed(2));

    const trend = state.trend || { direction: "steady", change: 0 };
    const trendEl = document.getElementById("avg-trend");
    if (trendEl) {
      const icon =
        trend.direction === "improving" ? "+" : trend.direction === "declining" ? "-" : "=";
      trendEl.textContent = `${icon} ${trend.change ?? 0}`;
      trendEl.className = `stat-inline-value trend-badge ${trend.direction || "steady"}`;
    }

    if (!state.grades.length) {
      setText("avg-updated", "-");
      return;
    }

    const latest = [...state.grades].sort(
      (a, b) => dateSortValue(b.graded_at, 0) - dateSortValue(a.graded_at, 0)
    )[0];
    setText("avg-updated", latest?.graded_at ? formatDate(latest.graded_at, true) : "-");
  }

  function renderOverview() {
    setText(
      "overview-average",
      state.averages?.overall == null ? "-" : Number(state.averages.overall).toFixed(2)
    );
    setCount("overview-subject-count", getSubjectCount());
    setCount("overview-open-tasks", state.tasks.filter((task) => !task.graded).length);
    setCount("overview-return-count", state.returns.length);
    setCount("overview-open-requests", getOpenRequestCount());

    const upcomingContainer = document.getElementById("overview-upcoming");
    if (upcomingContainer) {
      const upcoming = state.tasks
        .filter((task) => !task.graded && task.due_at)
        .sort(
          (a, b) =>
            dateSortValue(a.due_at, Number.POSITIVE_INFINITY) -
            dateSortValue(b.due_at, Number.POSITIVE_INFINITY)
        )
        .slice(0, 5);

      setCount("overview-upcoming-count", upcoming.length);

      if (!upcoming.length) {
        upcomingContainer.innerHTML =
          '<p class="empty-state">Keine offenen Aufgaben mit Datum vorhanden.</p>';
      } else {
        upcomingContainer.innerHTML = upcoming
          .map(
            (task) => `
              <div class="overview-row">
                <div class="overview-row-main">
                  ${buildRowHead(task.title, task.subject, task.category)}
                  ${buildMetaLine([`Fällig: ${formatDate(task.due_at)}`])}
                </div>
                <div class="overview-row-side">
                  <span class="status-pill ${getTaskStatus(task).className}">${getTaskStatus(task).label}</span>
                </div>
              </div>
            `
          )
          .join("");
      }
    }

    const latestGradesContainer = document.getElementById("overview-latest-grades");
    if (latestGradesContainer) {
      const latestGrades = [...state.grades]
        .sort((a, b) => dateSortValue(b.graded_at, 0) - dateSortValue(a.graded_at, 0))
        .slice(0, 5);

      setCount("overview-latest-grade-count", latestGrades.length);

      if (!latestGrades.length) {
        latestGradesContainer.innerHTML =
          '<p class="empty-state">Noch keine Benotungen vorhanden.</p>';
      } else {
        latestGradesContainer.innerHTML = latestGrades
          .map(
            (grade) => `
              <div class="overview-row">
                <div class="overview-row-main">
                  ${buildRowHead(grade.title, grade.subject, grade.category)}
                  ${buildMetaLine([
                    `Lehrkraft: ${grade.teacher || "Lehrkraft unbekannt"}`,
                    `Datum: ${formatDate(grade.graded_at)}`
                  ])}
                </div>
                <div class="overview-row-side">
                  <span class="grade-pill ${gradeColor(grade.value)}">Note ${formatGradeValue(grade.value)}</span>
                </div>
              </div>
            `
          )
          .join("");
      }
    }

    const recentReturnsContainer = document.getElementById("overview-recent-returns");
    if (recentReturnsContainer) {
      const recentReturns = [...state.returns]
        .sort((a, b) => dateSortValue(b.graded_at, 0) - dateSortValue(a.graded_at, 0))
        .slice(0, 5);

      setCount("overview-recent-return-count", recentReturns.length);

      if (!recentReturns.length) {
        recentReturnsContainer.innerHTML =
          '<p class="empty-state">Noch keine Rückgaben vorhanden.</p>';
      } else {
        recentReturnsContainer.innerHTML = recentReturns
          .map((entry) => {
            const stats = getReturnMessageStats(entry);
            const status = getReturnStatus(stats);
            return `
              <div class="overview-row">
                <div class="overview-row-main">
                  ${buildRowHead(entry.title, entry.subject, entry.category)}
                  ${buildMetaLine([
                    `Rückgabe: ${formatDate(entry.graded_at)}`,
                    `${stats.totalCount} Nachricht${stats.totalCount === 1 ? "" : "en"}`
                  ])}
                </div>
                <div class="overview-row-side overview-row-stack">
                  <span class="grade-pill ${gradeColor(entry.grade)}">Note ${formatGradeValue(entry.grade)}</span>
                  <span class="return-status-pill ${status.className}">${status.label}</span>
                </div>
              </div>
            `;
          })
          .join("");
      }
    }
  }

  function renderClassAverage() {
    const container = document.getElementById("class-average");
    if (!container) return;

    if (!state.classAverages.length) {
      container.innerHTML = '<p class="empty-state">Keine Vergleichsdaten vorhanden.</p>';
      return;
    }

    const highest = Math.max(...state.classAverages.map((item) => Number(item.average || 0)), 1);
    container.innerHTML = state.classAverages
      .map((item) => {
        const width = Math.min(100, Math.round((Number(item.average || 0) / highest) * 100));
        const valueText = item.average != null ? Number(item.average).toFixed(2) : "-";
        return `
          <div class="chart-bar">
            <div class="chart-label">${escapeHtml(item.subject)}</div>
            <div class="bar"><span style="width:${width}%;"></span></div>
            <small>${valueText}</small>
          </div>
        `;
      })
      .join("");
  }

  function renderNotifications() {
    const container = document.getElementById("notification-list");
    if (!container) return;

    setCount("notification-count", state.notifications.length);

    if (!state.notifications.length) {
      container.innerHTML = '<p class="empty-state">Keine neuen Benachrichtigungen.</p>';
      return;
    }

    container.innerHTML = state.notifications
      .map(
        (note) => `
          <article class="notification ${note.read_at ? "" : "unread"}">
            <div class="notification-head">
              <strong>${note.type === "average" ? "Durchschnitt" : "Neue Note"}</strong>
              <small>${formatDate(note.created_at, true)}</small>
            </div>
            <p class="notification-copy">${escapeHtml(note.message)}</p>
            ${
              note.read_at
                ? ""
                : `<button class="btn small secondary" data-note-id="${note.id}">Als gelesen markieren</button>`
            }
          </article>
        `
      )
      .join("");

    container.querySelectorAll("button[data-note-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = button.getAttribute("data-note-id");
        const headers = csrfToken ? { "X-CSRF-Token": csrfToken } : {};
        await fetch(`/student/notifications/${id}/read`, { method: "POST", headers });
        state.notifications = state.notifications.map((note) =>
          note.id == id ? { ...note, read_at: new Date().toISOString() } : note
        );
        renderNotifications();
      });
    });
  }

  function renderTasks() {
    const container = document.getElementById("task-list");
    if (!container) return;

    if (!state.tasks.length) {
      setCount("task-count", 0);
      container.innerHTML = '<p class="empty-state">Keine aktiven Prüfungen vorhanden.</p>';
      return;
    }

    const subject = document.getElementById("task-filter-subject")?.value || "";
    const query = document.getElementById("task-filter-query")?.value || "";
    const filtered = state.tasks.filter(
      (task) =>
        matchesSubject(task, subject) &&
        matchesQuery(task, query, ["title", "description", "subject", "category", "note"])
    );

    setCount("task-count", filtered.length);

    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine aktiven Prüfungen gefunden.</p>';
      return;
    }

    const ordered = [...filtered].sort((a, b) => {
      const aTime = dateSortValue(a.due_at, Number.POSITIVE_INFINITY);
      const bTime = dateSortValue(b.due_at, Number.POSITIVE_INFINITY);
      if (aTime !== bTime) return aTime - bTime;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    const now = new Date();
    const upcomingLimit = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const groups = {
      past: [],
      upcoming: [],
      later: []
    };

    ordered.forEach((task) => {
      if (!task.due_at) {
        groups.later.push(task);
        return;
      }

      const dueAt = new Date(task.due_at);
      if (Number.isNaN(dueAt.getTime())) {
        groups.later.push(task);
        return;
      }

      if (dueAt < now) {
        groups.past.push(task);
        return;
      }
      if (dueAt <= upcomingLimit) {
        groups.upcoming.push(task);
        return;
      }
      groups.later.push(task);
    });

    const renderTaskRow = (task) => {
      const status = getTaskStatus(task);
      const gradeText = formatGradeValue(task.grade);
      return `
        <article class="task-row dataset-row">
          <div class="row-main">
            ${buildRowHead(task.title, task.subject, task.category)}
            ${buildMetaLine([
              `Fällig: ${formatDate(task.due_at)}`,
              `Gewichtung: ${formatWeight(task.weight)}`,
              task.graded_at ? `Benotet: ${formatDate(task.graded_at)}` : ""
            ])}
            ${task.description ? `<div class="nav-note">${escapeHtml(task.description)}</div>` : ""}
            ${task.note ? `<div class="nav-note">Kommentar: ${escapeHtml(task.note)}</div>` : ""}
          </div>
          <div class="row-side task-status">
            <span class="status-pill ${status.className}">${status.label}</span>
            ${task.graded ? `<span class="grade-pill ${gradeColor(task.grade)}">Note ${gradeText}</span>` : ""}
          </div>
        </article>
      `;
    };

    const renderTaskGroup = (title, copy, tasks) => `
      <section class="task-group">
        <div class="task-group-head">
          <div>
            <h4>${title}</h4>
            <p>${copy}</p>
          </div>
          <span class="dataset-count">${tasks.length}</span>
        </div>
        <div class="task-group-rule" aria-hidden="true"></div>
        <div class="dataset-block">
          ${
            tasks.length
              ? tasks.map((task) => renderTaskRow(task)).join("")
              : '<p class="empty-state">Keine Einträge in diesem Bereich.</p>'
          }
        </div>
      </section>
    `;

    container.innerHTML = [
      renderTaskGroup(
        "Bevorstehend",
        "Aufgaben mit Termin in den nächsten 14 Tagen.",
        groups.upcoming
      ),
      renderTaskGroup(
        "Weiter anstehend",
        "Aufgaben mit späterem Termin. Einträge ohne Datum stehen ebenfalls hier.",
        groups.later
      ),
      renderTaskGroup(
        "Vergangene",
        "Aufgaben mit Termin vor dem aktuellen Zeitpunkt.",
        [...groups.past].sort(
          (a, b) => dateSortValue(b.due_at, 0) - dateSortValue(a.due_at, 0)
        )
      )
    ].join("");
  }

  function renderArchive() {
    const container = document.getElementById("archive-list");
    if (!container) return;

    if (!state.archivedTasks.length) {
      setCount("archive-count", 0);
      container.innerHTML = '<p class="empty-state">Keine archivierten Prüfungen vorhanden.</p>';
      return;
    }

    const subject = document.getElementById("archive-filter-subject")?.value || "";
    const query = document.getElementById("archive-filter-query")?.value || "";
    const filtered = state.archivedTasks.filter(
      (task) =>
        matchesSubject(task, subject) &&
        matchesQuery(task, query, ["title", "description", "subject", "category", "note"])
    );

    setCount("archive-count", filtered.length);

    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine archivierten Prüfungen gefunden.</p>';
      return;
    }

    const ordered = [...filtered].sort(
      (a, b) => dateSortValue(b.due_at, 0) - dateSortValue(a.due_at, 0)
    );

    container.innerHTML = ordered
      .map((task) => {
        const statusLabel = task.graded ? "Benotet" : "Archiviert";
        return `
          <article class="task-row dataset-row">
            <div class="row-main">
              ${buildRowHead(task.title, task.subject, task.category)}
              ${buildMetaLine([
                `Prüfungsdatum: ${formatDate(task.due_at)}`,
                `Gewichtung: ${formatWeight(task.weight)}`
              ])}
              ${task.description ? `<div class="nav-note">${escapeHtml(task.description)}</div>` : ""}
              ${task.note ? `<div class="nav-note">Kommentar: ${escapeHtml(task.note)}</div>` : ""}
            </div>
            <div class="row-side task-status">
              <span class="status-pill graded">${statusLabel}</span>
              ${task.graded ? `<span class="grade-pill ${gradeColor(task.grade)}">Note ${formatGradeValue(task.grade)}</span>` : ""}
            </div>
          </article>
        `;
      })
      .join("");
  }

  async function markReturnRepliesSeen(gradeId) {
    const headers = csrfToken ? { "X-CSRF-Token": csrfToken } : {};
    await fetch(`/student/returns/${gradeId}/messages/seen`, { method: "POST", headers });
  }

  async function hideRequestThread(gradeId) {
    const headers = csrfToken ? { "X-CSRF-Token": csrfToken } : {};
    const response = await fetch(`/student/returns/${gradeId}/messages/hide`, {
      method: "POST",
      headers
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Ticket konnte nicht ausgeblendet werden.");
    }
  }

  function syncRequestGradeFilterOptions(entries) {
    const select = document.getElementById("request-filter-grade");
    if (!select) return "";

    const previousValue = String(select.value || "");
    const ordered = [...entries].sort(
      (a, b) => dateSortValue(b.graded_at, 0) - dateSortValue(a.graded_at, 0)
    );

    const options = ['<option value="">Alle Rückgaben</option>'];
    ordered.forEach((entry) => {
      const label = `${entry.subject ? `${entry.subject} | ` : ""}${entry.title}`;
      options.push(`<option value="${String(entry.id)}">${escapeHtml(label)}</option>`);
    });
    select.innerHTML = options.join("");

    let nextValue = previousValue;
    if (
      requestFocusGradeId &&
      ordered.some((entry) => String(entry.id) === String(requestFocusGradeId))
    ) {
      nextValue = String(requestFocusGradeId);
    }
    if (nextValue && !ordered.some((entry) => String(entry.id) === String(nextValue))) {
      nextValue = "";
    }
    select.value = nextValue;
    return select.value || "";
  }

  function decorateReturnRows(ordered, container) {
    const rows = container.querySelectorAll(".request-card, .return-row");
    rows.forEach((row, index) => {
      const entry = ordered[index];
      if (!entry) return;
      const body = row.querySelector(".request-card-body") || row.firstElementChild;
      if (!body) return;

      const details = document.createElement("details");
      details.className = "return-message-details";
      const entryKey = String(entry.id);
      const stats = getReturnMessageStats(entry);
      const status = getReturnStatus(stats);
      if (state.openReturnDetails.has(entryKey) || stats.unreadReplyCount > 0) {
        details.open = true;
      }

      const summary = document.createElement("summary");
      summary.className = "return-message-summary request-ticket-summary";
      const summaryLastActivity = stats.lastActivityAt
        ? `Letzte Aktivität: ${formatDate(stats.lastActivityAt, true)}`
        : "Noch keine Aktivität";
      const closedMeta = stats.closedAt
        ? `<span>Geschlossen: ${formatDate(stats.closedAt, true)}</span>`
        : "";
      summary.innerHTML = `
        <div class="return-summary-main">
          <span>Rückfragen</span>
          <span class="return-status-pill ${status.className}">${status.label}</span>
        </div>
        <div class="return-summary-meta">
          <span>${stats.totalCount} Nachricht${stats.totalCount === 1 ? "" : "en"}</span>
          <span>${summaryLastActivity}</span>
          ${closedMeta}
          ${stats.unreadReplyCount ? `<span class="badge-inline return-unread-badge">${stats.unreadReplyCount} neu</span>` : ""}
        </div>
      `;
      details.appendChild(summary);

      const thread = document.createElement("div");
      thread.className = "return-message-thread request-ticket-thread";
      const closedMessageHtml = stats.closedAt
        ? `
          <article class="return-message-row system">
            <div class="return-message-head">
              <strong>Status</strong>
              <span class="ticket-tag system">Geschlossen</span>
              <small>${formatDate(stats.closedAt, true)}</small>
            </div>
            <p>Du hast die Anfrage geschlossen.</p>
          </article>
        `
        : "";
      thread.innerHTML = entry.messages.length
        ? `${entry.messages
            .map((message) => {
              const studentAuthor = currentUserEmail || "Schüler";
              const teacherAuthor =
                message.teacher_reply_by_email || entry.teacher || "Lehrkraft";
              const teacherPart = message.teacher_reply
                ? `
                  <article class="return-message-row teacher ${message.teacher_reply_seen_at ? "" : "unseen"}">
                    <div class="return-message-head">
                      <strong>${escapeHtml(teacherAuthor)}</strong>
                      <span class="ticket-tag teacher">Antwort</span>
                      <small>${formatDate(message.replied_at, true)}</small>
                    </div>
                    ${message.teacher_reply_seen_at ? "" : '<span class="return-reply-new">Neu</span>'}
                    <p>${escapeHtml(message.teacher_reply)}</p>
                  </article>
                `
                : '<article class="return-message-row pending"><small>Antwort der Lehrkraft steht noch aus.</small></article>';
              return `
                <article class="return-message-row student">
                  <div class="return-message-head">
                    <strong>${escapeHtml(studentAuthor)}</strong>
                    <span class="ticket-tag student">Anfrage</span>
                    <small>${formatDate(message.created_at, true)}</small>
                  </div>
                  <p>${escapeHtml(message.student_message)}</p>
                </article>
                ${teacherPart}
              `;
            })
            .join("")}${closedMessageHtml}`
        : '<article class="return-message-row pending"><small>Noch keine Rückfragen vorhanden.</small></article>';
      details.appendChild(thread);

      if (entry.can_message) {
        const form = document.createElement("form");
        form.className = "return-message-form";
        form.setAttribute("data-grade-id", String(entry.id));
        form.innerHTML = `
          <label for="message-${entry.id}">Frage zur Benotung</label>
          <textarea id="message-${entry.id}" name="message" rows="2" maxlength="1000" placeholder="z.B. Warum wurde Teilaufgabe 3 mit 0 Punkten bewertet?" required></textarea>
          <div class="return-message-meta-row">
            <small class="return-message-counter" data-counter>0 / 1000</small>
          </div>
          <div class="return-message-actions">
            <button class="btn small" type="submit" data-send-button>Nachricht senden</button>
            <small class="return-message-feedback" data-feedback></small>
          </div>
        `;
        const textarea = form.querySelector("textarea[name='message']");
        const counterEl = form.querySelector("[data-counter]");
        const sendButton = form.querySelector("[data-send-button]");

        const updateCounter = () => {
          if (!counterEl || !textarea) return;
          const used = textarea.value.trim().length;
          counterEl.textContent = `${used} / 1000`;
          counterEl.classList.toggle("is-limit", used > 900);
        };

        textarea?.addEventListener("input", updateCounter);
        updateCounter();

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const feedbackEl = form.querySelector("[data-feedback]");
          const gradeId = form.getAttribute("data-grade-id");
          const message = textarea ? textarea.value.trim() : "";
          if (!message) {
            if (feedbackEl) feedbackEl.textContent = "Bitte Nachricht eingeben.";
            return;
          }

          if (feedbackEl) feedbackEl.textContent = "";
          if (sendButton) {
            sendButton.disabled = true;
            sendButton.textContent = "Sende...";
          }

          const headers = { "Content-Type": "application/json" };
          if (csrfToken) headers["X-CSRF-Token"] = csrfToken;

          try {
            const response = await fetch(`/student/returns/${gradeId}/message`, {
              method: "POST",
              headers,
              body: JSON.stringify({ message })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              if (feedbackEl) {
                feedbackEl.textContent =
                  payload.error || "Nachricht konnte nicht gesendet werden.";
              }
              return;
            }
            if (textarea) textarea.value = "";
            updateCounter();
            if (feedbackEl) feedbackEl.textContent = "Nachricht gesendet.";
            state.openReturnDetails.add(entryKey);
            await loadReturnsFromServer();
          } catch (err) {
            if (feedbackEl) feedbackEl.textContent = "Serverfehler beim Senden.";
          } finally {
            if (sendButton) {
              sendButton.disabled = false;
              sendButton.textContent = "Nachricht senden";
            }
          }
        });
        details.appendChild(form);
      }

      details.addEventListener("toggle", async () => {
        if (details.open) {
          state.openReturnDetails.add(entryKey);
        } else {
          state.openReturnDetails.delete(entryKey);
        }
        if (!details.open || !hasUnreadTeacherReplies(entry)) return;
        try {
          await markReturnRepliesSeen(entry.id);
          entry.messages = entry.messages.map((message) =>
            message.teacher_reply && !message.teacher_reply_seen_at
              ? { ...message, teacher_reply_seen_at: new Date().toISOString() }
              : message
          );
          renderReturns();
          renderRequests();
          renderOverview();
        } catch (err) {
          console.error("Konnte Antworten nicht als gesehen markieren:", err);
        }
      });

      body.appendChild(details);
    });
  }

  function renderReturns() {
    const container = document.getElementById("return-list");
    if (!container) return;

    if (!state.returns.length) {
      setCount("return-count", 0);
      container.innerHTML = '<p class="empty-state">Keine Rückgaben vorhanden.</p>';
      return;
    }

    const subject = document.getElementById("return-filter-subject")?.value || "";
    const query = document.getElementById("return-filter-query")?.value || "";
    const filtered = state.returns.filter(
      (entry) =>
        matchesSubject(entry, subject) &&
        matchesQuery(entry, query, ["title", "note", "subject", "category"])
    );

    setCount("return-count", filtered.length);

    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine Rückgaben gefunden.</p>';
      return;
    }

    const ordered = [...filtered].sort(
      (a, b) => dateSortValue(b.graded_at, 0) - dateSortValue(a.graded_at, 0)
    );

    container.innerHTML = ordered
      .map((entry) => {
        const stats = getReturnMessageStats(entry);
        const status = getReturnStatus(stats);
        const downloadUrl = entry.attachment_download_url
          ? escapeHtml(entry.attachment_download_url)
          : "";
        const externalLink = entry.external_link ? escapeHtml(entry.external_link) : "";
        const attachmentName = entry.attachment_name ? escapeHtml(entry.attachment_name) : "Datei";
        const attachmentHtml = externalLink
          ? `<div class="return-actions"><a class="btn small secondary" href="${externalLink}" target="_blank" rel="noopener noreferrer">Link öffnen</a></div>`
          : downloadUrl
            ? `<div class="return-actions"><a class="btn small secondary" href="${downloadUrl}">Datei herunterladen</a><small>${attachmentName}</small></div>`
            : "";
        const requestActionHtml = entry.can_message
          ? `<div class="return-actions"><a class="btn small" href="/student/requests?gradeId=${encodeURIComponent(String(entry.id))}">${stats.closedAt ? "Neue Anfrage starten" : stats.totalCount > 0 ? "Anfragen ansehen" : "Anfrage erstellen"}</a></div>`
          : "";

        return `
          <article class="return-row dataset-row">
            <div class="row-main">
              ${buildRowHead(entry.title, entry.subject, entry.category)}
              ${buildMetaLine([
                `Rückgabe: ${formatDate(entry.graded_at, true)}`,
                `Gewichtung: ${formatWeight(entry.weight)}`
              ])}
              <div class="return-insights">
                <span class="return-status-pill ${status.className}">${status.label}</span>
                <span>${stats.totalCount} Nachricht${stats.totalCount === 1 ? "" : "en"}</span>
                <span>Letzte Aktivität: ${
                  stats.lastActivityAt ? formatDate(stats.lastActivityAt, true) : "Noch keine Rückfragen"
                }</span>
                ${stats.closedAt ? `<span>Geschlossen: ${formatDate(stats.closedAt, true)}</span>` : ""}
              </div>
              ${entry.note ? `<div class="nav-note">${escapeHtml(entry.note)}</div>` : ""}
              ${attachmentHtml}
              ${requestActionHtml}
            </div>
            <div class="row-side return-grade">
              <span class="grade-pill ${gradeColor(entry.grade)}">Note ${formatGradeValue(entry.grade)}</span>
            </div>
          </article>
        `;
      })
      .join("");

    decorateReturnRows(ordered, container);
  }

  function renderRequests() {
    const container = document.getElementById("request-list");
    if (!container) return;
    container.classList.add("request-list");

    const sourceEntries = state.returns.filter((entry) => {
      const hasMessages = Array.isArray(entry.messages) && entry.messages.length > 0;
      const isClosed = Boolean(getThreadClosedAt(entry));
      if (hasMessages && !isClosed) return true;
      return Boolean(requestFocusGradeId) &&
        String(entry.id) === String(requestFocusGradeId) &&
        entry.can_message;
    });

    if (!sourceEntries.length) {
      setCount("request-count", 0);
      container.innerHTML =
        '<p class="empty-state">Noch keine Tickets vorhanden. Neue Anfragen startest du direkt bei der jeweiligen Rückgabe.</p>';
      return;
    }

    const selectedGradeId = syncRequestGradeFilterOptions(sourceEntries);
    const query = document.getElementById("request-filter-query")?.value || "";
    const filtered = sourceEntries.filter((entry) => {
      if (selectedGradeId && String(entry.id) !== String(selectedGradeId)) return false;
      if (!query) return true;
      const messageText = (entry.messages || [])
        .map((message) => `${message.student_message || ""} ${message.teacher_reply || ""}`)
        .join(" ");
      return matchesQuery(
        { ...entry, messageText },
        query,
        ["title", "note", "subject", "category", "messageText"]
      );
    });

    setCount("request-count", filtered.length);

    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine Anfragen zu den Filtern gefunden.</p>';
      return;
    }

    const ordered = [...filtered]
      .map((entry) => {
        const stats = getReturnMessageStats(entry);
        const gradedTs = dateSortValue(entry.graded_at, 0);
        const activityTs = dateSortValue(stats.lastActivityAt, 0);
        return {
          entry,
          stats,
          sortTs: Math.max(gradedTs, activityTs)
        };
      })
      .sort((a, b) => {
        if (a.stats.unreadReplyCount !== b.stats.unreadReplyCount) {
          return b.stats.unreadReplyCount - a.stats.unreadReplyCount;
        }
        if (a.stats.unansweredCount !== b.stats.unansweredCount) {
          return b.stats.unansweredCount - a.stats.unansweredCount;
        }
        return b.sortTs - a.sortTs;
      })
      .map((item) => item.entry);

    container.innerHTML = ordered
      .map((entry) => {
        const stats = getReturnMessageStats(entry);
        const status = getReturnStatus(stats);
        const deleteButtonHtml =
          Array.isArray(entry.messages) && entry.messages.length > 0 && !stats.closedAt
            ? `<button class="btn small secondary request-delete-button" type="button" data-request-delete="${String(entry.id)}">Anfrage schließen</button>`
            : "";
        return `
          <article class="request-card request-row" data-grade-id="${String(entry.id)}">
            <div class="request-card-body">
              <header class="request-card-header">
                <div class="row-main">
                  ${buildRowHead(entry.title, entry.subject, entry.category)}
                  ${buildMetaLine([
                    `Rückgabe: ${formatDate(entry.graded_at, true)}`,
                    `Gewichtung: ${formatWeight(entry.weight)}`
                  ])}
                </div>
                <div class="return-grade">
                  <span class="grade-pill ${gradeColor(entry.grade)}">Note ${formatGradeValue(entry.grade)}</span>
                </div>
              </header>

              <div class="return-insights">
                <span class="return-status-pill ${status.className}">${status.label}</span>
                <span>${stats.totalCount} Nachricht${stats.totalCount === 1 ? "" : "en"}</span>
                <span>Letzte Aktivität: ${
                  stats.lastActivityAt ? formatDate(stats.lastActivityAt, true) : "Noch keine Rückfragen"
                }</span>
              </div>
              ${entry.note ? `<div class="nav-note request-note">${escapeHtml(entry.note)}</div>` : ""}
              ${deleteButtonHtml ? `<div class="request-actions">${deleteButtonHtml}</div>` : ""}
            </div>
          </article>
        `;
      })
      .join("");

    decorateReturnRows(ordered, container);

    container.querySelectorAll("[data-request-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const gradeId = button.getAttribute("data-request-delete");
        if (!gradeId) return;
        button.setAttribute("disabled", "disabled");
        try {
          await hideRequestThread(gradeId);
          state.openReturnDetails.delete(String(gradeId));
          requestFocusGradeId = null;
          await loadReturnsFromServer();
        } catch (err) {
          console.error(err);
          window.alert(err.message || "Ticket konnte nicht gelöscht werden.");
          button.removeAttribute("disabled");
        }
      });
    });

    if (requestFocusGradeId) {
      const focusRow = container.querySelector(
        `[data-grade-id="${String(requestFocusGradeId)}"]`
      );
      if (focusRow) {
        focusRow.classList.add("request-row-focus");
        focusRow.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      requestFocusGradeId = null;
    }
  }

  async function refreshGrades(skipRequest = false) {
    if (!skipRequest) {
      try {
        const response = await fetch("/student/grades?format=json");
        const data = await response.json();
        state.allGrades = (data.grades || []).map(normalizeGrade);
      } catch (err) {
        console.error("Konnte Noten nicht aktualisieren:", err);
      }
    }
    const baseGrades = getBaseFilteredGrades();
    syncGradeSubjectSelection(baseGrades);
    state.grades = getVisibleGrades(baseGrades);
    state.averages = computeAveragesClient(state.grades);
    renderGrades();
    renderAverages();
    renderOverview();
  }

  function scheduleGradeRefresh() {
    window.clearTimeout(gradeRefreshTimer);
    gradeRefreshTimer = window.setTimeout(() => {
      refreshGrades();
    }, 160);
  }

  async function loadClassComparison() {
    try {
      const response = await fetch("/student/class-averages?format=json");
      const data = await response.json();
      state.classAverages = data.subjects || [];
      renderClassAverage();
      if (needsGrades) {
        renderGrades();
        renderAverages();
      }
      if (needsGradeOverview && !needsGrades) {
        renderGradeSubjectOverview();
      }
    } catch (err) {
      console.error("Konnte Klassenvergleich nicht laden:", err);
    }
  }

  async function loadTasksFromServer() {
    try {
      const response = await fetch("/student/tasks?format=json");
      const data = await response.json();
      state.tasks = (data.tasks || []).map(normalizeTask);
      renderTasks();
      renderOverview();
    } catch (err) {
      console.error("Konnte Aufgaben nicht laden:", err);
    }
  }

  async function loadArchiveFromServer() {
    try {
      const response = await fetch("/student/archive?format=json");
      const data = await response.json();
      state.archivedTasks = (data.tasks || []).map(normalizeTask);
      renderArchive();
    } catch (err) {
      console.error("Konnte Archiv nicht laden:", err);
    }
  }

  async function loadReturnsFromServer() {
    try {
      const response = await fetch("/student/returns?format=json");
      const data = await response.json();
      state.returns = (data.returns || []).map(normalizeReturn);
      renderReturns();
      renderRequests();
      renderOverview();
    } catch (err) {
      console.error("Konnte Rückgaben nicht laden:", err);
    }
  }

  async function loadNotificationsFromServer() {
    try {
      const response = await fetch("/student/notifications?format=json");
      const data = await response.json();
      state.notifications = data.notifications || [];
      renderNotifications();
    } catch (err) {
      console.error("Konnte Benachrichtigungen nicht laden:", err);
    }
  }

  document.getElementById("grade-filter")?.addEventListener("change", () => refreshGrades());
  document.getElementById("grade-filter")?.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") {
      scheduleGradeRefresh();
    }
  });

  document.getElementById("task-filter")?.addEventListener("input", () => renderTasks());
  document.getElementById("task-filter")?.addEventListener("change", () => renderTasks());
  document.getElementById("return-filter")?.addEventListener("input", () => renderReturns());
  document.getElementById("return-filter")?.addEventListener("change", () => renderReturns());
  document.getElementById("request-filter")?.addEventListener("input", () => renderRequests());
  document.getElementById("request-filter")?.addEventListener("change", () => renderRequests());
  document.getElementById("archive-filter")?.addEventListener("input", () => renderArchive());
  document.getElementById("archive-filter")?.addEventListener("change", () => renderArchive());

  if (needsGradeOverview && !needsGrades) {
    renderGradeSubjectOverview();
  }

  if (needsGrades || needsOverview) {
    renderGrades();
    renderAverages();
    refreshGrades();
  }

  if (needsTasks || needsOverview) {
    renderTasks();
    loadTasksFromServer();
  }

  if (needsArchive) {
    renderArchive();
    loadArchiveFromServer();
  }

  if (needsReturns || needsRequests || needsOverview) {
    renderReturns();
    renderRequests();
    loadReturnsFromServer();
  }

  if (needsClassAverages || needsGrades || needsGradeOverview) {
    renderClassAverage();
    loadClassComparison();
  }

  if (needsNotifications) {
    renderNotifications();
    loadNotificationsFromServer();
  }

  if (needsOverview) {
    renderOverview();
  }
})();
