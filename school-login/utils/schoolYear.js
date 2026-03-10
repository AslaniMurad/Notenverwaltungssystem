function padYear(year) {
  return String(year).padStart(4, "0");
}

function buildSchoolYearName(startYear) {
  const numericStartYear = Number(startYear);
  return `${padYear(numericStartYear)}/${padYear(numericStartYear + 1)}`;
}

function parseSchoolYearName(name) {
  const normalized = String(name || "").trim();
  const match = normalized.match(/^(\d{4})\/(\d{2}|\d{4})$/);
  if (!match) return null;

  const startYear = Number(match[1]);
  const rawEndYear = match[2];
  const endYear = rawEndYear.length === 2
    ? Number(`${String(startYear).slice(0, 2)}${rawEndYear}`)
    : Number(rawEndYear);

  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || endYear !== startYear + 1) {
    return null;
  }

  return { startYear, endYear };
}

function toSqlDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function getDefaultSchoolYearWindow(referenceDate = new Date()) {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const startYear = month >= 8 ? year : year - 1;
  const endYear = startYear + 1;

  return {
    name: buildSchoolYearName(startYear),
    startDate: `${padYear(startYear)}-09-01`,
    endDate: `${padYear(endYear)}-08-31`,
    startYear,
    endYear
  };
}

function getNextSchoolYear(activeSchoolYear) {
  const parsed = parseSchoolYearName(activeSchoolYear?.name);
  const fallback = getDefaultSchoolYearWindow();
  const startYear = parsed ? parsed.startYear + 1 : fallback.startYear + 1;
  const endYear = startYear + 1;
  const startDate = activeSchoolYear?.end_date
    ? toSqlDate(new Date(new Date(activeSchoolYear.end_date).getTime() + 24 * 60 * 60 * 1000))
    : `${padYear(startYear)}-09-01`;

  return {
    name: buildSchoolYearName(startYear),
    startDate: startDate || `${padYear(startYear)}-09-01`,
    endDate: `${padYear(endYear)}-08-31`,
    startYear,
    endYear
  };
}

function promoteClassName(name) {
  const normalized = String(name || "").trim();
  const match = normalized.match(/^(\d+)(.*)$/);
  if (!match) {
    return {
      currentName: normalized,
      nextName: normalized,
      changed: false
    };
  }

  const nextName = `${Number(match[1]) + 1}${match[2]}`;
  return {
    currentName: normalized,
    nextName,
    changed: nextName !== normalized
  };
}

module.exports = {
  buildSchoolYearName,
  getDefaultSchoolYearWindow,
  getNextSchoolYear,
  parseSchoolYearName,
  promoteClassName,
  toSqlDate
};
