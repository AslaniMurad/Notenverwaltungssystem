// Navigation toggles for collapsible sidebar panels
document.querySelectorAll('[data-target]').forEach(trigger => {
  const target = document.querySelector(trigger.getAttribute('data-target'));
  if (!target) return;
  trigger.addEventListener('click', () => {
    const isOpen = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!isOpen));
    target.classList.toggle('is-open', !isOpen);
    trigger.classList.toggle('is-active', !isOpen);
  });
});

// Mark active navigation links based on current path
const currentPath = window.location.pathname;
document.querySelectorAll('.app-nav a[href]').forEach(link => {
  if (link.getAttribute('href') === currentPath) {
    link.classList.add('is-active');
  }
});

console.debug('School Panel assets loaded');
