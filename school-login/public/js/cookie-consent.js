(function () {
  const root = document.documentElement;
  const bodyBannerClass = "has-cookie-banner";
  const consentValues = new Set(["necessary", "all"]);

  function getCookieName() {
    return root.dataset.consentCookie || "nvs_cookie_consent";
  }

  function getConsentMaxAgeDays() {
    const rawValue = Number(root.dataset.consentMaxAgeDays);
    return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 180;
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

  function writeCookie(name, value) {
    const maxAge = getConsentMaxAgeDays() * 24 * 60 * 60;
    const secureFlag = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secureFlag}`;
  }

  function getConsentChoice() {
    const value = readCookie(getCookieName());
    return consentValues.has(value) ? value : null;
  }

  function clearOptionalStorage() {
    try {
      localStorage.removeItem("theme");
    } catch (err) {
      // Ignore storage errors so consent can still be updated.
    }
  }

  function dispatchConsentChange(choice) {
    document.dispatchEvent(
      new CustomEvent("app:cookie-consent-changed", {
        detail: {
          choice,
          preferences: choice === "all"
        }
      })
    );
  }

  function setBannerVisibility(banner, isVisible) {
    if (!banner) {
      return;
    }

    banner.hidden = !isVisible;
    banner.classList.toggle("is-visible", isVisible);
    document.body.classList.toggle(bodyBannerClass, isVisible);
  }

  document.addEventListener("DOMContentLoaded", function () {
    const banner = document.querySelector("[data-cookie-banner]");
    if (!banner) {
      return;
    }

    function openBanner() {
      setBannerVisibility(banner, true);
      const firstAction = banner.querySelector("[data-cookie-action]");
      if (firstAction) {
        firstAction.focus();
      }
    }

    function applyChoice(choice) {
      if (!consentValues.has(choice)) {
        return;
      }

      writeCookie(getCookieName(), choice);
      if (choice !== "all") {
        clearOptionalStorage();
      }
      setBannerVisibility(banner, false);
      dispatchConsentChange(choice);
    }

    banner.querySelectorAll("[data-cookie-action]").forEach((button) => {
      button.addEventListener("click", function () {
        applyChoice(button.getAttribute("data-cookie-action"));
      });
    });

    document.querySelectorAll("[data-open-cookie-settings]").forEach((button) => {
      button.addEventListener("click", openBanner);
    });

    setBannerVisibility(banner, !getConsentChoice());
  });
})();
