// public/js/mobile-login.js - Mobile Login Enhancements

document.addEventListener('DOMContentLoaded', function() {
  // Nur auf Mobile ausführen
  if (!document.body.classList.contains('mobile-view')) {
    return;
  }

  const loginButton = document.querySelector('.btn-login-submit');
  const loginForm = document.querySelector('form[action="/login"]');

  // Loading State beim Submit
  if (loginForm && loginButton) {
    loginForm.addEventListener('submit', function(e) {
      loginButton.classList.add('loading');
      loginButton.innerHTML = 'Wird geladen...';
      loginButton.disabled = true;
    });
  }

  console.log('📱 Mobile Login loaded');
});
