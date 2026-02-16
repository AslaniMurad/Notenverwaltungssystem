function deriveNameFromEmail(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  const match = trimmed.match(/^([^@]+)@/);
  if (!match) return null;
  const localPart = match[1];
  const parts = localPart.split(".");
  if (parts.length !== 2) return null;
  const [first, last] = parts;
  const isValidPart = (part) => /^[a-z]+(?:-[a-z]+)*$/.test(part);
  if (!isValidPart(first) || !isValidPart(last)) return null;
  const cap = (part) => part.charAt(0).toUpperCase() + part.slice(1);
  return `${cap(first)} ${cap(last)}`;
}

module.exports = { deriveNameFromEmail };
