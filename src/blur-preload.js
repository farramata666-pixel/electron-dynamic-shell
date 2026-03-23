// Preload for service WebContentsViews
// Bridges blur settings updates from main process → content script
const { ipcRenderer } = require('electron');

ipcRenderer.on('blur-settings-updated', function(event, settings) {
  if (typeof window.__hbUpdateSettings === 'function')
    window.__hbUpdateSettings(settings);
});
