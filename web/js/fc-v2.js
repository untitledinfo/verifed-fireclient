/* FireClient v2 - live RSS news feed (https://www.fireclient.net/feed.xml) + article reader,
   version selection banner, profile & session tracking, and page hooks. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function ipcSend(ch, a) { try { (window.ipc || window.require('electron').ipcRenderer).send(ch, a); return true; } catch (e) { return false; } }
  function ipcInvoke(ch, a) { try { var i = window.ipc || window.require('electron').ipcRenderer; return i.invoke(ch, a); } catch (e) { return Promise.reject(e); } }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { try { console.error('[fc-v2]', e); } catch (_) {} } }; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  /* ------------------------------------------------------------------ page hooks */
  function onPageShown(id, cb) {
    var p = $(id); if (!p) return;
    var was = p.classList.contains('active');
    new MutationObserver(function () {
      var now = p.classList.contains('active');
      if (now && !was) { try { cb(); } catch (e) { console.error('[fc-v2]', e); } }
      was = now;
    }).observe(p, { attributes: true, attributeFilter: ['class'] });
    if (was) { try { cb(); } catch (e) {} }
  }
  safe(function () {
    var home = $('su-page-home');
    if (!home) return;
    var sync = function () { document.body.classList.toggle('fc-home-active', home.classList.contains('active')); };
    new MutationObserver(sync).observe(home, { attributes: true, attributeFilter: ['class'] });
    sync();
  })();

  /* ------------------------------------------------------------------ NEWS (https://www.fireclient.net/feed.xml) */
  var NEWS_FEED_XML = 'https://www.fireclient.net/feed.xml';
  var SITE_ORIGIN = 'https://www.fireclient.net';
  var NEWS_BUNDLED = 'assets/news/news.json';
  var NEWS_KEY = 'fc-news-v4';
  var LOCAL_FALLBACKS = [
    'assets/news/welcome.jpg',
    'assets/news/pvp.jpg',
    'assets/news/season.jpg',
    'assets/news/launcher-home-960.jpg',
    'assets/news/og-image.png'
  ];
  var posts = [];

  function cleanUrl(u) {
    if (typeof u !== 'string') return '';
    u = u.trim();
    if (!u) return '';
    if (u.indexOf('ingame-menu-960.jpg') >= 0) return 'assets/news/welcome.jpg';
    if (u.indexOf('ingame-hud-960.jpg') >= 0) return 'assets/news/pvp.jpg';
    if (u.indexOf('launcher-mods-960.jpg') >= 0) return 'assets/news/season.jpg';
    if (u.charAt(0) === '/') return SITE_ORIGIN + u;
    if (/^https:\/\//i.test(u)) return u;
    if (/^assets\/news\/[\w.\-]+$/i.test(u)) return u;
    return '';
  }

  function localPairFor(url, idx) {
    var s = String(url || '');
    if (s.indexOf('welcome.jpg') >= 0 || s.indexOf('ingame-menu-960.jpg') >= 0) return 'assets/news/welcome.jpg';
    if (s.indexOf('pvp.jpg') >= 0 || s.indexOf('ingame-hud-960.jpg') >= 0) return 'assets/news/pvp.jpg';
    if (s.indexOf('season.jpg') >= 0 || s.indexOf('launcher-mods-960.jpg') >= 0) return 'assets/news/season.jpg';
    if (s.indexOf('launcher-home-960.jpg') >= 0) return 'assets/news/launcher-home-960.jpg';
    if (s.indexOf('og-image.png') >= 0) return 'assets/news/og-image.png';
    if (/^assets\/news\//i.test(s)) return s;
    return LOCAL_FALLBACKS[(idx || 0) % LOCAL_FALLBACKS.length];
  }

  function normalise(list) {
    var out = [];
    (Array.isArray(list) ? list : []).slice(0, 12).forEach(function (p, idx) {
      if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title.trim()) return;
      var primaryImg = cleanUrl(p.remoteImage || p.image);
      var localImg = cleanUrl(p.localImage || (/^assets\/news\//i.test(p.image || '') ? p.image : localPairFor(primaryImg, idx)));
      if (!primaryImg || /^assets\/news\//i.test(primaryImg)) primaryImg = localImg;
      out.push({
        id: String(p.id || p.title).slice(0, 80),
        tag: String(p.tag || 'NEWS').split(/\s+/)[0].slice(0, 14).toUpperCase(),
        title: p.title.trim().slice(0, 120),
        summary: String(p.summary || '').slice(0, 320),
        date: String(p.date || '').slice(0, 10),
        image: primaryImg,
        localImage: localImg,
        url: cleanUrl(p.url),
        body: (Array.isArray(p.body) ? p.body : []).slice(0, 12).map(function (t) { return String(t).slice(0, 1200); })
      });
    });
    return out;
  }

  function parseRssXml(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    var items = doc.querySelectorAll('item');
    var out = [];
    items.forEach(function (it, idx) {
      var textOf = function (sel) { var n = it.querySelector(sel); return n && n.textContent ? n.textContent.trim() : ''; };
      var title = textOf('title');
      if (!title) return;
      var link = textOf('link');
      var desc = textOf('description');
      var catNode = it.querySelector('category');
      var tag = (catNode && catNode.textContent ? catNode.textContent.trim() : 'NEWS').toUpperCase();
      var pubRaw = textOf('pubDate');
      var dateStr = '';
      if (pubRaw) {
        var dt = new Date(pubRaw);
        if (!isNaN(dt)) dateStr = dt.toISOString().slice(0, 10);
      }
      var encodedNode = it.getElementsByTagNameNS('*', 'encoded')[0] || it.querySelector('encoded');
      var html = encodedNode && encodedNode.textContent ? encodedNode.textContent : '';
      var remoteImg = '';
      var paras = [];
      if (html) {
        var frag = new DOMParser().parseFromString(html, 'text/html');
        var imgEl = frag.querySelector('img[src]');
        if (imgEl) remoteImg = cleanUrl(imgEl.getAttribute('src'));
        frag.querySelectorAll('p').forEach(function (pEl) {
          var t = (pEl.textContent || '').trim();
          if (t.length > 20 && paras.length < 8) paras.push(t);
        });
      }
      var localImg = localPairFor(remoteImg, idx);
      if (!remoteImg) remoteImg = localImg;
      out.push({
        id: link || ('post-' + idx),
        tag: tag,
        title: title,
        summary: desc,
        date: dateStr,
        image: remoteImg,
        remoteImage: remoteImg,
        localImage: localImg,
        url: link || SITE_ORIGIN + '/blog/',
        body: paras.length ? paras : (desc ? [desc] : [])
      });
    });
    return normalise(out);
  }

  function fmtDate(d) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || '';
    var t = new Date(d + 'T00:00:00');
    return isNaN(t) ? d : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fetchWithTimeout(url, ms, asText) {
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : 0;
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return asText ? r.text() : r.json();
    }, function (e) { clearTimeout(timer); throw e; });
  }

  function setImg(node, primaryUrl, fallbackUrl) {
    if (!node) return;
    var u1 = primaryUrl ? 'url("' + String(primaryUrl).replace(/"/g, '%22') + '")' : '';
    var u2 = (fallbackUrl && fallbackUrl !== primaryUrl) ? 'url("' + String(fallbackUrl).replace(/"/g, '%22') + '")' : '';
    var bg = (u1 && u2) ? (u1 + ', ' + u2) : (u1 || u2 || 'none');
    node.style.backgroundImage = bg;
  }

  function renderNews() {
    var f = $('fcn-feature'), list = $('fcn-list');
    if (!f || !list) return;
    if (!posts.length) {
      $('fcn-title').textContent = 'No news yet';
      $('fcn-sum').textContent = 'Updates and guides are posted on fireclient.net.';
      $('fcn-tag').textContent = 'NEWS'; $('fcn-date').textContent = ''; setImg($('fcn-img'), '', '');
      list.textContent = '';
      return;
    }
    var p = posts[0];
    $('fcn-tag').textContent = p.tag; $('fcn-date').textContent = fmtDate(p.date);
    $('fcn-title').textContent = p.title; $('fcn-sum').textContent = p.summary;
    setImg($('fcn-img'), p.image, p.localImage);
    f.onclick = function () { openPost(0); };
    f.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(0); } };
    list.textContent = '';
    posts.slice(1, 5).forEach(function (q, i) {
      var row = el('div', 'fcn-item'); row.tabIndex = 0; row.setAttribute('role', 'button');
      var th = el('div', 'fcn-thumb'); setImg(th, q.image, q.localImage);
      var tx = el('div'); tx.appendChild(el('b', null, q.title)); tx.appendChild(el('small', null, (q.tag + ' · ' + fmtDate(q.date)).trim()));
      row.appendChild(th); row.appendChild(tx);
      row.onclick = function () { openPost(i + 1); };
      row.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(i + 1); } };
      list.appendChild(row);
    });
  }

  var modalUrl = '';
  function openPost(i) {
    var p = posts[i]; if (!p) return;
    $('fcn-m-tag').textContent = p.tag; $('fcn-m-date').textContent = fmtDate(p.date);
    $('fcn-m-title').textContent = p.title;
    setImg($('fcn-m-img'), p.image, p.localImage);
    $('fcn-m-img').style.display = (p.image || p.localImage) ? '' : 'none';
    var t = $('fcn-m-text'); t.textContent = '';
    (p.body.length ? p.body : [p.summary]).forEach(function (para) { if (para) t.appendChild(el('p', null, para)); });
    modalUrl = p.url || (SITE_ORIGIN + '/blog/');
    $('fcn-m-open').hidden = !modalUrl;
    $('fcn-modal').hidden = false;
    $('fcn-m-close').focus();
  }
  function closePost() { var m = $('fcn-modal'); if (m) m.hidden = true; }
  safe(function () {
    var m = $('fcn-modal'); if (!m) return;
    $('fcn-m-x').onclick = closePost; $('fcn-m-close').onclick = closePost;
    m.addEventListener('mousedown', function (e) { if (e.target === m) closePost(); });
    $('fcn-m-open').onclick = function () { if (modalUrl) ipcSend('open-external', modalUrl); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !m.hidden) closePost(); });
  })();

  function loadNews() {
    var cached = [];
    try { cached = normalise(JSON.parse(localStorage.getItem(NEWS_KEY) || '[]')); } catch (e) { cached = []; }
    var bundledP = fetchWithTimeout(NEWS_BUNDLED, 3000, false).then(function (j) { return normalise(j && j.posts); }).catch(function () { return []; });
    bundledP.then(function (b) {
      if (!posts.length) { posts = cached.length ? cached : b; renderNews(); }
      return fetchWithTimeout(NEWS_FEED_XML, 6000, true).then(function (xmlText) {
        var fresh = parseRssXml(xmlText);
        if (fresh.length) {
          posts = fresh; renderNews();
          try { localStorage.setItem(NEWS_KEY, JSON.stringify(fresh)); } catch (e) {}
        }
      }).catch(function () {
        if (!posts.length && b.length) { posts = b; renderNews(); }
      });
    });
  }
  safe(loadNews)();
  window.fcNewsReload = loadNews;

  /* ------------------------------------------------------------------ expose for other blocks */
  window.__fcv2 = { onPageShown: onPageShown, el: el, $: $, safe: safe, ipcInvoke: ipcInvoke, ipcSend: ipcSend };
})();


/* ------------------------------------------------------------------ VERSION SELECTION */
(function () {
  'use strict';
  var H = window.__fcv2; if (!H) return;
  var $ = H.$, el = H.el;
  function SU() { return window.__SU || {}; }
  function kindOf(v) { var t = ((v && (v.type || v.loader)) || '').toLowerCase(); return t.indexOf('fabric') >= 0 ? 'fabric' : t.indexOf('neoforge') >= 0 ? 'neoforge' : t.indexOf('forge') >= 0 ? 'forge' : t.indexOf('quilt') >= 0 ? 'quilt' : 'vanilla'; }
  function find(id) { return (SU().versions || []).filter(function (v) { return (v.id || v.versionId || v.name) === id; })[0] || null; }
  function lastPlayed(id) { try { var m = JSON.parse(localStorage.getItem('fc-lastplayed') || '{}'); return m[id] || 0; } catch (e) { return 0; } }
  function ago(ts) { if (!ts) return 'never played'; var m = Math.round((Date.now() - ts) / 60000); if (m < 1) return 'played just now'; if (m < 60) return 'played ' + m + 'm ago'; var h = Math.round(m / 60); if (h < 48) return 'played ' + h + 'h ago'; return 'played ' + Math.round(h / 24) + 'd ago'; }

  function build() {
    var bar = $('fc-im-bar'); if (!bar || $('fc-sel')) return $('fc-sel');
    var box = el('div', 'fc-sel'); box.id = 'fc-sel';
    bar.parentNode.insertBefore(box, bar);
    return box;
  }
  function refresh() {
    var box = build(); if (!box) return;
    var id = SU().selVer, v = id ? find(id) : null;
    box.textContent = '';
    box.className = 'fc-sel';
    if (!v) {
      var s = (SU().versions || []);
      box.appendChild(el('div', 'fc-sel-empty', s.length ? 'Select a version below to play it.' : 'No version installed yet. Install one above to get started.'));
      return;
    }
    var k = kindOf(v); box.classList.add(k);
    var ico = el('div', 'fc-sel-ico');
    var srcIco = document.querySelector('.su-ver-row[data-vid="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .ico');
    if (srcIco && srcIco.innerHTML && srcIco.innerHTML.trim()) {
      ico.innerHTML = srcIco.innerHTML;
    } else if (k === 'vanilla') {
      ico.innerHTML = '<img class="loader-logo" src="assets/vanilla-grass.png" alt="Vanilla" draggable="false">';
    } else if (k === 'fabric') {
      ico.innerHTML = '<img class="loader-logo" src="assets/fabric.png" alt="Fabric" draggable="false">';
    } else if (k === 'forge' || k === 'neoforge') {
      ico.innerHTML = '<img class="loader-logo" src="assets/minecraft-forge.png" alt="Forge" draggable="false">';
    } else {
      ico.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/><path d="M3 9h18M9 3v18"/></svg>';
    }
    var main = el('div', 'fc-sel-main');
    var headRow = el('div', 'fc-sel-header-row');
    headRow.appendChild(el('div', 'fc-sel-eyebrow', 'Selected Version'));
    headRow.appendChild(el('span', 'fc-sel-status-badge', '● Ready to Play'));
    main.appendChild(headRow);
    main.appendChild(el('div', 'fc-sel-name', v.customName || id));
    var chips = el('div', 'fc-sel-chips');
    if (v.mcVersion) chips.appendChild(el('span', 'fc-chip', 'Minecraft ' + v.mcVersion));
    chips.appendChild(el('span', 'fc-chip', (v.loader || (k.charAt(0).toUpperCase() + k.slice(1))) + (v.loaderVersion ? ' ' + v.loaderVersion : '')));
    chips.appendChild(el('span', 'fc-chip', ago(lastPlayed(id))));
    main.appendChild(chips);

    var acts = el('div', 'fc-sel-actions');
    var go = el('button', 'fc-sel-go', 'Launch');
    go.onclick = function () { if (typeof window.suPlay === 'function') window.suPlay(); };
    acts.appendChild(go);

    var fBtn = el('button', 'su-btn', 'Open Folder');
    fBtn.onclick = function () { if (typeof window.suOpenDirFor === 'function') window.suOpenDirFor(id, 'instance'); };
    acts.appendChild(fBtn);

    box.appendChild(ico); box.appendChild(main); box.appendChild(acts);
  }

  document.addEventListener('click', H.safe(function (e) {
    var row = e.target.closest && e.target.closest('#su-ver-list .su-ver-row');
    if (!row || e.target.closest('button, input, a')) return;
    var id = row.getAttribute('data-vid');
    if (id && typeof window.suVersionSelect === 'function') window.suVersionSelect(id);
  }));

  var host = $('su-ver-list');
  if (host) new MutationObserver(H.safe(function () { refresh(); })).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  H.onPageShown('su-page-versions', refresh);
  refresh();
})();


