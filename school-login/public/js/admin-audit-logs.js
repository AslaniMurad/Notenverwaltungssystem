(function () {
  const tbody = document.getElementById("audit-log-table-body");
  const sentinel = document.getElementById("audit-logs-sentinel");
  const table = document.getElementById("audit-log-table");

  if (!tbody || !sentinel || !table) return;

  const query = new URLSearchParams(window.location.search);
  const knownIds = new Set();
  let newestId = null;
  let oldestId = null;
  let loadingOlder = false;
  let hasMoreOlder = true;

  function readExistingRows() {
    const rows = Array.from(tbody.querySelectorAll("tr"));
    rows.forEach((row) => {
      const idCell = row.children[5];
      if (!idCell) return;
      const id = Number(idCell.textContent.trim());
      if (!Number.isFinite(id)) return;
      knownIds.add(id);
      if (newestId == null || id > newestId) newestId = id;
      if (oldestId == null || id < oldestId) oldestId = id;
    });
  }

  function buildDescription(log) {
    return log.action || "-";
  }

  function createCell(text) {
    const td = document.createElement("td");
    td.textContent = text == null || text === "" ? "-" : String(text);
    return td;
  }

  function createRow(log) {
    const tr = document.createElement("tr");
    tr.appendChild(createCell(log.created_at));
    tr.appendChild(createCell(log.actor_email));
    tr.appendChild(createCell(log.actor_role));
    tr.appendChild(createCell(buildDescription(log)));
    tr.appendChild(createCell(log.entity_type));
    tr.appendChild(createCell(log.entity_id));
    tr.appendChild(createCell(log.status_code));
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
    return response.json();
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
    if (newestId == null) return;
    try {
      const data = await fetchLogs({ afterId: newestId, limit: 100 });
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

  window.setInterval(pollNewLogs, 5000);
})();
