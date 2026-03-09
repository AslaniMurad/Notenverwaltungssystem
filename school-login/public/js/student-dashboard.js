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
      external_link: entry.external_link || null,
      can_message: Boolean(entry.can_message),
      messages: Array.isArray(entry.messages)
        ? entry.messages.map((message) => ({
            id: message.id,
            student_message: message.student_message || "",
            teacher_reply: message.teacher_reply || null,
            teacher_reply_seen_at: message.teacher_reply_seen_at || null,
            created_at: message.created_at || null,
            replied_at: message.replied_at || null
          }))
        : []
    };
  }

  const state = {
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
    document.getElementById("overview-recent-returns")
  );
  const needsTasks = Boolean(document.getElementById("task-list"));
  const needsArchive = Boolean(document.getElementById("archive-list"));
  const needsReturns = Boolean(document.getElementById("return-list"));
  const needsRequests = Boolean(document.getElementById("request-list"));
  const needsGrades = Boolean(document.getElementById("grade-list"));
  const needsClassAverages = Boolean(document.getElementById("class-average"));
  const needsNotifications = Boolean(document.getElementById("notification-list"));
  let requestFocusGradeId = new URLSearchParams(window.location.search).get("gradeId");

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

  function getReturnMessageStats(entry) {
    const messages = Array.isArray(entry?.messages) ? entry.messages : [];
    let unansweredCount = 0;
    let unreadReplyCount = 0;
    let lastActivityTs = 0;

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

    return {
      totalCount: messages.length,
      unansweredCount,
      unreadReplyCount,
      lastActivityAt: lastActivityTs ? new Date(lastActivityTs).toISOString() : null
    };
  }

  function getReturnStatus(stats) {
    if (stats.unreadReplyCount > 0) {
      return { label: "Neue Antwort", className: "new" };
    }
    if (stats.unansweredCount > 0) {
      return { label: "Antwort ausstehend", className: "pending" };
    }
    if (stats.totalCount > 0) {
      return { label: "Beantwortet", className: "answered" };
    }
    return { label: "Noch keine Rueckfrage", className: "idle" };
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
        recentEl.innerHTML = '<p class="empty-state">Noch keine Rückgaben vorhanden.</p>';
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
      container.innerHTML = '<p class="empty-state">Keine aktiven Pruefungen vorhanden.</p>';
      return;
    }

    const subject = document.getElementById("task-filter-subject")?.value || "";
    const query = document.getElementById("task-filter-query")?.value || "";
    const filtered = state.tasks.filter(
      (task) =>
        matchesSubject(task, subject) && matchesQuery(task, query, ["title", "description"])
    );
    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine aktiven Pruefungen gefunden.</p>';
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

  function renderArchive() {
    const container = document.getElementById("archive-list");
    if (!container) return;

    if (!state.archivedTasks.length) {
      container.innerHTML = '<p class="empty-state">Keine archivierten Pruefungen vorhanden.</p>';
      return;
    }

    const subject = document.getElementById("archive-filter-subject")?.value || "";
    const query = document.getElementById("archive-filter-query")?.value || "";
    const filtered = state.archivedTasks.filter(
      (task) =>
        matchesSubject(task, subject) && matchesQuery(task, query, ["title", "description"])
    );
    if (!filtered.length) {
      container.innerHTML = '<p class="empty-state">Keine archivierten Pruefungen gefunden.</p>';
      return;
    }

    const ordered = [...filtered].sort((a, b) => {
      const aTime = dateSortValue(a.due_at, 0);
      const bTime = dateSortValue(b.due_at, 0);
      return bTime - aTime;
    });

    container.innerHTML = ordered
      .map((task) => {
        const dueText = formatDate(task.due_at);
        const weightText = Number.isFinite(task.weight) && task.weight ? `${task.weight}%` : "-";
        const gradeText = Number.isFinite(task.grade) ? task.grade.toFixed(2) : "-";
        const statusLabel = task.graded ? "Benotet" : "Archiviert";
        return `
          <div class="task-row">
            <div>
              <div class="task-title">
                <strong>${escapeHtml(task.title)}</strong>
                ${task.category ? `<span class="pill">${escapeHtml(task.category)}</span>` : ""}
              </div>
              <div class="task-meta">
                <span>Pruefungsdatum: ${dueText}</span>
                <span>Gewichtung: ${weightText}</span>
              </div>
              ${task.description ? `<div class="nav-note">${escapeHtml(task.description)}</div>` : ""}
              ${task.note ? `<div class="nav-note">Kommentar: ${escapeHtml(task.note)}</div>` : ""}
            </div>
            <div class="task-status">
              <span class="status-pill graded">${statusLabel}</span>
              ${task.graded ? `<small>Note ${gradeText}</small>` : ""}
            </div>
          </div>
        `;
      })
      .join("");
  }

  async function markReturnRepliesSeen(gradeId) {
    const headers = csrfToken ? { "X-CSRF-Token": csrfToken } : {};
    await fetch(`/student/returns/${gradeId}/messages/seen`, { method: "POST", headers });
  }

  function syncRequestGradeFilterOptions(entries) {
    const select = document.getElementById("request-filter-grade");
    if (!select) return "";

    const previousValue = String(select.value || "");
    const ordered = [...entries].sort((a, b) => {
      const aTime = dateSortValue(a.graded_at, 0);
      const bTime = dateSortValue(b.graded_at, 0);
      return bTime - aTime;
    });

    const options = ['<option value="">Alle Rueckgaben</option>'];
    ordered.forEach((entry) => {
      options.push(`<option value="${String(entry.id)}">${escapeHtml(entry.title)}</option>`);
    });
    select.innerHTML = options.join("");

    let nextValue = previousValue;
    if (requestFocusGradeId && ordered.some((entry) => String(entry.id) === String(requestFocusGradeId))) {
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
        ? `Letzte Aktivitaet: ${formatDate(stats.lastActivityAt, true)}`
        : "Noch keine Aktivitaet";
      summary.innerHTML = `
        <div class="return-summary-main">
          <span>Rueckfragen</span>
          <span class="return-status-pill ${status.className}">${status.label}</span>
        </div>
        <div class="return-summary-meta">
          <span>${stats.totalCount} Nachricht${stats.totalCount === 1 ? "" : "en"}</span>
          <span>${summaryLastActivity}</span>
          ${stats.unreadReplyCount ? `<span class="badge-inline return-unread-badge">${stats.unreadReplyCount} neu</span>` : ""}
        </div>
      `;
      details.appendChild(summary);

      const thread = document.createElement("div");
      thread.className = "return-message-thread request-ticket-thread";
      thread.innerHTML = entry.messages.length
        ? entry.messages
          .map((message) => {
            const teacherPart = message.teacher_reply
              ? `
                <article class="return-message-row teacher ${message.teacher_reply_seen_at ? "" : "unseen"}">
                  <div class="return-message-head">
                    <strong>Lehrkraft</strong>
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
                  <strong>Du</strong>
                  <span class="ticket-tag student">Anfrage</span>
                  <small>${formatDate(message.created_at, true)}</small>
                </div>
                <p>${escapeHtml(message.student_message)}</p>
              </article>
              ${teacherPart}
            `;
          })
          .join("")
        : '<article class="return-message-row pending"><small>Noch keine Rueckfragen vorhanden.</small></article>';
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
              if (feedbackEl) feedbackEl.textContent = payload.error || "Nachricht konnte nicht gesendet werden.";
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
        const stats = getReturnMessageStats(entry);
        const status = getReturnStatus(stats);
        const gradeText = Number.isFinite(entry.grade) ? entry.grade.toFixed(2) : "-";
        const returnText = formatDate(entry.graded_at, true);
        const activityText = stats.lastActivityAt
          ? formatDate(stats.lastActivityAt, true)
          : "Noch keine Rueckfragen";
        const weightText =
          Number.isFinite(entry.weight) && entry.weight ? `${entry.weight}%` : "-";
        const downloadUrl = entry.attachment_download_url
          ? escapeHtml(entry.attachment_download_url)
          : "";
        const externalLink = entry.external_link ? escapeHtml(entry.external_link) : "";
        const attachmentName = entry.attachment_name ? escapeHtml(entry.attachment_name) : "Datei";
        const attachmentHtml = externalLink
          ? `<div class="return-actions"><a class="btn small secondary" href="${externalLink}" target="_blank" rel="noopener noreferrer">Link oeffnen</a></div>`
          : downloadUrl
            ? `<div class="return-actions"><a class="btn small secondary" href="${downloadUrl}">Datei herunterladen</a><small>${attachmentName}</small></div>`
            : "";
        const requestActionHtml = entry.can_message
          ? `<div class="return-actions"><a class="btn small" href="/student/requests?gradeId=${encodeURIComponent(String(entry.id))}">${stats.totalCount > 0 ? "Anfragen ansehen" : "Anfrage erstellen"}</a></div>`
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
              <div class="return-insights">
                <span class="return-status-pill ${status.className}">${status.label}</span>
                <span>${stats.totalCount} Nachricht${stats.totalCount === 1 ? "" : "en"}</span>
                <span>Letzte Aktivitaet: ${activityText}</span>
              </div>
              ${entry.note ? `<div class="nav-note">${escapeHtml(entry.note)}</div>` : ""}
              ${attachmentHtml}
              ${requestActionHtml}
            </div>
            <div class="return-grade">
              <span class="grade-pill ${gradeColor(entry.grade)}">Note ${gradeText}</span>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function renderRequests() {
    const container = document.getElementById("request-list");
    if (!container) return;
    container.classList.add("request-list");

    const sourceEntries = state.returns.filter(
      (entry) => entry.can_message || (Array.isArray(entry.messages) && entry.messages.length > 0)
    );
    if (!sourceEntries.length) {
      container.innerHTML = '<p class="empty-state">Noch keine moeglichen Anfragen vorhanden.</p>';
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
      return matchesQuery({ ...entry, messageText }, query, ["title", "note", "messageText"]);
    });

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
        const gradeText = Number.isFinite(entry.grade) ? entry.grade.toFixed(2) : "-";
        const returnText = formatDate(entry.graded_at, true);
        const activityText = stats.lastActivityAt
          ? formatDate(stats.lastActivityAt, true)
          : "Noch keine Rueckfragen";
        const weightText = Number.isFinite(entry.weight) && entry.weight ? `${entry.weight}%` : "-";

        return `
          <article class="request-card request-row" data-grade-id="${String(entry.id)}">
            <div class="request-card-body">
              <header class="request-card-header">
                <div>
                  <div class="task-title">
                    <strong>${escapeHtml(entry.title)}</strong>
                    ${entry.category ? `<span class="pill">${escapeHtml(entry.category)}</span>` : ""}
                  </div>
                  <div class="task-meta">
                    <span>Rueckgabe: ${returnText}</span>
                    <span>Gewichtung: ${weightText}</span>
                  </div>
                </div>
                <div class="return-grade">
                  <span class="grade-pill ${gradeColor(entry.grade)}">Note ${gradeText}</span>
                </div>
              </header>

              <div class="return-insights">
                <span class="return-status-pill ${status.className}">${status.label}</span>
                <span>${stats.totalCount} Nachricht${stats.totalCount === 1 ? "" : "en"}</span>
                <span>Letzte Aktivitaet: ${activityText}</span>
              </div>
              ${entry.note ? `<div class="nav-note request-note">${escapeHtml(entry.note)}</div>` : ""}
            </div>
          </article>
        `;
      })
      .join("");

    decorateReturnRows(ordered, container);

    if (requestFocusGradeId) {
      const focusRow = container.querySelector(`[data-grade-id="${String(requestFocusGradeId)}"]`);
      if (focusRow) {
        focusRow.classList.add("request-row-focus");
        focusRow.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      requestFocusGradeId = null;
    }
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

  async function loadArchiveFromServer() {
    try {
      const response = await fetch("/student/archive");
      const data = await response.json();
      state.archivedTasks = (data.tasks || []).map(normalizeTask);
      renderArchive();
    } catch (err) {
      console.error("Konnte Archiv nicht laden:", err);
    }
  }

  async function loadReturnsFromServer() {
    try {
      const response = await fetch("/student/returns");
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
  document
    .getElementById("request-filter")
    ?.addEventListener("input", () => renderRequests());
  document
    .getElementById("request-filter")
    ?.addEventListener("change", () => renderRequests());
  document
    .getElementById("archive-filter")
    ?.addEventListener("input", () => renderArchive());
  document
    .getElementById("archive-filter")
    ?.addEventListener("change", () => renderArchive());

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

  if (needsClassAverages || needsGrades) {
    renderClassAverage();
    loadClassComparison();
  }

  if (needsNotifications || needsGrades) {
    renderNotifications();
    loadNotificationsFromServer();
  }

  if (needsOverview) {
    renderOverview();
  }
})();

