(function () {
  const root = document.documentElement;

  function resolveSystemTheme() {
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

  function updateToggleButton(button, theme) {
    if (!button) {
      return;
    }

    button.textContent = iconForTheme(theme);
    button.setAttribute("aria-label", labelForTheme(theme));
    button.setAttribute("title", labelForTheme(theme));
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  }

  applyTheme(resolveSystemTheme());

  const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

  document.addEventListener("DOMContentLoaded", function () {
    const toggleButton = document.getElementById("themeToggle");
    updateToggleButton(toggleButton, root.getAttribute("data-theme") || resolveSystemTheme());

    if (toggleButton) {
      toggleButton.addEventListener("click", function () {
        const currentTheme = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
        const nextTheme = currentTheme === "dark" ? "light" : "dark";
        applyTheme(nextTheme);
        updateToggleButton(toggleButton, nextTheme);
      });
    }

    if (typeof systemThemeQuery.addEventListener === "function") {
      systemThemeQuery.addEventListener("change", function (event) {
        const nextTheme = event.matches ? "dark" : "light";
        applyTheme(nextTheme);
        updateToggleButton(toggleButton, nextTheme);
      });
    }
  });
})();
