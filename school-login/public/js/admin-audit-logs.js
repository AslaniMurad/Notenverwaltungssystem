(function () {
  const tbody = document.getElementById("audit-log-table-body");
  const sentinel = document.getElementById("audit-logs-sentinel");
  const table = document.getElementById("audit-log-table");
  const countBadge = document.getElementById("audit-log-count");

  if (!tbody || !sentinel || !table) return;

  const query = new URLSearchParams(window.location.search);
  const knownIds = new Set();
  let totalCount = Number(countBadge?.dataset.totalCount);
  let newestId = null;
  let oldestId = null;
  let loadingOlder = false;
  let hasMoreOlder = true;

  if (!Number.isFinite(totalCount)) totalCount = 0;

  function readExistingRows() {
    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.forEach((row) => {
      const id = Number(row.dataset.logId);
      if (!Number.isFinite(id)) return;
      knownIds.add(id);
      if (newestId == null || id > newestId) newestId = id;
      if (oldestId == null || id < oldestId) oldestId = id;
    });
    if (!totalCount) totalCount = knownIds.size;
    updateCountBadge();
  }

  function buildDescription(log) {
    return log.action || "-";
  }

  function updateCountBadge() {
    if (!countBadge) return;
    countBadge.dataset.totalCount = String(totalCount);
    countBadge.textContent = `${totalCount} Eintraege`;
  }

  function createCell(text) {
    const td = document.createElement("td");
    td.textContent = text == null || text === "" ? "-" : String(text);
    return td;
  }

  function createRow(log) {
    const tr = document.createElement("tr");
    tr.dataset.logId = String(log.id);
    tr.appendChild(createCell(log.created_at));
    tr.appendChild(createCell(log.actor_email));
    tr.appendChild(createCell(buildDescription(log)));
    return tr;
  }

  function clearEmptyPlaceholder() {
    const onlyRow = tbody.querySelector("tr");
    if (!onlyRow) return;
    if (tbody.querySelectorAll("tr").length !== 1) return;
    if (!onlyRow.textContent.includes("Keine Audit-Eintraege")) return;
    tbody.innerHTML = "";
  }

  async function fetchLogs(extraParams) {
    const params = new URLSearchParams(query);
    Object.entries(extraParams || {}).forEach(([key, value]) => {
      if (value == null || value === "") return;
      params.set(key, String(value));
    });
    const response = await fetch(`/admin/audit-logs/data?${params.toString()}`, {
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (Number.isFinite(Number(data.totalCount))) {
      totalCount = Number(data.totalCount);
      updateCountBadge();
    }
    return data;
  }

  function appendOlderLogs(logs) {
    const fresh = logs.filter((log) => {
      const id = Number(log.id);
      if (!Number.isFinite(id) || knownIds.has(id)) return false;
      knownIds.add(id);
      return true;
    });
    if (!fresh.length) return;
    clearEmptyPlaceholder();
    const fragment = document.createDocumentFragment();
    fresh.forEach((log) => {
      fragment.appendChild(createRow(log));
      const id = Number(log.id);
      if (newestId == null || id > newestId) newestId = id;
      if (oldestId == null || id < oldestId) oldestId = id;
    });
    tbody.appendChild(fragment);
    if (knownIds.size > totalCount) {
      totalCount = knownIds.size;
      updateCountBadge();
    }
  }

  function prependNewLogs(logs) {
    const fresh = logs.filter((log) => {
      const id = Number(log.id);
      if (!Number.isFinite(id) || knownIds.has(id)) return false;
      knownIds.add(id);
      return true;
    });
    if (!fresh.length) return;
    clearEmptyPlaceholder();
    const fragment = document.createDocumentFragment();
    fresh.forEach((log) => {
      fragment.appendChild(createRow(log));
      const id = Number(log.id);
      if (newestId == null || id > newestId) newestId = id;
      if (oldestId == null || id < oldestId) oldestId = id;
    });
    tbody.prepend(fragment);
    if (knownIds.size > totalCount) {
      totalCount = knownIds.size;
      updateCountBadge();
    }
  }

  async function loadOlder() {
    if (loadingOlder || !hasMoreOlder || oldestId == null) return;
    loadingOlder = true;
    try {
      const data = await fetchLogs({ beforeId: oldestId, limit: 100 });
      appendOlderLogs(data.logs || []);
      hasMoreOlder = Boolean(data.hasMore);
      if (!hasMoreOlder) {
        sentinel.textContent = "Alle vorhandenen Eintraege wurden geladen.";
      }
    } catch (err) {
      sentinel.textContent = "Fehler beim Nachladen der Logs.";
      console.error(err);
    } finally {
      loadingOlder = false;
    }
  }

  async function pollNewLogs() {
    try {
      const data = newestId == null
        ? await fetchLogs({ limit: 100 })
        : await fetchLogs({ afterId: newestId, limit: 100 });
      prependNewLogs(data.logs || []);
    } catch (err) {
      console.error("Audit log live polling failed:", err);
    }
  }

  readExistingRows();

  const observer = new IntersectionObserver(
    (entries) => {
      const first = entries[0];
      if (first && first.isIntersecting) {
        loadOlder();
      }
    },
    { rootMargin: "300px 0px" }
  );
  observer.observe(sentinel);

  window.setInterval(pollNewLogs, 3000);
})();
