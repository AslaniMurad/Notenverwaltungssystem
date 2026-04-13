(function () {
  const root = document.documentElement;
  const storageKey = "nvs-theme";
  const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

  function isSupportedTheme(theme) {
    return theme === "dark" || theme === "light";
  }

  function resolveSystemTheme() {
    return systemThemeQuery.matches ? "dark" : "light";
  }

  function readStoredTheme() {
    try {
      const storedTheme = window.localStorage.getItem(storageKey);
      return isSupportedTheme(storedTheme) ? storedTheme : null;
    } catch (error) {
      return null;
    }
  }

  function persistTheme(theme) {
    if (!isSupportedTheme(theme)) {
      return;
    }

    try {
      window.localStorage.setItem(storageKey, theme);
    } catch (error) {
    }
  }

  function resolveActiveTheme() {
    return readStoredTheme() || resolveSystemTheme();
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", isSupportedTheme(theme) ? theme : resolveSystemTheme());
  }

  function iconForTheme(theme) {
    return theme === "dark" ? "\uD83C\uDF19" : "\u2600\uFE0F";
  }

  function labelForTheme(theme) {
    return theme === "dark" ? "Auf Lightmode wechseln" : "Auf Darkmode wechseln";
  }

  function stateForTheme(theme) {
    return theme === "dark" ? "Darkmode" : "Lightmode";
  }

  function updateToggleButton(button, theme) {
    if (!button) {
      return;
    }

    const icon = button.querySelector(".theme-toggle-icon");
    const state = button.querySelector(".theme-toggle-state");

    if (icon) {
      icon.textContent = iconForTheme(theme);
    } else {
      button.textContent = iconForTheme(theme);
    }

    if (state) {
      state.textContent = stateForTheme(theme);
    }

    button.setAttribute("aria-label", labelForTheme(theme));
    button.setAttribute("title", labelForTheme(theme));
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    button.dataset.themeCurrent = theme;
  }

  applyTheme(resolveActiveTheme());

  document.addEventListener("DOMContentLoaded", function () {
    const toggleButtons = Array.from(document.querySelectorAll("[data-theme-toggle]"));
    const floatingToggle = document.getElementById("themeToggle");
    const hasSidebarToggle = toggleButtons.some((button) => button.dataset.themeToggle === "sidebar");
    const activeTheme = root.getAttribute("data-theme") || resolveActiveTheme();

    if (hasSidebarToggle && floatingToggle) {
      floatingToggle.hidden = true;
    }

    toggleButtons.forEach((button) => {
      updateToggleButton(button, activeTheme);
      button.addEventListener("click", function () {
        const currentTheme = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
        const nextTheme = currentTheme === "dark" ? "light" : "dark";
        persistTheme(nextTheme);
        applyTheme(nextTheme);
        toggleButtons.forEach((toggleButton) => updateToggleButton(toggleButton, nextTheme));
      });
    });

    const handleSystemThemeChange = function (event) {
      if (readStoredTheme()) {
        return;
      }

      const nextTheme = event.matches ? "dark" : "light";
      applyTheme(nextTheme);
      toggleButtons.forEach((toggleButton) => updateToggleButton(toggleButton, nextTheme));
    };

    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", handleSystemThemeChange);
    } else if (typeof systemThemeQuery.addListener === "function") {
      systemThemeQuery.addListener(handleSystemThemeChange);
    }
  });
})();
