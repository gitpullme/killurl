// KillURL Background Service Worker
// Handles communication between popup, content scripts, and manages state

// Default settings
const DEFAULT_SETTINGS = {
    enabled: true, // Master on/off switch
    autoSkip: false,
    autoRedirect: false,
    showNotification: true,
    enabledSites: 'all', // 'all' or 'custom'
    customSites: [],
    skipDelay: 0, // ms delay before auto-skip (0 = instant)
    aggressiveMode: false, // Re-activate bypass after Cloudflare challenge completes
    removeAdBlockWalls: false, // Auto-remove "ad blocker detected" overlays
    adblockStealth: true, // Fool adblock detectors into seeing "no ad blocker"
    screenShareDRM: false // Bypass DRM protection for screen sharing
};

// Merge stored settings with defaults (so old installs get new keys like `enabled`)
async function getSettings() {
    const stored = await chrome.storage.sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// Per-tab memory of the destination URL the content script found on the
// PREVIOUS step. When the tab then lands on that host, it's the arrival
// (final destination) — not another shortener step — so the content script
// must stand down instead of "skipping" the real page. One-shot per tab.
const lastDestinationByTab = new Map(); // tabId -> destination url string

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) { return ''; }
}

if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
        lastDestinationByTab.delete(tabId);
    });
}

// Streaming platforms with DRM protection
const STREAMING_DOMAINS = [
    'netflix.com', 'www.netflix.com',
    'disneyplus.com', 'www.disneyplus.com',
    'hotstar.com', 'www.hotstar.com',
    'hulu.com', 'www.hulu.com',
    'hbomax.com', 'max.com', 'play.max.com',
    'primevideo.com', 'www.primevideo.com',
    'amazon.com', // Prime Video on Amazon
    'peacocktv.com', 'www.peacocktv.com',
    'paramountplus.com', 'www.paramountplus.com',
    'crunchyroll.com', 'www.crunchyroll.com',
    'funimation.com', 'www.funimation.com',
    'apple.com', 'tv.apple.com', // Apple TV+
    'youtube.com', 'www.youtube.com', // YouTube Premium DRM content
    'music.youtube.com',
    'spotify.com', 'open.spotify.com',
    'twitch.tv', 'www.twitch.tv',
    'jiocinema.com', 'www.jiocinema.com',
    'sonyliv.com', 'www.sonyliv.com',
    'zee5.com', 'www.zee5.com',
    'voot.com', 'www.voot.com',
    'mxplayer.in', 'www.mxplayer.in',
];

