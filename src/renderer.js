console.log('[Renderer] renderer.js loading...');
const { ipcRenderer } = require('electron');
const DevTools = require('./dev-tools');

// Detect which chrome strip this instance is running in.
// sidebarView is 80px wide; titlebarView is full-width but only 40px tall.
// The sidebar instance runs the full ServiceManager (service switching, accounts, etc.)
// The titlebar instance only wires up the top chrome buttons and modals.
const IS_SIDEBAR = window.innerWidth <= 110;
const IS_TITLEBAR = !IS_SIDEBAR;

// Clamp helper — mirrors CSS clamp(min, val, max)
function clamp(min, val, max) { return Math.min(Math.max(val, min), max); }

// Compute and apply responsive layout sizes based on main window dimensions.
// Called on load and whenever main process sends 'window-resized' with { width, height }.
// We do this in JS (not CSS vw/vh) because each WebContentsView has its own small
// viewport — the sidebar is only 80px wide, so vw units would be wrong.
let _lastWinW = 1400;
let _lastWinH = 900;

function applyResponsiveLayout(winW, winH) {
  _lastWinW = winW || _lastWinW;
  _lastWinH = winH || _lastWinH;
  const w = _lastWinW;
  const h = _lastWinH;

  // Titlebar height: 52px at 900px wide, 68px at 1400px, 80px at 1920px
  const titlebarH = Math.round(clamp(52, 52 + (w - 900) * (16 / 500), 80));
  // Sidebar width: 64px at 900px wide, 80px at 1400px, 96px at 1920px
  const sidebarW = Math.round(clamp(64, 64 + (w - 900) * (16 / 500), 96));

  // Apply to titlebar element
  const titlebar = document.getElementById('titlebar');
  if (titlebar) {
    titlebar.style.height = titlebarH + 'px';
    titlebar.style.minHeight = titlebarH + 'px';
  }

  // Apply to sidebar element
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.style.width = sidebarW + 'px';
  }

  // Scale service icons proportionally
  const iconSize = Math.round(clamp(48, 48 + (w - 900) * (14 / 500), 72));
  const imgSize  = Math.round(clamp(32, 32 + (w - 900) * (10 / 500), 48));
  document.querySelectorAll('.service-icon').forEach(el => {
    el.style.width  = iconSize + 'px';
    el.style.height = iconSize + 'px';
  });
  document.querySelectorAll('.service-icon img').forEach(el => {
    el.style.width  = imgSize + 'px';
    el.style.height = imgSize + 'px';
  });

  // Scale titlebar logo
  const logoImg = document.querySelector('.titlebar-logo img');
  const logoWrap = document.querySelector('.titlebar-logo');
  if (logoImg) {
    const logoSize = Math.round(clamp(40, 40 + (w - 900) * (16 / 500), 64));
    logoImg.style.width  = logoSize + 'px';
    logoImg.style.height = logoSize + 'px';
  }
  if (logoWrap) {
    logoWrap.style.width  = (sidebarW - 4) + 'px';
    logoWrap.style.height = titlebarH + 'px';
  }

  // Scale titlebar title font
  const title = document.querySelector('.titlebar-title');
  if (title) {
    const fontSize = Math.round(clamp(22, 22 + (w - 900) * (18 / 500), 44));
    title.style.fontSize = fontSize + 'px';
  }

  // Scale window control buttons height
  document.querySelectorAll('.window-control-btn').forEach(el => {
    el.style.height = titlebarH + 'px';
  });

  // Adjust main-container top offset
  const mainContainer = document.getElementById('main-container');
  if (mainContainer) mainContainer.style.top = titlebarH + 'px';

  // Report to main process so WebContentsView bounds stay in sync
  ipcRenderer.send('layout-dimensions', { titlebarHeight: titlebarH, sidebarWidth: sidebarW });
}

// Receive window dimensions from main process on resize
ipcRenderer.on('window-resized', (event, dims) => {
  if (dims && dims.width) applyResponsiveLayout(dims.width, dims.height);
  else applyResponsiveLayout(_lastWinW, _lastWinH);
});
window.addEventListener('resize', () => applyResponsiveLayout(_lastWinW, _lastWinH));

// Legacy alias kept for any code that calls reportLayoutDimensions() directly
function reportLayoutDimensions() { applyResponsiveLayout(_lastWinW, _lastWinH); }

// Canonical web URLs — use Chrome UA in main process so services don't block Electron
let SERVICES = {};

class ServiceManager {
  constructor() {
    this.currentService = null;
    this.currentAccountId = null;
    this.createdViews = new Set();  // accountIds with created WebContentsViews
    this.accounts = {};
    this.activeAccounts = {};
    this.settings = {};
    this.disabledServices = new Set(); // serviceIds that are turned off
    this.disabledAccounts = new Set(); // accountIds that are turned off individually
    this.devTools = new DevTools();
    this.notificationCounts = new Map();
    window.devTools = this.devTools;
    this.init();
  }

  async init() {
    try {
      console.log(`[Init] starting (${IS_SIDEBAR ? 'sidebar' : 'titlebar'})...`);
      SERVICES = await ipcRenderer.invoke('get-services') || {};
      this.settings = await ipcRenderer.invoke('get-settings') || {};
      console.log('[Init] SERVICES:', Object.keys(SERVICES).length);

      await this.loadAccounts();
      if (IS_SIDEBAR) this._renderServiceIcons();
      this.setupEventListeners();
      this.setupKeyboardShortcuts();
      this.setupIPCListeners();

      // Apply responsive layout now that DOM is ready
      applyResponsiveLayout(_lastWinW, _lastWinH);

      if (IS_TITLEBAR) {
        console.log('[Init] titlebar mode — skipping service init');
        ipcRenderer.invoke('get-extensions').then(exts => this.renderExtensionToolbar(exts));
        return;
      }

      // Load disabled services from settings
      this.disabledServices = new Set(this.settings.disabledServices || []);
      this.disabledAccounts = new Set(this.settings.disabledAccounts || []);
      for (const sId of this.disabledServices) this._applyServiceDisabledStyle(sId, true);

      this._initNetworkIndicator();

      if (Object.keys(SERVICES).length === 0) {
        console.log('[Init] No services found, showing Setup Wizard');
        this.showSetupWizard();
      } else if (!this.settings.firstTimeSetup) {
        this.showFirstTimeWizard();
      } else {
        let defaultService = this.settings.defaultService || 'gmail';
        if (this.disabledServices.has(defaultService)) {
          defaultService = Object.keys(SERVICES).find(s => !this.disabledServices.has(s)) || (Object.keys(SERVICES)[0] || 'gmail');
        }
        if (Object.keys(SERVICES).length > 0) {
          await this.switchService(defaultService);
          this._scheduleBackgroundPreloads(defaultService);
        }
      }
      ipcRenderer.invoke('get-extensions').then(exts => this.renderExtensionToolbar(exts));
    } catch (e) {
      console.error('[Init] Fatal error:', e);
    }
  }

  showSetupWizard() {
    console.log('[SetupWizard] Showing...');
    ipcRenderer.send('modal-open');
    const modal = document.getElementById('setup-wizard-modal');
    if (!modal) {
      console.error('[SetupWizard] Modal element not found!');
      return;
    }
    const errorEl = document.getElementById('setup-wizard-error');
    const nameInput = document.getElementById('new-service-name');
    const urlInput = document.getElementById('new-service-url');
    const addBtn = document.getElementById('setup-wizard-add-btn');

    modal.classList.remove('hidden');
    modal.style.display = 'flex'; // Force display
    modal.style.opacity = '1';
    modal.style.zIndex = '9999';
    
    if (nameInput) nameInput.value = '';
    if (urlInput) urlInput.value = '';
    if (errorEl) errorEl.classList.add('hidden');

    if (addBtn) {
      addBtn.onclick = async () => {
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();

        if (!name) {
          if (errorEl) {
            errorEl.textContent = 'Please enter a name.';
            errorEl.classList.remove('hidden');
          }
          return;
        }
        if (!url.startsWith('https://')) {
          if (errorEl) {
            errorEl.textContent = 'URL must start with https://';
            errorEl.classList.remove('hidden');
          }
          return;
        }

        const serviceId = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
        const result = await ipcRenderer.invoke('save-service', { id: serviceId, name, url });

        if (result.success) {
          SERVICES[serviceId] = { name, url };
          await this.loadAccounts();
          modal.classList.add('hidden');
          modal.style.display = 'none';
          ipcRenderer.send('modal-close');
          this._renderServiceIcons();
          await this.switchService(serviceId);
        } else {
          if (errorEl) {
            errorEl.textContent = 'Failed to save service: ' + (result.error || 'Unknown error');
            errorEl.classList.remove('hidden');
          }
        }
      };
    }
  }

