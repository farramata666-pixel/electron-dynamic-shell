// Console helpers for debugging and development
// Access these via browser DevTools console

window.unifiedComms = {
  // Get current service
  getCurrentService() {
    return window.serviceManager?.currentService || 'none';
  },

  // List all loaded services
  getLoadedServices() {
    const services = window.serviceManager?.loadedViews || new Map();
    return Array.from(services.keys());
  },

  // Get performance report
  getPerformance() {
    return window.devTools?.getReport() || 'DevTools not initialized';
  },

  // Check performance targets
  checkTargets() {
    return window.devTools?.checkTargets() || 'DevTools not initialized';
  },

  // Export all metrics
  exportMetrics() {
    window.devTools?.exportMetrics();
  },

  // Reset metrics
  resetMetrics() {
    window.devTools?.reset();
  },

  // Get current settings
  getSettings() {
    return window.serviceManager?.settings || {};
  },

  // Force garbage collection (if available)
  gc() {
    if (global.gc) {
      global.gc();
      console.log('Garbage collection triggered');
    } else {
      console.log('GC not available. Start with --expose-gc flag');
    }
  },

  // Get memory info
  getMemory() {
    if (process && process.memoryUsage) {
      const mem = process.memoryUsage();
      return {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
        rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
        external: Math.round(mem.external / 1024 / 1024) + ' MB'
      };
    }
    return 'Memory info not available';
  },

  // Reload current service
  reloadService() {
    const current = this.getCurrentService();
    if (current !== 'none') {
      const view = window.serviceManager?.loadedViews.get(current);
      if (view && view.reload) {
        view.reload();
        console.log(`Reloaded ${current}`);
      } else {
        console.log('Cannot reload - view not found or reload not available');
      }
    } else {
      console.log('No service currently loaded');
    }
  },

  // Clear cache for current service
  async clearCurrentCache() {
    const { ipcRenderer } = require('electron');
    const current = this.getCurrentService();
    if (current !== 'none') {
      const SERVICES = {
        gmail: 'persist:gmail',
        outlook: 'persist:outlook',
        slack: 'persist:slack',
        teams: 'persist:teams',
        telegram: 'persist:telegram',
        discord: 'persist:discord'
      };
      const partition = SERVICES[current];
      if (partition) {
        await ipcRenderer.invoke('clear-cache', partition);
        console.log(`Cache cleared for ${current}`);
      }
    } else {
      console.log('No service currently loaded');
    }
  },

  // Help command
  help() {
    console.log(`
Unified Comms Console Helpers
==============================

Available commands:

  unifiedComms.getCurrentService()    - Get current active service
  unifiedComms.getLoadedServices()    - List all loaded services
  unifiedComms.getPerformance()       - Get performance metrics
  unifiedComms.checkTargets()         - Check if targets are met
  unifiedComms.exportMetrics()        - Export all metrics to console
  unifiedComms.resetMetrics()         - Reset performance metrics
  unifiedComms.getSettings()          - Get current settings
  unifiedComms.getMemory()            - Get memory usage info
  unifiedComms.reloadService()        - Reload current service
  unifiedComms.clearCurrentCache()    - Clear cache for current service
  unifiedComms.gc()                   - Force garbage collection
  unifiedComms.help()                 - Show this help

DevTools direct access:

  window.devTools                     - DevTools instance
  window.serviceManager               - ServiceManager instance

Examples:

  // Check performance
  unifiedComms.getPerformance()
  
  // See if targets are met
  unifiedComms.checkTargets()
  
  // Get memory usage
  unifiedComms.getMemory()
  
  // Reload current service
  unifiedComms.reloadService()
    `);
  }
};

// Auto-display help on load
console.log('%cUnified Comms Developer Console', 'font-size: 16px; font-weight: bold; color: #5865f2;');
console.log('%cType unifiedComms.help() for available commands', 'color: #a0a0a0;');
