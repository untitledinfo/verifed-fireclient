'use strict';

/**
 * FireClient Cross-Platform Desktop Host (macOS, Linux & Windows)
 * Shares the exact ../web frontend & ../web/updater.html with the native Win32 host.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  safeStorage,
  Notification
} = require('electron');

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const CURRENT_VERSION = '2.2.7';
const REPO_URL = 'https://github.com/untitledinfo/verifed-fireclient';
const RELEASE_API = 'https://api.github.com/repos/untitledinfo/verifed-fireclient/releases/latest';
const RELEASES_LIST_API = 'https://api.github.com/repos/untitledinfo/verifed-fireclient/releases';
const DL_BASE = REPO_URL + '/releases/latest/download/';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const QUILT_META = 'https://meta.quiltmc.org/v3';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const PAPER_API = 'https://api.papermc.io/v2/projects/paper';

const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const IS_WIN = process.platform === 'win32';
const HOST_OS = IS_MAC ? 'macos' : (IS_LINUX ? 'linux' : 'windows');
const HOST_ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';

/* --------------------------------------------------------------------------
   Directory & Resource Resolution
   -------------------------------------------------------------------------- */
function resolveResourcePath(rel) {
  const packaged = path.join(process.resourcesPath || '', rel);
  if (fs.existsSync(packaged)) return packaged;
  return path.resolve(__dirname, '..', rel);
}

const WEB_DIR = resolveResourcePath('web');
const ASSETS_DIR = resolveResourcePath('assets');
const BUNDLED_MODS_DIR = resolveResourcePath('bundled-mods');

function getGameDir() {
  const home = os.homedir();
  const dotDir = path.join(home, '.fireclient');
  if (IS_MAC) {
    const appSup = path.join(home, 'Library', 'Application Support', 'fireclient');
    if (fs.existsSync(appSup) && !fs.existsSync(dotDir)) return appSup;
  }
  return dotDir;
}

const GAME_DIR = getGameDir();

function ensureDirs() {
  const subdirs = [
    '',
    'versions',
    'libraries',
    'assets/indexes',
    'assets/objects',
    'java',
    'mods',
    'shaderpacks',
    'resourcepacks',
    'saves',
    'screenshots',
    'schematics',
    'instances',
    'servers',
    'logs'
  ];
  for (const s of subdirs) {
    fs.mkdirSync(path.join(GAME_DIR, s), { recursive: true });
  }
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/* --------------------------------------------------------------------------
   Encrypted Credential Vault (macOS Keychain / Linux libsecret / Windows DPAPI)
   -------------------------------------------------------------------------- */
const VAULT_FILE = path.join(GAME_DIR, 'accounts.vault.json');
const SETTINGS_FILE = path.join(GAME_DIR, 'settings.json');
const SERVERS_FILE = path.join(GAME_DIR, 'servers-list.json');
const UPDATER_STATE_FILE = path.join(GAME_DIR, 'updater-state.json');

function loadVault() {
  try {
    if (!fs.existsSync(VAULT_FILE)) return { accounts: [], activeUuid: '' };
    const raw = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
    if (raw && raw.encrypted && safeStorage.isEncryptionAvailable()) {
      const dec = safeStorage.decryptString(Buffer.from(raw.payload, 'base64'));
      return JSON.parse(dec);
    }
    if (raw && Array.isArray(raw.accounts)) return raw;
  } catch (_) {}
  return { accounts: [], activeUuid: '' };
}

function saveVault(vault) {
  try {
    fs.mkdirSync(GAME_DIR, { recursive: true });
    const json = JSON.stringify(vault);
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(json).toString('base64');
      fs.writeFileSync(VAULT_FILE, JSON.stringify({ encrypted: true, payload: enc }, null, 2), { mode: 0o600 });
    } else {
      fs.writeFileSync(VAULT_FILE, json, { mode: 0o600 });
    }
  } catch (_) {}
}

function offlineUuidFromName(username) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/* --------------------------------------------------------------------------
   HTTPS / HTTP Helpers & File Downloader with Progress + SHA Verification
   -------------------------------------------------------------------------- */
function fetchBuffer(urlStr, headers = {}, redirects = 6) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      urlStr,
      {
        headers: Object.assign(
          { 'User-Agent': `FireClient/${CURRENT_VERSION} (${HOST_OS}; ${HOST_ARCH})` },
          headers
        ),
        timeout: 25000
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          return resolve(fetchBuffer(next, headers, redirects - 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks), headers: res.headers }));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
  });
}

