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

document.querySelectorAll('[data-create-switcher]').forEach((root) => {
  const buttons = Array.from(root.querySelectorAll('[data-mode-toggle]'));
  const panels = Array.from(root.querySelectorAll('[data-create-panel]'));
  if (!buttons.length || !panels.length) return;

  const fallbackMode = buttons[0].getAttribute('data-mode-toggle') || 'single';

  const setMode = (requestedMode) => {
    const mode = buttons.some((button) => button.getAttribute('data-mode-toggle') === requestedMode)
      ? requestedMode
      : fallbackMode;

    root.dataset.activeMode = mode;

    buttons.forEach((button) => {
      const isActive = button.getAttribute('data-mode-toggle') === mode;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
      button.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    panels.forEach((panel) => {
      panel.hidden = panel.getAttribute('data-create-panel') !== mode;
    });
  };

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      setMode(button.getAttribute('data-mode-toggle'));
    });
  });

  setMode(root.getAttribute('data-default-mode') || fallbackMode);
});

const bulkDelimiterExamples = {
  paragraph: [
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at'
  ].join('\n'),
  semicolon: [
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at'
  ].join(';'),
  comma: [
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at'
  ].join(','),
  tab: [
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at',
    'vorname.nachname@htlwy.at'
  ].join('\t')
};

document.querySelectorAll('[data-bulk-format-switcher]').forEach((root) => {
  const buttons = Array.from(root.querySelectorAll('[data-bulk-delimiter]'));
  const form = root.closest('form');
  const hiddenInput = form?.querySelector('[data-bulk-delimiter-input]');
  const textArea = form?.querySelector('[data-bulk-emails-input]');
  const preview = form?.querySelector('[data-bulk-delimiter-preview]');
  if (!buttons.length || !hiddenInput) return;

  const fallbackDelimiter = buttons[0].getAttribute('data-bulk-delimiter') || 'paragraph';

  const setDelimiter = (requestedDelimiter) => {
    const delimiter = buttons.some((button) => button.getAttribute('data-bulk-delimiter') === requestedDelimiter)
      ? requestedDelimiter
      : fallbackDelimiter;
    const example = bulkDelimiterExamples[delimiter] || bulkDelimiterExamples.paragraph;

    hiddenInput.value = delimiter;
    if (textArea) textArea.placeholder = example;
    if (preview) preview.textContent = example;

    buttons.forEach((button) => {
      const isActive = button.getAttribute('data-bulk-delimiter') === delimiter;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', String(isActive));
      button.setAttribute('tabindex', isActive ? '0' : '-1');
    });
  };

  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      setDelimiter(button.getAttribute('data-bulk-delimiter'));
    });
  });

  setDelimiter(root.getAttribute('data-default-delimiter') || hiddenInput.value || fallbackDelimiter);
});

console.debug('School Panel assets loaded');