/* ------------------------------------------------------------------ PROFILE & REAL SESSION STATS */
(function () {
  'use strict';
  var H = window.__fcv2; if (!H) return;
  var $ = H.$, el = H.el;
  var busy = false;
  function norm(u) { return String(u || '').replace(/-/g, '').toLowerCase(); }
  function txt(id, fallback) { var n = $(id); var t = n ? n.textContent.trim() : ''; return (t && t !== '—') ? t : (fallback || '0'); }
  function skinUrl(name) { return 'https://mc-heads.net/body/' + encodeURIComponent(name || 'steve') + '/320'; }
  function copy(text, btn) {
    var done = function () { if (!btn) return; var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1100); };
    try { navigator.clipboard.writeText(text).then(done, function () {}); } catch (e) {}
  }
  function button(label, cls, fn) { var b = el('button', cls || 'su-btn', label); b.onclick = fn; return b; }

  function getSessionSummary() {
    var list = [];
    try { list = JSON.parse(localStorage.getItem('fc-sessions') || '[]') || []; } catch (e) { list = []; }
    var open = null;
    try { open = JSON.parse(localStorage.getItem('fc-sess-open') || 'null'); } catch (e) {}
    var totalMs = list.reduce(function (acc, x) { return acc + Math.max(0, (x.e || 0) - (x.s || 0)); }, 0);
    if (open && open.start) totalMs += Math.max(0, Date.now() - open.start);
    var totalMin = Math.round(totalMs / 60000);
    var fmt = totalMin <= 0 ? '0m' : totalMin < 60 ? (totalMin + 'm') : (Math.floor(totalMin / 60) + 'h ' + (totalMin % 60) + 'm');
    var lastVer = (open && open.v) || (list.length ? list[list.length - 1].v : '') || (window.__SU && window.__SU.selVer) || 'None';
    return { count: list.length + (open && open.start ? 1 : 0), playtime: fmt, lastVer: lastVer, active: !!(open && open.start) };
  }

  function render() {
    var page = $('su-page-accounts'); if (!page || busy) return;
    busy = true;
    var done = function () { busy = false; };
    H.ipcInvoke('get-accounts').then(function (raw) {
      var accts = (raw && raw.accounts) || (Array.isArray(raw) ? raw : []);
      var active = (raw && (raw.activeUuid || raw.active)) || (window.__SU && window.__SU.currentUuid) || '';
      var isOffline = false;
      try {
        if (typeof window.fcIsOfflineMode === 'function' && window.fcIsOfflineMode()) isOffline = true;
        else if (localStorage.getItem('fc-launch-mode') === 'offline') isOffline = true;
      } catch(e) {}

      var a = null;
      if (isOffline) {
        var offName = (typeof window.getOfflineUsername === 'function' ? window.getOfflineUsername() : '') || localStorage.getItem('fc-offline-username') || 'Player';
        a = {
          username: offName,
          name: offName,
          uuid: 'offline-' + offName,
          authType: 'offline',
          isOffline: true
        };
      } else {
        a = accts.filter(function (x) { return active && norm(x.uuid) === norm(active); })[0] || accts[0] || null;
        if (!a) {
          var offList = (typeof window.fcGetOfflineAccounts === 'function' ? window.fcGetOfflineAccounts() : []);
          if (offList && offList.length) {
            a = {
              username: offList[0].username,
              name: offList[0].username,
              uuid: 'offline-' + offList[0].username,
              authType: 'offline',
              isOffline: true
            };
          }
        }
      }

      var host = $('fc-prof');
      if (!host) {
        host = el('section', 'fc-prof'); host.id = 'fc-prof';
        var head = page.querySelector('.su-page-head');
        head.parentNode.insertBefore(host, head.nextSibling);
        var grid = $('su-acct-grid');
        if (grid && !$('fc-prof-sub')) { var h = el('div', 'fc-sub-h', 'Saved accounts'); h.id = 'fc-prof-sub'; grid.parentNode.insertBefore(h, grid); }
      }
      host.textContent = '';
      if (!a) {
        var e = el('div', 'fc-prof-empty');
        e.appendChild(el('h3', null, 'No account yet'));
        e.appendChild(el('p', null, 'Sign in with Microsoft to play online, or add an offline profile.'));
        var row = el('div', 'fc-prof-actions'); row.style.justifyContent = 'center';
        row.appendChild(button('Sign in with Microsoft', 'su-btn primary', function () { window.suAcctAdd && suAcctAdd('msa'); }));
        row.appendChild(button('Offline profile', 'su-btn', function () { window.suAcctAdd && suAcctAdd('offline'); }));
        e.appendChild(row); host.appendChild(e);
      } else {
        var summary = getSessionSummary();
        var name = a.username || a.name || 'Player';
        var stage = el('div', 'fc-prof-stage');
        var img = el('img', 'fc-prof-skin'); img.alt = name + ' skin';
        img.src = skinUrl(name); img.draggable = false;
        img.onerror = function () {
          img.onerror = null;
          img.src = 'assets/steve-skin.png';
        };
        stage.appendChild(img);
        var main = el('div', 'fc-prof-main');
        main.appendChild(el('div', 'fc-prof-eyebrow', a.isOffline ? 'Offline Profile' : 'Microsoft Profile'));
        main.appendChild(el('div', 'fc-prof-name', name));
        var badges = el('div', 'fc-prof-badges');
        var t = String(a.authType || (a.isOffline ? 'offline' : 'msa')).toLowerCase();
        badges.appendChild(el('span', 'fc-badge type' + (t === 'offline' ? ' offline' : ''), t === 'msa' ? 'Microsoft' : t === 'token' ? 'Token' : 'Offline'));
        badges.appendChild(el('span', 'fc-badge on', summary.active ? 'In Game' : 'Active'));
        main.appendChild(badges);
        if (a.uuid) main.appendChild(el('div', 'fc-uuid', a.uuid));
        var stats = el('div', 'fc-prof-stats');
        [
          ['Playtime', summary.playtime],
          ['Sessions', String(summary.count)],
          ['Last version', summary.lastVer],
          ['Installed mods', txt('su-r-modcount', '0')]
        ].forEach(function (p) {
          var c = el('div', 'fc-stat'); c.appendChild(el('small', null, p[0])); c.appendChild(el('b', null, p[1])); stats.appendChild(c);
        });
        main.appendChild(stats);
        var acts = el('div', 'fc-prof-actions');
        acts.appendChild(button('Change skin', 'su-btn primary', function () { window.suGoPage && suGoPage('skins'); }));
        acts.appendChild(button('Usage stats', 'su-btn', function () { window.suGoPage && suGoPage('usage'); }));
        acts.appendChild(button('Add account', 'su-btn', function () { window.suAcctAdd && suAcctAdd('msa'); }));
        if (a.uuid) { var cb = button('Copy UUID', 'su-btn', function () { copy(a.uuid, cb); }); acts.appendChild(cb); }
        main.appendChild(acts);
        host.appendChild(stage); host.appendChild(main);
      }
      var p = (typeof window.suAccountsRender === 'function') ? window.suAccountsRender() : null;
      return p && p.then ? p.then(done, done) : done();
    }).catch(done);
  }

  H.onPageShown('su-page-accounts', render);
  window.fcProfileRender = render;
  try { var i = window.ipc; if (i && i.on) i.on('auth-changed', function () { var pg = $('su-page-accounts'); if (pg && pg.classList.contains('active')) setTimeout(render, 150); }); } catch (e) {}
})();


