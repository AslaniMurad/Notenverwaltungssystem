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

  function normalizeGrade(grade) {
    return { ...grade, value: Number(grade.value), weight: Number(grade.weight || 1) };
  }

  const state = {
    grades: (initialData.grades || []).map(normalizeGrade),
    averages: initialData.averages || { subjects: [], overall: null },
    classAverages: initialData.classAverages || [],
    notifications: initialData.notifications || [],
    trend: initialData.trend || { direction: "steady", change: 0 }
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
      const subjectText = grade.subject || "Fach";

      return `
        <div class="grade-row">
          <div>
            <div><strong>${subjectText}</strong> &middot; <small>${dateText}</small></div>
            <small>${grade.teacher || "Lehrkraft unbekannt"}</small>
            ${grade.comment ? `<div class="nav-note">${grade.comment}</div>` : ""}
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
            <div style="width:120px;font-weight:600;">${item.subject}</div>
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
          <p style="margin:4px 0;">${note.message}</p>
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

  renderGrades();
  renderAverages();
  renderClassAverage();
  renderNotifications();

  refreshGrades();
  loadClassComparison();
  loadNotificationsFromServer();
})();
