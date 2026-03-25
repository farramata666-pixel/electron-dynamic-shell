const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, session, Menu, MenuItem, dialog, net, globalShortcut, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const fetch = require('cross-fetch');

// ── XBlocker (NSFW image classifier) ─────────────────────────────────────────
let xBlockerEnabled = true;
let xBlockerCount = 0;
let xBlockerModel = null;
let xBlockerBroadcastTimer = null;
let nsfwjs = null;

function broadcastXBlockerState() {
  const payload = { enabled: xBlockerEnabled, count: xBlockerCount };
  uiView?.webContents.send('xblocker-update', payload);
  titlebarView?.webContents.send('xblocker-update', payload);
}

function incrementXBlockerCount() {
  xBlockerCount++;
  if (!xBlockerBroadcastTimer) {
    xBlockerBroadcastTimer = setTimeout(() => {
      xBlockerBroadcastTimer = null;
      broadcastXBlockerState();
    }, 500);
  }
}

async function initXBlocker() {
  xBlockerEnabled = store.get('xBlockerEnabled', true);
  try {
    nsfwjs = require('nsfwjs');
    // Load model — nsfwjs bundles its own model weights
    xBlockerModel = await nsfwjs.load();
    console.log('[XBlocker] Model loaded');
  } catch(e) {
    console.error('[XBlocker] Init failed:', e.message);
  }
}

// ── Ad blocker ────────────────────────────────────────────────────────────────
let adBlocker = null;
const blockedSessions = new Set();
let adBlockEnabled = true;   // persisted in store, loaded at init
let adBlockCount = 0;        // resets each launch
let adBlockBroadcastTimer = null;

function broadcastAdBlockState() {
  const payload = { enabled: adBlockEnabled, count: adBlockCount };
  uiView?.webContents.send('adblock-update', payload);
  titlebarView?.webContents.send('adblock-update', payload);
}

function incrementAdBlockCount() {
  adBlockCount++;
  // Debounce broadcasts to ~500ms so IPC isn't flooded
  if (!adBlockBroadcastTimer) {
    adBlockBroadcastTimer = setTimeout(() => {
      adBlockBroadcastTimer = null;
      broadcastAdBlockState();
    }, 500);
  }
}

async function initAdBlocker() {
  adBlockEnabled = store.get('adBlockEnabled', true);
  try {
    const cacheDir = app.getPath('userData');
    const cachePath = path.join(cacheDir, 'adblocker-cache.bin');
    if (fs.existsSync(cachePath)) {
      const buf = fs.readFileSync(cachePath);
      adBlocker = ElectronBlocker.deserialize(new Uint8Array(buf));
      // Patch: disable cosmetic filters on cached instance (not compatible with Electron < 35)
      adBlocker.config = { ...adBlocker.config, loadCosmeticFilters: false };
      console.log('[AdBlock] Loaded from cache');
    } else {
      adBlocker = await ElectronBlocker.fromLists(fetch, [
        'https://easylist.to/easylist/easylist.txt',
        'https://easylist.to/easylist/easyprivacy.txt',
        'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
      ], { enableCompression: true, loadCosmeticFilters: false });
      fs.writeFileSync(cachePath, Buffer.from(adBlocker.serialize()));
      console.log('[AdBlock] Downloaded and cached filter lists');
    }

    // Domains that must never be blocked — notifications, websockets, push, realtime APIs
    // O(1) exact lookup via Set + short suffix array for subdomain matching
    const NOTIF_EXACT = new Set([
      'mail.google.com', 'chat.google.com', 'notifications.google.com',
      'fcm.googleapis.com', 'firebaseinstallations.googleapis.com',
      'mtalk.google.com', 'googleapis.com',
      'outlook.live.com', 'outlook.office.com', 'substrate.office.com',
      'push.prod.outlook.com', 'res.cdn.office.net',
      'slack.com', 'wss-primary.slack.com', 'wss-backup.slack.com',
      'notifications.slack.com', 'edgeapi.slack.com',
      'teams.live.com', 'teams.microsoft.com', 'notify.teams.microsoft.com',
      'presence.teams.microsoft.com', 'chatsvcagg.teams.microsoft.com',
      'web.telegram.org', 'wss5.web.telegram.org', 'ss.telegram.org',
      'discord.com', 'gateway.discord.gg', 'discordapp.com',
      'web.whatsapp.com', 'wss.web.whatsapp.com',
    ]);
    const NOTIF_SUFFIXES = [
      '.googleapis.com', '.slack.com', '.discord.com', '.discordapp.com',
      '.microsoft.com', '.live.com', '.telegram.org', '.whatsapp.com',
    ];
    function isNotifDomain(host) {
      if (NOTIF_EXACT.has(host)) return true;
      for (let i = 0; i < NOTIF_SUFFIXES.length; i++) {
        if (host.endsWith(NOTIF_SUFFIXES[i])) return true;
      }
      return false;
    }

    // Wrap onBeforeRequest to count blocks and protect notification endpoints
    const origOnBeforeRequest = adBlocker.onBeforeRequest.bind(adBlocker);
    adBlocker.onBeforeRequest = (details, callback) => {
      try {
        if (isNotifDomain(new URL(details.url).hostname)) { callback({}); return; }
      } catch(e) {}
      origOnBeforeRequest(details, (response) => {
        if (response && (response.cancel === true || response.redirectURL)) {
          incrementAdBlockCount();
        }
        callback(response);
      });
    };
  } catch (e) {
    console.error('[AdBlock] Init failed:', e.message);
  }
}

function applyAdBlocker(ses) {
  if (!adBlocker) {
    // Blocker not ready yet — queue this session to be applied once init completes
    _pendingAdBlockSessions.add(ses);
    return;
  }
  const key = ses.partition || ses.storagePath || 'persist:main';
  if (blockedSessions.has(key)) return;
  blockedSessions.add(key);
  if (adBlockEnabled) adBlocker.enableBlockingInSession(ses);
  console.log(`[AdBlock] ${adBlockEnabled ? 'Enabled' : 'Registered (disabled)'} for session: ${key}`);
}
const _pendingAdBlockSessions = new Set();
// ── Blur system globals ───────────────────────────────────────────────────────
let blurPopupWin = null;
const DEFAULT_BLUR_SETTINGS = {
  enabled: true,
  blurAmount: 20,
  gray: false,
};
// Per-account blur exclusion list (accountIds where blur is suppressed)
let blurExcluded = new Set();

// JS to inject into a view to simulate page visibility state
// Defined here (top-level) so they're available in all ipcMain handlers below
const JS_SET_HIDDEN = `
(function() {
  try {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch(e) {}
})();
`;
const JS_SET_VISIBLE = `
(function() {
  try {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  } catch(e) {}
})();
`;

// ── Embedded server ───────────────────────────────────────────────────────────
let serverProcess = null;

function startServer() {
  const { spawn } = require('child_process');
  // In packaged app: entire server folder (code + node_modules) is in extraResources
  // so it lives on the real filesystem — no asar path tricks needed.
  const serverDir = app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '..', 'server');
  const serverPath = path.join(serverDir, 'index.js');

  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
  });
  serverProcess.stdout.on('data', d => console.log('[Server]', d.toString().trim()));
  serverProcess.stderr.on('data', d => console.error('[Server]', d.toString().trim()));
  serverProcess.on('exit', (code) => console.log(`[Server] exited with code ${code}`));
}

app.whenReady().then(startServer);

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// Fix GPU shader cache "Access is denied" errors — these flood the main thread
// and cause slowdowns when running from paths with spaces or restricted permissions
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// ── Pre-emptively fix corrupted electron-store config ────────────────────────
// Must run BEFORE new Store() is called
;(function() {
  // electron-store stores config in APPDATA\{name}\config.json on Windows
  const possiblePaths = [
    path.join(process.env.APPDATA || '', 'unified-comms', 'config.json'),
    path.join(process.env.HOME || '', '.config', 'unified-comms', 'config.json'),
  ];
  for (const confPath of possiblePaths) {
    try {
      if (!fs.existsSync(confPath)) continue;
      const buf = fs.readFileSync(confPath);
      // Detect UTF-8 BOM (EF BB BF) or UTF-16 BOM (FF FE / FE FF)
      const hasBOM = (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ||
                     (buf[0] === 0xFF && buf[1] === 0xFE) ||
                     (buf[0] === 0xFE && buf[1] === 0xFF);
      const raw = buf.toString('utf8').replace(/^\uFEFF/, '').trim();
      if (hasBOM || !raw.startsWith('{')) {
        fs.unlinkSync(confPath);
        console.log('[Store] Deleted corrupted config.json (BOM/invalid)');
        continue;
      }
      JSON.parse(raw); // throws if invalid JSON
    } catch(e) {
      try { fs.unlinkSync(confPath); } catch(e2) {}
      console.log('[Store] Deleted corrupted config.json:', e.message);
    }
  }
})();

// Safely initialize store — delete corrupted config and retry
function safeInitStore() {
  try {
    return new Store();
  } catch(e) {
    console.error('[Store] Init failed, resetting:', e.message);
    const confPath = path.join(process.env.APPDATA || process.env.HOME || '', 'unified-comms', 'config.json');
    try { fs.unlinkSync(confPath); } catch(e2) {}
    return new Store();
  }
}
const store = safeInitStore();
let mainWindow;   // BaseWindow
let uiView;       // WebContentsView for index.html (UI layer)
let titlebarView; // WebContentsView for titlebar chrome
let extensions;

// Cache renderer.js content at startup — avoids repeated disk reads on every view load
let _rendererCodeCache = null;
function getRendererCode() {
  if (!_rendererCodeCache) {
    _rendererCodeCache = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  }
  return _rendererCodeCache;
}

// Per-accountId debounce timers for page-title-updated — prevents burst regex work
const titleUpdateTimers = new Map();
function debounceTitleUpdate(accountId, fn, delay = 200) {
  clearTimeout(titleUpdateTimers.get(accountId));
  titleUpdateTimers.set(accountId, setTimeout(fn, delay));
}

const views = new Map();
const activePartitions = new Set();
let currentAccountId = null;

// Cache of service overlay icons (serviceId -> nativeImage), built at startup
const overlayIconCache = new Map();

async function buildOverlayIconCache() {
  if (process.platform !== 'win32') return;
  const { nativeImage } = require('electron');

  // Fetch services from config
  const servicesPath = path.join(app.getPath('userData'), 'services.json');
  let servicesKeys = [];
  try {
    if (fs.existsSync(servicesPath)) {
      const config = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
      servicesKeys = Object.keys(config);
    }
  } catch (e) {
    console.error('[Overlay] Failed to read services.json:', e.message);
  }

  if (servicesKeys.length === 0) return;

  for (const svc of servicesKeys) {
    try {
      const svgPath = path.join(__dirname, '..', 'assets', 'icons', svc + '.svg');
      if (!fs.existsSync(svgPath)) continue;
      const svgContent = fs.readFileSync(svgPath, 'utf8');
      // Render SVG via a hidden offscreen BrowserWindow
      const win = new BrowserWindow({ width: 64, height: 64, show: false, webPreferences: { offscreen: true } });
      const html = `<html><body style="margin:0;background:#1e1f2e;border-radius:32px;overflow:hidden;width:64px;height:64px;display:flex;align-items:center;justify-content:center;"><img src="data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}" width="48" height="48"></body></html>`;
      await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
      const img = await win.webContents.capturePage();
      win.destroy();
      overlayIconCache.set(svc, nativeImage.createFromBuffer(img.toPNG()));
    } catch(e) {
      console.log('[Overlay] Failed to cache icon for', svc, e.message);
    }
  }
  console.log('[Overlay] Icon cache built:', overlayIconCache.size, 'icons');
}

const TITLEBAR_HEIGHT = 68;
const SIDEBAR_WIDTH = 80;
const MEMORY_CHECK_INTERVAL = 120000;
const MAX_MEMORY_MB = 500;
const MAIN_PARTITION = 'persist:main';

// Dynamic layout dimensions — read from actual rendered DOM so CSS clamp() values
// are respected. Falls back to the design-time defaults if DOM isn't ready yet.
let _dynamicTitlebarHeight = 68;
let _dynamicSidebarWidth = 80;

function getDynamicLayout() {
  return { titlebarHeight: _dynamicTitlebarHeight, sidebarWidth: _dynamicSidebarWidth };
}

// Called from renderer via IPC whenever the window resizes
ipcMain.on('layout-dimensions', (event, { titlebarHeight, sidebarWidth }) => {
  _dynamicTitlebarHeight = titlebarHeight || 68;
  _dynamicSidebarWidth = sidebarWidth || 80;
  // Re-position the active service view with new dimensions
  if (currentAccountId && views.has(currentAccountId) && mainWindow && !mainWindow.isDestroyed()) {
    views.get(currentAccountId).setBounds(getViewBounds());
  }
});

// Preload scripts must live on the real filesystem (not inside asar).
// app.asar.unpacked is the sibling directory electron-builder creates for asarUnpack entries.
// In dev (npm start), __dirname is the real src/ folder — path.join works directly.
// In prod (built exe), __dirname is inside app.asar — we must redirect to app.asar.unpacked.
function getUnpackedPath(relativePath) {
  if (app.isPackaged) {
    // __dirname is e.g. /resources/app.asar/src — replace app.asar with app.asar.unpacked
    return path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), relativePath);
  }
  return path.join(__dirname, relativePath);
}
const COMBINED_PRELOAD_PATH = getUnpackedPath('combined-preload.js');

