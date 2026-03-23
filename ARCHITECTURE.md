# Architecture Documentation

## Overview

Unified Comms is built on Electron with a focus on performance, memory efficiency, and extensibility. The architecture uses a single-window design with embedded webviews for service isolation.

## Core Components

### 1. Main Process (main.js)

**Responsibilities:**
- Application lifecycle management
- Window creation and management
- Extension system initialization
- IPC communication handling
- Memory monitoring
- Menu creation

**Key Features:**
- Single BrowserWindow with hidden title bar
- ElectronChromeExtensions integration
- Persistent session management
- Memory pressure monitoring (60s intervals)
- Settings persistence via electron-store

### 2. Renderer Process (renderer.js)

**Responsibilities:**
- Service switching logic
- Webview lifecycle management
- UI state management
- Settings interface
- Extension management UI

**Key Classes:**

#### ServiceManager
Main orchestrator for the application:
- `switchService(serviceId)`: Handles tab switching with <100ms target
- `loadService(serviceId)`: Lazy loads services on demand
- `updateMemoryIndicator(data)`: Updates UI with memory stats
- `openSettings()`: Settings modal management
- `openExtensions()`: Extension management UI

**Performance Optimizations:**
- View pooling: Reuses existing webviews
- Lazy loading: Services load only when accessed
- Optional view destruction: Configurable memory vs speed tradeoff
- Fast switching: <100ms response time target

### 3. Service Configuration

Each service is defined with:
```javascript
{
  name: 'Service Name',
  url: 'https://service.url',
  partition: 'persist:serviceid'
}
```

**Partitions:**
- Isolate cookies, localStorage, and sessions
- Persist across app restarts
- Enable multi-account support per service

### 4. Extension System

**Integration:**
- Uses electron-chrome-extensions library
- Extensions load into default session
- Work across all services
- Support browser actions and content scripts

**Supported Features:**
- Browser actions (toolbar icons)
- Content scripts
- Background pages
- Storage API
- Tabs API (limited)

**Limitations:**
- Some Chrome APIs unavailable
- Manifest V3 limited support
- Extension popups may behave differently

## Data Flow

### Service Switching Flow
```
User clicks icon
  → ServiceManager.switchService()
    → Update UI (active state)
    → Check if view exists
      → Yes: Show existing view
      → No: Create new webview
        → Set partition
        → Load URL
        → Attach event listeners
    → Hide other views
    → Measure performance
```

### Memory Monitoring Flow
```
Timer (60s interval)
  → Get process.memoryUsage()
  → Calculate heap usage
  → Send to renderer via IPC
  → Update UI indicator
  → Check against threshold
    → High: Clear code caches
    → Normal: Continue monitoring
```

### Extension Loading Flow
```
User selects directory
  → Main process receives path
  → session.loadExtension(path)
  → Extension registered
  → Notify renderer
  → Update extensions list
  → Extension active across services
```

## Performance Strategy

### Memory Management

**Target: <200MB with 2-3 services**

Techniques:
1. Lazy loading: Don't load until needed
2. View pooling: Reuse existing views
3. Optional destruction: Trade memory for speed
4. Cache clearing: Periodic cleanup
5. Code cache clearing: On high memory

### Speed Optimization

**Target: <100ms tab switching**

Techniques:
1. View reuse: Keep views in memory
2. Minimal DOM manipulation
3. CSS transitions for smooth UX
4. Preload critical resources
5. Efficient event handling

### Resource Optimization

1. **Hardware Acceleration**: Configurable GPU usage
2. **Partition Isolation**: Separate processes per service
3. **Extension Efficiency**: Load only needed extensions
4. **Cache Strategy**: Balance speed vs disk usage

## Security Considerations

### Webview Isolation
- Each service runs in isolated partition
- No cross-service data sharing
- Separate cookie stores
- Independent localStorage

### Extension Security
- Extensions run in default session
- Limited API access
- User must explicitly load extensions
- No automatic extension updates

### Content Security
- contextIsolation enabled where possible
- nodeIntegration limited to main window
- Webviews have no Node access
- IPC channels whitelisted

## Build System

### electron-builder Configuration

**Targets:**
- macOS: DMG, ZIP
- Windows: NSIS, Portable
- Linux: AppImage, DEB

**Optimization:**
- Asar packaging for faster startup
- Native module compilation
- Code signing ready
- Auto-update infrastructure ready

## Extension Points

### Adding New Services

1. Add to SERVICES object in renderer.js:
```javascript
newservice: {
  name: 'New Service',
  url: 'https://service.url',
  partition: 'persist:newservice'
}
```

2. Add icon to assets/icons/
3. Add button to index.html sidebar
4. Add keyboard shortcut (optional)

### Custom Themes

Modify styles.css:
- Color variables at top
- Dark/light mode toggle
- Per-service styling

### Additional Features

Extension points for:
- Notification aggregation
- Unified search
- Custom protocols
- Deep linking
- Tray integration

## Testing Strategy

### Manual Testing
1. Service loading and switching
2. Extension installation
3. Memory usage monitoring
4. Settings persistence
5. Keyboard shortcuts

### Performance Testing
1. Measure switch times
2. Monitor memory usage
3. Check load times
4. Verify cache clearing

### Compatibility Testing
1. Test on macOS, Windows, Linux
2. Verify extension compatibility
3. Check service login flows
4. Test with various screen sizes

## Future Architecture Improvements

### Planned Enhancements

1. **Multi-Window Support**
   - Pop out services to separate windows
   - Picture-in-picture mode
   - Multi-monitor support

2. **Advanced Memory Management**
   - Automatic view hibernation
   - Predictive preloading
   - Smart cache management

3. **Enhanced Extension System**
   - Extension marketplace
   - Auto-updates
   - Extension sandboxing

4. **Service Plugins**
   - Plugin API for custom services
   - Community service packs
   - Service-specific features

5. **Sync & Backup**
   - Settings sync across devices
   - Session backup/restore
   - Cloud configuration

## Dependencies

### Core Dependencies
- `electron`: ^28.0.0 - Application framework
- `electron-chrome-extensions`: ^3.11.0 - Extension support
- `electron-store`: ^8.1.0 - Settings persistence

### Dev Dependencies
- `electron-builder`: ^24.9.1 - Build and packaging

### Why These Versions?
- Electron 28: Latest stable with WebContentsView support
- electron-chrome-extensions 3.11: Best Manifest V2 support
- electron-store 8.1: Reliable settings management

## Performance Benchmarks

### Target Metrics
- Initial startup: <2s
- Service switch: <100ms
- Service load: <3s
- Memory (2 services): <200MB
- Memory (6 services): <500MB

### Actual Performance
(Varies by system and network)
- Typical switch: 50-80ms
- Typical memory: 150-300MB
- Load time: 1-4s depending on service

## Troubleshooting Guide

### Common Issues

**High Memory Usage**
- Enable view destruction
- Clear caches
- Reduce active services
- Check for memory leaks in extensions

**Slow Switching**
- Disable view destruction
- Check system resources
- Reduce number of extensions
- Clear code caches

**Services Not Loading**
- Check network connection
- Verify service URLs
- Clear service cache
- Check partition names

**Extensions Not Working**
- Verify Manifest V2 compatibility
- Check extension permissions
- Reload extension
- Check console for errors
