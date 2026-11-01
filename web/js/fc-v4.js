/* FireClient v4 — the launcher side of the update round.
   1 Update badges on every Modrinth card (a newer build exists for your instance)
   2 Update all: one button that updates every outdated mod of the selected instance
   3 Dependency check before an install: missing required dependencies are listed and can be installed with them
   4 Install progress instead of one opaque "Installing…"
   5 Recently installed strip on the Mods page
   Everything is layered on top of the existing launcher: every hook is wrapped, so a failure here can never break it. */
(function () {
  'use strict';
  var API = 'https://api.modrinth.com/v2';
  var TTL = 30 * 60 * 1000;
  var LS = { recent: 'fc4-recent', updates: 'fc4-updates', installed: 'fc4-iv' };

  /* ------------------------------------------------------------------ helpers */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { report(e, 'fc-v4'); } }; }
  function jget(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function toast(m, t) { try { if (typeof window.toast === 'function') window.toast(m, t); } catch (e) {} }
  function api(path) {
    return fetch(API + path, { headers: { 'Accept': 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('Modrinth HTTP ' + r.status); return r.json();
    });
  }

  var diag = [];
  function report(err, where) {
    try {
      var msg = (err && (err.stack || err.message)) || String(err);
      diag.push(new Date().toISOString() + ' [' + (where || 'app') + '] ' + msg);
      if (diag.length > 40) diag.shift();
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ the selected instance */
  /** The instance the Mods page works on: its id, Minecraft version and loader. */
  function target() {
    try {
      var S = window.SU || window.__SU; if (!S || !S.selVer) return null;
      var v = (S.versions || []).filter(function (x) { return (x.id || x.versionId || x.name) === S.selVer; })[0] || {};
      var mc = String(v.mcVersion || v.minecraftVersion || '').trim();
      if (!mc) { var m = String(S.selVer).match(/(?:^|[-_])(1\.\d+(?:\.\d+)?)(?=$|[-_])/); if (m) mc = m[1]; }
      var loader = String(v.type || v.loader || '').toLowerCase();
      if (loader.includes('neoforge')) loader = 'neoforge';
      else if (loader.includes('fabric')) loader = 'fabric';
      else if (loader.includes('quilt')) loader = 'quilt';
      else if (loader.includes('forge')) loader = 'forge';
      else loader = '';
      return { id: S.selVer, mc: mc, loader: loader, ready: !!(S.selVer && mc && loader) };
    } catch (e) { return null; }
  }

  function installedMods() {
    var t = target();
    if (!t || !window.ipc) return Promise.resolve([]);
    return Promise.resolve(window.ipc.invoke('get-mods', t.id)).then(function (m) { return Array.isArray(m) ? m : []; }).catch(function () { return []; });
  }

  /** The Modrinth projects installed in this instance, straight from the launcher's own registry. */
  function registry(vid) {
    var r = jget('jl-inst-projects:' + vid, {}) || {};
    return r.modrinth || {};
  }

  /** The version of a project that is installed here (recorded when it was installed, file name as fallback). */
  function installedVersions(vid) { return jget(LS.installed + ':' + vid, {}); }

  function recordVersion(vid, projectId, version) {
    var m = installedVersions(vid);
    m[projectId] = version;
    jset(LS.installed + ':' + vid, m);
  }

  /** The version number an installed jar was built from, read from its file name. */
  function versionFromFileName(fileName) {
    var n = String(fileName || '');
    var m = n.match(/-v?(\d[\w.]*?(?:\.\d+)*(?:\+[\w.]+)?)(?:-[a-z]+\.jar|\.jar)/i);
    if (m) return m[1];
    m = n.match(/(\d+\.\d+[\d.]*)/);
    return m ? m[1] : null;
  }

  /** True when the Modrinth version is newer than the installed one. */
  function isNewer(remote, installed) {
    if (!remote || !installed) return false;
    var r = String(remote).replace(/^v/i, '').split(/[.\-+]/);
    var i = String(installed).replace(/^v/i, '').split(/[.\-+]/);
    for (var k = 0; k < Math.max(r.length, i.length); k++) {
      var a = parseInt(r[k], 10), b = parseInt(i[k], 10);
      if (isNaN(a) || isNaN(b)) {
        if ((r[k] || '') === (i[k] || '')) continue;
        return (r[k] || '') > (i[k] || '');
      }
      if (a !== b) return a > b;
    }
    return false;
  }

  /** The newest Modrinth version of a project that fits the instance's Minecraft version and loader. */
  function newestVersion(projectId, t) {
    var q = '?game_versions=' + encodeURIComponent(JSON.stringify([t.mc])) + '&loaders=' + encodeURIComponent(JSON.stringify([t.loader]));
    return api('/project/' + encodeURIComponent(projectId) + '/version' + q).then(function (list) {
      if (!list || !list.length) return null;
      var v = list[0];
      if (!v.files || !v.files.length) return null;
      return v;
    });
  }

  /* ------------------------------------------------------------------ 1/2 update checks */
  function updateKey(vid) { return LS.updates + ':' + vid; }

  /**
   * For every Modrinth mod installed in this instance, asks Modrinth for the newest build that fits the
   * instance. A mod with a newer build gets an update badge. The result is cached for half an hour.
   */
  function checkUpdates(force) {
    var t = target();
    if (!t || !t.ready) return Promise.resolve({});
    var cached = jget(updateKey(t.id), null);
    if (!force && cached && (Date.now() - cached.t) < TTL) return Promise.resolve(cached.mods || {});

    var reg = registry(t.id);
    var ids = Object.keys(reg).filter(function (id) { return id && id !== 'fireclient'; });
    if (!ids.length) { jset(updateKey(t.id), { t: Date.now(), mods: {} }); return Promise.resolve({}); }

    var installed = installedVersions(t.id);
    return api('/projects?ids=' + encodeURIComponent(JSON.stringify(ids))).then(function (projects) {
      var byId = {};
      (projects || []).forEach(function (p) { byId[p.id] = p; });
      return Promise.all(ids.map(function (id) {
        var p = byId[id];
        if (!p) return null;
        return newestVersion(id, t).then(function (v) {
          if (!v) return null;
          var fileName = reg[id];
          var current = installed[id] || versionFromFileName(fileName);
          if (!current) return null;
          if (!isNewer(v.version_number, current)) return null;
          return {
            projectId: id, slug: p.slug, title: p.title, icon: p.icon_url,
            fileName: v.files[0].filename, url: v.files[0].url,
            version: v.version_number, installed: current
          };
        }).catch(function () { return null; });
      })).then(function (list) {
        var map = {};
        list.filter(Boolean).forEach(function (u) { map[u.projectId] = u; });
        jset(updateKey(t.id), { t: Date.now(), mods: map });
        return map;
      });
    }).catch(function (e) { report(e, 'updates'); return {}; });
  }

  /* ------------------------------------------------------------------ 1 update badges */
  /** Adds an "UPDATE" badge to every card that has a newer build available. */
  function badgeCards(map) {
    if (!map || !Object.keys(map).length) return;
    var bySlug = {}, byTitle = {};
    Object.keys(map).forEach(function (k) {
      bySlug[map[k].slug] = map[k];
      byTitle[String(map[k].title || '').toLowerCase()] = map[k];
    });
    [].forEach.call(document.querySelectorAll('.mr-card, .fc3-card'), function (card) {
      if (card.getAttribute('data-fc4') === 'update') return;
      var slug = card.getAttribute('data-slug');
      var title = ((card.querySelector('.mr-name, .nm') || {}).textContent || '').trim().toLowerCase();
      var u = (slug && bySlug[slug]) || byTitle[title];
      if (!u) return;
      var host = card.querySelector('.mr-meta, .mt');
      if (!host) return;
      var b = el('span', 'fc4-badge', 'UPDATE ' + esc(u.version));
      b.setAttribute('data-fc4', 'update');
      b.title = u.installed + ' is installed, ' + u.version + ' is available';
      host.appendChild(b);
    });
  }

  /* ------------------------------------------------------------------ 2 update all */
  function updateAll() {
    var t = target();
    if (!t || !t.ready) { toast('Select a modded instance first', 'error'); return; }
    var btn = $('fc4-update-all');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    checkUpdates(true).then(function (map) {
      var list = Object.keys(map).map(function (k) { return map[k]; });
      if (!list.length) {
        if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
        toast('Every mod is up to date');
        return;
      }
      installAll(list, t, btn);
    }).catch(function (e) { report(e, 'update-all'); toast('Update check failed: ' + (e && e.message || e), 'error'); });
  }

  /** Installs every outdated mod, one after the other, with a progress line. */
  function installAll(list, t, btn) {
    var i = 0;
    function step() {
      if (i >= list.length) {
        if (btn) { btn.disabled = false; btn.textContent = 'Check for updates'; }
        toast(list.length + ' mod' + (list.length === 1 ? '' : 's') + ' updated');
        refreshMods();
        return;
      }
      var u = list[i++];
      if (btn) btn.textContent = 'Updating ' + i + '/' + list.length + '…';
      installMod(u.fileName, u.url, t).then(function (ok) {
        if (ok) recordVersion(t.id, u.projectId, u.version);
        if (btn) btn.textContent = 'Updated ' + i + '/' + list.length;
        if (!ok) toast(u.title + ': update failed', 'error');
        step();
      }).catch(function () { step(); });
    }
    step();
  }

  /** Downloads one file into the instance's mods folder. */
  function installMod(fileName, url, t) {
    if (!window.ipc) return Promise.resolve(false);
    return Promise.resolve(window.ipc.invoke('mr-install-mod', {
      versionId: t.id, fileName: fileName, downloadUrl: url
    })).then(function (r) { return !(r && r.error); }).catch(function () { return false; });
  }

  function refreshMods() {
    try {
      if (typeof window.refreshMods === 'function') window.refreshMods();
      else if (window.SU && window.SU.refreshMods) window.SU.refreshMods();
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ 3 dependency check */
  /**
   * Before a mod is installed, its required dependencies are checked. Anything missing is listed with an
   * "Install" button, so a mod never lands broken.
   */
  function checkDependencies(versionObj, install) {
    var deps = (versionObj && versionObj.dependencies) || [];
    var required = deps.filter(function (d) { return d.dependency_type === 'required' && d.project_id; });
    if (!required.length) return install();
    var ids = required.map(function (d) { return d.project_id; });
    return api('/projects?ids=' + encodeURIComponent(JSON.stringify(ids))).then(function (projects) {
      var byId = {};
      (projects || []).forEach(function (p) { byId[p.id] = p; });
      return installedMods().then(function (mods) {
        var names = mods.map(function (m) { return String(m.name || '').toLowerCase(); });
        var missing = required.filter(function (d) {
          var p = byId[d.project_id]; if (!p) return false;
          var slug = String(p.slug || '').toLowerCase(), title = String(p.title || '').toLowerCase();
          return !names.some(function (f) { return (slug && f.indexOf(slug) >= 0) || (title && f.indexOf(title) >= 0); });
        });
        if (!missing.length) return install();
        return askToInstallDeps(missing, byId, install);
      });
    }).catch(function () { return install(); });
  }

  /** Shows the missing dependencies and installs them before the mod itself. */
  function askToInstallDeps(missing, byId, install) {
    var box = $('fc4-deps');
    if (!box) return install();
    var t = target();
    box.innerHTML = '<div class="fc4-deps-head"><b>Missing dependencies</b><span>' + missing.length + ' mod' + (missing.length === 1 ? '' : 's') + ' needed</span></div>' +
      missing.map(function (d) {
        var p = byId[d.project_id] || {};
        return '<div class="fc4-dep">' + (p.icon_url ? '<img alt="" src="' + esc(p.icon_url) + '">' : '') +
          '<span class="n">' + esc(p.title || d.project_id) + '</span>' +
          '<button data-fc4-dep="' + esc(d.project_id) + '">Install</button></div>';
      }).join('') +
      '<div class="fc4-deps-foot"><button data-fc4-skip>Install without them</button><button data-fc4-cancel>Cancel</button></div>';
    box.classList.add('on');
    return new Promise(function (resolve) {
      function close() { box.classList.remove('on'); box.onclick = null; }
      box.onclick = function (e) {
        var b = e.target.closest('button'); if (!b) return;
        if (b.hasAttribute('data-fc4-cancel')) { close(); resolve(false); return; }
        if (b.hasAttribute('data-fc4-skip')) { close(); resolve(install()); return; }
        var id = b.getAttribute('data-fc4-dep');
        b.disabled = true; b.textContent = 'Installing…';
        newestVersion(id, t).then(function (v) {
          if (!v) { b.disabled = false; b.textContent = 'Retry'; return; }
          return installMod(v.files[0].filename, v.files[0].url, t).then(function (ok) {
            if (ok) { b.textContent = 'Installed'; return; }
            b.disabled = false; b.textContent = 'Retry';
          });
        }).catch(function () { b.disabled = false; b.textContent = 'Retry'; });
      };
    });
  }

  /* ------------------------------------------------------------------ 4 install progress */
  /** A small progress line under the search box while something is being installed. */
  function progressUI() {
    var host = $('fc4-progress');
    if (!host) return null;
    return {
      show: function (label) { host.innerHTML = '<span class="fc4-pl">' + esc(label) + '</span><div class="fc4-bar"><i></i></div>'; host.classList.add('on'); },
      set: function (pct) { var b = host.querySelector('i'); if (b) b.style.width = Math.max(2, Math.min(100, pct)) + '%'; },
      done: function (label) { host.innerHTML = '<span class="fc4-pl">' + esc(label) + '</span>'; setTimeout(function () { host.classList.remove('on'); }, 2500); }
    };
  }

  /* ------------------------------------------------------------------ 5 recently installed */
  function pushRecent(mod) {
    var l = jget(LS.recent, []).filter(function (r) { return r.file !== mod.name; });
    l.unshift({ title: mod.displayName || mod.name, file: mod.name, at: Date.now() });
    jset(LS.recent, l.slice(0, 8));
    renderRecent();
  }

  function renderRecent() {
    var host = $('fc4-recent');
    if (!host) return;
    var l = jget(LS.recent, []);
    if (!l.length) { host.innerHTML = ''; host.classList.remove('on'); return; }
    host.classList.add('on');
    host.innerHTML = '<span class="fc4-rh">Recently installed</span>' + l.map(function (r) {
      return '<button title="' + esc(r.file || '') + '">' + esc(r.title || r.file) + '</button>';
    }).join('');
  }

  /* ------------------------------------------------------------------ hooking the existing installs */
  /** Wraps the launcher's own install functions: dependency check first, progress while it runs. */
  function hookInstalls() {
    if (!window.suMrInstall || window.suMrInstall.__fc4) return;
    var orig = window.suMrInstall;
    var wrapped = function (slug, btn) {
      var t = target();
      if (!t || !t.ready) return orig(slug, btn);
      var ui = progressUI();
      return api('/project/' + encodeURIComponent(slug)).then(function (p) {
        return newestVersion(p.id, t);
      }).then(function (v) {
        if (!v) return orig(slug, btn);
        return checkDependencies(v, function () {
          if (ui) ui.show('Installing ' + slug + '…');
          return orig(slug, btn).then(function (r) {
            if (ui) ui.done('Installed ' + slug);
            recordVersion(t.id, v.project_id || slug, v.version_number);
            return r;
          });
        });
      }).catch(function () { return orig(slug, btn); });
    };
    wrapped.__fc4 = true;
    window.suMrInstall = wrapped;
  }

  function hookRegistryInstall() {
    if (!window.mrInstallFromRegistry || window.mrInstallFromRegistry.__fc4) return;
    var orig = window.mrInstallFromRegistry;
    var wrapped = function (idx, btn) {
      var v = (window._mrVerList || [])[idx];
      var t = target();
      if (!v || !t || !t.ready) return orig(idx, btn);
      var ui = progressUI();
      return checkDependencies(v, function () {
        if (ui) ui.show('Installing ' + (v.name || v.version_number) + '…');
        return orig(idx, btn).then(function (r) {
          if (ui) ui.done('Installed ' + (v.name || v.version_number));
          var pid = window.mrCurrentProject && window.mrCurrentProject.projectId;
          if (pid) recordVersion(t.id, pid, v.version_number);
          return r;
        });
      });
    };
    wrapped.__fc4 = true;
    window.mrInstallFromRegistry = wrapped;
  }

  /* ------------------------------------------------------------------ boot */
  function mount() {
    var page = $('su-page-mods');
    if (!page) return false;

    // the button belongs next to the installed-mod count
    var count = $('su-mods-count');
    var head = count ? count.closest('.su-section-head') : null;
    if (head && !$('fc4-update-all')) {
      var btn = el('button', 'su-btn fc4-update-all', 'Check for updates');
      btn.id = 'fc4-update-all';
      btn.onclick = safe(updateAll);
      head.appendChild(btn);
    }
    if (!$('fc4-deps')) { var d = el('div', 'fc4-deps'); d.id = 'fc4-deps'; page.appendChild(d); }
    if (!$('fc4-progress')) { var p = el('div', 'fc4-progress'); p.id = 'fc4-progress'; page.appendChild(p); }
    if (!$('fc4-recent')) { var r = el('div', 'fc4-recent'); r.id = 'fc4-recent'; page.appendChild(r); }
    return true;
  }

  function refreshBadges() {
    var t = target();
    if (!t || !t.ready) return;
    checkUpdates(false).then(function (map) {
      badgeCards(map);
      var btn = $('fc4-update-all');
      if (btn && !btn.disabled) {
        var n = Object.keys(map).length;
        btn.textContent = n ? 'Update ' + n + ' mod' + (n === 1 ? '' : 's') : 'Check for updates';
      }
    });
  }

  function boot() {
    var tick = function () { if (mount()) { renderRecent(); hookInstalls(); hookRegistryInstall(); } };
    tick();
    var timer = setInterval(function () { if (mount()) { clearInterval(timer); hookInstalls(); hookRegistryInstall(); } }, 800);

    // the download progress the native side already sends
    try {
      if (window.ipc && window.ipc.on) {
        window.ipc.on('mr-dl-progress', function (_, d) {
          var ui = progressUI(); if (!ui || !d) return;
          ui.set(d.total ? Math.round(d.done / d.total * 100) : 0);
        });
      }
    } catch (e) {}

    // new badges when the instance changes
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.su-ver-chip,#su-launch-pop-inst,.su-ver-row,.su-nav-item')) {
        setTimeout(safe(refreshBadges), 600);
      }
    }, true);
    window.addEventListener('online', safe(refreshBadges));

    // remember what was installed, so the Mods page can show it
    try {
      if (window.ipc && window.ipc.invoke && !window.ipc.__fc4Patched) {
        var origInvoke = window.ipc.invoke.bind(window.ipc);
        window.ipc.invoke = function (channel) {
          var args = Array.prototype.slice.call(arguments, 1);
          var p = origInvoke.apply(null, [channel].concat(args));
          try {
            if (channel === 'mr-install-mod' || channel === 'install-mod') {
              p.then(function () {
                installedMods().then(function (mods) {
                  var file = args[0] && (args[0].fileName || args[0].filename);
                  if (!file) return;
                  var m = mods.filter(function (x) { return x.name === file; })[0];
                  if (m) pushRecent(m);
                });
              });
            }
          } catch (e) {}
          return p;
        };
        window.ipc.__fc4Patched = true;
      }
    } catch (e) {}

    refreshBadges();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(boot)); else safe(boot)();
  window.FC4 = { checkUpdates: checkUpdates, updateAll: updateAll, diagnostics: function () { return diag.slice(); } };
})();