  _renderServiceIcons() {
    const container = document.getElementById('service-icons-container');
    if (!container) return;
    container.innerHTML = '';

    const pngServices = ['gchat', 'outlook', 'teams'];
    Object.entries(SERVICES).forEach(([serviceId, service]) => {
      const ext = pngServices.includes(serviceId) ? 'png' : 'svg';
      const iconSrc = window.__assetBase ? `${window.__assetBase}/icons/${serviceId}.${ext}` : `../assets/icons/${serviceId}.${ext}`;

      const btn = document.createElement('button');
      btn.className = 'service-icon';
      btn.dataset.service = serviceId;
      btn.title = service.name;
      btn.innerHTML = `
        <img src="${iconSrc}" alt="${service.name}" onerror="this.src='../assets/icon-256.png';">
        <span class="service-label">${service.name.split(' ')[0]}</span>
        <span class="notification-badge hidden">0</span>
      `;

      btn.addEventListener('click', (e) => this.switchService(serviceId));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showAccountContextMenu(serviceId, btn);
      }, true); // capture phase

      // Hover toggle button
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'svc-toggle-btn';
      toggleBtn.title = 'Turn off service';
      toggleBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18.36 6.64A9 9 0 1 1 5.64 5.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg>`;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleService(serviceId);
      });
      btn.appendChild(toggleBtn);

      container.appendChild(btn);
    });
  }

  async preloadService(serviceId) {
    const accountId = this.activeAccounts[serviceId];
    if (!accountId || this.createdViews.has(accountId)) return;
    const service = SERVICES[serviceId];
    const account = this.getAccount(serviceId, accountId);
    if (!service || !account) return;
    await ipcRenderer.invoke('create-view', { accountId, url: service.url, partition: account.partition });
    this.createdViews.add(accountId);
  }

  _scheduleBackgroundPreloads(skipServiceId) {
    // Preload all other enabled services simultaneously — no stagger.
    const order = Object.keys(SERVICES).filter(s => s !== skipServiceId && !this.disabledServices.has(s));
    if (order.length === 0) return;

    let remaining = 0;
    const indicator = document.getElementById('preload-indicator');
    const label = document.getElementById('preload-label');

    const done = () => {
      remaining--;
      if (remaining <= 0 && indicator) indicator.classList.add('hidden');
    };

    order.forEach((serviceId) => {
      // Small offset so the default service gets a head start on network
      setTimeout(() => {
        const accountId = this.activeAccounts[serviceId];
        if (!accountId || this.createdViews.has(accountId)) return;
        if (this.disabledAccounts.has(accountId)) return;
        remaining++;
        if (indicator) indicator.classList.remove('hidden');
        if (label) label.textContent = `Loading ${SERVICES[serviceId].name}…`;
        console.log(`[Preload] background preloading ${serviceId}`);
        this.preloadService(serviceId).then(done).catch(done);
      }, 1500);
    });
  }

  _initNetworkIndicator() {
    const dot = document.getElementById('network-dot');
    const status = document.getElementById('network-status');
    const speed = document.getElementById('network-speed');
    if (!dot || !status) return;

    const update = () => {
      const online = navigator.onLine;
      dot.classList.toggle('offline', !online);
      status.textContent = online ? 'Online' : 'Offline';
      status.classList.toggle('offline', !online);

      // Network speed via Network Information API
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (speed) {
        if (online && conn && conn.downlink != null) {
          speed.textContent = `↓ ${conn.downlink} Mbps`;
        } else {
          speed.textContent = '';
        }
      }
    };

    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    // Also refresh speed when connection changes
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) conn.addEventListener('change', update);
  }

  async loadAccounts() {
    const stored = await ipcRenderer.invoke('get-accounts');
    if (stored && Object.keys(stored).length > 0) {
      this.accounts = stored.accounts || {};
      this.activeAccounts = stored.activeAccounts || {};
      // Backfill any services added after initial setup
      let dirty = false;
      for (const serviceId in SERVICES) {
        if (!this.accounts[serviceId] || this.accounts[serviceId].length === 0) {
          this.accounts[serviceId] = [{
            id: `${serviceId}-1`, name: 'Default',
            partition: `persist:${serviceId}-1`, isDefault: true, createdAt: Date.now()
          }];
          this.activeAccounts[serviceId] = `${serviceId}-1`;
          dirty = true;
        }
      }
      if (dirty) await this.saveAccounts();
    } else {
      this.accounts = {};
      this.activeAccounts = {};
      for (const serviceId in SERVICES) {
        this.accounts[serviceId] = [{
          id: `${serviceId}-1`, name: 'Default',
          partition: `persist:${serviceId}-1`, isDefault: true, createdAt: Date.now()
        }];
        this.activeAccounts[serviceId] = `${serviceId}-1`;
      }
      await this.saveAccounts();
    }
  }

  async saveAccounts() {
    await ipcRenderer.invoke('save-accounts', { accounts: this.accounts, activeAccounts: this.activeAccounts });
  }

  setupIPCListeners() {
    ipcRenderer.on('view-title-updated', (event, { accountId, title }) => {
      const serviceId = this.getServiceForAccount(accountId);
      if (serviceId) this.handleTitleUpdate(serviceId, accountId, title);
    });

    ipcRenderer.on('view-loaded', (event, { accountId }) => {
      if (accountId === this.currentAccountId) this.hideLoading();
    });

    ipcRenderer.on('view-load-error', (event, { accountId, error }) => {
      if (accountId === this.currentAccountId) {
        const serviceId = this.getServiceForAccount(accountId);
        const name = serviceId ? SERVICES[serviceId]?.name : 'Service';
        this.showError(`Failed to load ${name}: ${error}`);
      }
    });

    ipcRenderer.on('memory-update', (event, data) => this.updateMemoryIndicator(data));
    ipcRenderer.on('open-settings', () => this.openSettings());
    ipcRenderer.on('open-extensions', () => this.openExtensions());
    ipcRenderer.on('extension-loaded', (event, ext) => {
      this.refreshExtensionsList();
    });
    // Titlebar buttons forward modal requests here
    ipcRenderer.on('open-modal', (event, { modal }) => {
      if (modal === 'settings') this.openSettings();
      else if (modal === 'extensions') this.openExtensions();
    });

    // Native menu selection response
    ipcRenderer.on('account-menu-select', (event, { serviceId, accountId, action }) => {
      if (accountId) this.switchService(serviceId, accountId);
      else if (action === 'add') this.addNewAccount(serviceId);
      else if (action === 'manage') this.openAccountManagement(serviceId);
    });

    // Main process asks for account name to show in desktop notification
    ipcRenderer.on('request-account-name', (event, { accountId, newCount, serviceLabel }) => {
      const serviceId = this.getServiceForAccount(accountId);
      const account = serviceId ? this.getAccount(serviceId, accountId) : null;
      const accountName = account?.name || 'Default';
      ipcRenderer.send('show-notification', { accountId, accountName, serviceLabel, newCount });
    });

    // Web-notification path — includes sender + body from the intercepted notification
    ipcRenderer.on('request-account-name-toast', (event, { accountId, serviceLabel, sender, body, newCount }) => {
      const serviceId = this.getServiceForAccount(accountId);
      const account = serviceId ? this.getAccount(serviceId, accountId) : null;
      const accountName = account?.name || 'Default';
      ipcRenderer.send('show-notification', { accountId, accountName, serviceLabel, newCount, sender, body });
    });

    ipcRenderer.on('adblock-update', (event, { enabled, count }) => {
      this.updateAdBlockBtn(enabled, count);
    });

    ipcRenderer.on('xblocker-update', (event, { enabled, count }) => {
      this.updateXBlockerBtn(enabled, count);
    });
  }

  updateAdBlockBtn(enabled, count) {
    const btn = document.getElementById('adblock-btn');
    const countEl = document.getElementById('adblock-count');
    if (!btn) return;
    btn.classList.toggle('adblock-btn-on', enabled);
    btn.classList.toggle('adblock-btn-off', !enabled);
    btn.title = enabled ? `Ad Blocker ON — ${count} blocked` : 'Ad Blocker OFF';
    if (countEl) countEl.textContent = count >= 1000 ? `${(count/1000).toFixed(1)}k` : count;
  }

  updateXBlockerBtn(enabled, count) {
    const btn = document.getElementById('xblocker-btn');
    const countEl = document.getElementById('xblocker-count');
    if (!btn) return;
    btn.classList.toggle('xblocker-btn-on', enabled);
    btn.classList.toggle('xblocker-btn-off', !enabled);
    btn.title = enabled ? `XBlocker ON — ${count} blocked` : 'XBlocker OFF';
    if (countEl) countEl.textContent = count >= 1000 ? `${(count/1000).toFixed(1)}k` : count;
  }

  getServiceForAccount(accountId) {
    for (const [serviceId, accounts] of Object.entries(this.accounts)) {
      if (accounts.find(a => a.id === accountId)) return serviceId;
    }
    return null;
  }

  setupEventListeners() {
    document.getElementById('minimize-btn').addEventListener('click', () => ipcRenderer.send('window-minimize'));
    document.getElementById('maximize-btn').addEventListener('click', () => ipcRenderer.send('window-maximize'));
    document.getElementById('close-btn').addEventListener('click', () => ipcRenderer.send('window-close'));

    const markAllBtn = document.getElementById('mark-all-read-btn');
    if (markAllBtn) {
      markAllBtn.addEventListener('click', () => this.markAllAsRead());
    }

    document.getElementById('reload-btn').addEventListener('click', () => {
      console.log('Button clicked: reload-btn');
      ipcRenderer.invoke('reload-view', { accountId: this.currentAccountId || null });
      const btn = document.getElementById('reload-btn');
      btn.classList.add('spinning');
      setTimeout(() => btn.classList.remove('spinning'), 1000);
    });

    document.getElementById('blur-btn').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      ipcRenderer.invoke('open-blur-popup', {
        anchorRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        accountId: this.currentAccountId
      });
    });

    // Adblock toggle button
    ipcRenderer.invoke('get-adblock-state').then(({ enabled, count }) => {
      this.updateAdBlockBtn(enabled, count);
    });
    document.getElementById('adblock-btn').addEventListener('click', async () => {
      const { enabled } = await ipcRenderer.invoke('toggle-adblock');
      const countEl = document.getElementById('adblock-count');
      const count = parseInt(countEl?.textContent || '0');
      this.updateAdBlockBtn(enabled, count);
    });

    // XBlocker toggle button
    ipcRenderer.invoke('get-xblocker-state').then(({ enabled, count }) => {
      this.updateXBlockerBtn(enabled, count);
    });
    document.getElementById('xblocker-btn').addEventListener('click', async () => {
      const { enabled } = await ipcRenderer.invoke('toggle-xblocker');
      const countEl = document.getElementById('xblocker-count');
      const count = parseInt(countEl?.textContent || '0');
      this.updateXBlockerBtn(enabled, count);
    });

    document.getElementById('settings-btn').addEventListener('click', () => {
      console.log('Button clicked: settings-btn');
      if (IS_TITLEBAR) { ipcRenderer.send('sidebar-open-modal', { modal: 'settings' }); return; }
      this.openSettings();
    });
    document.getElementById('extensions-btn').addEventListener('click', () => {
      if (IS_TITLEBAR) { ipcRenderer.send('sidebar-open-modal', { modal: 'extensions' }); return; }
      this.openExtensions();
    });

    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.target.closest('.modal').classList.add('hidden');
        this.restoreActiveView();
      });
    });
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.classList.add('hidden');
          this.restoreActiveView();
        }
      });
    });

    document.getElementById('save-settings-btn').addEventListener('click', () => this.saveSettings());
    document.getElementById('backup-data-btn')?.addEventListener('click', () => this.backupData());
    document.getElementById('restore-data-btn')?.addEventListener('click', () => this.restoreData());
    document.getElementById('clear-cache-btn').addEventListener('click', () => this.clearAllCaches());
    document.getElementById('manage-accounts-btn').addEventListener('click', () => {
      document.getElementById('settings-modal').classList.add('hidden');
      this.openAccountManagement();
    });
    document.getElementById('clean-storage-btn').addEventListener('click', () => {
      document.getElementById('settings-modal').classList.add('hidden');
      this.openCleanStorage();
    });
    document.getElementById('load-extension-btn').addEventListener('click', () => ipcRenderer.send('open-extension-dialog'));
    document.getElementById('cws-btn').addEventListener('click', () => ipcRenderer.invoke('open-cws'));
    document.getElementById('retry-btn').addEventListener('click', async () => {
      if (!this.currentService || !this.currentAccountId) return;
      const account = this.getAccount(this.currentService, this.currentAccountId);
      if (account) {
        try { await ipcRenderer.invoke('clear-cache', account.partition); } catch (e) {}
      }
      this.switchService(this.currentService, null, true);
    });
  }

  setupKeyboardShortcuts() {
    const serviceKeys = Object.keys(SERVICES);
    document.addEventListener('keydown', (e) => {
      const key = parseInt(e.key);
      if (isNaN(key) || key < 1 || key > Math.min(serviceKeys.length, 9)) return;
      const serviceId = serviceKeys[key - 1];
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey) { e.preventDefault(); this.switchService(serviceId); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); this.cycleAccount(serviceId); }
    });
  }

  cycleAccount(serviceId) {
    const accounts = this.accounts[serviceId];
    if (!accounts || accounts.length <= 1) return;
    const currentId = this.activeAccounts[serviceId];
    const idx = accounts.findIndex(a => a.id === currentId);
    const next = accounts[(idx + 1) % accounts.length];
    this.switchService(serviceId, next.id);
  }

  async switchService(serviceId, accountId = null, forceReload = false) {
    if (!SERVICES[serviceId]) return;

    // If service is disabled, show the off-state page instead
    if (this.disabledServices.has(serviceId)) {
      this._showServiceOffPage(serviceId);
      return;
    }

    // If the requested account is disabled, find next enabled one
    if (accountId && this.disabledAccounts.has(accountId)) {
      const next = (this.accounts[serviceId] || []).find(a => !this.disabledAccounts.has(a.id));
      if (next) accountId = next.id;
      else { this._showServiceOffPage(serviceId); return; }
    }

    // Hide the service-off page if it was showing
    this._hideServiceOffPage();
    if (!accountId) accountId = this.activeAccounts[serviceId];
    if (!accountId && this.accounts[serviceId]?.length) {
      accountId = this.accounts[serviceId][0].id;
      this.activeAccounts[serviceId] = accountId;
    }
    if (this.currentService === serviceId && this.currentAccountId === accountId && !forceReload) return;

    const startTime = performance.now();

    // Update UI immediately — don't wait for IPC
    document.querySelectorAll('.service-icon').forEach(icon => {
      icon.classList.toggle('active', icon.dataset.service === serviceId);
    });
    document.getElementById('error-boundary').classList.add('hidden');

    const prevAccountId = this.currentAccountId;
    this.currentService = serviceId;
    this.currentAccountId = accountId;
    this.activeAccounts[serviceId] = accountId;

    const service = SERVICES[serviceId];
    let account = this.getAccount(serviceId, accountId);
    if (!account && this.accounts[serviceId]?.length) {
      account = this.accounts[serviceId][0];
      this.currentAccountId = account.id;
      this.activeAccounts[serviceId] = account.id;
      accountId = account.id;
    }
    if (!service || !account) {
      console.warn('[Switch] No account for', serviceId);
      return;
    }

    try {
      if (!this.createdViews.has(accountId) || forceReload) {
        // View not ready yet — create it (first-time or force reload)
        this.showLoading();
        // Fire hide and create in parallel — hide doesn't need to finish before create starts
        const hidePromise = (prevAccountId && prevAccountId !== accountId)
          ? ipcRenderer.invoke('hide-view', { accountId: prevAccountId })
          : Promise.resolve();
        const createPromise = ipcRenderer.invoke('create-view', {
          accountId, url: service.url, partition: account.partition, forceReload
        });
        await Promise.all([hidePromise, createPromise]);
        this.createdViews.add(accountId);
      } else if (prevAccountId && prevAccountId !== accountId) {
        // View already exists — fire hide and show simultaneously via show-view
        // (show-view already handles hiding the previous view internally)
      }

      // show-view handles removing the old view and adding the new one atomically
      await ipcRenderer.invoke('show-view', { accountId });
      this.updateAccountBadge(serviceId, accountId);
      // Save accounts async — don't block the switch
      this.saveAccounts().catch(() => {});

      console.log(`Switched to ${serviceId}(${accountId}) in ${(performance.now() - startTime).toFixed(1)}ms`);
      this.devTools.measureSwitch(serviceId, startTime);
    } catch (err) {
      console.error('[Switch] Error:', err);
      this.showError(`Failed to switch to ${SERVICES[serviceId]?.name || serviceId}: ${err.message || err}`);
    } finally {
      this.hideLoading();
    }
  }

  showLoading() { document.getElementById('loading-indicator').classList.remove('hidden'); }
  hideLoading() { document.getElementById('loading-indicator').classList.add('hidden'); }

  async hideActiveView() {
    if (this.currentAccountId) {
      await ipcRenderer.invoke('hide-view', { accountId: this.currentAccountId });
    }
  }

  async restoreActiveView() {
    ipcRenderer.send('modal-close');
    if (this.currentAccountId) {
      await ipcRenderer.invoke('show-view', { accountId: this.currentAccountId });
    }
  }

  getAccount(serviceId, accountId) {
    return (this.accounts[serviceId] || []).find(a => a.id === accountId) || null;
  }

  updateAccountBadge(serviceId, accountId) {
    const icon = document.querySelector(`.service-icon[data-service="${serviceId}"]`);
    if (!icon) return;
    let badge = icon.querySelector('.account-badge');
    if (!badge) { badge = document.createElement('span'); badge.className = 'account-badge'; icon.appendChild(badge); }
    const account = this.getAccount(serviceId, accountId);
    if (account) { badge.textContent = account.name; badge.classList.remove('hidden'); }
  }

  showError(message) {
    this.hideLoading();
    document.getElementById('error-boundary').classList.remove('hidden');
    document.getElementById('error-message').textContent = message;
  }

  handleTitleUpdate(serviceId, accountId, title) {
    this.autoDetectAccountName(serviceId, accountId, title);
    // Unread count patterns covering all 8 services
    const patterns = [
      /^\((\d+)\)/,          // (3) Gmail, (3) Slack, (3) WhatsApp, (3) Telegram, (3) Discord
      /\((\d+)\)\s*[-|]/,    // (3) - Title or (3) | Title
      /\((\d+)\)\s*$/,       // trailing (3)
      /^\*(\d+)\*/,          // *3* (some services)
      /\[(\d+)\]/,           // [3]
    ];
    let count = 0;
    for (const p of patterns) { const m = title.match(p); if (m) { count = parseInt(m[1]); break; } }
    this.updateNotificationBadge(serviceId, accountId, count);
  }

  autoDetectAccountName(serviceId, accountId, title) {
    const account = this.getAccount(serviceId, accountId);
    if (!account || account.name !== 'Default') return;
    let name = null;
    if (serviceId === 'gmail') {
      // "Inbox (3) - user@gmail.com - Gmail" or "Inbox - user@gmail.com"
      const m = title.match(/[-–]\s*([^@\s]+@[^@\s]+\.[^@\s-]+)/);
      if (m) name = m[1].trim().split('@')[0];
    } else if (serviceId === 'gchat') {
      // "Jerry | Google Chat" or "Chat - Jerry"
      const m = title.match(/^([^|–-]+)\s*[|–-]/);
      if (m) name = m[1].trim();
    } else if (serviceId === 'outlook') {
      // "Mail - user@outlook.com - Outlook"
      const m = title.match(/[-–]\s*([^@\s]+@[^@\s]+)/);
      if (m) name = m[1].trim().split('@')[0];
    } else if (serviceId === 'slack') {
      // "general | workspace - Slack" or "workspace | Slack"
      const m = title.match(/\|\s*([^|–-]+)\s*[-–]/);
      if (m) name = m[1].trim();
      else { const m2 = title.match(/^([^|]+)\s*\|/); if (m2) name = m2[1].trim(); }
    } else if (serviceId === 'teams') {
      const m = title.match(/[-–]\s*(.+?)\s*[-–]\s*Microsoft Teams/);
      if (m) name = m[1].trim();
    } else if (serviceId === 'discord') {
      // "Discord | Friends" or "@username - Discord"
      const m = title.match(/Discord\s*[|]\s*(.+)/);
      if (m) name = m[1].trim();
    } else if (serviceId === 'telegram') {
      // "Telegram Web" — no user info in title, skip
    } else if (serviceId === 'whatsapp') {
      const m = title.match(/WhatsApp\s*[-–|]\s*(.+)/);
      if (m) name = m[1].trim();
    }
    if (name && name.length > 0 && name !== 'Default') {
      account.name = name.slice(0, 20); // cap length
      this.saveAccounts();
      this.updateAccountBadge(serviceId, accountId);
    }
  }

  updateNotificationBadge(serviceId, accountId, count) {
    const icon = document.querySelector(`.service-icon[data-service="${serviceId}"]`);
    if (!icon) return;
    const badge = icon.querySelector('.notification-badge');
    if (!badge) return;

    // Only allow zeroing a non-zero count if the user is actively viewing this exact account.
    // Switching to gmail-1 must not clear gmail-2's badge.
    const current = this.notificationCounts.get(`${serviceId}-${accountId}`) || 0;
    if (count === 0 && current > 0 && this.currentAccountId !== accountId) return;

    this.notificationCounts.set(`${serviceId}-${accountId}`, count);
    let total = 0;
    for (const [k, v] of this.notificationCounts) { if (k.startsWith(serviceId + '-')) total += v; }
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : total;
      badge.classList.remove('hidden');
      icon.classList.add('has-notification');
      // Show mark-as-read button
      let markBtn = icon.querySelector('.mark-read-btn');
      if (!markBtn) {
        markBtn = document.createElement('button');
        markBtn.className = 'mark-read-btn';
        markBtn.title = 'Mark as read';
        markBtn.textContent = '✓';
        markBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.markAsRead(serviceId);
        });
        icon.appendChild(markBtn);
      }
      markBtn.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
      icon.classList.remove('has-notification');
      const markBtn = icon.querySelector('.mark-read-btn');
      if (markBtn) markBtn.classList.add('hidden');
    }
    this.updateWindowTitle();
  }

  markAsRead(serviceId) {
    const accounts = this.accounts[serviceId] || [];
    let targetAccountId = null;
    let maxCount = 0;
    accounts.forEach(acc => {
      const count = this.notificationCounts.get(`${serviceId}-${acc.id}`) || 0;
      if (count > maxCount) { maxCount = count; targetAccountId = acc.id; }
    });

    // Persist suppression so badges don't reappear on next launch
    accounts.forEach(acc => {
      const count = this.notificationCounts.get(`${serviceId}-${acc.id}`) || 0;
      if (count > 0) ipcRenderer.send('suppress-badge', { accountId: acc.id, count });
    });

    if (targetAccountId) {
      // Switch to the account with unread — service marks messages as read naturally
      this.switchService(serviceId, targetAccountId);
    } else {
      accounts.forEach(acc => this.notificationCounts.set(`${serviceId}-${acc.id}`, 0));
      const icon = document.querySelector(`.service-icon[data-service="${serviceId}"]`);
      if (icon) {
        const badge = icon.querySelector('.notification-badge');
        if (badge) badge.classList.add('hidden');
        icon.classList.remove('has-notification');
        const markBtn = icon.querySelector('.mark-read-btn');
        if (markBtn) markBtn.classList.add('hidden');
      }
      this.updateWindowTitle();
    }
  }

  markAllAsRead() {
    for (const serviceId of Object.keys(this.accounts)) {
      const accounts = this.accounts[serviceId] || [];
      let hasUnread = false;
      accounts.forEach(acc => {
        const count = this.notificationCounts.get(`${serviceId}-${acc.id}`) || 0;
        if (count > 0) {
          hasUnread = true;
          ipcRenderer.send('suppress-badge', { accountId: acc.id, count });
          this.notificationCounts.set(`${serviceId}-${acc.id}`, 0);
        }
      });
      if (hasUnread) {
        const icon = document.querySelector(`.service-icon[data-service="${serviceId}"]`);
        if (icon) {
          const badge = icon.querySelector('.notification-badge');
          if (badge) badge.classList.add('hidden');
          icon.classList.remove('has-notification');
          const markBtn = icon.querySelector('.mark-read-btn');
          if (markBtn) markBtn.classList.add('hidden');
        }
      }
    }
    this.updateWindowTitle();
  }

  updateWindowTitle() {
    let total = 0;
    for (const v of this.notificationCounts.values()) total += v;
    document.title = total > 0 ? `(${total}) Unified Comms` : 'Unified Comms';
    const markAllBtn = document.getElementById('mark-all-read-btn');
    if (markAllBtn) {
      if (total > 0) markAllBtn.classList.remove('hidden');
      else markAllBtn.classList.add('hidden');
    }
  }

  updateMemoryIndicator(data) {
    const el = document.getElementById('memory-value');
    el.textContent = `${data.heapUsed} MB`;
    this.devTools.recordMemory(data);
    el.style.color = data.heapUsed > 400 ? '#ff6b6b' : data.heapUsed > 250 ? '#ffa500' : '#5865f2';
  }

  async openSettings() {
    ipcRenderer.send('modal-open');
    await this.hideActiveView();
    document.getElementById('settings-modal').classList.remove('hidden');
    document.getElementById('destroy-views-toggle').checked = this.settings.destroyViewsOnSwitch;
    document.getElementById('hardware-accel-toggle').checked = this.settings.hardwareAcceleration;
    document.getElementById('memory-limit').value = this.settings.memoryLimit;
    document.getElementById('default-service').value = this.settings.defaultService;
    // Populate adblock + xblocker state from main
    const [adState, xbState] = await Promise.all([
      ipcRenderer.invoke('get-adblock-state'),
      ipcRenderer.invoke('get-xblocker-state'),
    ]);
    document.getElementById('adblock-settings-toggle').checked = adState.enabled;
    document.getElementById('xblocker-settings-toggle').checked = xbState.enabled;

    // Populate services on/off list
    const servicesList = document.getElementById('settings-services-list');
    if (servicesList) {
      const pngServices = ['gchat', 'outlook', 'teams'];
      servicesList.innerHTML = Object.entries(SERVICES).map(([sId, svc]) => {
        const ext = pngServices.includes(sId) ? 'png' : 'svg';
        const iconSrc = window.__assetBase ? `${window.__assetBase}/icons/${sId}.${ext}` : `../assets/icons/${sId}.${ext}`;
        const isDisabled = this.disabledServices.has(sId);
        return `
          <div class="settings-row">
            <div class="settings-row-info">
              <img src="${iconSrc}" width="16" height="16" style="object-fit:contain;flex-shrink:0;">
              <span class="settings-row-title">${svc.name}</span>
            </div>
            <label class="settings-toggle">
              <input type="checkbox" class="svc-settings-toggle" data-service="${sId}" ${isDisabled ? '' : 'checked'}>
              <span class="settings-toggle-track"><span class="settings-toggle-thumb"></span></span>
            </label>
          </div>`;
      }).join('');
      servicesList.querySelectorAll('.svc-settings-toggle').forEach(cb => {
        cb.addEventListener('change', () => this.toggleService(cb.dataset.service));
      });
    }
  }

  async saveSettings() {
    this.settings = {
      destroyViewsOnSwitch: document.getElementById('destroy-views-toggle').checked,
      hardwareAcceleration: document.getElementById('hardware-accel-toggle').checked,
      memoryLimit: parseInt(document.getElementById('memory-limit').value),
      defaultService: document.getElementById('default-service').value
    };
    await ipcRenderer.invoke('save-settings', this.settings);

    // Apply adblock toggle if it changed
    const adToggle = document.getElementById('adblock-settings-toggle');
    const [adState] = await Promise.all([ipcRenderer.invoke('get-adblock-state')]);
    if (adToggle.checked !== adState.enabled) {
      const result = await ipcRenderer.invoke('toggle-adblock');
      this.updateAdBlockBtn(result.enabled, adState.count);
    }

    // Apply xblocker toggle if it changed
    const xbToggle = document.getElementById('xblocker-settings-toggle');
    const xbState = await ipcRenderer.invoke('get-xblocker-state');
    if (xbToggle.checked !== xbState.enabled) {
      const result = await ipcRenderer.invoke('toggle-xblocker');
      this.updateXBlockerBtn(result.enabled, xbState.count);
    }

    document.getElementById('settings-modal').classList.add('hidden');
    await this.restoreActiveView();
  }

  async clearAllCaches() {
    for (const serviceId in this.accounts) {
      for (const account of this.accounts[serviceId]) {
        await ipcRenderer.invoke('clear-cache', account.partition);
      }
    }
    alert('All caches cleared');
  }

  async backupData() {
    const result = await ipcRenderer.invoke('backup-data');
    if (result.cancelled) return;
    if (result.error) { alert('Backup failed: ' + result.error); return; }
    alert(`Backup saved to:\n${result.path}`);
  }

  async restoreData() {
    const confirmed = confirm('Restore will overwrite your current sessions and settings.\nThe app will restart after restore.\n\nContinue?');
    if (!confirmed) return;
    const result = await ipcRenderer.invoke('restore-data');
    if (result.cancelled) return;
    if (result.error) { alert('Restore failed: ' + result.error); return; }
    // Trigger restart
    ipcRenderer.invoke('relaunch-app');
  }

  async openCleanStorage() {
    ipcRenderer.send('modal-open');
    await this.hideActiveView();
    const modal = document.getElementById('clean-storage-modal');
    modal.classList.remove('hidden');

    // Reset state
    document.getElementById('clean-storage-scanning').classList.remove('hidden');
    document.getElementById('clean-storage-empty').classList.add('hidden');
    document.getElementById('clean-storage-list').classList.add('hidden');
    document.getElementById('clean-storage-footer').classList.add('hidden');

    const items = await ipcRenderer.invoke('scan-junk');

    document.getElementById('clean-storage-scanning').classList.add('hidden');

    if (!items || items.length === 0) {
      document.getElementById('clean-storage-empty').classList.remove('hidden');
      return;
    }

    const list = document.getElementById('clean-storage-list');
    list.classList.remove('hidden');
    list.innerHTML = items.map((item, i) => `
      <label class="clean-item">
        <input type="checkbox" class="clean-item-check" data-index="${i}" checked>
        <span class="clean-item-icon">${item.type === 'dir' ? '📁' : '📄'}</span>
        <span class="clean-item-name" title="${item.path}">${item.name}</span>
        <span class="clean-item-size">${item.sizeMB < 1 ? (item.sizeMB * 1024).toFixed(0) + ' KB' : item.sizeMB.toFixed(1) + ' MB'}</span>
      </label>
    `).join('');

    const footer = document.getElementById('clean-storage-footer');
    footer.classList.remove('hidden');

    const updateTotal = () => {
      const checked = [...list.querySelectorAll('.clean-item-check:checked')];
      const total = checked.reduce((sum, cb) => sum + (items[+cb.dataset.index].sizeMB || 0), 0);
      document.getElementById('clean-storage-total').textContent =
        `${checked.length} item${checked.length !== 1 ? 's' : ''} — ${total.toFixed(1)} MB`;
    };
    updateTotal();
    list.querySelectorAll('.clean-item-check').forEach(cb => cb.addEventListener('change', updateTotal));

    document.getElementById('clean-storage-delete-btn').onclick = async () => {
      const checked = [...list.querySelectorAll('.clean-item-check:checked')];
      const toDelete = checked.map(cb => items[+cb.dataset.index]);
      if (toDelete.length === 0) return;

      const btn = document.getElementById('clean-storage-delete-btn');
      btn.disabled = true;
      btn.textContent = 'Deleting…';

      const { freedMB } = await ipcRenderer.invoke('delete-junk', toDelete);

      modal.classList.add('hidden');
      await this.restoreActiveView();
      alert(`Freed ${freedMB} MB of storage.`);
    };
  }

  showFirstTimeWizard() {
    ipcRenderer.send('modal-open');
    const modal = document.getElementById('wizard-modal');
    modal.classList.remove('hidden');
    document.getElementById('wizard-skip-btn').addEventListener('click', () => this.finishWizard());
    document.getElementById('wizard-next-btn').addEventListener('click', () => {
      document.getElementById('wizard-step-1').classList.remove('active');
      document.getElementById('wizard-step-2').classList.add('active');
    });
    document.getElementById('wizard-finish-btn').addEventListener('click', () => this.finishWizard());
  }

  finishWizard() {
    document.getElementById('wizard-modal').classList.add('hidden');
    ipcRenderer.send('modal-close');
    this.settings.firstTimeSetup = true;
    ipcRenderer.invoke('save-settings', this.settings);
    this.switchService(this.settings.defaultService || 'gmail');
  }

  showAccountContextMenu(serviceId, iconElement) {
    const isDisabled = this.disabledServices.has(serviceId);
    const accounts = this.accounts[serviceId] || [];
    const activeId = this.activeAccounts[serviceId];
    const service = SERVICES[serviceId];
    const accountCounts = {};
    accounts.forEach(acc => {
      accountCounts[acc.id] = this.notificationCounts.get(`${serviceId}-${acc.id}`) || 0;
    });

    // Remove any existing custom menu
    this.closeContextMenu();

    // Expand uiView to full window so the menu (which extends beyond 80px sidebar) is visible
    ipcRenderer.send('context-menu-open');
    document.body.classList.add('ccm-expanded');

    const iconRect = iconElement.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'custom-context-menu';
    menu.className = 'custom-context-menu';

    // Header
    const header = document.createElement('div');
    header.className = 'ccm-header';
    header.innerHTML = `<img src="${window.__assetBase ? window.__assetBase + '/icons/' + serviceId + (['gchat','outlook','teams'].includes(serviceId)?'.png':'.svg') : '../assets/icons/' + serviceId + (['gchat','outlook','teams'].includes(serviceId)?'.png':'.svg')}" class="ccm-header-icon"><span>${service.name}</span>`;
    menu.appendChild(header);

    if (isDisabled) {
      // Service is off — only show Turn On option
      const turnOnItem = document.createElement('div');
      turnOnItem.className = 'ccm-item ccm-action ccm-action-on';
      turnOnItem.innerHTML = `<span class="ccm-action-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18.36 6.64A9 9 0 1 1 5.64 5.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg></span><span>Turn On</span>`;
      turnOnItem.addEventListener('click', (e) => { e.stopPropagation(); this.closeContextMenu(); this.toggleService(serviceId); });
      menu.appendChild(turnOnItem);
    } else {
      // Account items
      accounts.forEach(acc => {
        const isAccOff = this.disabledAccounts && this.disabledAccounts.has(acc.id);
        const item = document.createElement('div');
        item.className = 'ccm-item' + (acc.id === activeId ? ' ccm-item-active' : '') + (isAccOff ? ' ccm-item-off' : '');
        const unread = accountCounts[acc.id] || 0;
        item.innerHTML = `
          <span class="ccm-check">${acc.id === activeId && !isAccOff ? '✓' : ''}</span>
          <span class="ccm-name" style="${isAccOff ? 'opacity:0.4;text-decoration:line-through;' : ''}">${acc.name}</span>
          ${unread > 0 && !isAccOff ? `<span class="ccm-badge">${unread}</span>` : ''}
          <button class="ccm-acc-toggle" title="${isAccOff ? 'Turn on account' : 'Turn off account'}" style="margin-left:6px;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18.36 6.64A9 9 0 1 1 5.64 5.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          </button>
        `;
        // Click on row = switch to account (only if on)
        item.addEventListener('click', (e) => {
          if (e.target.closest('.ccm-acc-toggle')) return;
          e.stopPropagation();
          if (isAccOff) return;
          this.closeContextMenu();
          this.switchService(serviceId, acc.id);
        });
        // Click on power button = toggle account
        item.querySelector('.ccm-acc-toggle').addEventListener('click', (e) => {
          e.stopPropagation();
          this.closeContextMenu();
          this.toggleAccount(serviceId, acc.id);
        });
        menu.appendChild(item);
      });

      // Separator
      const sep = document.createElement('div');
      sep.className = 'ccm-separator';
      menu.appendChild(sep);

      // Add account
      const addItem = document.createElement('div');
      addItem.className = 'ccm-item ccm-action';
      addItem.innerHTML = `<span class="ccm-action-icon">＋</span><span>Add Account</span>`;
      addItem.addEventListener('click', (e) => { e.stopPropagation(); this.closeContextMenu(); this.addNewAccount(serviceId); });
      menu.appendChild(addItem);

      // Manage accounts
      const manageItem = document.createElement('div');
      manageItem.className = 'ccm-item ccm-action';
      manageItem.innerHTML = `<span class="ccm-action-icon">⚙</span><span>Manage Accounts</span>`;
      manageItem.addEventListener('click', (e) => { e.stopPropagation(); this.closeContextMenu(); this.openAccountManagement(serviceId); });
      menu.appendChild(manageItem);

      // Separator + Turn Off
      const sep2 = document.createElement('div');
      sep2.className = 'ccm-separator';
      menu.appendChild(sep2);

      const turnOffItem = document.createElement('div');
      turnOffItem.className = 'ccm-item ccm-action ccm-action-off';
      turnOffItem.innerHTML = `<span class="ccm-action-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18.36 6.64A9 9 0 1 1 5.64 5.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg></span><span>Turn Off</span>`;
      turnOffItem.addEventListener('click', (e) => { e.stopPropagation(); this.closeContextMenu(); this.toggleService(serviceId); });
      menu.appendChild(turnOffItem);
    }

