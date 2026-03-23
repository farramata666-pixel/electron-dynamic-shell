// Development tools for debugging and performance monitoring

class DevTools {
  constructor() {
    this.metrics = {
      switchTimes: [],
      memorySnapshots: [],
      loadTimes: {}
    };
  }

  // Measure tab switch performance
  measureSwitch(serviceId, startTime) {
    const duration = performance.now() - startTime;
    this.metrics.switchTimes.push({
      service: serviceId,
      duration,
      timestamp: Date.now()
    });

    console.log(`[DevTools] Switch to ${serviceId}: ${duration.toFixed(2)}ms`);
    
    if (duration > 100) {
      console.warn(`[DevTools] Slow switch detected: ${duration.toFixed(2)}ms`);
    }

    return duration;
  }

  // Track memory usage
  recordMemory(data) {
    this.metrics.memorySnapshots.push({
      ...data,
      timestamp: Date.now()
    });

    // Keep only last 100 snapshots
    if (this.metrics.memorySnapshots.length > 100) {
      this.metrics.memorySnapshots.shift();
    }
  }

  // Measure service load time
  measureLoad(serviceId, startTime) {
    const duration = performance.now() - startTime;
    this.metrics.loadTimes[serviceId] = duration;

    console.log(`[DevTools] ${serviceId} loaded in ${duration.toFixed(2)}ms`);
    
    return duration;
  }

  // Get performance report
  getReport() {
    const avgSwitchTime = this.metrics.switchTimes.length > 0
      ? this.metrics.switchTimes.reduce((sum, m) => sum + m.duration, 0) / this.metrics.switchTimes.length
      : 0;

    const recentMemory = this.metrics.memorySnapshots.slice(-10);
    const avgMemory = recentMemory.length > 0
      ? recentMemory.reduce((sum, m) => sum + m.heapUsed, 0) / recentMemory.length
      : 0;

    return {
      averageSwitchTime: avgSwitchTime.toFixed(2) + 'ms',
      averageMemory: avgMemory.toFixed(2) + 'MB',
      totalSwitches: this.metrics.switchTimes.length,
      loadedServices: Object.keys(this.metrics.loadTimes),
      loadTimes: this.metrics.loadTimes,
      recentSwitches: this.metrics.switchTimes.slice(-10)
    };
  }

  // Export metrics to console
  exportMetrics() {
    console.table(this.getReport());
    console.log('Full metrics:', this.metrics);
  }

  // Check if performance targets are met
  checkTargets() {
    const report = this.getReport();
    const avgSwitch = parseFloat(report.averageSwitchTime);
    const avgMem = parseFloat(report.averageMemory);

    const results = {
      switchTime: {
        target: 100,
        actual: avgSwitch,
        passed: avgSwitch < 100
      },
      memory: {
        target: 200,
        actual: avgMem,
        passed: avgMem < 200
      }
    };

    console.log('[DevTools] Performance Targets:');
    console.table(results);

    return results;
  }

  // Reset all metrics
  reset() {
    this.metrics = {
      switchTimes: [],
      memorySnapshots: [],
      loadTimes: {}
    };
    console.log('[DevTools] Metrics reset');
  }
}

// Export for use in renderer
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DevTools;
}
