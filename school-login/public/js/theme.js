(function () {
  const STORAGE_KEY = "theme";
  const root = document.documentElement;

  function isValidTheme(theme) {
    return theme === "light" || theme === "dark";
  }

  function resolveInitialTheme() {
    try {
      const storedTheme = localStorage.getItem(STORAGE_KEY);
      if (isValidTheme(storedTheme)) {
        return storedTheme;
      }
    } catch (err) {
      // Ignore storage failures and fall back to system preference.
    }

    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
  }

  function iconForTheme(theme) {
    return theme === "dark" ? "\u2600\uFE0F" : "\uD83C\uDF19";
  }

  function labelForTheme(theme) {
    return theme === "dark" ? "Auf Light Mode wechseln" : "Auf Dark Mode wechseln";
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (err) {
      // Ignore storage failures so the toggle still works in-session.
    }
  }

  function hasStoredPreference() {
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

  const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

  document.addEventListener("DOMContentLoaded", function () {
    const toggleButton = document.getElementById("themeToggle");
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
      systemThemeQuery.addEventListener("change", function (event) {
        if (hasStoredPreference()) {
          return;
        }

        const nextTheme = event.matches ? "dark" : "light";
        setTheme(nextTheme, toggleButton, false);
      });
    }
  });
})();