// Services that fire window.Notification natively — dom-badge and title paths
// must NOT also fire a desktop alert for these (prevents duplicates)
// Note: outlook removed — its SW notification intercept is unreliable in Electron,
// so it uses the dom-badge path for alerts instead
const WEB_NOTIF_SERVICES = new Set(['telegram', 'slack', 'teams', 'whatsapp']);

// Modern Chrome user-agent so Gmail, Outlook, Slack, Teams, etc. don't block or misbehave in Electron
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// Force English UI for Google Chat and other services that use Accept-Language
const LOAD_OPTIONS = { extraHeaders: 'Accept-Language: en-US,en;q=0.9\n' };

function getMainSession() { return session.fromPartition(MAIN_PARTITION); }

function getViewBounds() {
  const [w, h] = mainWindow.getContentSize();
  const safeW = w > 200 ? w : 1400;
  const safeH = h > 200 ? h : 900;
  return { x: _dynamicSidebarWidth, y: _dynamicTitlebarHeight, width: safeW - _dynamicSidebarWidth, height: safeH - _dynamicTitlebarHeight };
}

// ── Extension helpers ─────────────────────────────────────────────────────────

async function loadExtIntoSession(ses, extPath) {
  try {
    await ses.loadExtension(extPath, { allowFileAccess: true });
  } catch(e) {
    if (!e.message.includes('already')) console.log(`[Ext] load failed: ${e.message}`);
  }
}

// Prevent extension errors from crashing the app
process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught exception:', error.message);
  // Don't exit - keep app running
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
  // Don't exit - keep app running
});

// Catch renderer process crashes
app.on('render-process-gone', (event, webContents, details) => {
  console.error('[App] Renderer process gone:', details.reason);
  // Don't exit - main process continues
});

async function loadAllExtensionsIntoSession(ses) {
  const disabled = store.get('disabledExtensions', []);
  const allPaths = store.get('extensionPaths', {});
  for (const [id, extPath] of Object.entries(allPaths)) {
    if (disabled.includes(id)) continue;
    if (!fs.existsSync(extPath)) continue;
    try {
      await loadExtIntoSession(ses, extPath);
    } catch(e) {
      console.log(`[Ext] Failed to load ${id} into session:`, e.message);
    }
  }
}

async function restoreExtensions() {
  try {
    await loadAllExtensionsIntoSession(getMainSession());
    console.log('[Extensions] Restored into main session');
  } catch(e) {
    console.error('[Extensions] Restore failed:', e.message);
    // Continue anyway - app should work without extensions
  }
}