async function fetchJson(urlStr, headers = {}) {
  const res = await fetchBuffer(urlStr, Object.assign({ Accept: 'application/json' }, headers));
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} for ${urlStr}`);
  }
  return JSON.parse(res.body.toString('utf8'));
}

function downloadFile(urlStr, destPath, onProgress, redirects = 6) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) return reject(new Error('Too many redirects'));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(
      urlStr,
      {
        headers: { 'User-Agent': `FireClient/${CURRENT_VERSION} (${HOST_OS}; ${HOST_ARCH})` },
        timeout: 60000
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          return resolve(downloadFile(next, destPath, onProgress, redirects - 1));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let got = 0;
        let lastT = Date.now();
        let lastBytes = 0;
        let speed = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          got += chunk.length;
          if (typeof onProgress === 'function') {
            const now = Date.now();
            if (now - lastT >= 350) {
              speed = ((got - lastBytes) / ((now - lastT) / 1000));
              lastT = now;
              lastBytes = got;
            }
            onProgress(got, total, speed);
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(destPath)));
        out.on('error', (err) => {
          try { fs.unlinkSync(destPath); } catch (_) {}
          reject(err);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Download timeout')));
    req.on('error', reject);
  });
}

function hashFileHex(filePath, algo = 'sha256') {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    s.on('error', reject);
  });
}

/* --------------------------------------------------------------------------
   Cross-Platform Release Feed & Standalone Updater Window (macOS, Linux, Win)
   -------------------------------------------------------------------------- */
function extractHex64(raw) {
  const m = String(raw || '').match(/\b([a-fA-F0-9]{64})\b/);
  return m ? m[1].toLowerCase() : '';
}

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^[vV]/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^[vV]/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] || 0;
    const bv = pb[i] || 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

async function fetchLatestReleaseInfo() {
  let rel = null;
  try {
    rel = await fetchJson(RELEASE_API, {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    });
  } catch (_) {
    const list = await fetchJson(RELEASES_LIST_API, { Accept: 'application/vnd.github+json' }).catch(() => []);
    if (Array.isArray(list) && list.length) rel = list[0];
  }
  if (!rel || typeof rel !== 'object') {
    return { ok: false, error: 'Could not reach GitHub Releases feed.' };
  }

  const tag = String(rel.tag_name || 'v2.2.7');
  const latest = tag.replace(/^[vV]/, '');
  const name = String(rel.name || `FireClient ${tag}`);
  const notes = String(rel.body || '').slice(0, 2400);
  const publishedAt = String(rel.published_at || '');
  const htmlUrl = String(rel.html_url || (REPO_URL + '/releases'));

  const platforms = {
    windows: {
      setupUrl: DL_BASE + 'FireClient-Setup.exe',
      portableUrl: DL_BASE + 'FireClient-portable.zip',
      size: 0,
      sha256: ''
    },
    macos: {
      dmgUrl: DL_BASE + 'FireClient-macOS-universal.dmg',
      arm64DmgUrl: DL_BASE + 'FireClient-macOS-arm64.dmg',
      x64DmgUrl: DL_BASE + 'FireClient-macOS-x64.dmg',
      zipUrl: DL_BASE + 'FireClient-macOS-universal.zip',
      installCmd: 'curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-macos.sh | bash',
      size: 0,
      sha256: '',
      available: false
    },
    linux: {
      appImageUrl: DL_BASE + 'FireClient-Linux-x86_64.AppImage',
      arm64AppImageUrl: DL_BASE + 'FireClient-Linux-arm64.AppImage',
      debUrl: DL_BASE + 'FireClient-Linux-amd64.deb',
      tarGzUrl: DL_BASE + 'FireClient-Linux-x86_64.tar.gz',
      installCmd: 'curl -fsSL https://raw.githubusercontent.com/untitledinfo/verifed-fireclient/main/scripts/install-linux.sh | bash',
      size: 0,
      sha256: '',
      available: false
    }
  };

  let reportUrl = '';
  let sumsUrl = '';
  const assetDigests = new Map();

  for (const asset of Array.isArray(rel.assets) ? rel.assets : []) {
    if (!asset || !asset.browser_download_url) continue;
    const nm = String(asset.name || '');
    const lnm = nm.toLowerCase();
    const url = String(asset.browser_download_url);
    const sz = Number(asset.size) || 0;
    const dg = extractHex64(asset.digest || '');
    if (dg) assetDigests.set(url, { sha256: dg, size: sz, name: nm });

    if (nm === 'FireClient-Setup.exe') {
      platforms.windows.setupUrl = url;
      platforms.windows.size = sz;
      if (dg) platforms.windows.sha256 = dg;
    } else if (lnm === 'fireclient-portable.zip') {
      platforms.windows.portableUrl = url;
    } else if (nm === 'verification-report.json') {
      reportUrl = url;
    } else if (lnm === 'sha256sums.txt' || lnm === 'sha256sums') {
      sumsUrl = url;
    } else if (lnm.endsWith('.dmg')) {
      platforms.macos.available = true;
      if (lnm.includes('arm64') || lnm.includes('aarch64')) platforms.macos.arm64DmgUrl = url;
      else if (lnm.includes('x64') || lnm.includes('intel')) platforms.macos.x64DmgUrl = url;
      if (lnm.includes('universal') || !platforms.macos.size) {
        platforms.macos.dmgUrl = url;
        platforms.macos.size = sz;
        if (dg) platforms.macos.sha256 = dg;
      }
    } else if (lnm.endsWith('.zip') && (lnm.includes('mac') || lnm.includes('darwin'))) {
      platforms.macos.available = true;
      platforms.macos.zipUrl = url;
    } else if (lnm.endsWith('.appimage')) {
      platforms.linux.available = true;
      if (lnm.includes('arm64') || lnm.includes('aarch64')) platforms.linux.arm64AppImageUrl = url;
      else {
        platforms.linux.appImageUrl = url;
        platforms.linux.size = sz;
        if (dg) platforms.linux.sha256 = dg;
      }
    } else if (lnm.endsWith('.deb')) {
      platforms.linux.available = true;
      platforms.linux.debUrl = url;
      if (!platforms.linux.size) platforms.linux.size = sz;
    } else if (lnm.endsWith('.tar.gz')) {
      platforms.linux.available = true;
      platforms.linux.tarGzUrl = url;
    }
  }

  let publisher = 'FireClient LLC.';
  let defenderClean = true;
  if (reportUrl) {
    try {
      const rep = await fetchJson(reportUrl);
      const h = extractHex64(rep.sha256);
      if (h && !platforms.windows.sha256) platforms.windows.sha256 = h;
      if (rep.publisher && (rep.publisher.organization || rep.publisher.displayName)) {
        publisher = rep.publisher.organization || rep.publisher.displayName;
      }
      if (rep.microsoftDefender) defenderClean = rep.microsoftDefender.exitCode === 0;
    } catch (_) {}
  }

  if (sumsUrl) {
    try {
      const sumsRes = await fetchBuffer(sumsUrl);
      const lines = sumsRes.body.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
        if (!m) continue;
        const hash = m[1].toLowerCase();
        const fname = path.basename(m[2].trim());
        for (const [u, meta] of assetDigests.entries()) {
          if (meta.name === fname) meta.sha256 = hash;
        }
        if (fname.toLowerCase().endsWith('.dmg') && !platforms.macos.sha256) platforms.macos.sha256 = hash;
        if (fname.toLowerCase().endsWith('.appimage') && !platforms.linux.sha256) platforms.linux.sha256 = hash;
      }
    } catch (_) {}
  }

  let activeUrl = platforms.windows.setupUrl;
  let activeSize = platforms.windows.size;
  let activeSha = platforms.windows.sha256;

  if (IS_MAC) {
    activeUrl = HOST_ARCH === 'arm64'
      ? (assetDigests.has(platforms.macos.arm64DmgUrl) ? platforms.macos.arm64DmgUrl : platforms.macos.dmgUrl)
      : (assetDigests.has(platforms.macos.x64DmgUrl) ? platforms.macos.x64DmgUrl : platforms.macos.dmgUrl);
    const meta = assetDigests.get(activeUrl);
    activeSize = (meta && meta.size) || platforms.macos.size;
    activeSha = (meta && meta.sha256) || platforms.macos.sha256;
  } else if (IS_LINUX) {
    const runningAppImage = Boolean(process.env.APPIMAGE);
    if (runningAppImage) {
      activeUrl = HOST_ARCH === 'arm64' ? platforms.linux.arm64AppImageUrl : platforms.linux.appImageUrl;
    } else if (fs.existsSync('/usr/bin/dpkg') && assetDigests.has(platforms.linux.debUrl)) {
      activeUrl = platforms.linux.debUrl;
    } else {
      activeUrl = HOST_ARCH === 'arm64' ? platforms.linux.arm64AppImageUrl : platforms.linux.appImageUrl;
    }
    const meta = assetDigests.get(activeUrl);
    activeSize = (meta && meta.size) || platforms.linux.size;
    activeSha = (meta && meta.sha256) || platforms.linux.sha256;
  }

  const state = readJsonSafe(UPDATER_STATE_FILE, {});
  const hasUpdate = compareVersions(latest, CURRENT_VERSION) > 0 ||
    (activeSha ? state.installedSha256 !== activeSha : state.installedTag !== tag);

  return {
    ok: true,
    configured: true,
    hasUpdate,
    current: CURRENT_VERSION,
    latest,
    tag,
    name,
    notes,
    publishedAt,
    installerUrl: activeUrl,
    releaseUrl: htmlUrl,
    repoUrl: REPO_URL,
    size: activeSize || platforms.windows.size || 8800792,
    sha256: activeSha || platforms.windows.sha256,
    strictShaAvailable: Boolean(activeSha && assetDigests.has(activeUrl)),
    platformAssetReady: IS_WIN ? true : (IS_MAC ? platforms.macos.available : platforms.linux.available),
    publisher,
    defenderClean,
    os: HOST_OS,
    arch: HOST_ARCH,
    platforms
  };
}

let mainWindow = null;
let updaterWindow = null;
let updaterRunning = false;

function openTrustedExternal(urlStr) {
  try {
    const u = new URL(String(urlStr || ''));
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      shell.openExternal(u.toString());
      return true;
    }
  } catch (_) {}
  return false;
}

function startUpdaterWindow(force = true) {
  if (updaterWindow && !updaterWindow.isDestroyed()) {
    updaterWindow.focus();
    return;
  }
  updaterWindow = new BrowserWindow({
    width: 580,
    height: 510,
    resizable: false,
    frame: false,
    transparent: false,
    backgroundColor: '#07070c',
    show: false,
    icon: path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true
    }
  });
  updaterWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    updaterWindow.show();
  });
  updaterWindow.on('closed', () => {
    updaterWindow = null;
    updaterRunning = false;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  });
  updaterWindow.loadFile(path.join(WEB_DIR, 'updater.html'));
  updaterWindow._forceInstall = force;
}

async function runUpdaterFlow() {
  if (!updaterWindow || updaterWindow.isDestroyed() || updaterRunning) return;
  updaterRunning = true;
  const send = (ch, payload) => {
    if (updaterWindow && !updaterWindow.isDestroyed()) {
      updaterWindow.webContents.send(ch, payload);
    }
  };

  send('update-checking');
  try {
    const info = await fetchLatestReleaseInfo();
    if (!info.ok) {
      send('update-error', { message: info.error || 'Could not check GitHub Releases.' });
      updaterRunning = false;
      return;
    }
    if (!updaterWindow._forceInstall && !info.hasUpdate) {
      send('update-not-needed');
      setTimeout(() => {
        if (updaterWindow && !updaterWindow.isDestroyed()) updaterWindow.close();
      }, 1400);
      return;
    }
    if (!info.platformAssetReady) {
      send('update-error', {
        message: `Prebuilt ${HOST_OS.toUpperCase()} package is building on GitHub Releases — use the 1-line ${HOST_OS} installer or check Releases.`
      });
      updaterRunning = false;
      return;
    }

    send('update-found', info);

    const tmpDir = path.join(os.tmpdir(), 'fireclient-update');
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = path.extname(new URL(info.installerUrl).pathname) || (IS_MAC ? '.dmg' : (IS_LINUX ? '.AppImage' : '.exe'));
    const dest = path.join(tmpDir, `FireClient-${info.latest}-${HOST_OS}-${HOST_ARCH}${ext}`);

    await downloadFile(info.installerUrl, dest, (got, total, speed) => {
      const tot = total || info.size || got;
      const pct = tot > 0 ? (got / tot) * 100 : 0;
      send('update-download-progress', { percent: pct, transferred: got, total: tot, speed });
    });

    send('update-verifying', { sha256: info.sha256 });
    const actualSha = await hashFileHex(dest, 'sha256');
    if (info.strictShaAvailable && info.sha256 && actualSha !== info.sha256.toLowerCase()) {
      try { fs.unlinkSync(dest); } catch (_) {}
      send('update-error', { message: 'SHA-256 verification failed! Package rejected for your safety.' });
      updaterRunning = false;
      return;
    }

    writeJsonSafe(UPDATER_STATE_FILE, {
      installedTag: info.tag,
      installedVersion: info.latest,
      installedSha256: actualSha
    });

    send('update-download-complete');
    setTimeout(() => applyPlatformUpdate(dest, ext), 900);
  } catch (err) {
    send('update-error', { message: err && err.message ? err.message : 'Update download failed.' });
    updaterRunning = false;
  }
}

function applyPlatformUpdate(dest, ext) {
  if (IS_MAC) {
    if (ext.toLowerCase() === '.dmg') {
      execFile('hdiutil', ['attach', dest, '-nobrowse', '-autoopen'], () => {
        shell.openPath(dest);
        app.quit();
      });
    } else {
      shell.showItemInFolder(dest);
      app.quit();
    }
    return;
  }
  if (IS_LINUX) {
    if (ext.toLowerCase() === '.appimage') {
      try { fs.chmodSync(dest, 0o755); } catch (_) {}
      const targetAppImage = process.env.APPIMAGE;
      if (targetAppImage) {
        try {
          fs.copyFileSync(dest, targetAppImage);
          fs.chmodSync(targetAppImage, 0o755);
          spawn(targetAppImage, [], { detached: true, stdio: 'ignore' }).unref();
          app.quit();
          return;
        } catch (_) {}
      }
      spawn(dest, [], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
      return;
    }
    shell.openPath(dest);
    app.quit();
    return;
  }
  spawn(dest, ['/S'], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

/* --------------------------------------------------------------------------
   Cross-Platform Adoptium Temurin JDK Detector & Auto-Provisioner
   -------------------------------------------------------------------------- */
function requiredJavaMajor(mcVersion) {
  const m = String(mcVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  const patch = parseInt(m[3] || '0', 10);
  if (major >= 26) return 25;
  if (major === 1 && (minor > 20 || (minor === 20 && patch >= 5))) return 21;
  if (major === 1 && minor >= 18) return 17;
  if (major === 1 && minor === 17) return 16;
  return 8;
}

function findInstalledJava(major) {
  const javaRoot = path.join(GAME_DIR, 'java');
  const binName = IS_WIN ? 'java.exe' : 'java';
  if (fs.existsSync(javaRoot)) {
    for (const entry of fs.readdirSync(javaRoot)) {
      if (!entry.includes(String(major)) && major !== 0) continue;
      const candidates = [
        path.join(javaRoot, entry, 'bin', binName),
        path.join(javaRoot, entry, 'Contents', 'Home', 'bin', binName)
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) return c;
      }
    }
  }
  if (IS_MAC) {
    const macCandidates = [
      `/Library/Java/JavaVirtualMachines/temurin-${major}.jdk/Contents/Home/bin/java`,
      `/opt/homebrew/opt/openjdk@${major}/bin/java`,
      `/usr/local/opt/openjdk@${major}/bin/java`
    ];
    for (const c of macCandidates) if (fs.existsSync(c)) return c;
  } else if (IS_LINUX) {
    const linuxCandidates = [
      `/usr/lib/jvm/java-${major}-openjdk-amd64/bin/java`,
      `/usr/lib/jvm/java-${major}-openjdk-arm64/bin/java`,
      `/usr/lib/jvm/java-${major}-openjdk/bin/java`,
      `/usr/lib/jvm/temurin-${major}-jdk-amd64/bin/java`,
      '/usr/bin/java'
    ];
    for (const c of linuxCandidates) if (fs.existsSync(c)) return c;
  }
  return '';
}

async function ensureAdoptiumJava(major, emitLog) {
  const existing = findInstalledJava(major);
  if (existing) return existing;

  const adoptOs = IS_MAC ? 'mac' : (IS_LINUX ? 'linux' : 'windows');
  const adoptArch = HOST_ARCH === 'arm64' ? 'aarch64' : 'x64';
  const targetMajor = [8, 17, 21, 25].includes(major) ? major : 21;
  const apiUrl = `https://api.adoptium.net/v3/assets/latest/${targetMajor}/hotspot?architecture=${adoptArch}&image_type=jdk&os=${adoptOs}&vendor=eclipse`;

  if (emitLog) emitLog(`[FireClient] Provisioning Adoptium Temurin JDK ${targetMajor} for ${adoptOs}/${adoptArch}...`);
  const assets = await fetchJson(apiUrl);
  if (!Array.isArray(assets) || !assets.length || !assets[0].binary || !assets[0].binary.package) {
    throw new Error(`Adoptium JDK ${targetMajor} unavailable for ${adoptOs}/${adoptArch}`);
  }
  const pkg = assets[0].binary.package;
  const archivePath = path.join(os.tmpdir(), pkg.name);
  await downloadFile(pkg.link, archivePath);

  if (pkg.checksum) {
    const sha = await hashFileHex(archivePath, 'sha256');
    if (sha !== String(pkg.checksum).toLowerCase()) {
      fs.unlinkSync(archivePath);
      throw new Error('Adoptium JDK SHA-256 verification failed');
    }
  }

  const destDir = path.join(GAME_DIR, 'java', `temurin-${targetMajor}`);
  fs.mkdirSync(destDir, { recursive: true });

  await new Promise((resolve, reject) => {
    if (pkg.name.endsWith('.tar.gz') || pkg.name.endsWith('.tgz')) {
      execFile('tar', ['-xzf', archivePath, '-C', destDir, '--strip-components=1'], (err) => {
        if (err) reject(err); else resolve();
      });
    } else {
      execFile('unzip', ['-oq', archivePath, '-d', destDir], (err) => {
        if (err) reject(err); else resolve();
      });
    }
  });
  try { fs.unlinkSync(archivePath); } catch (_) {}

  const bin = IS_MAC && fs.existsSync(path.join(destDir, 'Contents', 'Home', 'bin', 'java'))
    ? path.join(destDir, 'Contents', 'Home', 'bin', 'java')
    : path.join(destDir, 'bin', IS_WIN ? 'java.exe' : 'java');
  if (!IS_WIN && fs.existsSync(bin)) {
    try { fs.chmodSync(bin, 0o755); } catch (_) {}
  }
  return bin;
}