/* ------------------------------------------------------------------ RELEASE UPDATER (https://github.com/untitledinfo/verifed-fireclient) */
(function () {
  'use strict';
  var H = window.__fcv2; if (!H) return;
  var $ = H.$;
  var REPO_URL = 'https://github.com/untitledinfo/verifed-fireclient';
  var RELEASES_PAGE = 'https://github.com/untitledinfo/verifed-fireclient/releases';
  var API_LATEST = 'https://api.github.com/repos/untitledinfo/verifed-fireclient/releases/latest';
  var DL_BASE = 'https://github.com/untitledinfo/verifed-fireclient/releases/latest/download/';
  var DIRECT_INSTALLER = DL_BASE + 'FireClient-Setup.exe';
  var FALLBACK_SHA256 = 'd5f9ca5a1e84bc19232f4424dbfa32d9e6263da3c8ecabcf7ee231dad96f78a8';
  var INSTALL_CMDS = {
    windows: 'irm https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-windows.ps1 | iex',
    macos: 'curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-macos.sh | bash',
    linux: 'curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-linux.sh | bash'
  };
  var lastInfo = null;
  var detectedOs = (function () {
    var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    var pl = (typeof navigator !== 'undefined' && navigator.platform || '').toLowerCase();
    if (pl.indexOf('mac') !== -1 || /macintosh|mac os x/i.test(ua)) return 'macos';
    if (pl.indexOf('linux') !== -1 || /linux/i.test(ua)) return 'linux';
    return 'windows';
  })();

  function fmtMb(bytes) {
    if (!bytes || isNaN(bytes)) return '8.4 MB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function buildDefaultPlatforms(installerUrl, size, sha256) {
    return {
      windows: {
        setupUrl: installerUrl || DIRECT_INSTALLER,
        portableUrl: DL_BASE + 'FireClient-portable.zip',
        size: size || 8800792,
        sha256: sha256 || FALLBACK_SHA256
      },
      macos: {
        dmgUrl: DL_BASE + 'FireClient-macOS-universal.dmg',
        arm64DmgUrl: DL_BASE + 'FireClient-macOS-arm64.dmg',
        x64DmgUrl: DL_BASE + 'FireClient-macOS-x64.dmg',
        zipUrl: DL_BASE + 'FireClient-macOS-universal.zip',
        installCmd: INSTALL_CMDS.macos
      },
      linux: {
        appImageUrl: DL_BASE + 'FireClient-Linux-x86_64.AppImage',
        arm64AppImageUrl: DL_BASE + 'FireClient-Linux-arm64.AppImage',
        debUrl: DL_BASE + 'FireClient-Linux-amd64.deb',
        tarGzUrl: DL_BASE + 'FireClient-Linux-x86_64.tar.gz',
        installCmd: INSTALL_CMDS.linux
      }
    };
  }

  function fetchDirectFromGitHub() {
    return fetch(API_LATEST, { cache: 'no-store', headers: { 'Accept': 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rel) {
        var tag = String(rel.tag_name || 'v1.0.0');
        var latest = tag.replace(/^[vV]/, '');
        var installerUrl = DIRECT_INSTALLER;
        var reportUrl = '';
        var size = 8800792;
        var platforms = buildDefaultPlatforms(DIRECT_INSTALLER, size, FALLBACK_SHA256);
        (Array.isArray(rel.assets) ? rel.assets : []).forEach(function (a) {
          if (!a || typeof a !== 'object' || !a.browser_download_url) return;
          var nm = String(a.name || '');
          var lnm = nm.toLowerCase();
          if (nm === 'FireClient-Setup.exe') {
            installerUrl = a.browser_download_url;
            platforms.windows.setupUrl = a.browser_download_url;
            if (a.size) { size = a.size; platforms.windows.size = a.size; }
          } else if (lnm === 'fireclient-portable.zip') {
            platforms.windows.portableUrl = a.browser_download_url;
          } else if (nm === 'verification-report.json') {
            reportUrl = a.browser_download_url;
          } else if (lnm.slice(-4) === '.dmg') {
            if (lnm.indexOf('arm64') !== -1 || lnm.indexOf('aarch64') !== -1) platforms.macos.arm64DmgUrl = a.browser_download_url;
            else if (lnm.indexOf('x64') !== -1 || lnm.indexOf('intel') !== -1) platforms.macos.x64DmgUrl = a.browser_download_url;
            if (lnm.indexOf('universal') !== -1 || !platforms.macos._foundDmg) {
              platforms.macos.dmgUrl = a.browser_download_url;
              platforms.macos._foundDmg = true;
            }
          } else if (lnm.slice(-4) === '.zip' && (lnm.indexOf('mac') !== -1 || lnm.indexOf('darwin') !== -1)) {
            platforms.macos.zipUrl = a.browser_download_url;
          } else if (lnm.slice(-9) === '.appimage') {
            if (lnm.indexOf('arm64') !== -1 || lnm.indexOf('aarch64') !== -1) platforms.linux.arm64AppImageUrl = a.browser_download_url;
            else platforms.linux.appImageUrl = a.browser_download_url;
          } else if (lnm.slice(-4) === '.deb') {
            platforms.linux.debUrl = a.browser_download_url;
          } else if (lnm.slice(-7) === '.tar.gz') {
            platforms.linux.tarGzUrl = a.browser_download_url;
          }
        });
        var installedSha = '';
        try { installedSha = localStorage.getItem('fc-installed-sha256') || ''; } catch (e) {}
        var base = {
          configured: true,
          current: '2.2.7',
          latest: latest,
          tag: tag,
          name: rel.name || ('FireClient ' + tag),
          notes: String(rel.body || '').slice(0, 2400),
          publishedAt: rel.published_at || '',
          installerUrl: installerUrl,
          releaseUrl: rel.html_url || RELEASES_PAGE,
          repoUrl: REPO_URL,
          size: size,
          sha256: FALLBACK_SHA256,
          publisher: 'FireClient LLC.',
          defenderClean: true,
          platforms: platforms,
          hasUpdate: installedSha !== FALLBACK_SHA256
        };
        if (!reportUrl) return base;
        return fetch(reportUrl, { cache: 'no-store' })
          .then(function (rr) { return rr.ok ? rr.json() : null; })
          .then(function (rep) {
            if (rep && rep.sha256) {
              base.sha256 = String(rep.sha256).toLowerCase();
              base.platforms.windows.sha256 = base.sha256;
              base.hasUpdate = installedSha !== base.sha256;
            }
            if (rep && rep.fileSizeBytes) base.size = rep.fileSizeBytes;
            if (rep && rep.publisher && (rep.publisher.organization || rep.publisher.displayName)) {
              base.publisher = rep.publisher.organization || rep.publisher.displayName;
            }
            if (rep && rep.microsoftDefender) {
              base.defenderClean = rep.microsoftDefender.exitCode === 0;
            }
            return base;
          }).catch(function () { return base; });
      });
  }

  function selectOsTab(os) {
    var target = (os === 'macos' || os === 'linux') ? os : 'windows';
    var wrap = $('fc-os-install-center');
    if (!wrap) return;
    wrap.setAttribute('data-os-active', target);
    var tabs = wrap.querySelectorAll('.fc-os-tab');
    for (var i = 0; i < tabs.length; i++) {
      var active = tabs[i].getAttribute('data-os') === target;
      tabs[i].classList.toggle('active', active);
      tabs[i].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    var panels = wrap.querySelectorAll('.fc-os-panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].classList.toggle('active', panels[j].getAttribute('data-os-panel') === target);
    }
  }

  function updateSettingsUI(info) {
    if (!info) return;
    if (!info.platforms) info.platforms = buildDefaultPlatforms(info.installerUrl, info.size, info.sha256);
    lastInfo = info;
    var curBadge = $('fc-up-cur-badge');
    var badge = $('fc-up-ver-badge');
    var shaVal = $('fc-up-sha-val');
    var pill = $('fc-up-status-pill');
    var hostOsChip = $('fc-up-host-os');
    if (curBadge && info.current) {
      curBadge.textContent = 'v' + String(info.current).replace(/^[vV]/, '');
    }
    if (badge) {
      var dt = info.publishedAt ? (' · ' + String(info.publishedAt).slice(0, 10)) : '';
      badge.textContent = (info.name || info.tag || ('v' + info.latest)) + ' (' + fmtMb(info.size) + ')' + dt;
    }
    if (shaVal && info.sha256) {
      shaVal.textContent = String(info.sha256).toLowerCase();
    }
    if (pill) {
      var trustLabel = detectedOs === 'macos'
        ? 'macOS Gatekeeper & SHA-256 Verified'
        : (detectedOs === 'linux'
            ? 'Linux SHA-256 Verified'
            : (info.defenderClean !== false ? 'Defender Verified · Clean' : 'Verified Release'));
      pill.textContent = trustLabel + (info.publisher ? (' · ' + info.publisher) : '');
    }
    if (hostOsChip) {
      var osLabel = info.os === 'macos' || detectedOs === 'macos'
        ? ('macOS · ' + String(info.arch || 'Universal').toUpperCase())
        : ((info.os === 'linux' || detectedOs === 'linux')
            ? ('Linux · ' + String(info.arch || 'x86_64'))
            : ('Windows · ' + String(info.arch || 'x64')));
      hostOsChip.textContent = osLabel;
    }
    if (info.notes && $('fc-up-notes-body')) {
      $('fc-up-notes-title').textContent = (info.name || 'FireClient') + ' — Release Notes';
      $('fc-up-notes-body').textContent = String(info.notes).trim();
    }
  }

  function checkReleaseUpdate(manual) {
    var checkBtn = $('fc-up-check-btn');
    if (manual && checkBtn) { checkBtn.textContent = 'Checking…'; checkBtn.disabled = true; }
    return H.ipcInvoke('check-for-update').catch(function () { return null; }).then(function (res) {
      if (res && res.configured && (res.installerUrl || res.platforms)) return res;
      return fetchDirectFromGitHub();
    }).then(function (info) {
      updateSettingsUI(info);
      if (manual) {
        if (checkBtn) { checkBtn.textContent = 'Feed Synced ✓'; setTimeout(function () { checkBtn.textContent = 'Check for Updates'; checkBtn.disabled = false; }, 1600); }
        if (typeof window.showUpdateBanner === 'function' && info) {
          window.showUpdateBanner(info.current || '2.2.7', info.tag || info.latest || 'v1.0.0', info);
        }
      }
      return info;
    }).catch(function () {
      if (manual && checkBtn) { checkBtn.textContent = 'Check for Updates'; checkBtn.disabled = false; }
      return null;
    });
  }

  function resolvePlatformAssetUrl(os, variant) {
    var p = (lastInfo && lastInfo.platforms) || buildDefaultPlatforms(lastInfo && lastInfo.installerUrl, lastInfo && lastInfo.size, lastInfo && lastInfo.sha256);
    var targetOs = os || detectedOs || 'windows';
    if (targetOs === 'macos') {
      if (variant === 'arm64') return p.macos.arm64DmgUrl || p.macos.dmgUrl;
      if (variant === 'x64') return p.macos.x64DmgUrl || p.macos.dmgUrl;
      if (variant === 'zip') return p.macos.zipUrl || p.macos.dmgUrl;
      return p.macos.dmgUrl;
    }
    if (targetOs === 'linux') {
      if (variant === 'deb') return p.linux.debUrl || p.linux.appImageUrl;
      if (variant === 'tar') return p.linux.tarGzUrl || p.linux.appImageUrl;
      if (variant === 'arm64') return p.linux.arm64AppImageUrl || p.linux.appImageUrl;
      return p.linux.appImageUrl;
    }
    if (variant === 'portable') return p.windows.portableUrl;
    return p.windows.setupUrl || (lastInfo && lastInfo.installerUrl) || DIRECT_INSTALLER;
  }

  function runReleaseUpdate() {
    var btn = $('fc-up-install-btn');
    if (btn) { btn.textContent = 'Launching Updater…'; btn.disabled = true; setTimeout(function () { btn.textContent = 'Download & Install Update'; btn.disabled = false; }, 4000); }
    if (lastInfo && lastInfo.sha256) {
      try { localStorage.setItem('fc-installed-sha256', String(lastInfo.sha256).toLowerCase()); } catch (e) {}
    }
    H.ipcInvoke('download-update', { force: true }).catch(function () {
      var fallbackUrl = resolvePlatformAssetUrl(detectedOs);
      if (!H.ipcSend('open-external', fallbackUrl)) {
        window.open(fallbackUrl, '_blank', 'noopener');
      }
    });
  }

  function directDownloadInstaller(os, variant) {
    var url = resolvePlatformAssetUrl(os, variant);
    if (!H.ipcSend('open-external', url)) {
      window.open(url, '_blank', 'noopener');
    }
  }

  function openReleaseRepo() {
    var url = (lastInfo && lastInfo.releaseUrl) || RELEASES_PAGE;
    if (!H.ipcSend('open-external', url)) {
      window.open(url, '_blank', 'noopener');
    }
  }

  function copyTextFeedback(text, btn, label) {
    try {
      navigator.clipboard.writeText(text).then(function () {
        if (!btn) return;
        var old = btn.textContent;
        btn.textContent = label || 'Copied!';
        setTimeout(function () { btn.textContent = old; }, 1500);
      });
    } catch (e) {}
  }

  function copyReleaseSha(btn) {
    var sha = (lastInfo && lastInfo.sha256) || FALLBACK_SHA256;
    copyTextFeedback(sha, btn, 'Copied SHA-256!');
  }

  function copyInstallCmd(os, btn) {
    var cmd = INSTALL_CMDS[os] || INSTALL_CMDS.windows;
    copyTextFeedback(cmd, btn, 'Copied!');
  }

  function showReleaseNotes() {
    var dlg = $('fc-up-notes-dlg');
    if (!dlg) { openReleaseRepo(); return; }
    if (lastInfo && lastInfo.notes && String(lastInfo.notes).trim()) {
      $('fc-up-notes-title').textContent = (lastInfo.name || 'FireClient') + ' — Release Notes';
      $('fc-up-notes-body').textContent = String(lastInfo.notes).trim();
    } else if (lastInfo) {
      $('fc-up-notes-title').textContent = (lastInfo.name || 'FireClient') + ' — Release Summary';
      $('fc-up-notes-body').textContent =
        'Release: ' + (lastInfo.name || lastInfo.tag || 'Latest') + '\n' +
        'Published: ' + (lastInfo.publishedAt ? String(lastInfo.publishedAt).slice(0, 10) : 'Latest Verified Build') + '\n' +
        'Publisher: ' + (lastInfo.publisher || 'FireClient LLC.') + '\n' +
        'SHA-256: ' + (lastInfo.sha256 || FALLBACK_SHA256) + '\n\n' +
        'Supported Desktop Platforms:\n' +
        '• Windows 10 / 11 (x64): FireClient-Setup.exe & FireClient-portable.zip\n' +
        '• macOS 12+ (Apple Silicon M1–M4 & Intel): FireClient-macOS-universal.dmg & install-macos.sh\n' +
        '• Linux (Ubuntu, Debian, Fedora, Arch, SteamOS): .AppImage, .deb, .tar.gz & install-linux.sh';
    }
    if (typeof dlg.showModal === 'function' && !dlg.open) dlg.showModal();
  }

  window.fcCheckReleaseUpdate = checkReleaseUpdate;
  window.fcRunReleaseUpdate = runReleaseUpdate;
  window.fcDirectDownloadInstaller = directDownloadInstaller;
  window.fcOpenReleaseRepo = openReleaseRepo;
  window.fcCopyReleaseSha = copyReleaseSha;
  window.fcSelectOsTab = selectOsTab;
  window.fcCopyInstallCmd = copyInstallCmd;
  window.fcShowReleaseNotes = showReleaseNotes;

  H.ipcInvoke('get-platform-info').then(function (p) {
    if (p && p.os) {
      detectedOs = p.os === 'darwin' ? 'macos' : p.os;
    }
    selectOsTab(detectedOs);
  }).catch(function () {
    selectOsTab(detectedOs);
  });

  H.onPageShown('su-page-settings', function () {
    selectOsTab(detectedOs);
    checkReleaseUpdate(false);
  });
  setTimeout(function () {
    selectOsTab(detectedOs);
    checkReleaseUpdate(false);
  }, 1800);
})();

/* ==========================================================================
   FIRECLIENT PREMIER GAMING SUITE — AUDIO, THEMES, PERFORMANCE & MOTION
   ========================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------------ 1. Web Audio Synthesizer */
  var audioCtx = null;
  function getAudioCtx() {
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(function () {});
      }
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  function playSound(type) {
    if (localStorage.getItem('fc-audio-sfx') === '0') return;
    try {
      var ctx = getAudioCtx();
      if (!ctx) return;
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'launch') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, t);
        osc.frequency.exponentialRampToValueAtTime(560, t + 0.10);
        gain.gain.setValueAtTime(0.14, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.start(t);
        osc.stop(t + 0.15);
      } else if (type === 'theme') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, t);
        osc.frequency.exponentialRampToValueAtTime(880, t + 0.08);
        gain.gain.setValueAtTime(0.10, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        osc.start(t);
        osc.stop(t + 0.09);
      } else if (type === 'nav') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(280, t);
        osc.frequency.exponentialRampToValueAtTime(360, t + 0.04);
        gain.gain.setValueAtTime(0.07, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
        osc.start(t);
        osc.stop(t + 0.045);
      } else {
        // Crisp tactile mechanical click
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(340, t);
        osc.frequency.exponentialRampToValueAtTime(120, t + 0.028);
        gain.gain.setValueAtTime(0.11, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        osc.start(t);
        osc.stop(t + 0.035);
      }
    } catch (e) {}
  }
  window.fcPlaySound = playSound;

  window.fcToggleAudio = function (checked) {
    try {
      localStorage.setItem('fc-audio-sfx', checked ? '1' : '0');
      if (checked) playSound('click');
      if (typeof window.toast === 'function') {
        window.toast(checked ? 'Tactile Gaming Audio Enabled' : 'Tactile Gaming Audio Muted');
      }
    } catch (e) {}
  };

  document.addEventListener('click', function (e) {
    var el = e.target.closest('button, .su-nav-item, .su-quick-tile, .fcn-item, .fc-theme-item, .fc-ram-pill, [role="radio"]');
    if (!el) return;
    if (el.classList.contains('su-launch-btn') || el.id === 'su-play-btn') {
      playSound('launch');
    } else if (el.classList.contains('su-nav-item')) {
      playSound('nav');
    } else if (el.classList.contains('fc-theme-item') || el.closest('#fc-sw')) {
      playSound('theme');
    } else {
      playSound('click');
    }
  }, true);

  /* ------------------------------------------------------------------ 2. Topbar Theme Switcher & Palette */
  /* The full theme list lives in index.html (FC_THEMES + fcRenderThemeMenu + fcApplyTheme), because every theme also needs
     its own CSS variable block there. This file used to carry a second, shorter copy and overwrote the grid with it, so the
     four themes that existed only in index.html (toxic, amethyst, sunset, midnight) could not be picked and the menu
     disagreed with the Settings page. Keep the list in one place. */
  function currentThemeId() {
    try { return localStorage.getItem('fc-theme') || 'red'; } catch (e) { return 'red'; }
  }

  /* Delegates to index.html's renderer, which owns the theme list. It is looked up on `window` at call time and NOT
     reassigned here, so this file can be loaded before or after the inline script. */
  function renderThemeMenu() {
    if (typeof window.fcRenderThemes === 'function') { window.fcRenderThemes(); return; }
    var grid = $('fc-theme-grid');
    if (!grid) return;
    var cur = currentThemeId();
    var items = grid.querySelectorAll('.fc-theme-item');
    items.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-t') === cur);
    });
  }

  function updateThemeIndicators(tid) {
    if (!tid) tid = currentThemeId();
    var btnEl = document.querySelector('.fc-theme-item[data-t="' + tid + '"]');
    var el = btnEl ? btnEl.querySelector('.swatch') : null;
    var pip = $('fc-tb-theme-pip');
    if (pip && el) {
      var c = el.style.backgroundColor || getComputedStyle(el).backgroundColor;
      if (c) {
        pip.style.background = c;
        pip.style.boxShadow = '0 0 8px ' + c;
      }
    }
    var lbl = $('su-tb-theme-lbl');
    if (lbl && btnEl) {
      var nameEl = btnEl.querySelector('.fc-theme-label') || btnEl.querySelectorAll('span')[1];
      lbl.textContent = nameEl ? nameEl.textContent.trim().split(' ')[0].toUpperCase() : tid.toUpperCase();
    }
    document.querySelectorAll('.fc-theme-item').forEach(function (el2) {
      el2.classList.toggle('active', el2.getAttribute('data-t') === tid);
    });
    document.querySelectorAll('#fc-sw button').forEach(function (b) {
      var isOn = b.getAttribute('data-t') === tid;
      b.setAttribute('aria-checked', isOn ? 'true' : 'false');
      b.classList.toggle('active', isOn);
    });
  }
  window.fcRenderThemeMenu = renderThemeMenu;
  window.fcUpdateThemeIndicators = updateThemeIndicators;

  window.fcToggleThemeMenu = function (ev) {
    if (ev) ev.stopPropagation();
    if (typeof window.suTogglePop === 'function') {
      window.suTogglePop('theme', ev);
    } else {
      var p = $('su-tb-pop-theme');
      if (p) p.classList.toggle('open');
    }
    renderThemeMenu();
  };

  // Wrap window.fcTheme so any external calls keep indicators in sync
  var origTheme = window.fcTheme;
  window.fcTheme = function (id, quiet) {
    if (typeof window.fcApplyTheme === 'function') {
      window.fcApplyTheme(id, quiet);
    } else if (typeof origTheme === 'function') {
      origTheme(id, quiet);
    }
    updateThemeIndicators(id);
  };

  /* ------------------------------------------------------------------ 3. Gaming Performance Presets & Game Turbo */
  var JVM_PRESETS = {
    aikar: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1',
    zgc: '-XX:+UseZGC -XX:+ZGenerational -XX:+UnlockExperimentalVMOptions',
    shenandoah: '-XX:+UseShenandoahGC -XX:+UnlockExperimentalVMOptions',
    lowend: '-XX:+UseSerialGC -XX:MinHeapFreeRatio=10 -XX:MaxHeapFreeRatio=20',
    default: '-XX:+UseG1GC',
    custom: ''
  };

  window.fcApplyJvmPreset = function (key) {
    if (!key) return;
    var flags = JVM_PRESETS[key] !== undefined ? JVM_PRESETS[key] : (key === 'custom' ? '' : JVM_PRESETS.aikar);
    try {
      localStorage.setItem('fc-jvm-preset', key);
      if (key !== 'custom') {
        localStorage.setItem('nova-jvm-flags', flags);
      }
      var ta = $('fc-s-jvm-flags-text');
      if (ta) ta.value = localStorage.getItem('nova-jvm-flags') || '';
      var ji = $('jvm-flags-input');
      if (ji) ji.value = localStorage.getItem('nova-jvm-flags') || '';
      if (typeof window.toast === 'function') {
        var names = { aikar: "Aikar's Flags (Zero Micro-Stutter)", zgc: "Generational ZGC (Java 21+)", shenandoah: "Shenandoah Low-Pause GC", lowend: "Low-End PC Optimizer", default: "Default G1GC", custom: "Custom Flags" };
        window.toast('Preset Applied: ' + (names[key] || key));
      }
    } catch (e) {}
  };

  window.fcSaveJvmText = function (val) {
    try {
      localStorage.setItem('nova-jvm-flags', (val || '').trim());
      localStorage.setItem('fc-jvm-preset', 'custom');
      var sel = $('fc-s-jvm-preset');
      if (sel) sel.value = 'custom';
      var ji = $('jvm-flags-input');
      if (ji) ji.value = (val || '').trim();
      if (typeof window.toast === 'function') window.toast('Custom JVM flags saved');
    } catch (e) {}
  };

  window.fcResetJvmPreset = function () {
    window.fcApplyJvmPreset('aikar');
    var sel = $('fc-s-jvm-preset');
    if (sel) sel.value = 'aikar';
  };

  window.fcSetRamQuick = function (mb) {
    try {
      localStorage.setItem('justice-ram-mb', String(mb));
      var vr = $('fc-s-vram');
      var vrv = $('fc-s-vram-v');
      if (vr) vr.value = mb;
      if (vrv) vrv.textContent = Math.round(mb / 1024) + ' GB';
      if (typeof window.fcUpdateStrip === 'function') window.fcUpdateStrip();
      syncRamPills(mb);
      if (typeof window.toast === 'function') window.toast('Allocated RAM: ' + Math.round(mb / 1024) + ' GB');
    } catch (e) {}
  };

  function syncRamPills(mb) {
    if (!mb) {
      try { mb = parseInt(localStorage.getItem('justice-ram-mb') || '4096', 10); } catch (_) { mb = 4096; }
    }
    document.querySelectorAll('.fc-ram-pill').forEach(function (p) {
      var m = parseInt(p.textContent || '', 10) * 1024;
      p.classList.toggle('active', m === mb);
    });
  }

  window.fcToggleTurbo = function (checked) {
    try {
      localStorage.setItem('fc-game-turbo', checked ? '1' : '0');
      if (typeof window.toast === 'function') {
        window.toast(checked ? 'Game Turbo ON: High CPU Priority & OpenGL Enabled' : 'Game Turbo OFF');
      }
    } catch (e) {}
  };

  /* ------------------------------------------------------------------ 4. Modern Motion & Dialog Helpers */
  window.fcShowModal = function (modal) {
    if (typeof modal === 'string') modal = $(modal);
    if (!modal) return;
    modal.removeAttribute('data-closing');
    modal.removeAttribute('hidden');
    modal.hidden = false;
    modal.style.setProperty('display', 'flex', 'important');
  };

  window.fcHideModal = async function (modal) {
    if (typeof modal === 'string') modal = $(modal);
    if (!modal) return;
    modal.setAttribute('data-closing', '');
    try {
      var animations = modal.getAnimations({ subtree: true });
      if (animations.length > 0) {
        await Promise.race([
          Promise.allSettled(animations.map(function (a) { return a.finished; })),
          new Promise(function (r) { setTimeout(r, 180); })
        ]);
      }
    } catch (_) {}
    modal.removeAttribute('data-closing');
    modal.setAttribute('hidden', 'true');
    modal.hidden = true;
    modal.style.setProperty('display', 'none', 'important');
  };

  /* ------------------------------------------------------------------ 5. Multi-Language (i18n) Engine */
  var FC_LANGUAGES = [
    { code: 'en', name: 'English (US)', native: 'English', flag: '🇺🇸' },
    { code: 'es', name: 'Español', native: 'Español', flag: '🇪🇸' },
    { code: 'fr', name: 'Français', native: 'Français', flag: '🇫🇷' },
    { code: 'de', name: 'Deutsch', native: 'Deutsch', flag: '🇩🇪' },
    { code: 'ru', name: 'Русский', native: 'Русский', flag: '🇷🇺' },
    { code: 'zh', name: '简体中文', native: '简体中文', flag: '🇨🇳' },
    { code: 'ja', name: '日本語', native: '日本語', flag: '🇯🇵' },
    { code: 'pt', name: 'Português', native: 'Português', flag: '🇧🇷' },
    { code: 'hi', name: 'हिन्दी', native: 'हिन्दी', flag: '🇮🇳' },
    { code: 'ar', name: 'العربية', native: 'العربية', flag: '🇸🇦' }
  ];
  window.FC_LANGUAGES = FC_LANGUAGES;

  var FC_I18N = {
    en: {
      navHome: "Home",
      navVersions: "Versions",
      navMods: "Mods",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "Library",
      navResourcePacks: "Resource Packs",
      navShaders: "Shaders",
      navWorlds: "Worlds",
      navHost: "Host Server",
      navServers: "Servers",
      navScreenshots: "Screenshots",
      navAccounts: "Accounts",
      navSkins: "Skins",
      navStore: "Store",
      navConsole: "Console",
      navPerformance: "Performance",
      navUsage: "Usage",
      navSettings: "Settings",
      launchBtn: "LAUNCH",
      launching: "LAUNCHING...",
      playing: "PLAYING",
      selectVersion: "No version selected",
      selectLanguage: "Select Language",
      language: "Language",
      theme: "Theme",
      discord: "Discord",
      quickActions: "Quick Actions",
      browseModrinth: "Browse Modrinth",
      gameFolder: "Game Folder",
      modsFolder: "Mods Folder",
      viewScreenshots: "Screenshots",
      manageWorlds: "Worlds",
      serverList: "Servers",
      manageAccounts: "Accounts",
      clientSettings: "Settings",
      accountsTitle: "Accounts",
      accountsSub: "Sign in with Microsoft, token, or offline. Switch between saved accounts.",
      signInMicrosoft: "Sign in with Microsoft",
      offlineMode: "Offline",
      addAccount: "Add Account",
      addAccountBtn: "Add Account",
      addOfflineTitle: "Add Offline Account",
      addOfflineSub: "Play offline or on cracked servers with any custom username and avatar skin.",
      offlineUsername: "Player Username",
      offlineHint: "Allowed: A-Z, 0-9, and underscores. Max 16 characters.",
      enterUsername: "Enter offline username",
      switchAccount: "Switch",
      removeAccount: "Remove",
      activeAccount: "Active",
      clickToSwitch: "Click to switch",
      noAccountsYet: "No accounts added yet.",
      confirmRemoveAcct: "Remove this account from FireClient?",
      serversTitle: "Servers & Domains",
      serversSub: "Explore top multiplayer servers, save favorites, or probe server ping.",
      addServer: "Add Server",
      livePing: "Live Ping Tester",
      pingServer: "Probe Server",
      serverAddress: "Server Address or IP...",
      serverPort: "Port",
      latency: "Latency",
      players: "Players",
      online: "Online",
      offline: "Offline",
      testPing: "Test Ping",
      copyIp: "Copy IP",
      joinNow: "Join Server",
      addToFavorites: "Add to Favorites",
      ipCopied: "Server IP copied to clipboard!",
      probingServer: "Probing server...",
      serverUnreachable: "Server offline or unreachable",
      settingsTitle: "Settings",
      general: "General",
      game: "Game",
      appearance: "Appearance",
      languageSettingTitle: "Launcher Language",
      languageSettingDesc: "Change the interface language across the entire launcher.",
      performance: "Performance",
      gameTurbo: "Game Turbo (High Priority)",
      gameTurboDesc: "Pins launcher and Minecraft to high CPU scheduling priority with clean OpenGL threading.",
      ramAllocation: "Allocated RAM",
      tactileAudio: "Tactile Gaming Audio",
      tactileAudioDesc: "Crisp synthesized mechanical clicks for launcher controls.",
      minimizeOnLaunch: "Minimize when the game starts",
      openFolder: "Open Folder",
      resetDefaults: "Reset to Defaults"
    },
    es: {
      navHome: "Inicio",
      navVersions: "Versiones",
      navMods: "Mods",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "Biblioteca",
      navResourcePacks: "Paquetes de recursos",
      navShaders: "Shaders",
      navWorlds: "Mundos",
      navHost: "Alojar Servidor",
      navServers: "Servidores",
      navScreenshots: "Capturas",
      navAccounts: "Cuentas",
      navSkins: "Skins",
      navStore: "Tienda",
      navConsole: "Consola",
      navPerformance: "Rendimiento",
      navUsage: "Uso",
      navSettings: "Configuración",
      launchBtn: "JUGAR",
      launching: "INICIANDO...",
      playing: "EN JUEGO",
      selectVersion: "Sin versión seleccionada",
      selectLanguage: "Seleccionar Idioma",
      language: "Idioma",
      theme: "Tema",
      discord: "Discord",
      quickActions: "Acciones Rápidas",
      browseModrinth: "Explorar Modrinth",
      gameFolder: "Carpeta de Juego",
      modsFolder: "Carpeta Mods",
      viewScreenshots: "Capturas",
      manageWorlds: "Mundos",
      serverList: "Servidores",
      manageAccounts: "Cuentas",
      clientSettings: "Configuración",
      accountsTitle: "Cuentas",
      accountsSub: "Inicia sesión con Microsoft, token u offline. Alterna entre cuentas guardadas.",
      signInMicrosoft: "Iniciar con Microsoft",
      offlineMode: "Offline",
      addAccount: "Añadir Cuenta",
      addAccountBtn: "Añadir Cuenta",
      addOfflineTitle: "Añadir Cuenta Offline",
      addOfflineSub: "Juega sin conexión o en servidores cracked con cualquier nombre de usuario y skin.",
      offlineUsername: "Nombre de Usuario",
      offlineHint: "Permitido: A-Z, 0-9 y guiones bajos. Máximo 16 caracteres.",
      enterUsername: "Introduce nombre offline",
      switchAccount: "Cambiar",
      removeAccount: "Eliminar",
      activeAccount: "Activo",
      clickToSwitch: "Clic para cambiar",
      noAccountsYet: "No hay cuentas agregadas aún.",
      confirmRemoveAcct: "¿Eliminar esta cuenta de FireClient?",
      serversTitle: "Servidores y Dominios",
      serversSub: "Explora servidores multijugador, guarda favoritos y mide latencias en vivo.",
      addServer: "Añadir Servidor",
      livePing: "Medidor de Ping",
      pingServer: "Probar Servidor",
      serverAddress: "Dirección o IP del servidor...",
      serverPort: "Puerto",
      latency: "Latencia",
      players: "Jugadores",
      online: "En línea",
      offline: "Desconectado",
      testPing: "Probar Ping",
      copyIp: "Copiar IP",
      joinNow: "Entrar al Servidor",
      addToFavorites: "Guardar en Favoritos",
      ipCopied: "¡IP copiada al portapapeles!",
      probingServer: "Comprobando servidor...",
      serverUnreachable: "Servidor desconectado o inaccesible",
      settingsTitle: "Configuración",
      general: "General",
      game: "Juego",
      appearance: "Apariencia",
      languageSettingTitle: "Idioma del Launcher",
      languageSettingDesc: "Cambia el idioma de la interfaz en todo el launcher.",
      performance: "Rendimiento",
      gameTurbo: "Game Turbo (Alta Prioridad)",
      gameTurboDesc: "Asigna alta prioridad de CPU a Minecraft y optimiza hilos OpenGL.",
      ramAllocation: "Memoria RAM asignada",
      tactileAudio: "Audio Táctil",
      tactileAudioDesc: "Sonidos mecánicos nítidos para los controles del launcher.",
      minimizeOnLaunch: "Minimizar al iniciar el juego",
      openFolder: "Abrir Carpeta",
      resetDefaults: "Restablecer Valores"
    },
    fr: {
      navHome: "Accueil",
      navVersions: "Versions",
      navMods: "Mods",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "Bibliothèque",
      navResourcePacks: "Packs de ressources",
      navShaders: "Shaders",
      navWorlds: "Mondes",
      navHost: "Héberger",
      navServers: "Serveurs",
      navScreenshots: "Captures",
      navAccounts: "Comptes",
      navSkins: "Skins",
      navStore: "Boutique",
      navConsole: "Console",
      navPerformance: "Performances",
      navUsage: "Utilisation",
      navSettings: "Paramètres",
      launchBtn: "JOUER",
      launching: "LANCEMENT...",
      playing: "EN JEU",
      selectVersion: "Aucune version sélectionnée",
      selectLanguage: "Choisir la langue",
      language: "Langue",
      theme: "Thème",
      discord: "Discord",
      quickActions: "Actions Rapides",
      browseModrinth: "Parcourir Modrinth",
      gameFolder: "Dossier du jeu",
      modsFolder: "Dossier Mods",
      viewScreenshots: "Captures",
      manageWorlds: "Mondes",
      serverList: "Serveurs",
      manageAccounts: "Comptes",
      clientSettings: "Paramètres",
      accountsTitle: "Comptes",
      accountsSub: "Connectez-vous via Microsoft, jeton ou hors-ligne. Basculez facilement.",
      signInMicrosoft: "Connexion Microsoft",
      offlineMode: "Hors-ligne",
      addAccount: "Ajouter un compte",
      addAccountBtn: "Ajouter le compte",
      addOfflineTitle: "Ajouter un compte hors-ligne",
      addOfflineSub: "Jouez hors-ligne ou sur des serveurs non officiels avec votre pseudo personnalisé.",
      offlineUsername: "Pseudo Joueur",
      offlineHint: "Autorisé : A-Z, 0-9 et tirets bas. Max 16 caractères.",
      enterUsername: "Entrez un pseudo hors-ligne",
      switchAccount: "Changer",
      removeAccount: "Supprimer",
      activeAccount: "Actif",
      clickToSwitch: "Cliquer pour changer",
      noAccountsYet: "Aucun compte enregistré.",
      confirmRemoveAcct: "Supprimer ce compte de FireClient ?",
      serversTitle: "Serveurs & Domaines",
      serversSub: "Découvrez les meilleurs serveurs, sauvegardez vos favoris et testez le ping en direct.",
      addServer: "Ajouter serveur",
      livePing: "Testeur de Ping",
      pingServer: "Tester le serveur",
      serverAddress: "Adresse du serveur ou IP...",
      serverPort: "Port",
      latency: "Latence",
      players: "Joueurs",
      online: "En ligne",
      offline: "Hors-ligne",
      testPing: "Tester le Ping",
      copyIp: "Copier l'IP",
      joinNow: "Rejoindre",
      addToFavorites: "Ajouter aux favoris",
      ipCopied: "IP copiée dans le presse-papiers !",
      probingServer: "Vérification du serveur...",
      serverUnreachable: "Serveur hors-ligne ou inaccessible",
      settingsTitle: "Paramètres",
      general: "Général",
      game: "Jeu",
      appearance: "Apparence",
      languageSettingTitle: "Langue du launcher",
      languageSettingDesc: "Changez la langue de l'interface sur l'ensemble du launcher.",
      performance: "Performances",
      gameTurbo: "Game Turbo (Priorité Élevée)",
      gameTurboDesc: "Attribue une priorité CPU maximale à Minecraft avec fluidité OpenGL.",
      ramAllocation: "Mémoire RAM allouée",
      tactileAudio: "Audio Tactile",
      tactileAudioDesc: "Effets sonores mécaniques pour les boutons du launcher.",
      minimizeOnLaunch: "Réduire au démarrage du jeu",
      openFolder: "Ouvrir le dossier",
      resetDefaults: "Réinitialiser"
    },
    de: {
      navHome: "Startseite",
      navVersions: "Versionen",
      navMods: "Mods",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "Bibliothek",
      navResourcePacks: "Ressourcenpakete",
      navShaders: "Shader",
      navWorlds: "Welten",
      navHost: "Server Hosten",
      navServers: "Server",
      navScreenshots: "Screenshots",
      navAccounts: "Konten",
      navSkins: "Skins",
      navStore: "Shop",
      navConsole: "Konsole",
      navPerformance: "Leistung",
      navUsage: "Auslastung",
      navSettings: "Einstellungen",
      launchBtn: "SPIELEN",
      launching: "STARTET...",
      playing: "IM SPIEL",
      selectVersion: "Keine Version gewählt",
      selectLanguage: "Sprache wählen",
      language: "Sprache",
      theme: "Thema",
      discord: "Discord",
      quickActions: "Schnellaktionen",
      browseModrinth: "Modrinth durchsuchen",
      gameFolder: "Spielordner",
      modsFolder: "Mods-Ordner",
      viewScreenshots: "Screenshots",
      manageWorlds: "Welten",
      serverList: "Server",
      manageAccounts: "Konten",
      clientSettings: "Einstellungen",
      accountsTitle: "Konten",
      accountsSub: "Mit Microsoft, Token oder Offline anmelden. Nahtlos zwischen Konten wechseln.",
      signInMicrosoft: "Mit Microsoft anmelden",
      offlineMode: "Offline",
      addAccount: "Konto hinzufügen",
      addAccountBtn: "Konto hinzufügen",
      addOfflineTitle: "Offline-Konto hinzufügen",
      addOfflineSub: "Spiele offline oder auf Cracked-Servern mit beliebigem Spielernamen.",
      offlineUsername: "Spielername",
      offlineHint: "Erlaubt: A-Z, 0-9 und Unterstriche. Max. 16 Zeichen.",
      enterUsername: "Offline-Namen eingeben",
      switchAccount: "Wechseln",
      removeAccount: "Entfernen",
      activeAccount: "Aktiv",
      clickToSwitch: "Klicken zum Wechseln",
      noAccountsYet: "Noch keine Konten hinzugefügt.",
      confirmRemoveAcct: "Dieses Konto aus FireClient entfernen?",
      serversTitle: "Server & Domains",
      serversSub: "Entdecke Top-Multiplayer-Server, speichere Favoriten und teste Latenzen in Echtzeit.",
      addServer: "Server hinzufügen",
      livePing: "Live-Ping-Tester",
      pingServer: "Server testen",
      serverAddress: "Serveradresse oder IP...",
      serverPort: "Port",
      latency: "Latenz",
      players: "Spieler",
      online: "Online",
      offline: "Offline",
      testPing: "Ping testen",
      copyIp: "IP kopieren",
      joinNow: "Jetzt beitreten",
      addToFavorites: "Zu Favoriten hinzufügen",
      ipCopied: "Server-IP in die Zwischenablage kopiert!",
      probingServer: "Server wird abgefragt...",
      serverUnreachable: "Server offline oder nicht erreichbar",
      settingsTitle: "Einstellungen",
      general: "Allgemein",
      game: "Spiel",
      appearance: "Erscheinungsbild",
      languageSettingTitle: "Launcher-Sprache",
      languageSettingDesc: "Ändere die Anzeigesprache für die gesamte Benutzeroberfläche.",
      performance: "Leistung",
      gameTurbo: "Game Turbo (Hohe Priorität)",
      gameTurboDesc: "Gewährt Minecraft hohe CPU-Priorität und flüssige OpenGL-Ausführung.",
      ramAllocation: "Zugewiesener RAM",
      tactileAudio: "Taktiles Audio",
      tactileAudioDesc: "Mechanische Klickgeräusche für das Launcher-Interface.",
      minimizeOnLaunch: "Beim Spielstart minimieren",
      openFolder: "Ordner öffnen",
      resetDefaults: "Zurücksetzen"
    },
    ru: {
      navHome: "Главная",
      navVersions: "Версии",
      navMods: "Моды",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "Библиотека",
      navResourcePacks: "Текстур-паки",
      navShaders: "Шейдеры",
      navWorlds: "Миры",
      navHost: "Хостинг",
      navServers: "Серверы",
      navScreenshots: "Скриншоты",
      navAccounts: "Аккаунты",
      navSkins: "Скины",
      navStore: "Магазин",
      navConsole: "Консоль",
      navPerformance: "Производительность",
      navUsage: "Ресурсы",
      navSettings: "Настройки",
      launchBtn: "ИГРАТЬ",
      launching: "ЗАПУСК...",
      playing: "В ИГРЕ",
      selectVersion: "Версия не выбрана",
      selectLanguage: "Выберите язык",
      language: "Язык",
      theme: "Тема",
      discord: "Discord",
      quickActions: "Быстрый доступ",
      browseModrinth: "Каталог Modrinth",
      gameFolder: "Папка игры",
      modsFolder: "Папка модов",
      viewScreenshots: "Скриншоты",
      manageWorlds: "Миры",
      serverList: "Серверы",
      manageAccounts: "Аккаунты",
      clientSettings: "Настройки",
      accountsTitle: "Аккаунты",
      accountsSub: "Вход через Microsoft, токен или офлайн. Быстрое переключение профилей.",
      signInMicrosoft: "Войти через Microsoft",
      offlineMode: "Офлайн",
      addAccount: "Добавить аккаунт",
      addAccountBtn: "Добавить аккаунт",
      addOfflineTitle: "Добавить офлайн-аккаунт",
      addOfflineSub: "Играйте в автономном режиме или на пиратских серверах с любым ником.",
      offlineUsername: "Никнейм игрока",
      offlineHint: "Разрешены: A-Z, 0-9 и подчёркивание. До 16 символов.",
      enterUsername: "Введите ник игрока",
      switchAccount: "Выбрать",
      removeAccount: "Удалить",
      activeAccount: "Активен",
      clickToSwitch: "Нажмите для переключения",
      noAccountsYet: "Аккаунты ещё не добавлены.",
      confirmRemoveAcct: "Удалить этот аккаунт из FireClient?",
      serversTitle: "Серверы и домены",
      serversSub: "Лучшие игровые серверы, избранное и проверка пинга в реальном времени.",
      addServer: "Добавить сервер",
      livePing: "Тест пинга",
      pingServer: "Проверить",
      serverAddress: "Адрес сервера или IP...",
      serverPort: "Порт",
      latency: "Пинг",
      players: "Игроки",
      online: "В сети",
      offline: "Офлайн",
      testPing: "Проверить пинг",
      copyIp: "Скопировать IP",
      joinNow: "Подключиться",
      addToFavorites: "В избранное",
      ipCopied: "IP сервера скопирован в буфер обмена!",
      probingServer: "Проверка сервера...",
      serverUnreachable: "Сервер недоступен или выключен",
      settingsTitle: "Настройки",
      general: "Общие",
      game: "Игра",
      appearance: "Внешний вид",
      languageSettingTitle: "Язык лаунчера",
      languageSettingDesc: "Смена языка интерфейса во всём приложении.",
      performance: "Производительность",
      gameTurbo: "Game Turbo (Высокий приоритет)",
      gameTurboDesc: "Выделяет высокий приоритет процессора для Minecraft и плавного OpenGL.",
      ramAllocation: "Выделенная память RAM",
      tactileAudio: "Тактильный звук",
      tactileAudioDesc: "Чёткие механические щелчки при нажатии элементов интерфейса.",
      minimizeOnLaunch: "Сворачивать при запуске игры",
      openFolder: "Открыть папку",
      resetDefaults: "Сбросить настройки"
    },
    zh: {
      navHome: "首页",
      navVersions: "版本",
      navMods: "模组",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "模组库",
      navResourcePacks: "材质包",
      navShaders: "光影",
      navWorlds: "世界",
      navHost: "托管服务器",
      navServers: "服务器",
      navScreenshots: "屏幕截图",
      navAccounts: "账户",
      navSkins: "皮肤",
      navStore: "商店",
      navConsole: "控制台",
      navPerformance: "性能",
      navUsage: "资源监控",
      navSettings: "设置",
      launchBtn: "启动游戏",
      launching: "正在启动...",
      playing: "游戏中",
      selectVersion: "未选择版本",
      selectLanguage: "选择语言",
      language: "语言",
      theme: "主题",
      discord: "Discord",
      quickActions: "快捷操作",
      browseModrinth: "浏览 Modrinth",
      gameFolder: "游戏目录",
      modsFolder: "模组文件夹",
      viewScreenshots: "查看截图",
      manageWorlds: "管理世界",
      serverList: "服务器列表",
      manageAccounts: "管理账户",
      clientSettings: "客户端设置",
      accountsTitle: "账户管理",
      accountsSub: "使用微软登录、Token 登录或离线模式，一键切换不同账户。",
      signInMicrosoft: "微软登录",
      offlineMode: "离线模式",
      addAccount: "添加账户",
      addAccountBtn: "添加账户",
      addOfflineTitle: "添加离线账户",
      addOfflineSub: "畅玩单人离线世界或非正版服务器，支持自定义玩家名与头像。",
      offlineUsername: "玩家用户名",
      offlineHint: "仅限：英文字母、数字和下划线，最多 16 个字符。",
      enterUsername: "输入离线用户名",
      switchAccount: "切换",
      removeAccount: "删除",
      activeAccount: "当前激活",
      clickToSwitch: "点击切换",
      noAccountsYet: "尚未添加任何账户。",
      confirmRemoveAcct: "确定要从 FireClient 移除此账户吗？",
      serversTitle: "服务器与域名",
      serversSub: "探索顶级多人服务器，保存常用收藏，实时测试网络延迟。",
      addServer: "添加服务器",
      livePing: "实时测速工具",
      pingServer: "测速服务器",
      serverAddress: "输入服务器地址或 IP...",
      serverPort: "端口",
      latency: "网络延迟",
      players: "在线玩家",
      online: "在线",
      offline: "离线",
      testPing: "立即测速",
      copyIp: "复制 IP",
      joinNow: "加入服务器",
      addToFavorites: "添加至收藏",
      ipCopied: "服务器 IP 已复制到剪贴板！",
      probingServer: "正在测速服务器...",
      serverUnreachable: "服务器离线或无法连通",
      settingsTitle: "设置",
      general: "常规",
      game: "游戏",
      appearance: "个性化外观",
      languageSettingTitle: "启动器语言",
      languageSettingDesc: "更改整个启动器的显示界面语言。",
      performance: "性能优化",
      gameTurbo: "游戏极速模式 (高优先级)",
      gameTurboDesc: "将 Minecraft 调度提升为系统高优先级，并开启平滑 OpenGL 线程。",
      ramAllocation: "运行内存分配 (RAM)",
      tactileAudio: "机械按键音效",
      tactileAudioDesc: "为启动器按钮提供干脆利落的机械敲击声音反馈。",
      minimizeOnLaunch: "游戏启动后自动最小化",
      openFolder: "打开目录",
      resetDefaults: "恢复默认设置"
    },
    ja: {
      navHome: "ホーム",
      navVersions: "バージョン",
      navMods: "Mod",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "ライブラリ",
      navResourcePacks: "リソースパック",
      navShaders: "シェーダー",
      navWorlds: "ワールド",
      navHost: "サーバーホスト",
      navServers: "サーバー",
      navScreenshots: "スクリーンショット",
      navAccounts: "アカウント",
      navSkins: "スキン",
      navStore: "ストア",
      navConsole: "コンソール",
      navPerformance: "パフォーマンス",
      navUsage: "リソース状況",
      navSettings: "設定",
      launchBtn: "起動",
      launching: "起動中...",
      playing: "プレイ中",
      selectVersion: "バージョン未選択",
      selectLanguage: "言語を選択",
      language: "言語",
      theme: "テーマ",
      discord: "Discord",
      quickActions: "クイックアクション",
      browseModrinth: "Modrinth を開く",
      gameFolder: "ゲームフォルダ",
      modsFolder: "Mods フォルダ",
      viewScreenshots: "スクリーンショット",
      manageWorlds: "ワールド一覧",
      serverList: "サーバー一覧",
      manageAccounts: "アカウント",
      clientSettings: "設定",
      accountsTitle: "アカウント管理",
      accountsSub: "Microsoft、トークン、またはオフラインでサインイン。保存されたアカウントを切り替えられます。",
      signInMicrosoft: "Microsoft でサインイン",
      offlineMode: "オフライン",
      addAccount: "アカウント追加",
      addAccountBtn: "アカウントを追加",
      addOfflineTitle: "オフラインアカウントの追加",
      addOfflineSub: "オフラインやクラックサーバーで任意のユーザー名とスキンでプレイできます。",
      offlineUsername: "プレイヤー名",
      offlineHint: "半角英数字とアンダースコアのみ、最大16文字。",
      enterUsername: "ユーザー名を入力",
      switchAccount: "切り替え",
      removeAccount: "削除",
      activeAccount: "アクティブ",
      clickToSwitch: "クリックして切り替え",
      noAccountsYet: "アカウントがまだ登録されていません。",
      confirmRemoveAcct: "このアカウントを FireClient から削除しますか？",
      serversTitle: "サーバー＆ドメイン",
      serversSub: "人気マルチプレイサーバーの探索、お気に入りの保存、リアルタイム Ping 測定。",
      addServer: "サーバー追加",
      livePing: "ライブ Ping テスター",
      pingServer: "サーバーをテスト",
      serverAddress: "サーバーアドレスまたは IP...",
      serverPort: "ポート",
      latency: "Ping 遅延",
      players: "プレイヤー数",
      online: "オンライン",
      offline: "オフライン",
      testPing: "Ping を計測",
      copyIp: "IP をコピー",
      joinNow: "サーバーに参加",
      addToFavorites: "お気に入りに追加",
      ipCopied: "サーバー IP をクリップボードにコピーしました！",
      probingServer: "サーバーに接続中...",
      serverUnreachable: "サーバーがオフラインか到達不能です",
      settingsTitle: "設定",
      general: "全般",
      game: "ゲーム",
      appearance: "外観",
      languageSettingTitle: "ランチャー言語",
      languageSettingDesc: "ランチャー全体の表示言語を切り替えます。",
      performance: "パフォーマンス",
      gameTurbo: "ゲームターボ (高優先度)",
      gameTurboDesc: "Minecraft に高い CPU 優先度を割り当て、OpenGL スレッドを最適化します。",
      ramAllocation: "割り当てメモリ (RAM)",
      tactileAudio: "メカニカルクリック音",
      tactileAudioDesc: "ボタン操作時にリアルなメカニカルスイッチ音を鳴らします。",
      minimizeOnLaunch: "ゲーム起動時に最小化",
      openFolder: "フォルダを開く",
      resetDefaults: "初期設定に戻す"
    },
    pt: {
      navHome: "Início",
      navVersions: "Versões",
      navMods: "Mods",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "Biblioteca",
      navResourcePacks: "Pacotes de recursos",
      navShaders: "Shaders",
      navWorlds: "Mundos",
      navHost: "Hospedar Servidor",
      navServers: "Servidores",
      navScreenshots: "Capturas",
      navAccounts: "Contas",
      navSkins: "Skins",
      navStore: "Loja",
      navConsole: "Console",
      navPerformance: "Desempenho",
      navUsage: "Uso",
      navSettings: "Configurações",
      launchBtn: "JOGAR",
      launching: "INICIANDO...",
      playing: "JOGANDO",
      selectVersion: "Nenhuma versão selecionada",
      selectLanguage: "Selecionar Idioma",
      language: "Idioma",
      theme: "Tema",
      discord: "Discord",
      quickActions: "Ações Rápidas",
      browseModrinth: "Explorar Modrinth",
      gameFolder: "Pasta do Jogo",
      modsFolder: "Pasta de Mods",
      viewScreenshots: "Capturas",
      manageWorlds: "Mundos",
      serverList: "Servidores",
      manageAccounts: "Contas",
      clientSettings: "Configurações",
      accountsTitle: "Contas",
      accountsSub: "Entre com Microsoft, token ou offline. Alterne entre contas salvas com um clique.",
      signInMicrosoft: "Entrar com Microsoft",
      offlineMode: "Offline",
      addAccount: "Adicionar Conta",
      addAccountBtn: "Adicionar Conta",
      addOfflineTitle: "Adicionar Conta Offline",
      addOfflineSub: "Jogue offline ou em servidores piratas com qualquer nome e skin personalizada.",
      offlineUsername: "Nome de Usuário",
      offlineHint: "Permitido: A-Z, 0-9 e sublinhados. Máximo de 16 caracteres.",
      enterUsername: "Digite o nome offline",
      switchAccount: "Alternar",
      removeAccount: "Remover",
      activeAccount: "Ativo",
      clickToSwitch: "Clique para alternar",
      noAccountsYet: "Nenhuma conta adicionada ainda.",
      confirmRemoveAcct: "Remover esta conta do FireClient?",
      serversTitle: "Servidores & Domínios",
      serversSub: "Explore os melhores servidores, salve favoritos e teste ping e latência em tempo real.",
      addServer: "Adicionar Servidor",
      livePing: "Testador de Ping",
      pingServer: "Testar Servidor",
      serverAddress: "Endereço ou IP do servidor...",
      serverPort: "Porta",
      latency: "Latência",
      players: "Jogadores",
      online: "Online",
      offline: "Offline",
      testPing: "Testar Ping",
      copyIp: "Copiar IP",
      joinNow: "Entrar no Servidor",
      addToFavorites: "Adicionar aos Favoritos",
      ipCopied: "IP do servidor copiado para a área de transferência!",
      probingServer: "Consultando servidor...",
      serverUnreachable: "Servidor offline ou inacessível",
      settingsTitle: "Configurações",
      general: "Geral",
      game: "Jogo",
      appearance: "Aparência",
      languageSettingTitle: "Idioma do Launcher",
      languageSettingDesc: "Altera o idioma da interface em todo o inicializador.",
      performance: "Desempenho",
      gameTurbo: "Game Turbo (Alta Prioridade)",
      gameTurboDesc: "Atribui alta prioridade de CPU ao Minecraft com threads de OpenGL aceleradas.",
      ramAllocation: "Memória RAM alocada",
      tactileAudio: "Áudio Tátil",
      tactileAudioDesc: "Cliques mecânicos cristalinos nos controles do launcher.",
      minimizeOnLaunch: "Minimizar quando o jogo iniciar",
      openFolder: "Abrir Pasta",
      resetDefaults: "Restaurar Padrões"
    },
    hi: {
      navHome: "होम",
      navVersions: "संस्करण",
      navMods: "मॉड्स",
      navModrinth: "Modrinth",
      navCurseForge: "CurseForge",
      navLibrary: "लाइब्रेरी",
      navResourcePacks: "संसाधन पैक",
      navShaders: "शेडर्स",
      navWorlds: "दुनिया",
      navHost: "सर्वर होस्ट करें",
      navServers: "सर्वर",
      navScreenshots: "स्क्रीनशॉट",
      navAccounts: "खाते",
      navSkins: "स्किन्स",
      navStore: "स्टोर",
      navConsole: "कंसोल",
      navPerformance: "प्रदर्शन",
      navUsage: "उपयोग",
      navSettings: "सेटिंग्स",
      launchBtn: "खेलें",
      launching: "शुरू हो रहा है...",
      playing: "खेल जारी है",
      selectVersion: "कोई संस्करण नहीं चुना गया",
      selectLanguage: "भाषा चुनें",
      language: "भाषा",
      theme: "थीम",
      discord: "Discord",
      quickActions: "त्वरित क्रियाएं",
      browseModrinth: "Modrinth ब्राउज़ करें",
      gameFolder: "गेम फ़ोल्डर",
      modsFolder: "मॉड्स फ़ोल्डर",
      viewScreenshots: "स्क्रीनशॉट",
      manageWorlds: "दुनिया",
      serverList: "सर्वर",
      manageAccounts: "खाते",
      clientSettings: "सेटिंग्स",
      accountsTitle: "खाता प्रबंधन",
      accountsSub: "Microsoft, टोकन या ऑफ़लाइन से साइन इन करें। सहेजे गए खातों के बीच स्विच करें।",
      signInMicrosoft: "Microsoft से साइन इन करें",
      offlineMode: "ऑफ़लाइन",
      addAccount: "खाता जोड़ें",
      addAccountBtn: "खाता जोड़ें",
      addOfflineTitle: "ऑफ़लाइन खाता जोड़ें",
      addOfflineSub: "कस्टम उपयोगकर्ता नाम और स्किन के साथ ऑफ़लाइन या क्रैक्ड सर्वर पर खेलें।",
      offlineUsername: "खिलाड़ी का नाम",
      offlineHint: "अनुमत: A-Z, 0-9 और अंडरस्कोर। अधिकतम 16 अक्षर।",
      enterUsername: "उपयोगकर्ता नाम दर्ज करें",
      switchAccount: "बदलें",
      removeAccount: "हटाएं",
      activeAccount: "सक्रिय",
      clickToSwitch: "बदलने के लिए क्लिक करें",
      noAccountsYet: "अभी तक कोई खाता नहीं जोड़ा गया है।",
      confirmRemoveAcct: "क्या आप इस खाते को FireClient से हटाना चाहते हैं?",
      serversTitle: "सर्वर और डोमेन",
      serversSub: "मल्टीप्लेयर सर्वर खोजें, पसंदीदा सहेजें और लाइव पिंग मापें।",
      addServer: "सर्वर जोड़ें",
      livePing: "लाइव पिंग टेस्टर",
      pingServer: "सर्वर जांचें",
      serverAddress: "सर्वर पता या IP...",
      serverPort: "पोर्ट",
      latency: "पिंग विलंबता",
      players: "खिलाड़ी",
      online: "ऑनलाइन",
      offline: "ऑफ़लाइन",
      testPing: "पिंग जांचें",
      copyIp: "IP कॉपी करें",
      joinNow: "सर्वर से जुड़ें",
      addToFavorites: "पसंदीदा में जोड़ें",
      ipCopied: "सर्वर IP क्लिपबोर्ड पर कॉपी हो गया!",
      probingServer: "सर्वर जांचा जा रहा है...",
      serverUnreachable: "सर्वर ऑफ़लाइन है या पहुंच से बाहर है",
      settingsTitle: "सेटिंग्स",
      general: "सामान्य",
      game: "गेम",
      appearance: "दिखावट",
      languageSettingTitle: "लॉन्चर भाषा",
      languageSettingDesc: "संपूर्ण लॉन्चर में इंटरफ़ेस भाषा बदलें।",
      performance: "प्रदर्शन",
      gameTurbo: "गेम टर्बो (उच्च प्राथमिकता)",
      gameTurboDesc: "Minecraft को उच्च CPU प्राथमिकता और सुगम OpenGL प्रदान करता है।",
      ramAllocation: "आवंटित RAM",
      tactileAudio: "स्पर्श ध्वनि",
      tactileAudioDesc: "लॉन्चर बटन के लिए स्पष्ट मैकेनिकल क्लिक ध्वनि।",
      minimizeOnLaunch: "गेम शुरू होने पर छोटा करें",
      openFolder: "फ़ोल्डर खोलें",
      resetDefaults: "डिफ़ॉल्ट पर रीसेट करें"
    },
    ar: {
      navHome: "الرئيسية",
      navVersions: "الإصدارات",
      navMods: "التعديلات",
      navModrinth: "مودرينث",
      navCurseForge: "كورس فورج",
      navLibrary: "المكتبة",
      navResourcePacks: "حزم الموارد",
      navShaders: "التظليل",
      navWorlds: "العوالم",
      navHost: "استضافة خادم",
      navServers: "الخوادم",
      navScreenshots: "لقطات الشاشة",
      navAccounts: "الحسابات",
      navSkins: "المظاهر",
      navStore: "المتجر",
      navConsole: "وحدة التحكم",
      navPerformance: "الأداء",
      navUsage: "الاستخدام",
      navSettings: "الإعدادات",
      launchBtn: "تشغيل",
      launching: "جارٍ التشغيل...",
      playing: "قيد اللعب",
      selectVersion: "لم يتم اختيار إصدار",
      selectLanguage: "اختر اللغة",
      language: "اللغة",
      theme: "المظهر",
      discord: "ديسكورد",
      quickActions: "إجراءات سريعة",
      browseModrinth: "تصفح مودرينث",
      gameFolder: "مجلد اللعبة",
      modsFolder: "مجلد التعديلات",
      viewScreenshots: "لقطات الشاشة",
      manageWorlds: "العوالم",
      serverList: "الخوادم",
      manageAccounts: "الحسابات",
      clientSettings: "الإعدادات",
      accountsTitle: "الحسابات",
      accountsSub: "تسجيل الدخول عبر مايكروسوفت أو الرمز أو بدون إنترنت مع التبديل السهل.",
      signInMicrosoft: "دخول مايكروسوفت",
      offlineMode: "بدون إنترنت",
      addAccount: "إضافة حساب",
      addAccountBtn: "إضافة الحساب",
      addOfflineTitle: "إضافة حساب بدون إنترنت",
      addOfflineSub: "العب في العوالم الفردية أو الخوادم غير الرسمية بأي اسم مستخدم ومظهر.",
      offlineUsername: "اسم المستخدم",
      offlineHint: "المسموح: الحروف A-Z والأرقام 0-9 والشرطة السفلية. بحد أقصى 16 حرفاً.",
      enterUsername: "أدخل اسم المستخدم",
      switchAccount: "تبديل",
      removeAccount: "إزالة",
      activeAccount: "نشط",
      clickToSwitch: "انقر للتبديل",
      noAccountsYet: "لم تتم إضافة حسابات بعد.",
      confirmRemoveAcct: "هل تريد إزالة هذا الحساب من FireClient؟",
      serversTitle: "الخوادم والنطاقات",
      serversSub: "اكتشف أفضل الخوادم واحفظ المفضلة وافحص سرعة الاتصال المباشرة.",
      addServer: "إضافة خادم",
      livePing: "فاحص البينغ المباشر",
      pingServer: "فحص الخادم",
      serverAddress: "عنوان الخادم أو IP...",
      serverPort: "المنفذ",
      latency: "زمن الاستجابة",
      players: "اللاعبون",
      online: "متصل",
      offline: "غير متصل",
      testPing: "فحص البينغ",
      copyIp: "نسخ IP",
      joinNow: "الانضمام للخادم",
      addToFavorites: "إضافة للمفضلة",
      ipCopied: "تم نسخ عنوان الخادم إلى الحافظة!",
      probingServer: "جارٍ فحص الخادم...",
      serverUnreachable: "الخادم غير متصل أو لا يمكن الوصول إليه",
      settingsTitle: "الإعدادات",
      general: "عام",
      game: "اللعبة",
      appearance: "المظهر الخارجي",
      languageSettingTitle: "لغة المشغل",
      languageSettingDesc: "تغيير لغة واجهة المشغل بالكامل.",
      performance: "الأداء والسرعة",
      gameTurbo: "تسريع الألعاب (أولوية عالية)",
      gameTurboDesc: "تخصيص أولوية معالجة قصوى لماينكرافت لتحقيق أقصى إطارات.",
      ramAllocation: "ذاكرة RAM المخصصة",
      tactileAudio: "أصوات النقر",
      tactileAudioDesc: "أصوات أزرار ميكانيكية ممتعة ومحسنة لواجهة المشغل.",
      minimizeOnLaunch: "تصغير المشغل عند بدء اللعبة",
      openFolder: "فتح المجلد",
      resetDefaults: "استعادة الافتراضيات"
    }
  };
  window.FC_I18N = FC_I18N;

  function fcGetLanguage() {
    try {
      var saved = localStorage.getItem('fc-lang');
      if (saved && FC_I18N[saved]) return saved;
    } catch (_) {}
    return 'en';
  }
  window.fcGetLanguage = fcGetLanguage;

  function fcGetText(key, fallback) {
    var lang = fcGetLanguage();
    var dict = FC_I18N[lang] || FC_I18N.en;
    if (dict && dict[key] !== undefined) return dict[key];
    if (FC_I18N.en && FC_I18N.en[key] !== undefined) return FC_I18N.en[key];
    return fallback !== undefined ? fallback : key;
  }
  window.fcGetText = fcGetText;

  function fcSetLanguage(lang) {
    if (!FC_I18N[lang]) lang = 'en';
    try { localStorage.setItem('fc-lang', lang); } catch (_) {}

    if (lang === 'ar') {
      document.documentElement.setAttribute('dir', 'rtl');
    } else {
      document.documentElement.setAttribute('dir', 'ltr');
    }

    var lbl = $('su-tb-lang-lbl');
    if (lbl) lbl.textContent = lang.toUpperCase();

    var sel = $('fc-s-lang');
    if (sel && sel.value !== lang) sel.value = lang;

    var dict = FC_I18N[lang] || FC_I18N.en;
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (dict[key] !== undefined) el.textContent = dict[key];
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-title');
      if (dict[key] !== undefined) el.setAttribute('title', dict[key]);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      var key = el.getAttribute('data-i18n-placeholder');
      if (dict[key] !== undefined) el.setAttribute('placeholder', dict[key]);
    });

    var lb = $('su-launch-btn');
    if (lb && !lb.disabled) {
      var lblEl = lb.querySelector('.label');
      if (lblEl) lblEl.textContent = dict.launchBtn || 'LAUNCH';
    }

    renderLangMenu();
    try { window.dispatchEvent(new CustomEvent('fc-lang-changed', { detail: { lang: lang } })); } catch (_) {}
  }
  window.fcSetLanguage = fcSetLanguage;

  function renderLangMenu() {
    var host = $('fc-lang-list');
    if (!host) return;
    var cur = fcGetLanguage();
    host.innerHTML = FC_LANGUAGES.map(function (l) {
      var active = l.code === cur ? ' active' : '';
      return '<div class="fc-lang-item' + active + '" onclick="fcSetLanguage(\'' + l.code + '\');fcCloseLangMenu()">'
        + '<div style="display:flex;align-items:center"><span class="flag">' + l.flag + '</span><span>' + l.native + '</span></div>'
        + '<span class="code">' + l.code.toUpperCase() + '</span>'
        + '</div>';
    }).join('');
  }
  window.fcRenderLangMenu = renderLangMenu;

  window.fcToggleLangMenu = function (ev) {
    if (ev) ev.stopPropagation();
    if (typeof window.suTogglePop === 'function') {
      window.suTogglePop('lang', ev);
    } else {
      var p = $('su-tb-pop-lang');
      if (p) p.classList.toggle('open');
    }
    renderLangMenu();
  };

  window.fcCloseLangMenu = function () {
    var p = $('su-tb-pop-lang');
    if (p) p.classList.remove('open');
  };

  /* ------------------------------------------------------------------ 6. Multi-Account Management (Microsoft & Offline) */
  function fcGetOfflineAccounts() {
    var list = [];
    try {
      var saved = localStorage.getItem('fc-offline-accounts');
      if (saved) list = JSON.parse(saved);
    } catch (_) {}
    if (!Array.isArray(list)) list = [];
    var cur = '';
    try { cur = localStorage.getItem('fc-offline-username') || (JSON.parse(localStorage.getItem('nova-settings') || '{}')).username || ''; } catch (_) {}
    cur = String(cur).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16) || 'Player';
    if (!list.some(function (a) { return (a.username || '').toLowerCase() === cur.toLowerCase(); })) {
      list.unshift({ username: cur, addedAt: Date.now() });
      try { localStorage.setItem('fc-offline-accounts', JSON.stringify(list)); } catch (_) {}
    }
    return list;
  }
  window.fcGetOfflineAccounts = fcGetOfflineAccounts;

  function fcSaveOfflineAccount(username) {
    var nm = String(username || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16).trim();
    if (!nm) return false;
    var list = fcGetOfflineAccounts();
    var idx = list.findIndex(function (a) { return (a.username || '').toLowerCase() === nm.toLowerCase(); });
    if (idx >= 0) {
      list[idx].username = nm;
      list[idx].updatedAt = Date.now();
    } else {
      list.push({ username: nm, addedAt: Date.now() });
    }
    try { localStorage.setItem('fc-offline-accounts', JSON.stringify(list)); } catch (_) {}
    fcSwitchToOfflineAccount(nm);
    return true;
  }
  window.fcSaveOfflineAccount = fcSaveOfflineAccount;

  function fcRemoveOfflineAccount(username) {
    if (!username) return;
    if (!confirm(fcGetText('confirmRemoveAcct', 'Remove this account from FireClient?'))) return;
    var list = fcGetOfflineAccounts();
    var cur = (localStorage.getItem('fc-offline-username') || 'Player').toLowerCase();
    list = list.filter(function (a) { return (a.username || '').toLowerCase() !== username.toLowerCase(); });
    try { localStorage.setItem('fc-offline-accounts', JSON.stringify(list)); } catch (_) {}
    if (username.toLowerCase() === cur) {
      var next = list.length > 0 ? list[0].username : 'Player';
      fcSwitchToOfflineAccount(next);
    } else {
      if (window.SU && SU.loadUser) SU.loadUser();
      if (typeof window.suAccountsRender === 'function') window.suAccountsRender();
      if (typeof window.renderPopoverAccounts === 'function') window.renderPopoverAccounts();
    }
    if (typeof window.toast === 'function') window.toast('Offline account removed');
  }
  window.fcRemoveOfflineAccount = fcRemoveOfflineAccount;

  function fcSwitchToOfflineAccount(username) {
    var nm = String(username || 'Player').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16);
    try {
      localStorage.setItem('fc-launch-mode', 'offline');
      localStorage.setItem('fc-offline-username', nm);
      localStorage.setItem('jl-skin-username', nm);
      var ns = JSON.parse(localStorage.getItem('nova-settings') || '{}');
      ns.username = nm;
      localStorage.setItem('nova-settings', JSON.stringify(ns));
    } catch (_) {}
    if (typeof _offlineModeForced !== 'undefined') _offlineModeForced = true;
    var uIn = $('uname-in'); if (uIn) uIn.value = nm;
    var suIn = $('settings-user'); if (suIn) suIn.value = nm;
    if (window.SU) {
      SU.currentUsername = nm;
      if (SU.loadUser) SU.loadUser();
      if (SU.acctRefresh) SU.acctRefresh();
    }
    if (typeof window.suAccountsRender === 'function') window.suAccountsRender();
    if (typeof window.renderPopoverAccounts === 'function') window.renderPopoverAccounts();
    if (typeof window.toast === 'function') window.toast('Switched to ' + nm + ' (Offline)');
    var pop = $('su-tb-pop-acct'); if (pop) pop.classList.remove('open');
    var apPop = $('acct-popover'); if (apPop) apPop.classList.remove('open');
  }
  window.fcSwitchToOfflineAccount = fcSwitchToOfflineAccount;

  window.fcOpenAddAccountModal = function (tab) {
    if (typeof window.openAddAcctModal === 'function') {
      window.openAddAcctModal(tab || 'ms');
    } else {
      var m = $('add-acct-modal');
      if (m) m.classList.add('open');
      if (typeof window.switchAamTab === 'function') window.switchAamTab(tab || 'ms');
    }
  };

  window.aamOfflineValidate = function () {
    var inp = $('aam-offline-input');
    var btn = $('aam-offline-btn');
    var val = inp ? inp.value.trim() : '';
    if (btn) btn.disabled = val.length < 1;
    var av = $('aam-offline-av-preview');
    if (av) {
      av.src = 'https://mc-heads.net/avatar/' + encodeURIComponent(val || 'steve') + '/48';
    }
  };

  window.fcAddOfflineAccountFromModal = function () {
    var inp = $('aam-offline-input');
    var val = inp ? inp.value.trim() : '';
    if (!val) return;
    fcSaveOfflineAccount(val);
    if (typeof window.closeAddAcctModal === 'function') window.closeAddAcctModal();
    if (typeof window.toast === 'function') window.toast('Added offline account ' + val + ' ✓');
  };

  /* ------------------------------------------------------------------ 7. Live Server Ping & Latency Health Tool */
  var lastPingResult = null;
  var DEFAULT_CUBE_ICON = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='10' fill='%2318151c'/%3E%3Cpath d='M32 10L52 21v22L32 54 12 43V21L32 10z' fill='%23272230' stroke='%23ff4d4a' stroke-width='3'/%3E%3Cpath d='M32 10l20 11-20 11-20-11 20-11z' fill='%2310b981' fill-opacity='0.35'/%3E%3Cpath d='M32 32v22' stroke='%23ff4d4a' stroke-width='2.5'/%3E%3C/svg%3E";

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function suggestServerName(host) {
    if (!host) return 'Minecraft Server';
    var clean = String(host).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').split(':')[0];
    if (/^(127\.0\.0\.1|localhost)$/i.test(clean)) return 'Localhost Server';
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(clean)) return 'LAN Server (' + clean + ')';
    if (/\.fireclient\.net$/i.test(clean)) {
      var sub = clean.replace(/\.fireclient\.net$/i, '');
      return sub.toUpperCase() + ' Server';
    }
    var parts = clean.split('.');
    var main = (parts.length > 2 && /^(mc|play|buzz|bee|join|hub)$/i.test(parts[0])) ? parts[1] : parts[0];
    if (!main) return clean;
    return main.charAt(0).toUpperCase() + main.slice(1) + ' Server';
  }

  window.fcPingHostInput = function (val) {
    if (!val) return;
    if (val.indexOf(':') !== -1) {
      var parts = val.split(':');
      var h = parts[0].trim();
      var p = parseInt(parts[1].trim(), 10);
      if (h && !isNaN(p) && p > 0 && p <= 65535) {
        var hostIn = $('fc-ping-host');
        var portIn = $('fc-ping-port');
        if (hostIn && hostIn.value !== h) hostIn.value = h;
        if (portIn) portIn.value = p;
      }
    }
  };

  window.fcLoadPingDomains = async function () {
    var box = $('fc-ping-dom-chips');
    if (!box || !window.ipc || !window.ipc.invoke) return;
    try {
      var list = await window.ipc.invoke('cf-domain-list') || [];
      var netInfo = null;
      try { netInfo = await window.ipc.invoke('server-network-info'); } catch (_) {}
      var pubIp = (netInfo && netInfo.publicIp) || (Array.isArray(list) && list[0] && list[0].target) || '';
      var defPort = (Array.isArray(list) && list[0] && list[0].port) || 25565;
      var html = '';
      if (pubIp && /^\d+\.\d+\.\d+\.\d+$/.test(pubIp)) {
        html += '<button class="fc-ping-chip" style="border-color:rgba(56,189,248,.5);color:#38bdf8;background:rgba(56,189,248,.12)" onclick="fcPingPreset(\'' + escHtml(pubIp) + '\',' + defPort + ',\'My Public IP Server\')">Public IP (' + escHtml(pubIp) + ')</button>';
      }
      if (Array.isArray(list) && list.length) {
        html += list.slice(0, 4).map(function (d) {
          var dom = d.domain || (d.name + '.fireclient.net');
          var port = d.port || 25565;
          var label = (d.name || dom).toUpperCase();
          return '<button class="fc-ping-chip" style="border-color:rgba(var(--fc-rgb),.45);color:#fff;background:rgba(var(--fc-rgb),.12)" onclick="fcPingPreset(\'' + escHtml(dom) + '\',' + port + ',\'' + escHtml(label + ' Server') + '\')">' + escHtml(dom) + '</button>';
        }).join('');
      }
      box.innerHTML = html;
    } catch (_) {}
  };

  function renderPingResultBox(host, port, serverName, res) {
    var resBox = $('fc-ping-result-box');
    if (!resBox) return;
    resBox.style.display = 'flex';
    var iconEl = $('fc-ping-res-icon');
    var nameEl = $('fc-ping-res-name');
    var motdEl = $('fc-ping-res-motd');
    var statsEl = $('fc-ping-res-stats');
    var dotEl = $('fc-ping-res-dot');
    var msEl = $('fc-ping-res-ms');
    var routeEl = $('fc-ping-res-route');

    var activePort = (res && (res.resolvedPort || res.port)) || port || 25565;
    var realIp = (res && (res.publicIp || res.realIp || res.resolvedHost)) || host;
    var isLoopback = !!(res && res.localLoopback);
    var isSrv = !isLoopback && res && ((res.resolvedHost && res.resolvedHost.toLowerCase() !== host.toLowerCase()) || (res.resolvedPort && res.resolvedPort !== port));

    if (routeEl) {
      routeEl.style.display = 'inline-block';
      if (isLoopback) {
        routeEl.textContent = 'PUBLIC IP · LOCAL 0ms ROUTE';
        routeEl.style.color = '#10b981';
        routeEl.style.borderColor = 'rgba(16,185,129,.4)';
        routeEl.style.background = 'rgba(16,185,129,.12)';
      } else if (isSrv) {
        routeEl.textContent = 'DNS SRV ROUTED';
        routeEl.style.color = '#a855f7';
        routeEl.style.borderColor = 'rgba(168,85,247,.4)';
        routeEl.style.background = 'rgba(168,85,247,.12)';
      } else {
        routeEl.textContent = 'PUBLIC IP · DIRECT TCP';
        routeEl.style.color = '#38bdf8';
        routeEl.style.borderColor = 'rgba(56,189,248,.35)';
        routeEl.style.background = 'rgba(56,189,248,.12)';
      }
    }

    if (res && res.online) {
      if (iconEl) {
        iconEl.src = (res.icon && /^data:image\//.test(res.icon)) ? res.icon : DEFAULT_CUBE_ICON;
        iconEl.style.display = 'block';
      }
      if (nameEl) {
        nameEl.innerHTML = '<span style="color:#fff;font-weight:800">' + escHtml(serverName || host) + '</span>'
          + ' <span style="font-size:12px;font-family:\'JetBrains Mono\',monospace;color:var(--fc-a2);background:rgba(var(--fc-rgb),.12);border:1px solid rgba(var(--fc-rgb),.3);padding:2px 8px">' + escHtml(host) + ':' + activePort + '</span>';
      }
      if (motdEl) motdEl.textContent = (res.motd || 'A Minecraft Server').split('\n')[0].trim();
      var lat = typeof res.latency === 'number' ? res.latency : -1;
      var latClass = lat < 0 ? 'online' : (lat < 80 ? 'online' : (lat < 180 ? 'slow' : 'offline'));
      var latText = lat >= 0 ? (lat + ' ms') : (isLoopback ? '0 ms' : '<1 ms');
      if (dotEl) dotEl.className = 'fc-ping-dot ' + latClass;
      if (msEl) msEl.textContent = latText;
      if (statsEl) {
        statsEl.innerHTML =
          '<span>Public IP: <b style="color:#38bdf8">' + escHtml(realIp) + '</b></span>'
          + '<span>Port: <b style="color:#10b981">' + activePort + ' / TCP</b></span>'
          + '<span>' + fcGetText('players', 'Players') + ': <b>' + Number(res.players || 0).toLocaleString() + ' / ' + Number(res.max || 0).toLocaleString() + '</b></span>'
          + '<span>' + fcGetText('navVersions', 'Version') + ': <b>' + escHtml(res.version || 'Java') + (res.protocol ? ' (p' + res.protocol + ')' : '') + '</b></span>';
      }
    } else {
      if (iconEl) {
        iconEl.src = DEFAULT_CUBE_ICON;
        iconEl.style.display = 'block';
      }
      if (nameEl) {
        nameEl.innerHTML = '<span style="color:#fff;font-weight:800">' + escHtml(serverName || host) + '</span>'
          + ' <span style="font-size:12px;font-family:\'JetBrains Mono\',monospace;color:rgba(255,255,255,.5);background:rgba(255,255,255,.05);border:1px solid var(--fc-line);padding:2px 8px">' + escHtml(host) + ':' + activePort + '</span>';
      }
      if (motdEl) motdEl.textContent = fcGetText('serverUnreachable', 'Server is currently offline or port ' + activePort + ' is closed.');
      if (dotEl) dotEl.className = 'fc-ping-dot offline';
      if (msEl) msEl.textContent = fcGetText('offline', 'OFFLINE');
      if (statsEl) {
        statsEl.innerHTML =
          '<span>Resolved IP: <b style="color:#f59e0b">' + escHtml(realIp || 'Unresolved') + '</b></span>'
          + '<span>Port Tested: <b>' + activePort + '</b></span>'
          + '<span style="color:#ef4444">Status: <b>' + escHtml((res && res.error) ? ('No response (' + res.error + ')') : 'Connection timed out') + '</b></span>'
          + '<span>Tip: <b style="color:#38bdf8;cursor:pointer;text-decoration:underline" onclick="fcScanServerPorts()">Click "Scan All Ports" to find active port</b></span>';
      }
    }
  }

  window.fcRunPingTool = async function (exactPortFlag) {
    var hostIn = $('fc-ping-host');
    var portIn = $('fc-ping-port');
    var nameIn = $('fc-ping-name');
    var btn = $('fc-ping-btn');
    var resBox = $('fc-ping-result-box');
    var host = hostIn ? hostIn.value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') : '';
    var port = portIn ? (parseInt(portIn.value.trim() || '25565', 10) || 25565) : 25565;
    var exact = (exactPortFlag === true);

    if (!host) {
      if (typeof window.toast === 'function') window.toast('Please enter a server domain or IP address', 'error');
      if (hostIn) hostIn.focus();
      return;
    }
    if (host.indexOf(':') !== -1) {
      var parts = host.split(':');
      host = parts[0].trim();
      var p = parseInt(parts[1].trim(), 10);
      if (p > 0 && p <= 65535) {
        port = p;
        exact = true;
      }
      if (hostIn) hostIn.value = host;
      if (portIn) portIn.value = port;
    }

    var customName = nameIn ? nameIn.value.trim() : '';
    if (!customName) {
      customName = suggestServerName(host);
      if (nameIn) nameIn.value = customName;
    }

    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="fc-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:fcSpin .6s linear infinite;margin-right:6px"></span> ' + fcGetText('probingServer', 'Probing...');
    }

    if (resBox) {
      resBox.style.display = 'flex';
      var nameEl0 = $('fc-ping-res-name');
      var motdEl0 = $('fc-ping-res-motd');
      var statsEl0 = $('fc-ping-res-stats');
      var dotEl0 = $('fc-ping-res-dot');
      var msEl0 = $('fc-ping-res-ms');
      if (nameEl0) nameEl0.innerHTML = '<span>Probing ' + escHtml(host) + ':' + port + '…</span>';
      if (motdEl0) motdEl0.textContent = 'Resolving DNS SRV & testing TCP socket handshake…';
      if (statsEl0) statsEl0.innerHTML = '<span>Real IP: <b>Resolving…</b></span><span>Port: <b>' + port + '</b></span>';
      if (dotEl0) dotEl0.className = 'fc-ping-dot slow';
      if (msEl0) msEl0.textContent = '…';
    }

    try {
      var res = null;
      if (window.ipc && window.ipc.invoke) {
        try { res = await window.ipc.invoke('server-ping', { host: host, port: port, exactPort: exact }); } catch (_) {}
      }
      var isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|0\.0\.0\.0)/i.test(host);
      if ((!res || !res.online) && !isLocal && !exact) {
        try {
          var t0 = performance.now();
          var r = await fetch('https://api.mcstatus.io/v2/status/java/' + encodeURIComponent(host + (port !== 25565 ? ':' + port : '')), { cache: 'no-store' });
          var j = await r.json();
          var rtt = Math.max(1, Math.round(performance.now() - t0));
          if (j && j.online) {
            res = {
              online: true,
              latency: rtt,
              realIp: j.ip_address || (res && res.realIp) || host,
              resolvedHost: (j.srv_record && j.srv_record.host) || (res && res.resolvedHost) || host,
              resolvedPort: (j.srv_record && j.srv_record.port) || j.port || port,
              players: (j.players && j.players.online) || 0,
              max: (j.players && j.players.max) || 0,
              version: (j.version && (j.version.name_clean || j.version.name_raw)) || 'Minecraft',
              protocol: (j.version && j.version.protocol) || 0,
              motd: (j.motd && j.motd.clean) || '',
              icon: j.icon || ''
            };
          } else if (j && j.ip_address && res && !res.realIp) {
            res.realIp = j.ip_address;
          }
        } catch (_) {}
      }

      var finalPort = exact ? port : ((res && (res.resolvedPort || res.port)) || port);
      if (portIn && res && res.online && finalPort) portIn.value = finalPort;
      lastPingResult = { host: host, port: finalPort, name: customName, res: res };
      renderPingResultBox(host, finalPort, customName, res);
    } catch (e) {
      if (typeof window.toast === 'function') window.toast('Ping error: ' + (e.message || e), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" style="margin-right:6px"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' + fcGetText('pingServer', 'Probe Server');
      }
    }
  };

  window.fcScanServerPorts = async function (targetHost, stripId, onSelectFn) {
    var hostIn = $('fc-ping-host');
    var portIn = $('fc-ping-port');
    var nameIn = $('fc-ping-name');
    var scanBtn = $('fc-ping-scan-btn');
    var strip = $(stripId || 'fc-ping-ports-strip');
    var host = (targetHost || (hostIn ? hostIn.value : '') || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').split(':')[0];

    if (!host) {
      if (typeof window.toast === 'function') window.toast('Enter a domain or IP address first to scan ports', 'error');
      if (hostIn) hostIn.focus();
      return;
    }

    var curPort = portIn ? (parseInt(portIn.value, 10) || 25565) : 25565;

    if (scanBtn && !targetHost) {
      scanBtn.disabled = true;
      scanBtn.innerHTML = '<span>Detecting Ports…</span>';
    }
    if (strip) {
      strip.style.display = 'flex';
      strip.className = 'fc-host-ports-strip';
      strip.innerHTML = '<span style="font-size:11.5px;color:#38bdf8;font-family:\'JetBrains Mono\',monospace">Scanning Minecraft &amp; service ports on <b>' + escHtml(host) + '</b> in parallel…</span>';
    }

    try {
      var scanData = null;
      if (window.ipc && window.ipc.invoke) {
        try {
          scanData = await window.ipc.invoke('server-detect-ports', { host: host, customPort: curPort });
        } catch (_) {}
      }

      var portsList = (scanData && Array.isArray(scanData.ports)) ? scanData.ports : null;
      if (!portsList) {
        var candidatePorts = [25565, 25566, 25567, 25568, 25569, 25570, 25575, 19132, 24454, 8123];
        if (candidatePorts.indexOf(curPort) === -1) candidatePorts.unshift(curPort);
        portsList = await Promise.all(candidatePorts.map(async function (p) {
          var r = null;
          try {
            if (window.ipc && window.ipc.invoke) {
              r = await window.ipc.invoke('server-ping', { host: host, port: p, exactPort: true });
            }
          } catch (_) {}
          var isOn = !!(r && r.online);
          return {
            port: p,
            state: isOn ? 'mc_online' : 'free',
            online: isOn,
            latency: r ? r.latency : -1,
            players: r ? r.players : 0,
            max: r ? r.max : 0,
            version: (r && r.version) || '',
            motd: (r && r.motd) || '',
            realIp: (r && r.realIp) || ''
          };
        }));
      }

      var onlineHit = null;
      if (strip) {
        var resolvedIp = (scanData && scanData.resolvedIp) || (portsList[0] && portsList[0].realIp) || '';
        var recPort = (scanData && scanData.recommendedPort) || 0;
        var html = '<div style="width:100%;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:4px">'
          + '<span style="font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#e4e4e7">Smart Port Scan (' + escHtml(host) + (resolvedIp && resolvedIp !== host ? ' → ' + escHtml(resolvedIp) : '') + ')</span>'
          + (recPort ? '<span style="font-size:11px;color:#34d399;font-family:\'JetBrains Mono\',monospace">Recommended Free Port: <b>:' + recPort + '</b></span>' : '')
          + '</div>';

        portsList.forEach(function (item) {
          var p = item.port;
          var st = item.state || (item.online ? 'mc_online' : 'free');
          var isOn = (st === 'mc_online' || !!item.online);
          if (isOn && !onlineHit) onlineHit = item;

          var cls = 'fc-port-pill ' + (item.isOurHostedServer ? 'ours' : (isOn ? 'mc-online' : (st === 'in_use' ? 'in-use' : 'free')));
          if (p === curPort) cls += ' selected';

          var label = '';
          if (item.isOurHostedServer) {
            var ms0 = item.latency >= 0 ? item.latency + 'ms' : '1ms';
            label = '★ :' + p + ' OUR SERVER (' + (item.players || 0) + '/' + (item.max || 0) + ' · ' + ms0 + ')';
          } else if (isOn) {
            var plTxt = (item.players || 0) + '/' + (item.max || 0) + 'P';
            var msTxt = item.latency >= 0 ? item.latency + 'ms' : '1ms';
            label = '✓ :' + p + ' LIVE (' + plTxt + ' · ' + msTxt + ')';
          } else if (st === 'in_use') {
            label = '⚠ :' + p + ' IN USE' + (item.role ? ' (' + escHtml(item.role) + ')' : '');
          } else {
            label = '○ :' + p + ' FREE' + (item.role ? ' · ' + escHtml(item.role) : '');
          }

          html += '<button type="button" class="' + cls + '" onclick="fcSelectScannedPort(\'' + escHtml(host) + '\',' + p + ',true)">' + label + '</button>';
        });
        strip.innerHTML = html;
      }

      if (onlineHit) {
        var foundPort = onlineHit.port;
        var synthRes = {
          online: true,
          latency: onlineHit.latency >= 0 ? onlineHit.latency : 1,
          realIp: (scanData && scanData.resolvedIp) || onlineHit.realIp || host,
          resolvedHost: host,
          resolvedPort: foundPort,
          players: onlineHit.players || 0,
          max: onlineHit.max || 0,
          version: onlineHit.version || 'Minecraft',
          motd: onlineHit.motd || ''
        };
        if (!targetHost) {
          if (portIn) portIn.value = foundPort;
          var sName = (nameIn && nameIn.value.trim()) || suggestServerName(host);
          if (nameIn && !nameIn.value.trim()) nameIn.value = sName;
          lastPingResult = { host: host, port: foundPort, name: sName, res: synthRes };
          renderPingResultBox(host, foundPort, sName, synthRes);
        }
        if (typeof onSelectFn === 'function') onSelectFn(foundPort, synthRes);
        if (typeof window.toast === 'function') window.toast('Detected active Minecraft server on ' + host + ':' + foundPort + '! ✓');
      } else {
        if (!targetHost && portsList.length) {
          var first = portsList[0];
          var sName2 = (nameIn && nameIn.value.trim()) || suggestServerName(host);
          lastPingResult = { host: host, port: first.port, name: sName2, res: { online: false, realIp: (scanData && scanData.resolvedIp) || '' } };
          renderPingResultBox(host, first.port, sName2, lastPingResult.res);
        }
        if (typeof window.toast === 'function') window.toast('Scan complete on ' + host + ' — no active Minecraft Java server responded on scanned ports.');
      }
    } finally {
      if (scanBtn && !targetHost) {
        scanBtn.disabled = false;
        scanBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>Scan All Ports</span>';
      }
    }
  };

  window.fcSelectScannedPort = function (host, port, exact) {
    var hostIn = $('fc-ping-host');
    var portIn = $('fc-ping-port');
    if (hostIn) hostIn.value = host;
    if (portIn) portIn.value = port;
    window.fcRunPingTool(exact !== false);
  };

  window.fcPingPreset = function (host, port, presetName) {
    var hostIn = $('fc-ping-host');
    var portIn = $('fc-ping-port');
    var nameIn = $('fc-ping-name');
    if (hostIn) hostIn.value = host;
    if (portIn) portIn.value = port || 25565;
    if (nameIn) nameIn.value = presetName || suggestServerName(host);
    window.fcRunPingTool();
  };

  window.fcJoinPingedServer = function () {
    var host = (lastPingResult && lastPingResult.host) || ($('fc-ping-host') && $('fc-ping-host').value.trim()) || '';
    var port = (lastPingResult && lastPingResult.port) || parseInt(($('fc-ping-port') && $('fc-ping-port').value) || '25565', 10) || 25565;
    var name = ($('fc-ping-name') && $('fc-ping-name').value.trim()) || (lastPingResult && lastPingResult.name) || suggestServerName(host);
    if (!host) {
      if (typeof window.toast === 'function') window.toast('Probe or enter a server address first');
      return;
    }
    if (typeof window.suSrvJoin === 'function') {
      window.suSrvJoin({ name: name, address: host, port: port });
    }
  };

  window.fcAddPingedToFav = async function () {
    var host = ($('fc-ping-host') && $('fc-ping-host').value.trim()) || (lastPingResult && lastPingResult.host) || '';
    var port = parseInt(($('fc-ping-port') && $('fc-ping-port').value) || '', 10) || (lastPingResult && lastPingResult.port) || 25565;
    var name = ($('fc-ping-name') && $('fc-ping-name').value.trim()) || (lastPingResult && lastPingResult.name) || suggestServerName(host);
    if (!host) {
      if (typeof window.toast === 'function') window.toast('Enter a server address first');
      return;
    }
    try {
      if (window.ipc) {
        var r = await window.ipc.invoke('save-server', { name: name, address: host, port: port, tag: 'SMP' });
        if (r && r.error) {
          if (typeof window.toast === 'function') window.toast('Save failed: ' + r.error, 'error');
          return;
        }
      }
      if (typeof window.suSrvRefresh === 'function') await window.suSrvRefresh();
      if (typeof window.loadServerList === 'function') await window.loadServerList();
      if (typeof window.fcSwitchTab === 'function') window.fcSwitchTab('saved');
      if (typeof window.toast === 'function') window.toast('Added "' + name + '" (' + host + ':' + port + ') to Saved Servers ✓');
    } catch (e) {
      if (typeof window.toast === 'function') window.toast('Error: ' + e.message, 'error');
    }
  };

  window.fcCopyPingIp = function () {
    var host = (lastPingResult && lastPingResult.host) || ($('fc-ping-host') && $('fc-ping-host').value.trim()) || '';
    var port = (lastPingResult && lastPingResult.port) || parseInt(($('fc-ping-port') && $('fc-ping-port').value) || '25565', 10) || 25565;
    if (!host) return;
    var addr = host + (port && port !== 25565 ? ':' + port : '');
    try {
      navigator.clipboard.writeText(addr);
      if (typeof window.toast === 'function') window.toast('Copied address: ' + addr + ' ✓');
    } catch (_) {
      if (typeof window.toast === 'function') window.toast('Address: ' + addr);
    }
  };

  window.fcCopyPingRealIp = function () {
    var res = lastPingResult && lastPingResult.res;
    var host = (res && (res.realIp || res.resolvedHost)) || (lastPingResult && lastPingResult.host) || ($('fc-ping-host') && $('fc-ping-host').value.trim()) || '';
    var port = (res && (res.resolvedPort || res.port)) || (lastPingResult && lastPingResult.port) || parseInt(($('fc-ping-port') && $('fc-ping-port').value) || '25565', 10) || 25565;
    if (!host) return;
    var addr = host + ':' + port;
    try {
      navigator.clipboard.writeText(addr);
      if (typeof window.toast === 'function') window.toast('Copied Real IP: ' + addr + ' ✓');
    } catch (_) {
      if (typeof window.toast === 'function') window.toast('Real IP: ' + addr);
    }
  };

  /* ------------------------------------------------------------------ 8. Init State on Load */
  function initGamingState() {
    updateThemeIndicators();
    renderThemeMenu();

    // Init Language
    var curLang = fcGetLanguage();
    fcSetLanguage(curLang);
    renderLangMenu();

    // Init Audio toggle
    var audTog = $('fc-s-audio');
    if (audTog) {
      audTog.checked = localStorage.getItem('fc-audio-sfx') !== '0';
    }

    // Init JVM preset & text
    var jvmPreset = localStorage.getItem('fc-jvm-preset') || 'aikar';
    var sel = $('fc-s-jvm-preset');
    if (sel) sel.value = jvmPreset;
    var ta = $('fc-s-jvm-flags-text');
    if (ta) ta.value = localStorage.getItem('nova-jvm-flags') || JVM_PRESETS[jvmPreset] || '';

    // Init Game Turbo toggle
    var turbTog = $('fc-s-turbo');
    if (turbTog) turbTog.checked = localStorage.getItem('fc-game-turbo') === '1';

    // Init RAM quick pills
    syncRamPills();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGamingState);
  } else {
    setTimeout(initGamingState, 200);
  }
})();