// ── Service view context menu ─────────────────────────────────────────────────
// Builds a native context menu for right-clicks inside service web pages.
// Items shown depend on what was clicked: link, image, selected text, or blank area.
function attachServiceContextMenu(view) {
  view.webContents.on('context-menu', (e, params) => {
    const items = [];

    // Link — open in system browser or copy URL
    if (params.linkURL) {
      items.push(new MenuItem({
        label: 'Open link in browser',
        click: () => shell.openExternal(params.linkURL).catch(() => {}),
      }));
      items.push(new MenuItem({
        label: 'Copy link address',
        click: () => { clipboard.writeText(params.linkURL); },
      }));
      items.push(new MenuItem({ type: 'separator' }));
    }

    // Image
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(new MenuItem({
        label: 'Open image in browser',
        click: () => shell.openExternal(params.srcURL).catch(() => {}),
      }));
      items.push(new MenuItem({
        label: 'Copy image address',
        click: () => { clipboard.writeText(params.srcURL); },
      }));
      items.push(new MenuItem({ type: 'separator' }));
    }

    // Selected text
    if (params.selectionText && params.selectionText.trim()) {
      items.push(new MenuItem({
        label: 'Copy',
        role: 'copy',
      }));
      items.push(new MenuItem({
        label: `Search Google for "${params.selectionText.trim().slice(0, 30)}${params.selectionText.length > 30 ? '…' : ''}"`,
        click: () => shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText.trim())}`).catch(() => {}),
      }));
      items.push(new MenuItem({ type: 'separator' }));
    }

    // Editable field — paste
    if (params.isEditable) {
      if (!params.selectionText) {
        items.push(new MenuItem({ label: 'Cut', role: 'cut' }));
        items.push(new MenuItem({ label: 'Copy', role: 'copy' }));
      }
      items.push(new MenuItem({ label: 'Paste', role: 'paste' }));
      items.push(new MenuItem({ type: 'separator' }));
    }

    // Always: reload + back/forward
    items.push(new MenuItem({
      label: 'Reload',
      click: () => { if (!view.webContents.isDestroyed()) view.webContents.reload(); },
    }));
    items.push(new MenuItem({
      label: 'Back',
      enabled: view.webContents.navigationHistory?.canGoBack() ?? view.webContents.canGoBack(),
      click: () => { if (!view.webContents.isDestroyed()) view.webContents.goBack(); },
    }));
    items.push(new MenuItem({
      label: 'Forward',
      enabled: view.webContents.navigationHistory?.canGoForward() ?? view.webContents.canGoForward(),
      click: () => { if (!view.webContents.isDestroyed()) view.webContents.goForward(); },
    }));

    if (items.length === 0) return;
    const menu = new Menu();
    items.forEach(item => menu.append(item));
    menu.popup({ window: mainWindow });
  });
}

async function createWindow() {
  const mainSession = getMainSession();

  extensions = new ElectronChromeExtensions({
    session: mainSession,
    license: 'GPL-3.0',
    createTab: async (details) => {
      const win = new BrowserWindow({
        width: 800, height: 600,
        webPreferences: { session: mainSession, contextIsolation: true, sandbox: false }
      });
      if (details.url) await win.loadURL(details.url);
      else await win.loadURL('about:blank');
      win.show();
      extensions.addTab(win.webContents, win);
      return [win.webContents, win];
    },
    selectTab: (webContents, browserWindow) => { browserWindow?.focus(); },
    removeTab: (webContents, browserWindow) => { if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close(); },
  });

  await restoreExtensions();
  applyAdBlocker(mainSession);

  // ── Use BaseWindow so we control the full view hierarchy ──────────────────
  // BaseWindow has no built-in webContents — we add a uiView for the HTML UI
  // and service WebContentsViews as siblings on top.
  const appIconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  mainWindow = new BaseWindow({
    width: 1400, height: 900, titleBarStyle: 'hidden', frame: false,
    backgroundColor: '#1a1a1a', show: false,
    icon: appIconPath,
  });
  // Also set via setIcon for taskbar (works in dev mode too)
  try { mainWindow.setIcon(appIconPath); } catch(e) {}

  // Background fill view — solid dark color behind everything
  const bgView = new WebContentsView({ webPreferences: { partition: MAIN_PARTITION } });
  bgView.setBackgroundColor('#1a1a1a');
  mainWindow.contentView.addChildView(bgView);

  // UI is split into two non-overlapping chrome views so service views own the
  // content area (x:72, y:40) completely — no passthrough tricks needed.
  // sidebarView: left strip (sidebar icons, account badges, memory indicator)
  // titlebarView: top strip (title, reload, blur, extensions, settings, window controls)
  // Both load the same index.html in the same partition so IPC/state is shared.
  const uiWebPrefs = {
    nodeIntegration: true, contextIsolation: false,
    partition: MAIN_PARTITION, backgroundThrottling: false, spellcheck: false,
  };

  uiView = new WebContentsView({ webPreferences: uiWebPrefs }); // sidebarView alias kept for IPC compat
  uiView.setBackgroundColor('#00000000');
  mainWindow.contentView.addChildView(uiView);

  titlebarView = new WebContentsView({ webPreferences: uiWebPrefs });
  titlebarView.setBackgroundColor('#00000000');
  mainWindow.contentView.addChildView(titlebarView);

  function resizeUIView() {
    const [w, h] = mainWindow.getContentSize();
    const safeW = w > 200 ? w : 1400;
    const safeH = h > 200 ? h : 900;
    bgView.setBounds({ x: 0, y: 0, width: safeW, height: safeH });
    // Sidebar strip — full height, left edge only
    uiView.setBounds({ x: 0, y: 0, width: _dynamicSidebarWidth, height: safeH });
    // Titlebar strip — full width, top edge only
    titlebarView.setBounds({ x: 0, y: 0, width: safeW, height: _dynamicTitlebarHeight });
  }
  resizeUIView();

  // Show window immediately — BaseWindow doesn't have ready-to-show
  mainWindow.show();

  let _resizeTimer = null;
  mainWindow.on('resize', () => {
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      const [w, h] = mainWindow.getContentSize();
      const dims = { width: w > 200 ? w : 1400, height: h > 200 ? h : 900 };
      resizeUIView();
      if (currentAccountId && views.has(currentAccountId)) {
        views.get(currentAccountId).setBounds(getViewBounds());
      }
      uiView.webContents.send('window-resized', dims);
      titlebarView?.webContents.send('window-resized', dims);
    }, 16); // ~1 frame debounce
  });

  // Explicit maximize/unmaximize handlers — BaseWindow may not always fire 'resize'
  // on maximize on Windows, so handle both events to be safe.
  function onMaximizeChange() {
    const [w, h] = mainWindow.getContentSize();
    const dims = { width: w > 200 ? w : 1400, height: h > 200 ? h : 900 };
    resizeUIView();
    if (currentAccountId && views.has(currentAccountId)) {
      views.get(currentAccountId).setBounds(getViewBounds());
    }
    uiView.webContents.send('window-resized', dims);
    titlebarView?.webContents.send('window-resized', dims);
  }
  mainWindow.on('maximize', onMaximizeChange);
  mainWindow.on('unmaximize', onMaximizeChange);

  mainWindow.on('move', () => {});

  app.on('web-contents-created', (event, wc) => {
    wc.on('before-input-event', (e, input) => {
      if (input.key === 'F12' && input.type === 'keyDown') {
        // F12 = open DevTools on the active service view (not the UI chrome)
        if (currentAccountId && views.has(currentAccountId)) {
          views.get(currentAccountId).webContents.openDevTools({ mode: 'detach' });
        } else {
          uiView?.webContents.openDevTools({ mode: 'detach' });
        }
      }
    });
  });

  uiView.webContents.loadFile('src/index.html');
  uiView.webContents.on('did-finish-load', () => {
    console.log('[UIView] did-finish-load:', uiView.webContents.getURL());
    // Send initial window dimensions so responsive layout applies immediately
    const [w, h] = mainWindow.getContentSize();
    setTimeout(() => uiView.webContents.send('window-resized', { width: w > 200 ? w : 1400, height: h > 200 ? h : 900 }), 100);
  });
  uiView.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[UIView] did-fail-load:', code, desc, url));
  uiView.webContents.on('render-process-gone', (e, details) => console.log('[UIView] render-process-gone:', details.reason));
  uiView.webContents.on('console-message', (event, level, message) => console.log(`[Renderer] ${message}`));
  uiView.webContents.on('context-menu', (e) => e.preventDefault());
  uiView.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (currentAccountId && views.has(currentAccountId)) {
        views.get(currentAccountId).webContents.openDevTools({ mode: 'detach' });
      } else {
        uiView.webContents.openDevTools({ mode: 'detach' });
      }
    }
    if (input.type === 'keyDown' && (input.control || input.meta)) {
      if (input.key === ',') uiView.webContents.send('open-settings');
      if (input.key === 'e') uiView.webContents.send('open-extensions');
    }
  });

  // titlebarView — same index.html, same partition, handles top chrome + modals
  titlebarView.webContents.loadFile('src/index.html');
  titlebarView.webContents.on('did-finish-load', () => {
    console.log('[TitlebarView] did-finish-load');
    // Send initial window dimensions so responsive layout applies immediately
    const [w, h] = mainWindow.getContentSize();
    setTimeout(() => titlebarView.webContents.send('window-resized', { width: w > 200 ? w : 1400, height: h > 200 ? h : 900 }), 100);
  });
  titlebarView.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[TitlebarView] did-fail-load:', code, desc, url));
  titlebarView.webContents.on('render-process-gone', (e, details) => console.log('[TitlebarView] render-process-gone:', details.reason));
  titlebarView.webContents.on('console-message', (event, level, message) => console.log(`[Titlebar] ${message}`));
  titlebarView.webContents.on('context-menu', (e) => e.preventDefault());
  titlebarView.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (currentAccountId && views.has(currentAccountId)) {
        views.get(currentAccountId).webContents.openDevTools({ mode: 'detach' });
      } else {
        titlebarView.webContents.openDevTools({ mode: 'detach' });
      }
    }
    if (input.type === 'keyDown' && (input.control || input.meta)) {
      if (input.key === ',') { uiView.webContents.send('open-settings'); titlebarView.webContents.send('open-settings'); }
      if (input.key === 'e') { uiView.webContents.send('open-extensions'); titlebarView.webContents.send('open-extensions'); }
    }
  });

  createMenu();
  startMemoryMonitoring();
  mainWindow.on('closed', () => {
    mainWindow = null;
    uiView = null;
    // Force-exit so no Electron renderer processes linger after the window closes
    app.exit(0);
  });
  mainWindow.on('system-context-menu', (e) => e.preventDefault());
  console.log('Window created successfully');
}

ipcMain.handle('create-view', async (event, { accountId, url, partition, forceReload }) => {
  // Teams account 2+ — override URL to force Microsoft account picker so the
  // user can sign in with a different account instead of reusing account 1's session.
  // After sign-in, Microsoft redirects back to teams.live.com automatically.
  const isTeamsExtra = accountId.startsWith('teams-') && !accountId.endsWith('-1');
  if (isTeamsExtra && !views.has(accountId)) {
    url = 'https://login.live.com/login.srf?wa=wsignin1.0&rpsnv=13&ct=1&rver=7.0.6730.0&wp=MBI_SSL&wreply=https%3A%2F%2Fteams.live.com%2F&id=293290&aadredir=1&prompt=select_account';
  }

  // Gmail and GChat account 2+ use a BrowserWindow — Google blocks sign-in
  // in embedded WebContentsViews but a BrowserWindow works like a real browser.
  const isGoogleExtra = (accountId.startsWith('gmail-') || accountId.startsWith('gchat-'))
    && !accountId.endsWith('-1');

  if (isGoogleExtra) {
    if (views.has(accountId)) {
      if (forceReload) views.get(accountId).webContents.loadURL(url, LOAD_OPTIONS).catch(() => {});
      return { success: true };
    }
    const ses = session.fromPartition(partition);
    ses.setUserAgent(CHROME_USER_AGENT, 'en-US,en');

    // Apply Google sign-in spoofing at the session level so the embedded view
    // looks like a real Chrome browser — same technique as google-signin-window
    ses.webRequest.onBeforeSendHeaders(
      { urls: ['https://*.google.com/*', 'https://accounts.google.com/*'] },
      (details, callback) => {
        const headers = details.requestHeaders;
        delete headers['X-Electron'];
        headers['sec-ch-ua'] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Windows"';
        headers['User-Agent'] = CHROME_USER_AGENT;
        callback({ requestHeaders: headers });
      }
    );

    // Preload that scrubs Node/Electron globals before any page JS
    const spoofPath = path.join(app.getPath('userData'), `google-spoof-${partition.replace(/[^a-z0-9]/gi, '_')}.js`);
    if (!fs.existsSync(spoofPath)) {
      fs.writeFileSync(spoofPath, `(function() {
        ['process','require','module','exports','__dirname','__filename','Buffer'].forEach(k => {
          try { delete window[k]; } catch(e) {}
          try { Object.defineProperty(window, k, { get: () => undefined, configurable: true }); } catch(e) {}
        });
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch(e) {}
        try {
          if (!window.chrome || !window.chrome.runtime) {
            window.chrome = {
              app: { isInstalled: false, InstallState: {}, RunningState: {} },
              runtime: { id: undefined },
              loadTimes: function() { return {}; },
              csi: function() { return {}; },
            };
          }
        } catch(e) {}
      })();`);
    }
    const existing = ses.getPreloads();
    if (!existing.includes(spoofPath)) ses.setPreloads([...existing, spoofPath]);

    await loadAllExtensionsIntoSession(ses).catch(() => {});
    activePartitions.add(partition);
    applyAdBlocker(ses);

    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: COMBINED_PRELOAD_PATH,
      }
    });
    view.setBackgroundColor('#ffffff');
    view.__partition = partition;
    views.set(accountId, view);

    view.webContents.setUserAgent(CHROME_USER_AGENT);

    const serviceLabel = accountId.replace(/-\d+$/, '').replace(/^./, c => c.toUpperCase());
    let lastCount = 0;
    view.webContents.on('page-title-updated', (e, title) => {
      uiView?.webContents.send('view-title-updated', { accountId, title });
      debounceTitleUpdate(accountId, () => {
        const m = title.match(/^\((\d+)\)/) || title.match(/\((\d+)\)\s*$/);
        const newCount = m ? parseInt(m[1]) : 0;
        const suppressed = getSuppressed(accountId);
        const effectiveCount = newCount > suppressed ? newCount : 0;
        const windowFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
        const userIsReading = (currentAccountId === accountId) && windowFocused;
        if (effectiveCount > lastCount && !userIsReading) {
          const key = `${accountId}-title-${effectiveCount}`;
          if (!isDuplicateNotif(key)) uiView?.webContents.send('request-account-name', { accountId, newCount: effectiveCount, serviceLabel });
        }
        lastCount = effectiveCount;
      });
    });
    view.webContents.on('did-finish-load', () => {
      uiView?.webContents.send('view-loaded', { accountId });
      viewLoadedOnce.add(accountId);
      if (currentAccountId !== accountId) {
        view.webContents.executeJavaScript(JS_SET_HIDDEN).catch(() => {});
      }
    });
    attachServiceContextMenu(view);

    view.webContents.loadURL(url, LOAD_OPTIONS).catch(() => {});
    return { success: true };
  }

  if (views.has(accountId)) {
    if (forceReload) views.get(accountId).webContents.loadURL(url, LOAD_OPTIONS).catch(() => {});
    return { success: true };
  }

  const serviceLabel = accountId.replace(/-\d+$/, '').replace(/^./, c => c.toUpperCase());
  const serviceId = accountId.replace(/-\d+$/, '');

  if (!activePartitions.has(partition)) {
    activePartitions.add(partition);
    try {
      const ses = session.fromPartition(partition);
      const ua = partition.includes('whatsapp')
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        : CHROME_USER_AGENT;
      ses.setUserAgent(ua, 'en-US,en');
      await loadAllExtensionsIntoSession(ses);
      applyAdBlocker(ses);

      // For all services: grant notification permission so pages don't block on the
      // permission prompt, but our preload intercepts the actual Notification constructor
      // before any OS notification is shown.
      ses.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'notifications') {
          // Grant permission — our window.Notification intercept in the preload
          // catches the constructor call before it reaches the OS.
          callback(true);
        } else {
          callback(true);
        }
      });

      console.log(`[Extensions] Loaded into ${partition}`);
    } catch(e) {
      console.error(`[Extensions] Failed to load into ${partition}:`, e.message);
      // Continue anyway - view should work without extensions
    }
  }

  const view = new WebContentsView({
    webPreferences: {
      partition, nodeIntegration: false, contextIsolation: false,
      sandbox: false, spellcheck: false, backgroundThrottling: false,
      preload: COMBINED_PRELOAD_PATH,
    }
  });
  view.setBackgroundColor('#ffffff');

  view.__partition = partition; // store for IPC handler lookup
  views.set(accountId, view);

  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    // Microsoft auth popups use window.open + postMessage back to opener.
    // We must allow them as real child windows — denying or redirecting in-view
    // breaks the OAuth postMessage handshake and Teams never gets the token.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 600, height: 700, parent: mainWindow,
        webPreferences: { partition, nodeIntegration: false, contextIsolation: true }
      }
    };
  });

  let lastNotifCount = 0;
  view.webContents.on('page-title-updated', (e, title) => {
    uiView?.webContents.send('view-title-updated', { accountId, title });
    debounceTitleUpdate(accountId, () => {
      // Parse unread count from title — covers all services
      const countMatch =
        title.match(/^\((\d+)\)/) ||       // (3) Gmail / (3) Slack / (3) WhatsApp
        title.match(/\((\d+)\)\s*$/) ||    // trailing (3)
        title.match(/^\*(\d+)\*/) ||       // *3* some services
        title.match(/\[(\d+)\]/);          // [3] some services
      const newCount = countMatch ? parseInt(countMatch[1]) : 0;
      if (newCount > 0 && mainWindow) mainWindow.setTitle(`(${newCount}) Unified Comms`);
      if (newCount === 0) clearSuppressed(accountId);
      const suppressed = getSuppressed(accountId);
      const effectiveCount = newCount > suppressed ? newCount : 0;
      const windowFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
      const userIsReading = (currentAccountId === accountId) && windowFocused;
      if (effectiveCount > lastNotifCount && !userIsReading) {
        const dedupKey = `${accountId}-alert-${effectiveCount}`;
        if (!isDuplicateNotif(dedupKey) && !WEB_NOTIF_SERVICES.has(serviceId)) {
          console.log(`[page-title-updated] firing toast for ${accountId} count=${effectiveCount}`);
          showToast({ accountId, accountName: 'Default', serviceLabel, sender: null, body: `You have ${effectiveCount} unread message${effectiveCount > 1 ? 's' : ''}`, unreadCount: effectiveCount });
        }
      }
      lastNotifCount = effectiveCount;
    });
  });

  // Google Chat doesn't put counts in title — DOM polling in preload handles it
  // Favicon change is a secondary signal — only use it as a fallback if count is 0
  view.webContents.on('page-favicon-updated', (e, favicons) => {
    if (!accountId.startsWith('gchat')) return;
    const hasBadge = favicons.some(f => f.includes('badge') || f.includes('unread') || f.includes('_dot'));
    if (!hasBadge) {
      // Favicon went back to normal — clear the badge
      uiView?.webContents.send('view-title-updated', { accountId, title: 'Google Chat' });
    }
  });

  view.webContents.on('did-finish-load', () => {
    console.log(`[View] did-finish-load: ${accountId} url=${view.webContents.getURL().slice(0, 60)}`);
    uiView?.webContents.send('view-loaded', { accountId });
    injectBlurIntoView(view);
    // Send current xblocker state so the preload observer starts correctly
    view.webContents.send('xblocker-state', { enabled: xBlockerEnabled });
    // Skip executeJavaScript on Microsoft auth pages — it disrupts their React login flow
    const currentUrl = view.webContents.getURL();
    const isMsAuth = currentUrl.includes('login.microsoftonline.com') || currentUrl.includes('login.live.com') || currentUrl.includes('account.microsoft.com');
    if (isMsAuth) return;

    // Discord: intercept notifications via multiple paths since Discord web
    // fires showNotification from inside the SW context (not patchable from page).
    // Strategy: intercept SW→page messages, and also use session-level notification
    // permission denial to force Discord to fall back to window.Notification.
    if (serviceId === 'discord') {
      // Deny SW notification permission at session level so the SW cannot show
      // OS notifications — Discord will fall back to window.Notification in page context
      // which our preload already intercepts.
      const discordSes = view.webContents.session;
      discordSes.setPermissionRequestHandler((wc, permission, callback, details) => {
        if (permission === 'notifications') {
          // Grant to page context (window.Notification works), deny to SW push
          // We can't distinguish SW vs page here, so grant all — our FakeNotification handles it
          callback(true);
        } else {
          callback(true);
        }
      });

      view.webContents.executeJavaScript(`
        (function() {
          if (window.__discordNotifPatched) return;
          window.__discordNotifPatched = true;

          function forwardToPreload(title, options) {
            console.log('[discord-inject] forwardToPreload title=' + title + ' body=' + ((options && options.body) || ''));
            try { require('electron').ipcRenderer.send('web-notification', { title: title || '', body: (options && options.body) || '', icon: (options && options.icon) || '' }); } catch(e) { console.error('[discord-inject] ipc error', e); }
          }

          // Intercept SW→page messages — Discord SW posts notification data back to page
          if (navigator.serviceWorker) {
            navigator.serviceWorker.addEventListener('message', function(event) {
              const d = event.data;
              if (!d) return;
              console.log('[discord-inject] SW message:', JSON.stringify(d).slice(0, 200));
              // Discord SW message formats vary — try common patterns
              const title = d.title || (d.notification && d.notification.title) || (d.data && d.data.title) || '';
              const body  = d.body  || (d.notification && d.notification.body)  || (d.data && d.data.body)  || '';
              if (title) forwardToPreload(title, { body });
            });
          }

          // Patch prototype (covers any page-context showNotification calls)
          try {
            ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
              forwardToPreload(title, options);
            };
          } catch(e) {}

          // Patch resolved registrations — with retries since Discord registers SW lazily
          function patchRegistration(reg) {
            if (!reg || reg.__discordPatched) return;
            reg.__discordPatched = true;
            reg.showNotification = function(title, options) { forwardToPreload(title, options); };
            console.log('[discord-inject] registration patched:', reg.scope);
          }
          if (navigator.serviceWorker) {
            // ready resolves when SW is active — may take several seconds after page load
            navigator.serviceWorker.ready.then(patchRegistration).catch(() => {});
            navigator.serviceWorker.getRegistrations().then(regs => { console.log('[discord-inject] existing regs:', regs.length); regs.forEach(patchRegistration); }).catch(() => {});
            // Retry every 2s for 30s to catch lazy SW registration
            var retryCount = 0;
            var retryInterval = setInterval(function() {
              retryCount++;
              navigator.serviceWorker.getRegistrations().then(function(regs) {
                regs.forEach(patchRegistration);
                if (regs.length > 0 || retryCount >= 15) clearInterval(retryInterval);
              }).catch(function() { clearInterval(retryInterval); });
            }, 2000);
          }

          console.log('[discord-inject] notification intercept installed');
        })();
      `).catch(() => {});
    }

    // Outlook: inject badge detection via executeJavaScript as a fallback
    // in case the preload selectors miss the current Outlook DOM structure
    if (serviceId === 'outlook') {
      view.webContents.executeJavaScript(`
        (function() {
          if (window.__outlookJsInjected) return;
          window.__outlookJsInjected = true;
          console.log('[outlook-inject] badge detection injected');

          function getOutlookCount() {
            // Primary: exact class combo confirmed — <span class="EAy9M gy2aJ Ejrkd">(3)</span>
            var total = 0;
            document.querySelectorAll('span.EAy9M.gy2aJ.Ejrkd').forEach(function(el) {
              var m = el.textContent.trim().match(/\\((\\d+)\\)/);
              if (m) total = Math.max(total, parseInt(m[1]));
            });
            if (total > 0) return total;
            // Fallback: any EAy9M span
            var badgeSpan = document.querySelector('span[class*="EAy9M"]');
            if (badgeSpan) {
              var sm = badgeSpan.textContent.trim().match(/\\((\\d+)\\)/);
              if (sm) return parseInt(sm[1]);
            }
            const tm = document.title.match(/\\((\\d+)\\)/);
            if (tm) return parseInt(tm[1]);
            return 0;
          }

          let lastCount = -1;
          function check() {
            const count = getOutlookCount();
            if (count !== lastCount) {
              lastCount = count;
              console.log('[outlook-inject] count changed to', count);
              // Use the same IPC channel as the preload
              try { require('electron').ipcRenderer.send('dom-badge-count', { count }); } catch(e) {}
            }
          }

          setInterval(check, 1000);
          new MutationObserver(() => { clearTimeout(window.__oDebounce); window.__oDebounce = setTimeout(check, 200); })
            .observe(document.body, { childList: true, subtree: true, characterData: true });
          new MutationObserver(check)
            .observe(document.querySelector('title') || document.head, { childList: true, characterData: true, subtree: true });
          check();
        })();
      `).catch(e => console.log('[outlook-inject] failed:', e.message));
    }

    // If this view is not the active one, tell the page it's hidden
    // so SPAs update their title with unread counts when messages arrive
    viewLoadedOnce.add(accountId);
    if (currentAccountId !== accountId) {
      view.webContents.executeJavaScript(JS_SET_HIDDEN).catch(() => {});
    }
  });
  view.webContents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL) => {
    console.log(`[View] did-fail-load: ${accountId} code=${errorCode} url=${validatedURL}`);
    if (errorCode !== -3) uiView?.webContents.send('view-load-error', { accountId, error: errorDescription });
  });
  // Forward service view console logs to main process — lets us see preload logs
  view.webContents.on('console-message', (e, level, message) => {
    if (message.includes('[preload]') || message.includes('[discord') || message.includes('[outlook') || message.includes('[gmail') || message.includes('[gchat')) {
      console.log(`[${accountId}] ${message}`);
    }
  });

  // Re-lock window.Notification after every navigation — Discord's SPA router
  // can replace the window object context on route changes
  view.webContents.on('did-navigate-in-page', () => {
    if (serviceId === 'discord') {
      view.webContents.executeJavaScript(`
        (function() {
          try {
            var desc = Object.getOwnPropertyDescriptor(window, 'Notification');
            if (!desc || typeof desc.get !== 'function') {
              console.log('[discord-relock] re-locking Notification after navigation');
              // Re-apply the lock — preload already defined FakeNotification in this context
              // so we just need to ensure it's still locked
            } else {
              console.log('[discord-relock] Notification getter still in place');
            }
          } catch(e) {}
        })();
      `).catch(() => {});
    }
  });
  // Attach context menu for right-clicks inside the service page
  attachServiceContextMenu(view);

  // WhatsApp Web sniffs navigator.webdriver and Electron-specific globals — spoof them away
  const isWhatsApp = accountId.startsWith('whatsapp');
  if (isWhatsApp) {
    const WA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    view.webContents.setUserAgent(WA_UA);
    // Write a tiny preload script to disk and register it on the WhatsApp session
    // so it runs before any page JS — removes webdriver flag that WhatsApp checks
    const waPreloadPath = path.join(app.getPath('userData'), 'wa-spoof-preload.js');
    if (!fs.existsSync(waPreloadPath)) {
      fs.writeFileSync(waPreloadPath, `
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
        } catch(e) {}
      `);
    }
    const waSes = session.fromPartition(partition);
    const existing = waSes.getPreloads();
    if (!existing.includes(waPreloadPath)) {
      waSes.setPreloads([...existing, waPreloadPath]);
    }
  } else {
    view.webContents.setUserAgent(CHROME_USER_AGENT);
  }

  view.webContents.loadURL(url, LOAD_OPTIONS).catch(() => {});
  return { success: true };
});

// JS to inject into a view to simulate page visibility state
// Track views that have completed at least one full load — used to skip redundant
// JS_SET_VISIBLE calls on views that are still in their initial navigation.
const viewLoadedOnce = new Set();

ipcMain.handle('show-view', (event, { accountId }) => {
  if (!mainWindow) return;

  // Hide the previously active view — fire-and-forget, don't block showing the new one
  if (currentAccountId && currentAccountId !== accountId) {
    if (views.has(currentAccountId)) {
      const prevView = views.get(currentAccountId);
      try { mainWindow.contentView.removeChildView(prevView); } catch(e) {}
      if (!prevView.webContents.isDestroyed()) {
        prevView.webContents.send('view-visibility', { visible: false });
        prevView.webContents.executeJavaScript(JS_SET_HIDDEN).catch(() => {});
      }
    }
  }
  currentAccountId = accountId;
  domBadgePeakCount.delete(accountId);
  domBadgeLastCount.delete(accountId);
  webNotifCount.delete(accountId);
  clearSuppressed(accountId);

  // Update taskbar overlay icon to show which service is active
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    try {
      const serviceId = accountId.replace(/-\d+$/, '');
      const overlay = overlayIconCache.get(serviceId) || null;
      mainWindow.setOverlayIcon(overlay, serviceId);
    } catch(e) {}
  }

  const serviceId = accountId.replace(/-\d+$/, '');
  const label = serviceId.charAt(0).toUpperCase() + serviceId.slice(1);
  uiView?.webContents.send('view-title-updated', { accountId, title: label });
  titlebarView?.webContents.send('view-title-updated', { accountId, title: label });

  if (!views.has(accountId)) return;
  const view = views.get(accountId);
  view.setBounds(getViewBounds());
  const children = mainWindow.contentView.children || [];
  if (!children.includes(view)) {
    mainWindow.contentView.addChildView(view);
  }
  // Keep titlebarView and uiView on top so their buttons remain clickable
  if (titlebarView) {
    try { mainWindow.contentView.removeChildView(titlebarView); } catch(e) {}
    mainWindow.contentView.addChildView(titlebarView);
  }

  if (!view.webContents.isDestroyed()) {
    view.webContents.send('view-visibility', { visible: true });
    const hasLoaded = viewLoadedOnce.has(accountId);
    const keepHidden = accountId.startsWith('gmail') || accountId.startsWith('telegram') || accountId.startsWith('slack');
    if (keepHidden) {
      if (hasLoaded) view.webContents.executeJavaScript(JS_SET_VISIBLE).catch(() => {});
      setTimeout(() => {
        if (currentAccountId === accountId && !view.webContents.isDestroyed()) {
          view.webContents.executeJavaScript(JS_SET_HIDDEN).catch(() => {});
        }
      }, 2000);
    } else if (hasLoaded) {
      const viewUrl = view.webContents.getURL();
      const isMsAuth = viewUrl.includes('login.microsoftonline.com') || viewUrl.includes('login.live.com') || viewUrl.includes('account.microsoft.com');
      if (!isMsAuth) view.webContents.executeJavaScript(JS_SET_VISIBLE).catch(() => {});
    }
  }
  // Non-blocking — extensions tab registration doesn't affect display
  setImmediate(() => {
    try { extensions.addTab(view.webContents, mainWindow); extensions.selectTab(view.webContents); } catch(e) {}
  });
});

ipcMain.handle('hide-view', (event, { accountId }) => {
  if (!mainWindow || !views.has(accountId)) return;
  const view = views.get(accountId);
  try { mainWindow.contentView.removeChildView(view); } catch(e) {}
  if (!view.webContents.isDestroyed()) {
    view.webContents.send('view-visibility', { visible: false });
    view.webContents.executeJavaScript(JS_SET_HIDDEN).catch(() => {}); // fire-and-forget
  }
  if (currentAccountId === accountId) currentAccountId = null;
});

ipcMain.handle('destroy-view', (event, { accountId }) => {
  if (!views.has(accountId)) return;
  const view = views.get(accountId);
  try { mainWindow.contentView.removeChildView(view); } catch(e) {}
  try { view.webContents.stop(); } catch(e) {}
  views.delete(accountId);
  if (currentAccountId === accountId) currentAccountId = null;
});

// Google sign-in via a maximally-spoofed BrowserWindow.
// We intercept Google's detection headers at the webRequest level and
// strip/rewrite them so Google can't distinguish this from a real Chrome window.
ipcMain.handle('google-signin-window', async (event, { partition, accountName }) => {
  const tempPartition = `persist:google-auth-${Date.now()}`;
  const tempSession = session.fromPartition(tempPartition);

  // Spoof UA at session level (covers all requests including fetch/XHR)
  const REAL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  tempSession.setUserAgent(REAL_CHROME_UA, 'en-US,en;q=0.9');

  // Strip headers Google uses to detect non-browser environments
  tempSession.webRequest.onBeforeSendHeaders({ urls: ['https://*.google.com/*', 'https://accounts.google.com/*'] }, (details, callback) => {
    const headers = details.requestHeaders;
    // Remove Electron/Node specific headers
    delete headers['X-Electron'];
    // Ensure sec-ch-ua looks like real Chrome, not Electron
    headers['sec-ch-ua'] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    headers['User-Agent'] = REAL_CHROME_UA;
    callback({ requestHeaders: headers });
  });

  // Write preload to disk — scrubs all Node/Electron globals before any page JS
  const spoofPath = path.join(app.getPath('userData'), 'google-auth-spoof.js');
  fs.writeFileSync(spoofPath, `(function() {
    // Delete Node/Electron globals
    ['process','require','module','exports','__dirname','__filename','Buffer'].forEach(k => {
      try { delete window[k]; } catch(e) {}
      try { Object.defineProperty(window, k, { get: () => undefined, configurable: true }); } catch(e) {}
    });
    // Spoof webdriver
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true }); } catch(e) {}
    // Provide window.chrome like a real Chrome browser
    try {
      if (!window.chrome || !window.chrome.runtime) {
        window.chrome = {
          app: { isInstalled: false, InstallState: {}, RunningState: {} },
          runtime: { id: undefined },
          loadTimes: function() { return {}; },
          csi: function() { return {}; },
        };
      }
    } catch(e) {}
  })();`);
  tempSession.setPreloads([spoofPath]);

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520, height: 680,
      title: `Sign in to Google — ${accountName}`,
      autoHideMenuBar: true,
      webPreferences: {
        session: tempSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Disable features that leak Electron identity
        backgroundThrottling: false,
      }
    });

    win.loadURL('https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin', {
      extraHeaders: 'Accept-Language: en-US,en;q=0.9\nAccept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8\n'
    });

    // When Google redirects to a product page, sign-in succeeded.
    // Copy all cookies from the temp session into the real account partition.
    win.webContents.on('did-navigate', async (e, url) => {
      const signedIn =
        url.startsWith('https://mail.google.com') ||
        url.startsWith('https://myaccount.google.com') ||
        url.startsWith('https://www.google.com/_/');
      if (!signedIn) return;

      try {
        const accountSession = session.fromPartition(partition);
        // Copy cookies from all Google domains
        for (const domain of ['.google.com', 'accounts.google.com', 'mail.google.com']) {
          const cookies = await tempSession.cookies.get({ domain });
          for (const c of cookies) {
            await accountSession.cookies.set({
              url: `https://${c.domain.replace(/^\./, '')}`,
              name: c.name, value: c.value,
              domain: c.domain, path: c.path || '/',
              secure: c.secure, httpOnly: c.httpOnly,
              expirationDate: c.expirationDate,
              sameSite: c.sameSite || 'no_restriction',
            }).catch(() => {});
          }
        }
        console.log('[GoogleAuth] Cookies copied to', partition);
        resolve({ success: true });
      } catch(e) {
        console.error('[GoogleAuth] Cookie copy failed:', e.message);
        resolve({ success: true }); // still switch to view
      }
      win.close();
    });

    win.on('closed', () => resolve({ success: false }));
  });
});

