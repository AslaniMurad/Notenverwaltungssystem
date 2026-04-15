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

function isScrollableInYAxis(element) {
  const style = window.getComputedStyle(element);
  const overflowY = style.overflowY;
  return (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
    && element.scrollHeight > element.clientHeight + 2;
}

function getSidebarScrollTarget(sidebar) {
  const nav = sidebar.querySelector('.app-nav');
  if (nav && isScrollableInYAxis(nav)) return nav;
  if (isScrollableInYAxis(sidebar)) return sidebar;
  return null;
}

function ensureSidebarScrollButton(sidebar, direction) {
  const existing = sidebar.querySelector(`[data-sidebar-scroll-jump="${direction}"]`);
  if (existing) return existing;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `sidebar-scroll-jump sidebar-scroll-jump-${direction}`;
  button.dataset.sidebarScrollJump = direction;
  button.setAttribute(
    'aria-label',
    direction === 'up'
      ? 'In der Sidebar ganz nach oben scrollen'
      : 'In der Sidebar ganz nach unten scrollen'
  );
  button.textContent = direction === 'up' ? '↑' : '↓';
  button.hidden = true;
  sidebar.appendChild(button);
  return button;
}

function initSidebarScrollJumps() {
  const sidebars = Array.from(document.querySelectorAll('.app-sidebar, .teacher-sidebar'));
  if (!sidebars.length) return;

  sidebars.forEach((sidebar) => {
    const upButton = ensureSidebarScrollButton(sidebar, 'up');
    const downButton = ensureSidebarScrollButton(sidebar, 'down');
    let activeTarget = null;

    const syncSidebarScrollJumps = () => {
      const nextTarget = getSidebarScrollTarget(sidebar);

      if (activeTarget !== nextTarget) {
        if (activeTarget) activeTarget.removeEventListener('scroll', syncSidebarScrollJumps);
        activeTarget = nextTarget;
        if (activeTarget) activeTarget.addEventListener('scroll', syncSidebarScrollJumps, { passive: true });
      }

      if (!activeTarget) {
        upButton.hidden = true;
        downButton.hidden = true;
        return;
      }

      const regionTop = activeTarget === sidebar ? 0 : activeTarget.offsetTop;
      const regionHeight = activeTarget.clientHeight;
      const maxScrollTop = Math.max(activeTarget.scrollHeight - activeTarget.clientHeight, 0);

      sidebar.style.setProperty('--sidebar-scroll-region-top', `${regionTop}px`);
      sidebar.style.setProperty('--sidebar-scroll-region-height', `${regionHeight}px`);

      if (maxScrollTop <= 4) {
        upButton.hidden = true;
        downButton.hidden = true;
        return;
      }

      upButton.hidden = activeTarget.scrollTop <= 8;
      downButton.hidden = activeTarget.scrollTop >= maxScrollTop - 8;
    };

    upButton.addEventListener('click', () => {
      const target = getSidebarScrollTarget(sidebar);
      target.scrollTo({ top: 0, behavior: 'smooth' });
    });

    downButton.addEventListener('click', () => {
      const target = getSidebarScrollTarget(sidebar);
      target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
    });

    if (typeof ResizeObserver === 'function') {
      const resizeObserver = new ResizeObserver(() => {
        syncSidebarScrollJumps();
      });
      resizeObserver.observe(sidebar);
      const nav = sidebar.querySelector('.app-nav');
      if (nav) resizeObserver.observe(nav);
    }

    window.addEventListener('resize', syncSidebarScrollJumps, { passive: true });
    syncSidebarScrollJumps();
  });
}

initSidebarScrollJumps();

console.debug('School Panel assets loaded');
