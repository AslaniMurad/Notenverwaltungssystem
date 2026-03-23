(function () {
  const ACTIVE_CLASS = "is-active";
  const SUBMIT_LOCK = "modalSubmitting";
  let modal;
  let resolver = null;
  let lastFocusedElement = null;
  let hideTimer = null;

  function getFocusableElements() {
    if (!modal) {
      return [];
    }

    return Array.from(
      modal.overlay.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );
  }

  function onKeydown(event) {
    if (!modal || modal.overlay.hidden) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      close(false);
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = getFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function ensureModal() {
    if (modal) {
      return modal;
    }

    const overlay = document.createElement("div");
    overlay.className = "app-modal-overlay";
    overlay.hidden = true;
    overlay.innerHTML = [
      '<div class="app-modal-card" role="dialog" aria-modal="true" aria-labelledby="appModalTitle" aria-describedby="appModalMessage appModalNote">',
      '  <div class="app-modal-header">',
      '    <h2 class="app-modal-title" id="appModalTitle"></h2>',
      "  </div>",
      '  <div class="app-modal-body">',
      '    <p class="app-modal-message" id="appModalMessage"></p>',
      '    <p class="app-modal-note" id="appModalNote" hidden></p>',
      "  </div>",
      '  <div class="app-modal-footer">',
      '    <button type="button" class="btn btn-secondary app-modal-button" data-app-modal-cancel>Abbrechen</button>',
      '    <button type="button" class="btn btn-danger app-modal-button" data-app-modal-confirm>OK</button>',
      "  </div>",
      "</div>"
    ].join("");

    document.body.appendChild(overlay);

    modal = {
      overlay,
      card: overlay.querySelector(".app-modal-card"),
      title: overlay.querySelector("#appModalTitle"),
      message: overlay.querySelector("#appModalMessage"),
      note: overlay.querySelector("#appModalNote"),
      cancel: overlay.querySelector("[data-app-modal-cancel]"),
      confirm: overlay.querySelector("[data-app-modal-confirm]")
    };

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        close(false);
      }
    });

    modal.cancel.addEventListener("click", function () {
      close(false);
    });

    modal.confirm.addEventListener("click", function () {
      close(true);
    });

    document.addEventListener("keydown", onKeydown);
    return modal;
  }

  function open(options) {
    const instance = ensureModal();
    window.clearTimeout(hideTimer);

    if (resolver) {
      close(false);
    }

    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    instance.title.textContent = options.title || "Bestaetigung";
    instance.message.textContent = options.message || "";

    if (options.note) {
      instance.note.hidden = false;
      instance.note.textContent = options.note;
    } else {
      instance.note.hidden = true;
      instance.note.textContent = "";
    }

    instance.cancel.hidden = Boolean(options.hideCancel);
    instance.cancel.textContent = options.cancelText || "Abbrechen";
    instance.confirm.textContent = options.confirmText || "OK";
    instance.confirm.className = "btn app-modal-button " + (options.intent === "danger" ? "btn-danger" : "btn-primary");
    instance.card.setAttribute("role", options.hideCancel ? "alertdialog" : "dialog");

    instance.overlay.hidden = false;
    document.body.classList.add("app-modal-open");
    requestAnimationFrame(function () {
      instance.overlay.classList.add(ACTIVE_CLASS);
      instance.confirm.focus();
    });

    return new Promise(function (resolve) {
      resolver = resolve;
    });
  }

  function close(result) {
    if (!modal || !resolver) {
      return;
    }

    const resolve = resolver;
    resolver = null;
    modal.overlay.classList.remove(ACTIVE_CLASS);
    document.body.classList.remove("app-modal-open");

    hideTimer = window.setTimeout(function () {
      modal.overlay.hidden = true;
    }, 180);

    if (lastFocusedElement) {
      lastFocusedElement.focus();
      lastFocusedElement = null;
    }

    resolve(Boolean(result));
  }

  window.AppModal = {
    confirm: function (options) {
      return open(Object.assign({
        title: "Bestaetigung",
        confirmText: "Bestaetigen",
        cancelText: "Abbrechen",
        intent: "danger",
        hideCancel: false
      }, options));
    },
    alert: function (options) {
      return open(Object.assign({
        title: "Hinweis",
        confirmText: "OK",
        cancelText: "Abbrechen",
        intent: "primary",
        hideCancel: true
      }, options));
    }
  };

  document.addEventListener("submit", function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }

    if (!form.dataset.confirmMessage || form.dataset[SUBMIT_LOCK] === "true") {
      return;
    }

    event.preventDefault();

    window.AppModal.confirm({
      title: form.dataset.confirmTitle || "Bestaetigung",
      message: form.dataset.confirmMessage,
      note: form.dataset.confirmNote || "",
      confirmText: form.dataset.confirmAction || "Bestaetigen",
      cancelText: form.dataset.confirmCancel || "Abbrechen",
      intent: form.dataset.confirmVariant === "primary" ? "primary" : "danger"
    }).then(function (confirmed) {
      if (!confirmed) {
        return;
      }

      form.dataset[SUBMIT_LOCK] = "true";
      form.submit();
    });
  });
})();