/* --------------------------------------------------------------------------
   Minecraft Version Installer & Cross-Platform Java Process Launcher
   -------------------------------------------------------------------------- */
function mojangOsName() {
  if (IS_MAC) return 'osx';
  if (IS_LINUX) return 'linux';
  return 'windows';
}

function ruleMatchesOs(rules) {
  if (!Array.isArray(rules) || !rules.length) return true;
  const curOs = mojangOsName();
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name) {
        const rn = r.os.name === 'macos' ? 'osx' : r.os.name;
        if (rn !== curOs) match = false;
      }
      if (r.os.arch && r.os.arch !== HOST_ARCH) match = false;
    }
    if (r.features) match = false;
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

function mavenToPath(coord) {
  const [rawCoord, extPart] = String(coord || '').split('@');
  const parts = rawCoord.split(':');
  if (parts.length < 3) return '';
  const group = parts[0];
  const artifact = parts[1];
  const version = parts[2];
  const classifier = parts[3] || '';
  const ext = extPart || 'jar';
  const file = classifier ? `${artifact}-${version}-${classifier}.${ext}` : `${artifact}-${version}.${ext}`;
  return path.posix.join(group.replace(/\./g, '/'), artifact, version, file);
}

async function installVanillaVersion(versionId, emitProgress) {
  const manifest = await fetchJson(MOJANG_MANIFEST);
  const entry = (manifest.versions || []).find((v) => v.id === versionId);
  if (!entry) throw new Error(`Minecraft version ${versionId} not found in Mojang manifest`);
  const vDir = path.join(GAME_DIR, 'versions', versionId);
  fs.mkdirSync(vDir, { recursive: true });
  const vJsonPath = path.join(vDir, `${versionId}.json`);
  await downloadFile(entry.url, vJsonPath);
  const vJson = readJsonSafe(vJsonPath, {});
  if (vJson.downloads && vJson.downloads.client && vJson.downloads.client.url) {
    const jarPath = path.join(vDir, `${versionId}.jar`);
    if (!fs.existsSync(jarPath)) {
      if (emitProgress) emitProgress({ stage: 'client', percent: 25, label: `Downloading Minecraft ${versionId} client...` });
      await downloadFile(vJson.downloads.client.url, jarPath);
    }
  }
  return vJson;
}