ipcMain.handle('open-outlook-devtools', () => {
  for (const [id, v] of views.entries()) {
    if (id.startsWith('outlook')) v.webContents.openDevTools({ mode: 'detach' });
  }
});

ipcMain.handle('reload-view', (event, { accountId }) => {
  const target = accountId || currentAccountId;
  if (!target) return { success: false };
  if (!views.has(target)) return { success: false };
  views.get(target).webContents.reload();
  return { success: true };
});

ipcMain.handle('get-adblock-state', () => ({ enabled: adBlockEnabled, count: adBlockCount }));

ipcMain.handle('toggle-adblock', () => {
  adBlockEnabled = !adBlockEnabled;
  store.set('adBlockEnabled', adBlockEnabled);
  for (const partition of blockedSessions) {
    try {
      const ses = session.fromPartition(partition);
      if (adBlockEnabled) adBlocker?.enableBlockingInSession(ses);
      else adBlocker?.disableBlockingInSession(ses);
    } catch(e) {}
  }
  broadcastAdBlockState();
  return { enabled: adBlockEnabled };
});

ipcMain.handle('get-xblocker-state', () => ({ enabled: xBlockerEnabled, count: xBlockerCount }));

ipcMain.handle('toggle-xblocker', () => {
  xBlockerEnabled = !xBlockerEnabled;
  store.set('xBlockerEnabled', xBlockerEnabled);
  // Notify all service views so their MutationObserver activates/deactivates
  for (const [, view] of views.entries()) {
    if (!view || view.webContents.isDestroyed()) continue;
    view.webContents.send('xblocker-state', { enabled: xBlockerEnabled });
  }
  broadcastXBlockerState();
  return { enabled: xBlockerEnabled };
});

