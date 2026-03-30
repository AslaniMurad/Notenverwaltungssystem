const ROLE_LABELS = Object.freeze({
  admin: "Administrator",
  student: "Sch\u00fcler",
  teacher: "Lehrer"
});

const SCHOOL_BADGE_LABEL = "HTLWY";

function getEmailLocalPart(email) {
  const normalizedEmail = String(email || "").trim();
  if (!normalizedEmail) return "";

  const atIndex = normalizedEmail.indexOf("@");
  if (atIndex <= 0) return "";
  return normalizedEmail.slice(0, atIndex).trim();
}

function capitalizeWord(word) {
  const normalizedWord = String(word || "").trim();
  if (!normalizedWord) return "";
  return normalizedWord.charAt(0).toLocaleUpperCase("de-AT") + normalizedWord.slice(1).toLocaleLowerCase("de-AT");
}

function formatNameFromEmail(email) {
  const localPart = getEmailLocalPart(email);
  if (!/^[a-z]+(?:\.[a-z]+)+$/i.test(localPart)) {
    return "";
  }

  return localPart
    .split(".")
    .filter(Boolean)
    .map(capitalizeWord)
    .join(" ");
}

function formatReadableIdentifier(value) {
  const localPart = getEmailLocalPart(value) || String(value || "").trim();
  if (!localPart) return "";

  return localPart
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(capitalizeWord)
    .join(" ");
}

function getRoleLabel(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  return ROLE_LABELS[normalizedRole] || "Nutzer";
}

function getDisplayName({ email, name } = {}) {
  const nameFromEmail = formatNameFromEmail(email);
  if (nameFromEmail) return nameFromEmail;

  const fallbackName = String(name || "").trim();
  if (fallbackName && fallbackName.toLowerCase() !== String(email || "").trim().toLowerCase()) {
    return fallbackName;
  }

  const readableIdentifier = formatReadableIdentifier(email);
  if (readableIdentifier) return readableIdentifier;

  return "Nutzer";
}

function buildSidebarUser({ email, role, name, activeSchoolYearName, className } = {}) {
  const displayName = getDisplayName({ email, name });
  const roleLabel = getRoleLabel(role);
  const normalizedEmail = String(email || "").trim();
  const normalizedSchoolYearName = String(activeSchoolYearName || "").trim();
  const normalizedClassName = String(className || "").trim();
  const normalizedRole = String(role || "").trim().toLowerCase();
  const metaLines = [];

  if (normalizedEmail) {
    metaLines.push(normalizedEmail);
  }
  if (normalizedSchoolYearName) {
    metaLines.push(`Schuljahr: ${normalizedSchoolYearName}`);
  }
  if (normalizedRole === "student" && normalizedClassName) {
    metaLines.push(`Klasse: ${normalizedClassName}`);
  }

  return {
    badgeLabel: SCHOOL_BADGE_LABEL,
    displayName,
    roleLabel,
    titleLine: [displayName, roleLabel].filter(Boolean).join(" - "),
    email: normalizedEmail,
    metaLines
  };
}

module.exports = {
  ROLE_LABELS,
  SCHOOL_BADGE_LABEL,
  buildSidebarUser,
  formatNameFromEmail,
  formatReadableIdentifier,
  getDisplayName,
  getRoleLabel
};
