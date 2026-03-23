(function () {
  const STORAGE_KEY = "theme";
  const root = document.documentElement;
  const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let toggleButton = null;

  function isValidTheme(theme) {
    return theme === "light" || theme === "dark";
  }

  function getConsentCookieName() {
    return root.dataset.consentCookie || "nvs_cookie_consent";
  }

  function readCookie(name) {
    const cookies = document.cookie ? document.cookie.split(";") : [];
    for (const cookie of cookies) {
      const entry = cookie.trim();
      if (entry.startsWith(`${name}=`)) {
        return decodeURIComponent(entry.slice(name.length + 1));
      }
    }
    return "";
  }

  function canPersistPreference() {
    return readCookie(getConsentCookieName()) === "all";
  }

  function resolveSystemTheme() {
    return systemThemeQuery.matches ? "dark" : "light";
  }

  function resolveInitialTheme() {
    if (!canPersistPreference()) {
      return resolveSystemTheme();
    }

    try {
      const storedTheme = localStorage.getItem(STORAGE_KEY);
      if (isValidTheme(storedTheme)) {
        return storedTheme;
      }
    } catch (err) {
      // Ignore storage failures and fall back to the system preference.
    }

    return resolveSystemTheme();
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
  }

  function iconForTheme(theme) {
    return theme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19";
  }

  function labelForTheme(theme) {
    const label = theme === "dark" ? "Auf Light Mode wechseln" : "Auf Dark Mode wechseln";
    return canPersistPreference() ? label : `${label} (ohne Speicherung)`;
  }

  function saveTheme(theme) {
    if (!canPersistPreference()) {
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (err) {
      // Ignore storage failures so the toggle still works in-session.
    }
  }

  function clearStoredTheme() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      // Ignore storage failures so consent changes still apply.
    }
  }

  function hasStoredPreference() {
    if (!canPersistPreference()) {
      return false;
    }

    try {
      return isValidTheme(localStorage.getItem(STORAGE_KEY));
    } catch (err) {
      return false;
    }
  }

  function updateToggleButton(button, theme) {
    if (!button) {
      return;
    }

    button.textContent = iconForTheme(theme);
    button.setAttribute("aria-label", labelForTheme(theme));
    button.setAttribute("title", labelForTheme(theme));
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  }

  function setTheme(theme, button, persist) {
    if (!isValidTheme(theme)) {
      return;
    }

    applyTheme(theme);
    updateToggleButton(button, theme);

    if (persist) {
      saveTheme(theme);
    }
  }

  const initialTheme = root.getAttribute("data-theme");
  if (!isValidTheme(initialTheme)) {
    applyTheme(resolveInitialTheme());
  }

  document.addEventListener("DOMContentLoaded", function () {
    toggleButton = document.getElementById("themeToggle");
    const activeTheme = root.getAttribute("data-theme");
    updateToggleButton(toggleButton, isValidTheme(activeTheme) ? activeTheme : "light");

    if (toggleButton) {
      toggleButton.addEventListener("click", function () {
        const currentTheme = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
        const nextTheme = currentTheme === "dark" ? "light" : "dark";
        setTheme(nextTheme, toggleButton, true);
      });
    }

    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", function () {
        if (hasStoredPreference()) {
          return;
        }

        setTheme(resolveSystemTheme(), toggleButton, false);
      });
    }
  });

  document.addEventListener("app:cookie-consent-changed", function (event) {
    const preferencesEnabled = Boolean(event.detail && event.detail.preferences);
    if (!preferencesEnabled) {
      clearStoredTheme();
      setTheme(resolveSystemTheme(), toggleButton, false);
      return;
    }

    const activeTheme = root.getAttribute("data-theme");
    if (isValidTheme(activeTheme)) {
      saveTheme(activeTheme);
      updateToggleButton(toggleButton, activeTheme);
    }
  });
})();