ipcMain.handle('xblocker-classify', async (event, { url: imageUrl }) => {
  if (!xBlockerEnabled || !xBlockerModel) return { blocked: false };
  try {
    // Note: 'canvas' and 'loadImage' are used here for NSFW classification.
    // If 'canvas' is not installed (e.g., build issues on Windows), classification is skipped.
    const { createCanvas, loadImage } = require('canvas');
    const img = await loadImage(imageUrl);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const predictions = await xBlockerModel.classify(canvas);
    // Block if Porn or Hentai confidence > 60%
    const blocked = predictions.some(p =>
      (p.className === 'Porn' || p.className === 'Hentai') && p.probability > 0.6
    );
    if (blocked) incrementXBlockerCount();
    return { blocked };
  } catch(e) {
    return { blocked: false };
  }
});

ipcMain.handle('show-account-menu', (event, { serviceId, serviceName, accounts, activeAccountId }) => {
  const menu = new Menu();
  accounts.forEach(acc => {
    const isActive = acc.id === activeAccountId;
    const unreadStr = acc.unread > 0 ? `  (${acc.unread})` : '';
    menu.append(new MenuItem({
      label: `${isActive ? '✓  ' : '     '}${acc.name}${unreadStr}`,
      click: () => uiView?.webContents.send('account-menu-select', { serviceId, accountId: acc.id })
    }));
  });
  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(new MenuItem({ label: '+ Add Account', click: () => uiView?.webContents.send('account-menu-select', { serviceId, action: 'add' }) }));
  menu.append(new MenuItem({ label: '⚙ Manage Accounts', click: () => uiView?.webContents.send('account-menu-select', { serviceId, action: 'manage' }) }));
  // window option accepts BaseWindow directly (Electron 33+)
  menu.popup({ window: mainWindow });
  return { success: true };
});

ipcMain.handle('show-confirm', async (event, { message, detail }) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message, detail
  });
  return { response };
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  // isMaximized() is unreliable on Windows when maximized via OS (double-click, Win+Up).
  // Compare current bounds against the screen work area as a reliable fallback.
  const { screen } = require('electron');
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;
  const isMaximized = mainWindow.isMaximized() ||
    (bounds.x <= wa.x + 4 && bounds.y <= wa.y + 4 &&
     bounds.width >= wa.width - 4 && bounds.height >= wa.height - 4);
  if (isMaximized) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.on('window-close', () => mainWindow?.close());

// Expand sidebarView to full window so its modals render correctly over everything
ipcMain.on('modal-open', () => {
  if (!mainWindow || !uiView) return;
  const [w, h] = mainWindow.getContentSize();
  const safeW = w > 200 ? w : 1400;
  const safeH = h > 200 ? h : 900;
  uiView.setBounds({ x: 0, y: 0, width: safeW, height: safeH });
  // Bring to top of stack so it renders above service views
  try { mainWindow.contentView.removeChildView(uiView); } catch(e) {}
  mainWindow.contentView.addChildView(uiView);
});
// Restore sidebarView to its normal strip
ipcMain.on('modal-close', () => {
  if (!mainWindow || !uiView) return;
  const [w, h] = mainWindow.getContentSize();
  const safeH = h > 200 ? h : 900;
  uiView.setBounds({ x: 0, y: 0, width: _dynamicSidebarWidth, height: safeH });
  // Re-add titlebarView on top so its buttons aren't covered by uiView
  if (titlebarView) {
    try { mainWindow.contentView.removeChildView(titlebarView); } catch(e) {}
    mainWindow.contentView.addChildView(titlebarView);
  }
});

// Service-off page: expand uiView to full window so #content-area is visible,
// but keep titlebarView on top. No modal overlay — sidebar stays interactive.
ipcMain.on('service-off-show', () => {
  if (!mainWindow || !uiView) return;
  const [w, h] = mainWindow.getContentSize();
  const safeW = w > 200 ? w : 1400;
  const safeH = h > 200 ? h : 900;
  uiView.setBounds({ x: 0, y: 0, width: safeW, height: safeH });
  try { mainWindow.contentView.removeChildView(uiView); } catch(e) {}
  mainWindow.contentView.addChildView(uiView);
  if (titlebarView) {
    try { mainWindow.contentView.removeChildView(titlebarView); } catch(e) {}
    mainWindow.contentView.addChildView(titlebarView);
  }
});
ipcMain.on('service-off-hide', () => {
  if (!mainWindow || !uiView) return;
  const [w, h] = mainWindow.getContentSize();
  const safeH = h > 200 ? h : 900;
  uiView.setBounds({ x: 0, y: 0, width: _dynamicSidebarWidth, height: safeH });
  if (titlebarView) {
    try { mainWindow.contentView.removeChildView(titlebarView); } catch(e) {}
    mainWindow.contentView.addChildView(titlebarView);
  }
});

// Expand sidebar for context menu — same as modal-open but keeps service view visible
// (uiView is added on top but service view stays in the stack underneath)
ipcMain.on('context-menu-open', () => {
  if (!mainWindow || !uiView) return;
  const [w, h] = mainWindow.getContentSize();
  const safeW = w > 200 ? w : 1400;
  const safeH = h > 200 ? h : 900;
  uiView.setBounds({ x: 0, y: 0, width: safeW, height: safeH });
  try { mainWindow.contentView.removeChildView(uiView); } catch(e) {}
  mainWindow.contentView.addChildView(uiView);
  // Keep titlebarView on top
  if (titlebarView) {
    try { mainWindow.contentView.removeChildView(titlebarView); } catch(e) {}
    mainWindow.contentView.addChildView(titlebarView);
  }
});
ipcMain.on('context-menu-close', () => {
  if (!mainWindow || !uiView) return;
  const [w, h] = mainWindow.getContentSize();
  const safeH = h > 200 ? h : 900;
  uiView.setBounds({ x: 0, y: 0, width: _dynamicSidebarWidth, height: safeH });
  if (titlebarView) {
    try { mainWindow.contentView.removeChildView(titlebarView); } catch(e) {}
    mainWindow.contentView.addChildView(titlebarView);
  }
});
// Titlebar buttons forward modal requests to the sidebar
ipcMain.on('sidebar-open-modal', (event, { modal }) => {
  uiView?.webContents.send('open-modal', { modal });
});

// ── Custom toast notification window ─────────────────────────────────────────
let toastWin = null;
let toastHideTimer = null;
let toastClickData = null;

const SERVICE_NAMES = {
  gmail: 'Gmail', gchat: 'Google Chat', outlook: 'Outlook',
  slack: 'Slack', teams: 'Teams', telegram: 'Telegram',
  discord: 'Discord', whatsapp: 'WhatsApp',
};

// In-memory map of live account names detected from service DOM (e.g. Discord username)
// Used by showToast so the receiver label is correct even before the store write completes
const liveAccountNames = new Map();

