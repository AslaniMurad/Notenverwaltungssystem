const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const csrf = require("csurf");
const { db } = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { deriveNameFromEmail } = require("../utils/studentName");

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

router.use(requireAuth, requireRole("teacher"));

const csrfProtection = csrf({
  value: (req) =>
    (req.body && req.body._csrf) ||
    req.headers["x-csrf-token"] ||
    req.headers["csrf-token"]
});
const GRADE_ATTACHMENT_DIR = path.join(__dirname, "..", "uploads", "grade-attachments");
const MAX_GRADE_FILE_MB = Math.max(1, Number(process.env.GRADE_FILE_MAX_MB) || 10);
const MAX_GRADE_FILE_BYTES = MAX_GRADE_FILE_MB * 1024 * 1024;
const ALLOWED_GRADE_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png"]);
const ALLOWED_GRADE_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const MAGIC_BYTES = new Map([
  ["application/pdf", Buffer.from("%PDF-")],
  ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
  ["image/jpg", Buffer.from([0xff, 0xd8, 0xff])]
]);

fs.mkdirSync(GRADE_ATTACHMENT_DIR, { recursive: true });

const SPECIAL_ASSESSMENT_TYPES = ["Präsentation", "Wunschprüfung", "Benutzerdefiniert"];
const WEIGHT_MODE_POINTS = "points";
const SCORING_MODE_GRADE_ONLY = "grade_only";
const SCORING_MODE_POINTS_ONLY = "points_only";
const SCORING_MODE_POINTS_OR_GRADE = "points_or_grade";
const SCORING_MODE_POINTS_AND_GRADE = "points_and_grade";
const SCORING_MODE_OPTIONS = [
  { value: SCORING_MODE_GRADE_ONLY, label: "Nur Noten (1-5)" },
  { value: SCORING_MODE_POINTS_ONLY, label: "Nur Punkte" },
  { value: SCORING_MODE_POINTS_OR_GRADE, label: "Punkte oder Noten" },
  { value: SCORING_MODE_POINTS_AND_GRADE, label: "Punkte und Noten" }
];
const DEFAULT_SCORING_MODE = SCORING_MODE_POINTS_OR_GRADE;
const ABSENCE_MODE_INCLUDE_ZERO = "include_zero";
const ABSENCE_MODE_EXCLUDE = "exclude";
const ABSENCE_MODE_OPTIONS = [
  { value: ABSENCE_MODE_INCLUDE_ZERO, label: "Mit 0% werten (schlechteste Leistung)" },
  { value: ABSENCE_MODE_EXCLUDE, label: "Nicht gewichten (neutral)" }
];
const DEFAULT_ABSENCE_MODE = ABSENCE_MODE_INCLUDE_ZERO;
const DEFAULT_GRADE_THRESHOLDS = {
  grade1_min_percent: 88.5,
  grade2_min_percent: 75,
  grade3_min_percent: 62.5,
  grade4_min_percent: 50
};
const PARTICIPATION_SYMBOL_OPTIONS = [
  { value: "plus", label: "+" },
  { value: "plus_tilde", label: "+~" },
  { value: "neutral", label: "~" },
  { value: "minus_tilde", label: "-~" },
  { value: "minus", label: "-" }
];
const DEFAULT_PARTICIPATION_CONFIG = {
  ma_enabled: false,
  ma_weight: 5,
  ma_grade_plus: 1.5,
  ma_grade_plus_tilde: 2.5,
  ma_grade_neutral: 3,
  ma_grade_minus_tilde: 3.5,
  ma_grade_minus: 4.5
};
const TEMPLATE_CATEGORY_DEFINITIONS = [
  {
    key: "Schularbeit",
    slug: "schularbeit",
    label: "Schularbeit",
    aliases: ["schularbeit"]
  },
  {
    key: "Test",
    slug: "test",
    label: "Test",
    aliases: ["test"]
  },
  {
    key: "Projekt",
    slug: "projekt",
    label: "Projekt",
    aliases: ["projekt"]
  },
  {
    key: "Haus\u00fcbung",
    slug: "hausaufgabe",
    label: "Hausaufgabe",
    aliases: ["hausaufgabe", "hausuebung", "hausubung", "haus\u00fcbung", "hausübung"]
  },
  {
    key: "Mitarbeit",
    slug: "mitarbeit",
    label: "Mitarbeit",
    aliases: ["mitarbeit"]
  },
  {
    key: "Wiederholung",
    slug: "wiederholung",
    label: "Wiederholung",
    aliases: ["wiederholung"]
  }
];
const DEFAULT_PROFILE_WEIGHTS = {
  Schularbeit: 40,
  Test: 20,
  Projekt: 20,
  "Haus\u00fcbung": 10,
  Mitarbeit: 10,
  Wiederholung: 0
};
const CATEGORY_BY_KEY = new Map(TEMPLATE_CATEGORY_DEFINITIONS.map((entry) => [entry.key, entry]));

function sanitizeFilename(name) {
  return String(name || "datei")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function foldText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function resolveWeightMode(mode) {
  return WEIGHT_MODE_POINTS;
}

function getWeightUnit(mode) {
  return "Punkte";
}

function normalizeScoringMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  const validModes = new Set(SCORING_MODE_OPTIONS.map((entry) => entry.value));
  return validModes.has(normalized) ? normalized : DEFAULT_SCORING_MODE;
}

function normalizeAbsenceMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  const validModes = new Set(ABSENCE_MODE_OPTIONS.map((entry) => entry.value));
  return validModes.has(normalized) ? normalized : DEFAULT_ABSENCE_MODE;
}

function normalizeThresholds(source = {}) {
  const pick = (key, fallback) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    grade1_min_percent: pick("grade1_min_percent", DEFAULT_GRADE_THRESHOLDS.grade1_min_percent),
    grade2_min_percent: pick("grade2_min_percent", DEFAULT_GRADE_THRESHOLDS.grade2_min_percent),
    grade3_min_percent: pick("grade3_min_percent", DEFAULT_GRADE_THRESHOLDS.grade3_min_percent),
    grade4_min_percent: pick("grade4_min_percent", DEFAULT_GRADE_THRESHOLDS.grade4_min_percent)
  };
}

function parseThresholdsFromBody(body) {
  return normalizeThresholds({
    grade1_min_percent: parseNumericInput(body?.grade1_min_percent),
    grade2_min_percent: parseNumericInput(body?.grade2_min_percent),
    grade3_min_percent: parseNumericInput(body?.grade3_min_percent),
    grade4_min_percent: parseNumericInput(body?.grade4_min_percent)
  });
}

function validateThresholds(thresholds) {
  const t = normalizeThresholds(thresholds);
  const values = [t.grade1_min_percent, t.grade2_min_percent, t.grade3_min_percent, t.grade4_min_percent];
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    return "Grenzen muessen zwischen 0 und 100 liegen.";
  }
  if (!(t.grade1_min_percent > t.grade2_min_percent &&
        t.grade2_min_percent > t.grade3_min_percent &&
        t.grade3_min_percent > t.grade4_min_percent)) {
    return "Grenzen muessen streng fallend sein (1er > 2er > 3er > 4er).";
  }
  return null;
}

function buildGradeFromPercent(percent, thresholds) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return null;
  const t = normalizeThresholds(thresholds);
  if (value >= t.grade1_min_percent) return 1;
  if (value >= t.grade2_min_percent) return 2;
  if (value >= t.grade3_min_percent) return 3;
  if (value >= t.grade4_min_percent) return 4;
  return 5;
}

function normalizeParticipationConfig(source = {}) {
  const pick = (key, fallback) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  const rawEnabled = source?.ma_enabled;
  const enabled =
    rawEnabled === true ||
    rawEnabled === 1 ||
    rawEnabled === "1" ||
    rawEnabled === "true" ||
    rawEnabled === "on";
  return {
    ma_enabled: enabled,
    ma_weight: pick("ma_weight", DEFAULT_PARTICIPATION_CONFIG.ma_weight),
    ma_grade_plus: pick("ma_grade_plus", DEFAULT_PARTICIPATION_CONFIG.ma_grade_plus),
    ma_grade_plus_tilde: pick("ma_grade_plus_tilde", DEFAULT_PARTICIPATION_CONFIG.ma_grade_plus_tilde),
    ma_grade_neutral: pick("ma_grade_neutral", DEFAULT_PARTICIPATION_CONFIG.ma_grade_neutral),
    ma_grade_minus_tilde: pick("ma_grade_minus_tilde", DEFAULT_PARTICIPATION_CONFIG.ma_grade_minus_tilde),
    ma_grade_minus: pick("ma_grade_minus", DEFAULT_PARTICIPATION_CONFIG.ma_grade_minus)
  };
}

function parseParticipationConfigFromBody(body) {
  return normalizeParticipationConfig({
    ma_enabled: body?.ma_enabled,
    ma_weight: parseNumericInput(body?.ma_weight),
    ma_grade_plus: parseNumericInput(body?.ma_grade_plus),
    ma_grade_plus_tilde: parseNumericInput(body?.ma_grade_plus_tilde),
    ma_grade_neutral: parseNumericInput(body?.ma_grade_neutral),
    ma_grade_minus_tilde: parseNumericInput(body?.ma_grade_minus_tilde),
    ma_grade_minus: parseNumericInput(body?.ma_grade_minus)
  });
}

function validateParticipationConfig(config) {
  const value = normalizeParticipationConfig(config);
  if (!Number.isFinite(value.ma_weight) || value.ma_weight < 0) {
    return "MA-Gewichtung muss mindestens 0 Punkte sein.";
  }
  const gradeValues = [
    value.ma_grade_plus,
    value.ma_grade_plus_tilde,
    value.ma_grade_neutral,
    value.ma_grade_minus_tilde,
    value.ma_grade_minus
  ];
  if (gradeValues.some((entry) => !Number.isFinite(entry) || entry < 1 || entry > 5)) {
    return "MA-Notenwirkung muss zwischen 1 und 5 liegen.";
  }
  if (
    !(
      value.ma_grade_plus < value.ma_grade_plus_tilde &&
      value.ma_grade_plus_tilde < value.ma_grade_neutral &&
      value.ma_grade_neutral < value.ma_grade_minus_tilde &&
      value.ma_grade_minus_tilde < value.ma_grade_minus
    )
  ) {
    return "MA-Notenwirkung muss streng steigend sein (+ < +~ < ~ < -~ < -).";
  }
  if (value.ma_enabled && value.ma_weight <= 0) {
    return "Wenn MA aktiv ist, muss die MA-Gewichtung größer als 0 sein.";
  }
  return null;
}

function normalizeParticipationSymbol(symbol) {
  const normalized = String(symbol || "").trim().toLowerCase();
  if (normalized === "~") return "neutral";
  if (normalized === "tilde") return "neutral";
  return PARTICIPATION_SYMBOL_OPTIONS.some((entry) => entry.value === normalized) ? normalized : null;
}

function getParticipationGrade(symbol, config) {
  const normalized = normalizeParticipationSymbol(symbol);
  if (!normalized) return null;
  const source = normalizeParticipationConfig(config);
  if (normalized === "plus") return source.ma_grade_plus;
  if (normalized === "plus_tilde") return source.ma_grade_plus_tilde;
  if (normalized === "neutral") return source.ma_grade_neutral;
  if (normalized === "minus_tilde") return source.ma_grade_minus_tilde;
  if (normalized === "minus") return source.ma_grade_minus;
  return null;
}

function getParticipationSymbolLabel(symbol) {
  const normalized = normalizeParticipationSymbol(symbol);
  const option = PARTICIPATION_SYMBOL_OPTIONS.find((entry) => entry.value === normalized);
  return option ? option.label : String(symbol || "");
}

function buildParticipationAverageRows(marks, config) {
  const participation = normalizeParticipationConfig(config);
  if (!participation.ma_enabled || participation.ma_weight <= 0) return [];
  return (marks || [])
    .map((mark) => {
      const grade = getParticipationGrade(mark.symbol, participation);
      if (!Number.isFinite(grade)) return null;
      return {
        grade,
        weight: participation.ma_weight,
        is_participation: true
      };
    })
    .filter(Boolean);
}

function getScoringModeLabel(mode) {
  const normalized = normalizeScoringMode(mode);
  const entry = SCORING_MODE_OPTIONS.find((option) => option.value === normalized);
  return entry ? entry.label : "Punkte oder Noten";
}

function parseNumericInput(value) {
  if (value == null) return NaN;
  const normalized = String(value).trim().replace(",", ".");
  return Number(normalized);
}

function normalizeCategoryKey(value) {
  const folded = foldText(value);
  if (!folded) return null;
  for (const category of TEMPLATE_CATEGORY_DEFINITIONS) {
    const candidates = [category.key, category.label, category.slug, ...(category.aliases || [])];
    if (candidates.some((candidate) => foldText(candidate) === folded)) {
      return category.key;
    }
  }
  return null;
}

function getCategoryLabel(key) {
  return CATEGORY_BY_KEY.get(key)?.label || key;
}

function formatWeightNumber(weight) {
  const value = Number(weight);
  if (!Number.isFinite(value)) return "-";
  return String(Number(value.toFixed(2)));
}

function formatWeightLabel(weight, mode) {
  return `${formatWeightNumber(weight)} ${getWeightUnit(mode)}`;
}

function buildDefaultWeights(mode) {
  const weights = {};
  TEMPLATE_CATEGORY_DEFINITIONS.forEach((category) => {
    weights[category.key] = Number(DEFAULT_PROFILE_WEIGHTS[category.key] || 0);
  });
  return weights;
}

function mergeWeightsWithDefaults(rawWeights, mode) {
  const merged = buildDefaultWeights(mode);
  TEMPLATE_CATEGORY_DEFINITIONS.forEach((category) => {
    if (!Object.prototype.hasOwnProperty.call(rawWeights || {}, category.key)) return;
    const value = Number(rawWeights[category.key]);
    if (Number.isFinite(value) && value >= 0) {
      merged[category.key] = value;
    }
  });
  return merged;
}