async function installLoaderProfile(kind, mcVersion, loaderVersion) {
  const metaBase = kind === 'quilt' ? QUILT_META : FABRIC_META;
  let lv = loaderVersion;
  if (!lv) {
    const loaders = await fetchJson(`${metaBase}/versions/loader/${encodeURIComponent(mcVersion)}`);
    if (!Array.isArray(loaders) || !loaders.length) throw new Error(`No ${kind} loader for ${mcVersion}`);
    lv = loaders[0].loader ? loaders[0].loader.version : loaders[0].version;
  }
  await installVanillaVersion(mcVersion);
  const profileUrl = `${metaBase}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(lv)}/profile/json`;
  const profile = await fetchJson(profileUrl);
  const id = profile.id || `${kind}-loader-${lv}-${mcVersion}`;
  const pDir = path.join(GAME_DIR, 'versions', id);
  fs.mkdirSync(pDir, { recursive: true });
  writeJsonSafe(path.join(pDir, `${id}.json`), profile);
  return { ok: true, id, versionId: id };
}

function mergeVersionJson(childJson) {
  if (!childJson.inheritsFrom) return childJson;
  const parentPath = path.join(GAME_DIR, 'versions', childJson.inheritsFrom, `${childJson.inheritsFrom}.json`);
  const parent = readJsonSafe(parentPath, {});
  const merged = Object.assign({}, parent, childJson);
  merged.libraries = [...(childJson.libraries || []), ...(parent.libraries || [])];
  if (parent.arguments || childJson.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((childJson.arguments && childJson.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((childJson.arguments && childJson.arguments.jvm) || [])]
    };
  }
  if (!merged.assetIndex && parent.assetIndex) merged.assetIndex = parent.assetIndex;
  if (!merged.downloads && parent.downloads) merged.downloads = parent.downloads;
  return merged;
}

let activeGameProc = null;

