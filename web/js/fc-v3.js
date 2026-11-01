/* FireClient v3 — browse upgrades layered on top of the existing launcher.
   1 Top charts (downloads / followed / newest / updated)   6 Cached charts (work offline)
   2 Detail drawer with author + team, links, gallery        7 Crash/error guard banner with copyable diagnostics
   3 Right-click menu on every project card                  8 Keyboard shortcuts  ( / , Esc , ? )
   4 Favorites                                               9 Surprise me
   5 Recently viewed                                        10 "Fits your version" badge
   Nothing here replaces existing handlers; every hook is wrapped so a failure here can never break the launcher. */
(function () {
  'use strict';
  var API = 'https://api.modrinth.com/v2';
  var TTL = 30 * 60 * 1000;
  var LS = { fav: 'fc3-fav', recent: 'fc3-recent', top: 'fc3-top:' };

  /* ------------------------------------------------------------------ helpers */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(tag, cls, html) { var n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { report(e, 'fc-v3'); } }; }
  function jget(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function toast(m, t) { try { if (typeof window.toast === 'function') window.toast(m, t); } catch (e) {} }
  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function openExternal(u) {
    if (!/^https:\/\//i.test(u)) return;
    try { (window.ipc || window.require('electron').ipcRenderer).send('open-external', u); } catch (e) { try { window.open(u, '_blank'); } catch (_) {} }
  }
  function copy(t, msg) {
    var done = function () { toast(msg || 'Copied'); };
    try { navigator.clipboard.writeText(t).then(done, function () { fallback(); }); } catch (e) { fallback(); }
    function fallback() { var a = el('textarea'); a.value = t; a.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(a); a.select(); try { document.execCommand('copy'); done(); } catch (e) {} a.remove(); }
  }
  function selMc() {
    try {
      var S = window.SU || window.__SU; if (!S || !S.selVer) return '';
      var v = (S.versions || []).filter(function (x) { return (x.id || x.versionId || x.name) === S.selVer; })[0] || {};
      var mc = String(v.mcVersion || v.minecraftVersion || '');
      if (!mc) { var m = String(S.selVer).match(/(?:^|[-_])(1\.\d+(?:\.\d+)?)(?=$|[-_])/); if (m) mc = m[1]; }
      return mc;
    } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------ 7  error guard */
  var diag = [];
  function report(err, where) {
    try {
      var msg = (err && (err.stack || err.message)) || String(err);
      diag.push(new Date().toISOString() + ' [' + (where || 'app') + '] ' + msg);
      if (diag.length > 40) diag.shift();
      if (/ResizeObserver|Script error\.?$/i.test(msg)) return;
      showErr(String((err && err.message) || err).slice(0, 140));
    } catch (e) {}
  }
  var errBox, errTimer;
  function showErr(text) {
    if (!errBox) {
      errBox = el('div'); errBox.id = 'fc3-err'; errBox.setAttribute('role', 'alert');
      errBox.innerHTML = '<div><b>Something went wrong</b><span></span></div><button data-a="copy">Copy details</button><button data-a="x">Dismiss</button>';
      errBox.addEventListener('click', function (e) {
        var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'copy') copy('FireClient diagnostics\n' + navigator.userAgent + '\n\n' + diag.join('\n'), 'Diagnostics copied');
        if (a) errBox.classList.remove('on');
      });
      document.body.appendChild(errBox);
    }
    errBox.querySelector('span').textContent = text;
    errBox.classList.add('on');
    clearTimeout(errTimer); errTimer = setTimeout(function () { errBox.classList.remove('on'); }, 9000);
  }
  window.addEventListener('error', function (e) { if (e && e.message) report(e.error || e.message, 'window'); });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason; if (r && /fetch|network|Failed to load|abort/i.test(String(r.message || r))) return; report(r, 'promise');
  });

  /* ------------------------------------------------------------------ data */
  var memo = {};
  function api(path) {
    return fetch(API + path, { headers: { 'Accept': 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('Modrinth HTTP ' + r.status); return r.json();
    });
  }
  function topList(pt, index) {
    var key = LS.top + pt + ':' + index, c = jget(key, null), fresh = c && (Date.now() - c.t) < TTL;
    if (fresh) return Promise.resolve({ hits: c.hits, cached: true });
    var facets = encodeURIComponent(JSON.stringify([['project_type:' + pt]]));
    return api('/search?query=&limit=12&index=' + index + '&facets=' + facets).then(function (r) {
      var hits = (r.hits || []).map(slim); jset(key, { t: Date.now(), hits: hits }); return { hits: hits };
    }).catch(function (e) {
      if (c && c.hits) return { hits: c.hits, cached: true, stale: true };
      throw e;
    });
  }
  function slim(h) {
    return { id: h.project_id || h.id, slug: h.slug, title: h.title, author: h.author, description: h.description, icon: h.icon_url,
      downloads: h.downloads, follows: h.follows, versions: h.versions || [], pt: h.project_type, cats: h.display_categories || h.categories || [] };
  }
  function project(slug) {
    if (memo[slug]) return memo[slug];
    var p = Promise.all([api('/project/' + encodeURIComponent(slug)),
      api('/project/' + encodeURIComponent(slug) + '/members').catch(function () { return []; })])
      .then(function (r) { return { p: r[0], team: r[1] }; });
    memo[slug] = p; p.catch(function () { delete memo[slug]; }); return p;
  }

  /* ------------------------------------------------------------------ 4/5 favorites + recent */
  function favs() { return jget(LS.fav, []); }
  function isFav(slug) { return favs().some(function (f) { return f.slug === slug; }); }
  function toggleFav(item) {
    var l = favs(), i = -1; l.forEach(function (f, k) { if (f.slug === item.slug) i = k; });
    if (i >= 0) l.splice(i, 1); else l.unshift({ slug: item.slug, id: item.id, title: item.title, author: item.author, icon: item.icon, pt: item.pt, description: item.description, downloads: item.downloads, follows: item.follows, versions: [] });
    jset(LS.fav, l.slice(0, 120)); syncFavButtons();
    toast(i >= 0 ? 'Removed from favorites' : 'Added to favorites');
  }
  function pushRecent(item) {
    var l = jget(LS.recent, []).filter(function (r) { return r.slug !== item.slug; });
    l.unshift({ slug: item.slug, id: item.id, title: item.title, icon: item.icon, pt: item.pt, author: item.author });
    jset(LS.recent, l.slice(0, 10)); renderRecent();
  }
  function syncFavButtons() {
    [].forEach.call(document.querySelectorAll('.fc3-fav'), function (b) { b.classList.toggle('on', isFav(b.getAttribute('data-slug'))); });
    var d = $('fc3-drawer'); if (d) { var fb = d.querySelector('[data-a="fav"]'); if (fb) { var on = isFav(fb.getAttribute('data-slug')); fb.classList.toggle('on', on); fb.textContent = on ? 'Favorited' : 'Favorite'; } }
    refreshFavTabs();
  }

  /* ------------------------------------------------------------------ 1/6/10 top charts */
  var HOSTS = [
    { host: 'su-mr-results', pt: function () { return 'mod'; }, label: 'Mods', input: 'su-mr-q' },
    { host: 'su-mp-results', pt: function () { var S = window.SU || window.__SU; return (S && S.mp && S.mp.type) || 'mod'; }, label: 'Modrinth', input: 'su-mp-q' },
    { host: 'su-rp-results', pt: function () { return 'resourcepack'; }, label: 'Resource packs', input: 'su-rp-q' },
    { host: 'su-sh-results', pt: function () { return 'shader'; }, label: 'Shaders', input: 'su-sh-q' }
  ];
  var MODES = [['downloads', 'Most downloaded'], ['follows', 'Most followed'], ['newest', 'Newest'], ['updated', 'Updated'], ['fav', 'Favorites']];
  var NOUN = { mod: 'mods', modpack: 'modpacks', resourcepack: 'resource packs', shader: 'shaders' };
  var state = {};

  function mountCharts() {
    var n = 0;
    HOSTS.forEach(function (H) {
      var host = $(H.host); if (!host || host.getAttribute('data-fc3')) return;
      host.setAttribute('data-fc3', '1'); n++;
      var box = el('section', 'fc3-top'); box.id = 'fc3-top-' + H.host;
      box.innerHTML = '<div class="fc3-top-head"><h3>Top charts<small></small></h3><div class="fc3-seg" role="tablist"></div><div class="fc3-tools"><button data-a="surprise" title="Open a random top project">Surprise me</button></div></div><div class="fc3-grid"></div>';
      var seg = box.querySelector('.fc3-seg');
      MODES.forEach(function (m, i) {
        var b = el('button'); b.textContent = m[1]; b.setAttribute('data-m', m[0]); b.setAttribute('role', 'tab'); if (i === 0) b.className = 'on'; seg.appendChild(b);
      });
      var pag = host.previousElementSibling && (host.previousElementSibling.id === 'su-mp-pagination' || host.previousElementSibling.classList.contains('su-pagination')) ? host.previousElementSibling : null;
      var anchor = pag || ((host.previousElementSibling && host.previousElementSibling.classList.contains('su-results-head')) ? host.previousElementSibling : host);
      anchor.parentNode.insertBefore(box, anchor);
      state[H.host] = { mode: 'downloads', items: [] };
      box.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('.fc3-seg button');
        if (b) { state[H.host].mode = b.getAttribute('data-m'); [].forEach.call(seg.children, function (x) { x.classList.toggle('on', x === b); }); loadChart(H); return; }
        var s = e.target.closest && e.target.closest('[data-a="surprise"]');
        if (s) return surprise(H);
        cardClick(e, H);
      });
      box.addEventListener('contextmenu', function (e) { cardMenu(e, H); });
      box.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('fc3-card')) { e.preventDefault(); openDrawerFor(itemOf(e.target, H)); } });
      var inp = $(H.input);
      if (inp) inp.addEventListener('input', function () { syncVisibility(H); });
      // results replace the host's content when a search runs; sync visibility
      new MutationObserver(function () { syncVisibility(H); }).observe(host, { childList: true });
      syncVisibility(H); loadChart(H);
    });
    return n;
  }
  function syncVisibility(H) {
    var box = $('fc3-top-' + H.host), inp = $(H.input); if (!box) return;
    var q = inp && inp.value.trim();
    var host = $(H.host);
    var isSubPage = false;
    if (H.host === 'su-mp-results') {
      try {
        if (typeof window.suMpCurrentPage === 'number' && window.suMpCurrentPage > 1) isSubPage = true;
        var info = $('su-mp-page-info');
        if (info && /Page\s+([2-9]|\d{2,})/i.test(info.textContent)) isSubPage = true;
      } catch(_) {}
    }
    // If a search query is typed OR the user is on page 2+, hide the top charts showcase
    // so the paginated modpack/mod/resourcepack grid is clear and uncluttered.
    if (q || isSubPage) {
      box.style.display = 'none';
    } else {
      box.style.display = '';
    }
    // Results host must ALWAYS remain visible so users see the items on all pages
    if (host) host.style.display = '';
    var head = host && host.previousElementSibling;
    if (head && head.classList.contains('su-results-head')) head.style.display = '';
  }
  window.fc3ReloadChart = function(hostId, pt) {
    var H = HOSTS.find(function(x) { return x.host === hostId; });
    if (H) {
      loadChart(H);
      syncVisibility(H);
    }
  };
  function refreshFavTabs() { HOSTS.forEach(function (H) { if (state[H.host] && state[H.host].mode === 'fav') loadChart(H); }); }

  function loadChart(H) {
    var box = $('fc3-top-' + H.host); if (!box) return;
    var st = state[H.host], grid = box.querySelector('.fc3-grid'), pt = H.pt(), small = box.querySelector('h3 small');
    var mc = selMc(), mode = st.mode, token = (st.token = (st.token || 0) + 1);
    small.textContent = NOUN[pt] || '';
    if (mode === 'fav') {
      var l = favs().filter(function (f) { return !f.pt || f.pt === pt; });
      st.items = l; small.textContent = (NOUN[pt] || '') + ' · saved';
      grid.innerHTML = l.length ? '' : '<div class="fc3-note">No favorites yet. Click the heart on any ' + esc((NOUN[pt] || 'project').replace(/s$/, '')) + ' to keep it here.</div>';
      l.forEach(function (it, i) { grid.appendChild(card(it, i, H, mc, true)); }); return;
    }
    grid.innerHTML = ''; for (var i = 0; i < 6; i++) grid.appendChild(el('div', 'fc3-skel'));
    topList(pt, mode).then(function (r) {
      if (token !== st.token) return;
      st.items = r.hits; grid.innerHTML = '';
      if (r.cached) small.textContent = (NOUN[pt] || '') + (r.stale ? ' · offline copy' : ' · cached');
      r.hits.forEach(function (it, i) { grid.appendChild(card(it, i, H, mc, false)); });
      if (!r.hits.length) grid.innerHTML = '<div class="fc3-note">Nothing to show here yet.</div>';
      syncFavButtons();
    }).catch(function (e) {
      if (token !== st.token) return;
      grid.innerHTML = '<div class="fc3-note">Couldn’t reach Modrinth. Check your connection — charts you opened before are kept offline.<br><button class="fc3-ibtn" style="margin-top:10px" data-retry="1">Retry</button></div>';
      var rb = grid.querySelector('[data-retry]'); if (rb) rb.onclick = function () { loadChart(H); };
    });
  }

  function card(it, i, H, mc, isFavTab) {
    var c = el('div', 'fc3-card'); c.tabIndex = 0; c.setAttribute('data-slug', it.slug); c.setAttribute('data-i', i);
    var fits = mc && it.versions && it.versions.indexOf(mc) >= 0;
    var rank = isFavTab ? '' : (i < 9 ? '0' + (i + 1) : String(i + 1));
    var canInstall = (H.host !== 'su-mp-results') || true;
    c.innerHTML =
      '<span class="rk">' + rank + '</span>' +
      (it.icon ? '<img class="ic" loading="lazy" alt="" src="' + esc(it.icon) + '">' : '<div class="ic ph">' + esc((it.title || '?').charAt(0)) + '</div>') +
      '<div class="tx"><div class="nm">' + esc(it.title) + '</div>' +
      '<div class="by">' + (it.author ? 'by <b>' + esc(it.author) + '</b>' : '&nbsp;') + '</div>' +
      '<div class="ds">' + esc(it.description || '') + '</div>' +
      '<div class="mt"><span>' + fmt(it.downloads) + ' dl</span><span>' + fmt(it.follows) + ' follows</span>' + (fits ? '<span class="fc3-chip ok">fits ' + esc(mc) + '</span>' : '') + '</div></div>' +
      '<div class="side"><button class="fc3-fav" data-slug="' + esc(it.slug) + '" aria-label="Favorite" title="Favorite"><svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 2.9 5 6.4 5c2 0 3.4 1.1 4.1 2.3h3C14.2 6.1 15.6 5 17.6 5c3.5 0 5.4 3.6 4 6.8C19.5 16.4 12 21 12 21z"/></svg></button>' +
      '<button class="fc3-ibtn" data-a="install">Install</button></div>';
    c.__item = it;
    return c;
  }
  function itemOf(node, H) {
    var c = node.closest && node.closest('.fc3-card'); if (!c) return null;
    return c.__item || (state[H.host] && state[H.host].items[+c.getAttribute('data-i')]) || null;
  }
  function cardClick(e, H) {
    var fav = e.target.closest && e.target.closest('.fc3-fav');
    var it = itemOf(e.target, H); if (!it) return;
    if (fav) { e.stopPropagation(); toggleFav(it); return; }
    var ib = e.target.closest && e.target.closest('[data-a="install"]');
    if (ib) { e.stopPropagation(); return install(it, H, ib); }
    openDrawerFor(it);
  }

  function install(it, H, btn) {
    try {
      var S = window.SU || window.__SU; var host = H.host, pt = H.pt();
      if (btn) { btn.classList.remove('installed'); }
      var done = function () { };
      if (host === 'su-mr-results' && typeof window.suMrInstall === 'function') return window.suMrInstall(it.slug, btn);
      if (host === 'su-rp-results' && typeof window.suRpInstall === 'function') { S.rp = S.rp || {}; S.rp.results = [{ project_id: it.id, id: it.id, slug: it.slug, title: it.title }]; return window.suRpInstall(0, btn); }
      if (host === 'su-sh-results' && typeof window.suShInstall === 'function') { S.sh = S.sh || {}; S.sh.results = [{ project_id: it.id, id: it.id, slug: it.slug, title: it.title }]; return window.suShInstall(0, btn); }
      if (host === 'su-mp-results' && typeof window.suMpInstall === 'function') { S.mp.results = [{ project_id: it.id, id: it.id, slug: it.slug, title: it.title, project_type: pt }]; return window.suMpInstall(0, btn); }
      toast('Open the details to install', 'info');
    } catch (e) { report(e, 'install'); }
  }

  function surprise(H) {
    var st = state[H.host], l = (st && st.items) || []; if (!l.length) return toast('Charts are still loading');
    openDrawerFor(l[Math.floor(Math.random() * l.length)]);
  }

  /* ------------------------------------------------------------------ 5 recently viewed strip (above the first chart on each page) */
  function renderRecent() {
    var l = jget(LS.recent, []);
    HOSTS.forEach(function (H) {
      var box = $('fc3-top-' + H.host); if (!box) return;
      var r = box.previousElementSibling && box.previousElementSibling.classList.contains('fc3-recent') ? box.previousElementSibling : null;
      if (!l.length) { if (r) r.remove(); return; }
      if (!r) { r = el('div', 'fc3-recent'); box.parentNode.insertBefore(r, box); r.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) openDrawerFor(JSON.parse(b.getAttribute('data-i'))); }); }
      r.innerHTML = '<span>Recent</span>' + l.slice(0, 6).map(function (x) {
        return '<button data-i="' + esc(JSON.stringify(x)) + '">' + (x.icon ? '<img alt="" src="' + esc(x.icon) + '">' : '') + '<span>' + esc(x.title) + '</span></button>';
      }).join('');
    });
  }

  /* ------------------------------------------------------------------ 2 detail drawer */
  var scrim, drawer, current;
  function ensureDrawer() {
    if (drawer) return;
    scrim = el('div'); scrim.id = 'fc3-scrim'; scrim.addEventListener('click', closeDrawer);
    drawer = el('aside'); drawer.id = 'fc3-drawer'; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true');
    document.body.appendChild(scrim); document.body.appendChild(drawer);
    drawer.addEventListener('click', function (e) {
      var t = e.target; var a = t.closest && t.closest('[data-a]'); var lk = t.closest && t.closest('a[data-u]');
      if (lk) { openExternal(lk.getAttribute('data-u')); return; }
      var g = t.closest && t.closest('.gal img'); if (g) { openExternal(g.getAttribute('data-full')); return; }
      if (!a || !current) return;
      var act = a.getAttribute('data-a');
      if (act === 'x') closeDrawer();
      if (act === 'fav') toggleFav(current.item);
      if (act === 'open') openExternal('https://modrinth.com/' + typeSlug(current.item.pt) + '/' + current.item.slug);
      if (act === 'copy') copy('https://modrinth.com/' + typeSlug(current.item.pt) + '/' + current.item.slug, 'Link copied');
      if (act === 'author') { var au = a.getAttribute('data-author'); searchFor(au); closeDrawer(); }
      if (act === 'install') { var H = hostFor(current.item); if (H) { install(current.item, H, a); } else toast('Open Mods, Modrinth, Resource Packs or Shaders to install'); }
    });
  }
  function typeSlug(pt) { return { mod: 'mod', modpack: 'modpack', resourcepack: 'resourcepack', shader: 'shader' }[pt] || 'mod'; }
  function hostFor(it) {
    var pt = it.pt || 'mod';
    var pageId = (document.querySelector('.su-page.active') || {}).id || '';
    var map = { 'su-page-mods': 'su-mr-results', 'su-page-modrinth': 'su-mp-results', 'su-page-resourcepacks': 'su-rp-results', 'su-page-shaders': 'su-sh-results' };
    var h = map[pageId]; if (!h) { h = { mod: 'su-mr-results', modpack: 'su-mp-results', resourcepack: 'su-rp-results', shader: 'su-sh-results' }[pt]; }
    return HOSTS.filter(function (x) { return x.host === h; })[0] || null;
  }
  function closeDrawer() { if (!drawer) return; drawer.classList.remove('on'); scrim.classList.remove('on'); current = null; }
  var openDrawerFor = safe(function (it) {
    if (!it || !it.slug) return;
    ensureDrawer(); current = { item: it }; pushRecent(it);
    var mc = selMc();
    drawer.innerHTML = head(it) + '<div class="db"><div class="ld">Loading details…</div></div>' + foot(it);
    drawer.classList.add('on'); scrim.classList.add('on');
    var mine = it.slug;
    project(it.slug).then(function (r) {
      if (!current || current.item.slug !== mine) return;
      var p = r.p, team = Array.isArray(r.team) ? r.team : [];
      var owner = team.filter(function (m) { return m.role === 'Owner' || m.is_owner; })[0] || team[0];
      var ownerName = owner && owner.user && (owner.user.username || owner.user.name);
      it.pt = p.project_type || it.pt; it.author = ownerName || it.author; it.id = p.id || it.id;
      var others = team.filter(function (m) { return m !== owner && m.user; }).map(function (m) { return m.user.username; });
      var loaders = (p.loaders || []), gv = (p.game_versions || []);
      var fits = mc && gv.indexOf(mc) >= 0;
      var lnk = [['Source code', p.source_url], ['Issue tracker', p.issues_url], ['Wiki', p.wiki_url], ['Discord', p.discord_url]].filter(function (x) { return x[1] && /^https:\/\//i.test(x[1]); });
      var gal = (p.gallery || []).slice(0, 6);
      drawer.innerHTML = head(it, ownerName, others) +
        '<div class="db"><p class="sum">' + esc(p.description || it.description || '') + '</p>' +
        '<div class="stats"><div><b>' + fmt(p.downloads) + '</b><span>Downloads</span></div><div><b>' + fmt(p.followers) + '</b><span>Followers</span></div><div><b>' + esc(shortDate(p.updated)) + '</b><span>Updated</span></div></div>' +
        (fits !== undefined && mc ? '<div class="sec"><h4>Your version</h4><div class="chips"><span class="fc3-chip ' + (fits ? 'ok' : '') + '">' + (fits ? 'Supports ' + esc(mc) : 'No build listed for ' + esc(mc)) + '</span></div></div>' : '') +
        (loaders.length ? '<div class="sec"><h4>Loaders</h4><div class="chips">' + loaders.map(function (l) { return '<span class="fc3-chip">' + esc(l) + '</span>'; }).join('') + '</div></div>' : '') +
        (gv.length ? '<div class="sec"><h4>Minecraft versions</h4><div class="chips">' + versionChips(gv) + '</div></div>' : '') +
        ((p.categories || []).length ? '<div class="sec"><h4>Categories</h4><div class="chips">' + p.categories.map(function (c) { return '<span class="fc3-chip">' + esc(c) + '</span>'; }).join('') + '</div></div>' : '') +
        (gal.length ? '<div class="sec"><h4>Gallery</h4><div class="gal">' + gal.map(function (g) { return '<img loading="lazy" alt="" src="' + esc(g.url) + '" data-full="' + esc(g.raw_url || g.url) + '" title="' + esc(g.title || '') + '">'; }).join('') + '</div></div>' : '') +
        ((p.license && p.license.name) ? '<div class="sec"><h4>License</h4><div class="chips"><span class="fc3-chip">' + esc(p.license.name) + '</span></div></div>' : '') +
        (lnk.length ? '<div class="sec"><h4>Links</h4><div class="links">' + lnk.map(function (l) { return '<a data-u="' + esc(l[1]) + '">' + esc(l[0]) + '<em>open ↗</em></a>'; }).join('') + '</div></div>' : '') +
        '</div>' + foot(it);
    }).catch(function () {
      if (!current || current.item.slug !== mine) return;
      var b = drawer.querySelector('.db'); if (b) b.innerHTML = '<div class="ld">Couldn’t load details (offline?). You can still open it on Modrinth.</div>';
    });
  });
  function shortDate(s) { try { var d = new Date(s); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); } catch (e) { return '—'; } }
  function versionChips(gv) {
    var rel = gv.filter(function (v) { return /^\d+\.\d+(\.\d+)?$/.test(v); });
    var show = rel.slice(-14).reverse();
    return show.map(function (v) { return '<span class="fc3-chip">' + esc(v) + '</span>'; }).join('') + (rel.length > 14 ? '<span class="fc3-chip">+' + (rel.length - 14) + ' older</span>' : '');
  }
  function head(it, ownerName, others) {
    var name = ownerName || it.author;
    return '<div class="dh">' + (it.icon ? '<img alt="" src="' + esc(it.icon) + '">' : '<div class="ph">' + esc((it.title || '?').charAt(0)) + '</div>') +
      '<div class="t"><h2>' + esc(it.title) + '</h2><div class="au">' + (name ? 'by <b>' + esc(name) + '</b>' : '') +
      (others && others.length ? ' <span>+ ' + esc(others.slice(0, 3).join(', ')) + (others.length > 3 ? ' +' + (others.length - 3) : '') + '</span>' : '') + '</div></div>' +
      '<button class="x" data-a="x" aria-label="Close"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 5l14 14M19 5L5 19"/></svg></button></div>';
  }
  function foot(it) {
    var on = isFav(it.slug);
    return '<div class="df"><button class="main" data-a="install">Install</button><button data-a="fav" data-slug="' + esc(it.slug) + '" class="' + (on ? 'on' : '') + '">' + (on ? 'Favorited' : 'Favorite') + '</button><button data-a="open">Modrinth ↗</button><button data-a="copy">Copy link</button></div>';
  }

  /* ------------------------------------------------------------------ 3 right-click menu */
  var menu;
  function ensureMenu() {
    if (menu) return; menu = el('div'); menu.id = 'fc3-menu'; menu.setAttribute('role', 'menu'); document.body.appendChild(menu);
    document.addEventListener('click', hideMenu, true);
    document.addEventListener('scroll', hideMenu, true);
    window.addEventListener('blur', hideMenu);
    menu.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('button'); if (!b || !menu.__acts) return;
      var f = menu.__acts[b.getAttribute('data-k')]; hideMenu(); if (f) safe(f)();
    });
  }
  function hideMenu() { if (menu) menu.classList.remove('on'); }
  function showMenu(x, y, title, sub, acts) {
    ensureMenu(); menu.__acts = {};
    menu.innerHTML = '<div class="hd">' + esc(title) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' +
      acts.map(function (a, i) {
        if (a === '-') return '<hr>'; menu.__acts[i] = a.run;
        return '<button role="menuitem" data-k="' + i + '">' + esc(a.t) + (a.k ? '<kbd>' + esc(a.k) + '</kbd>' : '') + '</button>';
      }).join('');
    menu.classList.add('on');
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';
    var f = menu.querySelector('button'); if (f) f.focus({ preventScroll: true });
  }
  function projectActions(it) {
    return [
      { t: 'View details', k: 'Enter', run: function () { openDrawerFor(it); } },
      { t: 'Install', run: function () { var H = hostFor(it); if (H) install(it, H, null); else openDrawerFor(it); } },
      { t: isFav(it.slug) ? 'Remove from favorites' : 'Add to favorites', run: function () { toggleFav(it); } },
      '-',
      { t: 'More by ' + (it.author || 'author'), run: function () { searchFor(it.author || it.title); } },
      { t: 'Open on Modrinth', run: function () { openExternal('https://modrinth.com/' + typeSlug(it.pt) + '/' + it.slug); } },
      { t: 'Copy link', run: function () { copy('https://modrinth.com/' + typeSlug(it.pt) + '/' + it.slug, 'Link copied'); } },
      { t: 'Copy name', run: function () { copy(it.title, 'Name copied'); } }
    ];
  }
  function cardMenu(e, H) {
    var it = itemOf(e.target, H); if (!it) return; e.preventDefault();
    showMenu(e.clientX, e.clientY, it.title, it.author ? 'by ' + it.author : '', projectActions(it));
  }
  function searchFor(q) {
    if (!q) return;
    var pageId = (document.querySelector('.su-page.active') || {}).id || '';
    var map = { 'su-page-mods': ['su-mr-q', 'suModrinthSearch'], 'su-page-modrinth': ['su-mp-q', 'suMpSearch'], 'su-page-resourcepacks': ['su-rp-q', 'suRpSearch'], 'su-page-shaders': ['su-sh-q', 'suShSearch'] };
    var m = map[pageId] || map['su-page-modrinth'];
    if (!map[pageId]) { var b = document.querySelector('.su-nav-item[data-supage="modrinth"]'); if (b) b.click(); }
    var inp = $(m[0]); if (!inp) return; inp.value = q; inp.dispatchEvent(new Event('input', { bubbles: true }));
    if (typeof window[m[1]] === 'function') window[m[1]]();
  }

  // Right-click on the app's own cards (search results + installed rows). Delegated, so it covers cards drawn later.
  document.addEventListener('contextmenu', safe(function (e) {
    if (e.target.closest && e.target.closest('.fc3-top,#fc3-drawer,#fc3-menu')) return;
    var card = e.target.closest && e.target.closest('.su-mr-item,.su-pack-card');
    if (card) {
      var it = legacyItem(card); if (!it) return; e.preventDefault();
      showMenu(e.clientX, e.clientY, it.title, it.author ? 'by ' + it.author : '', projectActions(it)); return;
    }
    var row = e.target.closest && e.target.closest('.su-pack-row');
    if (row) {
      var nm = (row.querySelector('.name,.nm,.t') || {}).textContent || '';
      var fileEl = row.querySelector('.file-name'); var file = (fileEl && fileEl.textContent) || '';
      nm = nm.trim(); if (!nm) return; e.preventDefault();
      showMenu(e.clientX, e.clientY, nm, file ? file : 'installed', [
        { t: 'Find on Modrinth', run: function () { searchFor(nm.replace(/\.(jar|zip|disabled)$/i, '')); } },
        { t: 'Copy name', run: function () { copy(nm, 'Name copied'); } }
      ].concat(file ? [{ t: 'Copy file name', run: function () { copy(file, 'File name copied'); } }] : []));
    }
  }));
  function legacyItem(card) {
    var S = window.SU || window.__SU || {};
    var cont = card.parentElement && card.parentElement.id, idx = card.getAttribute('data-idx');
    var raw = null, pt = 'mod';
    if (card.classList.contains('su-mr-item')) { var slug = card.getAttribute('data-slug'); return slug ? { slug: slug, title: ((card.querySelector('.name') || {}).textContent || slug), author: ((card.querySelector('.meta') || {}).textContent || '').split('•')[0].trim(), pt: 'mod' } : null; }
    if (cont === 'su-rp-results') { raw = S.rp && S.rp.results && S.rp.results[idx]; pt = 'resourcepack'; }
    else if (cont === 'su-sh-results') { raw = S.sh && S.sh.results && S.sh.results[idx]; pt = 'shader'; }
    else if (cont === 'su-mp-results') { raw = S.mp && S.mp.results && S.mp.results[idx]; pt = (S.mp && S.mp.type) || 'modpack'; }
    if (!raw) return null; var s = slim(raw); s.pt = s.pt || pt; return s.slug ? s : null;
  }
  // Left-click on a legacy result card (outside its Install button) opens the drawer too.
  document.addEventListener('click', safe(function (e) {
    var card = e.target.closest && e.target.closest('.su-pack-card,.su-mr-item'); if (!card) return;
    if (e.target.closest('button,a,input,select')) return;
    var it = legacyItem(card); if (it) openDrawerFor(it);
  }));

  /* ------------------------------------------------------------------ 8 shortcuts */
  var keys;
  function toggleKeys(on) {
    if (!keys) {
      keys = el('div'); keys.id = 'fc3-keys';
      keys.innerHTML = '<div class="box"><h3>Shortcuts</h3><div class="r"><span>Focus search on a browse page</span><kbd>/</kbd></div><div class="r"><span>Close panel / menu</span><kbd>Esc</kbd></div><div class="r"><span>Show this list</span><kbd>?</kbd></div><div class="r"><span>Open selected card</span><kbd>Enter</kbd></div><div class="r"><span>Right-click any card</span><span>details · install · favorite</span></div></div>';
      keys.addEventListener('click', function () { keys.classList.remove('on'); }); document.body.appendChild(keys);
    }
    keys.classList.toggle('on', on == null ? !keys.classList.contains('on') : on);
  }
  document.addEventListener('keydown', safe(function (e) {
    var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.key === 'Escape') { hideMenu(); closeDrawer(); if (keys) keys.classList.remove('on'); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '?') { e.preventDefault(); toggleKeys(); }
    if (e.key === '/') {
      var pageId = (document.querySelector('.su-page.active') || {}).id || '';
      var id = { 'su-page-mods': 'su-mr-q', 'su-page-modrinth': 'su-mp-q', 'su-page-resourcepacks': 'su-rp-q', 'su-page-shaders': 'su-sh-q' }[pageId];
      var inp = id && $(id); if (inp) { e.preventDefault(); inp.focus(); inp.select(); }
    }
  }));

  /* ------------------------------------------------------------------ opening animation: keep the existing dismiss logic, tighten timing + honest copy */
  safe(function () {
    var s = $('fc-opening-splash'); if (!s) return;
    var st = $('fc-splash-status'), t = [[160, 'Loading profile'], [520, 'Checking game files'], [900, 'Starting']];
    var obs = new MutationObserver(function () { });
    t.forEach(function (x) { setTimeout(function () { if (st && document.body.contains(s) && !s.classList.contains('fc-splash-exit')) st.textContent = x[1]; }, x[0]); });
    void obs;
  })();

  /* ------------------------------------------------------------------ boot */
  function boot() {
    // the launcher builds its pages at runtime, so keep looking until the result hosts exist (and re-mount if a page is rebuilt)
    var tick = function () { if (mountCharts()) renderRecent(); };
    tick(); setInterval(safe(tick), 1500);
    // chips on the Modrinth page change what the chart should show
    var oldSet = window.suMpSetType;
    if (typeof oldSet === 'function' && !oldSet.__fc3) {
      window.suMpSetType = function (t) { var r = oldSet.apply(this, arguments); try { var H = HOSTS[1]; if (state[H.host]) { state[H.host].mode = state[H.host].mode; loadChart(H); } } catch (e) {} return r; };
      window.suMpSetType.__fc3 = true;
    }
    // refresh "fits your version" when the selected instance changes
    document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('.su-ver-pill,#su-launch-pop-inst,.su-ver-row')) setTimeout(function () { HOSTS.forEach(function (H) { if ($(H.host) && state[H.host]) loadChart(H); }); }, 400); }, true);
    window.addEventListener('online', function () { toast('Back online'); HOSTS.forEach(function (H) { if (state[H.host]) loadChart(H); }); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(boot)); else safe(boot)();
  window.FC3 = { openDetails: openDrawerFor, favorites: favs, diagnostics: function () { return diag.slice(); } };
})();
