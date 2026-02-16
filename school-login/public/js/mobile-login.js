// public/js/mobile-login.js - Mobile Login Enhancements

document.addEventListener('DOMContentLoaded', function() {
  if (!document.body.classList.contains('mobile-view')) {
    return;
  }

  const loginButton = document.querySelector('.btn-login-submit');
  const loginForm = document.querySelector('form[action="/login"]');

  if (loginForm && loginButton) {
    loginForm.addEventListener('submit', function() {
      loginButton.classList.add('loading');
      loginButton.innerHTML = 'Wird geladen...';
      loginButton.disabled = true;
    });
  }
});