async function launchMinecraft(opts = {}) {
  const versionId = String(opts.versionId || opts.version || '1.21.4');
  const sendLog = (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game-log', String(line));
    }
  };

  let vJsonPath = path.join(GAME_DIR, 'versions', versionId, `${versionId}.json`);
  if (!fs.existsSync(vJsonPath)) {
    sendLog(`[FireClient] Installing Minecraft ${versionId}...`);
    await installVanillaVersion(versionId);
  }
  const rawJson = readJsonSafe(vJsonPath, null);
  if (!rawJson) throw new Error(`Missing version metadata for ${versionId}`);
  if (rawJson.inheritsFrom) {
    const parentJson = path.join(GAME_DIR, 'versions', rawJson.inheritsFrom, `${rawJson.inheritsFrom}.json`);
    if (!fs.existsSync(parentJson)) await installVanillaVersion(rawJson.inheritsFrom);
  }
  const vJson = mergeVersionJson(rawJson);
  const baseVer = rawJson.inheritsFrom || versionId;
  const majorJava = requiredJavaMajor(baseVer);
  const javaBin = await ensureAdoptiumJava(majorJava, sendLog);

  const clientJar = path.join(GAME_DIR, 'versions', baseVer, `${baseVer}.jar`);
  if (!fs.existsSync(clientJar) && vJson.downloads && vJson.downloads.client) {
    sendLog(`[FireClient] Downloading ${baseVer}.jar...`);
    await downloadFile(vJson.downloads.client.url, clientJar);
  }

  const nativesDir = path.join(GAME_DIR, 'versions', versionId, 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });

  const cpEntries = [];
  const seenCoords = new Set();
  for (const lib of vJson.libraries || []) {
    if (!lib || !ruleMatchesOs(lib.rules)) continue;
    const rawParts = String(lib.name || '').split('@')[0].split(':');
    const coordKey = rawParts.length >= 2
      ? `${rawParts[0]}:${rawParts[1]}${rawParts[3] ? ':' + rawParts[3] : ''}`
      : '';
    let relPath = '';
    let dlUrl = '';
    if (lib.downloads && lib.downloads.artifact) {
      relPath = lib.downloads.artifact.path;
      dlUrl = lib.downloads.artifact.url;
    } else if (lib.name) {
      relPath = mavenToPath(lib.name);
      const base = (lib.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/');
      dlUrl = base + relPath.replace(/\\/g, '/');
    }
    if (relPath) {
      const fullLib = path.join(GAME_DIR, 'libraries', relPath);
      if (!fs.existsSync(fullLib) && dlUrl) {
        await downloadFile(dlUrl, fullLib).catch(() => {});
      }
      if (fs.existsSync(fullLib) && (!coordKey || !seenCoords.has(coordKey))) {
        if (coordKey) seenCoords.add(coordKey);
        cpEntries.push(fullLib);
      }
    }
    // Extract legacy 1.8.9–1.18.2 native classifier JARs (natives-osx / natives-macos / natives-linux)
    if (lib.downloads && lib.downloads.classifiers && lib.natives) {
      const osKey = mojangOsName();
      const natClassifier = (lib.natives[osKey] || (IS_MAC ? lib.natives.macos : '') || '').replace('${arch}', HOST_ARCH === 'arm64' ? '64' : '64');
      const natObj = natClassifier && lib.downloads.classifiers[natClassifier];
      if (natObj && natObj.path && natObj.url) {
        const natJar = path.join(GAME_DIR, 'libraries', natObj.path);
        if (!fs.existsSync(natJar)) {
          await downloadFile(natObj.url, natJar).catch(() => {});
        }
        if (fs.existsSync(natJar) && !IS_WIN) {
          await new Promise((res) => execFile('unzip', ['-oq', natJar, '-d', nativesDir, '-x', 'META-INF/*'], () => res()));
        }
      }
    }
  }
  if (fs.existsSync(clientJar)) cpEntries.push(clientJar);

  if (vJson.assetIndex && vJson.assetIndex.url && vJson.assetIndex.id) {
    const idxFile = path.join(GAME_DIR, 'assets', 'indexes', `${vJson.assetIndex.id}.json`);
    if (!fs.existsSync(idxFile)) await downloadFile(vJson.assetIndex.url, idxFile).catch(() => {});
  }

  const settings = readJsonSafe(SETTINGS_FILE, {});
  const ramMb = Math.max(1024, Number(opts.ramMb || settings.ramMb || 4096));

  const vault = loadVault();
  const activeAcct = (vault.accounts || []).find((a) => a.uuid === vault.activeUuid);
  const username = String(opts.username || (activeAcct && activeAcct.username) || 'Player');
  const uuid = String((activeAcct && activeAcct.uuid) || offlineUuidFromName(username));
  const accessToken = String((activeAcct && activeAcct.mcToken) || '0');

  const classpath = cpEntries.join(path.delimiter);
  const jvmArgs = [
    `-Xmx${ramMb}M`,
    '-Xms512M',
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=50'
  ];
  if (IS_MAC) jvmArgs.push('-XstartOnFirstThread');
  jvmArgs.push(
    `-Djava.library.path=${nativesDir}`,
    '-Dminecraft.launcher.brand=FireClient',
    `-Dminecraft.launcher.version=${CURRENT_VERSION}`,
    '-cp',
    classpath,
    vJson.mainClass || 'net.minecraft.client.main.Main'
  );

  const gameDir = opts.instanceDir && fs.existsSync(opts.instanceDir) ? opts.instanceDir : GAME_DIR;
  const gameArgs = [
    '--username', username,
    '--version', versionId,
    '--gameDir', gameDir,
    '--assetsDir', path.join(GAME_DIR, 'assets'),
    '--assetIndex', (vJson.assetIndex && vJson.assetIndex.id) || baseVer,
    '--uuid', uuid,
    '--accessToken', accessToken,
    '--userType', activeAcct ? 'msa' : 'legacy',
    '--versionType', 'FireClient'
  ];

  sendLog(`[FireClient] Launching ${versionId} on ${HOST_OS}/${HOST_ARCH} with Java ${majorJava} (${ramMb} MB)...`);
  activeGameProc = spawn(javaBin, [...jvmArgs, ...gameArgs], { cwd: gameDir });
  activeGameProc.stdout.on('data', (d) => sendLog(d.toString('utf8')));
  activeGameProc.stderr.on('data', (d) => sendLog(d.toString('utf8')));
  activeGameProc.on('close', (code) => {
    activeGameProc = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('game-exit', { code: code || 0 });
    }
  });
  return { ok: true, pid: activeGameProc.pid };
}

/* --------------------------------------------------------------------------
   Minecraft Server Status Ping (SRV + VarInt Handshake) & Local PaperMC Host
   -------------------------------------------------------------------------- */
