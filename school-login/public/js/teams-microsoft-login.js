(function () {
  const loginButton = document.querySelector("[data-microsoft-popup-login]");
  if (!loginButton) return;

  const statusElement = document.querySelector("[data-microsoft-popup-status]");
  const completeUrl = loginButton.dataset.microsoftPopupCompleteUrl;
  const csrfToken = loginButton.dataset.csrfToken;
  let teamsReady = false;
  let completionStarted = false;

  function setStatus(message) {
    if (statusElement) {
      statusElement.textContent = message || "";
    }
  }

  function parseAuthResult(result) {
    if (!result) return {};
    if (typeof result === "object") return result;
    try {
      return JSON.parse(result);
    } catch (error) {
      return { token: String(result) };
    }
  }

  async function completePopupLogin(token) {
    if (completionStarted) return;
    completionStarted = true;
    setStatus("Anmeldung wird abgeschlossen...");

    const response = await fetch(completeUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify({ token })
    });

    if (!response.ok) {
      completionStarted = false;
      throw new Error("Microsoft-Anmeldung konnte nicht abgeschlossen werden.");
    }

    const payload = await response.json();
    window.location.assign(payload.redirect || "/");
  }

  function handleAuthFailure(message) {
    completionStarted = false;
    loginButton.removeAttribute("aria-busy");
    loginButton.classList.remove("is-loading");
    setStatus(message || "Microsoft-Anmeldung wurde abgebrochen.");
  }

  function handleAuthSuccess(result) {
    const payload = parseAuthResult(result);
    if (!payload.token) {
      handleAuthFailure("Microsoft-Anmeldung lieferte keinen Abschluss-Token.");
      return;
    }
    completePopupLogin(payload.token).catch((error) => {
      handleAuthFailure(error.message);
    });
  }

  function openWindowPopup(authUrl) {
    const popup = window.open(
      authUrl,
      "nvsMicrosoftLogin",
      "popup=yes,width=620,height=720,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes"
    );

    if (!popup) {
      handleAuthFailure("Popup konnte nicht geoeffnet werden.");
      window.location.assign(authUrl);
      return;
    }

    popup.focus();
  }

  function authenticateWithTeams(authUrl) {
    const teams = window.microsoftTeams;
    if (!teamsReady || !teams?.authentication?.authenticate) {
      return false;
    }

    teams.authentication.authenticate({
      url: authUrl,
      width: 620,
      height: 720
    })
      .then(handleAuthSuccess)
      .catch((reason) => {
        handleAuthFailure(typeof reason === "string" ? reason : "Microsoft-Anmeldung wurde abgebrochen.");
      });
    return true;
  }

  if (window.microsoftTeams?.app?.initialize) {
    window.microsoftTeams.app.initialize()
      .then(() => {
        teamsReady = true;
      })
      .catch(() => {
        teamsReady = false;
      });
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data || {};
    if (data.type === "nvs:microsoft-login-complete") {
      handleAuthSuccess(data);
    } else if (data.type === "nvs:microsoft-login-failed") {
      handleAuthFailure(data.message);
    }
  });

  loginButton.addEventListener("click", (event) => {
    event.preventDefault();
    const authUrl = new URL(loginButton.getAttribute("href"), window.location.origin).toString();
    loginButton.setAttribute("aria-busy", "true");
    loginButton.classList.add("is-loading");
    setStatus("Microsoft-Anmeldung wird geoeffnet...");

    if (!authenticateWithTeams(authUrl)) {
      openWindowPopup(authUrl);
    }
  });
})();