    // Position: to the right of the sidebar icon, below titlebar
    const menuTop = Math.max(4, iconRect.top);
    menu.style.top = menuTop + 'px';
    menu.style.left = (iconRect.right + 8) + 'px';

    document.body.appendChild(menu);

    // Clamp menu so it doesn't go off-screen bottom
    requestAnimationFrame(() => {
      const menuH = menu.offsetHeight;
      const winH = window.innerHeight;
      if (menuTop + menuH > winH - 8) {
        menu.style.top = Math.max(4, winH - menuH - 8) + 'px';
      }
    });

    // Close on outside click — use capture so it fires before anything else
    setTimeout(() => {
      this._ccmOutsideClick = (e) => {
        if (!menu.contains(e.target)) this.closeContextMenu();
      };
      document.addEventListener('click', this._ccmOutsideClick, true);
    }, 50);
  }

  closeContextMenu() {
    const existing = document.getElementById('custom-context-menu');
    if (existing) existing.remove();
    if (this._ccmOutsideClick) {
      document.removeEventListener('click', this._ccmOutsideClick, true);
      this._ccmOutsideClick = null;
    }
    // Shrink uiView back to sidebar width
    ipcRenderer.send('context-menu-close');
    document.body.classList.remove('ccm-expanded');
  }

  // Toggle a service on or off
  async toggleService(serviceId) {
    const wasDisabled = this.disabledServices.has(serviceId);
    if (wasDisabled) {
      // Turn ON
      this.disabledServices.delete(serviceId);
      this._applyServiceDisabledStyle(serviceId, false);
      await this._saveDisabledServices();
      // Switch to it now
      await this.switchService(serviceId);
    } else {
      // Turn OFF — destroy all views for this service
      this.disabledServices.add(serviceId);
      this._applyServiceDisabledStyle(serviceId, true);
      await this._saveDisabledServices();

      const accounts = this.accounts[serviceId] || [];
      for (const acc of accounts) {
        if (this.createdViews.has(acc.id)) {
          await ipcRenderer.invoke('destroy-view', { accountId: acc.id }).catch(() => {});
          this.createdViews.delete(acc.id);
        }
      }

      // If this was the active service, show its off-page
      if (this.currentService === serviceId) {
        this._showServiceOffPage(serviceId);
      }
    }
  }

  async _saveDisabledServices() {
    this.settings.disabledServices = Array.from(this.disabledServices);
    this.settings.disabledAccounts = Array.from(this.disabledAccounts);
    await ipcRenderer.invoke('save-settings', this.settings);
  }

  async toggleAccount(serviceId, accountId) {
    const wasOff = this.disabledAccounts.has(accountId);
    if (wasOff) {
      // Turn ON — remove from disabled, switch to it
      this.disabledAccounts.delete(accountId);
      await this._saveDisabledServices();
      await this.switchService(serviceId, accountId);
    } else {
      // Turn OFF — destroy view, remove from disabled set
      this.disabledAccounts.add(accountId);
      if (this.createdViews.has(accountId)) {
        await ipcRenderer.invoke('destroy-view', { accountId }).catch(() => {});
        this.createdViews.delete(accountId);
      }
      await this._saveDisabledServices();
      // If this was the active account, switch to next enabled account in service
      if (this.currentAccountId === accountId) {
        const next = (this.accounts[serviceId] || []).find(a => a.id !== accountId && !this.disabledAccounts.has(a.id));
        if (next) {
          await this.switchService(serviceId, next.id);
        } else {
          // All accounts in service are off — treat like service off
          this._showServiceOffPage(serviceId);
        }
      }
    }
  }

  _applyServiceDisabledStyle(serviceId, disabled) {
    const icon = document.querySelector(`.service-icon[data-service="${serviceId}"]`);
    if (!icon) return;
    icon.classList.toggle('service-disabled', disabled);
    const toggleBtn = icon.querySelector('.svc-toggle-btn');
    if (toggleBtn) {
      toggleBtn.title = disabled ? 'Turn on service' : 'Turn off service';
      toggleBtn.classList.toggle('svc-toggle-btn-on', disabled);
    }
  }

  _showServiceOffPage(serviceId) {
    const service = SERVICES[serviceId];
    // Expand uiView to full window width so #content-area is visible
    ipcRenderer.send('service-off-show');
    // Hide any active WebContentsView
    if (this.currentAccountId) {
      ipcRenderer.invoke('hide-view', { accountId: this.currentAccountId }).catch(() => {});
    }
    this.currentService = serviceId;
    this.currentAccountId = null;

    // Update sidebar active state
    document.querySelectorAll('.service-icon').forEach(icon => {
      icon.classList.toggle('active', icon.dataset.service === serviceId);
    });

    // Hide loading/error
    document.getElementById('loading-indicator').classList.add('hidden');
    document.getElementById('error-boundary').classList.add('hidden');

    const pngServices = ['gchat', 'outlook', 'teams'];
    const iconExt = pngServices.includes(serviceId) ? 'png' : 'svg';
    const iconSrc = window.__assetBase
      ? `${window.__assetBase}/icons/${serviceId}.${iconExt}`
      : `../assets/icons/${serviceId}.${iconExt}`;

    // Show or update the off-page — in #content-area, content area bounds only
    let offPage = document.getElementById('service-off-page');
    if (!offPage) {
      offPage = document.createElement('div');
      offPage.id = 'service-off-page';
      document.getElementById('content-area').appendChild(offPage);
    }
    offPage.innerHTML = `
      <div class="sop-inner">
        <img src="${iconSrc}" class="sop-icon">
        <div class="sop-name">${service.name}</div>
        <div class="sop-status">Service is turned off</div>
        <div class="sop-desc">
          This service is not running and uses no memory.<br>
          To turn it back on:
          <ul class="sop-tips">
            <li>Hover the icon in the sidebar and click the power button</li>
            <li>Right-click the icon → Turn On</li>
            <li>Use Settings → Services</li>
          </ul>
        </div>
        <button class="sop-turn-on-btn" id="sop-turn-on">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18.36 6.64A9 9 0 1 1 5.64 5.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
          Turn On ${service.name}
        </button>
      </div>
    `;
    offPage.classList.remove('hidden');
    document.getElementById('sop-turn-on').addEventListener('click', () => this.toggleService(serviceId));
  }

  _hideServiceOffPage() {
    const offPage = document.getElementById('service-off-page');
    if (!offPage || offPage.classList.contains('hidden')) return;
    offPage.classList.add('hidden');
    // Shrink uiView back to sidebar strip
    ipcRenderer.send('service-off-hide');
  }

  async addNewAccount(serviceId) {
    const newId = `${serviceId}-${Date.now()}`;
    const newAccount = {
      id: newId,
      name: `Account ${this.accounts[serviceId].length + 1}`,
      partition: `persist:${newId}`,
      isDefault: false,
      createdAt: Date.now()
    };
    this.accounts[serviceId].push(newAccount);
    await this.saveAccounts();
    this.switchService(serviceId, newId);
  }

  openAccountManagement(serviceId = null) {
    ipcRenderer.send('modal-open');
    this.hideActiveView();
    const modal = document.getElementById('account-management-modal');
    const content = document.getElementById('account-management-content');
    const servicesToShow = serviceId ? [serviceId] : Object.keys(SERVICES);
    let html = '';
    servicesToShow.forEach(sId => {
      const service = SERVICES[sId];
      const accounts = this.accounts[sId] || [];
      const activeId = this.activeAccounts[sId];
      const _pngServices = ['gchat', 'outlook', 'teams'];
      const _iconExt = _pngServices.includes(sId) ? 'png' : 'svg';
      const iconSrc = window.__assetBase ? `${window.__assetBase}/icons/${sId}.${_iconExt}` : `../assets/icons/${sId}.${_iconExt}`;
      html += `
        <div class="am-section">
          <div class="am-section-header">
            <img src="${iconSrc}" class="am-section-icon">
            <span class="am-section-title">${service.name}</span>
            <span class="am-section-count">${accounts.length} account${accounts.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="am-account-list">`;
      accounts.forEach(acc => {
        const isActive = acc.id === activeId;
        html += `
          <div class="am-account-item${isActive ? ' am-account-active' : ''}" data-account-id="${acc.id}" data-service-id="${sId}">
            <div class="am-account-avatar">${acc.name.charAt(0).toUpperCase()}</div>
            <div class="am-account-info">
              <div class="am-account-name">${acc.name}</div>
              <div class="am-account-badges">
                ${acc.isDefault ? '<span class="am-badge am-badge-default">Default</span>' : ''}
                ${isActive ? '<span class="am-badge am-badge-active">Active</span>' : ''}
              </div>
            </div>
            <div class="am-account-actions">
              <button class="am-btn" data-action="rename" title="Rename">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </button>
              ${!acc.isDefault ? `<button class="am-btn" data-action="set-default" title="Set as default">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </button>` : ''}
              ${accounts.length > 1 ? `<button class="am-btn am-btn-danger" data-action="delete" title="Delete">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
              </button>` : ''}
            </div>
          </div>`;
      });
      html += `</div>
          <button class="am-add-btn" data-service-id="${sId}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add ${service.name} Account
          </button>
        </div>`;
    });
    content.innerHTML = html;
    modal.classList.remove('hidden');
    content.querySelectorAll('.am-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = btn.closest('.am-account-item');
        const aid = item.dataset.accountId, sid = item.dataset.serviceId;
        if (btn.dataset.action === 'rename') this.renameAccount(sid, aid);
        else if (btn.dataset.action === 'set-default') this.setDefaultAccount(sid, aid);
        else if (btn.dataset.action === 'delete') this.deleteAccount(sid, aid);
      });
    });
    content.querySelectorAll('.am-add-btn').forEach(btn => {
      btn.addEventListener('click', () => { this.addNewAccount(btn.dataset.serviceId); modal.classList.add('hidden'); });
    });
  }

  async renameAccount(serviceId, accountId) {
    const account = this.getAccount(serviceId, accountId);
    if (!account) return;

    // Inline rename - find the account item and replace name with input
    const item = document.querySelector(`.am-account-item[data-account-id="${accountId}"]`);
    if (!item) return;

    const nameEl = item.querySelector('.am-account-name');
    const currentName = account.name;

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;
    input.style.cssText = 'background:#3a3a4a;border:1px solid #5865f2;border-radius:4px;color:#fff;padding:2px 6px;font-size:13px;width:120px;outline:none;';
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const confirm = async () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        account.name = newName;
        await this.saveAccounts();
        this.updateAccountBadge(serviceId, accountId);
      }
      this.openAccountManagement();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirm();
      if (e.key === 'Escape') this.openAccountManagement();
    });
    input.addEventListener('blur', confirm);
  }

  async setDefaultAccount(serviceId, accountId) {
    (this.accounts[serviceId] || []).forEach(a => a.isDefault = false);
    const acc = this.getAccount(serviceId, accountId);
    if (acc) { acc.isDefault = true; await this.saveAccounts(); this.openAccountManagement(); }
  }

  async deleteAccount(serviceId, accountId) {
    const acc = this.getAccount(serviceId, accountId);
    if (!acc) return;

    // Use IPC to show native confirm dialog
    const { response } = await ipcRenderer.invoke('show-confirm', {
      message: `Delete account "${acc.name}"?`,
      detail: 'This will remove the account and clear all its data.'
    });
    if (response !== 0) return;

    const isActive = this.currentAccountId === accountId;

    // If deleting the active account, switch away FIRST before any teardown
    if (isActive) {
      const remaining = (this.accounts[serviceId] || []).filter(a => a.id !== accountId);
      const nextAccount = remaining[0];
      if (nextAccount) {
        this.activeAccounts[serviceId] = nextAccount.id;
        await this.switchService(serviceId, nextAccount.id);
      }
    }

    // Now safe to remove from accounts list and destroy the view
    this.accounts[serviceId] = this.accounts[serviceId].filter(a => a.id !== accountId);
    if (this.activeAccounts[serviceId] === accountId) {
      this.activeAccounts[serviceId] = this.accounts[serviceId][0]?.id;
    }

    await ipcRenderer.invoke('destroy-view', { accountId });
    this.createdViews.delete(accountId);
    await ipcRenderer.invoke('clear-cache', acc.partition);
    await this.saveAccounts();
    this.openAccountManagement();
  }

  async openExtensions() {
    ipcRenderer.send('modal-open');
    await this.hideActiveView();
    document.getElementById('extensions-modal').classList.remove('hidden');
    await this.refreshExtensionsList();
  }

  async refreshExtensionsList() {
    const exts = await ipcRenderer.invoke('get-extensions');
    const list = document.getElementById('extensions-list');
    if (!exts.length) {
      list.innerHTML = '<p style="color:#a0a0a0;text-align:center;padding:20px 0">No extensions installed</p>';
      this.renderExtensionToolbar([]);
      return;
    }
    list.innerHTML = '';
    exts.forEach(ext => {
      const item = document.createElement('div');
      item.className = 'extension-item';
      item.innerHTML = `
        <div class="extension-info">
          <div class="ext-header">
            ${ext.iconUrl ? `<img class="ext-icon-sm" src="${ext.iconUrl}" onerror="this.style.display='none'">` : ''}
            <h3>${ext.name}</h3>
            <span class="ext-version">v${ext.version}</span>
          </div>
          ${ext.description ? `<p class="ext-desc">${ext.description}</p>` : ''}
        </div>
        <div class="ext-actions">
          ${ext.hasPopup ? `<button class="btn-secondary ext-popup-btn" data-id="${ext.id}" title="Open Extension Popup">Open</button>` : ''}
          <label class="ext-toggle" title="${ext.enabled ? 'Enabled' : 'Disabled'}">
            <input type="checkbox" class="ext-toggle-input" ${ext.enabled ? 'checked' : ''} data-id="${ext.id}">
            <span class="ext-toggle-slider"></span>
          </label>
          ${ext.hasOptions ? `<button class="btn-icon ext-options-btn" data-id="${ext.id}" title="Options">⚙</button>` : ''}
          <button class="btn-icon btn-danger remove-ext-btn" data-id="${ext.id}" title="Remove">🗑</button>
        </div>`;

      item.querySelector('.ext-toggle-input').addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        e.target.closest('.ext-toggle').title = enabled ? 'Enabled' : 'Disabled';
        await ipcRenderer.invoke('toggle-extension', { id: ext.id, enabled });
        this.renderExtensionToolbar(await ipcRenderer.invoke('get-extensions'));
      });

      item.querySelector('.remove-ext-btn').addEventListener('click', async () => {
        await ipcRenderer.invoke('remove-extension', ext.id);
        this.refreshExtensionsList();
      });

      const optBtn = item.querySelector('.ext-options-btn');
      if (optBtn) {
        optBtn.addEventListener('click', async () => {
          const result = await ipcRenderer.invoke('open-extension-options', { id: ext.id });
          if (!result.success) alert('This extension has no options page.');
        });
      }

      const popupBtn = item.querySelector('.ext-popup-btn');
      if (popupBtn) {
        popupBtn.addEventListener('click', (e) => {
          const rect = e.target.getBoundingClientRect();
          this.openExtensionPopup(ext.id, rect);
        });
      }

      list.appendChild(item);
    });

    this.renderExtensionToolbar(exts);
  }

  // Render small extension icons in the titlebar for quick popup access
  renderExtensionToolbar(exts) {
    let toolbar = document.getElementById('ext-toolbar');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = 'ext-toolbar';
      // Insert before the settings/extensions buttons
      const actions = document.querySelector('.titlebar-actions');
      actions.insertBefore(toolbar, actions.firstChild);
    }
    toolbar.innerHTML = '';
    const active = exts.filter(e => e.enabled && e.hasPopup);
    active.forEach(ext => {
      const btn = document.createElement('button');
      btn.className = 'titlebar-btn ext-toolbar-btn';
      btn.title = ext.name;
      btn.dataset.extId = ext.id;
      if (ext.iconUrl) {
        btn.innerHTML = `<img src="${ext.iconUrl}" width="16" height="16" onerror="this.parentElement.textContent='🧩'">`;
      } else {
        btn.textContent = '🧩';
      }
      btn.addEventListener('click', (e) => {
        const rect = btn.getBoundingClientRect();
        this.openExtensionPopup(ext.id, rect);
      });
      toolbar.appendChild(btn);
    });
  }

  async openExtensionPopup(extensionId, anchorRect) {
    console.log('openExtensionPopup called:', extensionId, anchorRect);
    const result = await ipcRenderer.invoke('activate-extension-popup', {
      extensionId,
      anchorRect: { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
    });
    console.log('activate-extension-popup result:', JSON.stringify(result));
    if (!result.success) {
      console.log('Extension popup failed:', result.reason || 'unknown');
    }
  }
}

// DOMContentLoaded may have already fired when injected via executeJavaScript
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.serviceManager = new ServiceManager();
  });
} else {
  window.serviceManager = new ServiceManager();
}

window.unifiedComms = {
  getCurrentService: () => window.serviceManager?.currentService || 'none',
  help: () => console.log('Type unifiedComms.getCurrentService()'),
};

console.log('%cUnified Comms Ready', 'color: #5865f2; font-weight: bold');
