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

function deriveStudentNameFromEmail(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  const match = trimmed.match(/^([^@]+)@/);
  if (!match) return '';
  const localPart = match[1];
  const parts = localPart.split('.');
  if (parts.length !== 2) return '';
  const [first, last] = parts;
  const isValidPart = (part) => /^[a-z]+(?:-[a-z]+)*$/.test(part);
  if (!isValidPart(first) || !isValidPart(last)) return '';
  const cap = (part) => part.charAt(0).toUpperCase() + part.slice(1);
  return `${cap(first)} ${cap(last)}`;
}

const studentEmailInput = document.querySelector('[data-student-email]');
const studentNameInput = document.querySelector('[data-student-name]');
if (studentEmailInput && studentNameInput) {
  studentEmailInput.addEventListener('input', () => {
    if (studentNameInput.value.trim()) return;
    const derived = deriveStudentNameFromEmail(studentEmailInput.value);
    if (derived) studentNameInput.value = derived;
  });
}

console.debug('School Panel assets loaded');
