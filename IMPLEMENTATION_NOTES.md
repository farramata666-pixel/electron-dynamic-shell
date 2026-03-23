# Implementation Notes

## Architecture Overview

This Electron app uses a hybrid approach for maximum compatibility:

### Webview-Based Implementation (Current)
- Uses `<webview>` tags for service embedding
- Better compatibility across Electron versions
- Simpler state management
- Each service runs in isolated partition

### Key Design Decisions

1. **Webview vs BrowserView**
   - Webview chosen for easier DOM manipulation
   - BrowserView available for advanced use cases
   - Both support persistent partitions

2. **Memory Management**
   - Lazy loading: Services load only when clicked
   - Optional view destruction on tab switch
   - Periodic cache clearing
   - Memory monitoring every 60 seconds

3. **Extension Support**
   - Uses electron-chrome-extensions
   - Extensions work across all services
   - Load unpacked extensions via dialog
   - Extension state persists across restarts

## Performance Optimizations

### Implemented
- Lazy service loading
- View pooling (reuse existing views)
- Configurable view destruction
- Hardware acceleration toggle
- Code cache clearing
- Memory pressure monitoring

### Target Metrics
- RAM usage: <200MB with 2-3 services
- Tab switch: <100ms response time
- Initial load: <2 seconds

## Service Configurations

Each service uses a persistent partition:
- `persist:gmail` - Gmail session
- `persist:outlook` - Outlook session
- `persist:slack` - Slack session
- `persist:teams` - Teams session
- `persist:telegram` - Telegram session
- `persist:discord` - Discord session

## Extension Integration

Extensions are loaded into the default session and work across all services.

### Supported Extensions
- Grammarly
- Dark Reader
- Password managers (1Password, LastPass, Bitwarden)
- Ad blockers
- Most Chrome extensions

### Loading Extensions
1. Menu: Extensions > Load Extension
2. Select unpacked extension directory
3. Extension appears in toolbar
4. Works across all services

## Keyboard Shortcuts

- `Cmd/Ctrl+1` - Gmail
- `Cmd/Ctrl+2` - Outlook
- `Cmd/Ctrl+3` - Slack
- `Cmd/Ctrl+4` - Teams
- `Cmd/Ctrl+5` - Telegram
- `Cmd/Ctrl+6` - Discord
- `Cmd/Ctrl+,` - Settings

## Build Configuration

### macOS
- DMG and ZIP formats
- Code signing ready
- Notarization ready

### Windows
- NSIS installer
- Portable executable
- Auto-update ready

### Linux
- AppImage (universal)
- DEB package (Debian/Ubuntu)

## Future Enhancements

1. **Search Across Services**
   - Implement unified search
   - Index service content
   - Quick switcher

2. **Notification Aggregation**
   - Unified notification center
   - Badge counts per service
   - System tray integration

3. **Custom Themes**
   - Light/dark mode toggle
   - Custom color schemes
   - Per-service themes

4. **Advanced Features**
   - Multi-account support
   - Service-specific settings
   - Backup/restore sessions
   - Deep linking support

## Troubleshooting

### Webview not loading
- Ensure `webviewTag: true` in webPreferences
- Check partition names are correct
- Verify service URLs are accessible

### Extensions not working
- Check electron-chrome-extensions version
- Ensure extension is Manifest V2 compatible
- Some extensions may need additional permissions

### High memory usage
- Enable "Destroy views on switch"
- Clear caches regularly
- Reduce number of active services
- Disable hardware acceleration if GPU issues

### Build issues
- Run `npm install` to ensure all dependencies
- Check Node.js version (14+ required)
- Verify electron-builder configuration
