// KillURL Content Script (ISOLATED world)
// Runs on every page to detect URL shortener countdown pages and provide bypass functionality
// Works alongside injector.js (MAIN world) which handles timer interception
//
// IMPORTANT DESIGN PRINCIPLE:
// - DETECTION is always active (scanning for countdowns)
// - SKIPPING (clicking buttons, killing timers) ONLY happens when:
//   1. User clicks "Skip Countdown" in the popup, OR
//   2. User has explicitly enabled "Auto-Skip" in settings AND page is a KNOWN shortener
// - NEVER interfere with Cloudflare/captcha/security pages

(function () {
    'use strict';

    // ===== STATE =====
    let isShortenerPage = false;
    let isKnownShortener = false; // Confirmed via background domain list
    let isSecurityPage = false; // Cloudflare/captcha detected
    let destinationUrl = null;
    let countdownDetected = false;
    let settings = { enabled: true };
    let settingsLoaded = false; // true once GET_SETTINGS resolved in this context
    let userArmed = false; // true once the user explicitly hit Skip on THIS page
    let arrivedAtDestination = false; // true when this page IS the found destination
    // Smoking gun: PROOF of a real countdown (explicit wait-timer text, a digit
    // countdown element, a prominent number/clock, or a meta refresh). Weak
    // chatter ("verify", "timer", wizard steps) never sets this. Auto-action on
    // unknown pages requires this latch — structural signals alone (csrf forms,
    // generic scripts, short URLs) can never trigger clicks by themselves.
    let countdownGunSeen = false;
    let skipAttempted = false;
    let continuousScanner = null;
    let scanCount = 0;
    let injectorActivated = false;
    let mainListenersAttached = false;
    let mutationObserverAttached = false;
    // Skip sequencing: pairs each force-skip with its ticks-done wave so a late
    // event (or the fallback timer) can't double-run or cross steps.
    let skipSequence = 0;
    let lastTicksDoneToken = 0;
    function ticksDoneSeenFor(token) {
        return lastTicksDoneToken >= token;
    }

    function postDriveClickWave(source) {
        if (!isEnabled()) return;
        if (isSecurityPage && !settings.aggressiveMode) return;
        console.log(`[KillURL] Post-drive click wave (${source})`);
        revealHiddenElements();
        removeOverlays();
        handleProgressBars();
        forceEnableButtons();
        forceCountdownTextToZero();
        clickContinueButton();
        submitTokenFormIfReady();
        findDestinationUrl();
        // One more wave in case the completion handler renders async
        setTimeout(() => {
            if (!isEnabled()) return;
            if (destinationUrl) return;
            revealHiddenElements();
            forceEnableButtons();
            clickContinueButton();
            submitTokenFormIfReady();
            findDestinationUrl();
        }, 1200);
    }

    function isEnabled() {
        return settings.enabled !== false;
    }

    // Broadcast master + feature states to the MAIN-world injector. Idempotent —
    // safe to call on init, on every toggle, and as a reply to injector-ready.
    function broadcastStatesToInjector() {
        try {
            window.dispatchEvent(new CustomEvent('killurl-set-enabled', {
                detail: { enabled: settings.enabled !== false }
            }));
            window.dispatchEvent(new CustomEvent('killurl-set-aggressive', {
                detail: { enabled: !!settings.aggressiveMode }
            }));
            window.dispatchEvent(new CustomEvent('killurl-enable-drm-bypass', {
                detail: { enabled: !!settings.screenShareDRM }
            }));
            window.dispatchEvent(new CustomEvent('killurl-set-stealth', {
                detail: { enabled: settings.adblockStealth !== false }
            }));
        } catch (e) { /* ignore */ }
    }

    // ===== SECURITY PAGE DETECTION =====
    // These pages must NEVER be interfered with

    function checkSecurityPage() {
        const url = window.location.href.toLowerCase();
        const hostname = window.location.hostname.toLowerCase();

        // Cloudflare domains
        if (hostname.includes('challenges.cloudflare.com')) return true;
        if (url.includes('/cdn-cgi/') && url.includes('challenge')) return true;

        // Captcha domains
        if (hostname.includes('google.com') && url.includes('recaptcha')) return true;
        if (hostname.includes('recaptcha.net')) return true;
        if (hostname.includes('hcaptcha.com')) return true;

        return false;
    }

    function checkSecurityPageDOM() {
        try {
            const html = document.documentElement?.innerHTML || '';

            // Cloudflare challenge HTML markers (very specific element IDs/classes)
            if (html.includes('id="cf-challenge-running"') ||
                html.includes('id="challenge-running"') ||
                html.includes('cf-turnstile-wrapper') ||
                html.includes('id="challenge-form"') ||
                html.includes('id="challenge-stage"') ||
                html.includes('cf-chl-widget')) {
                return true;
            }

            // Cloudflare JS challenge scripts
            if (html.includes('/cdn-cgi/challenge-platform/')) {
                return true;
            }

            const bodyText = document.body?.textContent || '';

            // Very specific Cloudflare verification text (require BOTH text + CF HTML markers)
            if (bodyText.includes('Performing security verification') &&
                bodyText.includes('security service') && html.includes('cf-')) {
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

    // ===== TEXT PATTERNS (for DETECTION only, not auto-action) =====

    const COUNTDOWN_TEXT_PATTERNS = [
        /please wait\s*\d*/i,
        /wait\s*\d+\s*second/i,
        /\d+\s*seconds?\s*remaining/i,
        /\d+\s*seconds?\s*left/i,
        /generating\s*(your\s*)?link/i,
        /preparing\s*(your\s*)?(link|download|file)/i,
        /your\s*link\s*(is\s*)?(being\s*)?generat/i,
        /link\s*will\s*(be\s*)?ready/i,
        /loading\s*link/i,
        /processing\s*link/i,
        /scroll\s*down\s*to\s*continue/i,
        /scroll\s*down\s*to\s*(get|see|view|access)/i,
        /scroll\s*to\s*continue/i,
        /click\s*(here\s*)?to\s*continue/i,
        /click\s*(the\s*)?button\s*below/i,
        /your\s*link\s*is\s*ready/i,
        /link\s*ready/i,
        /your\s*download\s*is\s*ready/i,
        /you\s*will\s*be\s*redirected/i,
        /redirecting\s*in/i,
        /skip\s*(this\s*)?ad/i,
        /wait\s*for\s*\d+/i,
        /timer/i,
        /countdown/i,
        // ---- generic / multilingual (v2 smart engine) ----
        /verify\s*(you are|you're)?\s*(human|not a robot)/i,
        /verify\s*(to\s*)?continue/i,
        /human\s*verification/i,
        /complete\s*(the\s*)?(step|steps|task)/i,
        /unlock\s*(your\s*)?(link|download|content|button)/i,
        /your\s*link\s*(is\s*)?almost\s*ready/i,
        /link\s*(will\s*appear|appears)\s*(in|after)/i,
        /wait\s*a\s*moment/i,
        /please\s*stay\s*(on\s*this\s*page|here)/i,
        /do\s*not\s*close\s*(this\s*)?(tab|window|page)/i,
        /press\s*continue/i,
        /tap\s*(to\s*)?continue/i,
        /stay\s*on\s*page/i,
        /continue\s*in\s*\d+/i,
        /proceed\s*in\s*\d+/i,
        /you\s*(must|need to)\s*wait/i,
        // Arabic (nitro-link & clones target AR traffic)
        /انتظر/i,
        /الرجاء الانتظار/i,
        /رابطك/i,
        /الرابط/i,
        /تابع/i,
        /متابعة/i,
        /تحقق/i,
        /اضغط/i,
        /استمر/i,
    ];

    const BUTTON_TEXT_PATTERNS = [
        /^continue$/i,
        /^skip$/i,
        /^skip\s*ad$/i,
        /^get\s*link$/i,
        /^go\s*to\s*(link|download|url|page|website)/i,
        /^proceed$/i,
        /^click\s*here$/i,
        /^click\s*here\s*to\s*continue$/i,
        /^download$/i,
        /^download\s*now$/i,
        /^download\s*link$/i,
        /^go\s*to\s*link$/i,
        /^visit\s*(link|page|site|url)$/i,
        /^get\s*download\s*link$/i,
        /^generate\s*(download\s*)?link$/i,
        /^access\s*link$/i,
        /^open\s*link$/i,
        /^free\s*download$/i,
        /^direct\s*download$/i,
        /scroll\s*down\s*to\s*continue/i,
        /continue\s*to\s*/i,
        /go\s*to\s*destination/i,
        /get\s*your\s*link/i,
        /get\s*link/i,
        /getlink/i,
        // ---- generic v2: verify/unlock/next-step wording ----
        /^verify$/i,
        /verify\s*(and|&)?\s*continue/i,
        /^unlock$/i,
        /unlock\s*link/i,
        /show\s*(my\s*)?link/i,
        /reveal\s*(my\s*)?link/i,
        /get\s*my\s*link/i,
        /claim\s*(your\s*)?(link|reward|download)/i,
        /visit\s*link/i,
        /open\s*(link|download|destination)/i,
        /continue\s*→|→\s*continue/i,
        /click\s*to\s*(continue|proceed|unlock|reveal|show)/i,
        /press\s*(to\s*)?continue/i,
        /tap\s*(to\s*)?continue/i,
        /complete\s*(and|&)?\s*continue/i,
        // Arabic CTAs
        /متابعة/i,
        /استمرار/i,
        /الحصول.*رابط/i,
        /اضغط.*(هنا|متابعة|استمرار)/i,
        /تخطي/i,
    ];

    // Loose extras used ONLY in the click phase on already-qualified pages.
    // NEVER for detection scoring: bare "Next"/"Submit" appear on every wizard,
    // checkout and login form on the web — scoring them auto-arms the clicker
    // on innocent pages (random clicks / rogue form submits).
    const BUTTON_TEXT_PATTERNS_LOOSE_EXTRA = [
        /next\s*(step|page)?$/i,
        /^next$/i,
        /submit/i,
    ];

    // Explicit wait/countdown bindings. These carry real evidence (a timer the
    // page itself advertises), unlike bare "verify"/"unlock"/"step" wording.
    const STRONG_TIMER_PATTERNS = [
        /please\s*wait/i,
        /wait\s+\d+/i,
        /\d+\s*seconds?\s*(remaining|left|to\s*(go|wait))/i,
        /redirecting\s*in/i,
        /(continue|proceed).{0,12}in\s*\d+/i,
        /link\s*(will\s*appear|appears)\s*(in|after)/i,
        /generating\s*(your\s*)?link/i,
        /countdown/i,
        /you\s*(must|need to)\s*wait/i,
        /انتظر/i,
        /الرجاء الانتظار/i,
    ];

    // ===== ELEMENT SELECTORS =====

    const COUNTDOWN_SELECTORS = [
        '#countdown', '#timer', '#count', '#counter', '#seconds',
        '.countdown', '.timer', '.count', '.counter', '.seconds',
        '[id*="countdown"]', '[id*="timer"]', '[id*="count"]',
        '[class*="countdown"]', '[class*="timer"]',
        '#wait', '.wait', '#loading-time', '.loading-time',
        '#second', '.second', '#sec', '.sec',
        '#wpsafe-timer', '#wpsafe-countdown', '.wpsafe-timer',
        '#wpsafelink-countdown', '.wpsafelink-countdown',
        '#sTimer', '#short_timer', '.short_timer',
        '#scroll-timer', '.scroll-timer',
        '.progress-bar', '#progress-bar', '.progress', '#progress',
        '[role="progressbar"]',
        // ---- generic v2: modern earn-script markup ----
        '[data-countdown]', '[data-timer]', '[data-wait]', '[data-seconds]',
        '[id*="wait"]', '[class*="wait"]',
        '[id*="verify"]', '[class*="verify"]',
        '[id*="link-btn"]', '[class*="link-btn"]',
        '[id*="continue-btn"]', '[class*="continue-btn"]',
        '[id*="get-link"]', '[class*="get-link"]',
        '[id*="getlink"]', '[class*="getlink"]',
        '#countdown-timer', '.countdown-timer', '#timer-count', '.timer-count',
        '#time-left', '.time-left', '#timeLeft', '.timeLeft',
        '#step', '.step', '[id*="step"]', '[class*="step-"]',
        '.link-step', '#link-step', '.short-link-step',
    ];

    const DESTINATION_SELECTORS = [
        'a#skip', 'a.skip', 'a#continue', 'a.continue',
        'a#go-link', 'a.go-link', 'a#getlink', 'a.getlink', 'a#get-link',
        'a#btn-main', 'a.btn-main',
        'a#land-btn', 'a.land-btn',
        'a[href*="?go="]', 'a[href*="?url="]', 'a[href*="?link="]',
        'a[href*="?r="]', 'a[href*="?redirect="]', 'a[href*="?out="]',
        'a[href*="/go/"]', 'a[href*="/out/"]', 'a[href*="/redirect/"]',
        'a[href*="/link/"]', 'a[href*="/get/"]',
        'a#downloadButton', 'a.downloadButton', 'a#download-btn',
        'a.download-btn', 'a.download-link', 'a#download-link',
        'a.btn-success', 'a.btn-primary', 'a.btn-info',
        'button#continue', 'button.continue',
        'button#skip', 'button.skip',
        'button#getlink', 'button.getlink', 'button#get-link',
        '#btn-main a', '.btn-main a',
        '#wpsafe-link a', '.wpsafe-link a',
        '#wpsafe-generate a',
        '#download a', '.download a',
        '#link-box a', '.link-box a',
        '#final-link a', '.final-link a',
        // earnbox.in specific selectors
        'a.btn.btn-primary', 'button.btn.btn-primary',
        'a.btn.btn-success', 'button.btn.btn-success',
        '.earnbox-link a', '#earnbox-link a',
        // ---- generic v2: modern earn-script CTA markup ----
        'a[id*="continue"]', 'button[id*="continue"]',
        'a[class*="continue"]', 'button[class*="continue"]',
        'a[id*="get-link"]', 'button[id*="get-link"]',
        'a[class*="get-link"]', 'button[class*="get-link"]',
        'a[id*="getlink"]', 'button[id*="getlink"]',
        'a[class*="getlink"]', 'button[class*="getlink"]',
        'a[id*="verify"]', 'button[id*="verify"]',
        'a[class*="verify"]', 'button[class*="verify"]',
        'a[id*="link-btn"]', 'button[id*="link-btn"]',
        'form#go-link button', 'form.go-link button', 'form[id*="go"] button[type="submit"]',
        'form button[type="submit"]',
        'input[type="submit"][value*="ontinue" i]', 'input[type="button"][value*="ontinue" i]',
        '[role="button"][id*="link" i]', '[role="button"][id*="continue" i]',
    ];

    const HIDDEN_DURING_COUNTDOWN = [
        '#skip', '.skip', '#continue', '.continue',
        '#go-link', '.go-link', '#getlink', '.getlink',
        '#btn-main', '.btn-main',
        '#download', '.download',
        '#land-btn', '.land-btn',
        '#wpsafe-link', '.wpsafe-link',
        '#wpsafe-generate', '.wpsafe-generate',
        '#scroll-to-continue', '.scroll-to-continue',
        '#final-link', '.final-link',
        '#result-link', '.result-link',
        '#link-box', '.link-box',
        '#continue-btn', '.continue-btn',
        '#skip-btn', '.skip-btn',
        // ---- generic v2 ----
        '#link-btn', '.link-btn', '#get-link', '.get-link',
        '#verify', '.verify', '#unlock', '.unlock',
        '.btn-continue', '.btn-continue2', '.btn-success',
        '.link-step', '#link-step',
    ];

    // ===== INITIALIZATION =====

    function ensureInjectorLoaded() {
        try {
            const pageWindow = typeof window.wrappedJSObject !== 'undefined' ? window.wrappedJSObject : window;
            if (!pageWindow.__killurl_injector_loaded) {
                const api = typeof browser !== 'undefined' && browser.runtime ? browser : chrome;
                const script = document.createElement('script');
                script.src = api.runtime.getURL('content/injector.js');
                script.onload = function () {
                    this.remove();
                };
                (document.head || document.documentElement).appendChild(script);
                console.log('[KillURL] Injected injector.js into MAIN world via DOM fallback');
            }
        } catch (e) {
            console.error('[KillURL] Failed to ensure injector script loaded:', e);
        }
    }

    async function init() {
        ensureInjectorLoaded();

        try {
            settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        } catch (e) {
            settings = {};
        }
        // Default to enabled for old installs without the flag
        if (typeof settings.enabled === 'undefined') settings.enabled = true;
        settingsLoaded = true;

        // Tell MAIN world injector the master state ASAP (even when disabled,
        // so it can undo its document_start auto-activation)
        broadcastStatesToInjector();
        if (settings.screenShareDRM) {
            console.log('[KillURL] DRM screen share bypass setting sent to MAIN world: ENABLED');
        }

        // Master switch OFF → stay completely dormant
        if (settings.enabled === false) {
            console.log('[KillURL] Extension is turned OFF — dormant');
            return;
        }

        // Arrival check: did the previous step send us here as the DESTINATION?
        // If so this is the page the user actually wanted — stand down all
        // auto-action (no clicks, submits, or jumps) so we can't bounce them
        // back into the shortener loop. Manual Skip still works (userArmed).
        // Sticky per page-load: the background entry is one-shot, so a later
        // re-init (e.g. OFF→ON toggle) must not lose the arrival state.
        if (!arrivedAtDestination) {
            try {
                const arr = await chrome.runtime.sendMessage({ type: 'CHECK_ARRIVED', url: window.location.href });
                if (arr?.arrived) {
                    arrivedAtDestination = true;
                    console.log('[KillURL] Destination reached — standing down auto-action on this page');
                    try {
                        // Tell the injector too: no fast-activation here even if
                        // this host is allowlisted. Manual Skip is unaffected.
                        window.dispatchEvent(new CustomEvent('killurl-arrived'));
                    } catch (e) { /* ignore */ }
                    return;
                }
            } catch (e) { /* background unreachable: proceed normally */ }
        } else {
            console.log('[KillURL] Destination reached — standing down auto-action on this page');
            return;
        }

        // Early security check (URL-based, before DOM is ready)
        if (checkSecurityPage()) {
            isSecurityPage = true;
            console.log('[KillURL] Security page detected');
        }

        // If security page detected early and aggressive mode is OFF, bail out
        if (isSecurityPage && !settings.aggressiveMode) {
            console.log('[KillURL] Security page — all actions disabled (aggressive mode off)');
            return;
        }

        // Listen for events from MAIN world injector (attach once)
        if (!mainListenersAttached) {
            mainListenersAttached = true;
            window.addEventListener('killurl-timer-intercepted', (e) => {
                if (!isEnabled()) return;
                console.log('[KillURL] Timer intercepted by injector:', e.detail);
                if (!countdownDetected) {
                    countdownDetected = true;
                    isShortenerPage = true;
                    notifyStatus();
                }
            });

            window.addEventListener('killurl-url-found', (e) => {
                if (!isEnabled()) return;
                if (e.detail?.url && isValidDestination(e.detail.url)) {
                    destinationUrl = e.detail.url;
                    try { chrome.runtime.sendMessage({ type: 'FOUND_DESTINATION', url: destinationUrl }); } catch (err) { /* */ }
                }
            });

            window.addEventListener('killurl-skip-done', () => {
                if (!isEnabled()) return;
                console.log('[KillURL] Skip completed — revealing elements');
                revealHiddenElements();
                forceEnableButtons();
            });

            // Fired by the injector AFTER tick-driving finished and the page had
            // a beat to process completion: the timer gate should be open NOW,
            // so this is the highest-value moment to click.
            window.addEventListener('killurl-skip-ticks-done', () => {
                lastTicksDoneToken = skipSequence;
                postDriveClickWave('ticks-done-event');
            });

            window.addEventListener('killurl-security-page', (e) => {
                console.log('[KillURL] Security page confirmed by injector — disabling');
                isSecurityPage = true;
                stopContinuousScanner();
                if (e.detail?.aggressiveWatching) {
                    console.log('[KillURL] Aggressive mode: waiting for CF to complete...');
                }
            });

            window.addEventListener('killurl-reactivated', () => {
                if (!isEnabled()) return;
                console.log('[KillURL] Aggressive mode: re-activated after CF completion!');
                isSecurityPage = false;
                skipAttempted = false;
                scanCount = 0;
                // Re-start scanning
                detectShortenerPage();
                passiveScan();
                startContinuousScanner();
                notifyStatus();
                maybeAutoSkip();
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onDOMReady);
        } else {
            onDOMReady();
        }
    }

    // Called when master switch is toggled live (no page reload needed)
    function handleEnabledChanged(enabled) {
        settings.enabled = enabled;
        settingsLoaded = true;
        broadcastStatesToInjector();

        if (!enabled) {
            stopContinuousScanner();
            isShortenerPage = false;
            countdownDetected = false;
            destinationUrl = null;
            console.log('[KillURL] Turned OFF — detection stopped');
            return;
        }

        // Turned back ON — (re)start detection
        console.log('[KillURL] Turned ON — (re)starting detection');
        isSecurityPage = checkSecurityPage() || checkSecurityPageDOM();
        if (isSecurityPage && !settings.aggressiveMode) return;
        skipAttempted = false;
        countdownGunSeen = false;
        scanCount = 0;
        broadcastStatesToInjector();
        // init() attaches MAIN listeners once and runs onDOMReady; safe to call again
        if (!mainListenersAttached) {
            init();
        } else {
            detectShortenerPage();
            passiveScan();
            startContinuousScanner();
            if (settings.removeAdBlockWalls) removeAdBlockWalls();
        }
    }

    function onDOMReady() {
        if (!isEnabled()) return;
        // Check security page via DOM markers
        if (checkSecurityPageDOM()) {
            isSecurityPage = true;
            if (!settings.aggressiveMode) {
                console.log('[KillURL] Security page (DOM) detected — all actions disabled');
                return;
            }
            console.log('[KillURL] Security page (DOM) detected — aggressive mode, continuing...');
        }

        // DETECTION only — no skipping
        detectShortenerPage();
        setupMutationObserver();
        startContinuousScanner();

        // earnbox.in specific: watch for button changes more aggressively
        const hostname = window.location.hostname.replace(/^www\./, '');
        if (hostname === 'earnbox.in') {
            setupEarnboxWatcher();
        }

        // Auto-remove ad-block walls if enabled
        if (settings.removeAdBlockWalls) {
            // Run multiple times as walls can appear after a delay
            [500, 1500, 3000, 5000].forEach(delay => {
                setTimeout(() => removeAdBlockWalls(), delay);
            });
        }

        // Re-check at intervals
        [500, 1000, 2000, 3000, 5000, 8000].forEach(delay => {
            setTimeout(() => {
                if (isSecurityPage && !settings.aggressiveMode) return;
                // Re-check for security (some pages load CF challenge after a moment)
                if (checkSecurityPageDOM()) {
                    isSecurityPage = true;
                    if (!settings.aggressiveMode) {
                        stopContinuousScanner();
                        return;
                    }
                }
                detectShortenerPage();
                passiveScan();
            }, delay);
        });
    }

    // earnbox.in specific watcher for button appearances
    function setupEarnboxWatcher() {
        console.log('[KillURL] earnbox.in: Setting up button watcher...');
        
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const text = (node.textContent || '').toLowerCase();
                            // Check if a button with relevant text was added
                            if (text.includes('get link') || text.includes('continue') || text.includes('proceed')) {
                                console.log('[KillURL] earnbox.in: New button detected, attempting click...');
                                setTimeout(() => {
                                    clickEarnboxButton();
                                }, 500);
                            }
                        }
                    }
                }
                
                // Watch for style/class changes that might reveal buttons
                if (mutation.type === 'attributes' && (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
                    const target = mutation.target;
                    if (target.nodeType === Node.ELEMENT_NODE) {
                        const text = (target.textContent || '').toLowerCase();
                        if ((text.includes('get link') || text.includes('continue')) && isVisible(target)) {
                            console.log('[KillURL] earnbox.in: Button became visible, attempting click...');
                            setTimeout(() => {
                                clickEarnboxButton();
                            }, 500);
                        }
                    }
                }
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'disabled', 'hidden']
        });
    }

    // ===== CONTINUOUS SCANNER (PASSIVE — detection only, no clicking) =====

    function startContinuousScanner() {
        if (!isEnabled()) return;
        if (continuousScanner) return;

        continuousScanner = setInterval(() => {
            if (isSecurityPage && !settings.aggressiveMode) {
                stopContinuousScanner();
                return;
            }

            scanCount++;
            passiveScan();

            // Stop scanning after 2 minutes
            if (scanCount > 120) {
                stopContinuousScanner();
            }
        }, 1000);
    }

    function stopContinuousScanner() {
        if (continuousScanner) {
            clearInterval(continuousScanner);
            continuousScanner = null;
        }
    }

    // Passive scan — detect only, no clicking or modifying
    function passiveScan() {
        if (!isEnabled()) return;
        detectCountdownByText();
        detectVisibleContinueButtons();
        findDestinationUrl();
    }

    // ===== TEXT-BASED DETECTION =====

    function detectCountdownByText() {
        if (isSecurityPage && !settings.aggressiveMode) return;
        // Keep scanning until PROOF is found: an early weak match (bare
        // "verify"/"timer" chatter) must not block a later strong match from
        // setting the gun and unlocking auto-action.
        if (countdownDetected && isShortenerPage && countdownGunSeen) return;

        const bodyText = document.body?.innerText || '';

        // Strong (explicit wait-timer) patterns first — these are proof.
        for (const pattern of STRONG_TIMER_PATTERNS) {
            if (pattern.test(bodyText)) {
                console.log(`[KillURL] Countdown detected by strong text: ${pattern}`);
                countdownDetected = true;
                countdownGunSeen = true;
                isShortenerPage = true;
                notifyStatus();
                maybeAutoSkip();
                return;
            }
        }

        // Weak chatter only matters before anything was found at all.
        if (!(countdownDetected && isShortenerPage)) {
            for (const pattern of COUNTDOWN_TEXT_PATTERNS) {
                if (pattern.test(bodyText)) {
                    console.log(`[KillURL] Countdown detected by text: ${pattern}`);
                    countdownDetected = true;
                    isShortenerPage = true;
                    notifyStatus();
                    maybeAutoSkip();
                    return;
                }
            }
        }

        // Check for prominent countdown numbers (value 1-300, mm:ss, or bare digits)
        const elements = document.querySelectorAll('div, span, p, h1, h2, h3, h4, h5, h6, strong, b, em');
        for (const el of elements) {
            if (!isVisible(el)) continue;
            if (el.children.length > 0) continue; // leaf nodes only (avoid whole-page text)
            const text = el.textContent.trim();
            if (/^\d{1,3}$/.test(text)) {
                const num = parseInt(text);
                if (num >= 1 && num <= 300) {
                    try {
                        const fontSize = parseFloat(window.getComputedStyle(el).fontSize);
                        if (fontSize >= 14) {
                            console.log(`[KillURL] Countdown number detected: ${num} (${fontSize}px)`);
                            countdownDetected = true;
                            countdownGunSeen = true;
                            isShortenerPage = true;
                            notifyStatus();
                            maybeAutoSkip();
                            return;
                        }
                    } catch (e) { /* ignore */ }
                }
            } else if (/^0?0:\d{1,2}$/.test(text) || /^\d{1,2}:\d{2}$/.test(text)) {
                console.log(`[KillURL] Countdown clock detected: ${text}`);
                countdownDetected = true;
                countdownGunSeen = true;
                isShortenerPage = true;
                notifyStatus();
                maybeAutoSkip();
                return;
            }
        }
    }

    // Detect visible continue/skip buttons (for popup status display)
    function detectVisibleContinueButtons() {
        const clickables = document.querySelectorAll('a, button, input[type="submit"], input[type="button"]');
        for (const el of clickables) {
            if (!isVisible(el)) continue;
            const text = (el.textContent || el.value || '').trim();
            for (const pattern of BUTTON_TEXT_PATTERNS) {
                if (pattern.test(text)) {
                    const href = el.getAttribute('href');
                    if (href && href !== '#' && !href.startsWith('javascript:') && isValidDestination(href)) {
                        destinationUrl = href;
                        try { chrome.runtime.sendMessage({ type: 'FOUND_DESTINATION', url: destinationUrl }); } catch (e) { /* */ }
                    }
                    return;
                }
            }
        }
    }

    // ===== AUTO-SKIP LOGIC =====
    // Auto-skips only with consent + evidence (see canAutoAct): known domain,
    // explicit per-page arming via the Skip button, strong multi-signal proof
    // on unknown domains, or aggressive-mode opt-in. Weak matches (a bare
    // "timer" word, a wizard's Next button) NEVER auto-arm the clicker.

    function maybeAutoSkip() {
        if (!isEnabled()) return;
        if (isSecurityPage && !settings.aggressiveMode) return;
        if (skipAttempted) return;
        if (!settings.autoSkip) return;
        if (!canAutoAct()) {
            // Logged once per page — the continuous scanner re-evaluates often.
            if (!maybeAutoSkip._withheldLogged) {
                maybeAutoSkip._withheldLogged = true;
                console.log('[KillURL] Auto-skip withheld: insufficient evidence (enable Aggressive mode or press Skip manually)');
            }
            return;
        }
        if (isKnownShortener) {
            console.log('[KillURL] Auto-skip triggered on known shortener' +
                (isSecurityPage ? ' (aggressive mode)' : ''));
        } else if (userArmed) {
            console.log('[KillURL] Auto-skip triggered (user armed this page)');
        } else {
            console.log(`[KillURL] Auto-skip on strong-evidence page (score=${getConfidence().score})`);
        }

        skipAttempted = true;

        // Stubborn multi-step earn templates (timer + token form + chained steps)
        // need longer retry windows — nitro-link.com behaves like earnbox.in here.
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();
        const isStubbornSite = hostname === 'earnbox.in' ||
            hostname.endsWith('nitro-link.com') || hostname.endsWith('nitrolink.com') ||
            hostname.endsWith('nitro-links.com') || hasTokenForm();

        // Schedule multiple skip attempts with increasing delays
        // Early attempts use gentle skip (DOM only, don't kill page timers)
        // Later attempts use full skip (nuclear option) after page has loaded
        const baseDelay = settings.skipDelay || 500;

        let attempts;
        if (isStubbornSite) {
            // Stubborn sites need more attempts with longer delays (timers up to ~20s + steps)
            attempts = [
                { delay: baseDelay, gentle: true },  // ~0.5s
                { delay: baseDelay + 1500, gentle: true },  // ~2s
                { delay: baseDelay + 3000, gentle: true },  // ~3.5s
                { delay: baseDelay + 5000, gentle: true },  // ~5.5s
                { delay: baseDelay + 7000, gentle: false },  // ~7.5s — full skip
                { delay: baseDelay + 10000, gentle: false },  // ~10.5s — full skip
                { delay: baseDelay + 13000, gentle: false },  // ~13.5s — full skip
                { delay: baseDelay + 16000, gentle: false },  // ~16.5s — full skip
                { delay: baseDelay + 20000, gentle: false },  // ~20.5s — full skip
                { delay: baseDelay + 25000, gentle: false },  // ~25.5s — full skip (final)
            ];
        } else {
            attempts = [
                { delay: baseDelay, gentle: true },  // ~0.5s
                { delay: baseDelay + 1500, gentle: true },  // ~2s
                { delay: baseDelay + 3000, gentle: true },  // ~3.5s
                { delay: baseDelay + 5000, gentle: true },  // ~5.5s
                { delay: baseDelay + 8000, gentle: false },  // ~8.5s — full skip
                { delay: baseDelay + 12000, gentle: false },  // ~12.5s — full skip
                { delay: baseDelay + 17000, gentle: false },  // ~17.5s — full skip (final)
            ];
        }

        attempts.forEach(({ delay, gentle }, index) => {
            setTimeout(() => {
                if (!isEnabled()) return;
                console.log(`[KillURL] Auto-skip attempt ${index + 1}/${attempts.length} (${gentle ? 'gentle' : 'full'})`);
                if (gentle) {
                    executeGentleSkip();
                } else {
                    executeSkip();
                }
            }, delay);
        });

        // Arm the autopilot clicker so chained steps keep advancing on their own
        armAutopilot();
    }

    // ===== DETECT SHORTENER (domain check + universal heuristics) =====

    function detectShortenerPage() {
        if (!isEnabled()) return;
        if (isSecurityPage && !settings.aggressiveMode) return;
        const hostname = window.location.hostname.replace(/^www\./, '');

        chrome.runtime.sendMessage(
            { type: 'CHECK_SHORTENER', hostname },
            (response) => {
                if (response?.isShortener) {
                    isKnownShortener = true;
                    isShortenerPage = true;
                    notifyStatus();
                    maybeAutoSkip();
                    return;
                }

                // Heuristic detection (selector/text based)
                if (detectCountdownElements()) {
                    isShortenerPage = true;
                    notifyStatus();
                    maybeAutoSkip();
                    return;
                }

                // Universal confidence scoring — catches unknown domains/templates
                // (e.g. nitro-link.com before it was allowlisted, new clones)
                try {
                    const { score, reasons } = computeShortenerConfidence();
                    if (score >= 2) {
                        console.log(`[KillURL] Shortener detected by heuristics (score=${score}: ${reasons.join(',')})`);
                        isShortenerPage = true;
                        if (reasons.includes('countdown-text') || reasons.includes('countdown-element')) {
                            countdownDetected = true;
                        }
                        notifyStatus();
                        maybeAutoSkip();
                    }
                } catch (e) { /* ignore */ }
            }
        );
    }

    function detectCountdownElements() {
        for (const selector of COUNTDOWN_SELECTORS) {
            try {
                const el = document.querySelector(selector);
                if (el && isVisible(el)) {
                    const text = el.textContent.trim();
                    if (/\d/.test(text) && text.length < 30) {
                        countdownDetected = true;
                        countdownGunSeen = true; // visible digit countdown = proof
                        return true;
                    }
                }
            } catch (e) { /* skip */ }
        }

        for (const selector of HIDDEN_DURING_COUNTDOWN) {
            try {
                const el = document.querySelector(selector);
                if (el && !isVisible(el)) {
                    countdownDetected = true;
                    return true;
                }
            } catch (e) { /* skip */ }
        }

        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        if (metaRefresh) {
            const content = metaRefresh.getAttribute('content') || '';
            const urlMatch = content.match(/url=(.+)/i);
            if (urlMatch) {
                destinationUrl = urlMatch[1].trim().replace(/['"]/g, '');
                countdownGunSeen = true; // timed redirect = proof
                return true;
            }
        }

        return false;
    }

    // ===== UNIVERSAL SHORTENER CONFIDENCE (v2 smart engine) =====
    // Scores independent signals so ANY shortener/earn template is recognised,
    // even if its domain is unknown and its wording is new or non-English.
    // Score >= 2  => treat as shortener page.
    // Score >= 3  => high confidence (auto-skip may engage without aggressive mode).

    function hasShortCodePath() {
        try {
            const parts = window.location.pathname.split('/').filter(Boolean);
            if (parts.length === 1 && /^[A-Za-z0-9]{3,12}$/.test(parts[0])) return true;
            if (parts.length === 2 && /^[A-Za-z0-9]{3,12}$/.test(parts[1]) &&
                /^(go|link|links|out|redirect|visit|continue|s|v|u)$/i.test(parts[0])) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    function hasTokenForm() {
        try {
            const forms = document.querySelectorAll('form');
            for (const form of forms) {
                let hiddenNames = '';
                try {
                    hiddenNames = [...form.querySelectorAll('input[type="hidden"]')]
                        .map(i => (i.name || i.id || '').toLowerCase()).join(' ');
                } catch (e) { /* ignore */ }
                // Hidden token inputs (checked by NAME so label words like
                // "keyboard" can't false-positive).
                if (/_token|csrf|authenticity|__requestverificationtoken|link_id|\btoken\b|alias|slug/.test(hiddenNames)) {
                    const btn = form.querySelector('button, input[type="submit"], input[type="button"], a');
                    if (btn) return true;
                }
                if (/go-link|go_link|golink/.test((form.id + ' ' + form.className + ' ' + form.action).toLowerCase())) return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function hasTimerScript() {
        try {
            const scripts = document.querySelectorAll('script:not([src])');
            for (const script of scripts) {
                const c = script.textContent || '';
                if (c.length < 20 || c.length > 200000) continue;
                // NOTE: no bare "location" in the second half — window.location
                // appears in virtually every web app's scripts and caused
                // false positives on ordinary pages.
                if (/setTimeout|setInterval|countdown|timer|seconds?\s*[-=]|timeLeft|time_left|wait/i.test(c) &&
                    /continue|get.?link|verify|proceed|redirect/i.test(c)) {
                    return true;
                }
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function hasCountdownOrCTA() {
        try {
            const bodyText = document.body?.innerText || '';
            let strongHit = false;
            let textHit = false;
            for (const pattern of STRONG_TIMER_PATTERNS) {
                if (pattern.test(bodyText)) { strongHit = true; textHit = true; break; }
            }
            if (!strongHit) {
                for (const pattern of COUNTDOWN_TEXT_PATTERNS) {
                    if (pattern.test(bodyText)) { textHit = true; break; }
                }
            }
            const clickables = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]');
            let ctaHit = false;
            for (const el of clickables) {
                const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                if (!text) continue;
                // STRICT on purpose: bare Next/Submit/Continue-reading controls
                // must never count as shortener evidence.
                if (matchesCTA(text, false)) { ctaHit = true; break; }
            }
            return { strongHit, textHit, ctaHit };
        } catch (e) { return { strongHit: false, textHit: false, ctaHit: false }; }
    }

    function computeShortenerConfidence() {
        let score = 0;
        const reasons = [];
        try {
            if (hasShortCodePath()) { score += 1; reasons.push('short-code-url'); }
            if (hasTokenForm()) { score += 2; reasons.push('token-form'); }
            if (hasTimerScript()) { score += 2; reasons.push('timer-script'); }
            const { strongHit, textHit, ctaHit } = hasCountdownOrCTA();
            if (strongHit) { score += 3; reasons.push('countdown-text-strong'); }
            else if (textHit) { score += 1; reasons.push('countdown-text'); }
            if (ctaHit) { score += 1; reasons.push('cta-button'); }
            if (detectCountdownElements()) { score += 2; reasons.push('countdown-element'); }
            const meta = document.querySelector('meta[http-equiv="refresh"]');
            if (meta) { score += 1; reasons.push('meta-refresh'); }
        } catch (e) { /* ignore */ }
        return { score, reasons };
    }

    // Cached confidence (script/content scans on every call would be wasteful
    // inside mutation-driven hot paths like the autopilot).
    let confidenceCache = { score: 0, reasons: [], at: 0 };
    function getConfidence() {
        try {
            const now = Date.now();
            if (confidenceCache.at > 0 && now - confidenceCache.at < 2000) return confidenceCache;
            const r = computeShortenerConfidence();
            confidenceCache = { score: r.score, reasons: r.reasons, at: now };
            return confidenceCache;
        } catch (e) { return { score: 0, reasons: [], at: 0 }; }
    }

    // Central consent + evidence gate. NOTHING may auto-click, auto-submit or
    // auto-navigate unless this returns true:
    //  - this page is NOT the reached destination (arrival always stands down
    //    auto-action; explicit per-page arming via Skip still works), AND
    //  - known shortener domain, OR
    //  - the user explicitly hit Skip on THIS page (userArmed), OR
    //  - PROVEN countdown (smoking gun) + strong multi-signal evidence
    //    (score >= 6) — structural signals alone can never qualify, so random
    //    pages with csrf forms and generic scripts stay untouched, OR
    //  - aggressive mode + a detected countdown (explicit opt-in for the long tail).
    function canAutoAct() {
        if (!isEnabled()) return false;
        if (arrivedAtDestination && !userArmed) return false;
        if (isSecurityPage && !settings.aggressiveMode) return false;
        if (isKnownShortener) return true;
        if (userArmed) return true;
        if (!countdownGunSeen) return false;
        try {
            if (getConfidence().score >= 6) return true;
        } catch (e) { /* ignore */ }
        if (settings.aggressiveMode && countdownDetected) return true;
        return false;
    }

    function notifyStatus() {
        try {
            chrome.runtime.sendMessage({ type: 'PAGE_STATUS', detected: true });
        } catch (e) { /* ignore */ }
        findDestinationUrl();
    }

    // ===== EXECUTE GENTLE SKIP (auto-skip — DOM only, doesn't kill timers) =====
    // Safe to run early — won't break page loading

    function executeGentleSkip() {
        if (!isEnabled()) return;
        if (isSecurityPage && !settings.aggressiveMode) return;

        console.log('[KillURL] Gentle skip — DOM manipulation only...');

        // DOM manipulation — reveal buttons, remove overlays
        revealHiddenElements();
        removeOverlays();
        handleProgressBars();
        forceEnableButtons();
        forceCountdownTextToZero();
        findDestinationUrl();

        // Try clicking continue buttons
        setTimeout(() => {
            if (!isEnabled()) return;
            clickContinueButton();
            submitTokenFormIfReady();
            findDestinationUrl();
        }, 300);
    }

    // ===== EXECUTE SKIP (manual click or escalated auto-skip — full nuclear) =====
    // This clears ALL timers and zeros variables — can break page loading if run too early

    function executeSkip() {
        if (!isEnabled()) {
            console.log('[KillURL] Skip blocked — extension is turned OFF');
            return;
        }
        if (isSecurityPage && !settings.aggressiveMode) {
            console.log('[KillURL] Skipping blocked — security page (aggressive mode off)');
            return;
        }

        if (isSecurityPage && settings.aggressiveMode) {
            console.log('[KillURL] Aggressive mode: forcing skip despite security page detection');
        }

        console.log('[KillURL] Executing skip...');
        // Manual skips arm the autopilot so chained steps keep advancing.
        // This is explicit per-page consent: the user asked THIS page to act.
        userArmed = true;
        armAutopilot();

        // 1. Activate the MAIN world injector (hooks timers)
        if (!injectorActivated) {
            injectorActivated = true;
            window.dispatchEvent(new CustomEvent('killurl-activate'));
        }

        // 2. Force-skip in MAIN world (clears all timers, zeros variables)
        const skipToken = ++skipSequence;
        const skipHref = window.location.href;
        window.dispatchEvent(new CustomEvent('killurl-force-skip'));

        // Also request background to inject skip script (belt + suspenders)
        try { chrome.runtime.sendMessage({ type: 'INJECT_SKIP_SCRIPT' }); } catch (e) { /* */ }

        // Fallback click wave: if the injector's ticks-done event never arrives
        // (lost event, slow drive), still run the post-drive routine at +3.5s.
        // The event path and this fallback share one guard — whichever fires
        // first wins, the other becomes a no-op for this skip token.
        setTimeout(() => {
            if (skipToken !== skipSequence) return;
            if (!isEnabled()) return;
            if (destinationUrl) return;
            if (window.location.href !== skipHref) return;
            if (ticksDoneSeenFor(skipToken)) return;
            console.log('[KillURL] Ticks-done event missing — running fallback click wave');
            postDriveClickWave('fallback-3.5s');
        }, 3500);

        // 3. DOM manipulation — reveal buttons, remove overlays
        revealHiddenElements();
        removeOverlays();
        handleProgressBars();
        forceEnableButtons();
        forceCountdownTextToZero();

        // 4. Try clicking continue buttons
        setTimeout(() => {
            if (!isEnabled()) return;
            clickContinueButton();
            submitTokenFormIfReady();
            findDestinationUrl();
        }, 200);

        // 5. Retry at intervals (longer window for stubborn multi-step templates)
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();
        const isStubbornSite = hostname === 'earnbox.in' ||
            hostname.endsWith('nitro-link.com') || hostname.endsWith('nitrolink.com') ||
            hasTokenForm();

        const retryDelays = isStubbornSite
            ? [500, 1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 13000, 16000, 20000, 25000]
            : [500, 1000, 2000, 3000, 5000, 8000, 12000];

        retryDelays.forEach(delay => {
            setTimeout(() => {
                if (!isEnabled()) return;
                revealHiddenElements();
                forceEnableButtons();
                forceCountdownTextToZero();
                clickContinueButton();
                submitTokenFormIfReady();
                findDestinationUrl();
            }, delay);
        });
    }

    // ===== SMART HELPERS (v2): countdown forcing, token forms, autopilot =====

    // Never touch captchas / challenge widgets — clicking those breaks pages
    // and can lock the user out.
    function isProtectedWidget(el) {
        try {
            if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
            if (el.closest('iframe')) return true;
            const probe = (el.outerHTML || '').slice(0, 2000).toLowerCase();
            if (/cf-turnstile|cf-challenge|challenge-form|g-recaptcha|recaptcha|hcaptcha|turnstile|challenge-platform|cdn-cgi\/challenge/.test(probe)) return true;
            const ancestor = el.closest('[class*="captcha" i], [id*="captcha" i], [class*="turnstile" i], [class*="challenge" i]');
            if (ancestor) return true;
        } catch (e) { return true; }
        return false;
    }

    function isSafeToClick(el) {
        try {
            if (!el || el.disabled) return false;
            if (isProtectedWidget(el)) return false;
            const type = (el.getAttribute('type') || '').toLowerCase();
            if (type === 'checkbox' || type === 'radio') return false; // never auto-toggle opt-ins
            const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
            if (/captcha|i'm not a robot|i am not a robot|turnstile/.test(text)) return false;
        } catch (e) { return false; }
        return true;
    }

    // CTA matcher. Strict (default) = detection scoring + reveal/enable/form
    // decisions: must NOT fire on ordinary "Next", "Submit", "Continue reading"
    // or "Proceed to checkout" controls. Loose = click phase on an already
    // qualified page (or explicit user arming), where recall matters more.
    function matchesCTA(text, loose = false) {
        if (!text) return false;
        const t = text.trim();
        if (!t) return false;
        for (const pattern of BUTTON_TEXT_PATTERNS) {
            if (pattern.test(t)) return true;
        }
        if (loose) {
            for (const pattern of BUTTON_TEXT_PATTERNS_LOOSE_EXTRA) {
                if (pattern.test(t)) return true;
            }
        }
        const lower = t.toLowerCase();
        if (lower.includes('get link') || lower.includes('getlink') ||
            lower.includes('unlock') || lower.includes('verify') ||
            lower.includes('visit link') || lower.includes('show link') ||
            lower.includes('reveal') || lower.includes('متابعة') ||
            lower.includes('استمرار') || lower.includes('تخطي')) {
            return true;
        }
        if (loose) {
            // Bare continue/proceed only when something already qualified the page:
            // "Continue reading" / "Proceed to checkout" must never score points.
            return lower.includes('continue') || lower.includes('proceed');
        }
        return false;
    }

    // Rewrite visible countdown numbers (e.g. "12", "00:12", "wait 10s") to zero
    // soBtn-enabling scripts observe completion on their next tick.
    function forceCountdownTextToZero() {
        try {
            const els = document.querySelectorAll('div, span, p, h1, h2, h3, h4, h5, h6, strong, b, em, li, td');
            for (const el of els) {
                if (el.children.length > 0) continue; // leaf text nodes only
                if (!isVisible(el)) continue;
                const text = (el.textContent || '').trim();
                if (!text || text.length > 24) continue;
                if (/^(\d{1,3})\s*(s|sec|secs|seconds)?$/i.test(text)) {
                    const num = parseInt(text, 10);
                    if (num > 0 && num <= 300) {
                        el.textContent = el.textContent.replace(String(num), '0');
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } else if (/^0?0:\d{1,2}$/.test(text)) {
                    el.textContent = '0:00';
                } else if (/^(please\s*wait|wait|loading)[.…\s\d]*$/i.test(text)) {
                    // leave the label, zero any embedded number
                    const m = text.match(/\d+/);
                    if (m) el.textContent = el.textContent.replace(m[0], '0');
                }
            }
        } catch (e) { /* ignore */ }
    }

    // Many earn templates (nitro-link included) gate the next step behind a
    // form carrying a server token. Once buttons are enabled, submit it.
    // HARD RULES (these burned us before): only with canAutoAct consent, only
    // token-style forms, and NEVER login/payment/upload forms — a CSRF token
    // plus a "Continue" button describes every login page on the web.
    function submitTokenFormIfReady() {
        if (!canAutoAct()) return false;
        try {
            const forms = document.querySelectorAll('form');
            for (const form of forms) {
                if (isProtectedWidget(form)) continue;
                // Never touch credential/payment/upload forms, no matter what.
                try {
                    if (form.querySelector('input[type="password"], input[type="email"], input[type="file"], input[type="month"], input[name*="card" i], input[name*="cvv" i], input[name*="pass" i]')) continue;
                } catch (e) { /* ignore */ }
                const btn = form.querySelector('button:not([disabled]), input[type="submit"]:not([disabled]), input[type="button"]:not([disabled])');
                if (!btn) continue;
                const label = ((btn.textContent || btn.value || '') + ' ' + (btn.getAttribute('aria-label') || ''));
                const formText = ((form.textContent || '') + ' ' + label);
                if (!matchesCTA(label) && !matchesCTA(formText)) continue;
                if (!isSafeToClick(btn)) continue;
                // Token markers required — AND a real countdown context (or a
                // known shortener, or explicit user arming). csrf alone is NOT
                // evidence: every login/checkout form on the web has one.
                // (Checked against hidden input NAMES, not raw HTML, so words
                // like "keyboard" or "hashtag" in labels can't qualify.)
                let hiddenNames = '';
                try {
                    hiddenNames = [...form.querySelectorAll('input[type="hidden"]')]
                        .map(i => (i.name || i.id || '').toLowerCase()).join(' ');
                } catch (e) { /* ignore */ }
                const html = (form.innerHTML || '').toLowerCase();
                const isTokenForm = /go-link|go_link|golink/.test((form.id + ' ' + form.className + ' ' + form.action).toLowerCase()) ||
                    /_token|csrf|authenticity|__requestverificationtoken|link_id|\btoken\b|alias|slug/.test(hiddenNames) ||
                    /__requestverificationtoken|link_id/.test(html);
                const hasCsrfOnly = !isTokenForm && /(csrf)/.test(hiddenNames + ' ' + html);
                if (!isTokenForm && !hasCsrfOnly) continue;
                if (!countdownDetected && !isKnownShortener && !userArmed) continue;
                const action = (form.getAttribute('action') || '').trim();
                if (!action || action === '#' || /^javascript:/i.test(action)) {
                    // JS-handled token post (fetch): only with a real token.
                    if (!isTokenForm) continue;
                }
                console.log('[KillURL] Auto-submitting token form...');
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit(btn);
                } else {
                    btn.click();
                }
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    // Autopilot: once armed (auto-skip engaged or user hit Skip), watch the DOM
    // for up to 60s and advance every chained step the moment its button/form
    // becomes available. This is what cracks multi-step templates hands-free.
    let autopilotArmed = false;
    let autopilotObserver = null;
    let autopilotTimer = null;

    function armAutopilot() {
        if (!isEnabled()) return;
        if (autopilotArmed) return;
        autopilotArmed = true;
        console.log('[KillURL] Autopilot armed — advancing chained steps automatically');
        try {
            if (autopilotObserver) autopilotObserver.disconnect();
            autopilotObserver = new MutationObserver(() => {
                if (!isEnabled() || !autopilotArmed) return;
                if (isSecurityPage && !settings.aggressiveMode) return;
                autopilotTick();
            });
            autopilotObserver.observe(document.documentElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['style', 'class', 'disabled', 'hidden', 'href', 'aria-disabled']
            });
        } catch (e) { /* ignore */ }
        if (autopilotTimer) clearTimeout(autopilotTimer);
        autopilotTimer = setTimeout(disarmAutopilot, 60000);
        // Immediate first tick in case the step is already present
        setTimeout(() => { if (autopilotArmed) autopilotTick(); }, 400);
    }

    function disarmAutopilot() {
        autopilotArmed = false;
        try { if (autopilotObserver) autopilotObserver.disconnect(); } catch (e) { /* ignore */ }
        autopilotObserver = null;
        if (autopilotTimer) { clearTimeout(autopilotTimer); autopilotTimer = null; }
    }

    let lastAutopilotClick = 0;
    function autopilotTick() {
        if (!isEnabled() || !autopilotArmed) return;
        // NOTE: no canAutoAct() re-check here on purpose — arming was already
        // gated, and re-scoring mid-flow false-negatives once the countdown
        // text vanishes post-completion. Clicks stay capped, form submits stay
        // hardened, and direct navigation stays gated inside navigateOrClick.
        const now = Date.now();
        if (now - lastAutopilotClick < 800) return; // max ~1 click/sec, human-like
        // Destination already found via fetch hook? Offer it and stop.
        if (destinationUrl) { disarmAutopilot(); return; }
        revealHiddenElements();
        forceEnableButtons();
        forceCountdownTextToZero();
        if (clickContinueButton()) {
            lastAutopilotClick = now;
            setTimeout(() => findDestinationUrl(), 400);
            return;
        }
        if (submitTokenFormIfReady()) {
            lastAutopilotClick = now;
            setTimeout(() => findDestinationUrl(), 800);
        }
    }

    // ===== FIND DESTINATION URL =====

    function setDestination(url) {
        if (!url) return false;
        let candidate = String(url).trim().replace(/^['"]+|['";,]+$/g, '');
        if (!candidate) return false;
        // Unwrap URL-encoded / double-encoded values (?url=https%3A%2F%2F...)
        for (let i = 0; i < 3; i++) {
            try {
                const decoded = decodeURIComponent(candidate);
                if (decoded === candidate) break;
                candidate = decoded;
            } catch (e) { break; }
        }
        // Unwrap base64 payloads
        if (/^[A-Za-z0-9+/=]{24,}$/.test(candidate) && !candidate.includes('://')) {
            try {
                const decoded = atob(candidate);
                if (/^https?:\/\//i.test(decoded)) candidate = decoded;
            } catch (e) { /* ignore */ }
        }
        if (isValidDestination(candidate)) {
            if (destinationUrl !== candidate) {
                console.log('[KillURL] Destination found:', candidate.slice(0, 120));
            }
            destinationUrl = candidate;
            try { chrome.runtime.sendMessage({ type: 'FOUND_DESTINATION', url: destinationUrl }); } catch (e) { /* */ }
            // Destination known — tell the injector to unfreeze page variables
            // so the page (and its next step) computes normally from here on.
            try { window.dispatchEvent(new CustomEvent('killurl-release-vars')); } catch (e) { /* */ }
            return true;
        }
        return false;
    }

    function findDestinationUrl() {
        // 1. Known selector patterns (check ALL matches, prefer visible)
        const seen = new Set();
        for (const selector of DESTINATION_SELECTORS) {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    if (seen.has(el)) return;
                    seen.add(el);
                    const href = el.getAttribute('href') || el.dataset?.url || el.dataset?.href ||
                        el.dataset?.link || el.dataset?.redirect || el.dataset?.target;
                    if (href && setDestination(href)) return;
                });
                if (destinationUrl) return;
            } catch (e) { /* skip */ }
        }

        // 2. Text-based link scan (smart CTA matcher)
        const allLinks = document.querySelectorAll('a[href]');
        for (const link of allLinks) {
            const href = link.getAttribute('href');
            if (!href || href === '#' || href.startsWith('javascript:')) continue;

            const text = ((link.textContent || '') + ' ' + (link.getAttribute('aria-label') || '')).trim();
            if (!text) continue;

            if (matchesCTA(text) && setDestination(href)) return;
        }

        // 3. Token-form actions carrying the next-step URL
        try {
            document.querySelectorAll('form[action]').forEach(form => {
                const action = form.getAttribute('action');
                if (action && action !== '#' && setDestination(action)) return;
            });
            if (destinationUrl) return;
        } catch (e) { /* ignore */ }

        // 4. onclick / data-* attributes anywhere
        try {
            document.querySelectorAll('[onclick], [data-url], [data-href], [data-link], [data-redirect], [data-target], [data-destination], [data-next]').forEach(el => {
                const onclick = el.getAttribute('onclick') || '';
                if (onclick) {
                    const m = onclick.match(/https?:\/\/[^'"()\s]+/i);
                    if (m && setDestination(m[0])) return;
                }
                const d = el.dataset || {};
                for (const key of ['url', 'href', 'link', 'redirect', 'target', 'destination', 'next']) {
                    if (d[key] && setDestination(d[key])) return;
                }
            });
            if (destinationUrl) return;
        } catch (e) { /* ignore */ }

        // 5. Scripts + JSON blobs (timer scripts often embed the target)
        const scripts = document.querySelectorAll('script:not([src])');
        for (const script of scripts) {
            const content = script.textContent;
            if (!content || content.length < 10 || content.length > 500000) continue;

            const urlPatterns = [
                /(?:var|let|const)\s+(?:url|link|redirect|destination|target|go|href|finalUrl|final_url|redirectUrl|redirect_url|nextUrl|next_url)\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi,
                /window\.location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/gi,
                /location\.replace\(\s*['"](https?:\/\/[^'"]+)['"]\s*\)/gi,
                /window\.open\(\s*['"](https?:\/\/[^'"]+)['"]/gi,
                /"(?:destination|redirect|target|final|next|url)"\s*:\s*"(https?:\/\/[^"]+)"/gi,
                /atob\(\s*['"]([A-Za-z0-9+/=]{20,})['"]\s*\)/gi,
            ];

            for (const pattern of urlPatterns) {
                let match;
                while ((match = pattern.exec(content)) !== null) {
                    let url = match[1];
                    if (/^[A-Za-z0-9+/=]+$/.test(url) && url.length > 20 && !url.includes('://')) {
                        try { url = atob(url); } catch (e) { /* */ }
                    }
                    if (url && url.startsWith('http') && setDestination(url)) return;
                }
            }
        }

        // 6. URL params (?url= / ?go= / ?r= ...) — some templates leak the target
        try {
            const params = new URLSearchParams(window.location.search);
            for (const key of ['url', 'u', 'go', 'to', 'link', 'dest', 'destination', 'target', 'r', 'redirect', 'out', 'next']) {
                const v = params.get(key);
                if (v && setDestination(v)) return;
            }
        } catch (e) { /* ignore */ }
    }

    // ===== DOM MODIFICATION (only during skip) =====

    function forceShow(el) {
        if (!el) return;
        el.style.setProperty('display', 'block', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('pointer-events', 'auto', 'important');
        el.style.setProperty('height', 'auto', 'important');
        el.style.setProperty('max-height', 'none', 'important');
        el.style.setProperty('overflow', 'visible', 'important');
        el.style.setProperty('z-index', '99999', 'important');
        el.style.setProperty('transform', 'none', 'important');
        el.style.setProperty('clip', 'auto', 'important');
        el.style.setProperty('clip-path', 'none', 'important');
        el.removeAttribute('disabled');
        el.removeAttribute('aria-disabled');
        el.removeAttribute('aria-hidden');
        el.classList.remove('hidden', 'd-none', 'invisible', 'hide', 'disabled', 'none', 'ng-hide');
    }

    function revealHiddenElements() {
        const allSelectors = [...HIDDEN_DURING_COUNTDOWN, ...DESTINATION_SELECTORS];
        const processed = new Set();

        for (const selector of allSelectors) {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    if (processed.has(el)) return;
                    processed.add(el);
                    forceShow(el);
                });
            } catch (e) { /* skip */ }
        }

        // Also scan buttons/links with relevant text (smart CTA matcher)
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]').forEach(el => {
            const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
            if (!text) return;

            if (matchesCTA(text) && !isVisible(el)) {
                if (isProtectedWidget(el)) return;
                forceShow(el);
                // Walk up parents
                let parent = el.parentElement;
                let depth = 0;
                while (parent && depth < 5) {
                    if (!isVisible(parent)) forceShow(parent);
                    parent = parent.parentElement;
                    depth++;
                }
            }
        });
    }

    function forceEnableButtons() {
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]').forEach(el => {
            const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
            if (!text) return;

            if (matchesCTA(text)) {
                if (isProtectedWidget(el)) return;
                if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
                    el.disabled = false;
                    el.removeAttribute('aria-disabled');
                    el.removeAttribute('disabled');
                    el.style.setProperty('pointer-events', 'auto', 'important');
                    el.style.setProperty('opacity', '1', 'important');
                }
                // Uncover pointer-events:none ancestors (common timer-gate trick)
                try {
                    let parent = el.parentElement;
                    let depth = 0;
                    while (parent && depth < 3) {
                        const ps = window.getComputedStyle(parent);
                        if (ps.pointerEvents === 'none') {
                            parent.style.setProperty('pointer-events', 'auto', 'important');
                        }
                        parent = parent.parentElement;
                        depth++;
                    }
                } catch (e) { /* ignore */ }

                // Fix onclick handlers: extract URL instead of removing the handler
                const onclick = el.getAttribute('onclick') || '';
                if (onclick) {
                    // Extract any URL from the onclick handler
                    const urlMatch = onclick.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) ||
                        onclick.match(/location\.replace\(['"]([^'"]+)['"]\)/i) ||
                        onclick.match(/window\.open\(['"]([^'"]+)['"]/);
                    if (urlMatch && urlMatch[1]) {
                        // Preserve the URL as href so direct navigation works
                        if (el.tagName === 'A' && (!el.getAttribute('href') || el.getAttribute('href') === '#' || el.getAttribute('href') === 'javascript:void(0)')) {
                            el.setAttribute('href', urlMatch[1]);
                        }
                    }
                    // Remove only the "return false" part, keep the rest of the handler
                    if (onclick.includes('return false') || onclick.includes('return !')) {
                        const fixed = onclick.replace(/;?\s*return\s+(false|![a-z01])\s*;?/gi, ';');
                        el.setAttribute('onclick', fixed);
                    }
                }
            }
        });
    }

    function removeOverlays() {
        const overlaySelectors = [
            '#overlay', '.overlay', '#ad-overlay', '.ad-overlay',
            '.modal-backdrop', '#modal-backdrop',
            '.ad-container', '#ad-container',
            '.splash-overlay', '#splash-overlay',
            '.blocker', '#blocker',
        ];

        overlaySelectors.forEach(selector => {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    if (el.querySelector('a[href], button, input[type="submit"]')) {
                        el.style.setProperty('background', 'transparent', 'important');
                    } else {
                        el.style.setProperty('display', 'none', 'important');
                    }
                });
            } catch (e) { /* skip */ }
        });

        document.body.style.setProperty('overflow', 'auto', 'important');
        document.documentElement.style.setProperty('overflow', 'auto', 'important');
    }

    function handleProgressBars() {
        document.querySelectorAll('.progress-bar, [role="progressbar"], .progress').forEach(el => {
            el.style.setProperty('width', '100%', 'important');
            el.style.setProperty('transition', 'none', 'important');
            el.setAttribute('aria-valuenow', '100');
            // Fire completion events: templates gating Continue on the filling
            // animation listen for these — trigger them immediately.
            try {
                el.dispatchEvent(new TransitionEvent('transitionend', { bubbles: true }));
                el.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
            } catch (e) {
                try { el.dispatchEvent(new Event('transitionend', { bubbles: true })); } catch (err) { /* ignore */ }
            }
        });
    }

    // Fire a HUMAN-LIKE press sequence, not just .click(). Many earn templates
    // bind pointerdown/mousedown (faster on mobile, and .click() alone never
    // fires those) — a lone synthetic click is silently ignored there while a
    // real press works. This is the #1 "timer skipped but Continue is dead" cause.
    function dispatchFullClickSequence(el) {
        try {
            const rect = el.getBoundingClientRect?.();
            const cx = rect ? rect.left + rect.width / 2 : 0;
            const cy = rect ? rect.top + rect.height / 2 : 0;
            const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: 1 };
            try { el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new PointerEvent('pointerenter', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new PointerEvent('pointerdown', base)); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new MouseEvent('mousedown', base)); } catch (e) { /* ignore */ }
            try { el.focus?.(); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            el.click();
        } catch (e) { /* ignore */ }
    }

    // If an invisible ad/overlay div sits ON TOP of the button (very common on
    // earn pages), human presses land on the overlay, not the button. Detect via
    // hit-testing and neutralize the blocker — never touch captcha widgets.
    function clearPointBlockers(el) {
        try {
            const rect = el.getBoundingClientRect?.();
            if (!rect) return;
            for (let i = 0; i < 5; i++) {
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const top = document.elementFromPoint(cx, cy);
                if (!top || top === el || el.contains(top)) return;
                if (top === document.body || top === document.documentElement) return;
                if (isProtectedWidget(top)) return;
                // Don't nuke the page's own button wrapper — only true overlays.
                if (top.contains(el)) return;
                top.style.setProperty('pointer-events', 'none', 'important');
                console.log('[KillURL] Neutralized overlay covering the Continue button:', top.tagName, top.id || top.className);
            }
        } catch (e) { /* ignore */ }
    }

    // Click a CTA and keep re-clicking as its gate opens (timer-gated handlers
    // ignore early clicks — the click that lands right after the page marks
    // completion is the one that advances). Capped so we never spam.
    function clickWhenReady(el, timeoutMs = 6000) {
        if (!el || !isSafeToClick(el)) return false;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
        clearPointBlockers(el);
        const pageHref = window.location.href;
        let clicks = 0;
        const MAX_CLICKS = 8;
        const doClick = () => {
            if (!isEnabled()) return;
            if (clicks >= MAX_CLICKS) return;
            if (!document.contains(el)) return;
            if (!isSafeToClick(el)) return;
            clicks++;
            clearPointBlockers(el);
            dispatchFullClickSequence(el);
        };
        doClick();
        try {
            const observer = new MutationObserver(() => {
                // Button changed (text/class/disabled) — gate may have opened
                setTimeout(doClick, 150);
            });
            observer.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
            const poller = setInterval(() => {
                if (!isEnabled()) { clearInterval(poller); observer.disconnect(); return; }
                doClick();
                findDestinationUrl();
                if (clicks >= MAX_CLICKS || destinationUrl || window.location.href !== pageHref) {
                    clearInterval(poller);
                    observer.disconnect();
                }
            }, 700);
            setTimeout(() => {
                clearInterval(poller);
                observer.disconnect();
                // Nothing advanced (same page, no destination): the gate needs a
                // real trusted press — tell the user one manual click finishes it.
                if (isEnabled() && window.location.href === pageHref && !destinationUrl) {
                    showPageHint('KillURL: timer skipped — click Continue once yourself to proceed');
                }
            }, timeoutMs);
        } catch (e) { /* ignore */ }
        return true;
    }

    // Small in-page notice (own shadow-free div, auto-removed). Used when the
    // timer is dead but the final press needs a human (trusted-event gates).
    function showPageHint(text) {
        try {
            if (document.getElementById('killurl-hint')) return;
            const div = document.createElement('div');
            div.id = 'killurl-hint';
            div.textContent = text;
            div.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);' +
                'background:#111128;color:#34d399;font:600 13px system-ui,sans-serif;' +
                'padding:10px 18px;border-radius:10px;border:1px solid rgba(52,211,153,.4);' +
                'box-shadow:0 4px 24px rgba(0,0,0,.5);z-index:2147483647;cursor:pointer;';
            div.addEventListener('click', () => div.remove());
            document.documentElement.appendChild(div);
            setTimeout(() => { try { div.remove(); } catch (e) { /* ignore */ } }, 9000);
        } catch (e) { /* ignore */ }
    }

    function clickContinueButton() {
        // Site-specific handlers
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();

        // earnbox.in specific handling
        if (hostname === 'earnbox.in') {
            const found = clickEarnboxButton();
            // If earnbox handler didn't find anything, fall through to generic handler
            if (found) return true;
            console.log('[KillURL] earnbox.in: Falling back to generic handler...');
        }

        // Try to click or navigate via known button selectors
        const buttonSelectors = [
            '#skip', '.skip', 'a#skip', 'a.skip',
            '#continue', '.continue', 'a#continue', 'a.continue',
            '#go-link', '.go-link', 'a#go-link', 'a.go-link',
            '#getlink', '.getlink', 'a#getlink', 'a.getlink',
            '#btn-main', '.btn-main', 'a#btn-main', 'a.btn-main',
            '#land-btn', '.land-btn',
            '#wpsafe-link a', '.wpsafe-link a',
            '#wpsafe-generate a',
            '#download a', '.download a',
            '#scroll-to-continue', '.scroll-to-continue',
            '#continue-btn', '.continue-btn',
            '#skip-btn', '.skip-btn',
            '#link-btn', '.link-btn', '#get-link', '.get-link',
            '#verify', '.verify', 'form#go-link button', 'form.go-link button',
        ];

        for (const selector of buttonSelectors) {
            try {
                const btn = document.querySelector(selector);
                if (btn && isVisible(btn) && !btn.disabled && isSafeToClick(btn)) {
                    navigateOrClick(btn);
                    return true;
                }
            } catch (e) { /* skip */ }
        }

        // Fallback: smart text-based click (covers unknown templates/wordings).
        // Loose matching is fine here — the page already qualified (or the user
        // explicitly armed it via Skip).
        const clickables = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]');
        for (const el of clickables) {
            if (!isVisible(el) || el.disabled) continue;
            if (!isSafeToClick(el)) continue;
            const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
            if (matchesCTA(text, true)) {
                console.log('[KillURL] Clicking Continue:', text.slice(0, 60));
                navigateOrClick(el);
                return true;
            }
        }
        return false;
    }

    // earnbox.in specific button clicking logic
    // earnbox.in has a two-step process:
    // Step 1: Timer countdown → "Get Link" button appears
    // Step 2: After clicking "Get Link" → "Continue" button appears
    function clickEarnboxButton() {
        if (!isEnabled()) return false;
        console.log('[KillURL] earnbox.in: Looking for buttons (Get Link or Continue)...');
        
        // Strategy 1: Look for buttons/links with specific text patterns (check hidden ones too)
        const allClickables = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]');
        for (const el of allClickables) {
            const text = (el.textContent || el.value || '').toLowerCase().trim();
            
            // Check for "Get Link" button (Step 1)
            if (text.includes('get link') || text === 'getlink' || text.includes('get your link')) {
                console.log('[KillURL] earnbox.in: Found "Get Link" button (Step 1):', text, 'visible:', isVisible(el));
                // Force show it and all parents
                forceShow(el);
                let parent = el.parentElement;
                let depth = 0;
                while (parent && depth < 5) {
                    forceShow(parent);
                    parent = parent.parentElement;
                    depth++;
                }
                setTimeout(() => {
                    el.click();
                    console.log('[KillURL] earnbox.in: Clicked "Get Link", waiting for Continue button...');
                    // After clicking Get Link, wait and look for Continue button
                    setTimeout(() => {
                        clickEarnboxButton(); // Recursive call to find Continue button
                    }, 1500);
                }, 500);
                return true;
            }
            
            // Check for "Continue" button (Step 2)
            if (text === 'continue' || text.includes('continue to') || text === 'proceed' || text === 'next') {
                console.log('[KillURL] earnbox.in: Found "Continue" button (Step 2):', text, 'visible:', isVisible(el));
                // Force show it and all parents
                forceShow(el);
                let parent = el.parentElement;
                let depth = 0;
                while (parent && depth < 5) {
                    forceShow(parent);
                    parent = parent.parentElement;
                    depth++;
                }
                setTimeout(() => {
                    navigateOrClick(el);
                    console.log('[KillURL] earnbox.in: Clicked "Continue" button');
                }, 500);
                return true;
            }
        }

        // Strategy 2: Look for primary/success buttons (check hidden ones too)
        const primaryButtons = document.querySelectorAll('.btn-primary, .btn-success, .btn.btn-primary, .btn.btn-success, .btn-info, .btn.btn-block');
        for (const btn of primaryButtons) {
            if (btn.tagName !== 'A' && btn.tagName !== 'BUTTON') continue;
            
            const text = (btn.textContent || '').toLowerCase().trim();
            // Skip if it's clearly not the right button
            if (text.includes('login') || text.includes('sign up') || text.includes('register') || text.includes('submit')) continue;
            
            console.log('[KillURL] earnbox.in: Found primary/success button:', text, 'visible:', isVisible(btn));
            // Force show it and all parents
            forceShow(btn);
            let parent = btn.parentElement;
            let depth = 0;
            while (parent && depth < 5) {
                forceShow(parent);
                parent = parent.parentElement;
                depth++;
            }
            setTimeout(() => {
                btn.click();
                console.log('[KillURL] earnbox.in: Clicked button, checking for next step...');
                // Wait and check if there's another button to click
                setTimeout(() => {
                    clickEarnboxButton();
                }, 1500);
            }, 500);
            return true;
        }

        // Strategy 3: Look for any link/button with destination-like text (check hidden ones too)
        const allLinks = document.querySelectorAll('a[href], button');
        for (const el of allLinks) {
            const text = (el.textContent || '').toLowerCase().trim();
            const href = el.getAttribute('href');
            
            // Look for destination-like text
            if (text && (text.includes('link') || text.includes('continue') || text.includes('proceed') || text.includes('next') || text.includes('skip'))) {
                // Skip navigation links
                if (text.includes('home') || text.includes('about') || text.includes('contact') || text.includes('privacy')) continue;
                
                console.log('[KillURL] earnbox.in: Found potential button/link:', text, href || '(button)', 'visible:', isVisible(el));
                // Force show it and all parents
                forceShow(el);
                let parent = el.parentElement;
                let depth = 0;
                while (parent && depth < 5) {
                    forceShow(parent);
                    parent = parent.parentElement;
                    depth++;
                }
                setTimeout(() => {
                    if (href && href !== '#' && !href.startsWith('javascript:')) {
                        navigateOrClick(el);
                    } else {
                        el.click();
                        // Wait and check for next step
                        setTimeout(() => {
                            clickEarnboxButton();
                        }, 1500);
                    }
                }, 500);
                return true;
            }
        }

        console.log('[KillURL] earnbox.in: No button found yet, will retry...');
        return false;
    }

    function navigateOrClick(el) {
        if (!isSafeToClick(el)) return;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }

        // Get href from element or its parent link
        let href = el.getAttribute('href');
        if (!href || href === '#' || href.startsWith('javascript:')) {
            // Check data attributes
            href = el.dataset?.url || el.dataset?.href || el.dataset?.link;
        }
        if (!href || href === '#' || href.startsWith('javascript:')) {
            // Check parent <a>
            const parentLink = el.closest('a[href]');
            if (parentLink) {
                const parentHref = parentLink.getAttribute('href');
                if (parentHref && parentHref !== '#' && !parentHref.startsWith('javascript:')) {
                    href = parentHref;
                }
            }
        }
        // Also check onclick for embedded URLs
        if (!href || href === '#' || href.startsWith('javascript:')) {
            const onclick = el.getAttribute('onclick') || '';
            const urlMatch = onclick.match(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/i) ||
                onclick.match(/location\.replace\(['"]([^'"]+)['"]\)/i);
            if (urlMatch) href = urlMatch[1];
        }

        // If the CTA is (or wraps) a real link to another page, navigate
        // directly — this bypasses timer-gated and isTrusted-gated click
        // handlers entirely. Direct jumps need consent (canAutoAct): without
        // it we only press the button in place, never leave the page.
        // Pure-JS buttons fall through to gated clicking.
        if (href && (href.startsWith('http') || href.startsWith('/')) && isValidDestination(href) && canAutoAct()) {
            console.log('[KillURL] Navigating directly via CTA href:', href);
            window.location.href = href;
            // Still click (capped) in case navigation is intercepted
            setTimeout(() => { clickWhenReady(el, 3000); }, 300);
            return;
        }

        // No usable href (timer-gated button like your Continue): click now and
        // keep re-clicking as the gate opens.
        setTimeout(() => {
            clickWhenReady(el);
        }, 200);
    }

    // ===== UTILITIES =====

    function isVisible(el) {
        if (!el) return false;
        try {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                parseFloat(style.opacity) > 0 &&
                el.offsetWidth > 0 &&
                el.offsetHeight > 0;
        } catch (e) {
            return false;
        }
    }

    function isValidDestination(url) {
        if (!url) return false;
        url = url.trim();
        if (url.startsWith('/go/') || url.startsWith('/out/') || url.startsWith('/redirect/') || url.startsWith('/link/')) return true;
        if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
        try {
            const destHost = new URL(url).hostname.replace(/^www\./, '');
            const currentHost = window.location.hostname.replace(/^www\./, '');
            return destHost !== currentHost;
        } catch (e) {
            return false;
        }
    }

    // ===== MUTATION OBSERVER (passive — detection only) =====

    function setupMutationObserver() {
        if (mutationObserverAttached) return;
        mutationObserverAttached = true;
        const observer = new MutationObserver((mutations) => {
            if (!isEnabled()) return;
            if (isSecurityPage && !settings.aggressiveMode) return;

            let shouldScan = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check if CF challenge was injected after load
                            const html = node.innerHTML || '';
                            if (html.includes('cf-challenge') || html.includes('cf-turnstile') || html.includes('challenge-platform')) {
                                isSecurityPage = true;
                                if (!settings.aggressiveMode) {
                                    stopContinuousScanner();
                                    return;
                                }
                            }

                            const text = (node.textContent || '').toLowerCase();
                            if (text.includes('continue') || text.includes('skip') ||
                                text.includes('get link') || text.includes('scroll down') ||
                                text.includes('download') || text.includes('click here')) {
                                shouldScan = true;
                            }
                        }
                    }
                }

                if (mutation.type === 'attributes') {
                    const target = mutation.target;
                    if (mutation.attributeName === 'disabled' || mutation.attributeName === 'style' ||
                        mutation.attributeName === 'class' || mutation.attributeName === 'href') {
                        const text = (target.textContent || '').toLowerCase();
                        if (text.includes('continue') || text.includes('skip') ||
                            text.includes('get link') || text.includes('scroll down')) {
                            shouldScan = true;
                        }
                    }
                }
            }

            if (shouldScan) {
                setTimeout(() => passiveScan(), 100);
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'disabled', 'href', 'aria-disabled', 'aria-hidden']
        });
    }

    // ===== AD-BLOCK WALL REMOVAL =====

    function removeAdBlockWalls() {
        if (!isEnabled()) return 0;
        let removed = 0;

        // Text patterns that identify ad-block detection overlays
        const adblockTextPatterns = [
            /ad\s*block/i,
            /ad\s*blocker/i,
            /adblock/i,
            /please\s*(disable|turn\s*off|deactivate|whitelist|remove)/i,
            /disable\s*(your\s*)?ad/i,
            /turn\s*off\s*(your\s*)?ad/i,
            /deactivate\s*(your\s*)?ad/i,
            /whitelist\s*(this|our)/i,
            /ad\s*blocking\s*(software|extension|plugin)/i,
            /\u0645\u0627\u0646\u0639\s*\u0627\u0644\u0625\u0639\u0644\u0627\u0646\u0627\u062a/i, // Arabic: ad blocker
            /adblocker\s*(detected|enabled|found|active)/i,
            /we\s*detected\s*(an?\s*)?ad/i,
            /you\s*(are|'re)\s*using\s*(an?\s*)?ad/i,
        ];

        // Known ad-block wall selectors (common libraries/plugins)
        const knownSelectors = [
            '#adblock-notice', '.adblock-notice',
            '#adblock-modal', '.adblock-modal',
            '#adblock-overlay', '.adblock-overlay',
            '#adblock-wrapper', '.adblock-wrapper',
            '#ab-message', '.ab-message',
            '#adblockDetect', '.adblockDetect',
            '#adb-enabled', '.adb-enabled',
            '#adblock_message', '.adblock_message',
            '#adblock-popup', '.adblock-popup',
            '#adblock-banner', '.adblock-banner',
            '#adbdetect', '.adbdetect',
            '#blockMsg', '.blockMsg',
            '.adblock-warning', '#adblock-warning',
            '.adblocker-root', '#adblocker-root',
            '.disable-adblock', '#disable-adblock',
            '[id*="adblock"]', '[id*="adbDetect"]',
            '[class*="adblock"]', '[class*="adbDetect"]',
            '[id*="AdBlock"]', '[class*="AdBlock"]',
            '.fc-consent-root', // Funding Choices
        ];

        // 1. Remove by known selectors
        for (const selector of knownSelectors) {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    const text = (el.textContent || '').toLowerCase();
                    if (text.includes('ad') && (text.includes('block') || text.includes('disable'))) {
                        el.remove();
                        removed++;
                    }
                });
            } catch (e) { /* skip */ }
        }

        // 2. Scan all fixed/absolute elements for ad-block text
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            try {
                const style = window.getComputedStyle(el);
                const isOverlay = (style.position === 'fixed' || style.position === 'absolute') &&
                    parseInt(style.zIndex || '0') > 100;
                if (!isOverlay) continue;

                const text = (el.textContent || '').substring(0, 1000); // limit for perf
                let isAdBlockWall = false;
                for (const pattern of adblockTextPatterns) {
                    if (pattern.test(text)) {
                        isAdBlockWall = true;
                        break;
                    }
                }

                if (isAdBlockWall) {
                    el.remove();
                    removed++;
                }
            } catch (e) { /* skip */ }
        }

        // 3. Remove common backdrop/dimmer overlays left behind
        document.querySelectorAll('div, section').forEach(el => {
            try {
                const style = window.getComputedStyle(el);
                if (style.position === 'fixed' &&
                    parseInt(style.zIndex || '0') > 100 &&
                    (style.backgroundColor.includes('rgba') || parseFloat(style.opacity) < 0.9) &&
                    el.children.length === 0 &&
                    (el.textContent || '').trim() === '') {
                    // Empty backdrop overlay — remove it
                    el.remove();
                    removed++;
                }
            } catch (e) { /* skip */ }
        });

        // 4. Restore body scroll
        if (removed > 0) {
            document.body.style.setProperty('overflow', 'auto', 'important');
            document.documentElement.style.setProperty('overflow', 'auto', 'important');
            document.body.style.setProperty('position', 'static', 'important');
            document.body.classList.remove('modal-open', 'no-scroll', 'noscroll', 'overflow-hidden');
            console.log(`[KillURL] Removed ${removed} ad-block wall element(s)`);
        }

        return removed;
    }

    // ===== MESSAGE HANDLER =====

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.type) {
            case 'ENABLED_CHANGED':
                handleEnabledChanged(!!message.enabled);
                sendResponse({ success: true, enabled: isEnabled() });
                break;

            case 'EXECUTE_SKIP':
            case 'DO_SKIP':
                if (!isEnabled()) {
                    sendResponse({ success: false, disabled: true, destinationUrl });
                    break;
                }
                // USER explicitly clicked skip
                executeSkip();
                sendResponse({
                    success: !isSecurityPage || !!settings.aggressiveMode,
                    destinationUrl,
                    isSecurityPage: isSecurityPage && !settings.aggressiveMode,
                    aggressiveMode: !!settings.aggressiveMode
                });
                break;

            case 'SHORTENER_DETECTED':
                if (!isEnabled()) { sendResponse({ success: false, disabled: true }); break; }
                isKnownShortener = true;
                isShortenerPage = true;
                if (message.autoSkip) settings.autoSkip = true;
                if (message.autoRedirect) settings.autoRedirect = true;
                notifyStatus();
                maybeAutoSkip();
                sendResponse({ success: true });
                break;

            case 'GET_STATUS':
                sendResponse({
                    enabled: isEnabled(),
                    arrived: arrivedAtDestination,
                    isShortenerPage,
                    isKnownShortener,
                    isSecurityPage,
                    aggressiveMode: !!settings.aggressiveMode,
                    countdownDetected,
                    destinationUrl,
                    hostname: window.location.hostname,
                    scanCount
                });
                break;

            case 'DO_REDIRECT':
                if (!isEnabled()) { sendResponse({ success: false, disabled: true }); break; }
                if (message.url) {
                    window.location.href = message.url;
                } else if (destinationUrl) {
                    window.location.href = destinationUrl;
                }
                sendResponse({ success: true });
                break;

            case 'REMOVE_ADBLOCK_WALL':
                if (!isEnabled()) { sendResponse({ success: false, disabled: true, removed: 0 }); break; }
                const wallsRemoved = removeAdBlockWalls();
                sendResponse({ success: true, removed: wallsRemoved });
                break;

            case 'SCAN_PAGE':
                if (!isEnabled()) {
                    sendResponse({
                        enabled: false,
                        isShortenerPage: false,
                        isKnownShortener: false,
                        isSecurityPage: false,
                        countdownDetected: false,
                        destinationUrl: null,
                        hostname: window.location.hostname,
                        scanCount
                    });
                    break;
                }
                isShortenerPage = false;
                countdownDetected = false;
                countdownGunSeen = false;
                destinationUrl = null;
                isSecurityPage = false;
                scanCount = 0;
                try { maybeAutoSkip._withheldLogged = false; } catch (e) { /* ignore */ }

                // Re-check security
                if (checkSecurityPage() || checkSecurityPageDOM()) {
                    isSecurityPage = true;
                }

                if (!isSecurityPage || settings.aggressiveMode) {
                    detectShortenerPage();
                    passiveScan();
                }

                setTimeout(() => {
                    sendResponse({
                        enabled: isEnabled(),
                        arrived: arrivedAtDestination,
                        isShortenerPage,
                        isKnownShortener,
                        isSecurityPage,
                        countdownDetected,
                        destinationUrl,
                        hostname: window.location.hostname,
                        scanCount
                    });
                }, 1000);
                return true;

            case 'ACTIVATE_DRM_BYPASS':
                if (!isEnabled()) { sendResponse({ success: false, disabled: true }); break; }
                // User clicked the Screen Share Mode button in popup
                console.log('[KillURL] DRM bypass activation requested from popup');
                try {
                    window.dispatchEvent(new CustomEvent('killurl-force-drm-bypass'));
                } catch (e) { /* ignore */ }
                sendResponse({ success: true, needsReload: true });
                break;
        }
    });

    // Live-update when settings change (e.g. toggled from popup/options on another page)
    if (chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'sync' || !changes.settings) return;
            const next = changes.settings.newValue || {};
            const wasEnabled = isEnabled();
            settings = { ...settings, ...next };
            settingsLoaded = true;
            if (typeof settings.enabled === 'undefined') settings.enabled = true;
            if (wasEnabled !== isEnabled()) {
                handleEnabledChanged(isEnabled());
            } else {
                // State values (aggressive/DRM) may still have changed — keep the
                // injector in sync without restarting detection.
                broadcastStatesToInjector();
            }
        });
    }

    // Handshake responder: the MAIN-world injector announces
    // killurl-injector-ready on boot (and DOMContentLoaded) and needs the true
    // master state — which may still be loading here, so fetch it if needed.
    // Registered at top level so it works even while dormant (master OFF).
    window.addEventListener('killurl-injector-ready', async () => {
        if (!settingsLoaded) {
            try {
                const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
                if (s) settings = { ...settings, ...s };
                if (typeof settings.enabled === 'undefined') settings.enabled = true;
                settingsLoaded = true;
            } catch (e) { /* keep defaults; injector fails open via grace timer */ }
        }
        broadcastStatesToInjector();
    });

    // If the document_start injection raced document creation (no head/html yet),
    // retry once the DOM exists. Also re-broadcast states for late attachers.
    function retryInjectorSetup() {
        try {
            const pageWindow = typeof window.wrappedJSObject !== 'undefined' ? window.wrappedJSObject : window;
            if (!pageWindow.__killurl_injector_loaded) {
                ensureInjectorLoaded();
            }
        } catch (e) { /* ignore */ }
        // Only broadcast authoritative state (never guess ON pre-load).
        if (settingsLoaded) broadcastStatesToInjector();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', retryInjectorSetup);
    }
    window.addEventListener('load', retryInjectorSetup);

    // Initialize
    init();
})();