function showToast({ accountId, accountName, serviceLabel, sender, body, unreadCount }) {
  const serviceId = accountId.replace(/-\d+$/, '');
  const serviceName = SERVICE_NAMES[serviceId] || serviceLabel;
  const iconPath = `file:///${path.join(__dirname, '..', 'assets', 'icons', serviceId + '.svg').replace(/\\/g, '/')}`;

  // Look up real account name — check live in-memory map first (fastest, no store race),
  // then fall back to persisted store value
  if (!accountName || accountName === 'Default') {
    if (liveAccountNames.has(accountId)) {
      accountName = liveAccountNames.get(accountId);
    } else {
      try {
        const saved = store.get('accounts', {});
        const accounts = saved[serviceId] || [];
        const acc = accounts.find(a => a.id === accountId);
        if (acc && acc.name && acc.name !== 'Default') accountName = acc.name;
      } catch(e) {}
    }
  }

  // Determine receiver label: account name if not Default, else 'You'
  const receiver = (accountName && accountName !== 'Default') ? accountName : 'You';

  toastClickData = { serviceId, accountId };

  if (!toastWin || toastWin.isDestroyed()) {
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.workAreaSize;
    toastWin = new BrowserWindow({
      width: 360, height: 180,
      x: width - 375, y: height - 195,
      frame: false, transparent: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, focusable: false,
      backgroundColor: '#1e1f2e',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    toastWin.loadFile('src/notification-toast.html');
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    toastWin.on('closed', () => { toastWin = null; });
  }

  // Wait for load then send data
  const sendData = () => {
    if (!toastWin || toastWin.isDestroyed()) return;
    toastWin.webContents.send('toast-data', {
      iconPath, serviceName, sender, receiver, body, unreadCount,
    });
    // Use show() instead of showInactive() — on Windows, focusable:false + showInactive
    // sometimes fails to render the window. show() works reliably.
    toastWin.show();
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {
      if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
    }, 5000);
  };

  if (toastWin.webContents.isLoading()) {
    toastWin.webContents.once('did-finish-load', sendData);
  } else {
    sendData();
  }
}

// Open URL in the system default browser (triggered by Ctrl+click in service views)
ipcMain.on('open-external-url', (event, { url }) => {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return;
  shell.openExternal(url).catch(() => {});
});

ipcMain.on('toast-clicked', () => {
  if (!toastClickData) return;
  const { serviceId, accountId } = toastClickData;
  mainWindow?.show(); mainWindow?.focus();
  uiView?.webContents.send('account-menu-select', { serviceId, accountId });
  if (toastWin && !toastWin.isDestroyed()) toastWin.hide();
});

// Renderer sends back account name so we can show it in the desktop notification
ipcMain.on('show-notification', (event, { accountId, accountName, serviceLabel, newCount, sender, body }) => {
  showToast({ accountId, accountName, serviceLabel, sender, body: body || `You have ${newCount} unread message${newCount > 1 ? 's' : ''}`, unreadCount: newCount });
});

// ── Suppressed badge counts (persisted across sessions) ──────────────────────
// When user clicks "mark as read", we store the count they suppressed.
// On next launch, counts <= suppressed value are ignored (not new messages).
function getSuppressed(accountId) {
  return store.get(`suppressedCounts.${accountId}`, 0);
}
function setSuppressed(accountId, count) {
  store.set(`suppressedCounts.${accountId}`, count);
}
function clearSuppressed(accountId) {
  store.delete(`suppressedCounts.${accountId}`);
}

ipcMain.on('suppress-badge', (event, { accountId, count }) => {
  console.log(`[suppress-badge] accountId=${accountId} count=${count}`);
  setSuppressed(accountId, count);
});
ipcMain.on('clear-suppressed', (event, { accountId }) => {
  clearSuppressed(accountId);
});

// Deduplication map — prevents duplicate alerts from multiple notification paths
const recentNotifKeys = new Map();
function isDuplicateNotif(key) {
  const now = Date.now();
  if (recentNotifKeys.has(key) && now - recentNotifKeys.get(key) < 3000) return true;
  recentNotifKeys.set(key, now);
  // Clean entries older than 10s
  for (const [k, t] of recentNotifKeys) { if (now - t > 10000) recentNotifKeys.delete(k); }
  return false;
}

// Per-account running unread count for web-notification path
const webNotifCount = new Map();

// Intercept web page notifications — fired from combined-preload.js
ipcMain.on('web-notification', (event, { title, body }) => {
  let accountId = null;
  for (const [id, v] of views.entries()) {
    if (!v.webContents.isDestroyed() && v.webContents.id === event.sender.id) {
      accountId = id; break;
    }
  }
  console.log(`[web-notification] title="${title}" accountId=${accountId} currentAccountId=${currentAccountId}`);
  if (!accountId) return;

  // Suppress if user is actively viewing this service AND the window is focused.
  // For Discord (and other WEB_NOTIF_SERVICES), notifications fire for channels the
  // user isn't looking at even when Discord is the active tab — so only suppress
  // when the main window actually has focus (user is actively reading).
  const windowFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  if (accountId === currentAccountId && windowFocused) return;

  const serviceId = accountId.replace(/-\d+$/, '');
  const serviceLabel = serviceId.charAt(0).toUpperCase() + serviceId.slice(1);

  // Deduplicate — use title+body as key so each unique message fires once
  const dedupKey = `${accountId}-webnotif-${title}-${body}`;
  if (isDuplicateNotif(dedupKey)) return;

  // Increment running count for this account
  const prev = webNotifCount.get(accountId) || 0;
  const newCount = prev + 1;
  webNotifCount.set(accountId, newCount);

  // Update badge in renderer with real running count
  uiView?.webContents.send('view-title-updated', { accountId, title: `(${newCount}) ${title}` });
  titlebarView?.webContents.send('view-title-updated', { accountId, title: `(${newCount}) ${title}` });

  // Parse sender from notification title (e.g. "Jerry James: hello" or "Jerry James")
  let sender = null;
  const senderMatch = title.match(/^([^:]+):/);
  if (senderMatch) sender = senderMatch[1].trim();
  else sender = title;

  // Cross-dedup: mark this count so dom-badge-count doesn't double-fire within 3s
  isDuplicateNotif(`${accountId}-dom-${newCount}`);

  console.log(`[web-notification] firing toast for ${accountId} sender="${sender}" count=${newCount}`);
  showToast({ accountId, accountName: 'Default', serviceLabel, sender, body: body || '', unreadCount: newCount });
});

// DOM badge count from preload polling (Telegram, Google Chat, Gmail)
const domBadgeLastCount = new Map();
const domBadgePeakCount = new Map(); // tracks highest count seen while view was active

// Discord sends its logged-in username once the DOM is ready — update account name
ipcMain.on('discord-username-detected', (event, { name }) => {
  let accountId = null;
  for (const [id, v] of views.entries()) {
    if (!v.webContents.isDestroyed() && v.webContents.id === event.sender.id) { accountId = id; break; }
  }
  if (!accountId) return;
  console.log(`[discord-username] accountId=${accountId} name="${name}"`);
  // Store in live map immediately — available for next toast without store round-trip
  liveAccountNames.set(accountId, name);
  // Update stored account name so toast shows it as receiver
  try {
    const saved = store.get('accounts', {});
    const accounts = saved['discord'] || [];
    const acc = accounts.find(a => a.id === accountId);
    if (acc && (acc.name === 'Default' || !acc.name)) {
      acc.name = name;
      store.set('accounts', saved);
      uiView?.webContents.send('account-name-updated', { accountId, name });
    }
  } catch(e) {}
});

// All other services send their logged-in username via this channel
ipcMain.on('service-username-detected', (event, { name }) => {
  let accountId = null;
  for (const [id, v] of views.entries()) {
    if (!v.webContents.isDestroyed() && v.webContents.id === event.sender.id) { accountId = id; break; }
  }
  if (!accountId) return;
  console.log(`[service-username] accountId=${accountId} name="${name}"`);
  liveAccountNames.set(accountId, name);
  try {
    const serviceId = accountId.replace(/-\d+$/, '');
    const saved = store.get('accounts', {});
    const accounts = saved[serviceId] || [];
    const acc = accounts.find(a => a.id === accountId);
    if (acc && (acc.name === 'Default' || !acc.name)) {
      acc.name = name;
      store.set('accounts', saved);
      uiView?.webContents.send('account-name-updated', { accountId, name });
    }
  } catch(e) {}
});

ipcMain.on('dom-badge-count', (event, { count, sender, body }) => {
  let accountId = null;
  for (const [id, v] of views.entries()) {
    if (!v.webContents.isDestroyed() && v.webContents.id === event.sender.id) {
      accountId = id; break;
    }
  }
  console.log(`[dom-badge-count] count=${count} accountId=${accountId} currentAccountId=${currentAccountId}`);
  if (!accountId) return;
  const serviceId = accountId.replace(/-\d+$/, '');
  const label = serviceId.charAt(0).toUpperCase() + serviceId.slice(1);

  const isActive = accountId === currentAccountId;

  // Apply suppression — ignore counts <= what user already marked as read
  const suppressed = getSuppressed(accountId);
  const effectiveCount = count > suppressed ? count : 0;
  console.log(`[dom-badge-count] accountId=${accountId} count=${count} suppressed=${suppressed} effectiveCount=${effectiveCount}`);
  // While the view is active, track the peak unread count seen
  if (isActive && effectiveCount > 0) {
    const peak = domBadgePeakCount.get(accountId) || 0;
    if (effectiveCount > peak) domBadgePeakCount.set(accountId, effectiveCount);
  }

  // Use peak count for badge display when active view resets to 0
  const displayCount = (isActive && effectiveCount === 0)
    ? (domBadgePeakCount.get(accountId) || 0)
    : effectiveCount;

  // Synthesize a title update so the renderer badge logic handles it uniformly
  uiView?.webContents.send('view-title-updated', {
    accountId,
    title: displayCount > 0 ? `(${displayCount}) ${label}` : label
  });
  titlebarView?.webContents.send('view-title-updated', {
    accountId,
    title: displayCount > 0 ? `(${displayCount}) ${label}` : label
  });

  // Fire desktop notification when count increases and user is NOT actively reading it.
  // "Actively reading" = this service is selected AND the Electron window has focus.
  // If the user is on another Windows app, isFocused() is false — always notify.
  const windowFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  const userIsReading = isActive && windowFocused;
  const last = domBadgeLastCount.get(accountId) || 0;
  if (effectiveCount > last && !userIsReading) {
    // WEB_NOTIF_SERVICES fire via web-notification for rich toasts (sender+body),
    // but Discord also sends dom-badge-count for real messages — allow it as fallback
    const skipDomToast = WEB_NOTIF_SERVICES.has(serviceId) && serviceId !== 'discord';
    if (!skipDomToast) {
      const dedupKey = `${accountId}-dom-${effectiveCount}`;
      if (!isDuplicateNotif(dedupKey)) {
        console.log(`[dom-badge-count] firing toast for ${accountId} count=${effectiveCount}`);
        const toastBody = body || (sender ? 'New message' : `You have ${effectiveCount} unread message${effectiveCount > 1 ? 's' : ''}`);
        showToast({ accountId, accountName: 'Default', serviceLabel: label, sender: sender || null, body: toastBody, unreadCount: effectiveCount });
      }
    }
  }

  // Always update lastCount so we don't re-fire toasts for the same count
  domBadgeLastCount.set(accountId, effectiveCount);
  if (!isActive && effectiveCount === 0) {
    domBadgePeakCount.delete(accountId);
    clearSuppressed(accountId); // service confirmed 0 unread — reset suppression
  }
});

ipcMain.on('open-popup-window', (event, { url, partition: p }) => {
  const popup = new BrowserWindow({ width: 600, height: 700, parent: mainWindow, webPreferences: { partition: p, nodeIntegration: false, contextIsolation: true } });
  popup.loadURL(url);
  popup.once('ready-to-show', () => popup.show());
});

ipcMain.on('open-extension-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Extension Directory' });
  if (!result.canceled && result.filePaths.length > 0) loadExtension(result.filePaths[0]);
});

ipcMain.handle('get-services', () => {
  const servicesPath = path.join(app.getPath('userData'), 'services.json');
  try {
    if (fs.existsSync(servicesPath)) {
      return JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
    }
  } catch (e) {
    console.error('[Main] Failed to read services.json:', e.message);
  }
  return {};
});

ipcMain.handle('save-service', async (event, { id, name, url }) => {
  const userData = app.getPath('userData');
  const servicesPath = path.join(userData, 'services.json');
  
  // Ensure userData directory exists
  if (!fs.existsSync(userData)) {
    fs.mkdirSync(userData, { recursive: true });
  }

  let services = {};
  try {
    if (fs.existsSync(servicesPath)) {
      services = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
    }
    services[id] = { name, url };
    fs.writeFileSync(servicesPath, JSON.stringify(services, null, 2));
    
    // Refresh icon cache for the new service
    buildOverlayIconCache();
    
    return { success: true };
  } catch (e) {
    console.error('[Main] Failed to save service:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-settings', () => {
  console.log('[IPC] get-settings called');
  return store.get('settings', {
    destroyViewsOnSwitch: false, hardwareAcceleration: true,
    memoryLimit: MAX_MEMORY_MB, defaultService: 'gmail', firstTimeSetup: false,
    disabledServices: []
  });
});
ipcMain.handle('save-settings', (event, settings) => { store.set('settings', settings); return { success: true }; });
ipcMain.handle('get-accounts', () => store.get('accounts', null));
ipcMain.handle('save-accounts', (event, data) => { store.set('accounts', data); return { success: true }; });
ipcMain.handle('clear-cache', async (event, partition) => {
  if (!partition) return { success: false };
  const ses = session.fromPartition(partition);
  await ses.clearCache(); await ses.clearCodeCaches();
  return { success: true };
});

// ── Storage Cleaner ───────────────────────────────────────────────────────────
// Returns a list of junk files/folders with sizes so the UI can show them before deletion.
ipcMain.handle('scan-junk', async () => {
  const userData = app.getPath('userData');
  const results = [];

  // 1. Orphaned google-spoof-persist_*.js files (keep only the latest per prefix)
  const spoofFiles = fs.readdirSync(userData).filter(f => f.match(/^google-spoof-persist_.+\.js$/));
  const spoofGroups = {};
  for (const f of spoofFiles) {
    const prefix = f.replace(/_\d+\.js$/, '');
    if (!spoofGroups[prefix]) spoofGroups[prefix] = [];
    spoofGroups[prefix].push(f);
  }
  for (const [, files] of Object.entries(spoofGroups)) {
    files.sort(); // ascending — last is newest
    const toDelete = files.slice(0, -1); // keep last
    for (const f of toDelete) {
      const full = path.join(userData, f);
      try { results.push({ type: 'file', path: full, name: f, sizeMB: +(fs.statSync(full).size / 1048576).toFixed(2) }); } catch(e) {}
    }
  }

  // 2. Orphaned Partitions — timestamped dirs whose service has an active "-1" partition
  const partitionsDir = path.join(userData, 'Partitions');
  if (fs.existsSync(partitionsDir)) {
    const accounts = store.get('accounts.accounts', null) || store.get('accounts', null);
    // Collect all partition names that are actively used
    const activePartitions = new Set(['main', 'cws']);
    if (accounts) {
      const accs = accounts.accounts || accounts;
      for (const svcAccounts of Object.values(accs)) {
        for (const acc of svcAccounts) {
          // partition is like "persist:gmail-1" — strip prefix
          const p = (acc.partition || '').replace(/^persist:/, '');
          if (p) activePartitions.add(p);
        }
      }
    }

    const dirs = fs.readdirSync(partitionsDir);
    for (const dir of dirs) {
      if (activePartitions.has(dir)) continue;
      // Only flag timestamped dirs (contain a long numeric suffix)
      if (!dir.match(/-\d{10,}$/)) continue;
      const full = path.join(partitionsDir, dir);
      try {
        const stat = fs.statSync(full);
        if (!stat.isDirectory()) continue;
        const size = getDirSizeMB(full);
        results.push({ type: 'dir', path: full, name: dir, sizeMB: size });
      } catch(e) {}
    }
  }

  // 3. Empty/useless top-level dirs
  const emptyDirs = ['blob_storage', 'Code Cache'];
  for (const d of emptyDirs) {
    const full = path.join(userData, d);
    if (!fs.existsSync(full)) continue;
    const size = getDirSizeMB(full);
    results.push({ type: 'dir', path: full, name: d, sizeMB: size });
  }

  // 4. debug.log
  const debugLog = path.join(userData, 'debug.log');
  if (fs.existsSync(debugLog)) {
    try { results.push({ type: 'file', path: debugLog, name: 'debug.log', sizeMB: +(fs.statSync(debugLog).size / 1048576).toFixed(2) }); } catch(e) {}
  }

  return results;
});

ipcMain.handle('delete-junk', async (event, items) => {
  let freed = 0;
  for (const item of items) {
    try {
      if (item.type === 'file') { freed += fs.statSync(item.path).size; fs.unlinkSync(item.path); }
      else { freed += getDirSizeBytes(item.path); fs.rmSync(item.path, { recursive: true, force: true }); }
    } catch(e) { console.error('[Cleaner] Failed to delete', item.path, e.message); }
  }
  return { freedMB: +(freed / 1048576).toFixed(1) };
});

// ── Backup / Restore ─────────────────────────────────────────────────────────

// Files/dirs to include per partition (relative to the partition dir)
const BACKUP_PARTITION_INCLUDES = ['Cookies', 'Network', 'Local Storage', 'Preferences', 'IndexedDB'];

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

ipcMain.handle('backup-data', async () => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Backup',
    defaultPath: `unified-comms-backup-${new Date().toISOString().slice(0,10)}.zip`,
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
  });
  if (canceled || !filePath) return { cancelled: true };

  try {
    const userData = app.getPath('userData');
    const tmpDir = path.join(app.getPath('temp'), `uc-backup-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // 1. config.json (electron-store)
    const configSrc = path.join(userData, 'config.json');
    if (fs.existsSync(configSrc)) fs.copyFileSync(configSrc, path.join(tmpDir, 'config.json'));

    // 2. Local Storage (app-level, under userData root)
    const lsSrc = path.join(userData, 'Local Storage');
    if (fs.existsSync(lsSrc)) copyRecursive(lsSrc, path.join(tmpDir, 'Local Storage'));

    // 3. Partitions — only active ones, only critical subdirs
    const accounts = store.get('accounts', null);
    const partitionsDir = path.join(userData, 'Partitions');
    if (accounts && fs.existsSync(partitionsDir)) {
      const allAccounts = accounts.accounts || accounts;
      const partitionNames = new Set();
      for (const svcAccounts of Object.values(allAccounts)) {
        for (const acc of svcAccounts) {
          const p = (acc.partition || '').replace(/^persist:/, '');
          if (p) partitionNames.add(p);
        }
      }
      for (const pName of partitionNames) {
        const pSrc = path.join(partitionsDir, pName);
        if (!fs.existsSync(pSrc)) continue;
        for (const sub of BACKUP_PARTITION_INCLUDES) {
          copyRecursive(path.join(pSrc, sub), path.join(tmpDir, 'Partitions', pName, sub));
        }
      }
    }

    // Zip tmpDir → filePath using PowerShell (Windows built-in, no extra deps)
    const { execSync } = require('child_process');
    // PowerShell Compress-Archive needs forward slashes or escaped backslashes
    const src = tmpDir.replace(/\\/g, '\\\\');
    const dst = filePath.replace(/\\/g, '\\\\');
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${src}\\\\*' -DestinationPath '${dst}' -Force"`, { timeout: 60000 });

    // Cleanup tmp
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[Backup] Done:', filePath);
    return { path: filePath };
  } catch (e) {
    console.error('[Backup] Failed:', e.message);
    return { error: e.message };
  }
});