// Known URL shortener domains and their patterns
const SHORTENER_DOMAINS = [
    // Popular shorteners
    'bit.ly', 'bitly.com', 'tinyurl.com', 'goo.gl', 't.co',
    'ow.ly', 'is.gd', 'buff.ly', 'adf.ly', 'j.mp',
    'dlvr.it', 'ift.tt', 'db.tt',
    // Ad-based shorteners with countdowns
    'adfoc.us', 'bc.vc', 'j.gs', 'q.gs',
    'shorte.st', 'sh.st', 'ouo.io', 'ouo.press',
    'za.gl', 'za.mn', 'adfly.com',
    'linkvertise.com', 'linkvertise.net', 'link-to.net',
    'direct-link.net', 'linkvertise.download',
    'shrinkme.io', 'shrink.pe',
    'exe.io', 'exey.io', 'exe.app',
    'gplinks.co', 'gplinks.in',
    'droplinks.co', 'droplink.co',
    'mdiskshortner.link', 'mdisk.me',
    'adrinolinks.in', 'adrinolinks.com',
    'earnl.xyz', 'earnlink.xyz',
    'link1s.com', 'link1s.net',
    'cuty.io', 'cutt.ly', 'cutt.us',
    'shrtfly.com', 'shrtfly.net',
    'za.uy', 'shorturl.at',
    'tei.ai', 'tii.ai',
    'linkpays.in',
    'try2link.com', 'try2links.com',
    'ez4short.com', 'ez4links.com',
    'rslinks.net',
    'technorozen.com',
    'tnlink.in', 'tnshort.net',
    'atglinks.com',
    'indianshortner.com',
    'dulink.in',
    'xpshort.com',
    'iir.ai',
    'reqlinks.net',
    'krfrn.xyz', 'kfrn.xyz',
    'modishortner.com',
    // File hosting / download with timers
    'mediafire.com', 'mega.nz',
    'uploadhaven.com', 'upload.ee',
    'datanodes.to', 'ddownload.com',
    'usersdrive.com',
    'hexupload.net',
    'clicksfly.com',
    'fc-lc.com', 'fc.lc',
    'earnhub.net',
    'mboost.me',
    // More shorteners
    'short.io', 'rebrand.ly', 'rb.gy',
    'mcaf.ee', 'soo.gd', 'clck.ru',
    's.id', 'rotf.lol', 'shorturl.asia',
    // Indian URL shorteners / earn-to-click
    'just2earn.com',
    'earnbox.in',
    'whatsagrouplink.online',
    'usalinkz.com',
    'techymozo.com',
    'teraboxlink.com',
    'earnkaro.com',
    'shortnerfly.com',
    'earn.wiki',
    'upshrink.com',
    'moneycase.net',
    'gyanilinks.com',
    'shareus.io', 'shareus.site',
    'link-target.net',
    'links4earn.com',
    'linksfree.net',
    'earnl.net',
    'shortzon.com',
    'link-hub.net',
    'hindilinks4u.to',
    'insurancegold.in',
    'grantph.one',
    'financerites.com',
    'bindaaslinks.com',
    'go.bloggingaro.com',
    'go.linkbnao.com',
    'go.crazyblog.in',
    'go.techoreels.com',
    'go.flashlink.in',
    'go.earnforinfo.com',
    'link.vip', 'link.vipurl.in',
    'short2url.in',
    'grfrn.xyz',
    'urlshortx.com',
    'telegram.im',
    'linkbn.com',
    'herogay.fun',
    // Nitro / earn-link clones (multi-step timer + token-form flow)
    'nitro-link.com', 'www.nitro-link.com',
    'nitrolink.com', 'nitro-links.com', 'nitroshare.site',
];

// Initialize settings on install
chrome.runtime.onInstalled.addListener(async () => {
    const settings = await getSettings();
    await chrome.storage.sync.set({ settings });
    console.log('[KillURL] Extension installed/updated');
});

