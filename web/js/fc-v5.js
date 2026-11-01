/* FireClient v5 — interface density (Comfortable / Compact).
   Persisted in localStorage as fc-density and applied to <html data-fc-density>, so the CSS in fc-v5.css
   does the work and nothing re-renders. Wrapped in try/catch like fc-v4: a failure here can never break
   the launcher. */
(function () {
  'use strict';

  var KEY = 'fc-density';
  var MODES = ['comfortable', 'compact'];
  var LABELS = { comfortable: 'COMFORTABLE', compact: 'COMPACT' };

  function $(id) { return document.getElementById(id); }
  function toast(m) { try { if (typeof window.toast === 'function') window.toast(m); } catch (e) {} }

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return MODES.indexOf(v) >= 0 ? v : 'comfortable';
    } catch (e) { return 'comfortable'; }
  }

  function apply(mode) {
    if (MODES.indexOf(mode) < 0) mode = 'comfortable';
    document.documentElement.setAttribute('data-fc-density', mode);
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    var lbl = $('su-tb-density-lbl');
    if (lbl) lbl.textContent = LABELS[mode];
    var btn = $('su-tb-density');
    if (btn) btn.title = 'Interface density: ' + LABELS[mode].toLowerCase() + ' (click to change)';
    var sw = $('fc-density-sw');
    if (sw) {
      var kids = sw.querySelectorAll('[data-density]');
      for (var i = 0; i < kids.length; i++) {
        var on = kids[i].getAttribute('data-density') === mode;
        kids[i].classList.toggle('primary', on);
        kids[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }

  function cycle() {
    var next = MODES[(MODES.indexOf(read()) + 1) % MODES.length];
    apply(next);
    toast('Interface density: ' + LABELS[next].toLowerCase());
  }

  /* Applies before first paint when the script is loaded in <head>-order (it is: after the stylesheets). */
  apply(read());

  /* The top bar is markup, not built by JS, so wait for it to exist before wiring the button. */
  function wire() {
    var host = document.querySelector('.su-topbar .su-tb-spacer');
    var btn = $('su-tb-density');
    if (!btn && host) {
      btn = document.createElement('button');
      btn.className = 'su-tb-btn';
      btn.id = 'su-tb-density';
      btn.type = 'button';
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
        '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="11" width="18" height="5" rx="1.5"/>' +
        '<rect x="3" y="18" width="10" height="2.5" rx="1.25"/></svg>' +
        '<span id="su-tb-density-lbl"></span>';
      host.insertAdjacentElement('afterend', btn);
    }
    if (btn && !btn.__fcWired) {
      btn.__fcWired = true;
      btn.addEventListener('click', cycle);
    }
    apply(read());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  /* Exposed so the settings page (or the command palette) can offer the same switch. */
  window.fcDensity = { get: read, set: apply, cycle: cycle };

  /* ---------- Launcher fullscreen ---------- */
  /* The window is a borderless WS_POPUP, so a real fullscreen mode has to cover the monitor itself; "maximize" still
     leaves the taskbar visible. The native side keeps the restore rectangle. F11 toggles it anywhere in the launcher. */
  var fsOn = false;

  function setFullscreen(next) {
    fsOn = !!next;
    try {
      if (window.ipc && typeof window.ipc.invoke === 'function') {
        window.ipc.invoke('window-fullscreen', fsOn).then(function (r) {
          if (Array.isArray(r) && typeof r[0] === 'boolean' && r[0] !== fsOn) fsOn = r[0];
          paintIcons();
        }, function () {});
      }
      if (window.ipc && typeof window.ipc.send === 'function') window.ipc.send('window-fullscreen', fsOn);
    } catch (e) {}
    paintIcons();
  }

  function paintIcons() {
    var b = $('wb-fs');
    if (b) {
      b.title = fsOn ? 'Exit fullscreen (F11)' : 'Fullscreen (F11)';
      b.setAttribute('aria-pressed', fsOn ? 'true' : 'false');
      b.classList.toggle('fs-on', fsOn);
    }
  }

  window.fcToggleFullscreen = function () { setFullscreen(!fsOn); };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setFullscreen(!fsOn);
    }
  });

  /* Keep the icon right when the user changes it from the OS (maximize via double-click, Win+Up, etc). */
  try {
    if (window.ipc && typeof window.ipc.on === 'function') {
      window.ipc.on('window-state', function (_e, s) {
        if (s === 'fullscreen') fsOn = true;
        else if (s === 'restored') fsOn = false;
        paintIcons();
      });
    }
  } catch (e) {}

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintIcons);
  else paintIcons();
})();
