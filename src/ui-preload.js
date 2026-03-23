// Preload for the UI WebContentsView — runs in Node context before page scripts
// This ensures renderer.js has full Node/IPC access regardless of script loading quirks
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// Make ipcRenderer available globally for renderer.js
window.ipcRenderer = ipcRenderer;

// Ensure require is available in the page context
window.__nodeRequire = require;
