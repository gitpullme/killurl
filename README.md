# ⚡ KillURL — URL Shortener Countdown Killer

A Chrome extension that instantly bypasses countdown timers on URL shortener pages. No more waiting 10+ seconds on ad-heavy shortener sites.

## ✨ Features

### 🎯 Skip Countdown
- Kills all active timers on the page (setTimeout/setInterval)
- Reveals hidden "Continue" / "Skip" / "Get Link" buttons
- Removes overlay ad containers blocking button access
- Completes progress bars instantly
- Auto-clicks the continue button when found

### 🚀 Direct Redirect
- Detects the final destination URL from page scripts, data attributes, and hidden links
- Navigates directly to the final page — zero waiting
- Decodes base64-encoded URLs often used by shorteners

### ⚙️ Smart Detection
- 70+ supported URL shortener domains built-in
- Mutation Observer watches for dynamically loaded countdowns
- Pattern matching for common timer variables in page JavaScript
- Works on unknown shorteners too (heuristic countdown detection)

### 🔧 Configurable
- **Auto-Skip**: Automatically skip countdown on detection
- **Auto-Redirect**: Automatically go to final destination
- **Site Scope**: Apply to all sites, known shorteners only, or a custom list
- **Skip Delay**: Adjustable delay before auto-skip kicks in

## 📦 Installation

### Mozilla Firefox
1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click **"Load Temporary Add-on..."**
4. Select the `manifest.json` file inside the `killurl` folder
5. The extension will be loaded and ready to use in Firefox!

### Google Chrome & Chromium Browsers
1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **"Load unpacked"**
5. Select the `killurl` folder
6. The extension icon will appear in your toolbar

## 🎮 Usage

1. **Navigate to any URL shortener page** (e.g., adf.ly, shorte.st, ouo.io, linkvertise.com, etc.)
2. **Click the KillURL extension icon** in your toolbar
3. Choose an action:
   - **⏩ Skip Countdown** — Kills the timer, reveals the button
   - **🚀 Direct Redirect** — Goes straight to the final URL (if detected)
   - **🔍 Re-scan Page** — Re-analyze the page for countdowns
4. Use the **Auto-Skip** / **Auto-Redirect** toggles for hands-free operation

## 🌐 Supported Sites

KillURL supports 70+ URL shortener and file hosting sites including:

| Category | Sites |
|----------|-------|
| **Popular** | bit.ly, tinyurl.com, goo.gl, t.co, ow.ly, cutt.ly |
| **Ad-based** | adf.ly, shorte.st, ouo.io, linkvertise.com, shrinkme.io |
| **Indian** | gplinks.co, adrinolinks.in, indianshortner.com, tnlink.in |
| **File Hosting** | mediafire.com, mega.nz, uploadhaven.com |
| **Others** | exe.io, droplinks.co, try2link.com, clicksfly.com |

...and many more. It also uses heuristic detection for unknown shortener sites.

## 🏗️ Project Structure

```
killurl/
├── manifest.json          # Extension manifest (MV3)
├── background/
│   └── background.js      # Service worker - settings, detection, injection
├── content/
│   ├── content.js          # Content script - DOM analysis, skip logic
│   └── content.css         # In-page notification styles
├── popup/
│   ├── popup.html          # Extension popup UI
│   ├── popup.css           # Popup styles (dark theme)
│   └── popup.js            # Popup logic
├── options/
│   ├── options.html        # Settings page
│   ├── options.css         # Settings styles
│   └── options.js          # Settings logic
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```

## ⚠️ Disclaimer

This extension is for educational and personal productivity purposes. Use responsibly and respect website terms of service.