// Update toolbar badge/icon to reflect master enabled state
async function refreshBadge(tabId) {
    try {
        const settings = await getSettings();
        if (settings.enabled === false) {
            await chrome.action.setBadgeText(tabId ? { text: 'OFF', tabId } : { text: '' });
            await chrome.action.setBadgeBackgroundColor({ color: '#6b7280', ...(tabId ? { tabId } : {}) });
            return;
        }
        // Re-clear OFF badge when re-enabled (per-tab detection will re-set its own badge)
        if (tabId) {
            await chrome.action.setBadgeText({ text: '', tabId });
        }
    } catch (e) { /* ignore */ }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
        const newSettings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
        if (newSettings.enabled === false) {
            // Clear all detection badges when turned off
            chrome.action.setBadgeText({ text: '' }).catch(() => { });
        }
    }
});

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'GET_SETTINGS':
            getSettings().then(settings => {
                sendResponse(settings);
            });
            return true; // async response

        case 'SAVE_SETTINGS':
            (async () => {
                const merged = { ...DEFAULT_SETTINGS, ...(message.settings || {}) };
                await chrome.storage.sync.set({ settings: merged });
                await refreshBadge(sender.tab?.id);
                sendResponse({ success: true, settings: merged });
            })();
            return true;

        case 'SET_ENABLED':
            (async () => {
                const current = await getSettings();
                current.enabled = !!message.enabled;
                await chrome.storage.sync.set({ settings: current });
                await refreshBadge(sender.tab?.id);
                // Broadcast to all tabs so content scripts update instantly
                try {
                    const tabs = await chrome.tabs.query({});
                    for (const t of tabs) {
                        if (t.id == null) continue;
                        try { await chrome.tabs.sendMessage(t.id, { type: 'ENABLED_CHANGED', enabled: current.enabled }); } catch (e) { /* tab has no content script */ }
                    }
                } catch (e) { /* ignore */ }
                sendResponse({ success: true, enabled: current.enabled });
            })();
            return true;

        case 'CHECK_SHORTENER':
            const isShortener = isKnownShortener(message.hostname);
            sendResponse({ isShortener, domains: SHORTENER_DOMAINS });
            return true;

        case 'SKIP_COUNTDOWN':
            // Inject skip script into the active tab
            (async () => {
                const s = await getSettings();
                if (s.enabled === false) { sendResponse({ success: false, disabled: true }); return; }
                if (sender.tab) {
                    chrome.tabs.sendMessage(sender.tab.id, { type: 'EXECUTE_SKIP' });
                }
                sendResponse({ success: true });
            })();
            return true;

        case 'DIRECT_REDIRECT':
            // Handle direct redirect
            (async () => {
                const s = await getSettings();
                if (s.enabled === false) { sendResponse({ success: false, disabled: true }); return; }
                if (message.url) {
                    chrome.tabs.update(sender.tab?.id, { url: message.url });
                    sendResponse({ success: true });
                } else {
                    sendResponse({ success: false });
                }
            })();
            return true;

        case 'FOUND_DESTINATION':
            // Content script found the destination URL — ignore if master switch is off
            (async () => {
                const s = await getSettings();
                if (s.enabled === false) { sendResponse({ success: false, disabled: true }); return; }
                if (sender.tab) {
                    chrome.action.setBadgeText({ text: '!', tabId: sender.tab.id });
                    chrome.action.setBadgeBackgroundColor({ color: '#10b981', tabId: sender.tab.id });
                    // Remember it so the NEXT page load on that host is
                    // recognized as the arrival, not another step to skip.
                    if (message.url) lastDestinationByTab.set(sender.tab.id, message.url);
                }
                sendResponse({ success: true });
            })();
            return true;

        case 'CHECK_ARRIVED':
            // "Am I the destination page?" — content script asks on every load.
            // One-shot: consumed on first match so later visits behave normally.
            {
                let arrived = false;
                try {
                    const tabId = sender.tab?.id;
                    const remembered = (tabId != null) ? lastDestinationByTab.get(tabId) : null;
                    if (remembered && message.url) {
                        const destHost = hostOf(remembered);
                        const hereHost = hostOf(message.url);
                        if (destHost && hereHost && destHost === hereHost) {
                            arrived = true;
                            lastDestinationByTab.delete(tabId);
                        }
                    }
                } catch (e) { /* ignore */ }
                sendResponse({ arrived });
            }
            return true;

        case 'PAGE_STATUS':
            // Update badge based on page detection status
            (async () => {
                const s = await getSettings();
                if (s.enabled === false) {
                    if (sender.tab) {
                        try { await chrome.action.setBadgeText({ text: '', tabId: sender.tab.id }); } catch (e) { /* ignore */ }
                    }
                    sendResponse({ success: false, disabled: true });
                    return;
                }
                if (sender.tab) {
                    if (message.detected) {
                        chrome.action.setBadgeText({ text: '⏭', tabId: sender.tab.id });
                        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId: sender.tab.id });
                    } else {
                        chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
                    }
                }
                sendResponse({ success: true });
            })();
            return true;

        case 'INJECT_SKIP_SCRIPT':
            (async () => {
                const s = await getSettings();
                if (s.enabled === false) { sendResponse({ success: false, disabled: true }); return; }
                if (sender.tab) {
                    chrome.scripting.executeScript({
                        target: { tabId: sender.tab.id },
                        func: skipCountdownInjection,
                        world: 'MAIN'
                    });
                }
                sendResponse({ success: true });
            })();
            return true;

        case 'TOGGLE_DRM_BYPASS':
            handleDRMBypassToggle(message, sender, sendResponse);
            return true;

        case 'CHECK_STREAMING':
            const isStreaming = isStreamingDomain(message.hostname);
            sendResponse({ isStreaming, domains: STREAMING_DOMAINS });
            return true;

        case 'INJECT_DRM_BYPASS':
            (async () => {
                const s = await getSettings();
                if (s.enabled === false) { sendResponse({ success: false, disabled: true }); return; }
                if (message.tabId) {
                    injectDRMBypass(message.tabId);
                }
                sendResponse({ success: true });
            })();
            return true;
    }
});

