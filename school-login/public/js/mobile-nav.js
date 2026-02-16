/* public/js/mobile-nav.js - Mobile navigation and device class handling */

(function () {
  function detectMobileClient() {
    var ua = navigator.userAgent || "";
    var uaMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Windows Phone|Opera Mini|Mobile|CriOS/i.test(ua);
    var smallViewport = window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
    var coarsePointer = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    var noHover = window.matchMedia && window.matchMedia("(hover: none)").matches;
    return Boolean(uaMobile || smallViewport || (coarsePointer && noHover));
  }

  function applyDeviceClasses() {
    var isMobile = detectMobileClient();
    document.documentElement.classList.toggle("mobile-view", isMobile);
    document.documentElement.classList.toggle("desktop-view", !isMobile);
    document.documentElement.setAttribute("data-device", isMobile ? "mobile" : "desktop");

    if (document.body) {
      document.body.classList.toggle("mobile-view", isMobile);
      document.body.classList.toggle("desktop-view", !isMobile);
      document.body.setAttribute("data-device", isMobile ? "mobile" : "desktop");
    }

    return isMobile;
  }

  function setToggleState(toggle, sidebar, open) {
    if (!toggle || !sidebar) return;
    sidebar.classList.toggle("mobile-active", open);
    toggle.classList.toggle("active", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.textContent = open ? "Close" : "Menu";
  }

  function ensureMobileToggle(sidebar) {
    if (!sidebar) return null;

    var toggle = document.querySelector(".mobile-nav-toggle");
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mobile-nav-toggle";
      toggle.setAttribute("aria-label", "Navigation umschalten");
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "Menu";
      document.body.insertBefore(toggle, document.body.firstChild);
    }

    if (toggle.dataset.mobileBound === "true") {
      return toggle;
    }

    toggle.dataset.mobileBound = "true";

    toggle.addEventListener("click", function (event) {
      event.stopPropagation();
      var isOpen = !sidebar.classList.contains("mobile-active");
      setToggleState(toggle, sidebar, isOpen);
    });

    document.addEventListener("click", function (event) {
      if (
        !event.target.closest(".app-sidebar") &&
        !event.target.closest(".teacher-sidebar") &&
        !event.target.closest(".mobile-nav-toggle")
      ) {
        setToggleState(toggle, sidebar, false);
      }
    });

    var sidebarLinks = sidebar.querySelectorAll("a, button");
    sidebarLinks.forEach(function (link) {
      link.addEventListener("click", function () {
        setToggleState(toggle, sidebar, false);
      });
    });

    return toggle;
  }

  function enhanceMobileTable() {
    var tables = document.querySelectorAll("table:not(.desktop-only)");

    tables.forEach(function (table) {
      var headers = table.querySelectorAll("thead th");
      var rows = table.querySelectorAll("tbody tr");

      rows.forEach(function (row) {
        var cells = row.querySelectorAll("td");
        cells.forEach(function (cell, index) {
          if (headers[index]) {
            cell.setAttribute("data-label", headers[index].textContent.trim());
          }
        });
      });
    });
  }

  function initializeMobileNavigation() {
    var isMobile = applyDeviceClasses();
    var sidebar = document.querySelector(".app-sidebar, .teacher-sidebar");
    var toggle = ensureMobileToggle(sidebar);

    if (!sidebar || !toggle) return;

    if (isMobile) {
      toggle.hidden = false;
    } else {
      setToggleState(toggle, sidebar, false);
      toggle.hidden = true;
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    initializeMobileNavigation();
    enhanceMobileTable();
  });

  window.addEventListener("resize", initializeMobileNavigation);
})();