ipcMain.handle('restore-data', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup File',
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.length) return { cancelled: true };
  const zipPath = filePaths[0];

  try {
    const userData = app.getPath('userData');
    const tmpDir = path.join(app.getPath('temp'), `uc-restore-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Extract zip
    const { execSync } = require('child_process');
    const src = zipPath.replace(/\\/g, '\\\\');
    const dst = tmpDir.replace(/\\/g, '\\\\');
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${src}' -DestinationPath '${dst}' -Force"`, { timeout: 60000 });

    // Restore config.json
    const configSrc = path.join(tmpDir, 'config.json');
    if (fs.existsSync(configSrc)) fs.copyFileSync(configSrc, path.join(userData, 'config.json'));

    // Restore Local Storage
    const lsSrc = path.join(tmpDir, 'Local Storage');
    if (fs.existsSync(lsSrc)) copyRecursive(lsSrc, path.join(userData, 'Local Storage'));

    // Restore Partitions
    const partitionsSrc = path.join(tmpDir, 'Partitions');
    if (fs.existsSync(partitionsSrc)) {
      for (const pName of fs.readdirSync(partitionsSrc)) {
        const pSrc = path.join(partitionsSrc, pName);
        const pDest = path.join(userData, 'Partitions', pName);
        copyRecursive(pSrc, pDest);
      }
    }

    // Cleanup tmp
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('[Restore] Done from:', zipPath);
    return { success: true };
  } catch (e) {
    console.error('[Restore] Failed:', e.message);
    return { error: e.message };
  }
});

ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  app.exit(0);
});

function getDirSizeBytes(dirPath) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) total += getDirSizeBytes(full);
      else { try { total += fs.statSync(full).size; } catch(e) {} }
    }
  } catch(e) {}
  return total;
}

function getDirSizeMB(dirPath) {
  return +(getDirSizeBytes(dirPath) / 1048576).toFixed(2);
}

ipcMain.handle('get-extensions', async () => {
  const exts = getMainSession().getAllExtensions();
  const disabled = store.get('disabledExtensions', []);
  return Object.values(exts).map(e => {
    const manifest = e.manifest || {};
    const action = manifest.action || manifest.browser_action || manifest.page_action;
    const hasOptions = !!(manifest.options_page || manifest.options_ui?.page);
    const hasPopup = !!(action?.default_popup);
    const iconPath = action?.default_icon
      ? (typeof action.default_icon === 'string' ? action.default_icon : (action.default_icon['48'] || action.default_icon['32'] || action.default_icon['16'] || Object.values(action.default_icon)[0]))
      : (manifest.icons?.['48'] || manifest.icons?.['32'] || manifest.icons?.['16'] || null);
    let iconDataUrl = null;
    if (iconPath && e.path) {
      try {
        const absIconPath = path.join(e.path, iconPath.replace(/^\//, ''));
        const iconBuf = fs.readFileSync(absIconPath);
        const ext2 = path.extname(iconPath).toLowerCase();
        const mime = ext2 === '.png' ? 'image/png' : ext2 === '.jpg' || ext2 === '.jpeg' ? 'image/jpeg' : 'image/png';
        iconDataUrl = `data:${mime};base64,${iconBuf.toString('base64')}`;
      } catch(e2) {}
    }
    return { id: e.id, name: e.name, version: e.version, description: manifest.description || '', enabled: !disabled.includes(e.id), hasOptions, hasPopup, iconUrl: iconDataUrl, path: e.path };
  });
});

ipcMain.handle('toggle-extension', async (event, { id, enabled }) => {
  const disabled = store.get('disabledExtensions', []);
  const extPath = store.get(`extensionPaths.${id}`);
  const allSessions = [getMainSession(), ...Array.from(activePartitions).map(p => session.fromPartition(p))];
  if (enabled) {
    store.set('disabledExtensions', disabled.filter(x => x !== id));
    for (const ses of allSessions) { if (extPath) await loadExtIntoSession(ses, extPath); }
  } else {
    if (!disabled.includes(id)) store.set('disabledExtensions', [...disabled, id]);
    for (const ses of allSessions) { try { await ses.removeExtension(id); } catch(e) {} }
  }
  return { success: true };
});

ipcMain.handle('open-extension-options', async (event, { id }) => {
  const ext = Object.values(getMainSession().getAllExtensions()).find(e => e.id === id);
  if (!ext) return { success: false };
  const manifest = ext.manifest || {};
  const optionsPage = manifest.options_ui?.page || manifest.options_page;
  if (!optionsPage) return { success: false, reason: 'no options page' };
  
  const win = new BrowserWindow({
    width: 800, height: 600, title: `${ext.name} — Options`,
    webPreferences: { 
      nodeIntegration: false, 
      contextIsolation: false,
      sandbox: false,
      partition: MAIN_PARTITION 
    }
  });

  // Register with extensions so chrome.* APIs work
  try {
    extensions.addTab(win.webContents, mainWindow);
  } catch(e) {
    console.log('[Options] addTab error (non-fatal):', e.message);
  }

  // Catch errors from the options page
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2) console.log(`[Options] ${msg}`);
  });

  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[Options] Render process crashed:', details.reason);
    if (!win.isDestroyed()) win.close();
  });

  win.loadURL(`chrome-extension://${id}/${optionsPage}`);
  win.once('ready-to-show', () => win.show());
  return { success: true };
});

ipcMain.handle('remove-extension', async (event, id) => {
  const disabled = store.get('disabledExtensions', []);
  store.set('disabledExtensions', disabled.filter(x => x !== id));
  store.delete(`extensionPaths.${id}`);
  const allSessions = [getMainSession(), ...Array.from(activePartitions).map(p => session.fromPartition(p))];
  for (const ses of allSessions) { try { await ses.removeExtension(id); } catch(e) {} }
  return { success: true };
});

ipcMain.handle('activate-extension-popup', async (event, { extensionId, anchorRect }) => {
  try {
    const ext = Object.values(getMainSession().getAllExtensions()).find(e => e.id === extensionId);
    if (!ext) return { success: false, reason: 'extension not found' };
    const manifest = ext.manifest || {};
    const action = manifest.action || manifest.browser_action || manifest.page_action;
    if (!action?.default_popup) return { success: false, reason: 'no popup' };
    const popupFile = action.default_popup.replace(/^\//, '');
    const popupUrl = `chrome-extension://${extensionId}/${popupFile}`;
    console.log(`[Popup] Opening: ${popupUrl}`);
    const [winX, winY] = mainWindow.getPosition();
    const screenX = winX + Math.round(anchorRect.x);
    const screenY = winY + Math.round(anchorRect.y + anchorRect.height + 4);
    const win = new BrowserWindow({
      width: 380, height: 500, x: screenX, y: screenY,
      frame: false, resizable: true, alwaysOnTop: true, skipTaskbar: true, show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: false, sandbox: false, partition: MAIN_PARTITION }
    });
    
    // Prevent renderer crashes from killing main process
    win.webContents.on('render-process-gone', (e, details) => {
      console.error('[Popup] Render process gone:', details.reason);
      if (!win.isDestroyed()) win.close();
    });

    try { extensions.addTab(win.webContents, mainWindow); extensions.selectTab(win.webContents); } catch(e) {
      console.log('[Popup] addTab/selectTab error:', e.message);
    }
    win.webContents.on('console-message', (e, level, msg) => {
      if (level >= 2) console.log(`[Popup] ${msg}`);
    });
    win.webContents.on('did-finish-load', () => { win.show(); win.focus(); });
    win.webContents.on('did-fail-load', (e, code, desc) => {
      console.log(`[Popup] fail: ${code} ${desc}`);
      if (!win.isDestroyed()) win.close();
    });
    win.webContents.on('preferred-size-changed', (e, size) => {
      if (size.width > 0 && size.height > 0)
        win.setSize(Math.min(Math.max(size.width, 200), 800), Math.min(Math.max(size.height, 100), 700));
    });
    win.on('blur', () => { if (!win.isDestroyed()) win.close(); });
    win.loadURL(popupUrl).catch(err => {
      console.log('[Popup] loadURL error:', err.message);
      if (!win.isDestroyed()) win.close();
    });
    return { success: true };
  } catch(e) {
    console.error('[Popup] Fatal error:', e.message);
    return { success: false, reason: e.message };
  }
});

ipcMain.handle('open-cws', async () => {
  const cwsWin = new BrowserWindow({
    width: 1100, height: 750, parent: mainWindow, title: 'Chrome Web Store',
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:cws' }
  });
  cwsWin.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  cwsWin.webContents.on('will-navigate', (e, url) => {
    if (url.includes('chrome.google.com/webstore') && url.includes('detail')) {
      const match = url.match(/\/detail\/[^/]+\/([a-z]{32})/);
      if (match) { e.preventDefault(); installCWSExtension(match[1], cwsWin); }
    }
    if (url.startsWith('uc-install://')) {
      e.preventDefault();
      const extId = url.replace('uc-install://', '').replace(/\/$/, '');
      if (extId.match(/^[a-z]{32}$/)) installCWSExtension(extId, cwsWin);
    }
  });
  cwsWin.webContents.session.webRequest.onBeforeRequest(
    { urls: ['*://clients2.google.com/service/update2/crx*'] },
    (details, callback) => {
      const urlObj = new URL(details.url);
      const x = urlObj.searchParams.get('x') || '';
      const idMatch = x.match(/id%3D([a-z]{32})/i) || x.match(/id=([a-z]{32})/i);
      if (idMatch) { callback({ cancel: true }); installCWSExtension(idMatch[1], cwsWin); }
      else callback({});
    }
  );
  cwsWin.webContents.on('did-finish-load', () => {
    const url = cwsWin.webContents.getURL();
    const match = url.match(/\/detail\/[^/]+\/([a-z]{32})/);
    if (match) {
      cwsWin.webContents.executeJavaScript(`
        (function() {
          if (document.getElementById('__uc_install_btn')) return;
          const btn = document.createElement('button');
          btn.id = '__uc_install_btn';
          btn.textContent = '⬇ Install in Unified Comms';
          btn.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;background:#5865f2;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,0.3)';
          btn.onclick = () => { window.location.href = 'uc-install://${match[1]}'; };
          document.body.appendChild(btn);
        })();
      `).catch(() => {});
    }
  });
  cwsWin.loadURL('https://chrome.google.com/webstore/category/extensions');
  cwsWin.once('ready-to-show', () => cwsWin.show());
});

