const { db } = require("../db");

const SETTING_KEYS = {
  microsoftLoginEnabled: "microsoft_login_enabled",
  maintenanceModeEnabled: "maintenance_mode_enabled"
};

const DEFAULT_SETTINGS = {
  [SETTING_KEYS.microsoftLoginEnabled]: true,
  [SETTING_KEYS.maintenanceModeEnabled]: false
};

function normalizeBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disabled"].includes(normalized)) return false;
  return fallback;
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function getSettingValue(key) {
  const row = await getAsync("SELECT value FROM app_settings WHERE key = ?", [key]);
  return row?.value ?? DEFAULT_SETTINGS[key] ?? null;
}

async function getBooleanSetting(key) {
  return normalizeBoolean(await getSettingValue(key), normalizeBoolean(DEFAULT_SETTINGS[key], false));
}

async function setBooleanSetting(key, enabled) {
  const value = enabled ? "true" : "false";
  await runAsync(
    `INSERT INTO app_settings (key, value)
     VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = current_timestamp
     RETURNING key`,
    [key, value]
  );
  return enabled;
}

async function getRuntimeSettings() {
  const [microsoftLoginEnabled, maintenanceModeEnabled] = await Promise.all([
    getBooleanSetting(SETTING_KEYS.microsoftLoginEnabled),
    getBooleanSetting(SETTING_KEYS.maintenanceModeEnabled)
  ]);

  return {
    microsoftLoginEnabled,
    maintenanceModeEnabled
  };
}

async function updateRuntimeSettings(settings = {}) {
  const microsoftLoginEnabled = normalizeBoolean(settings.microsoftLoginEnabled, true);
  const maintenanceModeEnabled = normalizeBoolean(settings.maintenanceModeEnabled, false);

  await Promise.all([
    setBooleanSetting(SETTING_KEYS.microsoftLoginEnabled, microsoftLoginEnabled),
    setBooleanSetting(SETTING_KEYS.maintenanceModeEnabled, maintenanceModeEnabled)
  ]);

  return {
    microsoftLoginEnabled,
    maintenanceModeEnabled
  };
}

module.exports = {
  SETTING_KEYS,
  getRuntimeSettings,
  updateRuntimeSettings,
  normalizeBoolean
};