// Check if a hostname is a known shortener
function isKnownShortener(hostname) {
    if (!hostname) return false;
    hostname = hostname.replace(/^www\./, '').toLowerCase();
    return SHORTENER_DOMAINS.some(domain =>
        hostname === domain || hostname.endsWith('.' + domain)
    );
}

// Check if a hostname is a streaming domain
function isStreamingDomain(hostname) {
    if (!hostname) return false;
    hostname = hostname.replace(/^www\./, '').toLowerCase();
    return STREAMING_DOMAINS.some(domain => {
        const cleanDomain = domain.replace(/^www\./, '');
        return hostname === cleanDomain || hostname.endsWith('.' + cleanDomain);
    });
}

// Handle DRM bypass toggle
async function handleDRMBypassToggle(message, sender, sendResponse) {
    try {
        const currentSettings = await getSettings();
        if (currentSettings.enabled === false && message.enabled) {
            sendResponse({ success: false, disabled: true, error: 'Extension is turned off' });
            return;
        }
        currentSettings.screenShareDRM = message.enabled;
        await chrome.storage.sync.set({ settings: currentSettings });

        // Get current active tab
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && message.enabled) {
            injectDRMBypass(tab.id);
        }

        sendResponse({ success: true });
    } catch (e) {
        sendResponse({ success: false, error: e.message });
    }
}

// Inject DRM bypass into a tab
async function injectDRMBypass(tabId) {
    try {
        // Inject the DRM bypass CSS
        await chrome.scripting.insertCSS({
            target: { tabId },
            css: `
                /* Force video elements to use software compositing */
                video {
                    transform: translateZ(0) !important;
                    -webkit-transform: translateZ(0) !important;
                    backface-visibility: hidden !important;
                    -webkit-backface-visibility: hidden !important;
                    image-rendering: auto !important;
                    will-change: auto !important;
                }
                /* Prevent hardware overlay for encrypted media */
                video::-webkit-media-controls,
                video::-moz-media-controls {
                    display: none !important;
                }
            `
        });

        // Inject the DRM bypass script into MAIN world
        await chrome.scripting.executeScript({
            target: { tabId },
            func: drmBypassInjection,
            world: 'MAIN'
        });

        console.log('[KillURL] DRM bypass injected into tab', tabId);
    } catch (e) {
        console.log('[KillURL] Failed to inject DRM bypass:', e.message);
    }
}

