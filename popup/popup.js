// KillURL Popup Script
// Handles popup UI interactions and communication with content/background scripts

document.addEventListener('DOMContentLoaded', async () => {
    // UI Elements
    const popupContainer = document.querySelector('.popup-container');
    const statusCard = document.getElementById('statusCard');
    const statusLabel = document.getElementById('statusLabel');
    const statusDetail = document.getElementById('statusDetail');
    const destinationSection = document.getElementById('destinationSection');
    const destinationUrl = document.getElementById('destinationUrl');
    const skipBtn = document.getElementById('skipBtn');
    const redirectBtn = document.getElementById('redirectBtn');
    const scanBtn = document.getElementById('scanBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const powerIconBtn = document.getElementById('powerIconBtn');
    const powerToggleBtn = document.getElementById('powerToggleBtn');
    const masterTitle = document.getElementById('masterTitle');
    const masterSubtitle = document.getElementById('masterSubtitle');
    const masterToggle = document.getElementById('masterToggle');
    const autoSkipToggle = document.getElementById('autoSkipToggle');
    const autoRedirectToggle = document.getElementById('autoRedirectToggle');
    const aggressiveModeToggle = document.getElementById('aggressiveModeToggle');
    const removeAdBlockBtn = document.getElementById('removeAdBlockBtn');
    const removeAdBlockToggle = document.getElementById('removeAdBlockToggle');
    const adblockStealthToggle = document.getElementById('adblockStealthToggle');
    const drmBypassBtn = document.getElementById('drmBypassBtn');
    const screenShareDRMToggle = document.getElementById('screenShareDRMToggle');

    // State
    let currentStatus = null;
    let currentTabId = null;
    let extensionEnabled = true;

    // ===== MASTER ON/OFF =====

    function applyEnabledState(enabled) {
        extensionEnabled = enabled;

        if (masterToggle) masterToggle.checked = enabled;

        if (powerToggleBtn) {
            powerToggleBtn.classList.toggle('enabled', enabled);
            powerToggleBtn.classList.toggle('off', !enabled);
            powerToggleBtn.title = enabled ? 'Turn extension off' : 'Turn extension on';
        }
        if (masterTitle) masterTitle.textContent = enabled ? 'Extension ON' : 'Extension OFF';
        if (masterSubtitle) masterSubtitle.textContent = enabled ? 'Click to turn off' : 'Click to turn on';
        if (powerIconBtn) {
            powerIconBtn.classList.toggle('off', !enabled);
            powerIconBtn.title = enabled ? 'Turn extension off' : 'Turn extension on';
        }
        if (popupContainer) popupContainer.classList.toggle('extension-off', !enabled);

        // Disable all feature controls while off
        const featureBtns = [skipBtn, redirectBtn, scanBtn, removeAdBlockBtn, drmBypassBtn];
        const featureToggles = [autoSkipToggle, autoRedirectToggle, aggressiveModeToggle, removeAdBlockToggle, adblockStealthToggle, screenShareDRMToggle];
        if (!enabled) {
            featureBtns.forEach(b => { if (b) b.disabled = true; });
            featureToggles.forEach(t => { if (t) t.disabled = true; });
            setStatus('idle', 'Extension Turned Off', 'Turn it on to kill countdowns');
        } else {
            featureToggles.forEach(t => { if (t) t.disabled = false; });
            // Buttons get re-enabled by requestPageStatus() below
        }
    }

    async function setExtensionEnabled(enabled) {
        applyEnabledState(enabled);
        try {
            await chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled });
        } catch (e) {
            // Fallback: persist via SAVE_SETTINGS if background is unreachable
            try {
                const current = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
                current.enabled = enabled;
                await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: current });
            } catch (err) { /* ignore */ }
        }
        showToast(enabled ? 'KillURL enabled' : 'KillURL turned off', enabled ? 'success' : 'error');
        if (enabled) {
            requestPageStatus();
        }
    }

    // Show real extension version (proves which build is running)
    try {
        const manifest = chrome.runtime.getManifest();
        const versionLabel = document.getElementById('versionLabel');
        if (versionLabel && manifest?.version) {
            versionLabel.textContent = `KillURL v${manifest.version}`;
        }
    } catch (e) { /* ignore */ }

    // ===== INITIALIZATION =====

    // Load settings
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (settings) {
        extensionEnabled = settings.enabled !== false; // default ON for old installs
        autoSkipToggle.checked = settings.autoSkip || false;
        autoRedirectToggle.checked = settings.autoRedirect || false;
        aggressiveModeToggle.checked = settings.aggressiveMode || false;
        removeAdBlockToggle.checked = settings.removeAdBlockWalls || false;
        if (adblockStealthToggle) adblockStealthToggle.checked = settings.adblockStealth !== false;
        screenShareDRMToggle.checked = settings.screenShareDRM || false;
    }
    applyEnabledState(extensionEnabled);

    // Master power toggle handlers — attached before any early return so the
    // off switch always works (even on chrome:// pages)
    if (powerToggleBtn) {
        powerToggleBtn.addEventListener('click', () => setExtensionEnabled(!extensionEnabled));
    }
    if (powerIconBtn) {
        powerIconBtn.addEventListener('click', () => setExtensionEnabled(!extensionEnabled));
    }
    if (masterToggle) {
        masterToggle.addEventListener('change', () => setExtensionEnabled(masterToggle.checked));
    }

    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab?.id;

    if (!extensionEnabled) {
        // Keep the "turned off" status — don't overwrite with page-specific status
        return;
    }

    if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:') || tab.url.startsWith('moz-extension://')) {
        setStatus('idle', 'No web page active', 'Open a URL shortener page');
        skipBtn.disabled = true;
        redirectBtn.disabled = true;
        scanBtn.disabled = true;
        return;
    }

    // Get page status from content script
    requestPageStatus();

    // ===== EVENT HANDLERS =====

    // Skip Countdown
    skipBtn.addEventListener('click', async () => {
        if (!extensionEnabled) { showToast('Extension is turned off', 'error'); return; }
        skipBtn.disabled = true;
        const btnTitle = skipBtn.querySelector('.btn-title');
        const originalText = btnTitle.textContent;
        btnTitle.textContent = 'Skipping...';

        try {
            const response = await chrome.tabs.sendMessage(currentTabId, { type: 'DO_SKIP' });

            if (response?.isSecurityPage) {
                btnTitle.textContent = 'Blocked';
                showToast('🛡️ Security page — skip disabled to avoid breaking captcha', 'error');
                setStatus('safe', '🛡️ Security Page', 'Cloudflare/captcha detected');
                skipBtn.disabled = true;
            } else {
                if (response?.destinationUrl) {
                    showDestination(response.destinationUrl);
                }
                btnTitle.textContent = 'Skipped!';
                showToast('Countdown skipped!', 'success');
                setStatus('safe', 'Countdown Skipped', 'Timer has been killed');
                setTimeout(() => requestPageStatus(), 1000);
            }
        } catch (e) {
            btnTitle.textContent = 'Error';
            showToast('Could not skip — try Re-scan first', 'error');
        }

        setTimeout(() => {
            skipBtn.disabled = false;
            btnTitle.textContent = originalText;
        }, 2000);
    });

    // Direct Redirect
    redirectBtn.addEventListener('click', async () => {
        if (!extensionEnabled) { showToast('Extension is turned off', 'error'); return; }
        if (!currentStatus?.destinationUrl) {
            showToast('No destination URL found yet', 'error');
            return;
        }

        redirectBtn.disabled = true;
        const btnTitle = redirectBtn.querySelector('.btn-title');
        btnTitle.textContent = 'Redirecting...';

        try {
            await chrome.tabs.sendMessage(currentTabId, {
                type: 'DO_REDIRECT',
                url: currentStatus.destinationUrl
            });
            showToast('Redirecting to destination...', 'success');
            // Close popup after redirect
            setTimeout(() => window.close(), 500);
        } catch (e) {
            showToast('Could not redirect', 'error');
            redirectBtn.disabled = false;
            btnTitle.textContent = 'Direct Redirect';
        }
    });

    // Re-scan
    scanBtn.addEventListener('click', async () => {
        if (!extensionEnabled) { showToast('Extension is turned off', 'error'); return; }
        scanBtn.disabled = true;
        const btnTitle = scanBtn.querySelector('.btn-title');
        btnTitle.textContent = 'Scanning...';
        setStatus('scanning', 'Scanning page...', 'Looking for countdowns');

        try {
            const response = await chrome.tabs.sendMessage(currentTabId, { type: 'SCAN_PAGE' });
            handleStatusResponse(response);
            showToast('Page scanned', 'success');
        } catch (e) {
            setStatus('idle', 'Could not scan', 'Content script not loaded');
            showToast('Could not connect to page', 'error');
        }

        scanBtn.disabled = false;
        btnTitle.textContent = 'Re-scan Page';
    });

    // Settings
    settingsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // Auto-Skip Toggle
    autoSkipToggle.addEventListener('change', async () => {
        if (!extensionEnabled) { autoSkipToggle.checked = false; return; }
        const currentSettings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        currentSettings.autoSkip = autoSkipToggle.checked;
        await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        showToast(autoSkipToggle.checked ? 'Auto-skip enabled' : 'Auto-skip disabled', 'success');
    });

    // Auto-Redirect Toggle
    autoRedirectToggle.addEventListener('change', async () => {
        if (!extensionEnabled) { autoRedirectToggle.checked = false; return; }
        const currentSettings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        currentSettings.autoRedirect = autoRedirectToggle.checked;
        await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        showToast(autoRedirectToggle.checked ? 'Auto-redirect enabled' : 'Auto-redirect disabled', 'success');
    });

    // Aggressive Mode Toggle
    aggressiveModeToggle.addEventListener('change', async () => {
        if (!extensionEnabled) { aggressiveModeToggle.checked = false; return; }
        const currentSettings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        currentSettings.aggressiveMode = aggressiveModeToggle.checked;
        await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        showToast(aggressiveModeToggle.checked ? 'Aggressive mode enabled' : 'Aggressive mode disabled', 'success');
    });

    // Remove Ad-Block Wall Button
    removeAdBlockBtn.addEventListener('click', async () => {
        if (!extensionEnabled) { showToast('Extension is turned off', 'error'); return; }
        removeAdBlockBtn.disabled = true;
        const btnTitle = removeAdBlockBtn.querySelector('.btn-title');
        const originalText = btnTitle.textContent;
        btnTitle.textContent = 'Removing...';

        try {
            const response = await chrome.tabs.sendMessage(currentTabId, { type: 'REMOVE_ADBLOCK_WALL' });
            if (response?.removed > 0) {
                btnTitle.textContent = `Removed ${response.removed}!`;
                showToast(`Removed ${response.removed} ad-block wall(s)!`, 'success');
            } else {
                btnTitle.textContent = 'None Found';
                showToast('No ad-block walls detected on this page', 'success');
            }
        } catch (e) {
            btnTitle.textContent = 'Error';
            showToast('Could not connect to page', 'error');
        }

        setTimeout(() => {
            removeAdBlockBtn.disabled = false;
            btnTitle.textContent = originalText;
        }, 2000);
    });

    // Auto-Remove Ad-Block Walls Toggle
    removeAdBlockToggle.addEventListener('change', async () => {
        if (!extensionEnabled) { removeAdBlockToggle.checked = false; return; }
        const currentSettings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        currentSettings.removeAdBlockWalls = removeAdBlockToggle.checked;
        await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
        showToast(removeAdBlockToggle.checked ? 'Auto-remove ad walls enabled' : 'Auto-remove ad walls disabled', 'success');
    });

    // AdBlock Stealth Toggle — fool detectors into seeing "no ad blocker"
    if (adblockStealthToggle) {
        adblockStealthToggle.addEventListener('change', async () => {
            if (!extensionEnabled) { adblockStealthToggle.checked = true; return; }
            const currentSettings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
            currentSettings.adblockStealth = adblockStealthToggle.checked;
            await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: currentSettings });
            showToast(adblockStealthToggle.checked ? 'Stealth on — sites see no ad blocker' : 'Stealth off — detectors can see your ad blocker', 'success');
        });
    }

    // Copy destination URL on click
    destinationUrl.addEventListener('click', () => {
        const url = destinationUrl.textContent;
        navigator.clipboard.writeText(url).then(() => {
            showToast('URL copied to clipboard!', 'success');
        });
    });

    // DRM Bypass Button
    drmBypassBtn.addEventListener('click', async () => {
        if (!extensionEnabled) { showToast('Extension is turned off', 'error'); return; }
        drmBypassBtn.disabled = true;
        const btnTitle = drmBypassBtn.querySelector('.btn-title');
        const originalText = btnTitle.textContent;
        btnTitle.textContent = 'Activating...';

        try {
            // 1. Enable the setting persistently
            await chrome.runtime.sendMessage({
                type: 'TOGGLE_DRM_BYPASS',
                enabled: true
            });
            screenShareDRMToggle.checked = true;

            // 2. Tell content script to activate DRM bypass in MAIN world
            try {
                await chrome.tabs.sendMessage(currentTabId, {
                    type: 'ACTIVATE_DRM_BYPASS'
                });
            } catch (e) { /* content script may not be on this page */ }

            btnTitle.textContent = 'Active!';
            drmBypassBtn.classList.add('active');

            // 3. Prompt reload for full effect
            showToast('🖥️ Enabled! Reload the page for full effect.', 'success');

            // 4. Offer to reload the tab
            setTimeout(async () => {
                try {
                    await chrome.tabs.reload(currentTabId);
                    showToast('Page reloading with DRM bypass...', 'success');
                } catch (e) { /* ignore */ }
            }, 1500);
        } catch (e) {
            btnTitle.textContent = 'Error';
            showToast('Failed to activate DRM bypass', 'error');
        }

        setTimeout(() => {
            drmBypassBtn.disabled = false;
            btnTitle.textContent = originalText;
        }, 4000);
    });

    // Screen Share DRM Toggle
    screenShareDRMToggle.addEventListener('change', async () => {
        if (!extensionEnabled) { screenShareDRMToggle.checked = false; return; }
        await chrome.runtime.sendMessage({
            type: 'TOGGLE_DRM_BYPASS',
            enabled: screenShareDRMToggle.checked
        });
        if (screenShareDRMToggle.checked) {
            showToast('🖥️ DRM bypass enabled — reload streaming pages!', 'success');
        } else {
            showToast('Screen Share DRM auto-bypass disabled', 'success');
        }
    });

    // ===== HELPER FUNCTIONS =====

    async function requestPageStatus() {
        if (!extensionEnabled) {
            setStatus('idle', 'Extension Turned Off', 'Turn it on to kill countdowns');
            return;
        }
        setStatus('scanning', 'Scanning page...', 'Checking for countdowns');

        try {
            const response = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_STATUS' });
            handleStatusResponse(response);
        } catch (e) {
            // Content script might not be injected
            setStatus('idle', 'Page not detected', 'Not a URL shortener page');
            skipBtn.disabled = false; // Still allow manual skip
            redirectBtn.disabled = true;
        }
    }

    function handleStatusResponse(response) {
        currentStatus = response;

        if (!response) {
            setStatus('idle', 'No response', 'Content script not loaded');
            return;
        }

        // Content script reports master switch state — stay in sync
        if (response.enabled === false) {
            applyEnabledState(false);
            return;
        }

        // Arrival: this page IS the destination the chain led to. Celebrate,
        // don't skip — auto-action is stood down here (manual Skip still works).
        if (response.arrived) {
            setStatus('safe', '🎉 Destination reached', response.hostname || 'You made it to the final page');
            skipBtn.disabled = false; // manual override stays available
            redirectBtn.disabled = true;
            return;
        }

        // Security page — behavior depends on aggressive mode
        if (response.isSecurityPage) {
            if (response.aggressiveMode) {
                // Aggressive mode ON: show warning but keep Skip enabled
                setStatus('detected', '⚡ Aggressive Mode Active', 'Cloudflare detected — bypass enabled');
                skipBtn.disabled = false;
                redirectBtn.disabled = !response.destinationUrl;
                if (response.destinationUrl) {
                    showDestination(response.destinationUrl);
                }
            } else {
                // Aggressive mode OFF: disable everything (original behavior)
                setStatus('safe', '🛡️ Security Page', 'Cloudflare/captcha detected — KillURL disabled');
                skipBtn.disabled = true;
                redirectBtn.disabled = true;
            }
            return;
        }

        if (response.isShortenerPage) {
            if (response.countdownDetected) {
                const label = response.isKnownShortener
                    ? 'Countdown Detected!'
                    : 'Countdown Detected (unknown site)';
                setStatus('detected', label, `Timer found on ${response.hostname}`);
            } else {
                setStatus('detected', 'Shortener Detected', `On ${response.hostname}`);
            }

            if (response.destinationUrl) {
                showDestination(response.destinationUrl);
                redirectBtn.disabled = false;
            } else {
                redirectBtn.disabled = true;
            }

            skipBtn.disabled = false;
        } else {
            setStatus('safe', 'No countdown found', response.hostname || 'Regular page');
            skipBtn.disabled = false; // Still allow manual skip attempt
            redirectBtn.disabled = true;
        }
    }

    function setStatus(type, label, detail) {
        statusCard.className = `status-card ${type}`;
        statusLabel.textContent = label;
        statusDetail.textContent = detail;
    }

    function showDestination(url) {
        destinationSection.classList.remove('hidden');
        destinationUrl.textContent = url;
        destinationUrl.title = `Click to copy: ${url}`;
        redirectBtn.disabled = false;
    }

    function showToast(message, type = 'success') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }
});
