const { ipcRenderer } = require('electron');

let settings = { enabled: true, blurAmount: 20, gray: false };
let saveTimer = null;

// accountId is passed via query string: blur-popup.html?accountId=gmail-1
const accountId = new URLSearchParams(window.location.search).get('accountId') || '';
console.log('[BlurPopup] accountId:', JSON.stringify(accountId));

// Load settings + exclusion state in parallel
Promise.all([
  ipcRenderer.invoke('blur-get-settings'),
  accountId
    ? ipcRenderer.invoke('blur-get-excluded', { accountId })
    : Promise.resolve({ excluded: false })
]).then(([saved, { excluded }]) => {
  if (saved) Object.assign(settings, saved);
  applyToUI();
  setupExcludeButton(excluded);
}).catch(e => console.error('[BlurPopup] init error:', e.message));

// Keep checkbox in sync when Alt+L fires while popup is open
ipcRenderer.on('blur-settings-changed', (event, s) => {
  Object.assign(settings, s);
  document.getElementById('enabled-toggle').checked = settings.enabled;
});

function applyToUI() {
  document.getElementById('enabled-toggle').checked = settings.enabled;
  document.getElementById('blur-amount').value = settings.blurAmount;
  document.getElementById('blur-val').textContent = settings.blurAmount + 'px';
  document.getElementById('gray-toggle').checked = !!settings.gray;
}

function setupExcludeButton(isExcluded) {
  const footer = document.getElementById('footer-section');
  const btn    = document.getElementById('exclude-btn');
  const label  = document.getElementById('service-label');
  const hint   = document.getElementById('exclude-hint');

  if (!accountId) {
    footer.style.display = 'none';
    return;
  }

  // e.g. "gmail-1" → "gmail"
  const displayName = accountId.replace(/-\d+$/, '');
  label.textContent = displayName.charAt(0).toUpperCase() + displayName.slice(1);
  footer.classList.add('visible');

  renderBtn(isExcluded);

  btn.addEventListener('click', async () => {
    // "apply" class means currently excluded → clicking re-applies blur
    const currentlyExcluded = btn.classList.contains('apply');
    const next = !currentlyExcluded;
    await ipcRenderer.invoke('blur-set-excluded', { accountId, excluded: next });
    renderBtn(next);
  });

  function renderBtn(excluded) {
    if (excluded) {
      btn.textContent  = '✓ Apply blur to this service';
      btn.className    = 'exclude-btn apply';
      hint.textContent = 'Blur is currently OFF for this service';
    } else {
      btn.textContent  = '✕ Remove blur from this service';
      btn.className    = 'exclude-btn remove';
      hint.textContent = 'Click to turn off blur for this service only';
    }
  }
}

// ── Settings controls ─────────────────────────────────────────────────────────

function save() { ipcRenderer.invoke('blur-save-settings', settings); }
function debouncedSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 150); }

document.getElementById('enabled-toggle').addEventListener('change', e => {
  settings.enabled = e.target.checked;
  save();
});

document.getElementById('blur-amount').addEventListener('input', e => {
  settings.blurAmount = parseInt(e.target.value);
  document.getElementById('blur-val').textContent = e.target.value + 'px';
  debouncedSave();
});

document.getElementById('gray-toggle').addEventListener('change', e => {
  settings.gray = e.target.checked;
  save();
});

document.getElementById('close-btn').addEventListener('click', () => window.close());
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.close(); });
