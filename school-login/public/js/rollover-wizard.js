function normalizeWizardSearch(value) {
  return String(value || "").trim().toLowerCase()
}

const classFilterInput = document.querySelector("[data-rollover-class-filter-input]")
if (classFilterInput) {
  const classRows = Array.from(document.querySelectorAll("[data-rollover-class-row]"))

  classFilterInput.addEventListener("input", () => {
    const query = normalizeWizardSearch(classFilterInput.value)
    classRows.forEach((row) => {
      const haystack = String(row.dataset.searchText || "")
      row.hidden = query ? !haystack.includes(query) : false
    })
  })
}

const studentFilterInput = document.querySelector("[data-rollover-student-filter-input]")
if (studentFilterInput) {
  const groups = Array.from(document.querySelectorAll("[data-rollover-student-group]"))

  studentFilterInput.addEventListener("input", () => {
    const query = normalizeWizardSearch(studentFilterInput.value)
    groups.forEach((group) => {
      const rows = Array.from(group.querySelectorAll("[data-rollover-student-row]"))
      let visibleCount = 0
      rows.forEach((row) => {
        const haystack = String(row.dataset.searchText || "")
        const visible = !query || haystack.includes(query)
        row.hidden = !visible
        if (visible) visibleCount += 1
      })
      group.hidden = visibleCount === 0
      if (query && visibleCount > 0) group.open = true
    })
  })
}

document.querySelectorAll("[name$='[mode]']").forEach((modeSelect) => {
  const match = String(modeSelect.name).match(/^student_overrides\[(\d+)\]\[mode\]$/)
  if (!match) return

  const studentId = match[1]
  const actionSelect = document.querySelector(`[name="student_overrides[${studentId}][action]"]`)
  const targetSelect = document.querySelector(`[name="student_overrides[${studentId}][target_class_key]"]`)

  function syncManualControls() {
    const manualMode = modeSelect.value === "manual"
    if (actionSelect) actionSelect.disabled = !manualMode
    if (targetSelect) targetSelect.disabled = !manualMode
  }

  modeSelect.addEventListener("change", syncManualControls)
  syncManualControls()
})

function buildSchoolYearNameFromDate(value) {
  const match = String(value || "").match(/^(\d{4})-\d{2}-\d{2}$/)
  if (!match) return ""
  const startYear = Number(match[1])
  return `${String(startYear).padStart(4, "0")}/${String(startYear + 1).padStart(4, "0")}`
}

const startDateInput = document.querySelector("[name='start_date']")
const schoolYearNameInput = document.querySelector("[name='school_year_name']")
if (startDateInput && schoolYearNameInput) {
  let previousSuggestedName = buildSchoolYearNameFromDate(startDateInput.value)

  startDateInput.addEventListener("change", () => {
    const nextSuggestedName = buildSchoolYearNameFromDate(startDateInput.value)
    const currentName = String(schoolYearNameInput.value || "").trim()
    if (!currentName || currentName === previousSuggestedName) {
      schoolYearNameInput.value = nextSuggestedName
    }
    previousSuggestedName = nextSuggestedName
  })
}

document.querySelectorAll("[data-rollover-restore-form]").forEach((restoreForm) => {
  restoreForm.addEventListener("submit", (event) => {
    const label = String(restoreForm.dataset.restoreLabel || "dieses Schuljahr")
    const confirmed = window.confirm(
      `${label} wiederherstellen?\n\nAlle Daten im aktuell aktiven Zielschuljahr werden dabei entfernt.`
    )
    if (!confirmed) {
      event.preventDefault()
    }
  })
})
