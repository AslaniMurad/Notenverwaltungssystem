(function () {
  document.addEventListener("DOMContentLoaded", () => {
    if (window.innerWidth > 900) return;

    const loginForm = document.querySelector('form[action="/login"]');
    const loginButton = document.querySelector(".btn-login-submit");

    if (!loginForm || !loginButton) return;

    loginForm.addEventListener("submit", () => {
      loginButton.disabled = true;
      loginButton.textContent = "Wird geladen...";
    });
  });
})();
