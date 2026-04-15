function normalizeDangerSearch(value) {
  return String(value || "").trim().toLowerCase()
}

document.querySelectorAll("[data-archive-danger-filter]").forEach((input) => {
  const targetSelector = String(input.getAttribute("data-target-selector") || "").trim()
  if (!targetSelector) return

  const container = input.closest(".archive-danger-subpanel") || document
  const rows = Array.from(container.querySelectorAll(targetSelector))
  if (!rows.length) return

  input.addEventListener("input", () => {
    const query = normalizeDangerSearch(input.value)
    rows.forEach((row) => {
      const haystack = String(row.getAttribute("data-filter-text") || "")
      row.hidden = query ? !haystack.includes(query) : false
    })
  })
})