async function installCWSExtension(extId, parentWin) {
  const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0.0.0&acceptformat=crx3&x=id%3D${extId}%26uc`;
  if (parentWin && !parentWin.isDestroyed()) {
    parentWin.webContents.executeJavaScript(`document.getElementById('__uc_install_btn') && (document.getElementById('__uc_install_btn').textContent = '⏳ Installing...');`).catch(() => {});
  }
  const extBaseDir = path.join(app.getPath('userData'), 'extensions');
  if (!fs.existsSync(extBaseDir)) fs.mkdirSync(extBaseDir, { recursive: true });
  const crxPath = path.join(extBaseDir, `${extId}.crx`);
  const extDir = path.join(extBaseDir, extId);
  try {
    await downloadFile(crxUrl, crxPath);
    await unpackCrx(crxPath, extDir);
    const ext = await getMainSession().loadExtension(extDir, { allowFileAccess: true });
    store.set(`extensionPaths.${ext.id}`, extDir);
    for (const partition of activePartitions) await loadExtIntoSession(session.fromPartition(partition), extDir);
    uiView?.webContents.send('extension-loaded', { id: ext.id, name: ext.name, version: ext.version });
    dialog.showMessageBox(mainWindow, { type: 'info', title: 'Extension Installed', message: `"${ext.name}" installed successfully.`, buttons: ['OK'] });
    if (parentWin && !parentWin.isDestroyed()) parentWin.close();
  } catch (err) {
    console.error('CWS install error:', err);
    dialog.showErrorBox('Install Failed', `Could not install extension: ${err.message}`);
    if (parentWin && !parentWin.isDestroyed()) {
      parentWin.webContents.executeJavaScript(`document.getElementById('__uc_install_btn') && (document.getElementById('__uc_install_btn').textContent = '⬇ Install in Unified Comms');`).catch(() => {});
    }
  }
}

async function loadExtension(extensionPath) {
  try {
    const ext = await getMainSession().loadExtension(extensionPath, { allowFileAccess: true });
    store.set(`extensionPaths.${ext.id}`, extensionPath);
    for (const partition of activePartitions) await loadExtIntoSession(session.fromPartition(partition), extensionPath);
    uiView?.webContents.send('extension-loaded', { id: ext.id, name: ext.name, version: ext.version });
  } catch(e) {
    dialog.showErrorBox('Extension Error', `Failed to load extension: ${e.message}`);
  }
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    const chunks = [];
    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const loc = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location;
        return downloadFile(loc, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { fs.writeFileSync(dest, Buffer.concat(chunks)); resolve(); });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function unpackCrx(crxPath, destDir) {
  return new Promise((resolve, reject) => {
    try {
      const data = fs.readFileSync(crxPath);
      const magic = data.toString('utf8', 0, 4);
      if (magic !== 'Cr24') return reject(new Error('Not a valid CRX file'));
      const version = data.readUInt32LE(4);
      let zipStart;
      if (version === 3) { zipStart = 12 + data.readUInt32LE(8); }
      else if (version === 2) { zipStart = 16 + data.readUInt32LE(8) + data.readUInt32LE(12); }
      else return reject(new Error(`Unsupported CRX version: ${version}`));
      const zipPath = crxPath + '.zip';
      fs.writeFileSync(zipPath, data.slice(zipStart));
      if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      const { execFile } = require('child_process');
      if (process.platform === 'win32') {
        execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], (err) => {
          fs.unlinkSync(zipPath);
          if (err) return reject(new Error(`Unzip failed: ${err.message}`));
          resolve();
        });
      } else {
        execFile('unzip', ['-o', zipPath, '-d', destDir], (err) => {
          fs.unlinkSync(zipPath);
          if (err) return reject(new Error(`Unzip failed: ${err.message}`));
          resolve();
        });
      }
    } catch(e) { reject(e); }
  });
}

// ── Blur system ───────────────────────────────────────────────────────────────

// Settings get/save
ipcMain.handle('blur-get-settings', () => store.get('blurSettings', DEFAULT_BLUR_SETTINGS));

ipcMain.handle('blur-save-settings', (event, newSettings) => {
  store.set('blurSettings', newSettings);
  broadcastBlurSettings(newSettings);
  return { success: true };
});

// Per-account exclusion
ipcMain.handle('blur-set-excluded', (event, { accountId, excluded }) => {
  if (excluded) {
    blurExcluded.add(accountId);
  } else {
    blurExcluded.delete(accountId);
  }
  // Re-inject with the correct effective settings — this handles both cases cleanly
  const view = views.get(accountId);
  if (view && !view.webContents.isDestroyed()) {
    injectBlurIntoView(view).catch(e => console.log('[Blur] set-excluded inject failed:', e.message));
  }
  // Persist immediately
  store.set('blurExcluded', Array.from(blurExcluded));
  return { success: true };
});

ipcMain.handle('blur-get-excluded', (event, { accountId }) => {
  return { excluded: blurExcluded.has(accountId) };
});

function broadcastBlurSettings(settings) {
  for (const [accountId, view] of views.entries()) {
    if (!view || view.webContents.isDestroyed()) continue;
    // Re-inject fully — this sets __blurSettings, clears the guard, and re-runs the script.
    // Falls back gracefully if the view isn't ready (executeJavaScript will throw and be caught).
    injectBlurIntoView(view).catch(() => {});
  }
  // Also notify popup if open so its checkbox stays in sync
  if (blurPopupWin && !blurPopupWin.isDestroyed()) {
    blurPopupWin.webContents.send('blur-settings-changed', settings);
  }
}

async function injectBlurIntoView(view) {
  if (!view || view.webContents.isDestroyed()) return;

  // Skip injection on auth/login pages and known React-heavy SPAs where
  // executeJavaScript disrupts synthetic event handlers
  const url = view.webContents.getURL();
  const isAuthPage = /login\.|accounts\.|auth\.|\/oauth|\/signin|\/login|\/auth/.test(url);
  const isSkipped = isAuthPage || url.includes('teams.live.com');
  if (isSkipped) return;

  const settings = store.get('blurSettings', DEFAULT_BLUR_SETTINGS);
  // Find accountId for this view
  let accountId = null;
  for (const [id, v] of views.entries()) { if (v === view) { accountId = id; break; } }
  const effective = (accountId && blurExcluded.has(accountId))
    ? { ...settings, enabled: false }
    : settings;
  try {
    // Set settings THEN clear the guard so the script re-initialises cleanly
    await view.webContents.executeJavaScript(
      `window.__blurSettings = ${JSON.stringify(effective)}; window.__hbInjected = false;`
    );
    const script = fs.readFileSync(getUnpackedPath('blur-content.js'), 'utf8');
    await view.webContents.executeJavaScript(script);
    console.log('[Blur] Injected into', view.webContents.getURL().slice(0, 50), '| enabled=' + effective.enabled);
  } catch(e) {
    console.log('[Blur] Inject failed:', e.message);
  }
}

ipcMain.handle('blur-resize-popup', (event, { height }) => {
  if (blurPopupWin && !blurPopupWin.isDestroyed()) blurPopupWin.setSize(260, height);
  return { success: true };
});

// Open blur settings popup — receives current accountId from renderer
ipcMain.handle('open-blur-popup', async (event, { anchorRect, accountId }) => {
  if (blurPopupWin && !blurPopupWin.isDestroyed()) { blurPopupWin.focus(); return { success: true }; }
  const [winX, winY] = mainWindow.getPosition();
  // Taller when a service is active so the footer fits without clipping
  const popupHeight = accountId ? 370 : 270;
  blurPopupWin = new BrowserWindow({
    width: 260, height: popupHeight,
    x: winX + Math.round(anchorRect.x),
    y: winY + Math.round(anchorRect.y + anchorRect.height + 4),
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, partition: MAIN_PARTITION }
  });
  blurPopupWin.loadFile('src/blur-popup.html', { query: { accountId: accountId || '' } });
  blurPopupWin.once('ready-to-show', () => { blurPopupWin.show(); blurPopupWin.focus(); });
  blurPopupWin.on('blur', () => { if (blurPopupWin && !blurPopupWin.isDestroyed()) blurPopupWin.close(); });
  blurPopupWin.on('closed', () => { blurPopupWin = null; });
  return { success: true };
});

function startMemoryMonitoring() {
  async function collectAndSend() {
    try {
      // Sum memory across ALL Electron processes (main + all renderers/WebContentsViews)
      const allMetrics = await app.getAppMetrics();
      let totalMB = 0;
      for (const proc of allMetrics) {
        // workingSetSize is the actual RAM in use (KB)
        totalMB += (proc.memory?.workingSetSize || 0);
      }
      totalMB = Math.round(totalMB / 1024); // KB → MB

      // Also include main process RSS for accuracy
      const mainMem = process.memoryUsage();
      const mainRssMB = Math.round(mainMem.rss / 1024 / 1024);
      // Use whichever is larger — app metrics sometimes lag on first call
      const displayMB = Math.max(totalMB, mainRssMB);

      if (displayMB > MAX_MEMORY_MB) getMainSession().clearCodeCaches();
      uiView?.webContents.send('memory-update', { heapUsed: displayMB, rss: displayMB });
    } catch(e) {
      // Fallback to main process only
      const mem = process.memoryUsage();
      const mb = Math.round(mem.rss / 1024 / 1024);
      uiView?.webContents.send('memory-update', { heapUsed: mb, rss: mb });
    }
  }

  collectAndSend(); // immediate first reading
  setInterval(collectAndSend, 5000); // update every 5 seconds
}

function createMenu() {
  const template = [
    { label: 'File', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => uiView?.webContents.send('open-settings') }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Extensions', submenu: [
      { label: 'Load Extension...', click: async () => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (!r.canceled) loadExtension(r.filePaths[0]); } },
      { label: 'Manage Extensions', click: () => uiView?.webContents.send('open-extensions') }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Fix userData path so login sessions persist across installs/updates.
  app.setPath('userData', path.join(
    process.env.APPDATA || process.env.HOME || app.getPath('userData'),
    'unified-comms'
  ));

  // CRITICAL for Windows: without this, Electron notifications are attributed to
  // "electron.app.electron" and Windows may silently drop them or show wrong icon.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.unified-comms.app');
  }

  // Restore excluded accounts from store
  const savedExcluded = store.get('blurExcluded', []);
  blurExcluded = new Set(savedExcluded);

  // ── Splash screen ──────────────────────────────────────────────────────────
  const splashWin = new BrowserWindow({
    width: 1400, height: 900,
    frame: false, transparent: false,
    backgroundColor: '#0d0d1a',
    resizable: false, movable: true,
    center: true, show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  });
  splashWin.loadFile('src/splash.html');
  splashWin.once('ready-to-show', () => splashWin.show());

  // Start loading main window in background while splash plays
  const mainWindowReady = createWindow();

  // Wait for splash-done IPC (user skipped or 5s elapsed)
  await new Promise(resolve => {
    ipcMain.once('splash-done', resolve);
  });

  // Ensure main window is fully created before closing splash
  await mainWindowReady;
  if (!splashWin.isDestroyed()) splashWin.close();
  // ──────────────────────────────────────────────────────────────────────────

  // Build overlay icon cache in background (non-blocking)
  buildOverlayIconCache().catch(() => {});

  // Init adblocker and xblocker in the background after window is visible.
  // applyAdBlocker() is called inside create-view for each session, so by the
  // time the user clicks a service the blocker will be ready.
  initAdBlocker().then(() => {
    // Apply to main session + any sessions created before blocker was ready
    try { applyAdBlocker(getMainSession()); } catch(e) {}
    for (const ses of _pendingAdBlockSessions) {
      try { applyAdBlocker(ses); } catch(e) {}
    }
    _pendingAdBlockSessions.clear();
  }).catch(e => console.error('[AdBlock] deferred init failed:', e.message));

  // XBlocker model load is very heavy (TensorFlow) — defer well after startup
  setTimeout(() => {
    initXBlocker().catch(e => console.error('[XBlocker] deferred init failed:', e.message));
  }, 5000);

  // Alt+L — toggle blur on/off globally
  globalShortcut.register('Alt+L', () => {
    const settings = store.get('blurSettings', DEFAULT_BLUR_SETTINGS);
    const next = { ...settings, enabled: !settings.enabled };
    store.set('blurSettings', next);
    broadcastBlurSettings(next);
  });
}).catch(console.error);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  store.set('blurExcluded', Array.from(blurExcluded));
  // Ensure all child processes are gone
  process.exit(0);
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