function writeVarInt(val) {
  const bytes = [];
  let v = val >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      break;
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarIntFromBuf(buf, offset = 0) {
  let numRead = 0;
  let result = 0;
  while (offset + numRead < buf.length) {
    const read = buf[offset + numRead];
    result |= (read & 0x7f) << (7 * numRead);
    numRead++;
    if (numRead > 5) return null;
    if ((read & 0x80) === 0) return { value: result, length: numRead };
  }
  return null;
}

async function pingMinecraftServer(address) {
  let host = String(address || '127.0.0.1').trim();
  let port = 25565;
  let explicitPort = false;
  if (host.includes(':')) {
    const idx = host.lastIndexOf(':');
    const p = parseInt(host.slice(idx + 1), 10);
    if (p > 0 && p <= 65535) {
      port = p;
      host = host.slice(0, idx);
      explicitPort = true;
    }
  }
  if (!explicitPort && /[a-zA-Z]/.test(host)) {
    try {
      const srv = await dns.promises.resolveSrv(`_minecraft._tcp.${host}`);
      if (Array.isArray(srv) && srv.length) {
        host = srv[0].name.replace(/\.$/, '');
        port = srv[0].port;
      }
    } catch (_) {}
  }

  const startT = Date.now();
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: 4500 });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve(res);
    };

    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port, 0);
      const hsPayload = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(767),
        writeVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        writeVarInt(0x01)
      ]);
      const hsPkt = Buffer.concat([writeVarInt(hsPayload.length), hsPayload]);
      const reqPkt = Buffer.from([0x01, 0x00]);
      sock.write(Buffer.concat([hsPkt, reqPkt]));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const pktLen = readVarIntFromBuf(buf, 0);
      if (!pktLen) return;
      if (buf.length < pktLen.length + pktLen.value) return;
      const pktId = readVarIntFromBuf(buf, pktLen.length);
      if (!pktId || pktId.value !== 0x00) return finish({ online: false });
      const strLen = readVarIntFromBuf(buf, pktLen.length + pktId.length);
      if (!strLen) return;
      const jsonStart = pktLen.length + pktId.length + strLen.length;
      const jsonStr = buf.slice(jsonStart, jsonStart + strLen.value).toString('utf8');
      try {
        const j = JSON.parse(jsonStr);
        const desc = typeof j.description === 'string'
          ? j.description
          : (j.description && (j.description.text || (Array.isArray(j.description.extra) ? j.description.extra.map((e) => e.text || '').join('') : ''))) || '';
        finish({
          online: true,
          latency: Date.now() - startT,
          host,
          port,
          motd: desc,
          playersOnline: (j.players && j.players.online) || 0,
          playersMax: (j.players && j.players.max) || 0,
          version: (j.version && j.version.name) || '',
          favicon: j.favicon || ''
        });
      } catch (_) {
        finish({ online: false });
      }
    });
    sock.on('timeout', () => finish({ online: false, error: 'timeout' }));
    sock.on('error', (e) => finish({ online: false, error: e.message }));
  });
}

let activeServerProc = null;
let activeServerId = 'fireclient-main-server';

async function startLocalPaperServer(opts = {}) {
  if (activeServerProc) return { ok: true, running: true, id: activeServerId };
  const mcVer = String(opts.version || '1.21.4');
  const srvId = String(opts.id || 'fireclient-main-server');
  activeServerId = srvId;
  const srvDir = path.join(GAME_DIR, 'servers', srvId);
  fs.mkdirSync(path.join(srvDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(srvDir, 'eula.txt'), 'eula=true\n', 'utf8');

  const jarPath = path.join(srvDir, 'server.jar');
  if (!fs.existsSync(jarPath)) {
    const buildsInfo = await fetchJson(`${PAPER_API}/versions/${encodeURIComponent(mcVer)}/builds`);
    const builds = buildsInfo.builds || [];
    if (!builds.length) throw new Error(`No PaperMC builds found for ${mcVer}`);
    const latestBuild = builds[builds.length - 1];
    const dlName = latestBuild.downloads.application.name;
    const dlUrl = `${PAPER_API}/versions/${encodeURIComponent(mcVer)}/builds/${latestBuild.build}/downloads/${encodeURIComponent(dlName)}`;
    await downloadFile(dlUrl, jarPath);
  }

  const javaBin = await ensureAdoptiumJava(requiredJavaMajor(mcVer));
  const ramMb = Math.max(1024, Number(opts.ramMb || 2048));
  activeServerProc = spawn(javaBin, [`-Xmx${ramMb}M`, '-Xms512M', '-jar', jarPath, 'nogui'], { cwd: srvDir });
  const sendSrvLog = (line) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-log', String(line));
    }
  };
  activeServerProc.stdout.on('data', (d) => sendSrvLog(d.toString('utf8')));
  activeServerProc.stderr.on('data', (d) => sendSrvLog(d.toString('utf8')));
  activeServerProc.on('close', () => { activeServerProc = null; });
  return { ok: true, running: true, id: srvId, pid: activeServerProc.pid };
}

/* --------------------------------------------------------------------------
   IPC Handlers Registration (macOS + Linux + Windows Parity)
   -------------------------------------------------------------------------- */
