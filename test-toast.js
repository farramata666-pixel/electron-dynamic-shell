// Standalone test: run with `electron test-toast.js`
// This bypasses all service logic and directly tests the toast window
const { app, BrowserWindow } = require('electron');
const path = require('path');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.unified-comms.app');
}

app.whenReady().then(() => {
  const { screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  console.log('[test-toast] screen size:', width, 'x', height);
  console.log('[test-toast] toast will appear at:', width - 375, height - 195);

  const toastWin = new BrowserWindow({
    width: 360, height: 180,
    x: width - 375, y: height - 195,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  toastWin.loadFile('src/notification-toast.html');
  toastWin.setAlwaysOnTop(true, 'screen-saver');

  toastWin.webContents.on('did-finish-load', () => {
    console.log('[test-toast] toast loaded, sending test data...');
    toastWin.webContents.send('toast-data', {
      iconPath: `file:///${path.join(__dirname, 'assets', 'icons', 'discord.svg').replace(/\\/g, '/')}`,
      serviceName: 'Discord',
      sender: 'Jerry James',
      receiver: 'You',
      body: 'Hey, are you there?',
      unreadCount: 3,
    });
    toastWin.show();
    toastWin.setAlwaysOnTop(true, 'screen-saver');
    console.log('[test-toast] show() called');
  });

  toastWin.webContents.on('console-message', (e, level, msg) => {
    console.log('[toast-html]', msg);
  });

  // Also open devtools on the toast to inspect it
  setTimeout(() => {
    if (!toastWin.isDestroyed()) {
      toastWin.webContents.openDevTools({ mode: 'detach' });
    }
  }, 1000);

  // Quit after 10s
  setTimeout(() => app.quit(), 10000);
});
