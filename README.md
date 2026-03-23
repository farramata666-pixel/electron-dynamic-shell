# Unified Comms

A lightweight, unified communication hub that combines Gmail, Google Chat, Outlook, Slack, Microsoft Teams, Telegram, Discord, and WhatsApp in a single Electron application with Chrome extension support.

## Features

- **Single Window Architecture**: Uses WebContentsView for efficient memory management
- **Multi-Account Support**: Run multiple accounts per service, switch with right-click
- **Persistent Sessions**: Each account maintains its own isolated login session
- **Lazy Loading**: Services load only when accessed
- **Ad Blocker**: Built-in ad and tracker blocking via Ghostery
- **XBlocker**: NSFW image filtering powered by TensorFlow.js + nsfwjs
- **Blur Mode**: Privacy overlay to hide sensitive content on screen
- **Chrome Extensions**: Install and use browser extensions like Grammarly, Dark Reader
- **Keyboard Shortcuts**: Quick switching with Cmd/Ctrl+1-8
- **Memory Monitoring**: Real-time memory usage tracking
- **Performance Optimized**: Target <200MB RAM with 2-3 services open
- **Cross-Platform**: Works on macOS, Windows, and Linux
- **Embedded Backend**: Bundled Node.js server starts automatically with the app

## Installation

```bash
# Install all dependencies (Electron app + backend server)
npm install

# Start the app (launches Electron UI + backend server together)
npm start

# Build for your platform
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

> `npm install` automatically installs dependencies for both the root and the `server/` directory via a `postinstall` hook.

## Backend Server

The app includes an embedded Node.js backend (`server/`) that starts automatically when you run `npm start`. It runs as a child process of the Electron main process and is shut down cleanly when the app closes.

- Default port: **4000** (configurable via `PORT` in `server/.env`)
- Server logs appear in the console prefixed with `[Server]`

To configure the server, create a `server/.env` file:

```env
PORT=4000
NODE_ENV=development
```

## Usage

### Switching Services

- Click service icons in the left sidebar
- Use keyboard shortcuts: Cmd/Ctrl+1-8
- Services load on-demand for better performance

### Multi-Account

- Right-click any sidebar icon to switch accounts or add a new one
- Cmd/Ctrl+Shift+1-8 cycles through accounts for that service
- Each account has its own isolated session (cookies, localStorage, etc.)

### Installing Extensions

1. Click the Extensions button in the title bar
2. Click "Load Unpacked" and select an extension directory, or use "Chrome Web Store" to download one
3. Extension will be active across all services

### Settings

Access via Cmd/Ctrl+, or the settings button:

- **Destroy views on switch**: Saves memory by destroying inactive views
- **Hardware acceleration**: Toggle GPU rendering
- **Memory limit**: Max heap threshold before cleanup
- **Default service**: Which service opens on launch
- **Ad Blocker / XBlocker**: Toggle privacy features per-session

## Service URLs

- **Gmail**: https://mail.google.com
- **Google Chat**: https://mail.google.com/chat
- **Outlook**: https://outlook.live.com
- **Slack**: https://app.slack.com/client
- **Teams**: https://teams.live.com
- **Telegram**: https://web.telegram.org
- **Discord**: https://discord.com/app
- **WhatsApp**: https://web.whatsapp.com

## Architecture

### Main Process (src/main.js)
- Window management via `BaseWindow` + `WebContentsView`
- Embedded backend server lifecycle (spawn + kill)
- Extension system via `electron-chrome-extensions`
- Ad blocking via `@ghostery/adblocker-electron`
- NSFW filtering via `nsfwjs` + TensorFlow.js
- IPC communication and session management

### Renderer Process (src/renderer.js)
- `ServiceManager` class handles service/account switching
- Notification badge tracking per account
- Settings, extensions, and account management UI
- Responsive layout scaling

### Backend Server (server/)
- Express.js REST API
- MongoDB via Mongoose
- JWT authentication via Passport
- Runs on port 4000 by default

### Key Technologies
- Electron 33+
- electron-chrome-extensions
- electron-store
- @ghostery/adblocker-electron
- nsfwjs + TensorFlow.js
- Express + Mongoose

## Performance Tips

1. Enable "Destroy views on switch" to reduce memory usage
2. Clear caches periodically from Settings
3. Monitor memory usage in the sidebar
4. Disable services you don't use via the power button on each sidebar icon

## Troubleshooting

### Service won't load
- Check your internet connection
- Try clearing cache in Settings
- Reload the service with the reload button

### High memory usage
- Enable "Destroy views on switch"
- Clear caches from Settings
- Disable unused services

### Extensions not working
- Ensure the extension is Manifest V2 compatible
- Check extension permissions
- Reload the extension from the Extensions panel

### Server not starting
- Check that `server/node_modules` exists (run `npm install` from root)
- Check for a port conflict on 4000 — set a different `PORT` in `server/.env`
- Server logs are visible in the terminal prefixed with `[Server]`

## License

MIT
