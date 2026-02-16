(() => {
  const initialDataEl = document.getElementById("student-initial-data");
  let initialData = {};

  if (initialDataEl && initialDataEl.textContent) {
    try {
      initialData = JSON.parse(initialDataEl.textContent);
    } catch (err) {
      console.error("Konnte initiale Studentendaten nicht laden:", err);
    }
  }

  const csrfToken = initialData.csrfToken;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeGrade(grade) {
    return { ...grade, value: Number(grade.value), weight: Number(grade.weight || 1) };
  }

  function normalizeTask(task) {
    return {
      ...task,
      weight: Number(task.weight || 0),
      grade: task.grade == null ? null : Number(task.grade),
      graded: Boolean(task.graded)
    };
  }

  function normalizeReturn(entry) {
    return {
      ...entry,
      weight: Number(entry.weight || 0),
      grade: Number(entry.grade),
      attachment_download_url: entry.attachment_download_url || null,
      attachment_name: entry.attachment_name || null,
      external_link: entry.external_link || null
    };
  }

  const state = {
    grades: (initialData.grades || []).map(normalizeGrade),
    averages: initialData.averages || { subjects: [], overall: null },
    classAverages: initialData.classAverages || [],
    notifications: initialData.notifications || [],
    trend: initialData.trend || { direction: "steady", change: 0 },
    tasks: (initialData.tasks || []).map(normalizeTask),
    returns: (initialData.returns || []).map(normalizeReturn)
  };

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      setActiveTab(tab.dataset.tab);
    });
  });

  document.querySelectorAll("[data-tab-target]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = link.getAttribute("data-tab-target");
      if (target) {
        event.preventDefault();
        setActiveTab(target);
        document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  function setActiveTab(name) {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    document.querySelectorAll(".tab-content").forEach((content) => {
      content.classList.toggle("active", content.id === name);
    });
    document.querySelectorAll("[data-tab-target]").forEach((link) => {
      const isActive = link.getAttribute("data-tab-target") === name;
      link.classList.toggle("is-active", isActive);
    });
  }

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

  function getTaskStatus(task) {
    if (task.graded) {
      return { label: "Benotet", className: "graded" };
    }
    const due = task.due_at ? new Date(task.due_at) : null;
    if (due && !Number.isNaN(due.getTime()) && due < new Date()) {
      return { label: "Ueberfaellig", className: "overdue" };
    }
    return { label: "Offen", className: "open" };
  }

  function computeAveragesClient(grades) {
    const subjectMap = new Map();
    grades.forEach((grade) => {
      const bucket = subjectMap.get(grade.subject) || { weightedSum: 0, weightTotal: 0 };
      bucket.weightedSum += grade.value * (grade.weight || 1);
      bucket.weightTotal += grade.weight || 1;
      subjectMap.set(grade.subject, bucket);
    });
    const subjects = Array.from(subjectMap.entries()).map(([subject, info]) => ({
      subject,
      average: info.weightTotal ? Number((info.weightedSum / info.weightTotal).toFixed(2)) : null
    }));
    const total = subjects.reduce(
      (acc, subject) => {
        if (subject.average == null) return acc;
        const weight = subjectMap.get(subject.subject).weightTotal;
        return {
          weightedSum: acc.weightedSum + subject.average * weight,
          weightTotal: acc.weightTotal + weight
        };
      },
      { weightedSum: 0, weightTotal: 0 }
    );
    return {
      subjects,
      overall: total.weightTotal ? Number((total.weightedSum / total.weightTotal).toFixed(2)) : null
    };
  }

  function renderGrades() {
    const container = document.getElementById("grade-list");
    if (!container) return;
    if (!state.grades.length) {
      container.innerHTML = '<p class="empty-state">Keine Noten vorhanden.</p>';
      return;
    }

    const items = state.grades.map((grade) => {
      const dateValue = grade.graded_at ? new Date(grade.graded_at) : null;
      const dateText =
        dateValue && !Number.isNaN(dateValue.getTime()) ? dateValue.toLocaleDateString() : "-";
      const valueText = Number.isFinite(grade.value) ? grade.value.toFixed(2) : "-";
      const weightText = Number.isFinite(grade.weight) ? grade.weight : "-";
      const subjectText = escapeHtml(grade.subject || "Fach");
      const teacherText = escapeHtml(grade.teacher || "Lehrkraft unbekannt");
      const commentText = escapeHtml(grade.comment || "");

      return `
        <div class="grade-row">
          <div>
            <div><strong>${subjectText}</strong> &middot; <small>${dateText}</small></div>
            <small>${teacherText}</small>
            ${commentText ? `<div class="nav-note">${commentText}</div>` : ""}
          </div>
          <div class="grade-value">${valueText}</div>
          <div><span class="grade-pill ${gradeColor(grade.value)}">Gewichtung ${weightText}</span></div>
          <div style="text-align:right;"><span class="grade-pill">${subjectText}</span></div>
        </div>
      `;
    });
    container.innerHTML = items.join("");
  }

  function renderAverages() {
    const overallEl = document.getElementById("avg-overall");
    if (overallEl) {
      overallEl.textContent = state.averages.overall ?? "-";
    }

    const trend = state.trend || { direction: "steady", change: 0 };
    const trendEl = document.getElementById("avg-trend");
    if (trendEl) {
      const icon =
        trend.direction === "improving" ? "↑" : trend.direction === "declining" ? "↓" : "→";
      trendEl.textContent = `${icon} ${trend.change ?? 0}`;
    }

    const updatedEl = document.getElementById("avg-updated");
    if (updatedEl) {
      if (!state.grades.length) {
        updatedEl.textContent = "-";
      } else {
        const latest = [...state.grades].sort(
          (a, b) => new Date(b.graded_at) - new Date(a.graded_at)
        )[0];
        updatedEl.textContent = latest?.graded_at
          ? new Date(latest.graded_at).toLocaleString()
          : "-";
      }
    }
  }

  function renderOverview() {
    const averageEl = document.getElementById("overview-average");
    if (averageEl) {
      averageEl.textContent = state.averages.overall ?? "-";
    }

    const openTasksEl = document.getElementById("overview-open-tasks");
    if (openTasksEl) {
      openTasksEl.textContent = state.tasks.filter((task) => !task.graded).length;
    }

    const returnsEl = document.getElementById("overview-return-count");
    if (returnsEl) {
      returnsEl.textContent = state.returns.length;
    }

    const upcomingEl = document.getElementById("overview-upcoming");
    if (upcomingEl) {
      const upcoming = state.tasks
        .filter((task) => !task.graded && task.due_at)
        .sort((a, b) => {
          const aTime = dateSortValue(a.due_at, Number.POSITIVE_INFINITY);
          const bTime = dateSortValue(b.due_at, Number.POSITIVE_INFINITY);
          return aTime - bTime;
        })
        .slice(0, 3);

      if (!upcoming.length) {
        upcomingEl.innerHTML = '<p class="empty-state">Keine offenen Aufgaben mit Datum.</p>';
      } else {
        upcomingEl.innerHTML = upcoming
          .map(
            (task) => `
              <div class="overview-row">
                <div>
                  <strong>${escapeHtml(task.title)}</strong>
                  ${task.category ? `<span class="pill">${escapeHtml(task.category)}</span>` : ""}
                </div>
                <small>${formatDate(task.due_at)}</small>
              </div>
            `
          )
          .join("");
      }
    }

    const recentEl = document.getElementById("overview-recent-returns");
    if (recentEl) {
      const recent = [...state.returns]
        .sort((a, b) => {
          const aTime = dateSortValue(a.graded_at, 0);
          const bTime = dateSortValue(b.graded_at, 0);
          return bTime - aTime;
        })
        .slice(0, 3);

      if (!recent.length) {
        recentEl.innerHTML = '<p class="empty-state">Noch keine Rueckgaben vorhanden.</p>';
      } else {
        recentEl.innerHTML = recent
          .map((entry) => {
            const gradeText = Number.isFinite(entry.grade) ? entry.grade.toFixed(2) : "-";
            return `
              <div class="overview-row">
                <div>
                  <strong>${escapeHtml(entry.title)}</strong>
                  ${entry.category ? `<span class="pill">${escapeHtml(entry.category)}</span>` : ""}
                </div>
                <span class="grade-pill ${gradeColor(entry.grade)}">Note ${gradeText}</span>
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
            <div style="width:120px;font-weight:600;">${escapeHtml(item.subject)}</div>
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
    if (!state.notifications.length) {
      container.innerHTML = '<p class="empty-state">Keine neuen Benachrichtigungen.</p>';
      return;
    }

    container.innerHTML = state.notifications
      .map(
        (note) => `
        <div class="notification ${note.read_at ? "" : "unread"}">
          <strong>${note.type === "average" ? "Durchschnitt" : "Neue Note"}</strong>
          <p style="margin:4px 0;">${escapeHtml(note.message)}</p>
          <small>${new Date(note.created_at).toLocaleString()}</small>
          ${
            note.read_at
              ? ""
              : `<button class="btn small secondary" data-note-id="${note.id}">Als gelesen markieren</button>`
          }
        </div>
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
      container.innerHTML = '<p class="empty-state">Keine Aufgaben vorhanden.</p>';
      return;
    }

    const subject = document.getElementById("task-filter-subject")?.value || "";
    const query = document.getElementById("task-filter-query")?.value || "";
    const filtered = state.tasks.filter(
      (task) =>
        matchesSubject(task, subject) && matchesQuery(task, query, ["title", "description"])
    );
    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine Aufgaben gefunden.</p>';
      return;
    }

    const ordered = [...filtered].sort((a, b) => {
      const aTime = dateSortValue(a.due_at, Number.POSITIVE_INFINITY);
      const bTime = dateSortValue(b.due_at, Number.POSITIVE_INFINITY);
      if (aTime !== bTime) return aTime - bTime;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });

    container.innerHTML = ordered
      .map((task) => {
        const status = getTaskStatus(task);
        const dueText = formatDate(task.due_at);
        const weightText = Number.isFinite(task.weight) && task.weight ? `${task.weight}%` : "-";
        const gradeText = Number.isFinite(task.grade) ? task.grade.toFixed(2) : "-";
        return `
          <div class="task-row">
            <div>
              <div class="task-title">
                <strong>${escapeHtml(task.title)}</strong>
                ${task.category ? `<span class="pill">${escapeHtml(task.category)}</span>` : ""}
              </div>
              <div class="task-meta">
                <span>Datum: ${dueText}</span>
                <span>Gewichtung: ${weightText}</span>
              </div>
              ${task.description ? `<div class="nav-note">${escapeHtml(task.description)}</div>` : ""}
            </div>
            <div class="task-status">
              <span class="status-pill ${status.className}">${status.label}</span>
              ${task.graded ? `<small>Note ${gradeText}</small>` : ""}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderReturns() {
    const container = document.getElementById("return-list");
    if (!container) return;
    if (!state.returns.length) {
      container.innerHTML = '<p class="empty-state">Keine Rueckgaben vorhanden.</p>';
      return;
    }

    const subject = document.getElementById("return-filter-subject")?.value || "";
    const query = document.getElementById("return-filter-query")?.value || "";
    const filtered = state.returns.filter(
      (entry) => matchesSubject(entry, subject) && matchesQuery(entry, query, ["title", "note"])
    );
    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine Rueckgaben gefunden.</p>';
      return;
    }

    const ordered = [...filtered].sort((a, b) => {
      const aTime = dateSortValue(a.graded_at, 0);
      const bTime = dateSortValue(b.graded_at, 0);
      return bTime - aTime;
    });

    container.innerHTML = ordered
      .map((entry) => {
        const gradeText = Number.isFinite(entry.grade) ? entry.grade.toFixed(2) : "-";
        const returnText = formatDate(entry.graded_at, true);
        const weightText =
          Number.isFinite(entry.weight) && entry.weight ? `${entry.weight}%` : "-";
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
        return `
          <div class="return-row">
            <div>
              <div class="task-title">
                <strong>${escapeHtml(entry.title)}</strong>
                ${entry.category ? `<span class="pill">${escapeHtml(entry.category)}</span>` : ""}
              </div>
              <div class="task-meta">
                <span>Rueckgabe: ${returnText}</span>
                <span>Gewichtung: ${weightText}</span>
              </div>
              ${entry.note ? `<div class="nav-note">${escapeHtml(entry.note)}</div>` : ""}
              ${attachmentHtml}
            </div>
            <div class="return-grade">
              <span class="grade-pill ${gradeColor(entry.grade)}">Note ${gradeText}</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  async function refreshGrades(skipRequest = false) {
    const form = document.getElementById("grade-filter");
    const params = form ? new URLSearchParams(new FormData(form)).toString() : "";
    if (!skipRequest) {
      try {
        const response = await fetch(`/student/grades?${params}`);
        const data = await response.json();
        state.grades = (data.grades || []).map(normalizeGrade);
        state.averages = computeAveragesClient(state.grades);
      } catch (err) {
        console.error("Konnte Noten nicht aktualisieren:", err);
      }
    }
    renderGrades();
    renderAverages();
    renderOverview();
  }

  async function loadClassComparison() {
    try {
      const response = await fetch("/student/class-averages");
      const data = await response.json();
      state.classAverages = data.subjects || [];
      renderClassAverage();
    } catch (err) {
      console.error("Konnte Klassenvergleich nicht laden:", err);
    }
  }

  async function loadTasksFromServer() {
    try {
      const response = await fetch("/student/tasks");
      const data = await response.json();
      state.tasks = (data.tasks || []).map(normalizeTask);
      renderTasks();
      renderOverview();
    } catch (err) {
      console.error("Konnte Aufgaben nicht laden:", err);
    }
  }

  async function loadReturnsFromServer() {
    try {
      const response = await fetch("/student/returns");
      const data = await response.json();
      state.returns = (data.returns || []).map(normalizeReturn);
      renderReturns();
      renderOverview();
    } catch (err) {
      console.error("Konnte Rueckgaben nicht laden:", err);
    }
  }

  async function loadNotificationsFromServer() {
    try {
      const response = await fetch("/student/notifications");
      const data = await response.json();
      state.notifications = data.notifications || [];
      renderNotifications();
    } catch (err) {
      console.error("Konnte Benachrichtigungen nicht laden:", err);
    }
  }

  document
    .getElementById("grade-filter")
    ?.addEventListener("change", () => refreshGrades());
  document
    .getElementById("task-filter")
    ?.addEventListener("input", () => renderTasks());
  document
    .getElementById("task-filter")
    ?.addEventListener("change", () => renderTasks());
  document
    .getElementById("return-filter")
    ?.addEventListener("input", () => renderReturns());
  document
    .getElementById("return-filter")
    ?.addEventListener("change", () => renderReturns());

  renderGrades();
  renderAverages();
  renderClassAverage();
  renderNotifications();
  renderTasks();
  renderReturns();
  renderOverview();

  refreshGrades();
  loadClassComparison();
  loadTasksFromServer();
  loadReturnsFromServer();
  loadNotificationsFromServer();
})();
