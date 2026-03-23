# Installation Guide

## Prerequisites

- Node.js 14 or higher
- npm or yarn
- Git (optional)

## Quick Install

```bash
# Navigate to project directory
cd unified-comms

# Install dependencies
npm install

# Start the application
npm start
```

## Detailed Installation Steps

### 1. Install Node.js

**macOS:**
```bash
brew install node
```

**Windows:**
Download from https://nodejs.org

**Linux:**
```bash
sudo apt install nodejs npm
```

### 2. Install Dependencies

```bash
npm install
```

This installs:
- Electron 28
- electron-chrome-extensions
- electron-store
- electron-builder (dev)

### 3. Run the Application

```bash
npm start
```

The app will open with Gmail as the default service.

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

## Troubleshooting Installation

### npm install fails
```bash
# Clear cache and retry
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

### Build fails
```bash
# Ensure electron-builder is installed
npm install --save-dev electron-builder
```

### App won't start
```bash
# Check Node version
node --version  # Should be 14+

# Try verbose mode
npm start --verbose
```

## Next Steps

After installation:
1. Read QUICK_START.md for usage guide
2. Open DevTools to access console helpers
3. Configure settings via Cmd/Ctrl+,
4. Install extensions via Extensions menu

## Uninstallation

```bash
# Remove node_modules
rm -rf node_modules

# Remove built apps
rm -rf dist
```