function parseWeightsFromBody(body) {
  const result = {};
  TEMPLATE_CATEGORY_DEFINITIONS.forEach((category) => {
    const raw = body ? body[`weight_${category.slug}`] : "";
    result[category.key] = parseNumericInput(raw);
  });
  return result;
}

function computeWeightsTotal(weights) {
  return Number(
    TEMPLATE_CATEGORY_DEFINITIONS.reduce((sum, category) => {
      const value = Number(weights?.[category.key] || 0);
      return Number.isFinite(value) ? sum + value : sum;
    }, 0).toFixed(2)
  );
}

function validateWeights(mode, weights) {
  for (const category of TEMPLATE_CATEGORY_DEFINITIONS) {
    const value = Number(weights?.[category.key]);
    if (!Number.isFinite(value) || value < 0) {
      return `Gewichtung f\u00fcr ${getCategoryLabel(category.key)} muss mindestens 0 sein.`;
    }
  }

  const total = computeWeightsTotal(weights);
  if (total <= 0) return "Die Summe der Punkte muss gr\u00f6\u00dfer als 0 sein.";
  return null;
}

async function loadProfileItems(profileId) {
  const rows = await allAsync(
    "SELECT category, weight FROM teacher_grading_profile_items WHERE profile_id = ?",
    [profileId]
  );
  const items = {};
  rows.forEach((row) => {
    const key = normalizeCategoryKey(row.category);
    if (!key) return;
    const value = Number(row.weight);
    if (!Number.isFinite(value)) return;
    items[key] = value;
  });
  return items;
}

async function loadTeacherProfiles(teacherId) {
  const profiles = await allAsync(
    `SELECT id, teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active, created_at, updated_at
     FROM teacher_grading_profiles
     WHERE teacher_id = ?
     ORDER BY is_active DESC, created_at ASC, id ASC`,
    [teacherId]
  );
  return profiles.map((profile) => ({
    ...profile,
    weight_mode: resolveWeightMode(profile.weight_mode),
    scoring_mode: normalizeScoringMode(profile.scoring_mode),
    absence_mode: normalizeAbsenceMode(profile.absence_mode),
    thresholds: normalizeThresholds(profile),
    participation: normalizeParticipationConfig(profile),
    is_active: Boolean(profile.is_active)
  }));
}

async function loadTeacherProfileById(profileId, teacherId) {
  const profile = await getAsync(
    `SELECT id, teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active, created_at, updated_at
     FROM teacher_grading_profiles
     WHERE id = ? AND teacher_id = ?`,
    [profileId, teacherId]
  );
  if (!profile) return null;
  return {
    ...profile,
    weight_mode: resolveWeightMode(profile.weight_mode),
    scoring_mode: normalizeScoringMode(profile.scoring_mode),
    absence_mode: normalizeAbsenceMode(profile.absence_mode),
    thresholds: normalizeThresholds(profile),
    participation: normalizeParticipationConfig(profile),
    is_active: Boolean(profile.is_active)
  };
}

async function loadActiveTeacherProfile(teacherId) {
  const activeProfile = await getAsync(
    `SELECT id, teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active, created_at, updated_at
     FROM teacher_grading_profiles
     WHERE teacher_id = ? AND is_active = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [teacherId, true]
  );

  if (activeProfile) {
    const weights = mergeWeightsWithDefaults(
      await loadProfileItems(activeProfile.id),
      activeProfile.weight_mode
    );
    return {
      ...activeProfile,
      weight_mode: resolveWeightMode(activeProfile.weight_mode),
      scoring_mode: normalizeScoringMode(activeProfile.scoring_mode),
      absence_mode: normalizeAbsenceMode(activeProfile.absence_mode),
      thresholds: normalizeThresholds(activeProfile),
      participation: normalizeParticipationConfig(activeProfile),
      is_active: Boolean(activeProfile.is_active),
      weights,
      total_weight: computeWeightsTotal(weights)
    };
  }

  const fallback = await getAsync(
    `SELECT id, teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active, created_at, updated_at
     FROM teacher_grading_profiles
     WHERE teacher_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [teacherId]
  );
  if (!fallback) return null;

  await runAsync("UPDATE teacher_grading_profiles SET is_active = ? WHERE teacher_id = ?", [false, teacherId]);
  await runAsync(
    "UPDATE teacher_grading_profiles SET is_active = ?, updated_at = current_timestamp WHERE id = ? AND teacher_id = ?",
    [true, fallback.id, teacherId]
  );

  const weights = mergeWeightsWithDefaults(await loadProfileItems(fallback.id), fallback.weight_mode);
  return {
    ...fallback,
    weight_mode: resolveWeightMode(fallback.weight_mode),
    scoring_mode: normalizeScoringMode(fallback.scoring_mode),
    absence_mode: normalizeAbsenceMode(fallback.absence_mode),
    thresholds: normalizeThresholds(fallback),
    participation: normalizeParticipationConfig(fallback),
    is_active: true,
    weights,
    total_weight: computeWeightsTotal(weights)
  };
}

function enrichWeightData(entry, fallbackMode = WEIGHT_MODE_POINTS) {
  const weightMode = resolveWeightMode(entry?.weight_mode || fallbackMode);
  return {
    ...entry,
    weight_mode: weightMode,
    weight_unit: getWeightUnit(weightMode),
    weight_label: formatWeightLabel(entry?.weight, weightMode)
  };
}

function normalizeExternalLink(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > 2048) {
    return { error: "Der Link ist zu lang." };
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "Ungültiger Link." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { error: "Der Link muss mit http:// oder https:// beginnen." };
  }
  return { value: url.toString() };
}

async function hasValidFileSignature(filePath, mime) {
  const expected = MAGIC_BYTES.get(mime);
  if (!expected) return false;
  try {
    const handle = await fs.promises.open(filePath, "r");
    const buffer = Buffer.alloc(expected.length);
    await handle.read(buffer, 0, expected.length, 0);
    await handle.close();
    return buffer.equals(expected);
  } catch {
    return false;
  }
}

async function removeUploadedFile(file) {
  if (!file || !file.path) return;
  try {
    await fs.promises.unlink(file.path);
  } catch {}
}

async function removeStoredAttachment(attachmentPath) {
  if (!attachmentPath) return;
  const baseDir = path.resolve(GRADE_ATTACHMENT_DIR);
  const filePath = path.resolve(path.join(GRADE_ATTACHMENT_DIR, attachmentPath));
  if (!filePath.startsWith(baseDir + path.sep)) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {}
}

function buildDefaultAddGradeFormData(source = {}) {
  return {
    grade_template_id: source.grade_template_id || "",
    grade: source.grade != null ? String(source.grade) : "",
    points_achieved: source.points_achieved != null ? String(source.points_achieved) : "",
    is_absent:
      source.is_absent === true ||
      source.is_absent === 1 ||
      source.is_absent === "1" ||
      source.is_absent === "true" ||
      source.is_absent === "on",
    note: source.note || "",
    external_link: source.external_link || ""
  };
}

function parseOptionalNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { provided: false, value: null };
  const value = parseNumericInput(text);
  return { provided: true, value };
}