function registerIpcHandlers() {
  const handle = (ch, fn) => {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });
  };

  /* Window Controls */
  ipcMain.on('window-minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.minimize();
  });
  ipcMain.on('window-maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
  });
  ipcMain.on('window-close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.close();
  });
  ipcMain.on('__drag-window', () => {});
  ipcMain.on('open-external', (_e, url) => openTrustedExternal(url));
  ipcMain.on('open-url', (_e, url) => openTrustedExternal(url));
  ipcMain.on('updater-ready', () => runUpdaterFlow());
  ipcMain.on('retry-update', () => runUpdaterFlow());

  handle('open-external', (url) => ({ ok: openTrustedExternal(url) }));
  handle('open-url', (url) => ({ ok: openTrustedExternal(url) }));
  handle('open-release-page', () => ({ ok: openTrustedExternal(REPO_URL + '/releases') }));

  /* Platform & System Telemetry */
  handle('get-platform-info', () => ({
    os: HOST_OS,
    arch: HOST_ARCH,
    platform: process.platform,
    version: CURRENT_VERSION,
    packageFormat: IS_MAC ? '.dmg Universal' : (IS_LINUX ? (process.env.APPIMAGE ? 'AppImage' : 'deb / tar.gz') : 'NSIS Setup.exe')
  }));

  handle('get-system-info', () => {
    const cpus = os.cpus() || [];
    return {
      os: HOST_OS,
      platform: process.platform,
      release: os.release(),
      arch: HOST_ARCH,
      cpuModel: (cpus[0] && cpus[0].model) || `${HOST_OS} ${HOST_ARCH}`,
      cpuCores: cpus.length || 4,
      totalMemMb: Math.round(os.totalmem() / 1048576),
      freeMemMb: Math.round(os.freemem() / 1048576),
      gameDir: GAME_DIR,
      version: CURRENT_VERSION
    };
  });

  /* Release Updater */
  handle('check-for-update', () => fetchLatestReleaseInfo());
  handle('download-update', (opts) => {
    const force = !opts || opts.force !== false;
    startUpdaterWindow(force);
    return { ok: true };
  });

  /* Settings & Folders */
  handle('get-settings', () => readJsonSafe(SETTINGS_FILE, { ramMb: 4096 }));
  handle('save-settings', (next) => {
    const cur = readJsonSafe(SETTINGS_FILE, {});
    const merged = Object.assign({}, cur, next || {});
    writeJsonSafe(SETTINGS_FILE, merged);
    return { ok: true, settings: merged };
  });

  const openSubDir = (sub) => {
    const p = path.join(GAME_DIR, sub || '');
    fs.mkdirSync(p, { recursive: true });
    shell.openPath(p);
    return { ok: true, path: p };
  };
  handle('open-game-dir', () => openSubDir(''));
  handle('open-mods-dir', () => openSubDir('mods'));
  handle('open-shaders-dir', () => openSubDir('shaderpacks'));
  handle('open-resourcepacks-dir', () => openSubDir('resourcepacks'));
  handle('open-saves-dir', () => openSubDir('saves'));
  handle('open-screenshots-dir', () => openSubDir('screenshots'));
  handle('open-logs-dir', () => openSubDir('logs'));
  handle('open-crash-reports-dir', () => openSubDir('crash-reports'));
  handle('open-instance-dir', (id) => openSubDir(id ? path.join('instances', String(id)) : ''));

  /* Authentication Vault */
  handle('auth-status', () => {
    const vault = loadVault();
    const active = (vault.accounts || []).find((a) => a.uuid === vault.activeUuid) || vault.accounts[0];
    if (!active) return { loggedIn: false, accounts: [] };
    return {
      loggedIn: true,
      username: active.username,
      uuid: active.uuid,
      activeUuid: active.uuid,
      accounts: vault.accounts.map((a) => ({ username: a.username, uuid: a.uuid, authType: a.authType || 'msa' }))
    };
  });
  handle('get-accounts', () => {
    const vault = loadVault();
    return {
      activeUuid: vault.activeUuid,
      accounts: (vault.accounts || []).map((a) => ({ username: a.username, uuid: a.uuid, authType: a.authType || 'msa' }))
    };
  });
  handle('auth-token-login', async (payload) => {
    const token = typeof payload === 'string' ? payload : (payload && payload.token);
    if (!token) return { ok: false, error: 'Missing Minecraft access token' };
    const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
      Authorization: `Bearer ${token.trim()}`
    });
    const vault = loadVault();
    const entry = { username: profile.name, uuid: profile.id, mcToken: token.trim(), authType: 'token' };
    vault.accounts = (vault.accounts || []).filter((a) => a.uuid !== entry.uuid).concat([entry]);
    vault.activeUuid = entry.uuid;
    saveVault(vault);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('auth-changed', { loggedIn: true, username: entry.username, uuid: entry.uuid, activeUuid: entry.uuid, accounts: vault.accounts });
    }
    return { ok: true, username: entry.username, uuid: entry.uuid };
  });
  handle('switch-account', (uuid) => {
    const vault = loadVault();
    vault.activeUuid = String(uuid || '');
    saveVault(vault);
    return { ok: true };
  });
  handle('remove-account', (uuid) => {
    const vault = loadVault();
    vault.accounts = (vault.accounts || []).filter((a) => a.uuid !== uuid);
    if (vault.activeUuid === uuid) vault.activeUuid = (vault.accounts[0] && vault.accounts[0].uuid) || '';
    saveVault(vault);
    return { ok: true };
  });
  handle('auth-logout', () => {
    saveVault({ accounts: [], activeUuid: '' });
    return { ok: true };
  });

  /* Java & Minecraft Versions */
  handle('check-java', () => {
    const found = [25, 21, 17, 8].map((m) => ({ major: m, path: findInstalledJava(m) })).filter((x) => x.path);
    return { installed: found.length > 0, runtimes: found, path: (found[0] && found[0].path) || '' };
  });
  handle('get-versions', async () => {
    const m = await fetchJson(MOJANG_MANIFEST);
    return m.versions || [];
  });
  handle('get-installed-versions', () => {
    const vRoot = path.join(GAME_DIR, 'versions');
    if (!fs.existsSync(vRoot)) return [];
    return fs.readdirSync(vRoot).filter((d) => fs.existsSync(path.join(vRoot, d, `${d}.json`)));
  });
  handle('get-fabric-versions', () => fetchJson(`${FABRIC_META}/versions/game`));
  handle('get-fabric-loaders', (mcVer) => fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVer || '1.21.4')}`));
  handle('get-quilt-versions', () => fetchJson(`${QUILT_META}/versions/game`));
  handle('install-vanilla', (ver) => installVanillaVersion(typeof ver === 'object' ? ver.version : ver));
  handle('install-fabric', (opts) => installLoaderProfile('fabric', opts.mcVersion || opts.version, opts.loaderVersion));
  handle('install-quilt', (opts) => installLoaderProfile('quilt', opts.mcVersion || opts.version, opts.loaderVersion));
  handle('launch-game', (opts) => launchMinecraft(opts));

  /* Modrinth & Local Content Management */
  handle('mr-search', (q) => {
    const query = typeof q === 'string' ? q : ((q && q.query) || '');
    const facets = (q && q.facets) ? `&facets=${encodeURIComponent(JSON.stringify(q.facets))}` : '';
    const limit = (q && q.limit) || 24;
    return fetchJson(`${MODRINTH_API}/search?query=${encodeURIComponent(query)}&limit=${limit}${facets}`);
  });
  handle('mr-get-project', (id) => fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}`));
  handle('mr-get-projects', (ids) => fetchJson(`${MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(ids || []))}`));
  handle('mr-get-versions', (opts) => {
    const id = typeof opts === 'string' ? opts : opts.projectId || opts.id;
    return fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}/version`);
  });
  handle('mr-categories', () => fetchJson(`${MODRINTH_API}/tag/category`));
  handle('mr-install-mod', async (opts) => {
    const url = opts && (opts.url || opts.downloadUrl);
    const filename = path.basename(String((opts && opts.filename) || 'mod.jar'));
    const dest = path.join(GAME_DIR, 'mods', filename);
    await downloadFile(url, dest);
    return { ok: true, path: dest };
  });
  handle('mr-shader-search', (q) => {
    const query = typeof q === 'string' ? q : ((q && q.query) || '');
    const facets = encodeURIComponent(JSON.stringify([['project_type:shader']]));
    return fetchJson(`${MODRINTH_API}/search?query=${encodeURIComponent(query)}&limit=24&facets=${facets}`);
  });
  handle('mr-shader-install', async (opts) => {
    const url = opts && (opts.url || opts.downloadUrl);
    const filename = path.basename(String((opts && opts.filename) || 'shader.zip'));
    const dest = path.join(GAME_DIR, 'shaderpacks', filename);
    await downloadFile(url, dest);
    return { ok: true, path: dest };
  });
  handle('mr-rp-search', (q) => {
    const query = typeof q === 'string' ? q : ((q && q.query) || '');
    const facets = encodeURIComponent(JSON.stringify([['project_type:resourcepack']]));
    return fetchJson(`${MODRINTH_API}/search?query=${encodeURIComponent(query)}&limit=24&facets=${facets}`);
  });
  handle('mr-rp-categories', () => fetchJson(`${MODRINTH_API}/tag/category`));
  handle('mr-rp-get-versions', (opts) => {
    const id = typeof opts === 'string' ? opts : opts.projectId || opts.id;
    return fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}/version`);
  });
  handle('mr-rp-install', async (opts) => {
    const url = opts && (opts.url || opts.downloadUrl);
    const filename = path.basename(String((opts && opts.filename) || 'resourcepack.zip'));
    const dest = path.join(GAME_DIR, 'resourcepacks', filename);
    await downloadFile(url, dest);
    return { ok: true, path: dest };
  });

  const toggleAssetFile = (sub, arg) => {
    const fname = path.basename(String(typeof arg === 'object' ? (arg.filename || arg.name) : arg));
    const full = path.join(GAME_DIR, sub, fname);
    if (!fs.existsSync(full)) return { ok: false, error: 'File not found' };
    const next = fname.endsWith('.disabled') ? full.slice(0, -9) : `${full}.disabled`;
    fs.renameSync(full, next);
    return { ok: true, enabled: !next.endsWith('.disabled'), filename: path.basename(next) };
  };
  const deleteAssetFile = (sub, arg) => {
    const fname = path.basename(String(typeof arg === 'object' ? (arg.filename || arg.name) : arg));
    const full = path.join(GAME_DIR, sub, fname);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return { ok: true };
  };
  handle('toggle-mod', (a) => toggleAssetFile('mods', a));
  handle('delete-mod', (a) => deleteAssetFile('mods', a));
  handle('toggle-shader', (a) => toggleAssetFile('shaderpacks', a));
  handle('delete-shader', (a) => deleteAssetFile('shaderpacks', a));
  handle('toggle-rp', (a) => toggleAssetFile('resourcepacks', a));
  handle('delete-rp', (a) => deleteAssetFile('resourcepacks', a));
  handle('delete-version', (ver) => {
    const id = path.basename(String(typeof ver === 'object' ? ver.id || ver.version : ver));
    const vDir = path.join(GAME_DIR, 'versions', id);
    if (id && fs.existsSync(vDir)) fs.rmSync(vDir, { recursive: true, force: true });
    return { ok: true };
  });
  handle('discord-get-client-id', () => ({ clientId: '1300000000000000000' }));
  handle('discord-presence', () => ({ ok: true }));

  const listDirFiles = (sub, exts) => {
    const dir = path.join(GAME_DIR, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => !exts || exts.some((e) => f.toLowerCase().endsWith(e)))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, filename: f, enabled: !f.endsWith('.disabled'), size: st.size, mtime: st.mtimeMs };
      });
  };
  handle('get-mods', () => listDirFiles('mods', ['.jar', '.jar.disabled']));
  handle('get-mod-count', () => listDirFiles('mods', ['.jar']).length);
  handle('get-shaders', () => listDirFiles('shaderpacks', ['.zip', '.zip.disabled']));
  handle('get-shader-count', () => listDirFiles('shaderpacks', ['.zip']).length);
  handle('get-resource-packs', () => listDirFiles('resourcepacks', ['.zip', '.zip.disabled']));
  handle('get-resource-pack-count', () => listDirFiles('resourcepacks', ['.zip']).length);
  handle('get-screenshots', () => listDirFiles('screenshots', ['.png', '.jpg', '.jpeg']));
  handle('get-all-screenshots', () => listDirFiles('screenshots', ['.png', '.jpg', '.jpeg']));
  handle('get-worlds', () => {
    const sDir = path.join(GAME_DIR, 'saves');
    if (!fs.existsSync(sDir)) return [];
    return fs.readdirSync(sDir).filter((d) => fs.existsSync(path.join(sDir, d, 'level.dat'))).map((d) => ({ name: d }));
  });
  handle('get-world-count', () => {
    const sDir = path.join(GAME_DIR, 'saves');
    if (!fs.existsSync(sDir)) return 0;
    return fs.readdirSync(sDir).filter((d) => fs.existsSync(path.join(sDir, d, 'level.dat'))).length;
  });

  /* Saved Servers & Local PaperMC Server Hosting */
  handle('get-servers', () => readJsonSafe(SERVERS_FILE, []));
  handle('save-server', (srv) => {
    const list = readJsonSafe(SERVERS_FILE, []);
    const next = Array.isArray(srv) ? srv : list.filter((s) => s.ip !== srv.ip).concat([srv]);
    writeJsonSafe(SERVERS_FILE, next);
    return { ok: true, servers: next };
  });
  handle('delete-server', (ip) => {
    const list = readJsonSafe(SERVERS_FILE, []).filter((s) => s.ip !== ip && s.id !== ip);
    writeJsonSafe(SERVERS_FILE, list);
    return { ok: true, servers: list };
  });
  handle('server-ping', (addr) => pingMinecraftServer(typeof addr === 'object' ? addr.address || addr.ip : addr));
  handle('start-server', (opts) => startLocalPaperServer(opts));
  handle('stop-server', () => {
    if (activeServerProc) {
      try { activeServerProc.stdin.write('stop\n'); } catch (_) { activeServerProc.kill(); }
    }
    return { ok: true };
  });
  handle('server-cmd', (cmd) => {
    const line = typeof cmd === 'object' ? cmd.command || cmd.cmd : cmd;
    if (activeServerProc && line) activeServerProc.stdin.write(String(line) + '\n');
    return { ok: true };
  });
  handle('server-status', () => ({ running: Boolean(activeServerProc), id: activeServerId }));
  handle('server-host-status', () => ({ running: Boolean(activeServerProc), id: activeServerId }));
  handle('server-list', () => {
    const root = path.join(GAME_DIR, 'servers');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory()).map((d) => ({
      id: d,
      name: d,
      isMain: d === 'fireclient-main-server',
      running: Boolean(activeServerProc) && activeServerId === d
    }));
  });

  /* Native Notifications & File Pickers */
  handle('show-native-notification', (opts) => {
    if (Notification.isSupported() && opts) {
      new Notification({ title: opts.title || 'FireClient', body: opts.body || '' }).show();
    }
    return { ok: true };
  });
  handle('open-file-dialog', async (opts) => {
    const res = await dialog.showOpenDialog(mainWindow, opts || { properties: ['openFile'] });
    return res.canceled ? null : res.filePaths;
  });
  handle('check-bedrock-installed', () => ({ installed: false, platform: HOST_OS }));
}

/* --------------------------------------------------------------------------
   Main Window Lifecycle
   -------------------------------------------------------------------------- */
function createMainWindow() {
  ensureDirs();
  registerIpcHandlers();

  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    backgroundColor: '#08070d',
    show: false,
    icon: path.join(ASSETS_DIR, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openTrustedExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      openTrustedExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(WEB_DIR, 'index.html'));
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createMainWindow);
}

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});
