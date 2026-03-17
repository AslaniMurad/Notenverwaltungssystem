const archiveNumberFormatter = new Intl.NumberFormat("de-AT")

function formatArchiveNumber(value) {
  return archiveNumberFormatter.format(Number(value || 0))
}

function normalizeArchiveSearch(value) {
  return String(value || "").trim().toLowerCase()
}

document.querySelectorAll("[data-archive-section]").forEach((section) => {
  const rows = Array.from(section.querySelectorAll("[data-archive-row]"))
  if (!rows.length) return

  const searchInput = section.querySelector("[data-archive-search]")
  const summary = section.querySelector("[data-archive-summary]")
  const actions = section.querySelector("[data-archive-actions]")
  const moreButton = section.querySelector("[data-archive-more]")
  const allButton = section.querySelector("[data-archive-all]")
  const resetButton = section.querySelector("[data-archive-reset]")
  const emptyState = section.querySelector("[data-archive-filter-empty]")
  const defaultPageSize = Math.max(Number(section.getAttribute("data-archive-page-size")) || 25, 1)

  let query = ""
  let limit = defaultPageSize

  function getMatchingRows() {
    if (!query) return rows
    return rows.filter((row) => String(row.dataset.searchText || "").includes(query))
  }

  function updateSummary(matchCount, shownCount) {
    if (!summary) return

    if (query) {
      summary.textContent = shownCount === 0
        ? "Keine Treffer"
        : `${formatArchiveNumber(matchCount)} Treffer, alle sichtbar`
      return
    }

    summary.textContent = shownCount < matchCount
      ? `${formatArchiveNumber(shownCount)} von ${formatArchiveNumber(matchCount)} Zeilen sichtbar`
      : `Alle ${formatArchiveNumber(matchCount)} Zeilen sichtbar`
  }

  function updateActions(matchCount, shownCount) {
    const shouldShowActionBar = query || matchCount > defaultPageSize || limit > defaultPageSize
    if (actions) actions.hidden = !shouldShowActionBar
    if (moreButton) moreButton.hidden = query || shownCount >= matchCount
    if (allButton) allButton.hidden = query || shownCount >= matchCount
    if (resetButton) resetButton.hidden = !query && limit <= defaultPageSize
  }

  function render() {
    const matchingRows = getMatchingRows()
    const matchSet = new Set(matchingRows)
    const activeLimit = query ? matchingRows.length : limit
    let shownCount = 0

    rows.forEach((row) => {
      const isMatch = matchSet.has(row)
      const shouldShow = isMatch && shownCount < activeLimit
      row.hidden = !shouldShow
      if (shouldShow) shownCount += 1
    })

    if (emptyState) emptyState.hidden = matchingRows.length !== 0
    updateSummary(matchingRows.length, shownCount)
    updateActions(matchingRows.length, shownCount)
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      query = normalizeArchiveSearch(searchInput.value)
      limit = query ? rows.length : defaultPageSize
      render()
    })
  }

  if (moreButton) {
    moreButton.addEventListener("click", () => {
      limit += defaultPageSize
      render()
    })
  }

  if (allButton) {
    allButton.addEventListener("click", () => {
      limit = rows.length
      render()
    })
  }

  if (resetButton) {
    resetButton.addEventListener("click", () => {
      query = ""
      limit = defaultPageSize
      if (searchInput) searchInput.value = ""
      render()
      if (searchInput) searchInput.focus()
    })
  }

  render()
})