async function renderAddGradeForm(req, res, payload) {
  const {
    status = 200,
    classData,
    student,
    templates,
    gradedTemplateIds = [],
    error = null,
    formData = {}
  } = payload || {};
  const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
  const scoringMode = normalizeScoringMode(activeProfile?.scoring_mode);
  const absenceMode = normalizeAbsenceMode(activeProfile?.absence_mode);
  const thresholds = normalizeThresholds(activeProfile?.thresholds || activeProfile || {});
  const openMessageCount = classData?.id ? await loadClassOpenMessageCount(classData.id) : 0;

  return res.status(status).render("teacher/teacher-add-grade", {
    email: req.session.user.email,
    classData,
    student,
    templates,
    gradedTemplateIds: Array.isArray(gradedTemplateIds) ? gradedTemplateIds.map(String) : [],
    activeProfile,
    scoringMode,
    scoringModeLabel: getScoringModeLabel(scoringMode),
    absenceMode,
    thresholds,
    openMessageCount,
    formData: buildDefaultAddGradeFormData(formData),
    csrfToken: req.csrfToken(),
    error,
    maxFileSizeMb: MAX_GRADE_FILE_MB
  });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, GRADE_ATTACHMENT_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const safeExt = ALLOWED_GRADE_EXTENSIONS.has(ext) ? ext : "";
      const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt}`;
      cb(null, uniqueName);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    if (!ALLOWED_GRADE_EXTENSIONS.has(ext) || !ALLOWED_GRADE_MIME_TYPES.has(mime)) {
      const error = new Error("Unsupported file type");
      error.code = "UNSUPPORTED_FILE_TYPE";
      return cb(error);
    }
    return cb(null, true);
  },
  limits: { fileSize: MAX_GRADE_FILE_BYTES }
});

function runCsrf(req, res) {
  return new Promise((resolve) => {
    csrfProtection(req, res, (err) => resolve(err));
  });
}

function handleUpload(req, res, next) {
  upload.single("attachment_file")(req, res, async (err) => {
    let uploadErr = err;
    try {
      const csrfErr = await runCsrf(req, res);
      if (csrfErr) {
        await removeUploadedFile(req.file);
        return next(csrfErr);
      }
      if (!uploadErr && req.file) {
        const signatureOk = await hasValidFileSignature(
          req.file.path,
          String(req.file.mimetype || "").toLowerCase()
        );
        if (!signatureOk) {
          await removeUploadedFile(req.file);
          uploadErr = new Error("Invalid file signature");
          uploadErr.code = "INVALID_FILE_SIGNATURE";
        }
      }
      if (!uploadErr) return next();

      await removeUploadedFile(req.file);
      const classId = req.params.classId;
      const studentId = req.params.studentId;
      const classData = await loadClassForTeacher(classId, req.session.user.id);
      if (!classData) {
        return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
      }
      const students = await loadStudents(classId);
      const student = students.find((entry) => String(entry.id) === String(studentId));
      if (!student) {
        return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
      }
      const templates = await loadTemplates(classId);
      const gradedTemplateIds = await loadGradedTemplateIdsForStudent(classId, student.id);
      const errorMessage =
        uploadErr.code === "LIMIT_FILE_SIZE"
          ? `Datei ist zu groß. Maximal ${MAX_GRADE_FILE_MB} MB erlaubt.`
          : uploadErr.code === "UNSUPPORTED_FILE_TYPE"
          ? "Nur PDF-, JPG- oder PNG-Dateien sind erlaubt."
          : uploadErr.code === "INVALID_FILE_SIGNATURE"
          ? "Dateiinhalt passt nicht zum Dateityp."
          : "Upload fehlgeschlagen. Bitte erneut versuchen.";
      return renderAddGradeForm(req, res, {
        status: 400,
        classData,
        student,
        templates,
        gradedTemplateIds,
        error: errorMessage,
        formData: req.body || {}
      });
    } catch (innerErr) {
      return next(innerErr);
    }
  });
}

function renderError(res, req, message, status, backUrl) {
  return res.status(status).render("error", {
    message,
    status,
    backUrl,
    csrfToken: req.csrfToken()
  });
}

async function loadClassForTeacher(classId, teacherId) {
  return getAsync(
    "SELECT id, name, subject FROM classes WHERE id = ? AND teacher_id = ?",
    [classId, teacherId]
  );
}

async function loadStudents(classId) {
  return allAsync("SELECT id, name, email FROM students WHERE class_id = ? ORDER BY name", [classId]);
}

async function loadTemplates(classId) {
  const templates = await allAsync(
    "SELECT id, name, category, weight, weight_mode, max_points, date, description FROM grade_templates WHERE class_id = ? ORDER BY date, name",
    [classId]
  );
  return templates.map((template) => enrichWeightData(template));
}

async function loadStudentGrades(studentId) {
  return allAsync(
    `SELECT g.id, g.grade, g.points_achieved, g.points_max, g.note, g.created_at, g.grade_template_id as template_id, gt.name, gt.category, gt.weight, gt.weight_mode, gt.max_points as template_max_points, gt.date, gt.description, c.subject as class_subject, g.attachment_path, g.attachment_original_name, g.attachment_mime, g.attachment_size, g.external_link, g.is_absent, 0 as is_special
     FROM grades g
     JOIN grade_templates gt ON gt.id = g.grade_template_id
     JOIN classes c ON c.id = g.class_id
     WHERE g.student_id = ?
     UNION ALL
     SELECT sa.id, sa.grade, NULL as points_achieved, NULL as points_max, sa.description as note, sa.created_at, NULL as template_id, sa.name, sa.type as category, sa.weight, NULL as weight_mode, NULL as template_max_points, sa.created_at as date, sa.description, c.subject as class_subject, NULL as attachment_path, NULL as attachment_original_name, NULL as attachment_mime, NULL as attachment_size, NULL as external_link, false as is_absent, 1 as is_special
     FROM special_assessments sa
     JOIN classes c ON c.id = sa.class_id
     WHERE sa.student_id = ?
     ORDER BY created_at DESC`,
    [studentId, studentId]
  );
}

async function loadGradedTemplateIdsForStudent(classId, studentId) {
  const rows = await allAsync(
    "SELECT grade_template_id FROM grades WHERE class_id = ? AND student_id = ?",
    [classId, studentId]
  );
  return rows.map((row) => String(row.grade_template_id));
}

async function loadSpecialAssessments(classId) {
  return allAsync(
    `SELECT sa.id, sa.student_id, s.name AS student_name, sa.type, sa.name, sa.description, sa.weight, sa.grade, sa.created_at
     FROM special_assessments sa
     JOIN students s ON s.id = sa.student_id
     WHERE sa.class_id = ?
     ORDER BY sa.created_at DESC`,
    [classId]
  );
}

async function loadClassGradeMessages(classId) {
  return allAsync(
    `SELECT gm.id, gm.grade_id, gm.student_id, gm.student_message, gm.teacher_reply, gm.created_at, gm.replied_at,
            s.name AS student_name, s.email AS student_email, gt.name AS test_name, g.grade AS grade_value
     FROM grade_messages gm
     JOIN grades g ON g.id = gm.grade_id
     JOIN students s ON s.id = gm.student_id
     LEFT JOIN grade_templates gt ON gt.id = g.grade_template_id
     WHERE g.class_id = ? AND s.class_id = ?
     ORDER BY gm.created_at ASC`,
    [classId, classId]
  );
}

async function loadStudentGradeMessages(classId, studentId) {
  return allAsync(
    `SELECT gm.id, gm.grade_id, gm.student_message, gm.teacher_reply, gm.created_at, gm.replied_at
     FROM grade_messages gm
     JOIN grades g ON g.id = gm.grade_id
     WHERE g.class_id = ? AND g.student_id = ? AND gm.student_id = ?
     ORDER BY gm.created_at ASC`,
    [classId, studentId, studentId]
  );
}

function groupClassMessageThreads(rows) {
  const threadMap = new Map();
  let openMessageCount = 0;

  rows.forEach((row) => {
    const key = `${row.grade_id}:${row.student_id}`;
    if (!threadMap.has(key)) {
      threadMap.set(key, {
        grade_id: row.grade_id,
        student_id: row.student_id,
        student_name: row.student_name,
        student_email: row.student_email,
        test_name: row.test_name,
        grade_value: row.grade_value,
        latest_at: row.created_at,
        messages: []
      });
    }

    const thread = threadMap.get(key);
    thread.messages.push({
      id: row.id,
      student_message: row.student_message,
      teacher_reply: row.teacher_reply || null,
      created_at: row.created_at,
      replied_at: row.replied_at || null
    });
    thread.latest_at = row.created_at;
    if (!row.teacher_reply) openMessageCount += 1;
  });

  const messageThreads = Array.from(threadMap.values()).sort(
    (a, b) => new Date(b.latest_at) - new Date(a.latest_at)
  );

  return { messageThreads, openMessageCount };
}

async function loadClassOpenMessageCount(classId) {
  const messages = await loadClassGradeMessages(classId);
  const { openMessageCount } = groupClassMessageThreads(messages);
  return openMessageCount;
}

async function loadMessageForTeacher(classId, messageId, teacherId) {
  return getAsync(
    `SELECT gm.id, gm.student_id
     FROM grade_messages gm
     JOIN grades g ON g.id = gm.grade_id
     JOIN classes c ON c.id = g.class_id
     WHERE gm.id = ? AND c.id = ? AND c.teacher_id = ?`,
    [messageId, classId, teacherId]
  );
}
function shouldSkipGradeForAbsence(grade, absenceMode) {
  if (!grade || !grade.is_absent) return false;
  return normalizeAbsenceMode(absenceMode) === ABSENCE_MODE_EXCLUDE;
}

function isValidGradeValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 && numeric <= 5;
}

function isValidWeightValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0;
}

function escapeCsvValue(value) {
  const stringValue = value == null ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(stringValue) ? `'${stringValue}` : stringValue;
  if (/[",\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function computeWeightedAverage(grades, options = {}) {
  const absenceMode = normalizeAbsenceMode(options.absenceMode);
  let weightedSum = 0;
  let weightTotal = 0;

  grades.forEach((grade) => {
    if (shouldSkipGradeForAbsence(grade, absenceMode)) return;
    const value = Number(grade?.grade);
    const weight = grade?.weight == null ? 1 : Number(grade.weight);
    if (!isValidGradeValue(value) || !isValidWeightValue(weight)) return;
    weightedSum += value * weight;
    weightTotal += weight;
  });

  return weightTotal ? Number((weightedSum / weightTotal).toFixed(2)) : null;
}

function mapGradeToEstimatedPercent(grade, thresholdsSource) {
  const value = Number(grade);
  if (!isValidGradeValue(value)) return null;

  const thresholds = normalizeThresholds(thresholdsSource || {});
  const anchors = [
    { grade: 1, percent: 100 },
    { grade: 2, percent: Number(thresholds.grade2_min_percent) },
    { grade: 3, percent: Number(thresholds.grade3_min_percent) },
    { grade: 4, percent: Number(thresholds.grade4_min_percent) },
    { grade: 5, percent: 0 }
  ];

  const clamped = Math.min(5, Math.max(1, value));
  if (clamped === 1) return 100;
  if (clamped === 5) return 0;

  const lower = Math.floor(clamped);
  const upper = Math.ceil(clamped);
  const lowerAnchor = anchors.find((entry) => entry.grade === lower);
  const upperAnchor = anchors.find((entry) => entry.grade === upper);
  if (!lowerAnchor || !upperAnchor) return null;
  if (lower === upper) return Number(lowerAnchor.percent);

  const ratio = (clamped - lower) / (upper - lower);
  return Number((lowerAnchor.percent + (upperAnchor.percent - lowerAnchor.percent) * ratio).toFixed(4));
}

function computePointTotalsWithParticipation(entries, options = {}) {
  const thresholds = normalizeThresholds(options.thresholds || {});
  const absenceMode = normalizeAbsenceMode(options.absenceMode);
  return (entries || []).reduce(
    (acc, row) => {
      if (shouldSkipGradeForAbsence(row, absenceMode)) return acc;

      const achieved = Number(row?.points_achieved);
      const max = Number(row?.points_max);
      if (Number.isFinite(achieved) && Number.isFinite(max) && max > 0) {
        acc.achieved += achieved;
        acc.max += max;
        return acc;
      }

      if (!row?.is_participation) return acc;

      const weight = Number(row?.weight);
      const grade = Number(row?.grade);
      if (!isValidWeightValue(weight) || weight <= 0 || !isValidGradeValue(grade)) return acc;

      const estimatedPercent = mapGradeToEstimatedPercent(grade, thresholds);
      if (!Number.isFinite(estimatedPercent)) return acc;

      acc.max += weight;
      acc.achieved += weight * (estimatedPercent / 100);
      return acc;
    },
    { achieved: 0, max: 0 }
  );
}

async function loadParticipationMarks(classId, studentId) {
  return allAsync(
    `SELECT id, student_id, class_id, symbol, note, created_at
     FROM participation_marks
     WHERE class_id = ? AND student_id = ?
     ORDER BY created_at DESC`,
    [classId, studentId]
  );
}

async function buildSettingsPageData(teacherId, selectedProfileId, formOverride = null) {
  const profiles = await loadTeacherProfiles(teacherId);
  const setupComplete = profiles.length > 0;
  const activeProfile = profiles.find((profile) => profile.is_active) || profiles[0] || null;

  let selectedProfile = null;
  if (selectedProfileId) {
    selectedProfile = profiles.find((profile) => Number(profile.id) === Number(selectedProfileId)) || null;
  }
  if (!selectedProfile) selectedProfile = activeProfile;

  let selectedWeights = buildDefaultWeights(WEIGHT_MODE_POINTS);
  let selectedMode = WEIGHT_MODE_POINTS;
  let selectedScoringMode = DEFAULT_SCORING_MODE;
  let selectedAbsenceMode = DEFAULT_ABSENCE_MODE;
  let selectedThresholds = normalizeThresholds();
  let selectedParticipation = normalizeParticipationConfig();
  if (selectedProfile) {
    selectedMode = resolveWeightMode(selectedProfile.weight_mode);
    selectedWeights = mergeWeightsWithDefaults(await loadProfileItems(selectedProfile.id), selectedMode);
    selectedScoringMode = normalizeScoringMode(selectedProfile.scoring_mode);
    selectedAbsenceMode = normalizeAbsenceMode(selectedProfile.absence_mode);
    selectedThresholds = normalizeThresholds(selectedProfile.thresholds || selectedProfile);
    selectedParticipation = normalizeParticipationConfig(
      selectedProfile.participation || selectedProfile
    );
  }

  const selectedTotal = computeWeightsTotal(selectedWeights);
  const defaultProfileName = selectedProfile?.name || "Standardprofil";
  const formData =
    formOverride ||
    {
      profile_id: selectedProfile?.id || "",
      profile_name: defaultProfileName,
      weight_mode: selectedMode,
      scoring_mode: selectedScoringMode,
      absence_mode: selectedAbsenceMode,
      thresholds: selectedThresholds,
      participation: selectedParticipation,
      set_active: selectedProfile ? Boolean(selectedProfile.is_active) : true,
      weights: selectedWeights
    };

  return {
    setupComplete,
    activeProfile,
    profiles: profiles.map((profile) => ({
      ...profile,
      mode_label: getWeightUnit(profile.weight_mode),
      scoring_mode: normalizeScoringMode(profile.scoring_mode),
      absence_mode: normalizeAbsenceMode(profile.absence_mode),
      thresholds: normalizeThresholds(profile.thresholds || profile),
      participation: normalizeParticipationConfig(profile.participation || profile),
      is_active: Boolean(profile.is_active)
    })),
    selectedProfile,
    selectedWeights,
    selectedTotal,
    formData
  };
}

router.get("/classes", async (req, res, next) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    const q = qRaw.slice(0, 120);
    const qFolded = foldText(q);
    const sortOptions = new Set([
      "newest",
      "oldest",
      "name_asc",
      "name_desc",
      "subject_asc",
      "subject_desc"
    ]);
    const sort = sortOptions.has(String(req.query.sort || ""))
      ? String(req.query.sort)
      : "newest";

    const classesAll = await allAsync(
      "SELECT id, name, subject, created_at FROM classes WHERE teacher_id = ?",
      [req.session.user.id]
    );
    let classes = classesAll.filter((entry) => {
      if (!qFolded) return true;
      const haystack = foldText(`${entry.name || ""} ${entry.subject || ""}`);
      return haystack.includes(qFolded);
    });

    const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), "de", { sensitivity: "base" });
    const compareTime = (a, b) => {
      const ta = a ? new Date(a).getTime() : 0;
      const tb = b ? new Date(b).getTime() : 0;
      return ta - tb;
    };

    classes.sort((a, b) => {
      switch (sort) {
        case "oldest":
          return compareTime(a.created_at, b.created_at);
        case "name_asc":
          return compareText(a.name, b.name);
        case "name_desc":
          return compareText(b.name, a.name);
        case "subject_asc":
          return compareText(a.subject, b.subject) || compareText(a.name, b.name);
        case "subject_desc":
          return compareText(b.subject, a.subject) || compareText(a.name, b.name);
        case "newest":
        default:
          return compareTime(b.created_at, a.created_at);
      }
    });

    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);

    res.render("teacher/teacher-classes", {
      email: req.session.user.email,
      classes,
      totalClassCount: classesAll.length,
      search: { q, sort },
      setupComplete: Boolean(activeProfile),
      activeProfile,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/create-class", (req, res) => {
  res.render("teacher/teacher-create-class", {
    email: req.session.user.email,
    csrfToken: req.csrfToken()
  });
});

router.post("/create-class", async (req, res, next) => {
  try {
    const { name, subject } = req.body || {};
    if (!name || !subject) {
      return renderError(res, req, "Bitte alle Pflichtfelder ausfüllen.", 400, "/teacher/create-class");
    }

    await runAsync("INSERT INTO classes (name, subject, teacher_id) VALUES (?,?,?)", [
      name,
      subject,
      req.session.user.id
    ]);
    res.redirect("/teacher/classes");
  } catch (err) {
    next(err);
  }
});

router.post("/delete-class/:id", async (req, res, next) => {
  try {
    const classId = req.params.id;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    await runAsync("DELETE FROM students WHERE class_id = ?", [classId]);
    await runAsync("DELETE FROM classes WHERE id = ?", [classId]);
    res.redirect("/teacher/classes");
  } catch (err) {
    next(err);
  }
});

