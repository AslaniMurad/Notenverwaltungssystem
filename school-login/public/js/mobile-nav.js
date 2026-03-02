(function () {
  const MOBILE_BREAKPOINT = 900;

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function enhanceTablesForMobile() {
    if (!isMobile()) return;

    document.querySelectorAll("table").forEach((table) => {
      const headers = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
      if (!headers.length) return;

      table.querySelectorAll("tbody tr").forEach((row) => {
        row.querySelectorAll("td").forEach((cell, index) => {
          if (!cell.hasAttribute("data-label") && headers[index]) {
            cell.setAttribute("data-label", headers[index]);
          }
        });
      });
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const sidebar = document.querySelector(".app-sidebar, .teacher-sidebar");
    let toggle = document.querySelector(".mobile-nav-toggle");

    if (!sidebar) {
      enhanceTablesForMobile();
      return;
    }

    if (!toggle) {
      toggle = document.createElement("button");
      toggle.className = "mobile-nav-toggle";
      toggle.setAttribute("type", "button");
      toggle.setAttribute("aria-label", "Navigation umschalten");
      document.body.prepend(toggle);
    }

    const closeSidebar = () => {
      sidebar.classList.remove("mobile-active");
      document.body.classList.remove("mobile-nav-open");
      toggle.innerHTML = "&#9776;";
      toggle.setAttribute("aria-expanded", "false");
    };

    const openSidebar = () => {
      if (!isMobile()) return;
      sidebar.classList.add("mobile-active");
      document.body.classList.add("mobile-nav-open");
      toggle.innerHTML = "&#10005;";
      toggle.setAttribute("aria-expanded", "true");
    };

    closeSidebar();

    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!isMobile()) return;

      if (sidebar.classList.contains("mobile-active")) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });

    document.addEventListener("click", (event) => {
      if (!isMobile()) return;
      const clickedInsideSidebar = event.target.closest(".app-sidebar, .teacher-sidebar");
      const clickedToggle = event.target.closest(".mobile-nav-toggle");
      if (!clickedInsideSidebar && !clickedToggle) {
        closeSidebar();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSidebar();
      }
    });

    sidebar.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        if (isMobile()) closeSidebar();
      });
    });

    window.addEventListener("resize", () => {
      if (!isMobile()) {
        closeSidebar();
      }
    });

    enhanceTablesForMobile();
  });
})();
