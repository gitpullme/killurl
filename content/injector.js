// KillURL MAIN World Injector
// This script runs in the page's MAIN JS world (not isolated extension world)
// 
// STRATEGY:
// 1. On KNOWN shortener domains → auto-activate at document_start (hooks timers before page JS runs)
// 2. On UNKNOWN domains → stay dormant, activate only on user's "Skip" click
// 3. After DOM loads → check for Cloudflare/captcha → if found, DEACTIVATE and restore original timers
// 4. On force-skip → activate + clear all timers + zero countdown variables
// 5. On STREAMING domains → hook EME/DRM APIs IMMEDIATELY for screen share bypass

(function () {
    'use strict';

    // Prevent double initialization if injected via manifest and script tag
    if (window.__killurl_injector_loaded) return;
    window.__killurl_injector_loaded = true;

    const TIMER_THRESHOLD = 1000;
    const FAST_FORWARD_DELAY = 10;
    const DEBUG = false;

    function log(...args) {
        if (DEBUG) console.log('[KillURL:MAIN]', ...args);
    }

    // ===== STATE =====
    let activated = false;
    let deactivated = false; // Set true if security page detected AFTER activation
    let varKillInterval = null;
    let aggressiveMode = false; // Set via event from content script
    let reactivationWatcher = null;
    let trackedIntervals = new Map(); // Track interval callbacks for force-skip
    let trackedRAF = new Map(); // Track rAF callbacks for force-skip
    // Master switch — tri-state: null = not yet known (content script hasn't
    // replied), true = on, false = off. Starts UNKNOWN so a fresh page can never
    // fast-activate before learning that the user turned the extension OFF.
    let masterState = null;
    let fastActivateTimer = null;
    // Set when the net sniffer (fetch/XHR hook below) captures a destination:
    // the drive loop stops early and the 8s last-resort nuke stands down.
    let destinationCaptured = false;
    window.addEventListener('killurl-url-found', (e) => {
        if (e.detail?.url) {
            destinationCaptured = true;
            log('Destination captured:', e.detail.url);
        }
    });
    // The content script asks us to unfreeze variables once it has what it
    // needs (destination found) so later steps compute normally.
    window.addEventListener('killurl-release-vars', () => {
        releaseVarKilling();
    });

    // ===== DRM BYPASS STATE =====
    let drmBypassEnabled = false;
    let drmBypassActivated = false;
    let pendingEMECalls = []; // Queue EME calls until settings are confirmed
    let settingsReceived = false; // Whether content.js has sent settings

    // ===== STREAMING PLATFORM DOMAINS (for DRM bypass) =====
    const STREAMING_DOMAINS = [
        'netflix.com', 'disneyplus.com', 'hotstar.com',
        'hulu.com', 'hbomax.com', 'max.com',
        'primevideo.com', 'amazon.com',
        'peacocktv.com', 'paramountplus.com',
        'crunchyroll.com', 'funimation.com',
        'tv.apple.com', 'youtube.com', 'music.youtube.com',
        'spotify.com', 'twitch.tv',
        'jiocinema.com', 'sonyliv.com', 'zee5.com',
        'voot.com', 'mxplayer.in',
    ];

    function isStreamingDomain() {
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();
        return STREAMING_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
    }

    // Save originals IMMEDIATELY
    const _origSetTimeout = window.setTimeout.bind(window);
    const _origSetInterval = window.setInterval.bind(window);
    const _origClearTimeout = window.clearTimeout.bind(window);
    const _origClearInterval = window.clearInterval.bind(window);
    const _origRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
    const _origCancelRAF = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : null;
    const _origFetch = window.fetch ? window.fetch.bind(window) : null;
    const _origDateNow = Date.now.bind(Date);
    const _origPerfNow = (window.performance && window.performance.now) ? window.performance.now.bind(window.performance) : null;

    // Track-mode inventory: every timer created while we are dormant is recorded
    // (callback + delay) so a later force-skip can DRIVE it to completion instead
    // of just clearing it. FIFO-capped so normal pages never leak memory.
    const TRACK_MAX = 300;
    let trackedTimeouts = new Map(); // id -> {callback, args, delay}
    let timeShiftMs = 0; // added to Date.now()/performance.now() after force-skip

    function trackPut(map, id, entry) {
        try {
            map.set(id, entry);
            if (map.size > TRACK_MAX) {
                const oldest = map.keys().next().value;
                map.delete(oldest);
            }
        } catch (e) { /* ignore */ }
    }

    function isTimerLikeDelay(delay) {
        return typeof delay === 'number' && delay >= 200 && delay <= 5000;
    }

    // ===== KNOWN SHORTENER DOMAINS (for auto-activation) =====
    // This list enables timer hooking at document_start on known sites
    const KNOWN_DOMAINS = [
        'adf.ly', 'adfoc.us', 'bc.vc', 'j.gs', 'q.gs',
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
        'rslinks.net', 'technorozen.com',
        'tnlink.in', 'tnshort.net',
        'atglinks.com', 'indianshortner.com',
        'dulink.in', 'xpshort.com',
        'iir.ai', 'reqlinks.net',
        'krfrn.xyz', 'kfrn.xyz',
        'modishortner.com',
        'clicksfly.com', 'fc-lc.com', 'fc.lc',
        'earnhub.net', 'mboost.me',
        // Indian shorteners / redirectors with countdowns
        'just2earn.com', 'earnbox.in',
        'whatsagrouplink.online',
        'usalinkz.com', 'techymozo.com',
        'teraboxlink.com', 'earnkaro.com',
        'shortnerfly.com', 'earn.wiki',
        'upshrink.com', 'moneycase.net',
        'gyanilinks.com', 'shareus.io', 'shareus.site',
        'link-target.net', 'links4earn.com',
        'linksfree.net', 'earnl.net',
        'shortzon.com', 'link-hub.net',
        'hindilinks4u.to', 'insurancegold.in',
        'grantph.one', 'financerites.com',
        'bindaaslinks.com',
        'go.bloggingaro.com', 'go.linkbnao.com',
        'go.crazyblog.in', 'go.techoreels.com',
        'go.flashlink.in', 'go.earnforinfo.com',
        'short2url.in', 'grfrn.xyz',
        'urlshortx.com', 'linkbn.com',
        // Nitro / earn-link clones (multi-step timer + token-form flow)
        'nitro-link.com', 'nitrolink.com', 'nitro-links.com', 'nitroshare.site',
    ];

    // ===== DRM/EME BYPASS (for screen sharing) =====
    // This MUST be hooked synchronously at document_start on streaming domains
    // because streaming players call requestMediaKeySystemAccess during initialization

    const _origRequestMKSA = navigator.requestMediaKeySystemAccess
        ? navigator.requestMediaKeySystemAccess.bind(navigator)
        : null;

    function activateDRMBypass() {
        if (drmBypassActivated) return;
        if (!_origRequestMKSA) return;
        drmBypassActivated = true;

        console.log('[KillURL] 🖥️ DRM Screen Share bypass ACTIVATED on', window.location.hostname);

        // Override requestMediaKeySystemAccess
        navigator.requestMediaKeySystemAccess = function (keySystem, supportedConfigurations) {
            console.log('[KillURL] 🔑 Intercepted EME request:', keySystem);

            // If extension or DRM bypass is disabled, pass through untouched
            if (masterState === false) {
                console.log('[KillURL] Extension turned off — EME passing through');
                return _origRequestMKSA(keySystem, supportedConfigurations);
            }
            // If DRM bypass is confirmed disabled, pass through
            if (settingsReceived && !drmBypassEnabled) {
                console.log('[KillURL] DRM bypass disabled by settings, passing through');
                return _origRequestMKSA(keySystem, supportedConfigurations);
            }

            // Log original robustness levels
            supportedConfigurations.forEach((config, i) => {
                if (config.videoCapabilities) {
                    config.videoCapabilities.forEach(cap => {
                        console.log(`[KillURL] Original video robustness: "${cap.robustness}" → forcing "" (software/L3)`);
                    });
                }
            });

            // Modify configurations to force software-based decryption
            const modifiedConfigs = supportedConfigurations.map(config => {
                const newConfig = { ...config };

                // Force software secure decode for video
                if (newConfig.videoCapabilities) {
                    newConfig.videoCapabilities = newConfig.videoCapabilities.map(cap => ({
                        ...cap,
                        robustness: '' // Empty = software decode (Widevine L3)
                    }));
                }

                // Force software secure decode for audio
                if (newConfig.audioCapabilities) {
                    newConfig.audioCapabilities = newConfig.audioCapabilities.map(cap => ({
                        ...cap,
                        robustness: '' // Empty = software decode (Widevine L3)
                    }));
                }

                // Remove persistentState requirement which can force hardware
                if (newConfig.persistentState === 'required') {
                    newConfig.persistentState = 'optional';
                }

                // Remove distinctiveIdentifier which can force hardware
                if (newConfig.distinctiveIdentifier === 'required') {
                    newConfig.distinctiveIdentifier = 'optional';
                }

                return newConfig;
            });

            console.log('[KillURL] ✅ EME configs modified → forced software decode (Widevine L3)');

            // Try modified configs first, fall back to original if they fail
            return _origRequestMKSA(keySystem, modifiedConfigs).catch(err => {
                console.log('[KillURL] ⚠️ Modified configs rejected, falling back to original:', err.message);
                return _origRequestMKSA(keySystem, supportedConfigurations);
            });
        };

        // Also override MediaKeySystemAccess.createMediaKeys if available
        // to ensure software-only processing
        try {
            const origCreateMediaKeys = MediaKeySystemAccess.prototype.createMediaKeys;
            MediaKeySystemAccess.prototype.createMediaKeys = function () {
                log('Intercepted createMediaKeys');
                return origCreateMediaKeys.call(this);
            };
        } catch (e) { /* ignore */ }

        // Process video elements for software compositing
        function processVideoElements() {
            const videos = document.querySelectorAll('video');
            videos.forEach(video => {
                if (video.__killurl_drm_processed) return;
                video.__killurl_drm_processed = true;

                // Force software compositing layer
                video.style.setProperty('transform', 'translateZ(0)', 'important');
                video.style.setProperty('-webkit-transform', 'translateZ(0)', 'important');
                video.style.setProperty('backface-visibility', 'hidden', 'important');
                video.style.setProperty('-webkit-backface-visibility', 'hidden', 'important');
                video.style.setProperty('will-change', 'auto', 'important');
                video.style.setProperty('image-rendering', 'auto', 'important');

                log('Processed video element for screen share');
            });
        }

        // Watch for dynamically added video elements
        const videoObserver = new MutationObserver(() => {
            processVideoElements();
        });

        // Start observing when DOM is available
        if (document.documentElement) {
            videoObserver.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        } else {
            // Wait for documentElement to be available
            const waitForDoc = _origSetInterval(() => {
                if (document.documentElement) {
                    _origClearInterval(waitForDoc);
                    videoObserver.observe(document.documentElement, {
                        childList: true,
                        subtree: true
                    });
                    processVideoElements();
                }
            }, 10);
        }

        // Also process when DOM is ready
        window.addEventListener('DOMContentLoaded', processVideoElements);
        window.addEventListener('load', processVideoElements);

        // Dispatch event to notify content script
        try {
            window.dispatchEvent(new CustomEvent('killurl-drm-bypass-active'));
        } catch (e) { /* ignore */ }
    }

    // Listen for DRM bypass enable/disable from content script
    window.addEventListener('killurl-enable-drm-bypass', (e) => {
        const shouldEnable = !!e.detail?.enabled;
        settingsReceived = true;
        drmBypassEnabled = shouldEnable;
        log('DRM bypass setting received:', shouldEnable);

        if (shouldEnable && !drmBypassActivated) {
            activateDRMBypass();
        }
    });

    // Listen for on-demand DRM bypass activation (from popup button)
    window.addEventListener('killurl-force-drm-bypass', () => {
        if (masterState === false) return;
        log('Force DRM bypass triggered');
        drmBypassEnabled = true;
        if (!drmBypassActivated) {
            activateDRMBypass();
        }
    });

    // ===== URL-BASED SECURITY PAGE DETECTION (synchronous, at document_start) =====

    function isSecurityURL() {
        const url = window.location.href.toLowerCase();
        const hostname = window.location.hostname.toLowerCase();
        if (url.includes('/cdn-cgi/') && url.includes('challenge')) return true;
        if (hostname.includes('challenges.cloudflare.com')) return true;
        if (url.includes('/turnstile/')) return true;
        if (hostname.includes('recaptcha.net')) return true;
        if (hostname.includes('hcaptcha.com')) return true;
        return false;
    }

    // ===== DOM-BASED SECURITY DETECTION (after DOM loads) =====

    function hasSecurityMarkers() {
        try {
            const html = document.documentElement?.innerHTML || '';

            // Cloudflare challenge HTML markers
            if (html.includes('id="cf-challenge-running"') ||
                html.includes('id="challenge-running"') ||
                html.includes('cf-turnstile-wrapper') ||
                html.includes('id="challenge-form"') ||
                html.includes('id="challenge-stage"') ||
                html.includes('cf-chl-widget')) {
                return true;
            }

            // Cloudflare JS challenge scripts
            if (html.includes('/cdn-cgi/challenge-platform/') ||
                html.includes('cpo.src') ||
                html.includes('cNonce')) {
                return true;
            }

            const bodyText = document.body?.textContent || '';

            // Cloudflare "checking" page text (very specific to avoid false positives)
            if (bodyText.includes('Performing security verification') &&
                bodyText.includes('security service')) {
                return true;
            }
            if (bodyText.includes('Checking if the site connection is secure') &&
                html.includes('cf-')) {
                return true;
            }
            if (bodyText.includes('DDoS protection by') && bodyText.includes('Cloudflare')) {
                return true;
            }
            if (bodyText.includes('Just a moment...') && html.includes('cf-challenge')) {
                return true;
            }

        } catch (e) { /* ignore */ }
        return false;
    }

    // ===== COUNTDOWN VARIABLE NAMES =====

    const COUNTDOWN_VAR_NAMES = [
        'counter', 'countdown', 'timer', 'count', 'seconds',
        'timeLeft', 'time_left', 'remaining', 'wait', 'Wait',
        'sec', 'second', 'delay', 'currentTime', 'current_time',
        'wpsafe_timer', 'wpsafelink_timer', 'wpsafe_count',
        'ctt', 'cnt', 'secs', 'timerCount', 'timerVal',
        'countdownTimer', 'countDown', 'countValue', 'counterValue',
        'secondsLeft', 'seconds_left', 'time_remaining',
        'waitTime', 'wait_time', 'waitSeconds', 'wait_seconds',
        'redirectTime', 'redirect_time', 'redirectTimer',
        'downloadTimer', 'download_timer', 'dlTimer',
        'linkTimer', 'link_timer', 'shortTimer', 'short_timer',
        'countdownSeconds', 'countdown_seconds',
        'timeCounter', 'time_counter', 'secondCounter',
        'scrollTimer', 'scroll_timer', 'scrollCount', 'scroll_count',
        // earnbox.in specific variables
        'earnboxTimer', 'earnbox_timer', 'earnboxCount', 'earnbox_count',
        'timeRemaining', 'secondsRemaining',
        // ---- generic v2: modern earn-template variable names ----
        'verifyTimer', 'verify_timer', 'unlockTimer', 'unlock_timer',
        'stepTimer', 'step_timer', 'linkWait', 'link_wait',
        'nitroTimer', 'nitro_timer', 'goTimer', 'go_timer',
        'remainingTime', 'remaining_time', 'leftTime', 'left_time',
        'cooldown', 'coolDown', 'cooldownTimer',
        'startTime', 'start_time', 'endTime', 'end_time',
        'timer_sec', 'timerSec', 'cdTimer', 'cd',
    ];

    // ===== CHECK IF CURRENT DOMAIN IS A KNOWN SHORTENER =====

    function isKnownDomain() {
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();
        return KNOWN_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
    }

    // ===== TIMER HOOKS =====
    // Wrappers install at document_start on EVERY page in TRACK mode:
    // zero behavior change (original delays kept), we only inventory callbacks.
    // On activation (known shortener / auto-skip / manual Skip) they switch to
    // FAST mode: long timers fast-forward, visibility is spoofed, clocks shift.

    function installHookWrappers() {
        if (window.__killurl_hooks_installed) return;
        window.__killurl_hooks_installed = true;

        window.setTimeout = function (callback, delay, ...args) {
            if (deactivated || masterState === false) return _origSetTimeout(callback, delay, ...args);

            if (!activated) {
                // TRACK MODE — record only, keep original timing
                const id = _origSetTimeout(callback, delay, ...args);
                if (typeof callback === 'function' && isTimerLikeDelay(delay)) {
                    trackPut(trackedTimeouts, id, { callback, args, delay });
                }
                return id;
            }

            if (typeof delay === 'number' && delay >= TIMER_THRESHOLD) {
                log(`Intercepted setTimeout: ${delay}ms → ${FAST_FORWARD_DELAY}ms`);

                const id = _origSetTimeout(callback, FAST_FORWARD_DELAY, ...args);
                if (typeof callback === 'function') trackPut(trackedTimeouts, id, { callback, args, delay });

                try {
                    window.dispatchEvent(new CustomEvent('killurl-timer-intercepted', {
                        detail: { type: 'timeout', originalDelay: delay, newDelay: FAST_FORWARD_DELAY }
                    }));
                } catch (e) { /* ignore */ }

                return id;
            }
            const id = _origSetTimeout(callback, delay, ...args);
            if (typeof callback === 'function' && isTimerLikeDelay(delay)) {
                trackPut(trackedTimeouts, id, { callback, args, delay });
            }
            return id;
        };

        window.setInterval = function (callback, delay, ...args) {
            if (deactivated || masterState === false) return _origSetInterval(callback, delay, ...args);

            if (!activated) {
                // TRACK MODE — record only, keep original timing
                const id = _origSetInterval(callback, delay, ...args);
                if (typeof callback === 'function' && isTimerLikeDelay(delay)) {
                    trackPut(trackedIntervals, id, { callback, args, delay });
                }
                return id;
            }

            if (typeof delay === 'number' && delay >= TIMER_THRESHOLD) {
                log(`Intercepted setInterval: ${delay}ms → ${FAST_FORWARD_DELAY}ms`);

                // Fire callback immediately to advance countdown
                try { if (typeof callback === 'function') callback.call(window, ...args); } catch (e) { /* ignore */ }

                const id = _origSetInterval(callback, FAST_FORWARD_DELAY, ...args);

                // Track so force-skip can fire it one last time before clearing
                if (typeof callback === 'function') trackPut(trackedIntervals, id, { callback, args, delay });

                try {
                    window.dispatchEvent(new CustomEvent('killurl-timer-intercepted', {
                        detail: { type: 'interval', originalDelay: delay, newDelay: FAST_FORWARD_DELAY }
                    }));
                } catch (e) { /* ignore */ }

                return id;
            }

            // Also track non-intercepted intervals (countdown intervals with short delays)
            const id = _origSetInterval(callback, delay, ...args);
            if (typeof delay === 'number' && delay >= 250 && delay <= 1000) {
                trackedIntervals.set(id, { callback, args });
            }
            return id;
        };

        // Track requestAnimationFrame loops (some templates drive timers via rAF)
        if (_origRAF && !window.__killurl_raf_hooked) {
            window.__killurl_raf_hooked = true;
            window.requestAnimationFrame = function (callback, ...args) {
                if (deactivated || masterState === false) return _origRAF(callback, ...args);
                const id = _origRAF(function (ts) {
                    try { trackedRAF.set(id, { callback }); } catch (e) { /* ignore */ }
                    return callback.call(window, ts);
                }, ...args);
                try { trackedRAF.set(id, { callback }); } catch (e) { /* ignore */ }
                return id;
            };
            if (_origCancelRAF) {
                window.cancelAnimationFrame = function (id) {
                    try { trackedRAF.delete(id); } catch (e) { /* ignore */ }
                    return _origCancelRAF(id);
                };
            }
        }

        // Visibility spoof + clock shift install on ACTIVATION only (see
        // installVisibilitySpoof / installClockHooks below) — never in track
        // mode, so normal pages are completely unaffected.
        installNetCapture();

        log('Hook wrappers installed (track mode)');
    }

    function installVisibilitySpoof() {
        if (window.__killurl_visibility_hooked) return;
        // Only ever spoof once activated (shortener context)
        if (!activated) return;
        window.__killurl_visibility_hooked = true;
            let _origHiddenGet = null;
            let _origVisGet = null;
            try {
                _origHiddenGet = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get ||
                    Object.getOwnPropertyDescriptor(document, 'hidden')?.get || null;
                _origVisGet = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')?.get ||
                    Object.getOwnPropertyDescriptor(document, 'visibilityState')?.get || null;
            } catch (e) { /* ignore */ }
            try {
                Object.defineProperty(document, 'hidden', {
                    get() {
                        if (deactivated || masterState === false) {
                            try { return _origHiddenGet ? _origHiddenGet.call(document) : false; }
                            catch (e) { return false; }
                        }
                        return false;
                    },
                    configurable: true
                });
            } catch (e) { /* ignore */ }
            try {
                Object.defineProperty(document, 'visibilityState', {
                    get() {
                        if (deactivated || masterState === false) {
                            try { return _origVisGet ? _origVisGet.call(document) : 'visible'; }
                            catch (e) { return 'visible'; }
                        }
                        return 'visible';
                    },
                    configurable: true
                });
            } catch (e) { /* ignore */ }
            try {
                if (!document.__killurl_hasFocus_hooked) {
                    document.__killurl_hasFocus_hooked = true;
                    const _origHasFocus = document.hasFocus.bind(document);
                    document.hasFocus = function () {
                        if (deactivated || masterState === false) return _origHasFocus();
                        return true;
                    };
                }
            } catch (e) { /* ignore */ }
            window.addEventListener('visibilitychange', (e) => {
                if (!deactivated && masterState !== false) { e.stopImmediatePropagation(); }
            }, true);
            window.addEventListener('blur', (e) => {
                if (!deactivated && masterState !== false) { e.stopImmediatePropagation(); }
            }, true);
    }

    function installNetCapture() {
        if (window.__killurl_net_hooked) return;
        window.__killurl_net_hooked = true;
        if (_origFetch) {
            window.fetch = function (...args) {
                // Stealth: bait requests succeed locally — detector sees "ads load fine".
                try {
                    const first = args[0];
                    const urlStr = typeof first === 'string' ? first : (first && first.url) || '';
                    if (urlStr && stealthActive() && BAIT_URL_RE.test(urlStr)) {
                        console.log('[KillURL] Stealth: faked bait fetch', String(urlStr).slice(0, 80));
                        return Promise.resolve(new Response('{}', {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        }));
                    }
                } catch (e) { /* fall through to real fetch */ }
                return _origFetch(...args).then((response) => {
                    if (!deactivated && masterState !== false) {
                        try {
                            const clone = response.clone();
                            clone.text().then((text) => {
                                if (!text || text.length > 200000) return;
                                const m = text.match(/"(?:destination|redirect|target|final|next|url)"\s*:\s*"(https?:\/\/[^"]+)"/i) ||
                                    text.match(/https?:\/\/[^\s"'\\]+/i);
                                if (m && m[1] && m[1].startsWith('http')) {
                                    try {
                                        window.dispatchEvent(new CustomEvent('killurl-url-found', {
                                            detail: { url: m[1], source: 'fetch' }
                                        }));
                                    } catch (e) { /* ignore */ }
                                }
                            }).catch(() => { });
                        } catch (e) { /* ignore */ }
                    }
                    return response;
                });
            };
            // Also watch XHR token endpoints
            try {
                const _origXHROpen = XMLHttpRequest.prototype.open;
                const _origXHRSend = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                    this.__killurl_url = url;
                    return _origXHROpen.call(this, method, url, ...rest);
                };
                XMLHttpRequest.prototype.send = function (...args) {
                    // Stealth: bait XHR "succeeds" locally with empty JSON.
                    try {
                        if (stealthActive() && typeof this.__killurl_url === 'string' && BAIT_URL_RE.test(this.__killurl_url)) {
                            const self = this;
                            console.log('[KillURL] Stealth: faked bait XHR', String(this.__killurl_url).slice(0, 80));
                            _origSetTimeout(() => {
                                try {
                                    Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
                                    Object.defineProperty(self, 'status', { value: 200, configurable: true });
                                    Object.defineProperty(self, 'statusText', { value: 'OK', configurable: true });
                                    Object.defineProperty(self, 'responseText', { value: '{}', configurable: true });
                                    Object.defineProperty(self, 'response', { value: '{}', configurable: true });
                                    self.dispatchEvent(new Event('readystatechange'));
                                    self.dispatchEvent(new Event('load'));
                                    self.dispatchEvent(new Event('loadend'));
                                } catch (e) { /* ignore */ }
                            }, 10);
                            return;
                        }
                    } catch (e) { /* fall through to real send */ }
                    this.addEventListener('load', function () {
                        if (deactivated || masterState === false) return;
                        try {
                            const text = this.responseText || '';
                            if (!text || text.length > 200000) return;
                            const m = text.match(/"(?:destination|redirect|target|final|next|url)"\s*:\s*"(https?:\/\/[^"]+)"/i);
                            if (m && m[1]) {
                                window.dispatchEvent(new CustomEvent('killurl-url-found', {
                                    detail: { url: m[1], source: 'xhr' }
                                }));
                            }
                        } catch (e) { /* ignore */ }
                    });
                    return _origXHRSend.call(this, ...args);
                };
            } catch (e) { /* ignore */ }
        }
    }

    // ===== ADBLOCK STEALTH (fool detectors into seeing "no adblocker") =====
    // Nitro-style flows SILENTLY lock the Continue button when an adblocker is
    // detected (no visible wall — the click just dies). These shims make every
    // classic probe report "ads fine": bait-element geometry, bait script/image/
    // iframe loads, bait fetch/XHR, and famous ad globals. All wrappers check
    // stealthActive() first, so with master OFF (or stealth OFF) the page is
    // byte-for-byte untouched.
    let stealthEnabled = null; // null = not yet told → shims active (fail-open)

    function stealthActive() {
        return masterState !== false && stealthEnabled !== false && !deactivated;
    }

    window.addEventListener('killurl-set-stealth', (e) => {
        stealthEnabled = e.detail?.enabled !== false;
        log('AdBlock stealth set to:', stealthEnabled);
    });

    // Class/id tokens detectors use for bait elements. Bare "ad"/"ads" only
    // match as whole separator-bounded tokens (so "header", "read", "leads",
    // "download" never match).
    const BAIT_TOKEN_RE = /(^|[\s_\-])(ads?box|ad-?banner|adsense|adverts?|advertisement|sponsor(ed)?|pub_\d+([x×]\d+)?|google_?ads?|text-?ads?|ad-?placement|ad-?container|pop-?under|ads?)([\s_\-]|$)/i;

    function isBaitElement(el) {
        try {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
            const cls = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
            const hay = ((el.id || '') + ' ' + cls).toLowerCase();
            if (!hay.trim()) return false;
            if (/captcha|turnstile|challenge|recaptcha|hcaptcha/.test(hay)) return false;
            return BAIT_TOKEN_RE.test(hay);
        } catch (e) { return false; }
    }

    // Famous ad hosts/paths detectors load as network bait. Host-focused so we
    // never touch first-party app traffic.
    const BAIT_URL_RE = /googlesyndication|googleadservices|doubleclick|googletagservices|adservice\.google|pagead|adsbygoogle|adsrvr|adnxs|criteo|taboola|outbrain|revcontent|mgid|amazon-adsystem|apstag|pubmatic|rubicon|moatads|2mdn\.net|prebid|pbjs|pop-?under|banner-?ads|popads|adnxs-simple/i;

    // Fake-but-functional GPT: behaves like a LOADED googletag where every slot
    // renders empty. Queued cmd functions execute immediately (a dead cmd array
    // would jam the page: pushed init callbacks never run and anything gated on
    // slotRenderEnded waits forever — exactly a stuck Continue button).
    // NOTE: slot events report isEmpty:false ("rendered"). Render-gated Continue
    // buttons unlock on that; empty-gated fallbacks proceed either way.
    const GPT_STUB_JS = '(function(){var g=window.googletag=window.googletag||{};if(g.__ku)return;g.__ku=1;'
        + 'g.apiReady=true;g.pubadsReady=true;'
        + 'var L={};function on(n,cb){(L[n]=L[n]||[]).push(cb)}'
        + 'function ev(){return{isEmpty:false,slot:null,serviceName:"publisher",slotContentChanged:true}}'
        + 'function fire(){for(var n in L){var a=L[n];for(var i=0;i<a.length;i++){try{a[i](ev())}catch(e){}}}}'
        + 'var slot={getSlotElementId:function(){return""},getAdUnitPath:function(){return""},addService:function(){return slot},setTargeting:function(){return slot},setCollapseEmptyDiv:function(){}};'
        + 'var pub={addEventListener:function(n,cb){on(n,cb);setTimeout(fire,30);return pub},'
        + 'removeEventListener:function(){return pub},setTargeting:function(){return pub},clearTargeting:function(){return pub},'
        + 'setPrivacySettings:function(){return pub},enableSingleRequest:function(){return pub},collapseEmptyDivs:function(){},'
        + 'disableInitialLoad:function(){},enableLazyLoad:function(){},refresh:function(){setTimeout(fire,30)},'
        + 'clear:function(){},getSlots:function(){return[]},isInitialLoadDisabled:function(){return false}};'
        + 'g.cmd=g.cmd||[];'
        + '(function(){var q=(g.cmd.splice?g.cmd.splice(0,g.cmd.length):[]);for(var i=0;i<q.length;i++){try{q[i]&&q[i]()}catch(e){}}})();'
        + 'g.cmd.push=function(f){try{f&&f()}catch(e){}return g.cmd.length};'
        + 'g.defineSlot=function(){return slot};g.defineOutOfPageSlot=function(){return slot};'
        + 'g.display=function(){};g.enableServices=function(){};g.destroySlots=function(){};'
        + 'g.pubads=function(){return pub};g.companionAds=function(){return{setRefreshUnfilledSlots:function(){}}};'
        + 'g.content=function(){return{setContent:function(){}}};'
        + 'setTimeout(fire,120);})();';

    function baitScriptStub(url) {
        const u = (url || '').toLowerCase();
        // adsbygoogle baseline keeps plain AdSense checks quiet.
        let extra = 'window.adsbygoogle=window.adsbygoogle||[];';
        if (/googletag|doubleclick|gpt|pubads|securepubads/.test(u)) extra += GPT_STUB_JS;
        if (/prebid|pbjs/.test(u)) extra += 'window.pbjs=window.pbjs||{que:[]};(function(p){if(p.__ku)return;p.__ku=1;function d(){var q=p.que.splice?p.que.splice(0,p.que.length):[];for(var i=0;i<q.length;i++){try{q[i]&&q[i]()}catch(e){}}}try{d()}catch(e){}p.que.push=function(f){try{f&&f()}catch(e){}return 0};p.requestBids=function(o){try{o=o||{};var h=o.bidsBackHandler;setTimeout(function(){try{h&&h([])}catch(e){}},20)}catch(e){}};p.addAdUnits=function(){};p.setConfig=function(){}})(window.pbjs);';
        if (/criteo/.test(u)) extra += 'window.Criteo=window.Criteo||{events:[]};(function(c){if(c.__ku)return;c.__ku=1;var a=c.events instanceof Array?c.events.slice():[];c.events={push:function(f){try{f&&f()}catch(e){}return 0}};for(var i=0;i<a.length;i++){try{a[i]&&a[i]()}catch(e){}}})(window.Criteo);';
        if (/apstag|amazon-adsystem/.test(u)) extra += 'window.apstag=window.apstag||{};(function(a){if(a.__ku)return;a.__ku=1;a.fetchBids=function(s,cb){if(typeof s==="function"){cb=s}setTimeout(function(){try{cb&&cb([])}catch(e){}},20)};a.setDisplayBids=function(){};a.targetingKeys=function(){return[]};a.init=function(){}})(window.apstag);';
        return 'data:text/javascript,' + encodeURIComponent(extra);
    }
    const BAIT_IMG_STUB = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    // Rewrite an about-to-be-inserted bait resource to a stub that LOADS
    // successfully (real load events fire → detector sees success).
    function baitRewrite(node) {
        if (!stealthActive()) return node;
        try {
            if (!node || node.nodeType !== 1 || node.__killurl_stubbed) return node;
            const tag = (node.tagName || '').toUpperCase();
            const srcAttr = tag === 'LINK' ? node.getAttribute('href') : node.getAttribute('src');
            if (!srcAttr || !BAIT_URL_RE.test(srcAttr)) return node;
            node.__killurl_stubbed = true;
            try { node.setAttribute('data-killurl-orig-src', srcAttr); } catch (e) { /* ignore */ }
            if (tag === 'SCRIPT') node.setAttribute('src', baitScriptStub(srcAttr));
            else if (tag === 'IMG') node.setAttribute('src', BAIT_IMG_STUB);
            else if (tag === 'IFRAME') node.setAttribute('src', 'about:blank');
            else if (tag === 'LINK') node.setAttribute('href', 'data:text/css,');
            console.log('[KillURL] Stealth: stubbed bait resource', tag, String(srcAttr).slice(0, 80));
        } catch (e) { /* ignore */ }
        return node;
    }

    function shimGetter(proto, name, fake) {
        try {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || typeof desc.get !== 'function') return;
            const origGet = desc.get;
            Object.defineProperty(proto, name, {
                get() {
                    let real = null;
                    try { real = origGet.call(this); } catch (e) { /* ignore */ }
                    try {
                        if (stealthActive() && isBaitElement(this)) return fake(this, real);
                    } catch (e) { /* ignore */ }
                    return real;
                },
                configurable: true
            });
        } catch (e) { /* ignore */ }
    }

    function installStealthHooks() {
        if (window.__killurl_stealth_hooked) return;
        window.__killurl_stealth_hooked = true;

        // 1. Bait geometry: hidden/removed bait reports plausible ad dimensions.
        try {
            const htmlProto = window.HTMLElement ? window.HTMLElement.prototype : null;
            const elProto = window.Element ? window.Element.prototype : null;
            if (htmlProto) {
                shimGetter(htmlProto, 'offsetHeight', (el, real) => Math.max(real || 0, 250));
                shimGetter(htmlProto, 'offsetWidth', (el, real) => Math.max(real || 0, 300));
                shimGetter(htmlProto, 'offsetParent', (el, real) => real || document.body);
            }
            if (elProto) {
                shimGetter(elProto, 'clientHeight', (el, real) => Math.max(real || 0, 250));
                shimGetter(elProto, 'clientWidth', (el, real) => Math.max(real || 0, 300));
            }
        } catch (e) { /* ignore */ }

        try {
            const _origRect = Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect = function (...args) {
                let real = null;
                try { real = _origRect.apply(this, args); } catch (e) { /* ignore */ }
                try {
                    if (stealthActive() && isBaitElement(this) && (!real || (real.width === 0 && real.height === 0))) {
                        return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 250, width: 300, height: 250, toJSON() { return this; } };
                    }
                } catch (e) { /* ignore */ }
                return real;
            };
        } catch (e) { /* ignore */ }

        try {
            const _origGCS = window.getComputedStyle.bind(window);
            window.getComputedStyle = function (el, pseudo) {
                const cs = _origGCS(el, pseudo);
                try {
                    if (stealthActive() && !pseudo && isBaitElement(el) && cs && cs.display === 'none') {
                        return new Proxy(cs, {
                            get(t, p) {
                                if (p === 'display') return 'block';
                                if (p === 'visibility') return 'visible';
                                if (p === 'getPropertyValue') {
                                    return (prop) => {
                                        if (prop === 'display') return 'block';
                                        if (prop === 'visibility') return 'visible';
                                        return t.getPropertyValue(prop);
                                    };
                                }
                                const v = t[p];
                                return typeof v === 'function' ? v.bind(t) : v;
                            }
                        });
                    }
                } catch (e) { /* ignore */ }
                return cs;
            };
        } catch (e) { /* ignore */ }

        // 2. Bait resource insertion: stub before it hits the network.
        try {
            const _origAppend = Node.prototype.appendChild;
            Node.prototype.appendChild = function (n) {
                return _origAppend.call(this, baitRewrite(n));
            };
            const _origInsert = Node.prototype.insertBefore;
            Node.prototype.insertBefore = function (n, ref) {
                return _origInsert.call(this, baitRewrite(n), ref);
            };
            const _origReplace = Node.prototype.replaceChild;
            Node.prototype.replaceChild = function (n, old) {
                return _origReplace.call(this, baitRewrite(n), old);
            };
        } catch (e) { /* ignore */ }

        // 3. `new Image().src = <bait>` without DOM insertion.
        try {
            const imgDesc = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, 'src');
            if (imgDesc && typeof imgDesc.set === 'function') {
                const _origImgSet = imgDesc.set;
                Object.defineProperty(window.HTMLImageElement.prototype, 'src', {
                    set(v) {
                        try {
                            if (stealthActive() && typeof v === 'string' && BAIT_URL_RE.test(v)) {
                                console.log('[KillURL] Stealth: stubbed bait Image');
                                v = BAIT_IMG_STUB;
                            }
                        } catch (e) { /* ignore */ }
                        _origImgSet.call(this, v);
                    },
                    get: imgDesc.get,
                    configurable: true
                });
            }
        } catch (e) { /* ignore */ }

        log('Stealth hooks installed');
    }

    // Clock-shift hooks: installed once at load, dormant pass-through until a    // force-skip arms timeShiftMs. Defeats wall-clock countdowns
    // (`remaining = endTime - Date.now()`) which repeated tick-firing can't move.
    function installClockHooks() {
        if (window.__killurl_clock_hooked) return;
        window.__killurl_clock_hooked = true;
        try {
            Date.now = function () {
                const real = _origDateNow();
                if (timeShiftMs > 0 && activated && !deactivated && masterState !== false) {
                    return real + timeShiftMs;
                }
                return real;
            };
        } catch (e) { /* ignore */ }
        try {
            if (_origPerfNow && window.performance) {
                window.performance.now = function () {
                    const real = _origPerfNow();
                    if (timeShiftMs > 0 && activated && !deactivated && masterState !== false) {
                        return real + timeShiftMs;
                    }
                    return real;
                };
            }
        } catch (e) { /* ignore */ }
        // `new Date().getTime()` / `+new Date()` wall-clock reads — the most common
        // countdown style templates actually use. Shifted only while timeShiftMs
        // is armed (during a skip drive), reverted right after.
        try {
            if (!Date.prototype.__killurl_patched) {
                Date.prototype.__killurl_patched = true;
                const _origGetTime = Date.prototype.getTime;
                const _origValueOf = Date.prototype.valueOf;
                Date.prototype.getTime = function () {
                    const real = _origGetTime.call(this);
                    if (timeShiftMs > 0 && activated && !deactivated && masterState !== false) {
                        return real + timeShiftMs;
                    }
                    return real;
                };
                Date.prototype.valueOf = function () {
                    const real = _origValueOf.call(this);
                    if (timeShiftMs > 0 && activated && !deactivated && masterState !== false &&
                        this instanceof Date) {
                        return real + timeShiftMs;
                    }
                    return real;
                };
            }
        } catch (e) { /* ignore */ }
    }

    // Flip from TRACK mode to FAST mode. Cheap + idempotent.
    function activateTimerHooks() {
        if (activated) return;
        activated = true;
        installHookWrappers();
        installVisibilitySpoof();
        installClockHooks();
        installNetCapture();
        installStealthHooks();
        log('Timer hooks activated (fast mode)');
    }

    function deactivateTimerHooks() {
        deactivated = true;
        // NOTE: wrappers stay installed and pass through while deactivated —
        // restoring originals would lose the track-mode inventory and break
        // re-activation (used by aggressive-mode watching).
        if (_origRAF && window.__killurl_raf_hooked) {
            try { window.requestAnimationFrame = _origRAF; } catch (e) { /* ignore */ }
            window.__killurl_raf_hooked = false;
        }
        if (_origCancelRAF) {
            try { window.cancelAnimationFrame = _origCancelRAF; } catch (e) { /* ignore */ }
        }
        trackedRAF.clear();
        trackedIntervals.clear();
        trackedTimeouts.clear();
        timeShiftMs = 0;
        destinationCaptured = false;

        // Stop var killing + unfreeze anything frozen
        releaseVarKilling();

        log('Timer hooks DEACTIVATED (security page)');

        // If aggressive mode is on, start watching for CF challenge completion
        if (aggressiveMode && !isActualChallengeFrame()) {
            startReactivationWatcher();
        }
    }

    // ===== AGGRESSIVE MODE: RE-ACTIVATION AFTER CF COMPLETES =====

    function isActualChallengeFrame() {
        // Never re-activate on actual Cloudflare challenge iframe/page
        const hostname = window.location.hostname.toLowerCase();
        return hostname.includes('challenges.cloudflare.com') ||
            hostname.includes('recaptcha.net') ||
            hostname.includes('hcaptcha.com');
    }

    function startReactivationWatcher() {
        if (reactivationWatcher) return;
        log('Aggressive mode: watching for CF challenge completion...');

        let checkCount = 0;
        const MAX_CHECKS = 30; // 30 checks × 2s = 60s max

        // Method 1: MutationObserver for CF element removal
        const observer = new MutationObserver(() => {
            if (!hasSecurityMarkers()) {
                log('Aggressive mode: CF markers gone (mutation) — re-activating!');
                cleanupWatcher(observer);
                reactivate();
            }
        });

        try {
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['style', 'class', 'id']
            });
        } catch (e) { /* ignore */ }

        // Method 2: Periodic polling as backup
        reactivationWatcher = _origSetInterval(() => {
            checkCount++;
            if (checkCount > MAX_CHECKS) {
                log('Aggressive mode: timed out waiting for CF completion');
                cleanupWatcher(observer);
                return;
            }
            if (!hasSecurityMarkers()) {
                log('Aggressive mode: CF markers gone (poll) — re-activating!');
                cleanupWatcher(observer);
                reactivate();
            }
        }, 2000);

        function cleanupWatcher(obs) {
            try { obs.disconnect(); } catch (e) { /* */ }
            if (reactivationWatcher) {
                _origClearInterval(reactivationWatcher);
                reactivationWatcher = null;
            }
        }
    }

    function reactivate() {
        if (masterState === false) return;
        if (!aggressiveMode) return;
        log('Re-activating timer hooks after CF challenge completion');
        deactivated = false;
        activated = false; // Reset so activateTimerHooks() can run
        activateTimerHooks();
        startVarKilling();

        // Notify content script
        try {
            window.dispatchEvent(new CustomEvent('killurl-reactivated'));
        } catch (e) { /* ignore */ }
    }

    // ===== VARIABLE KILLING =====

    function killCountdownVars() {
        if (deactivated) return;
        COUNTDOWN_VAR_NAMES.forEach(varName => {
            try {
                if (typeof window[varName] !== 'undefined' && typeof window[varName] === 'number' && window[varName] > 0) {
                    log(`Zeroed variable: ${varName} = ${window[varName]} → 0`);
                    window[varName] = 0;
                }
            } catch (e) { /* ignore */ }
        });
    }

    function startVarKilling() {
        if (varKillInterval || deactivated) return;
        killCountdownVars();
        varKillInterval = _origSetInterval(killCountdownVars, 200);

        COUNTDOWN_VAR_NAMES.forEach(varName => {
            try { interceptProperty(window, varName); } catch (e) { /* skip */ }
        });
    }

    // Every property we freeze is recorded so the freeze can be LIFTED after
    // the skip completes. Freezing generic names (count, timer, delay, ...) for
    // too long bricks completion flows that reuse those names — the classic
    // "timer skipped but Continue is dead forever" failure.
    let interceptedProps = [];

    function interceptProperty(obj, prop) {
        if (deactivated) return;
        let _value = obj[prop];
        try {
            Object.defineProperty(obj, prop, {
                get() { return deactivated ? _value : 0; },
                set(v) {
                    if (!deactivated && typeof v === 'number' && v > 1) {
                        log(`Intercepted ${prop} = ${v} → 0`);
                        _value = 0;
                    } else {
                        _value = v;
                    }
                },
                configurable: true
            });
            interceptedProps.push({ obj, prop });
        } catch (e) { /* skip */ }
    }

    // Restore all frozen variables to plain data properties holding their last
    // real value, and stop the 200ms freeze loop. Called once the skip's
    // completion has been observed (or the safety timeout fires) — the page
    // keeps working normally from then on.
    function releaseVarKilling() {
        try {
            if (varKillInterval) {
                _origClearInterval(varKillInterval);
                varKillInterval = null;
            }
        } catch (e) { /* ignore */ }
        const seen = new Set();
        for (const { obj, prop } of interceptedProps) {
            try {
                if (seen.has(prop)) continue;
                seen.add(prop);
                const desc = Object.getOwnPropertyDescriptor(obj, prop);
                if (desc && (desc.get || desc.set)) {
                    let current = 0;
                    try { current = obj[prop]; } catch (e) { /* ignore */ }
                    Object.defineProperty(obj, prop, {
                        value: current,
                        writable: true,
                        configurable: true,
                        enumerable: desc.enumerable !== false
                    });
                }
            } catch (e) { /* ignore */ }
        }
        interceptedProps = [];
        log('Variable freeze released');
    }

    // ===== EVENT LISTENERS =====

    // Content script can also trigger activation (for domains not in our list)
    window.addEventListener('killurl-activate', () => {
        if (masterState === false) return;
        if (deactivated) return;
        if (isSecurityURL()) return;
        log('Activation event received');
        activateTimerHooks();
        startVarKilling();
    });

    // Arrival calm-down: the content script reached the final destination on
    // this page (previous step's found URL). No fast-activation here even on
    // allowlisted hosts. Explicit skips (force-skip/activate) still work.
    let arrivalCalm = false;
    window.addEventListener('killurl-arrived', () => {
        arrivalCalm = true;
        if (fastActivateTimer) {
            _origClearTimeout(fastActivateTimer);
            fastActivateTimer = null;
        }
        log('Arrival page — fast-activation stood down');
    });
    window.addEventListener('killurl-set-enabled', (e) => {
        masterState = e.detail?.enabled !== false;
        log('Extension enabled set to:', masterState);
        console.log(`[KillURL] master state: ${masterState ? 'ON' : 'OFF'}`);

        // Whatever was pending, the truth just arrived — cancel the grace timer.
        if (fastActivateTimer) {
            _origClearTimeout(fastActivateTimer);
            fastActivateTimer = null;
        }

        if (masterState === false) {
            // Wrappers pass through while disabled — just drop inventory + clock shift.
            // (Originals are NOT restored so re-enabling keeps working without reload.)
            deactivated = true;
            releaseVarKilling();
            trackedIntervals.clear();
            trackedTimeouts.clear();
            trackedRAF.clear();
            timeShiftMs = 0;
            destinationCaptured = false;
            log('Timer hooks disabled (extension turned off)');
        } else {
            // Re-arm so the next skip/activation works without a reload.
            // If boot deferred fast-activation waiting for exactly this signal,
            // engage it now.
            deactivated = false;
            activated = false;
            log('Timer hooks re-armed (extension turned on)');
            maybeFastActivate();
        }
    });

    // Fast-activate on known shortener domains — but ONLY once the master state
    // is known-ON. At boot the state is still null, so boot instead arms a short
    // grace timer (see BOOT section); an OFF reply landing first cancels it.
    function maybeFastActivate() {
        if (arrivalCalm) return;
        if (masterState !== true) return;
        if (activated || deactivated) return;
        if (isSecurityURL() || isActualChallengeFrame()) return;
        if (!isKnownDomain()) return;
        log(`Known shortener domain: ${window.location.hostname} — fast-activating (master ON confirmed)`);
        activateTimerHooks();
        startVarKilling();
    }

    // Content script sends the aggressive mode setting
    window.addEventListener('killurl-set-aggressive', (e) => {
        aggressiveMode = !!e.detail?.enabled;
        log('Aggressive mode set to:', aggressiveMode);
        // If already deactivated and aggressive mode just turned on, start watching
        if (aggressiveMode && deactivated && !reactivationWatcher && !isActualChallengeFrame()) {
            startReactivationWatcher();
        }
    });

    // Force skip — clear ALL timers + activate if not already
    window.addEventListener('killurl-force-skip', () => {
        if (masterState === false) {
            log('Extension turned off — refusing force-skip');
            return;
        }
        if (hasSecurityMarkers() && !aggressiveMode) {
            log('Security page — refusing force-skip (aggressive mode off)');
            window.dispatchEvent(new CustomEvent('killurl-skip-blocked', {
                detail: { reason: 'security-page' }
            }));
            return;
        }

        if (hasSecurityMarkers() && aggressiveMode) {
            log('Aggressive mode: forcing skip despite security markers');
        }

        log('Force skip triggered');
        deactivated = false; // Re-enable if somehow deactivated
        destinationCaptured = false; // fresh drive for this step

        if (!activated) {
            activateTimerHooks();
        }

        console.log('[KillURL] Force skip: driving page timers to completion...');

        // 1. Zero countdown variables FIRST (before firing callbacks)
        killCountdownVars();

        // 2. Shift the clock forward so wall-clock countdowns
        //    (endTime - Date.now(), new Date().getTime()) read as finished.
        timeShiftMs = 180000; // +3 minutes

        // 3. DRIVE tracked tick callbacks to completion. Closure-scoped counters
        //    (invisible to window-var zeroing) decrement once per invocation, so
        //    firing ~80 times simulates ~80 seconds of ticks — the page's own
        //    completion path (enable button / auto-advance / token fetch) runs
        //    naturally, and timer-gated Continue handlers see "finished".
        //    Breaks early if a destination was captured meanwhile (nothing left
        //    to drive toward) — the net sniffer sets destinationCaptured.
        const sleep = (ms) => new Promise((res) => _origSetTimeout(res, ms));
        (async () => {
            try {
                const intervalCbs = [...trackedIntervals.values()].filter(
                    (e) => e && typeof e.callback === 'function' && (!e.delay || (e.delay >= 200 && e.delay <= 2000))
                );
                log(`Driving ${intervalCbs.length} tracked interval(s) to completion...`);
                console.log(`[KillURL] Driving ${intervalCbs.length} timer(s) + ${trackedTimeouts.size} timeout(s) to completion…`);
                for (let round = 0; round < 80; round++) {
                    if (destinationCaptured) break;
                    let any = false;
                    for (const { callback, args } of intervalCbs) {
                        try { callback.call(window, ...(args || [])); any = true; } catch (e) { /* ignore */ }
                    }
                    if (!any) break;
                    if (round % 8 === 7) await sleep(50); // yield so page microtasks/DOM settle
                }
                if (destinationCaptured) log('Destination captured mid-drive — stopping early');

                // Chained-setTimeout countdowns: fire each tracked link once —
                // the chain continues through our fast hooks and finishes fast.
                if (!destinationCaptured) {
                    const timeoutCbs = [...trackedTimeouts.values()].filter(
                        (e) => e && typeof e.callback === 'function'
                    );
                    log(`Firing ${timeoutCbs.length} tracked timeout(s)...`);
                    for (const { callback, args } of timeoutCbs) {
                        try { callback.call(window, ...(args || [])); } catch (e) { /* ignore */ }
                    }
                }

                // rAF-driven countdowns: flush a few frames with an advanced clock.
                if (trackedRAF.size && !destinationCaptured) {
                    log(`Flushing ${trackedRAF.size} tracked rAF callback(s)...`);
                    for (let k = 0; k < 10; k++) {
                        if (destinationCaptured) break;
                        const rafCbs = [...trackedRAF.values()];
                        for (const { callback } of rafCbs) {
                            try { callback.call(window, _origPerfNow ? _origPerfNow() + timeShiftMs : Date.now()); } catch (e) { /* ignore */ }
                        }
                        await sleep(30);
                    }
                    trackedRAF.clear();
                }
                if (_origCancelRAF) {
                    for (let i = 1; i < 1000; i++) {
                        try { _origCancelRAF(i); } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) { /* ignore */ }
        })().then(finishDrive, finishDrive);

        function finishDrive() {
            // 4. Completion should be observable NOW — tell the content script to
            //    click immediately (no arbitrary wait: the gate is open).
            //    Runs on fulfillment AND rejection: the click wave must fire even
            //    if the drive itself blew up halfway.
            dispatchTicksDone('drive-settled');

            // 5. Cleanup AFTER a short settle (page needs a beat to run its
            //    enable-button / token-fetch continuations — clearing too early
            //    used to brick the Continue button permanently).
            _origSetTimeout(() => {
                // Unfreeze variables + revert the clock so later steps on this
                // page compute time normally again.
                timeShiftMs = 0;
                releaseVarKilling();
                // Clear only OUR tracked timers — the page's completion
                // machinery stays intact.
                for (const id of trackedIntervals.keys()) {
                    try { _origClearInterval(id); } catch (e) { /* ignore */ }
                }
                for (const id of trackedTimeouts.keys()) {
                    try { _origClearTimeout(id); } catch (e) { /* ignore */ }
                }
                trackedIntervals.clear();
                trackedTimeouts.clear();
                log('Settled: tracked timers cleared, vars + clock restored');
            }, 1500);

            // 6. Safety net: if NOTHING completed after 8s (no destination, page
            //    still here), only then nuke broadly — leftover ad/polling loops.
            _origSetTimeout(() => {
                if (destinationCaptured || masterState === false) return;
                log('No completion after 8s — broad timer cleanup as last resort');
                for (let i = 1; i < 99999; i++) {
                    _origClearTimeout(i);
                    _origClearInterval(i);
                }
            }, 8000);
        }

        // Fires ticks-done exactly once per force-skip, no matter which path
        // gets here first (drive completion OR the hard fallback below).
        let ticksDoneFired = false;
        function dispatchTicksDone(source) {
            if (ticksDoneFired) return;
            ticksDoneFired = true;
            log(`Dispatching ticks-done (${source})`);
            console.log('[KillURL] Timer drive finished — gate should be open, clicking now…');
            try {
                window.dispatchEvent(new CustomEvent('killurl-skip-ticks-done'));
            } catch (e) { /* ignore */ }
        }
        // Hard fallback: even if the drive hangs or dies silently, the content
        // script still gets its click wave 4s after the skip started.
        _origSetTimeout(() => dispatchTicksDone('fallback-4s'), 4000);

        startVarKilling();

        window.dispatchEvent(new CustomEvent('killurl-skip-done'));
    });

    // ===== BOOT: TRACK EVERYTHING FROM document_start =====
    // Zero behavior change on normal pages (original delays kept) — but when a
    // shortener flow is later detected, the full timer inventory is available
    // to drive to completion instead of just being cleared.
    console.log('[KillURL] engine v6.6 ready (track+drive+stealth) — waiting for master state…');
    installHookWrappers();
    installClockHooks();
    installStealthHooks();

    // Ask the content script for the master switch state. It replies with
    // killurl-set-enabled (fetching settings first if it hasn't loaded them
    // yet), which closes the load-order race: without this handshake the
    // injector would have to guess, and guessing ON breaks "turned OFF".
    function announceInjectorReady() {
        try {
            window.dispatchEvent(new CustomEvent('killurl-injector-ready'));
        } catch (e) { /* ignore */ }
    }
    announceInjectorReady();

    // ===== AUTO-ACTIVATION ON KNOWN DOMAINS =====
    // Deferred: at document_start the master state is still UNKNOWN (null), so
    // fast-activation waits for the content script's reply. An OFF reply cancels
    // the grace timer and we stay dormant; an ON reply (or the timeout with no
    // OFF) engages fast mode. Track-mode inventory keeps recording meanwhile.

    if (isSecurityURL()) {
        log('Security URL detected — staying dormant');
    } else if (isKnownDomain()) {
        log(`Known shortener domain: ${window.location.hostname} — waiting for master state...`);
        fastActivateTimer = _origSetTimeout(() => {
            fastActivateTimer = null;
            if (arrivalCalm) {
                log('Staying dormant (arrival page)');
                return;
            }
            if (masterState === false || deactivated) {
                log('Staying dormant (extension turned OFF or deactivated)');
                return;
            }
            // No OFF signal arrived: content script absent/blocked — fail open so
            // the bypass still works, exactly like before the master switch existed.
            masterState = true;
            maybeFastActivate();
        }, 1500);
    } else {
        log('Unknown domain — dormant (waiting for activation)');
    }

    // ===== AUTO-ACTIVATE DRM BYPASS ON STREAMING DOMAINS =====
    // CRITICAL: This hooks EME IMMEDIATELY at document_start, BEFORE the player initializes
    // On streaming domains, we always hook EME (the hook checks settings before modifying)
    if (isStreamingDomain()) {
        console.log('[KillURL] 🎬 Streaming domain detected:', window.location.hostname, '— hooking EME at document_start');
        // Preemptively enable and activate — content.js will confirm settings shortly
        // If settings say disabled, the hook will pass through unmodified
        drmBypassEnabled = true; // Assume enabled until content.js says otherwise
        activateDRMBypass();
    }

    // ===== POST-DOM SECURITY CHECK =====
    // If we auto-activated but it turns out to be a Cloudflare challenge page,
    // DEACTIVATE (wrappers pass through untouched from then on)

    window.addEventListener('DOMContentLoaded', () => {
        // Re-ask: if the content script attached its responder late, this
        // second announcement still gets us the true master state.
        announceInjectorReady();
        if (activated && !deactivated && hasSecurityMarkers()) {
            log('Cloudflare challenge detected AFTER activation — deactivating!');
            deactivateTimerHooks(); // Will start reactivation watcher if aggressive mode is on
            window.dispatchEvent(new CustomEvent('killurl-security-page', {
                detail: { aggressiveWatching: aggressiveMode }
            }));
        }
    });

    window.addEventListener('load', () => {
        if (activated && !deactivated && hasSecurityMarkers()) {
            log('Cloudflare challenge detected on load — deactivating!');
            deactivateTimerHooks(); // Will start reactivation watcher if aggressive mode is on
            window.dispatchEvent(new CustomEvent('killurl-security-page', {
                detail: { aggressiveWatching: aggressiveMode }
            }));
        }
    });

})();