router.get("/settings", async (req, res, next) => {
  try {
    const teacherId = req.session.user.id;
    const selectedProfileId = req.query.profile_id ? Number(req.query.profile_id) : null;
    const isCreateMode = String(req.query.new || "") === "1";
    const isEditMode = String(req.query.edit || "") === "1";

    let pageData = await buildSettingsPageData(teacherId, selectedProfileId);
    if (isCreateMode) {
      const sourceProfile = pageData.activeProfile || pageData.selectedProfile;
      const createFormData = {
        profile_id: "",
        profile_name: "",
        weight_mode: WEIGHT_MODE_POINTS,
        scoring_mode: normalizeScoringMode(sourceProfile?.scoring_mode),
        absence_mode: normalizeAbsenceMode(sourceProfile?.absence_mode),
        thresholds: normalizeThresholds(sourceProfile?.thresholds || sourceProfile || {}),
        participation: normalizeParticipationConfig(
          sourceProfile?.participation || sourceProfile || {}
        ),
        set_active: !pageData.activeProfile,
        weights: mergeWeightsWithDefaults(sourceProfile?.weights || {}, WEIGHT_MODE_POINTS)
      };
      pageData = await buildSettingsPageData(teacherId, null, createFormData);
    }

    const showConfigForm =
      !pageData.setupComplete ||
      isCreateMode ||
      (isEditMode && Number.isInteger(selectedProfileId) && selectedProfileId > 0);
    const message = req.query.saved
      ? "Bewertungsschema gespeichert."
      : req.query.deleted
      ? "Profil gelöscht."
      : null;

    res.render("teacher/teacher-settings", {
      email: req.session.user.email,
      csrfToken: req.csrfToken(),
      categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
      scoringModeOptions: SCORING_MODE_OPTIONS,
      absenceModeOptions: ABSENCE_MODE_OPTIONS,
      participationSymbolOptions: PARTICIPATION_SYMBOL_OPTIONS,
      setupComplete: pageData.setupComplete,
      showSetupFlow: !pageData.setupComplete || String(req.query.setup || "") === "1",
      showConfigForm,
      profiles: pageData.profiles,
      activeProfile: pageData.activeProfile,
      selectedProfile: pageData.selectedProfile,
      selectedTotal: computeWeightsTotal(pageData.formData.weights),
      formData: pageData.formData,
      message,
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/settings/save-profile", async (req, res, next) => {
  try {
    const teacherId = req.session.user.id;
    const requestedProfileId = Number(req.body?.profile_id);
    const profileName = String(req.body?.profile_name || "").trim();
    const weightMode = WEIGHT_MODE_POINTS;
    const scoringMode = normalizeScoringMode(req.body?.scoring_mode);
    const absenceMode = normalizeAbsenceMode(req.body?.absence_mode);
    const thresholds = parseThresholdsFromBody(req.body || {});
    const participation = parseParticipationConfigFromBody(req.body || {});
    const requestedSetActive = req.body?.set_active === "1" || req.body?.set_active === "on";
    const parsedWeights = parseWeightsFromBody(req.body || {});
    const existingProfiles = await loadTeacherProfiles(teacherId);

    const formData = {
      profile_id: Number.isInteger(requestedProfileId) && requestedProfileId > 0 ? requestedProfileId : "",
      profile_name: profileName,
      weight_mode: weightMode,
      scoring_mode: scoringMode,
      absence_mode: absenceMode,
      thresholds,
      participation,
      set_active: requestedSetActive,
      weights: mergeWeightsWithDefaults(parsedWeights, weightMode)
    };

    if (!profileName) {
      const pageData = await buildSettingsPageData(teacherId, formData.profile_id, formData);
      return res.status(400).render("teacher/teacher-settings", {
        email: req.session.user.email,
        csrfToken: req.csrfToken(),
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        scoringModeOptions: SCORING_MODE_OPTIONS,
        absenceModeOptions: ABSENCE_MODE_OPTIONS,
        participationSymbolOptions: PARTICIPATION_SYMBOL_OPTIONS,
        setupComplete: pageData.setupComplete,
        showSetupFlow: !pageData.setupComplete,
        showConfigForm: true,
        profiles: pageData.profiles,
        activeProfile: pageData.activeProfile,
        selectedProfile: pageData.selectedProfile,
        selectedTotal: computeWeightsTotal(formData.weights),
        formData: pageData.formData,
        message: null,
        error: "Bitte einen Profilnamen angeben."
      });
    }

    const validationError = validateWeights(weightMode, parsedWeights);
    if (validationError) {
      const pageData = await buildSettingsPageData(teacherId, formData.profile_id, formData);
      return res.status(400).render("teacher/teacher-settings", {
        email: req.session.user.email,
        csrfToken: req.csrfToken(),
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        scoringModeOptions: SCORING_MODE_OPTIONS,
        absenceModeOptions: ABSENCE_MODE_OPTIONS,
        participationSymbolOptions: PARTICIPATION_SYMBOL_OPTIONS,
        setupComplete: pageData.setupComplete,
        showSetupFlow: !pageData.setupComplete,
        showConfigForm: true,
        profiles: pageData.profiles,
        activeProfile: pageData.activeProfile,
        selectedProfile: pageData.selectedProfile,
        selectedTotal: computeWeightsTotal(formData.weights),
        formData: pageData.formData,
        message: null,
        error: validationError
      });
    }

    const thresholdError = validateThresholds(thresholds);
    if (thresholdError) {
      const pageData = await buildSettingsPageData(teacherId, formData.profile_id, formData);
      return res.status(400).render("teacher/teacher-settings", {
        email: req.session.user.email,
        csrfToken: req.csrfToken(),
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        scoringModeOptions: SCORING_MODE_OPTIONS,
        absenceModeOptions: ABSENCE_MODE_OPTIONS,
        participationSymbolOptions: PARTICIPATION_SYMBOL_OPTIONS,
        setupComplete: pageData.setupComplete,
        showSetupFlow: !pageData.setupComplete,
        showConfigForm: true,
        profiles: pageData.profiles,
        activeProfile: pageData.activeProfile,
        selectedProfile: pageData.selectedProfile,
        selectedTotal: computeWeightsTotal(formData.weights),
        formData: pageData.formData,
        message: null,
        error: thresholdError
      });
    }

    const participationError = validateParticipationConfig(participation);
    if (participationError) {
      const pageData = await buildSettingsPageData(teacherId, formData.profile_id, formData);
      return res.status(400).render("teacher/teacher-settings", {
        email: req.session.user.email,
        csrfToken: req.csrfToken(),
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        scoringModeOptions: SCORING_MODE_OPTIONS,
        absenceModeOptions: ABSENCE_MODE_OPTIONS,
        participationSymbolOptions: PARTICIPATION_SYMBOL_OPTIONS,
        setupComplete: pageData.setupComplete,
        showSetupFlow: !pageData.setupComplete,
        showConfigForm: true,
        profiles: pageData.profiles,
        activeProfile: pageData.activeProfile,
        selectedProfile: pageData.selectedProfile,
        selectedTotal: computeWeightsTotal(formData.weights),
        formData: pageData.formData,
        message: null,
        error: participationError
      });
    }

    let profileId = null;
    let shouldSetActive = requestedSetActive;
    const profileExists =
      Number.isInteger(requestedProfileId) && requestedProfileId > 0
        ? await loadTeacherProfileById(requestedProfileId, teacherId)
        : null;

    if (!profileExists && existingProfiles.length === 0) {
      shouldSetActive = true;
    }

    if (profileExists) {
      await runAsync(
        `UPDATE teacher_grading_profiles
         SET name = ?, weight_mode = ?, scoring_mode = ?, absence_mode = ?, grade1_min_percent = ?, grade2_min_percent = ?, grade3_min_percent = ?, grade4_min_percent = ?, ma_enabled = ?, ma_weight = ?, ma_grade_plus = ?, ma_grade_plus_tilde = ?, ma_grade_neutral = ?, ma_grade_minus_tilde = ?, ma_grade_minus = ?, updated_at = current_timestamp
         WHERE id = ? AND teacher_id = ?`,
        [
          profileName,
          weightMode,
          scoringMode,
          absenceMode,
          thresholds.grade1_min_percent,
          thresholds.grade2_min_percent,
          thresholds.grade3_min_percent,
          thresholds.grade4_min_percent,
          participation.ma_enabled ? 1 : 0,
          participation.ma_weight,
          participation.ma_grade_plus,
          participation.ma_grade_plus_tilde,
          participation.ma_grade_neutral,
          participation.ma_grade_minus_tilde,
          participation.ma_grade_minus,
          profileExists.id,
          teacherId
        ]
      );
      profileId = profileExists.id;
    } else {
      const result = await runAsync(
        `INSERT INTO teacher_grading_profiles
         (teacher_id, name, weight_mode, scoring_mode, absence_mode, grade1_min_percent, grade2_min_percent, grade3_min_percent, grade4_min_percent, ma_enabled, ma_weight, ma_grade_plus, ma_grade_plus_tilde, ma_grade_neutral, ma_grade_minus_tilde, ma_grade_minus, is_active)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          teacherId,
          profileName,
          weightMode,
          scoringMode,
          absenceMode,
          thresholds.grade1_min_percent,
          thresholds.grade2_min_percent,
          thresholds.grade3_min_percent,
          thresholds.grade4_min_percent,
          participation.ma_enabled ? 1 : 0,
          participation.ma_weight,
          participation.ma_grade_plus,
          participation.ma_grade_plus_tilde,
          participation.ma_grade_neutral,
          participation.ma_grade_minus_tilde,
          participation.ma_grade_minus,
          shouldSetActive
        ]
      );
      profileId = result?.lastID;
    }

    if (!profileId) {
      throw new Error("Profil konnte nicht gespeichert werden.");
    }

    await runAsync("DELETE FROM teacher_grading_profile_items WHERE profile_id = ?", [profileId]);
    for (const category of TEMPLATE_CATEGORY_DEFINITIONS) {
      await runAsync(
        "INSERT INTO teacher_grading_profile_items (profile_id, category, weight) VALUES (?,?,?)",
        [profileId, category.key, Number(parsedWeights[category.key] || 0)]
      );
    }

    if (shouldSetActive) {
      await runAsync("UPDATE teacher_grading_profiles SET is_active = ? WHERE teacher_id = ?", [false, teacherId]);
      await runAsync(
        "UPDATE teacher_grading_profiles SET is_active = ?, updated_at = current_timestamp WHERE id = ? AND teacher_id = ?",
        [true, profileId, teacherId]
      );
    } else {
      const active = await getAsync(
        "SELECT id FROM teacher_grading_profiles WHERE teacher_id = ? AND is_active = ? LIMIT 1",
        [teacherId, true]
      );
      if (!active) {
        await runAsync(
          "UPDATE teacher_grading_profiles SET is_active = ?, updated_at = current_timestamp WHERE id = ? AND teacher_id = ?",
          [true, profileId, teacherId]
        );
      }
    }

    res.redirect(`/teacher/settings?saved=1&profile_id=${profileId}`);
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      const teacherId = req.session.user.id;
      const requestedProfileId = req.body?.profile_id ? Number(req.body.profile_id) : null;
      const formData = {
        profile_id: requestedProfileId || "",
        profile_name: String(req.body?.profile_name || "").trim(),
        weight_mode: WEIGHT_MODE_POINTS,
        scoring_mode: normalizeScoringMode(req.body?.scoring_mode),
        absence_mode: normalizeAbsenceMode(req.body?.absence_mode),
        thresholds: parseThresholdsFromBody(req.body || {}),
        participation: parseParticipationConfigFromBody(req.body || {}),
        set_active: req.body?.set_active === "1" || req.body?.set_active === "on",
        weights: mergeWeightsWithDefaults(parseWeightsFromBody(req.body || {}), WEIGHT_MODE_POINTS)
      };
      const pageData = await buildSettingsPageData(teacherId, requestedProfileId, formData);
      return res.status(409).render("teacher/teacher-settings", {
        email: req.session.user.email,
        csrfToken: req.csrfToken(),
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        scoringModeOptions: SCORING_MODE_OPTIONS,
        absenceModeOptions: ABSENCE_MODE_OPTIONS,
        participationSymbolOptions: PARTICIPATION_SYMBOL_OPTIONS,
        setupComplete: pageData.setupComplete,
        showSetupFlow: !pageData.setupComplete,
        showConfigForm: true,
        profiles: pageData.profiles,
        activeProfile: pageData.activeProfile,
        selectedProfile: pageData.selectedProfile,
        selectedTotal: computeWeightsTotal(formData.weights),
        formData: pageData.formData,
        message: null,
        error: "Profilname bereits vorhanden. Bitte einen anderen Namen wählen."
      });
    }
    next(err);
  }
});

router.post("/settings/activate-profile/:profileId", async (req, res, next) => {
  try {
    const teacherId = req.session.user.id;
    const profileId = Number(req.params.profileId);
    const profile = await loadTeacherProfileById(profileId, teacherId);
    if (!profile) {
      return renderError(res, req, "Profil nicht gefunden.", 404, "/teacher/settings");
    }

    await runAsync("UPDATE teacher_grading_profiles SET is_active = ? WHERE teacher_id = ?", [false, teacherId]);
    await runAsync(
      "UPDATE teacher_grading_profiles SET is_active = ?, updated_at = current_timestamp WHERE id = ? AND teacher_id = ?",
      [true, profileId, teacherId]
    );

    res.redirect(`/teacher/settings?profile_id=${profileId}&saved=1`);
  } catch (err) {
    next(err);
  }
});

router.post("/settings/delete-profile/:profileId", async (req, res, next) => {
  try {
    const teacherId = req.session.user.id;
    const profileId = Number(req.params.profileId);
    const profile = await loadTeacherProfileById(profileId, teacherId);
    if (!profile) {
      return renderError(res, req, "Profil nicht gefunden.", 404, "/teacher/settings");
    }

    await runAsync("DELETE FROM teacher_grading_profiles WHERE id = ? AND teacher_id = ?", [
      profileId,
      teacherId
    ]);

    if (profile.is_active) {
      const fallback = await getAsync(
        `SELECT id
         FROM teacher_grading_profiles
         WHERE teacher_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [teacherId]
      );
      if (fallback?.id) {
        await runAsync("UPDATE teacher_grading_profiles SET is_active = ? WHERE teacher_id = ?", [
          false,
          teacherId
        ]);
        await runAsync(
          "UPDATE teacher_grading_profiles SET is_active = ?, updated_at = current_timestamp WHERE id = ? AND teacher_id = ?",
          [true, fallback.id, teacherId]
        );
      }
    }

    res.redirect("/teacher/settings?deleted=1");
  } catch (err) {
    next(err);
  }
});

router.get("/students/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const qRaw = String(req.query.q || "").trim();
    const q = qRaw.slice(0, 120);
    const qFolded = foldText(q);
    const sortOptions = new Set(["name_asc", "name_desc", "email_asc", "email_desc"]);
    const sort = sortOptions.has(String(req.query.sort || ""))
      ? String(req.query.sort)
      : "name_asc";

    const studentsAll = await loadStudents(classId);
    let students = studentsAll.filter((entry) => {
      if (!qFolded) return true;
      const haystack = foldText(`${entry.name || ""} ${entry.email || ""}`);
      return haystack.includes(qFolded);
    });

    const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), "de", { sensitivity: "base" });
    students.sort((a, b) => {
      switch (sort) {
        case "name_desc":
          return compareText(b.name, a.name);
        case "email_asc":
          return compareText(a.email, b.email);
        case "email_desc":
          return compareText(b.email, a.email);
        case "name_asc":
        default:
          return compareText(a.name, b.name);
      }
    });
    const openMessageCount = await loadClassOpenMessageCount(classId);
    res.render("teacher/teacher-students", {
      email: req.session.user.email,
      classData,
      students,
      openMessageCount,
      totalStudentCount: studentsAll.length,
      search: { q, sort },
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/test-questions/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const messages = await loadClassGradeMessages(classId);
    const { messageThreads, openMessageCount } = groupClassMessageThreads(messages);
    res.render("teacher/teacher-test-questions", {
      email: req.session.user.email,
      classData,
      messageThreads,
      openMessageCount,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/students/:classId/messages/:messageId/reply", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const messageId = Number(req.params.messageId);
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }
    if (!messageId) {
      return renderError(res, req, "Ungültige Nachrichten-ID.", 400, `/teacher/test-questions/${classId}`);
    }

    const messageRow = await loadMessageForTeacher(classId, messageId, req.session.user.id);
    if (!messageRow) {
      return renderError(res, req, "Nachricht nicht gefunden.", 404, `/teacher/test-questions/${classId}`);
    }

    const reply = String(req.body?.reply || "").trim();
    if (!reply) {
      return renderError(res, req, "Bitte eine Antwort eingeben.", 400, `/teacher/test-questions/${classId}`);
    }
    if (reply.length > 1000) {
      return renderError(res, req, "Antwort darf maximal 1000 Zeichen lang sein.", 400, `/teacher/test-questions/${classId}`);
    }

    await runAsync(
      "UPDATE grade_messages SET teacher_reply = ?, replied_at = current_timestamp, teacher_reply_seen_at = NULL WHERE id = ?",
      [reply, messageId]
    );
    await runAsync(
      "INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)",
      [messageRow.student_id, "Lehrkraft hat auf deine Rückgabe-Nachricht geantwortet.", "info"]
    );
    res.redirect(`/teacher/test-questions/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/add-student/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const openMessageCount = await loadClassOpenMessageCount(classId);
    res.render("teacher/teacher-add-student", {
      email: req.session.user.email,
      classData,
      openMessageCount,
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/add-student/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const { name, email } = req.body || {};
    const resolvedEmail = String(email || "").trim();
    let resolvedName = String(name || "").trim();
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    if (!resolvedEmail) {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Bitte E-Mail angeben."
      });
    }
    if (!resolvedName) {
      const derived = deriveNameFromEmail(resolvedEmail);
      if (derived) {
        resolvedName = derived;
      } else {
        return res.status(400).render("teacher/teacher-add-student", {
          email: req.session.user.email,
          classData,
          csrfToken: req.csrfToken(),
          error: "Bitte Name angeben (oder E-Mail im Format vorname.nachname@xy)."
        });
      }
    }

    const userRow = await getAsync("SELECT id, role FROM users WHERE email = ?", [resolvedEmail]);
    if (!userRow || userRow.role !== "student") {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "E-Mail nicht gefunden oder nicht als SchǬler registriert."
      });
    }

    const duplicate = await getAsync("SELECT id FROM students WHERE email = ? AND class_id = ?", [resolvedEmail, classId]);
    if (duplicate) {
      return res.status(400).render("teacher/teacher-add-student", {
        email: req.session.user.email,
        classData,
        csrfToken: req.csrfToken(),
        error: "Dieser SchǬler ist bereits in der Klasse."
      });
    }

    await runAsync("INSERT INTO students (name, email, class_id) VALUES (?,?,?)", [resolvedName, resolvedEmail, classId]);
    res.redirect(`/teacher/students/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-student/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    await runAsync("DELETE FROM students WHERE id = ? AND class_id = ?", [studentId, classId]);
    res.redirect(`/teacher/students/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/grades/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const qRaw = String(req.query.q || "").trim();
    const q = qRaw.slice(0, 120);
    const qFolded = foldText(q);
    const statusOptions = new Set(["all", "with_grades", "no_grades", "incomplete"]);
    const status = statusOptions.has(String(req.query.status || ""))
      ? String(req.query.status)
      : "all";
    const sortOptions = new Set([
      "name_asc",
      "name_desc",
      "avg_best",
      "avg_worst",
      "grade_count_desc",
      "points_desc"
    ]);
    const sort = sortOptions.has(String(req.query.sort || ""))
      ? String(req.query.sort)
      : "name_asc";

    const studentsAll = await loadStudents(classId);
    const studentsBase = studentsAll.filter((entry) => {
      if (!qFolded) return true;
      const haystack = foldText(`${entry.name || ""} ${entry.email || ""}`);
      return haystack.includes(qFolded);
    });
    const templates = await loadTemplates(classId);
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    const participation = normalizeParticipationConfig(
      activeProfile?.participation || activeProfile || {}
    );
    const absenceMode = normalizeAbsenceMode(activeProfile?.absence_mode);
    const thresholds = normalizeThresholds(activeProfile?.thresholds || activeProfile || {});
    const openMessageCount = await loadClassOpenMessageCount(classId);
    const possibleCount = templates.length;
    const studentsWithGrades = await Promise.all(
      studentsBase.map(async (student) => {
        const grades = await loadStudentGrades(student.id);
        const participationMarks = await loadParticipationMarks(classId, student.id);
        const participationAverageRows = buildParticipationAverageRows(participationMarks, participation);
        const average = computeWeightedAverage([
          ...grades,
          ...participationAverageRows
        ], { absenceMode });
        const pointTotals = computePointTotalsWithParticipation(
          [...grades, ...participationAverageRows],
          { thresholds, absenceMode }
        );
        const hasPointTotals = pointTotals.max > 0;
        return {
          ...student,
          grade_count: grades.length,
          ma_count: participationMarks.length,
          average_grade: average,
          points_achieved_total: hasPointTotals ? Number(pointTotals.achieved.toFixed(2)) : null,
          points_max_total: hasPointTotals ? Number(pointTotals.max.toFixed(2)) : null,
          points_percent: hasPointTotals ? Number(((pointTotals.achieved / pointTotals.max) * 100).toFixed(2)) : null
        };
      })
    );

    const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), "de", { sensitivity: "base" });
    const compareNullableNumberAsc = (a, b) => {
      const va = Number(a);
      const vb = Number(b);
      const aValid = Number.isFinite(va);
      const bValid = Number.isFinite(vb);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return va - vb;
    };
    const compareNullableNumberDesc = (a, b) => -compareNullableNumberAsc(a, b);

    let studentsFiltered = studentsWithGrades.filter((student) => {
      const gradeCount = Number(student.grade_count || 0);
      const maCount = Number(student.ma_count || 0);
      if (status === "with_grades") return gradeCount > 0 || maCount > 0;
      if (status === "no_grades") return gradeCount === 0 && maCount === 0;
      if (status === "incomplete") return possibleCount > 0 && gradeCount < possibleCount;
      return true;
    });

    studentsFiltered.sort((a, b) => {
      switch (sort) {
        case "name_desc":
          return compareText(b.name, a.name);
        case "avg_best":
          return compareNullableNumberAsc(a.average_grade, b.average_grade) || compareText(a.name, b.name);
        case "avg_worst":
          return compareNullableNumberDesc(a.average_grade, b.average_grade) || compareText(a.name, b.name);
        case "grade_count_desc":
          return compareNullableNumberDesc(a.grade_count, b.grade_count) || compareText(a.name, b.name);
        case "points_desc":
          return compareNullableNumberDesc(a.points_percent, b.points_percent) || compareText(a.name, b.name);
        case "name_asc":
        default:
          return compareText(a.name, b.name);
      }
    });

    res.render("teacher/teacher-grades", {
      email: req.session.user.email,
      classData,
      students: studentsFiltered,
      totalStudentCount: studentsAll.length,
      possibleCount,
      activeProfile,
      participationEnabled: participation.ma_enabled,
      participationSymbolOptions: PARTICIPATION_SYMBOL_OPTIONS,
      search: { q, status, sort },
      message: req.query.ma_saved ? "Mitarbeit eingetragen." : null,
      openMessageCount,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/grades/:classId/participation", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    if (!activeProfile) {
      return res.redirect("/teacher/settings?setup=1");
    }
    const participation = normalizeParticipationConfig(
      activeProfile.participation || activeProfile
    );
    if (!participation.ma_enabled || participation.ma_weight <= 0) {
      return res.redirect(`/teacher/grades/${classId}`);
    }

    const studentId = Number(req.body?.student_id);
    const symbol = normalizeParticipationSymbol(req.body?.ma_symbol);
    const note = String(req.body?.ma_note || "").trim();

    const students = await loadStudents(classId);
    const student = students.find((entry) => Number(entry.id) === studentId);
    if (!student || !symbol) {
      return res.redirect(`/teacher/grades/${classId}`);
    }

    await runAsync(
      "INSERT INTO participation_marks (student_id, class_id, teacher_id, symbol, note) VALUES (?,?,?,?,?)",
      [student.id, classId, req.session.user.id, symbol, note || null]
    );
    await runAsync("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [
      student.id,
      "Neue Mitarbeit eingetragen.",
      "grade"
    ]);

    res.redirect(`/teacher/grades/${classId}?ma_saved=1`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-participation/:classId/:studentId/:markId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const markId = req.params.markId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const participationMarks = await loadParticipationMarks(classId, student.id);
    const targetMark = participationMarks.find((entry) => String(entry.id) === String(markId));
    if (!targetMark) {
      return renderError(
        res,
        req,
        "Mitarbeitseintrag nicht gefunden.",
        404,
        `/teacher/student-grades/${classId}/${studentId}`
      );
    }

    await runAsync(
      "DELETE FROM participation_marks WHERE id = ? AND class_id = ? AND student_id = ?",
      [markId, classId, student.id]
    );
    res.redirect(`/teacher/student-grades/${classId}/${studentId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/student-grades/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const gradeRows = await loadStudentGrades(student.id);
    const openMessageCount = await loadClassOpenMessageCount(classId);
    const gradeMessages = await loadStudentGradeMessages(classId, student.id);
    const messagesByGrade = new Map();
    gradeMessages.forEach((message) => {
      const key = String(message.grade_id);
      const list = messagesByGrade.get(key) || [];
      list.push({
        id: message.id,
        student_message: message.student_message,
        teacher_reply: message.teacher_reply || null,
        created_at: message.created_at,
        replied_at: message.replied_at || null
      });
      messagesByGrade.set(key, list);
    });
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    const participationConfig = normalizeParticipationConfig(
      activeProfile?.participation || activeProfile || {}
    );
    const absenceMode = normalizeAbsenceMode(activeProfile?.absence_mode);
    const thresholds = normalizeThresholds(activeProfile?.thresholds || activeProfile || {});
    const participationMarks = await loadParticipationMarks(classId, student.id);
    const fallbackMode = resolveWeightMode(activeProfile?.weight_mode);
    const grades = gradeRows.map((row) => {
      const hasAttachment = Boolean(row.attachment_path);
      const resolvedWeightMode = row.is_special ? fallbackMode : resolveWeightMode(row.weight_mode);
      const pointsAchieved = Number(row.points_achieved);
      const pointsMax = Number(row.points_max);
      const hasPoints = Number.isFinite(pointsAchieved) && Number.isFinite(pointsMax) && pointsMax > 0;
      const pointsPercent = hasPoints ? Number(((pointsAchieved / pointsMax) * 100).toFixed(2)) : null;
      const messages = row.is_special ? [] : messagesByGrade.get(String(row.id)) || [];
      return {
        id: row.id,
        grade: row.grade,
        points_achieved: hasPoints ? pointsAchieved : null,
        points_max: hasPoints ? pointsMax : null,
        points_percent: pointsPercent,
        note: row.note,
        is_absent: Boolean(row.is_absent),
        category: row.category,
        weight: row.weight,
        weight_mode: resolvedWeightMode,
        weight_label: formatWeightLabel(row.weight, resolvedWeightMode),
        template_name: row.name,
        template_date: row.date,
        is_special: Boolean(row.is_special),
        has_attachment: hasAttachment,
        attachment_name: row.attachment_original_name || null,
        attachment_delete_action: hasAttachment
          ? `/teacher/delete-grade-attachment/${classId}/${row.id}`
          : null,
        messages,
        open_message_count: messages.filter((message) => !message.teacher_reply).length,
        delete_action: row.is_special
          ? `/teacher/delete-special-assessment/${classId}/${row.id}`
          : `/teacher/delete-grade/${classId}/${row.id}`
      };
    });
    const participationAverageRows = buildParticipationAverageRows(
      participationMarks,
      participationConfig
    );
    const participationEntries = (participationMarks || [])
      .map((mark) => {
        const gradeValue = getParticipationGrade(mark.symbol, participationConfig);
        if (!Number.isFinite(gradeValue)) return null;
        return {
          id: mark.id,
          symbol: normalizeParticipationSymbol(mark.symbol),
          symbol_label: getParticipationSymbolLabel(mark.symbol),
          note: mark.note || "",
          created_at: mark.created_at,
          grade: Number(gradeValue.toFixed(2)),
          weight: Number(participationConfig.ma_weight || 0),
          weight_label: formatWeightLabel(participationConfig.ma_weight, WEIGHT_MODE_POINTS)
        };
      })
      .filter(Boolean);
    const wishGradeRows = [
      ...gradeRows.map((row) => ({
        grade: Number(row.grade),
        weight: Number(row.weight || 0),
        is_absent: Boolean(row.is_absent),
        source: "grade"
      })),
      ...participationAverageRows.map((row) => ({
        grade: Number(row.grade),
        weight: Number(row.weight || 0),
        source: "participation"
      }))
    ]
      .filter((row) => !shouldSkipGradeForAbsence(row, absenceMode))
      .filter(
        (row) =>
          isValidGradeValue(row.grade) &&
          isValidWeightValue(row.weight) &&
          Number(row.weight) > 0
      );

    const average = computeWeightedAverage([...gradeRows, ...participationAverageRows], {
      absenceMode
    });
    const studentPointTotals = computePointTotalsWithParticipation(
      [...gradeRows, ...participationAverageRows],
      { thresholds, absenceMode }
    );
    const pointsSummary =
      studentPointTotals.max > 0
        ? {
            achieved: Number(studentPointTotals.achieved.toFixed(2)),
            max: Number(studentPointTotals.max.toFixed(2)),
            percent: Number(((studentPointTotals.achieved / studentPointTotals.max) * 100).toFixed(2))
          }
        : null;

    res.render("teacher/teacher-student-grades", {
      email: req.session.user.email,
      classData,
      student,
      grades,
      participationEnabled: participationConfig.ma_enabled && participationConfig.ma_weight > 0,
      participationEntries,
      wishGradeRows,
      average,
      pointsSummary,
      activeWeightMode: fallbackMode,
      openMessageCount,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/student-grades/:classId/:studentId/details", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const gradeRows = await loadStudentGrades(student.id);
    const templates = await loadTemplates(classId);
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    const participationConfig = normalizeParticipationConfig(
      activeProfile?.participation || activeProfile || {}
    );
    const participationMarks = await loadParticipationMarks(classId, student.id);
    const absenceMode = normalizeAbsenceMode(activeProfile?.absence_mode);
    const thresholds = normalizeThresholds(activeProfile?.thresholds || activeProfile || {});
    const scoringMode = normalizeScoringMode(activeProfile?.scoring_mode);
    const participationEnabledForAverage =
      participationConfig.ma_enabled && Number(participationConfig.ma_weight) > 0;

    const detailRows = [];

    gradeRows.forEach((row, index) => {
      const gradeValue = Number(row.grade);
      const rawWeight = Number(row.weight);
      const effectiveWeight = row.weight == null ? 1 : Number(row.weight);
      const isAbsent = Boolean(row.is_absent);
      const skippedForAbsence = shouldSkipGradeForAbsence({ is_absent: isAbsent }, absenceMode);
      const hasValidGrade = isValidGradeValue(gradeValue);
      const hasValidWeight = isValidWeightValue(effectiveWeight);
      const included = !skippedForAbsence && hasValidGrade && hasValidWeight;
      const contributionValue = included ? gradeValue * effectiveWeight : 0;
      const pointsAchieved = Number(row.points_achieved);
      const pointsMax = Number(row.points_max);
      const hasPoints = Number.isFinite(pointsAchieved) && Number.isFinite(pointsMax) && pointsMax > 0;
      const pointsPercent = hasPoints ? Number(((pointsAchieved / pointsMax) * 100).toFixed(2)) : null;
      const gradeFromPoints =
        pointsPercent != null ? buildGradeFromPercent(pointsPercent, thresholds) : null;

      let includeReason = "Gewichtet in Gesamtnote.";
      if (skippedForAbsence) {
        includeReason = "Nicht gewichtet (Abwesenheit laut Profil).";
      } else if (!hasValidGrade) {
        includeReason = "Nicht gewichtet (ungültige Note).";
      } else if (!hasValidWeight) {
        includeReason = "Nicht gewichtet (ungültige Gewichtung).";
      }

      detailRows.push({
        source_type: Boolean(row.is_special) ? "Sonderleistung" : "Prüfung",
        source_name: row.name || (Boolean(row.is_special) ? "Sonderleistung" : "Prüfung"),
        category: row.category || "-",
        created_at: row.created_at || null,
        exam_date: row.date || null,
        note: row.note || "",
        is_absent: isAbsent,
        included,
        include_reason: includeReason,
        grade: hasValidGrade ? Number(gradeValue.toFixed(2)) : null,
        raw_weight: isValidWeightValue(rawWeight) ? Number(rawWeight.toFixed(2)) : null,
        effective_weight: hasValidWeight ? Number(effectiveWeight.toFixed(2)) : null,
        contribution: contributionValue,
        points_achieved: hasPoints ? Number(pointsAchieved.toFixed(2)) : null,
        points_max: hasPoints ? Number(pointsMax.toFixed(2)) : null,
        points_percent: pointsPercent,
        grade_from_points: Number.isFinite(gradeFromPoints) ? gradeFromPoints : null,
        symbol_label: null,
        row_origin: "grade",
        sort_index: index
      });
    });

    participationMarks.forEach((mark, index) => {
      const mappedGrade = getParticipationGrade(mark.symbol, participationConfig);
      const gradeValue = Number(mappedGrade);
      const rawWeight = Number(participationConfig.ma_weight);
      const effectiveWeight = participationConfig.ma_weight == null ? 1 : Number(participationConfig.ma_weight);
      const hasValidGrade = isValidGradeValue(gradeValue);
      const hasValidWeight = isValidWeightValue(effectiveWeight);
      const included = participationEnabledForAverage && hasValidGrade && hasValidWeight;
      const contributionValue = included ? gradeValue * effectiveWeight : 0;
      const symbolLabel = getParticipationSymbolLabel(mark.symbol);
      const estimatedPercent = hasValidGrade
        ? mapGradeToEstimatedPercent(gradeValue, thresholds)
        : null;
      const hasEstimatedPoints = hasValidWeight && Number.isFinite(estimatedPercent);
      const estimatedPointsMax = hasEstimatedPoints ? Number(effectiveWeight.toFixed(2)) : null;
      const estimatedPointsAchieved = hasEstimatedPoints
        ? Number((effectiveWeight * (estimatedPercent / 100)).toFixed(2))
        : null;

      let includeReason = "Gewichtet in Gesamtnote.";
      if (!participationEnabledForAverage) {
        includeReason = "Nicht gewichtet (MA im Profil deaktiviert oder Gewichtung 0).";
      } else if (!hasValidGrade) {
        includeReason = "Nicht gewichtet (Symbol nicht im MA-Schema).";
      } else if (!hasValidWeight) {
        includeReason = "Nicht gewichtet (ungültige MA-Gewichtung).";
      }

      detailRows.push({
        source_type: "Mitarbeit",
        source_name: `MA ${symbolLabel}`,
        category: "Mitarbeit",
        created_at: mark.created_at || null,
        exam_date: null,
        note: mark.note || "",
        is_absent: false,
        included,
        include_reason: includeReason,
        grade: hasValidGrade ? Number(gradeValue.toFixed(2)) : null,
        raw_weight: isValidWeightValue(rawWeight) ? Number(rawWeight.toFixed(2)) : null,
        effective_weight: hasValidWeight ? Number(effectiveWeight.toFixed(2)) : null,
        contribution: contributionValue,
        points_achieved: estimatedPointsAchieved,
        points_max: estimatedPointsMax,
        points_percent: hasEstimatedPoints ? Number(estimatedPercent.toFixed(2)) : null,
        grade_from_points: null,
        symbol_label: symbolLabel,
        row_origin: "participation",
        sort_index: gradeRows.length + index
      });
    });

    const sortedRows = detailRows
      .map((row) => {
        const timeValue = row.created_at ? new Date(row.created_at).getTime() : Number.POSITIVE_INFINITY;
        return {
          ...row,
          sort_time: Number.isFinite(timeValue) ? timeValue : Number.POSITIVE_INFINITY
        };
      })
      .sort((a, b) => {
        if (a.sort_time === b.sort_time) return a.sort_index - b.sort_index;
        return a.sort_time - b.sort_time;
      });

    let runningWeightedSum = 0;
    let runningWeightTotal = 0;
    const calculationRows = sortedRows.map((row, index) => {
      if (row.included) {
        runningWeightedSum += Number(row.contribution || 0);
        runningWeightTotal += Number(row.effective_weight || 0);
      }
      const runningAverage =
        runningWeightTotal > 0 ? Number((runningWeightedSum / runningWeightTotal).toFixed(4)) : null;
      return {
        ...row,
        step: index + 1,
        running_weighted_sum: Number(runningWeightedSum.toFixed(4)),
        running_weight_total: Number(runningWeightTotal.toFixed(4)),
        running_average: runningAverage
      };
    });

    const participationAverageRows = buildParticipationAverageRows(
      participationMarks,
      participationConfig
    );
    const referenceAverage = computeWeightedAverage([...gradeRows, ...participationAverageRows], {
      absenceMode
    });

    const summary = {
      included_count: calculationRows.filter((row) => row.included).length,
      excluded_count: calculationRows.filter((row) => !row.included).length,
      weighted_sum: Number(runningWeightedSum.toFixed(4)),
      weight_total: Number(runningWeightTotal.toFixed(4)),
      average: runningWeightTotal > 0 ? Number((runningWeightedSum / runningWeightTotal).toFixed(2)) : null,
      reference_average: referenceAverage
    };
    const detailPointTotals = computePointTotalsWithParticipation(
      [...gradeRows, ...participationAverageRows],
      { thresholds, absenceMode }
    );
    summary.points_achieved_total =
      detailPointTotals.max > 0 ? Number(detailPointTotals.achieved.toFixed(2)) : null;
    summary.points_max_total = detailPointTotals.max > 0 ? Number(detailPointTotals.max.toFixed(2)) : null;
    summary.points_percent =
      detailPointTotals.max > 0
        ? Number(((detailPointTotals.achieved / detailPointTotals.max) * 100).toFixed(2))
        : null;

    const gradedTemplateIds = new Set(
      gradeRows
        .filter((row) => !row.is_special && row.template_id != null)
        .map((row) => String(row.template_id))
    );
    const openTemplates = templates
      .filter((template) => !gradedTemplateIds.has(String(template.id)))
      .map((template) => ({
        id: template.id,
        name: template.name,
        category: template.category,
        weight_label: template.weight_label || formatWeightLabel(template.weight, template.weight_mode),
        max_points: template.max_points != null ? Number(template.max_points) : null,
        date: template.date || null,
        description: template.description || ""
      }));

    const participationScale = PARTICIPATION_SYMBOL_OPTIONS.map((option) => ({
      symbol: option.label,
      grade: getParticipationGrade(option.value, participationConfig)
    }));

    const exportFormat = String(req.query.format || "").toLowerCase();
    if (exportFormat === "csv_raw" || exportFormat === "csv_rechenweg") {
      const csvLines = [];
      const pushCsv = (row) => csvLines.push(row.map(escapeCsvValue).join(","));
      const fileNameSafeStudent = String(student.name || "schueler")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 80);

      pushCsv(["Sektion", "Schluessel", "Wert"]);
      pushCsv(["Meta", "Klasse", classData.name || ""]);
      pushCsv(["Meta", "Schüler", student.name || ""]);
      pushCsv(["Meta", "Fach", classData.subject || ""]);
      csvLines.push("");

      if (exportFormat === "csv_raw") {
        pushCsv([
          "Rohdaten",
          "Schritt",
          "Typ",
          "Bezeichnung",
          "Kategorie",
          "Erfasst am",
          "Prüfungsdatum",
          "Note",
          "Gewicht roh",
          "Gewicht effektiv",
          "Beitrag",
          "Punkte erreicht",
          "Punkte max",
          "Punkte Prozent",
          "Punkte->Note",
          "Abwesend",
          "Gewichtet",
          "Grund",
          "Notiz"
        ]);
        calculationRows.forEach((row) => {
          pushCsv([
            "Rohdaten",
            row.step,
            row.source_type,
            row.source_name,
            row.category,
            row.created_at || "",
            row.exam_date || "",
            row.grade != null ? Number(row.grade).toFixed(2) : "",
            row.raw_weight != null ? Number(row.raw_weight).toFixed(2) : "",
            row.effective_weight != null ? Number(row.effective_weight).toFixed(2) : "",
            row.contribution != null ? Number(row.contribution).toFixed(4) : "",
            row.points_achieved != null ? row.points_achieved : "",
            row.points_max != null ? row.points_max : "",
            row.points_percent != null ? Number(row.points_percent).toFixed(2) : "",
            row.grade_from_points != null ? Number(row.grade_from_points).toFixed(2) : "",
            row.is_absent ? "Ja" : "Nein",
            row.included ? "Ja" : "Nein",
            row.include_reason,
            row.note || ""
          ]);
        });

        const csvContent = csvLines.join("\n");
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=rohdaten_${fileNameSafeStudent}.csv`
        );
        return res.send(csvContent);
      }

      pushCsv([
        "Rechenweg",
        "Schritt",
        "Quelle",
        "Gewichtet",
        "Note",
        "Gewicht effektiv",
        "Beitrag",
        "Laufende Summe",
        "Laufendes Gewicht",
        "Laufender Schnitt"
      ]);
      calculationRows.forEach((row) => {
        pushCsv([
          "Rechenweg",
          row.step,
          `${row.source_type}: ${row.source_name}`,
          row.included ? "Ja" : "Nein",
          row.grade != null ? Number(row.grade).toFixed(2) : "",
          row.effective_weight != null ? Number(row.effective_weight).toFixed(2) : "",
          row.contribution != null ? Number(row.contribution).toFixed(4) : "",
          row.running_weighted_sum != null ? Number(row.running_weighted_sum).toFixed(4) : "",
          row.running_weight_total != null ? Number(row.running_weight_total).toFixed(4) : "",
          row.running_average != null ? Number(row.running_average).toFixed(4) : ""
        ]);
      });

      const csvContent = csvLines.join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=rechenweg_${fileNameSafeStudent}.csv`
      );
      return res.send(csvContent);
    }

    res.render("teacher/teacher-student-grade-details", {
      email: req.session.user.email,
      classData,
      student,
      activeProfile,
      profileInfo: {
        scoring_mode: scoringMode,
        scoring_mode_label: getScoringModeLabel(scoringMode),
        absence_mode: absenceMode,
        absence_mode_label:
          absenceMode === ABSENCE_MODE_EXCLUDE
            ? "Nicht gewichten (neutral)"
            : "Mit 0% werten (schlechteste Leistung)",
        thresholds,
        participation: participationConfig
      },
      participationScale,
      calculationRows,
      openTemplates,
      summary,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/delete-grade/:classId/:gradeId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const gradeId = req.params.gradeId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const gradeRow = await getAsync(
      "SELECT attachment_path FROM grades WHERE id = ? AND class_id = ?",
      [gradeId, classId]
    );
    await runAsync("DELETE FROM grades WHERE id = ? AND class_id = ?", [gradeId, classId]);
    await removeStoredAttachment(gradeRow?.attachment_path);
    const backUrl = req.get("referer") || `/teacher/grades/${classId}`;
    res.redirect(backUrl);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-grade-attachment/:classId/:gradeId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const gradeId = req.params.gradeId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const gradeRow = await getAsync(
      "SELECT attachment_path FROM grades WHERE id = ? AND class_id = ?",
      [gradeId, classId]
    );
    if (!gradeRow) {
      return renderError(res, req, "Note nicht gefunden.", 404, `/teacher/student-grades/${classId}`);
    }

    await runAsync(
      "UPDATE grades SET attachment_path = NULL, attachment_original_name = NULL, attachment_mime = NULL, attachment_size = NULL WHERE id = ? AND class_id = ?",
      [gradeId, classId]
    );
    await removeStoredAttachment(gradeRow.attachment_path);

    const backUrl = req.get("referer") || `/teacher/grades/${classId}`;
    res.redirect(backUrl);
  } catch (err) {
    next(err);
  }
});

router.get("/add-grade/:classId/:studentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const templates = await loadTemplates(classId);
    const gradedTemplateIds = await loadGradedTemplateIdsForStudent(classId, student.id);
    return renderAddGradeForm(req, res, {
      classData,
      student,
      templates,
      gradedTemplateIds,
      formData: {}
    });
  } catch (err) {
    next(err);
  }
});

router.post("/add-grade/:classId/:studentId", handleUpload, async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const studentId = req.params.studentId;
    const {
      grade_template_id,
      grade,
      points_achieved,
      note,
      external_link,
      is_absent
    } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      await removeUploadedFile(req.file);
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const student = students.find((entry) => String(entry.id) === String(studentId));
    if (!student) {
      await removeUploadedFile(req.file);
      return renderError(res, req, "Schüler nicht gefunden.", 404, `/teacher/students/${classId}`);
    }

    const templates = await loadTemplates(classId);
    const gradedTemplateIds = await loadGradedTemplateIdsForStudent(classId, student.id);
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    if (!activeProfile) {
      await removeUploadedFile(req.file);
      return res.redirect("/teacher/settings?setup=1");
    }

    const scoringMode = normalizeScoringMode(activeProfile.scoring_mode);
    const absenceMode = normalizeAbsenceMode(activeProfile.absence_mode);
    const thresholds = normalizeThresholds(activeProfile.thresholds || activeProfile);
    const gradeInput = parseOptionalNumber(grade);
    const pointsAchievedInput = parseOptionalNumber(points_achieved);
    const hasGrade = gradeInput.provided;
    const hasPoints = pointsAchievedInput.provided;
    const isAbsent =
      is_absent === true ||
      is_absent === 1 ||
      is_absent === "1" ||
      is_absent === "true" ||
      is_absent === "on";
    const formData = req.body || {};

    const renderValidationError = async (status, error) => {
      await removeUploadedFile(req.file);
      return renderAddGradeForm(req, res, {
        status,
        classData,
        student,
        templates,
        gradedTemplateIds,
        formData,
        error
      });
    };

    if (!grade_template_id) {
      return renderValidationError(400, "Bitte eine Prüfung auswählen.");
    }

    if (hasGrade && (!Number.isFinite(gradeInput.value) || gradeInput.value < 1 || gradeInput.value > 5)) {
      return renderValidationError(400, "Note muss zwischen 1 und 5 liegen.");
    }

    if (hasPoints && (!Number.isFinite(pointsAchievedInput.value) || pointsAchievedInput.value < 0)) {
      return renderValidationError(400, "Erreichte Punkte muessen mindestens 0 sein.");
    }

    const templateRow = await getAsync(
      "SELECT id, max_points FROM grade_templates WHERE id = ? AND class_id = ?",
      [grade_template_id, classId]
    );
    if (!templateRow) {
      return renderValidationError(400, "Prüfungsvorlage nicht gefunden.");
    }
    const templateMaxPointsRaw = Number(templateRow.max_points);
    const templateHasMaxPoints =
      Number.isFinite(templateMaxPointsRaw) && templateMaxPointsRaw > 0;

    if (hasPoints && !templateHasMaxPoints) {
      return renderValidationError(
        400,
        "Diese Prüfung hat keine maximalen Punkte. Bitte in der Prüfungsvorlage setzen."
      );
    }

    if (hasPoints && templateHasMaxPoints && pointsAchievedInput.value > templateMaxPointsRaw) {
      return renderValidationError(
        400,
        `Erreichte Punkte duerfen die maximalen Punkte (${templateMaxPointsRaw}) nicht uebersteigen.`
      );
    }

    const hasCompletePoints = hasPoints && templateHasMaxPoints;

    if (!isAbsent) {
      if (scoringMode === SCORING_MODE_GRADE_ONLY && !hasGrade) {
        return renderValidationError(400, "Dieses Profil verlangt eine Note.");
      }
      if (scoringMode === SCORING_MODE_POINTS_ONLY && !hasCompletePoints) {
        return renderValidationError(
          400,
          templateHasMaxPoints
            ? "Dieses Profil verlangt Punkte."
            : "Dieses Profil verlangt Punkte. Bitte zuerst maximale Punkte in der Prüfungsvorlage setzen."
        );
      }
      if (scoringMode === SCORING_MODE_POINTS_AND_GRADE && (!hasGrade || !hasCompletePoints)) {
        return renderValidationError(
          400,
          templateHasMaxPoints
            ? "Dieses Profil verlangt Punkte und Note."
            : "Dieses Profil verlangt Punkte und Note. Bitte zuerst maximale Punkte in der Prüfungsvorlage setzen."
        );
      }
      if (scoringMode === SCORING_MODE_POINTS_OR_GRADE && !hasGrade && !hasCompletePoints) {
        return renderValidationError(
          400,
          templateHasMaxPoints
            ? "Bitte mindestens Note oder Punkte angeben."
            : "Bitte mindestens eine Note angeben oder maximale Punkte in der Prüfungsvorlage setzen."
        );
      }
    }

    const linkResult = normalizeExternalLink(external_link);
    if (linkResult.error) {
      return renderValidationError(400, linkResult.error);
    }

    if (req.file && linkResult.value) {
      return renderValidationError(
        400,
        "Bitte entweder eine Datei hochladen oder einen Link angeben, nicht beides."
      );
    }

    let resolvedPointsAchieved = null;
    let resolvedPointsMax = null;
    let resolvedGrade = null;

    if (isAbsent) {
      if (absenceMode === ABSENCE_MODE_INCLUDE_ZERO) {
        if (!templateHasMaxPoints) {
          return renderValidationError(
            400,
            "Fuer 'Mit 0% werten' braucht die Prüfung maximale Punkte in der Vorlage."
          );
        }
        resolvedPointsAchieved = 0;
        resolvedPointsMax = templateMaxPointsRaw;
      }
      resolvedGrade = 5;
    } else {
      resolvedPointsAchieved = hasCompletePoints ? Number(pointsAchievedInput.value) : null;
      resolvedPointsMax = hasCompletePoints ? Number(templateMaxPointsRaw) : null;
      resolvedGrade = hasGrade ? Number(gradeInput.value) : null;

      if (resolvedGrade == null && resolvedPointsAchieved != null && resolvedPointsMax != null) {
        const percent = (resolvedPointsAchieved / resolvedPointsMax) * 100;
        resolvedGrade = buildGradeFromPercent(percent, thresholds);
      }
    }

    if (!Number.isFinite(resolvedGrade) || resolvedGrade < 1 || resolvedGrade > 5) {
      return renderValidationError(400, "Note konnte nicht berechnet werden.");
    }

    const attachmentPath = req.file ? req.file.filename : null;
    const attachmentOriginalName = req.file ? sanitizeFilename(req.file.originalname) : null;
    const attachmentMime = req.file ? req.file.mimetype : null;
    const attachmentSize = req.file ? req.file.size : null;

    try {
      await runAsync(
        "INSERT INTO grades (student_id, class_id, grade_template_id, grade, points_achieved, points_max, note, attachment_path, attachment_original_name, attachment_mime, attachment_size, external_link, is_absent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          studentId,
          classId,
          grade_template_id,
          resolvedGrade,
          resolvedPointsAchieved,
          resolvedPointsMax,
          String(note || "").trim() || null,
          attachmentPath,
          attachmentOriginalName,
          attachmentMime,
          attachmentSize,
          linkResult.value,
          isAbsent ? 1 : 0
        ]
      );
      await runAsync("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [
        studentId,
        "Neue Note eingetragen.",
        "grade"
      ]);
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        await removeUploadedFile(req.file);
        return renderAddGradeForm(req, res, {
          status: 409,
          classData,
          student,
          templates,
          gradedTemplateIds,
          formData,
          error: "Diese Prüfung wurde bereits benotet."
        });
      }
      throw err;
    }

    res.redirect(`/teacher/student-grades/${classId}/${studentId}`);
  } catch (err) {
    await removeUploadedFile(req.file);
    next(err);
  }
});

router.get("/grade-templates/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const qRaw = String(req.query.q || "").trim();
    const q = qRaw.slice(0, 120);
    const qFolded = foldText(q);
    const categoryParam = String(req.query.category || "").trim();
    const category = normalizeCategoryKey(categoryParam) || "";
    const pointsFilterOptions = new Set(["all", "with_max", "without_max"]);
    const pointsFilter = pointsFilterOptions.has(String(req.query.points || ""))
      ? String(req.query.points)
      : "all";
    const sortOptions = new Set([
      "date_desc",
      "date_asc",
      "name_asc",
      "name_desc",
      "weight_desc",
      "weight_asc",
      "max_desc",
      "max_asc",
      "category_asc"
    ]);
    const sort = sortOptions.has(String(req.query.sort || ""))
      ? String(req.query.sort)
      : "date_desc";

    const templatesAll = (await loadTemplates(classId)).map((template) => {
      const categoryKey = normalizeCategoryKey(template.category);
      const categorySlug = categoryKey
        ? (CATEGORY_BY_KEY.get(categoryKey)?.slug || "")
        : "";
      return {
        ...template,
        category_key: categoryKey || "",
        category_slug: categorySlug
      };
    });

    let templates = templatesAll.filter((template) => {
      if (category && template.category_key !== category) return false;
      const hasMaxPoints = template.max_points != null && Number(template.max_points) > 0;
      if (pointsFilter === "with_max" && !hasMaxPoints) return false;
      if (pointsFilter === "without_max" && hasMaxPoints) return false;
      if (!qFolded) return true;
      const dateLabel = template.date ? new Date(template.date).toLocaleDateString("de-DE") : "";
      const haystack = foldText(
        `${template.name || ""} ${template.category || ""} ${template.description || ""} ${dateLabel}`
      );
      return haystack.includes(qFolded);
    });

    const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), "de", { sensitivity: "base" });
    const compareNullableNumberAsc = (a, b) => {
      const va = Number(a);
      const vb = Number(b);
      const aValid = Number.isFinite(va);
      const bValid = Number.isFinite(vb);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return va - vb;
    };
    const compareNullableDateAsc = (a, b) => {
      const ta = a ? new Date(a).getTime() : NaN;
      const tb = b ? new Date(b).getTime() : NaN;
      const aValid = Number.isFinite(ta);
      const bValid = Number.isFinite(tb);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return ta - tb;
    };

    templates.sort((a, b) => {
      switch (sort) {
        case "date_asc":
          return compareNullableDateAsc(a.date, b.date) || compareText(a.name, b.name);
        case "name_asc":
          return compareText(a.name, b.name);
        case "name_desc":
          return compareText(b.name, a.name);
        case "weight_desc":
          return -compareNullableNumberAsc(a.weight, b.weight) || compareText(a.name, b.name);
        case "weight_asc":
          return compareNullableNumberAsc(a.weight, b.weight) || compareText(a.name, b.name);
        case "max_desc":
          return -compareNullableNumberAsc(a.max_points, b.max_points) || compareText(a.name, b.name);
        case "max_asc":
          return compareNullableNumberAsc(a.max_points, b.max_points) || compareText(a.name, b.name);
        case "category_asc":
          return compareText(a.category, b.category) || compareText(a.name, b.name);
        case "date_desc":
        default:
          return -compareNullableDateAsc(a.date, b.date) || compareText(a.name, b.name);
      }
    });

    const openMessageCount = await loadClassOpenMessageCount(classId);
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    const totalPointWeight = Number(
      templatesAll.reduce((sum, template) => sum + Number(template.weight || 0), 0).toFixed(2)
    );

    res.render("teacher/teacher-grade-templates", {
      email: req.session.user.email,
      classData,
      templates,
      totalTemplateCount: templatesAll.length,
      categoryOptions: TEMPLATE_CATEGORY_DEFINITIONS.map((entry) => ({
        key: entry.key,
        label: entry.label
      })),
      search: { q, category, points: pointsFilter, sort },
      activeProfile,
      totalPointWeight,
      openMessageCount,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.get("/create-template/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    if (!activeProfile) {
      return res.redirect("/teacher/settings?setup=1");
    }

    const openMessageCount = await loadClassOpenMessageCount(classId);
    res.render("teacher/teacher-create-template", {
      email: req.session.user.email,
      classData,
      activeProfile,
      categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
      formData: {
        name: "",
        category: "",
        weight: "",
        max_points: "",
        date: "",
        description: ""
      },
      openMessageCount,
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/create-template/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const { name, category, weight, max_points, date, description } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    if (!activeProfile) {
      return res.redirect("/teacher/settings?setup=1");
    }

    const normalizedCategory = normalizeCategoryKey(category);
    const profileSuggestedWeight = normalizedCategory
      ? Number(activeProfile.weights?.[normalizedCategory])
      : NaN;
    const rawWeightValue = parseNumericInput(weight);
    const weightValue = Number.isFinite(rawWeightValue) ? rawWeightValue : profileSuggestedWeight;
    const parsedMaxPoints = parseNumericInput(max_points);
    const hasMaxPointsInput = String(max_points || "").trim() !== "";
    const maxPointsValue = hasMaxPointsInput ? parsedMaxPoints : null;
    const formData = {
      name: name || "",
      category: normalizedCategory || category || "",
      weight: Number.isFinite(rawWeightValue) ? rawWeightValue : "",
      max_points: hasMaxPointsInput ? max_points : "",
      date: date || "",
      description: description || ""
    };

    if (!name || !normalizedCategory || !Number.isFinite(weightValue)) {
      return res.status(400).render("teacher/teacher-create-template", {
        email: req.session.user.email,
        classData,
        activeProfile,
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        formData,
        csrfToken: req.csrfToken(),
        error: "Bitte alle Pflichtfelder ausfüllen."
      });
    }
    if (weightValue < 0) {
      return res.status(400).render("teacher/teacher-create-template", {
        email: req.session.user.email,
        classData,
        activeProfile,
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        formData: { ...formData, weight: weightValue },
        csrfToken: req.csrfToken(),
        error: `Gewichtung muss mindestens 0 ${getWeightUnit(activeProfile.weight_mode)} sein.`
      });
    }
    if (hasMaxPointsInput && (!Number.isFinite(maxPointsValue) || maxPointsValue <= 0)) {
      return res.status(400).render("teacher/teacher-create-template", {
        email: req.session.user.email,
        classData,
        activeProfile,
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        formData,
        csrfToken: req.csrfToken(),
        error: "Maximale Punkte muessen groesser als 0 sein."
      });
    }

    await runAsync(
      "INSERT INTO grade_templates (class_id, name, category, weight, weight_mode, max_points, date, description) VALUES (?,?,?,?,?,?,?,?)",
      [
        classId,
        String(name).trim(),
        normalizedCategory,
        weightValue,
        resolveWeightMode(activeProfile.weight_mode),
        hasMaxPointsInput ? maxPointsValue : null,
        date || null,
        description || null
      ]
    );
    res.redirect(`/teacher/grade-templates/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/edit-template/:classId/:templateId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const templateId = req.params.templateId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    if (!activeProfile) {
      return res.redirect("/teacher/settings?setup=1");
    }

    const template = await getAsync(
      "SELECT id, name, category, weight, max_points, date, description FROM grade_templates WHERE id = ? AND class_id = ?",
      [templateId, classId]
    );
    if (!template) {
      return renderError(res, req, "Prüfung nicht gefunden.", 404, `/teacher/grade-templates/${classId}`);
    }

    const dateValue =
      template.date && !Number.isNaN(new Date(template.date).getTime())
        ? new Date(template.date).toISOString().slice(0, 10)
        : "";

    res.render("teacher/teacher-edit-template", {
      email: req.session.user.email,
      classData,
      activeProfile,
      categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
      templateId,
      formData: {
        name: template.name || "",
        category: template.category || "",
        weight: template.weight != null ? String(template.weight) : "",
        max_points: template.max_points != null ? String(template.max_points) : "",
        date: dateValue,
        description: template.description || ""
      },
      csrfToken: req.csrfToken(),
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post("/edit-template/:classId/:templateId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const templateId = req.params.templateId;
    const { name, category, weight, max_points, date, description } = req.body || {};
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    if (!activeProfile) {
      return res.redirect("/teacher/settings?setup=1");
    }

    const existingTemplate = await getAsync(
      "SELECT id FROM grade_templates WHERE id = ? AND class_id = ?",
      [templateId, classId]
    );
    if (!existingTemplate) {
      return renderError(res, req, "Prüfung nicht gefunden.", 404, `/teacher/grade-templates/${classId}`);
    }

    const normalizedCategory = normalizeCategoryKey(category);
    const rawWeightValue = parseNumericInput(weight);
    const parsedMaxPoints = parseNumericInput(max_points);
    const hasMaxPointsInput = String(max_points || "").trim() !== "";
    const maxPointsValue = hasMaxPointsInput ? parsedMaxPoints : null;
    const formData = {
      name: name || "",
      category: normalizedCategory || category || "",
      weight: Number.isFinite(rawWeightValue) ? rawWeightValue : weight || "",
      max_points: hasMaxPointsInput ? max_points : "",
      date: date || "",
      description: description || ""
    };

    if (!name || !normalizedCategory || !Number.isFinite(rawWeightValue)) {
      return res.status(400).render("teacher/teacher-edit-template", {
        email: req.session.user.email,
        classData,
        activeProfile,
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        templateId,
        formData,
        csrfToken: req.csrfToken(),
        error: "Bitte alle Pflichtfelder ausfüllen."
      });
    }
    if (rawWeightValue < 0) {
      return res.status(400).render("teacher/teacher-edit-template", {
        email: req.session.user.email,
        classData,
        activeProfile,
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        templateId,
        formData,
        csrfToken: req.csrfToken(),
        error: `Gewichtung muss mindestens 0 ${getWeightUnit(activeProfile.weight_mode)} sein.`
      });
    }
    if (hasMaxPointsInput && (!Number.isFinite(maxPointsValue) || maxPointsValue <= 0)) {
      return res.status(400).render("teacher/teacher-edit-template", {
        email: req.session.user.email,
        classData,
        activeProfile,
        categoryDefinitions: TEMPLATE_CATEGORY_DEFINITIONS,
        templateId,
        formData,
        csrfToken: req.csrfToken(),
        error: "Maximale Punkte muessen groesser als 0 sein."
      });
    }

    await runAsync(
      "UPDATE grade_templates SET name = ?, category = ?, weight = ?, max_points = ?, date = ?, description = ? WHERE id = ? AND class_id = ?",
      [
        String(name).trim(),
        normalizedCategory,
        rawWeightValue,
        hasMaxPointsInput ? maxPointsValue : null,
        date || null,
        description || null,
        templateId,
        classId
      ]
    );

    res.redirect(`/teacher/grade-templates/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-template/:classId/:templateId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const templateId = req.params.templateId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const templateRow = await getAsync(
      "SELECT id FROM grade_templates WHERE id = ? AND class_id = ?",
      [templateId, classId]
    );
    if (!templateRow) {
      return renderError(res, req, "Prüfung nicht gefunden.", 404, `/teacher/grade-templates/${classId}`);
    }

    await runAsync("DELETE FROM grade_templates WHERE id = ? AND class_id = ?", [templateId, classId]);
    res.redirect(`/teacher/grade-templates/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.get("/special-assessments/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const assessments = await loadSpecialAssessments(classId);
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    const weightMode = resolveWeightMode(activeProfile?.weight_mode);
    const openMessageCount = await loadClassOpenMessageCount(classId);
    const selectedStudent = req.query.student_id ? String(req.query.student_id) : "";

    res.render("teacher/teacher-special-assessments", {
      email: req.session.user.email,
      classData,
      students,
      assessments,
      activeProfile,
      weightMode,
      weightUnit: getWeightUnit(weightMode),
      openMessageCount,
      specialTypes: SPECIAL_ASSESSMENT_TYPES,
      formData: {
        student_id: selectedStudent,
        type: "",
        name: "",
        description: "",
        weight: "",
        grade: ""
      },
      error: null,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.post("/special-assessments/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    const weightMode = resolveWeightMode(activeProfile?.weight_mode);
    const { student_id, type, name, description, weight, grade } = req.body || {};
    const selectedStudent = students.find((entry) => String(entry.id) === String(student_id));
    const trimmedType = String(type || "").trim();
    const trimmedName = String(name || "").trim();
    const trimmedDescription = String(description || "").trim();
    const weightValue = Number(weight);
    const gradeValue = Number(grade);

    const isTypeValid = SPECIAL_ASSESSMENT_TYPES.includes(trimmedType);
    const resolvedName =
      trimmedName || (trimmedType && trimmedType !== "Benutzerdefiniert" ? trimmedType : "");

    if (!selectedStudent || !isTypeValid || !Number.isFinite(weightValue) || !Number.isFinite(gradeValue)) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        activeProfile,
        weightMode,
        weightUnit: getWeightUnit(weightMode),
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: "Bitte alle Pflichtfelder korrekt ausfüllen.",
        csrfToken: req.csrfToken()
      });
    }

    if (trimmedType === "Benutzerdefiniert" && !resolvedName) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        activeProfile,
        weightMode,
        weightUnit: getWeightUnit(weightMode),
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: "Bitte eine Bezeichnung für die benutzerdefinierte Sonderleistung angeben.",
        csrfToken: req.csrfToken()
      });
    }

    if (weightValue < 0) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        activeProfile,
        weightMode,
        weightUnit: getWeightUnit(weightMode),
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: `Gewichtung muss mindestens 0 ${getWeightUnit(weightMode)} sein.`,
        csrfToken: req.csrfToken()
      });
    }

    if (gradeValue < 1 || gradeValue > 5) {
      const assessments = await loadSpecialAssessments(classId);
      return res.status(400).render("teacher/teacher-special-assessments", {
        email: req.session.user.email,
        classData,
        students,
        assessments,
        activeProfile,
        weightMode,
        weightUnit: getWeightUnit(weightMode),
        specialTypes: SPECIAL_ASSESSMENT_TYPES,
        formData: {
          student_id: student_id || "",
          type: trimmedType,
          name: trimmedName,
          description: trimmedDescription,
          weight,
          grade
        },
        error: "Note muss zwischen 1 und 5 liegen.",
        csrfToken: req.csrfToken()
      });
    }

    await runAsync(
      "INSERT INTO special_assessments (student_id, class_id, type, name, description, weight, grade) VALUES (?,?,?,?,?,?,?)",
      [
        selectedStudent.id,
        classId,
        trimmedType,
        resolvedName,
        trimmedDescription || null,
        weightValue,
        gradeValue
      ]
    );
    await runAsync("INSERT INTO grade_notifications (student_id, message, type) VALUES (?,?,?)", [
      selectedStudent.id,
      "Neue Sonderleistung eingetragen.",
      "grade"
    ]);

    res.redirect(`/teacher/special-assessments/${classId}`);
  } catch (err) {
    next(err);
  }
});

router.post("/delete-special-assessment/:classId/:assessmentId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const assessmentId = req.params.assessmentId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const assessmentRow = await getAsync(
      "SELECT id FROM special_assessments WHERE id = ? AND class_id = ?",
      [assessmentId, classId]
    );
    if (!assessmentRow) {
      return renderError(res, req, "Sonderleistung nicht gefunden.", 404, `/teacher/special-assessments/${classId}`);
    }

    await runAsync("DELETE FROM special_assessments WHERE id = ? AND class_id = ?", [assessmentId, classId]);
    const backUrl = req.get("referer") || `/teacher/special-assessments/${classId}`;
    res.redirect(backUrl);
  } catch (err) {
    next(err);
  }
});

router.get("/class-statistics/:classId", async (req, res, next) => {
  try {
    const classId = req.params.classId;
    const classData = await loadClassForTeacher(classId, req.session.user.id);
    if (!classData) {
      return renderError(res, req, "Klasse nicht gefunden.", 404, "/teacher/classes");
    }

    const students = await loadStudents(classId);
    const templates = await loadTemplates(classId);
    const activeProfile = await loadActiveTeacherProfile(req.session.user.id);
    const participationConfig = normalizeParticipationConfig(
      activeProfile?.participation || activeProfile || {}
    );
    const absenceMode = normalizeAbsenceMode(activeProfile?.absence_mode);
    const openMessageCount = await loadClassOpenMessageCount(classId);
    const studentMap = new Map(students.map((student) => [String(student.id), student]));
    const gradesByStudent = new Map();

    for (const student of students) {
      const grades = await loadStudentGrades(student.id);
      const participationMarks = await loadParticipationMarks(classId, student.id);
      gradesByStudent.set(String(student.id), [
        ...grades,
        ...buildParticipationAverageRows(participationMarks, participationConfig)
      ]);
    }

    const templateStats = templates.map((template) => {
      const templateGrades = [];

      gradesByStudent.forEach((grades, studentId) => {
        const student = studentMap.get(studentId);
        grades.forEach((grade) => {
          if (grade.is_special) return;
          if (shouldSkipGradeForAbsence(grade, absenceMode)) return;
          const matchesById =
            grade.template_id && Number(grade.template_id) === Number(template.id);
          const matchesByName = !grade.template_id && grade.name === template.name;
          if (!matchesById && !matchesByName) return;

          const value = Number(grade.grade);
          if (!isValidGradeValue(value)) return;
          templateGrades.push({ value, studentName: student?.name || "" });
        });
      });

      const values = templateGrades.map((entry) => entry.value);
      const average = values.length
        ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
        : null;
      const bestGrade = values.length ? Math.min(...values) : null;
      const worstGrade = values.length ? Math.max(...values) : null;

      const bestStudents =
        bestGrade == null
          ? []
          : templateGrades
              .filter((entry) => entry.value === bestGrade)
              .map((entry) => entry.studentName)
              .filter(Boolean);
      const worstStudents =
        worstGrade == null
          ? []
          : templateGrades
              .filter((entry) => entry.value === worstGrade)
              .map((entry) => entry.studentName)
              .filter(Boolean);

      return {
        ...template,
        average,
        graded_count: values.length,
        best_grade: bestGrade,
        worst_grade: worstGrade,
        best_students: bestStudents,
        worst_students: worstStudents
      };
    });

    const allValues = [];
    let weightedSum = 0;
    let weightTotal = 0;

    gradesByStudent.forEach((grades) => {
      grades.forEach((grade) => {
        if (shouldSkipGradeForAbsence(grade, absenceMode)) return;
        const value = Number(grade.grade);
        const weight = grade?.weight == null ? 1 : Number(grade.weight);
        if (!isValidGradeValue(value) || !isValidWeightValue(weight)) return;
        allValues.push(value);
        weightedSum += value * weight;
        weightTotal += weight;
      });
    });

    const overallAverage = allValues.length
      ? Number((allValues.reduce((sum, value) => sum + value, 0) / allValues.length).toFixed(2))
      : null;
    const overallWeightedAverage = weightTotal
      ? Number((weightedSum / weightTotal).toFixed(2))
      : null;

    res.render("teacher/teacher-class-statistics", {
      email: req.session.user.email,
      classData,
      activeProfile,
      studentCount: students.length,
      overallWeightedAverage,
      overallAverage,
      templateStats,
      openMessageCount,
      csrfToken: req.csrfToken()
    });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  if (req.file) {
    return removeUploadedFile(req.file)
      .then(() => next(err))
      .catch(() => next(err));
  }
  return next(err);
});

module.exports = router;

