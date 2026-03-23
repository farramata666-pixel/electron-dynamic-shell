# Quick Start Guide

## Installation

```bash
# Clone or download the project
cd unified-comms

# Install dependencies
npm install

# Start the application
npm start
```

## First Run

1. The app will open with Gmail as the default service
2. Click any service icon in the left sidebar to switch
3. Each service will load on first click (lazy loading)
4. Login to each service as needed

## Using Services

### Gmail
- Click the Gmail icon or press `Cmd/Ctrl+1`
- Login with your Google account
- Session persists across app restarts

### Outlook
- Click the Outlook icon or press `Cmd/Ctrl+2`
- Login with your Microsoft account
- Access Outlook.com or Office 365

### Slack
- Click the Slack icon or press `Cmd/Ctrl+3`
- Choose your workspace
- Multiple workspaces supported via Slack's interface

### Microsoft Teams
- Click the Teams icon or press `Cmd/Ctrl+4`
- Login with your Microsoft account
- Access all your teams and channels

### Telegram
- Click the Telegram icon or press `Cmd/Ctrl+5`
- Login with phone number
- Full Telegram Web features

### Discord
- Click the Discord icon or press `Cmd/Ctrl+6`
- Login with your Discord account
- Access all servers and DMs

## Installing Extensions

### Method 1: Via Menu
1. Go to Extensions > Load Extension
2. Select an unpacked extension folder
3. Extension loads immediately

### Method 2: Via Toolbar
1. Click the Extensions button (puzzle icon)
2. Click "Load Extension"
3. Browse to extension directory

### Popular Extensions to Try

**Grammarly**
- Download from Chrome Web Store as unpacked
- Helps with writing across all services

**Dark Reader**
- Forces dark mode on all services
- Reduces eye strain

**Bitwarden/1Password**
- Password manager integration
- Auto-fill across services

## Settings

Access via `Cmd/Ctrl+,` or Settings button:

### Performance Settings

**Destroy views on switch**
- Enabled: Lower memory, slower switching
- Disabled: Higher memory, instant switching
- Recommended: Disabled for <4GB RAM systems

**Hardware acceleration**
- Enabled: Better graphics performance
- Disabled: Lower GPU usage
- Recommended: Enabled unless GPU issues

**Memory limit**
- Set threshold for warnings
- Default: 500MB
- Adjust based on your system

**Default service**
- Choose which service loads on startup
- Saves time if you use one service primarily

### Cache Management

Click "Clear All Caches" to:
- Free up disk space
- Fix loading issues
- Reset service states

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+1` | Switch to Gmail |
| `Cmd/Ctrl+2` | Switch to Outlook |
| `Cmd/Ctrl+3` | Switch to Slack |
| `Cmd/Ctrl+4` | Switch to Teams |
| `Cmd/Ctrl+5` | Switch to Telegram |
| `Cmd/Ctrl+6` | Switch to Discord |
| `Cmd/Ctrl+,` | Open Settings |
| `Cmd/Ctrl+R` | Reload current service |
| `Cmd/Ctrl+Q` | Quit application |

## Memory Monitoring

The sidebar footer shows current memory usage:
- **Blue**: Normal (<60% of limit)
- **Orange**: Warning (60-80% of limit)
- **Red**: High (>80% of limit)

If memory is high:
1. Enable "Destroy views on switch"
2. Clear caches
3. Close unused services
4. Restart the app

## Building for Distribution

### macOS
```bash
npm run build:mac
```
Output: `dist/Unified Comms.dmg`

### Windows
```bash
npm run build:win
```
Output: `dist/Unified Comms Setup.exe`

### Linux
```bash
npm run build:linux
```
Output: `dist/Unified Comms.AppImage`

## Troubleshooting

### Service won't load
1. Check internet connection
2. Try reloading: `Cmd/Ctrl+R`
3. Clear cache in Settings
4. Restart the app

### Login issues
1. Clear cache for that service
2. Try logging in via browser first
3. Check if service is down
4. Disable extensions temporarily

### Extension not working
1. Ensure it's Manifest V2 compatible
2. Check extension permissions
3. Reload the extension
4. Try a different extension version

### High memory usage
1. Enable "Destroy views on switch"
2. Close unused services
3. Clear caches
4. Reduce number of active services

### App won't start
1. Delete `node_modules` and reinstall
2. Check Node.js version (14+ required)
3. Try `npm start` from terminal
4. Check for error messages

## Tips & Tricks

1. **Use keyboard shortcuts** for fastest switching
2. **Enable view destruction** if you have limited RAM
3. **Install Dark Reader** for consistent dark mode
4. **Clear caches weekly** for best performance
5. **Set default service** to your most-used app
6. **Monitor memory** to optimize settings
7. **Use extensions sparingly** to reduce overhead

## Support

For issues or questions:
1. Check IMPLEMENTATION_NOTES.md
2. Review error messages in DevTools
3. Check GitHub issues
4. Create a new issue with details