// DRM bypass function injected into MAIN world
function drmBypassInjection() {
    if (window.__killurl_drm_bypass_active) return;
    window.__killurl_drm_bypass_active = true;

    console.log('[KillURL] DRM Screen Share bypass activated');

    // 1. Override requestMediaKeySystemAccess to downgrade security level
    const originalRMKSA = navigator.requestMediaKeySystemAccess?.bind(navigator);
    if (originalRMKSA) {
        navigator.requestMediaKeySystemAccess = async function (keySystem, supportedConfigurations) {
            console.log('[KillURL] Intercepted requestMediaKeySystemAccess:', keySystem);

            // Modify configurations to prefer software-based decryption
            const modifiedConfigs = supportedConfigurations.map(config => {
                const newConfig = { ...config };

                // Force software secure decode for video
                if (newConfig.videoCapabilities) {
                    newConfig.videoCapabilities = newConfig.videoCapabilities.map(cap => ({
                        ...cap,
                        robustness: '' // Empty robustness = software decode
                    }));
                }

                // Force software secure decode for audio
                if (newConfig.audioCapabilities) {
                    newConfig.audioCapabilities = newConfig.audioCapabilities.map(cap => ({
                        ...cap,
                        robustness: '' // Empty robustness = software decode
                    }));
                }

                return newConfig;
            });

            try {
                // Try with modified (software) configs first
                return await originalRMKSA(keySystem, modifiedConfigs);
            } catch (e) {
                console.log('[KillURL] Software decode failed, trying original configs');
                // Fallback to original configs if software decode isn't supported
                return await originalRMKSA(keySystem, supportedConfigurations);
            }
        };
    }

    // 2. Force all video elements to use software rendering
    function processVideoElements() {
        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            if (video.__killurl_processed) return;
            video.__killurl_processed = true;

            // Force software compositing
            video.style.setProperty('transform', 'translateZ(0)', 'important');
            video.style.setProperty('-webkit-transform', 'translateZ(0)', 'important');
            video.style.setProperty('backface-visibility', 'hidden', 'important');
            video.style.setProperty('-webkit-backface-visibility', 'hidden', 'important');
            video.style.setProperty('will-change', 'auto', 'important');

            console.log('[KillURL] Processed video element for screen share compatibility');
        });
    }

    // 3. Override HTMLMediaElement properties to prevent hardware overlay
    try {
        Object.defineProperty(HTMLMediaElement.prototype, 'disableRemotePlayback', {
            get() { return true; },
            set() { },
            configurable: true
        });
    } catch (e) { /* ignore */ }

    // Process existing and future video elements
    processVideoElements();

    // Watch for dynamically added video elements
    const observer = new MutationObserver((mutations) => {
        let hasNewVideos = false;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName === 'VIDEO' || node.querySelector?.('video')) {
                        hasNewVideos = true;
                        break;
                    }
                }
            }
            if (hasNewVideos) break;
        }
        if (hasNewVideos) {
            processVideoElements();
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });
}

// Function injected into MAIN world for on-demand force-skip
function skipCountdownInjection() {
    // Dispatch event that the MAIN world injector listens for
    window.dispatchEvent(new CustomEvent('killurl-force-skip'));

    // Also brute-force clear everything directly
    for (let i = 1; i < 99999; i++) {
        window.clearTimeout(i);
        window.clearInterval(i);
    }

    // Override countdown-related variables
    const commonCountdownVars = [
        'counter', 'countdown', 'timer', 'count', 'seconds',
        'timeLeft', 'time_left', 'remaining', 'wait',
        'sec', 'second', 'delay', 'wpsafe_timer', 'wpsafelink_timer',
        'ctt', 'cnt', 'num', 'secs', 'timerCount', 'timerVal',
        'scrollTimer', 'scroll_timer', 'scrollCount', 'scroll_count',
        'countdownTimer', 'countDown', 'shortTimer', 'short_timer',
        'currentTime', 'current_time', 'waitTime', 'wait_time',
        'redirectTime', 'redirect_time', 'downloadTimer', 'download_timer'
    ];

    commonCountdownVars.forEach(varName => {
        try {
            if (typeof window[varName] !== 'undefined') {
                window[varName] = 0;
            }
        } catch (e) { /* ignore */ }
    });

    // Dispatch completion event
    window.dispatchEvent(new CustomEvent('killurl-skip-done'));
}

// Listen for tab updates to auto-detect shortener pages and inject DRM bypass
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        try {
            const currentSettings = await getSettings();

            // Master switch OFF → do nothing, clear badge
            if (currentSettings.enabled === false) {
                try { await chrome.action.setBadgeText({ text: '', tabId }); } catch (e) { /* ignore */ }
                return;
            }

            const url = new URL(tab.url);
            const hostname = url.hostname.replace(/^www\./, '');

            if (isKnownShortener(hostname)) {
                // Notify the content script that this is a detected shortener
                try {
                    await chrome.tabs.sendMessage(tabId, {
                        type: 'SHORTENER_DETECTED',
                        autoSkip: currentSettings.autoSkip,
                        autoRedirect: currentSettings.autoRedirect,
                        hostname: hostname
                    });
                } catch (e) {
                    // Content script may not be ready yet
                }
            }

            // Auto-inject DRM bypass on streaming platforms if enabled
            if (currentSettings.screenShareDRM && isStreamingDomain(hostname)) {
                console.log('[KillURL] Streaming platform detected, injecting DRM bypass:', hostname);
                injectDRMBypass(tabId);
            }
        } catch (e) {
            // Invalid URL, ignore
        }
    }
});
