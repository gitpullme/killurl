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

    // Prevent double initialization if injected via manifest and script tag.
    // Deliberately short and neutral: this is a page-visible global, and sites
    // that hunt bypass tools scan window keys for extension-looking names.
    if (window.__k7_ld) return;
    window.__k7_ld = true;

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

    // ===== PROTECTED DOMAINS (Discord, Google, etc. — NEVER disrupt) =====
    const PROTECTED_DOMAINS = [
        'discord.com', 'discordapp.com', 'discord.gg', 'discordapp.net',
        'google.com', 'google.co.in', 'googleusercontent.com', 'gstatic.com',
        'youtube.com', 'youtu.be', 'youtube-nocookie.com',
        'facebook.com', 'messenger.com', 'instagram.com', 'threads.net',
        'whatsapp.com', 'telegram.org',
        'twitter.com', 'x.com', 'reddit.com', 'linkedin.com',
        'pinterest.com', 'tiktok.com', 'snapchat.com', 'tumblr.com',
        'microsoft.com', 'live.com', 'office.com', 'outlook.com', 'bing.com',
        'msn.com', 'azure.com', 'xbox.com', 'skype.com',
        'apple.com', 'icloud.com',
        'amazon.com', 'amazon.in', 'flipkart.com', 'ebay.com',
        'netflix.com', 'primevideo.com', 'hotstar.com', 'spotify.com',
        'twitch.tv', 'kick.com',
        'chatgpt.com', 'openai.com', 'claude.ai', 'anthropic.com',
        'perplexity.ai', 'gemini.google.com', 'copilot.microsoft.com',
        'stackoverflow.com', 'stackexchange.com', 'wikipedia.org',
        'paypal.com', 'stripe.com', 'notion.so', 'slack.com', 'zoom.us',
        'figma.com', 'canva.com', 'trello.com', 'atlassian.com',
        'yahoo.com', 'duckduckgo.com', 'cloudflare.com',
        'steampowered.com', 'steamcommunity.com', 'epicgames.com',
        'roblox.com', 'vercel.com', 'netlify.com', 'npmjs.com',
        'paytm.com', 'phonepe.com',
    ];

    // ===== FINAL DESTINATIONS (Mediafire, Mega, Drive — NEVER skip or hook) =====
    const FINAL_DOMAINS = [
        'mediafire.com', 'mega.nz', 'mega.io',
        'drive.google.com', 'docs.google.com', 'drive.usercontent.google.com',
        'dropbox.com', 'dropboxusercontent.com',
        'onedrive.live.com', '1drv.ms', 'sharepoint.com',
        'gofile.io', 'pixeldrain.com', 'pixeldra.in',
        'terabox.com', 'teraboxapp.com', '1024terabox.com', 'terasharelink.com',
        'workupload.com', 'krakenfiles.com', 'sendspace.com', 'send.cm',
        'filemail.com', 'wetransfer.com', 'we.tl',
        'icedrive.net', 'pcloud.com', 'box.com', 'app.box.com',
        'github.com', 'gitlab.com', 'sourceforge.net',
        'play.google.com', 'apps.apple.com',
        't.me', 'telegram.me', 'telegram.dog',
    ];

    const PATIENT_SEED_DOMAINS = [];

    const currentHostname = window.location.hostname.replace(/^www\./, '').toLowerCase();

    function inDomainList(host, list) {
        if (!host) return false;
        for (const d of list) {
            if (host === d || host.endsWith('.' + d)) return true;
        }
        return false;
    }

    function isProtectedDomain() {
        return inDomainList(currentHostname, PROTECTED_DOMAINS);
    }

    function isFinalDomain() {
        return inDomainList(currentHostname, FINAL_DOMAINS);
    }

    function isPatientSeedDomain() {
        return false;
    }

    function isStreamingDomain() {
        return inDomainList(currentHostname, STREAMING_DOMAINS);
    }

    // Early bail-out for final destinations and protected non-streaming domains
    if (isFinalDomain()) {
        console.log('[KillURL:MAIN] Final destination reached (' + currentHostname + ') — injector dormant');
        return;
    }

    if (isProtectedDomain() && !isStreamingDomain()) {
        console.log('[KillURL:MAIN] Protected domain (' + currentHostname + ') — injector dormant');
        return;
    }

    // ===== CAPTCHA / TURNSTILE SHORTENER DOMAINS =====
    // Sites that host Cloudflare Turnstile / Captcha challenges as part of their shortener flow.
    // The injector MUST NOT install any wrappers or touch any prototypes on these sites:
    // Turnstile actively inspects prototypes (appendChild, getBoundingClientRect, setTimeout, etc.)
    // and invalidates verification ("Verification failed") if any tampering is detected.
    const CAPTCHA_SHORTENER_DOMAINS = [
        'vplink.in', 'vplinks.in'
    ];

    function isCaptchaShortenerDomain() {
        return inDomainList(currentHostname, CAPTCHA_SHORTENER_DOMAINS);
    }

    if (isCaptchaShortenerDomain()) {
        console.log('[KillURL:MAIN] Captcha/Turnstile domain (' + currentHostname + ') — injector completely dormant to preserve native Turnstile verification');
        return;
    }

    const TIMER_THRESHOLD = 1000;
    const FAST_FORWARD_DELAY = 10;
    // Debug output in the page console: sessionStorage.setItem('killurl-debug','1')
    // then reload. MAIN-world logs are page-visible (a site can hook
    // console.log and read our args), so they stay OFF by default.
    const DEBUG = (() => {
        try { return sessionStorage.getItem('killurl-debug') === '1'; } catch (e) { return false; }
    })();

    function log(...args) {
        if (DEBUG) console.log('[KillURL:MAIN]', ...args);
    }

    // Install-guards + restore handles, all closure-local (page-visible window
    // flags like __killurl_hooks_installed were trivially detectable
    // fingerprints). The restore handles let patient mode put every patched
    // API back to byte-native.
    let hooksInstalled = false;
    let netHooked = false;
    let visibilityHooked = false;
    let stealthHooked = false;
    let clockHooked = false;
    let rafHooked = false;
    let patientStoodDown = false;
    let origXHROpen = null, origXHRSend = null;
    let origGetTime = null, origValueOf = null;
    let origHiddenGet = null, origVisGet = null, origHasFocus = null;
    let visBlockers = [];
    let origAppendChild = null, origInsertBefore = null, origReplaceChild = null;
    let origGBCR = null, origGCS = null, origImgSrcDesc = null;
    const shimmedGetters = [];
    let globalDocClickHandler = null;
    const stubbedNodes = new WeakSet();
    const drmProcessedVideos = new WeakSet();

    // Patched functions must still stringify like natives — `fn.toString()`
    // checks are the cheapest anti-tamper probe these sites run.
    function nativize(fn, orig) {
        try {
            const src = Function.prototype.toString.call(orig);
            Object.defineProperty(fn, 'toString', { value: function () { return src; }, writable: true, configurable: true });
        } catch (e) { /* ignore */ }
        return fn;
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
    const _origWindowOpen = window.open ? window.open.bind(window) : null;
    const _origAnchorClick = window.HTMLAnchorElement ? window.HTMLAnchorElement.prototype.click : null;
    const _origFormSubmit = window.HTMLFormElement ? window.HTMLFormElement.prototype.submit : null;

    // Ad networks and popup/popunder signatures
    const AD_POPUP_RE = /popads|popcash|propellerads|adsterra|monetag|clickadu|yllix|hilltopads|exoclick|trafficjunky|juicyads|ero-advertising|richads|adcash|bidvertiser|revenuehits|evadav|admaven|rollerads|onclickmega|highcpmgate|highrevenuegate|al5sm|whomee|dood|streamtape|vupload|syndication|doubleclick|googleadservices|googlesyndication|adnxs|taboola|outbrain|criteo|mgid|revcontent|zeroredirect|offerwall|traffic|direct-link|smartlink|adroute|adlinkfly|linkvertise|loot-link|loot-labs|ad-maven|ad-delivery|delivery-engine|clcksite|tracking|trackclick|xmlclick|adtracker/i;

    const ERROR_DEST_RE = /(?:error\.php|\berrno=\d+|\borigin=download|\berror_code=\d+|\b(?:404|403|500)\.html?|\/404(?:\/|\.|$|\?)|bypass\.vip|discord\.(?:gg|com)|(?:invalid[_-]?token|session[_-]?expired|token[_-]?expired|link[_-]?expired|blocked|suspended|cheating))/i;

    function isNewTabTarget(t) {
        try {
            t = (t || '').trim().toLowerCase();
            return t !== '' && t !== '_self' && t !== '_parent' && t !== '_top';
        } catch (e) { return false; }
    }

    function isAdOrPopupUrl(url) {
        if (!url) return true;
        try {
            const u = String(url).trim();
            if (!u || u === 'about:blank' || u.startsWith('javascript:')) return true;
            if (BAIT_URL_RE.test(u) || AD_POPUP_RE.test(u) || ERROR_DEST_RE.test(u)) return true;
            // MediaFire check: error pages are invalid destinations
            if (/mediafire\.com/i.test(u) && !/mediafire\.com\/(?:file|download|folder|view)\/[a-zA-Z0-9_-]+|mediafire\.com\/\?[a-zA-Z0-9_-]{5,}/i.test(u)) return true;
            if (/[?&](zoneid|bannerid|campaignid|pubid|direct_link|popunder|popup|clickid|ad_id)=/i.test(u)) return true;
            if (/^data:text\/html/i.test(u) && /script|window\.open|location/i.test(u)) return true;
        } catch (e) { return true; }
        return false;
    }

    function createDummyWindow(initialUrl) {
        let dummyLocationHref = initialUrl || '';
        const dummyWindow = {
            closed: false,
            name: '',
            opener: window,
            frameElement: null,
            parent: window,
            top: window,
            length: 0,
            frames: [],
            focus() {},
            blur() {},
            close() { this.closed = true; },
            postMessage() {},
            print() {},
            stop() {},
            location: {
                assign(u) { handleDummyLocation(u); },
                replace(u) { handleDummyLocation(u); },
                reload() {},
                toString() { return dummyLocationHref; },
                get href() { return dummyLocationHref; },
                set href(u) { handleDummyLocation(u); }
            },
            document: {
                write() {},
                writeln() {},
                open() { return this; },
                close() {},
                createElement() { return document.createElement('div'); },
                getElementById() { return null; },
                querySelector() { return null; },
                querySelectorAll() { return []; },
                addEventListener() {},
                removeEventListener() {}
            }
        };
        function handleDummyLocation(destUrl) {
            dummyLocationHref = String(destUrl || '');
            if (!dummyLocationHref || dummyLocationHref === 'about:blank' || dummyLocationHref.startsWith('javascript:')) return;
            log('Blocked deferred ad popunder navigation:', dummyLocationHref.slice(0, 80));
        }
        return dummyWindow;
    }

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
        'techmint.in', 'bcsakhi.in',
        'educatestudies.com', 'studyinsurances.com',
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
                if (drmProcessedVideos.has(video)) return;
                drmProcessedVideos.add(video);

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

    // ===== URL-BASED & DOM-BASED SECURITY DETECTION =====

    function isSecurityURL() {
        const url = (window.location.href || '').toLowerCase();
        const hostname = (window.location.hostname || '').toLowerCase();
        if (url.includes('/cdn-cgi/') && (url.includes('challenge') || url.includes('challenge-platform'))) return true;
        if (hostname.includes('challenges.cloudflare.com')) return true;
        if (url.includes('/turnstile/')) return true;
        if (url.includes('cf_chl_') || url.includes('__cf_chl_')) return true;
        if (hostname.includes('recaptcha.net')) return true;
        if (hostname.includes('hcaptcha.com')) return true;
        return false;
    }

    function isSecurityNode(n) {
        if (!n || n.nodeType !== 1) return false;
        try {
            const src = (n.getAttribute ? (n.getAttribute('src') || n.src || '') : '').toLowerCase();
            const href = (n.getAttribute ? (n.getAttribute('href') || n.href || '') : '').toLowerCase();
            if (src && (src.includes('challenges.cloudflare.com') ||
                        src.includes('challenge-platform') ||
                        src.includes('turnstile') ||
                        src.includes('recaptcha') ||
                        src.includes('hcaptcha'))) {
                return true;
            }
            if (href && (href.includes('challenges.cloudflare.com') || href.includes('challenge-platform'))) {
                return true;
            }
            const cls = (typeof n.className === 'string' ? n.className : (n.className && n.className.baseVal) || '').toLowerCase();
            const id = (n.id || '').toLowerCase();
            if (cls.includes('cf-turnstile') || cls.includes('cf-challenge') || cls.includes('g-recaptcha') || cls.includes('h-captcha')) {
                return true;
            }
            if (id.includes('turnstile') || id.includes('challenge')) {
                return true;
            }
            if (n.hasAttribute && (n.hasAttribute('data-sitekey') || n.getAttribute('name') === 'cf-turnstile-response' || n.getAttribute('name') === 'g-recaptcha-response' || n.getAttribute('name') === 'h-captcha-response')) {
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function isSecurityContext() {
        try {
            if (window.__k7_sec) return true;
            if (isSecurityURL()) return true;

            // Global Cloudflare Turnstile / challenge objects
            if (typeof window.turnstile !== 'undefined' ||
                typeof window.__CF$cv$params !== 'undefined' ||
                typeof window._cf_chl_opt !== 'undefined' ||
                typeof window.grecaptcha !== 'undefined' ||
                typeof window.hcaptcha !== 'undefined') {
                return true;
            }

            // DOM query for security widgets, scripts, iframes, inputs
            if (document.querySelector && document.querySelector(
                'script[src*="challenges.cloudflare.com"], script[src*="turnstile"], script[src*="challenge-platform"], ' +
                'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], iframe[src*="turnstile"], ' +
                'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], ' +
                '.cf-turnstile, [data-sitekey], [name="cf-turnstile-response"], [name="g-recaptcha-response"], [name="h-captcha-response"], ' +
                '#challenge-stage, #challenge-form, #cf-challenge-running, #challenge-running, .cf-turnstile-wrapper, .cf-chl-widget'
            )) {
                return true;
            }

            const html = (document.documentElement ? document.documentElement.innerHTML : '') || '';
            if (html.includes('challenges.cloudflare.com') ||
                html.includes('/cdn-cgi/challenge-platform/') ||
                html.includes('/cdn-cgi/scripts/') ||
                html.includes('cf-turnstile') ||
                html.includes('cf-challenge') ||
                html.includes('turnstile/v0/api.js') ||
                html.includes('id="challenge-stage"') ||
                html.includes('id="challenge-form"') ||
                html.includes('id="challenge-running"') ||
                html.includes('id="cf-challenge-running"') ||
                html.includes('__CF$cv$params') ||
                html.includes('cNonce')) {
                return true;
            }

            const bodyText = (document.body ? document.body.textContent : '') || '';
            if (bodyText.includes('Performing security verification') && html.includes('cf-')) return true;
            if (bodyText.includes('Checking if the site connection is secure') && html.includes('cf-')) return true;
            if (bodyText.includes('DDoS protection by') && bodyText.includes('Cloudflare')) return true;
            if (bodyText.includes('Just a moment...') && (html.includes('cf-challenge') || html.includes('cloudflare'))) return true;

        } catch (e) { /* ignore */ }
        return false;
    }

    function hasSecurityMarkers() {
        return isSecurityContext();
    }

    // ===== COUNTDOWN VARIABLE NAMES =====

    const COUNTDOWN_VAR_NAMES = [
        'counter', 'countdown', 'timer', 'count', 'seconds',
        'timeLeft', 'time_left', 'remaining', 'wait', 'Wait',
        'sec', 'second', 'delay',
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
        if (hooksInstalled) return;
        hooksInstalled = true;

        window.setTimeout = nativize(function (callback, delay, ...args) {
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
        }, _origSetTimeout);

        window.setInterval = nativize(function (callback, delay, ...args) {
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
        }, _origSetInterval);

        // Track requestAnimationFrame loops (some templates drive timers via rAF)
        if (_origRAF && !rafHooked) {
            rafHooked = true;
            window.requestAnimationFrame = nativize(function (callback, ...args) {
                if (deactivated || masterState === false) return _origRAF(callback, ...args);
                const id = _origRAF(function (ts) {
                    try { trackedRAF.set(id, { callback }); } catch (e) { /* ignore */ }
                    return callback.call(window, ts);
                }, ...args);
                try { trackedRAF.set(id, { callback }); } catch (e) { /* ignore */ }
                return id;
            }, _origRAF);
            if (_origCancelRAF) {
                window.cancelAnimationFrame = nativize(function (id) {
                    try { trackedRAF.delete(id); } catch (e) { /* ignore */ }
                    return _origCancelRAF(id);
                }, _origCancelRAF);
            }
        }

        // Tab-explosion & ad-popunder neutralization
        if (_origWindowOpen) {
            window.open = nativize(function (url, target, features) {
                if (deactivated || masterState === false) {
                    return _origWindowOpen(url, target, features);
                }
                if (isProtectedDomain() && !isKnownDomain() && !activated) {
                    return _origWindowOpen(url, target, features);
                }

                const urlStr = typeof url === 'string' ? url.trim() : (url ? String(url).trim() : '');

                // 1. If it's a known ad or blank/popunder URL, BLOCK IT COMPLETELY
                if (isAdOrPopupUrl(urlStr)) {
                    log('Blocked ad/popunder window.open:', (urlStr || 'about:blank').slice(0, 100));
                    return createDummyWindow(urlStr);
                }

                // 2. On shorteners or when activated: redirect legitimate HTTP URLs to current tab
                // (prevents cascading/infinite tabs on multi-step blogs like techmint.in -> bcsakhi.in)
                if (activated || isKnownDomain()) {
                    if (/^https?:\/\//i.test(urlStr) && !isAdOrPopupUrl(urlStr) && !ERROR_DEST_RE.test(urlStr)) {
                        log('Redirecting legitimate window.open to current tab:', urlStr.slice(0, 100));
                        try {
                            window.location.href = urlStr;
                        } catch (e) { /* ignore */ }
                        return window;
                    }
                }

                // 3. Normal browsing pass-through
                return _origWindowOpen(url, target, features);
            }, _origWindowOpen);
        }

        if (_origAnchorClick) {
            HTMLAnchorElement.prototype.click = nativize(function () {
                if (!deactivated && masterState !== false) {
                    const href = (this.href || this.getAttribute('href') || '').trim();
                    if (href && isAdOrPopupUrl(href)) {
                        log('Blocked synthetic click on ad anchor:', href.slice(0, 80));
                        return;
                    }
                    if ((activated || isKnownDomain()) && isNewTabTarget(this.target)) {
                        log('Rewrote anchor target from ' + this.target + ' to _self');
                        this.target = '_self';
                    }
                }
                return _origAnchorClick.apply(this);
            }, _origAnchorClick);
        }

        if (_origFormSubmit) {
            HTMLFormElement.prototype.submit = nativize(function (...args) {
                if (!deactivated && masterState !== false && (activated || isKnownDomain())) {
                    if (this.target && isNewTabTarget(this.target)) {
                        log('Rewrote form.submit target from ' + this.target + ' to _self');
                        this.target = '_self';
                    }
                }
                return _origFormSubmit.apply(this, args);
            }, _origFormSubmit);
        }

        // Global capture listener: prevent ad popup links from opening and keep genuine navigation in current tab
        if (!globalDocClickHandler) {
            globalDocClickHandler = function (e) {
                if (deactivated || masterState === false) return;
                if (!activated && !isKnownDomain()) return;
                try {
                    const a = e.target?.closest?.('a[href]');
                    if (a) {
                        const href = (a.href || a.getAttribute('href') || '').trim();
                        if (href && isAdOrPopupUrl(href)) {
                            log('Blocked click on ad anchor in page context:', href.slice(0, 80));
                            e.preventDefault();
                            e.stopPropagation();
                            return;
                        }
                        if (isNewTabTarget(a.target) || isNewTabTarget(a.getAttribute('target'))) {
                            log('Rewrote anchor click target to _self');
                            a.target = '_self';
                            a.setAttribute('target', '_self');
                        }
                    }
                } catch (err) { /* ignore */ }
            };
            try {
                document.addEventListener('click', globalDocClickHandler, true);
            } catch (e) { /* ignore */ }
        }

        // Visibility spoof + clock shift install on ACTIVATION only (see
        // installVisibilitySpoof / installClockHooks below) — never in track
        // mode, so normal pages are completely unaffected.
        installNetCapture();

        log('Hook wrappers installed (track mode)');
    }

    function installVisibilitySpoof() {
        if (visibilityHooked) return;
        // Only ever spoof once activated (shortener context)
        if (!activated) return;
        visibilityHooked = true;
            try {
                origHiddenGet = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get ||
                    Object.getOwnPropertyDescriptor(document, 'hidden')?.get || null;
                origVisGet = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')?.get ||
                    Object.getOwnPropertyDescriptor(document, 'visibilityState')?.get || null;
            } catch (e) { /* ignore */ }
            try {
                Object.defineProperty(document, 'hidden', {
                    get() {
                        if (deactivated || masterState === false) {
                            try { return origHiddenGet ? origHiddenGet.call(document) : false; }
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
                            try { return origVisGet ? origVisGet.call(document) : 'visible'; }
                            catch (e) { return 'visible'; }
                        }
                        return 'visible';
                    },
                    configurable: true
                });
            } catch (e) { /* ignore */ }
            try {
                if (!origHasFocus) {
                    origHasFocus = document.hasFocus.bind(document);
                    document.hasFocus = nativize(function () {
                        if (deactivated || masterState === false) return origHasFocus();
                        return true;
                    }, origHasFocus);
                }
            } catch (e) { /* ignore */ }
            const blockVis = (e) => {
                if (!deactivated && masterState !== false) { e.stopImmediatePropagation(); }
            };
            window.addEventListener('visibilitychange', blockVis, true);
            window.addEventListener('blur', blockVis, true);
            visBlockers = [
                { type: 'visibilitychange', fn: blockVis },
                { type: 'blur', fn: blockVis }
            ];
    }

    // Undo the visibility spoof: delete our own-property getters so the
    // prototype getters resurface, restore hasFocus, unhook the blockers.
    function restoreVisibilitySpoof() {
        try {
            for (const { type, fn } of visBlockers) window.removeEventListener(type, fn, true);
        } catch (e) { /* ignore */ }
        visBlockers = [];
        try { delete document.hidden; } catch (e) { /* ignore */ }
        try { delete document.visibilityState; } catch (e) { /* ignore */ }
        try { delete document.hasFocus; } catch (e) { /* ignore */ }
        visibilityHooked = false;
    }

    // ===== TOKEN TIME REWRITE (malleability probe / malleable hosts) =====
    // Backdates time-like fields in the page's OWN token submissions (fetch +
    // XHR) so the server reads them as aged past its wait requirement. Armed
    // ONLY by an explicit killurl-arm-time-rewrite event (one probe attempt,
    // or a host proven malleable), self-expires via TTL, and touches nothing
    // without BOTH a token marker and a plausible timestamp in the payload.
    // Reinstalls the net wrappers if patient stand-down tore them down — the
    // probe is a deliberate, time-boxed exception to byte-native mode, and the
    // wrappers stay toString-spoofed via nativize() either way.
    const TIME_REWRITE_KEY_RE = /^(iat|issued|issued_at|timestamp|timestamps|ts|t|time|created|created_at|starttime|start_time|wait_start|begin|begin_at)$|(_at|_time|timestamp)$/i;
    const COUNTDOWN_REWRITE_KEY_RE = /^(timer|time_left|countdown|counter)$/i;
    const ELAPSED_REWRITE_KEY_RE = /^(elapsed|duration|time_spent)$/i;
    const REWRITE_TOKEN_MARKER_RE = /token|_token|csrf|authenticity|__requestverificationtoken|link_id|alias|slug|nonce/i;
    const REWRITE_ENDPOINT_RE = /links\/go|go-link|admin-ajax|verify|continue|claim|token|go\//i;

    let timeRewrite = null;

    function timeRewriteArmed() {
        // Disabled: do not tamper with network request payloads or cryptographic nonces/HMACs
        return false;
    }

    function timeUnitOf(v) {
        try {
            if (typeof v !== 'number' || !isFinite(v)) return null;
            const nowMs = Date.now();
            if (Math.abs(v - nowMs) < 10 * 365 * 24 * 3600 * 1000) return 'ms';
            if (Math.abs(v - nowMs / 1000) < 10 * 365 * 24 * 3600) return 's';
            return null;
        } catch (e) { return null; }
    }

    function scaleToUnit(v, targetMs) {
        const u = timeUnitOf(v);
        if (u === 'ms') return targetMs;
        if (u === 's') return Math.floor(targetMs / 1000);
        return v;
    }

    function rewriteTimesInObject(o, targetMs, depth) {
        let changed = false;
        try {
            if (depth == null) depth = 0;
            if (!o || typeof o !== 'object' || depth > 3) return false;
            const keys = Array.isArray(o) ? o.map((_, i) => i) : Object.keys(o);
            for (const k of keys) {
                let v;
                try { v = o[k]; } catch (e) { continue; }
                if (typeof k === 'string' && TIME_REWRITE_KEY_RE.test(k) && typeof v === 'number' && timeUnitOf(v)) {
                    try { o[k] = scaleToUnit(v, targetMs); changed = true; } catch (e) { /* ignore */ }
                } else if (typeof k === 'string' && COUNTDOWN_REWRITE_KEY_RE.test(k)) {
                    try { o[k] = 0; changed = true; } catch (e) { /* ignore */ }
                } else if (typeof k === 'string' && ELAPSED_REWRITE_KEY_RE.test(k)) {
                    try { o[k] = 60; changed = true; } catch (e) { /* ignore */ }
                } else if (v && typeof v === 'object') {
                    try { if (rewriteTimesInObject(v, targetMs, depth + 1)) changed = true; } catch (e) { /* ignore */ }
                }
            }
        } catch (e) { /* ignore */ }
        return changed;
    }

    function rewriteFormData(formData, targetMs) {
        let changed = false;
        try {
            if (!formData || typeof formData.entries !== 'function') return false;
            for (const [key, val] of [...formData.entries()]) {
                if (typeof key === 'string' && TIME_REWRITE_KEY_RE.test(key)) {
                    if (typeof val === 'string' && /^-?\d+$/.test(val)) {
                        const n = Number(val);
                        if (timeUnitOf(n)) {
                            formData.set(key, String(scaleToUnit(n, targetMs)));
                            changed = true;
                        }
                    }
                } else if (typeof key === 'string' && COUNTDOWN_REWRITE_KEY_RE.test(key)) {
                    formData.set(key, '0');
                    changed = true;
                } else if (typeof key === 'string' && ELAPSED_REWRITE_KEY_RE.test(key)) {
                    formData.set(key, '60');
                    changed = true;
                }
            }
        } catch (e) { /* ignore */ }
        return changed;
    }

    function rewriteURLSearchParams(params, targetMs) {
        let changed = false;
        try {
            if (!params || typeof params.entries !== 'function') return false;
            for (const [key, val] of [...params.entries()]) {
                if (typeof key === 'string' && TIME_REWRITE_KEY_RE.test(key)) {
                    if (typeof val === 'string' && /^-?\d+$/.test(val)) {
                        const n = Number(val);
                        if (timeUnitOf(n)) {
                            params.set(key, String(scaleToUnit(n, targetMs)));
                            changed = true;
                        }
                    }
                } else if (typeof key === 'string' && COUNTDOWN_REWRITE_KEY_RE.test(key)) {
                    params.set(key, '0');
                    changed = true;
                } else if (typeof key === 'string' && ELAPSED_REWRITE_KEY_RE.test(key)) {
                    params.set(key, '60');
                    changed = true;
                }
            }
        } catch (e) { /* ignore */ }
        return changed;
    }

    function objectHasTokenMarker(o, depth) {
        try {
            if (depth == null) depth = 0;
            if (!o || typeof o !== 'object' || depth > 3) return false;
            for (const k of Object.keys(o)) {
                try {
                    if (REWRITE_TOKEN_MARKER_RE.test(k)) return true;
                    const v = o[k];
                    if (v && typeof v === 'object' && objectHasTokenMarker(v, depth + 1)) return true;
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function rewriteTimesInText(text, targetMs) {
        // Returns { text, changed }. JSON bodies first, then form-urlencoded.
        // Bodies without token markers pass through byte-identical.
        try {
            const t = String(text == null ? '' : text);
            if (!t || t.length > 200000) return { text, changed: false };
            const trimmed = t.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    const o = JSON.parse(trimmed);
                    if (o && typeof o === 'object' && objectHasTokenMarker(o) && rewriteTimesInObject(o, targetMs)) {
                        return { text: JSON.stringify(o), changed: true };
                    }
                    return { text, changed: false };
                } catch (e) { /* fall through to form-encoded */ }
            }
            if (t.indexOf('=') >= 0 && t.indexOf('\n') < 0) {
                const parts = t.split('&');
                if (parts.length > 64) return { text, changed: false };
                let tokenish = false;
                const kvs = [];
                for (const p of parts) {
                    const eq = p.indexOf('=');
                    if (eq < 0) { kvs.push({ raw: p }); continue; }
                    let k = p.slice(0, eq);
                    const v = p.slice(eq + 1);
                    try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e) { /* keep raw key */ }
                    kvs.push({ k, v, raw: p });
                    try { if (REWRITE_TOKEN_MARKER_RE.test(k)) tokenish = true; } catch (e) { /* ignore */ }
                }
                if (!tokenish) return { text, changed: false };
                let changed = false;
                const out = kvs.map(({ k, v, raw }) => {
                    if (v == null) return raw;
                    let dv = v;
                    try { dv = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
                    if (TIME_REWRITE_KEY_RE.test(k) && /^-?\d+$/.test(dv)) {
                        const n = Number(dv);
                        if (timeUnitOf(n)) {
                            changed = true;
                            return encodeURIComponent(k) + '=' + encodeURIComponent(String(scaleToUnit(n, targetMs)));
                        }
                    }
                    return raw;
                });
                if (changed) return { text: out.join('&'), changed: true };
            }
            return { text, changed: false };
        } catch (e) { return { text, changed: false }; }
    }

    function rewriteTimesInUrl(urlStr, targetMs, requireTokenPath) {
        // Returns rewritten URL string, or null if nothing changed. Same-host
        // URLs only; token-endpoint paths (or token-ish query keys) required
        // unless the caller already validated the body.
        try {
            const u = new URL(urlStr, window.location.href);
            if (u.hostname !== window.location.hostname) return null;
            if (requireTokenPath) {
                const hay = u.pathname + u.search;
                if (!REWRITE_ENDPOINT_RE.test(hay) && !/token|alias|slug|link_id|__requestverificationtoken/i.test(hay)) return null;
            }
            let changed = false;
            for (const k of [...u.searchParams.keys()]) {
                if (!TIME_REWRITE_KEY_RE.test(k)) continue;
                const v = u.searchParams.get(k);
                if (!/^-?\d+$/.test(v || '')) continue;
                const n = Number(v);
                if (!timeUnitOf(n)) continue;
                u.searchParams.set(k, String(scaleToUnit(n, targetMs)));
                changed = true;
            }
            return changed ? u.href : null;
        } catch (e) { return null; }
    }

    window.addEventListener('killurl-arm-time-rewrite', (e) => {
        try {
            const d = (e && e.detail) || {};
            const targetMs = Number(d.targetMs);
            if (!(targetMs > 0)) return;
            if (masterState === false) return;
            const ttlMs = Math.min(Math.max(Number(d.ttlMs) || 60000, 5000), 180000);
            timeRewrite = { targetMs, until: Date.now() + ttlMs };
            try { installNetCapture(); } catch (err) { /* ignore */ }
            log('Time-rewrite armed (target backdated, TTL ' + Math.round(ttlMs / 1000) + 's)');
        } catch (err) { /* ignore */ }
    });

    // Decide + compute a fetch rewrite. Returns { url, body } or null.
    // Query params need a tokenish context; bodies must THEMSELVES contain
    // token markers (enforced inside rewriteTimesInText) so analytics and
    // telemetry posts pass through byte-identical.
    function rewriteFetchArgs(urlStr, bodyTextOrNull, targetMs) {
        try {
            let url = urlStr, body = bodyTextOrNull, changed = false;
            const nu = rewriteTimesInUrl(urlStr, targetMs, true);
            if (nu) { url = nu; changed = true; }
            if (bodyTextOrNull != null) {
                const r = rewriteTimesInText(bodyTextOrNull, targetMs);
                if (r.changed) { body = r.text; changed = true; }
            }
            return changed ? { url, body } : null;
        } catch (e) { return null; }
    }

    function readRequestBody(req) {
        try {
            const ct = (req.headers && req.headers.get('content-type')) || '';
            if (!/json|form|text/i.test(ct)) return Promise.resolve(null);
            return req.clone().text().catch(() => null);
        } catch (e) { return Promise.resolve(null); }
    }

    function rebuildRequest(oldReq, newUrl, newBodyOrNull) {
        try {
            const init = {};
            try { init.method = oldReq.method; } catch (e) { /* ignore */ }
            try { init.headers = new Headers(oldReq.headers); } catch (e) { /* ignore */ }
            try { init.mode = oldReq.mode; } catch (e) { /* ignore */ }
            try { init.credentials = oldReq.credentials; } catch (e) { /* ignore */ }
            try { init.cache = oldReq.cache; } catch (e) { /* ignore */ }
            try { init.redirect = oldReq.redirect; } catch (e) { /* ignore */ }
            try { init.referrer = oldReq.referrer; } catch (e) { /* ignore */ }
            try { init.referrerPolicy = oldReq.referrerPolicy; } catch (e) { /* ignore */ }
            try { init.keepalive = oldReq.keepalive; } catch (e) { /* ignore */ }
            try { if (oldReq.signal) init.signal = oldReq.signal; } catch (e) { /* ignore */ }
            const method = ((init.method || 'GET') + '').toUpperCase();
            if (newBodyOrNull != null && method !== 'GET' && method !== 'HEAD') {
                init.body = newBodyOrNull;
                try { if (oldReq.duplex) init.duplex = oldReq.duplex; } catch (e) { /* ignore */ }
            }
            // NOTE: integrity deliberately dropped when the body changed.
            return new Request(newUrl, init);
        } catch (e) { return oldReq; }
    }

    function isSafeDestinationCandidate(url) {
        if (!url || typeof url !== 'string') return false;
        if (ERROR_DEST_RE.test(url)) return false;
        if (BAIT_URL_RE.test(url)) return false;
        if (/google|doubleclick|analytics|facebook|taboola/i.test(url)) return false;
        // MediaFire check: if host is mediafire.com, must be an authentic file/download/folder/view link
        if (/mediafire\.com/i.test(url)) {
            if (!/mediafire\.com\/(?:file|download|folder|view)\/[a-zA-Z0-9_-]+|mediafire\.com\/\?[a-zA-Z0-9_-]{5,}/i.test(url)) {
                return false;
            }
        }
        if (/mega\.(?:nz|io)/i.test(url)) {
            if (!/mega\.(?:nz|io)\/(?:file|folder)\/[a-zA-Z0-9_-]+|#[!a-zA-Z0-9_-]{8,}/i.test(url)) {
                return false;
            }
        }
        if (/drive\.google\.com/i.test(url)) {
            if (!/drive\.google\.com\/(?:file\/d\/|drive\/folders\/|open\?id=|uc\?id=)[a-zA-Z0-9_-]+/i.test(url)) {
                return false;
            }
        }
        return true;
    }

    function sniffDestinationUrl(data) {
        if (!data) return null;
        try {
            if (typeof data === 'object') {
                const queue = [data];
                let count = 0;
                while (queue.length && count < 30) {
                    count++;
                    const curr = queue.shift();
                    if (!curr || typeof curr !== 'object') continue;
                    for (const k of Object.keys(curr)) {
                        const v = curr[k];
                        if (typeof v === 'string' && /^https?:\/\/[^\s"']{8,}/i.test(v)) {
                            if ((/destination|redirect|target|final|next|url|link|data|href|result|download/i.test(k) || !BAIT_URL_RE.test(v)) && isSafeDestinationCandidate(v)) {
                                return v;
                            }
                        } else if (v && typeof v === 'object') {
                            queue.push(v);
                        }
                    }
                }
                return null;
            }
            const text = String(data);
            if (text.length > 250000) return null;
            const m = text.match(/"(?:destination|redirect|target|final|next|url|link|data|href|result|download_url)"\s*:\s*"(https?:\/\/[^"\\]+)"/i) ||
                      text.match(/"(?:location|link_url|target_url)"\s*:\s*"(https?:\/\/[^"\\]+)"/i);
            if (m && m[1]) {
                const cand = m[1].replace(/\\/g, '');
                if (isSafeDestinationCandidate(cand)) return cand;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function installNetCapture() {
        if (netHooked) return;
        netHooked = true;
        if (_origFetch) {
            window.fetch = nativize(function (...args) {
                // Stealth: bait requests succeed locally — detector sees "ads load fine".
                try {
                    const first = args[0];
                    const urlStr = typeof first === 'string' ? first : (first && first.url) || '';
                    if (urlStr && stealthActive() && BAIT_URL_RE.test(urlStr)) {
                        log('Stealth: faked bait fetch', String(urlStr).slice(0, 80));
                        return Promise.resolve(new Response('{}', {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        }));
                    }
                } catch (e) { /* fall through to real fetch */ }
                const proceed = (finalArgs) => _origFetch(...finalArgs).then((response) => {
                    if (!deactivated && masterState !== false) {
                        try {
                            const clone = response.clone();
                            clone.text().then((text) => {
                                const found = sniffDestinationUrl(text);
                                if (found) {
                                    destinationCaptured = true;
                                    log('Destination captured via fetch:', found.slice(0, 100));
                                    try {
                                        window.dispatchEvent(new CustomEvent('killurl-url-found', {
                                            detail: { url: found, source: 'fetch' }
                                        }));
                                    } catch (e) { /* ignore */ }
                                }
                            }).catch(() => { });
                        } catch (e) { /* ignore */ }
                    }
                    return response;
                });
                // Token time rewrite (probe / malleable hosts only, TTL'd).
                // String URLs + init bodies rewrite synchronously; Request
                // objects with bodies need one async read first.
                // NOTE: `proceed` is declared above (not below) on purpose —
                // const-declared helpers used inside this same synchronous
                // block would otherwise hit the temporal dead zone and throw.
                try {
                    if (timeRewriteArmed()) {
                        const first = args[0];
                        if (typeof first === 'string') {
                            const init = args[1] || {};
                            if (init && init.body) {
                                if (typeof init.body === 'string') {
                                    const rw = rewriteFetchArgs(first, init.body, timeRewrite.targetMs);
                                    if (rw && (rw.url !== first || rw.body !== init.body)) {
                                        log('Time-rewrite applied to fetch (string)', String(first).slice(0, 90));
                                        const nextInit = Object.assign({}, init);
                                        delete nextInit.integrity; // body changed: old hash would fail
                                        if (rw.body !== init.body) nextInit.body = rw.body;
                                        return proceed([rw.url, nextInit]);
                                    }
                                } else if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
                                    if (rewriteFormData(init.body, timeRewrite.targetMs)) {
                                        log('Time-rewrite applied to fetch (FormData)', String(first).slice(0, 90));
                                    }
                                } else if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) {
                                    if (rewriteURLSearchParams(init.body, timeRewrite.targetMs)) {
                                        log('Time-rewrite applied to fetch (URLSearchParams)', String(first).slice(0, 90));
                                    }
                                }
                            } else {
                                const nu = rewriteTimesInUrl(first, timeRewrite.targetMs, true);
                                if (nu && nu !== first) {
                                    log('Time-rewrite applied to fetch URL', String(first).slice(0, 90));
                                    return proceed([nu, init]);
                                }
                            }
                        } else if (first && typeof first.url === 'string') {
                            // Request object: async body read, then proceed.
                            return readRequestBody(first).then((bodyText) => {
                                try {
                                    if (timeRewriteArmed()) {
                                        const rw = rewriteFetchArgs(first.url, bodyText, timeRewrite.targetMs);
                                        if (rw && (rw.url !== first.url || rw.body !== bodyText)) {
                                            log('Time-rewrite applied to fetch(Request)', String(first.url).slice(0, 90));
                                            return proceed([rebuildRequest(first, rw.url, rw.body)]);
                                        }
                                    }
                                } catch (e) { /* fall through original */ }
                                return proceed(args);
                            });
                        }
                    }
                } catch (e) { /* fall through original */ }
                return proceed(args);
            }, _origFetch);
            // Also watch XHR token endpoints. The per-request URL lives in a
            // WeakMap — an own enumerable __killurl_url property on the page's
            // own XHR objects was a dead giveaway for any probe to find.
            try {
                origXHROpen = XMLHttpRequest.prototype.open;
                origXHRSend = XMLHttpRequest.prototype.send;
                const xhrUrlMap = new WeakMap();
                XMLHttpRequest.prototype.open = nativize(function (method, url, ...rest) {
                    xhrUrlMap.set(this, url);
                    return origXHROpen.call(this, method, url, ...rest);
                }, origXHROpen);
                XMLHttpRequest.prototype.send = nativize(function (...args) {
                    // Stealth: bait XHR "succeeds" locally with empty JSON.
                    try {
                        const xhrUrl = xhrUrlMap.get(this);
                        if (stealthActive() && typeof xhrUrl === 'string' && BAIT_URL_RE.test(xhrUrl)) {
                            const self = this;
                            log('Stealth: faked bait XHR', String(xhrUrl).slice(0, 80));
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
                    // Token time rewrite (probe / malleable hosts only, TTL'd).
                    // String, FormData, and URLSearchParams bodies rewritten.
                    try {
                        if (timeRewriteArmed() && args[0]) {
                            const xhrUrl = xhrUrlMap.get(this) || '';
                            if (typeof args[0] === 'string') {
                                const rw = rewriteFetchArgs(String(xhrUrl), args[0], timeRewrite.targetMs);
                                if (rw && rw.body !== args[0]) {
                                    log('Time-rewrite applied to XHR (string)', String(xhrUrl).slice(0, 90));
                                    args = [rw.body];
                                }
                            } else if (typeof FormData !== 'undefined' && args[0] instanceof FormData) {
                                if (rewriteFormData(args[0], timeRewrite.targetMs)) {
                                    log('Time-rewrite applied to XHR (FormData)', String(xhrUrl).slice(0, 90));
                                }
                            } else if (typeof URLSearchParams !== 'undefined' && args[0] instanceof URLSearchParams) {
                                if (rewriteURLSearchParams(args[0], timeRewrite.targetMs)) {
                                    log('Time-rewrite applied to XHR (URLSearchParams)', String(xhrUrl).slice(0, 90));
                                }
                            }
                        }
                    } catch (e) { /* fall through original */ }
                    this.addEventListener('load', function () {
                        if (deactivated || masterState === false) return;
                        try {
                            const found = sniffDestinationUrl(this.responseText || this.response);
                            if (found) {
                                destinationCaptured = true;
                                log('Destination captured via XHR:', found.slice(0, 100));
                                window.dispatchEvent(new CustomEvent('killurl-url-found', {
                                    detail: { url: found, source: 'xhr' }
                                }));
                            }
                        } catch (e) { /* ignore */ }
                    });
                    return origXHRSend.call(this, ...args);
                }, origXHRSend);
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
            if (!node || node.nodeType !== 1 || stubbedNodes.has(node)) return node;
            const tag = (node.tagName || '').toUpperCase();
            const srcAttr = tag === 'LINK' ? node.getAttribute('href') : node.getAttribute('src');
            if (!srcAttr || !BAIT_URL_RE.test(srcAttr)) return node;
            stubbedNodes.add(node);
            try { node.setAttribute('data-killurl-orig-src', srcAttr); } catch (e) { /* ignore */ }
            if (tag === 'SCRIPT') node.setAttribute('src', baitScriptStub(srcAttr));
            else if (tag === 'IMG') node.setAttribute('src', BAIT_IMG_STUB);
            else if (tag === 'IFRAME') node.setAttribute('src', 'about:blank');
            else if (tag === 'LINK') node.setAttribute('href', 'data:text/css,');
            log('Stealth: stubbed bait resource', tag, String(srcAttr).slice(0, 80));
        } catch (e) { /* ignore */ }
        return node;
    }

    function shimGetter(proto, name, fake) {
        try {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (!desc || typeof desc.get !== 'function') return;
            const origGet = desc.get;
            shimmedGetters.push({ proto, name, desc });
            Object.defineProperty(proto, name, {
                get: nativize(function () {
                    let real = null;
                    try { real = origGet.call(this); } catch (e) { /* ignore */ }
                    try {
                        if (stealthActive() && isBaitElement(this)) return fake(this, real);
                    } catch (e) { /* ignore */ }
                    return real;
                }, origGet),
                set: desc.set,
                enumerable: desc.enumerable,
                configurable: true
            });
        } catch (e) { /* ignore */ }
    }

    // Restore every stealth patch to the original native (patient stand-down
    // and clean re-arming both use this).
    function restoreStealthHooks() {
        try { if (origAppendChild) Node.prototype.appendChild = origAppendChild; } catch (e) { /* ignore */ }
        try { if (origInsertBefore) Node.prototype.insertBefore = origInsertBefore; } catch (e) { /* ignore */ }
        try { if (origReplaceChild) Node.prototype.replaceChild = origReplaceChild; } catch (e) { /* ignore */ }
        try { if (origGBCR) Element.prototype.getBoundingClientRect = origGBCR; } catch (e) { /* ignore */ }
        try { if (origGCS) window.getComputedStyle = origGCS; } catch (e) { /* ignore */ }
        for (const { proto, name, desc } of shimmedGetters) {
            try { Object.defineProperty(proto, name, desc); } catch (e) { /* ignore */ }
        }
        shimmedGetters.length = 0;
        try {
            if (origImgSrcDesc) Object.defineProperty(window.HTMLImageElement.prototype, 'src', origImgSrcDesc);
        } catch (e) { /* ignore */ }
        origAppendChild = origInsertBefore = origReplaceChild = origGBCR = origGCS = origImgSrcDesc = null;
        stealthHooked = false;
    }

    function installStealthHooks() {
        if (stealthHooked) return;
        stealthHooked = true;

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
            origGBCR = Element.prototype.getBoundingClientRect;
            const _origRect = origGBCR;
            Element.prototype.getBoundingClientRect = nativize(function (...args) {
                let real = null;
                try { real = _origRect.apply(this, args); } catch (e) { /* ignore */ }
                try {
                    if (stealthActive() && isBaitElement(this) && (!real || (real.width === 0 && real.height === 0))) {
                        return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 250, width: 300, height: 250, toJSON() { return this; } };
                    }
                } catch (e) { /* ignore */ }
                return real;
            }, _origRect);
        } catch (e) { /* ignore */ }

        try {
            origGCS = window.getComputedStyle;
            const _origGCS = origGCS.bind(window);
            window.getComputedStyle = nativize(function (el, pseudo) {
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
            }, origGCS);
        } catch (e) { /* ignore */ }

        // 2. Bait resource insertion: stub before it hits the network.
        try {
            origAppendChild = Node.prototype.appendChild;
            Node.prototype.appendChild = nativize(function (n) {
                if (isSecurityNode(n)) {
                    standDownForSecurity('security-node-appended');
                    return origAppendChild.call(this, n);
                }
                return origAppendChild.call(this, baitRewrite(n));
            }, origAppendChild);
            origInsertBefore = Node.prototype.insertBefore;
            Node.prototype.insertBefore = nativize(function (n, ref) {
                if (isSecurityNode(n)) {
                    standDownForSecurity('security-node-inserted');
                    return origInsertBefore.call(this, n, ref);
                }
                return origInsertBefore.call(this, baitRewrite(n), ref);
            }, origInsertBefore);
            origReplaceChild = Node.prototype.replaceChild;
            Node.prototype.replaceChild = nativize(function (n, old) {
                if (isSecurityNode(n)) {
                    standDownForSecurity('security-node-replaced');
                    return origReplaceChild.call(this, n, old);
                }
                return origReplaceChild.call(this, baitRewrite(n), old);
            }, origReplaceChild);
        } catch (e) { /* ignore */ }

        // 3. `new Image().src = <bait>` without DOM insertion.
        try {
            origImgSrcDesc = Object.getOwnPropertyDescriptor(window.HTMLImageElement.prototype, 'src');
            if (origImgSrcDesc && typeof origImgSrcDesc.set === 'function') {
                const _origImgSet = origImgSrcDesc.set;
                Object.defineProperty(window.HTMLImageElement.prototype, 'src', {
                    set: nativize(function (v) {
                        try {
                            if (stealthActive() && typeof v === 'string' && BAIT_URL_RE.test(v)) {
                                log('Stealth: stubbed bait Image');
                                v = BAIT_IMG_STUB;
                            }
                        } catch (e) { /* ignore */ }
                        _origImgSet.call(this, v);
                    }, _origImgSet),
                    get: origImgSrcDesc.get,
                    enumerable: origImgSrcDesc.enumerable,
                    configurable: true
                });
            }
        } catch (e) { /* ignore */ }

        log('Stealth hooks installed');
    }

    // Clock-shift hooks: installed once at load, dormant pass-through until a    // force-skip arms timeShiftMs. Defeats wall-clock countdowns
    // (`remaining = endTime - Date.now()`) which repeated tick-firing can't move.
    function installClockHooks() {
        if (clockHooked) return;
        clockHooked = true;
        // Keep authentic wall clock so server token validation, HMACs, and crypto signatures never skew or fail
    }

    // Flip from TRACK mode to FAST mode. Cheap + idempotent.
    function activateTimerHooks() {
        if (activated || deactivated || isSecurityContext() || isCaptchaShortenerDomain()) return;
        activated = true;
        installHookWrappers();
        installVisibilitySpoof();
        installClockHooks();
        installNetCapture();
        installStealthHooks();
        log('Timer hooks activated (fast mode)');
    }

    function standDownForSecurity(reason) {
        window.__k7_sec = true;
        deactivated = true;
        activated = false;

        if (fastActivateTimer) {
            _origClearTimeout(fastActivateTimer);
            fastActivateTimer = null;
        }

        // 1. Restore timer wrappers to original native functions
        try { window.setTimeout = _origSetTimeout; } catch (e) { /* ignore */ }
        try { window.setInterval = _origSetInterval; } catch (e) { /* ignore */ }
        if (_origRAF) {
            try { window.requestAnimationFrame = _origRAF; } catch (e) { /* ignore */ }
            rafHooked = false;
        }
        if (_origCancelRAF) {
            try { window.cancelAnimationFrame = _origCancelRAF; } catch (e) { /* ignore */ }
        }
        hooksInstalled = false;

        // 2. Restore window.open, click, submit
        if (_origWindowOpen) {
            try { window.open = _origWindowOpen; } catch (e) { /* ignore */ }
        }
        if (_origAnchorClick && window.HTMLAnchorElement) {
            try { window.HTMLAnchorElement.prototype.click = _origAnchorClick; } catch (e) { /* ignore */ }
        }
        if (_origFormSubmit && window.HTMLFormElement) {
            try { window.HTMLFormElement.prototype.submit = _origFormSubmit; } catch (e) { /* ignore */ }
        }

        // 3. Remove document click interceptor
        if (globalDocClickHandler) {
            try { document.removeEventListener('click', globalDocClickHandler, true); } catch (e) { /* ignore */ }
            globalDocClickHandler = null;
        }

        // 4. Restore stealth hooks (Node.prototype.appendChild, Element.prototype.getBoundingClientRect, getComputedStyle, etc.)
        restoreStealthHooks();

        // 5. Restore visibility spoof (document.hidden, document.visibilityState, document.hasFocus)
        restoreVisibilitySpoof();

        // 6. Restore network capture (fetch, XHR)
        if (_origFetch) {
            try { window.fetch = _origFetch; } catch (e) { /* ignore */ }
        }
        if (origXHROpen && window.XMLHttpRequest) {
            try { XMLHttpRequest.prototype.open = origXHROpen; } catch (e) { /* ignore */ }
        }
        if (origXHRSend && window.XMLHttpRequest) {
            try { XMLHttpRequest.prototype.send = origXHRSend; } catch (e) { /* ignore */ }
        }
        origXHROpen = null;
        origXHRSend = null;
        netHooked = false;

        // 7. Stop variable killing + unfreeze all properties
        releaseVarKilling();

        // 8. Clear tracked structures
        trackedRAF.clear();
        trackedIntervals.clear();
        trackedTimeouts.clear();
        timeShiftMs = 0;
        destinationCaptured = false;

        log(`Security page detected (${reason}) — all hooks 100% UNINSTALLED and native`);

        // 9. Notify content script
        try {
            window.dispatchEvent(new CustomEvent('killurl-security-page', {
                detail: { reason: reason || 'security-detected' }
            }));
        } catch (e) { /* ignore */ }

        // If aggressive mode is on, start watching for CF challenge completion
        if (aggressiveMode && !isActualChallengeFrame()) {
            startReactivationWatcher();
        }
    }

    function deactivateTimerHooks(reason) {
        standDownForSecurity(reason || 'deactivate-called');
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
        if (deactivated || isSecurityContext()) {
            standDownForSecurity('activate-event-blocked');
            return;
        }
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

    // Server-side timer bypass mode: do NOT stand down or revert to native 1000ms crawl speed.
    // Accelerate client timers and arm network request time-spoofing immediately.
    let injectorPatient = false;
    window.addEventListener('killurl-patient', () => {
        log('Server timer bypass engine: accelerating client timers');
        if (masterState === false) return;
        if (isSecurityContext()) {
            standDownForSecurity('patient-event-blocked');
            return;
        }
        try { installNetCapture(); } catch (e) { /* ignore */ }
        activateTimerHooks();
        startVarKilling();
    });

    // Proven-malleable host: aged tokens pass, so elapsed time is irrelevant
    // and the drive is safe again. Reinstall hooks and resume normal activation.
    window.addEventListener('killurl-malleable', () => {
        try {
            injectorPatient = false;
            patientStoodDown = false;
            deactivated = false;
            activated = false;
            try { installHookWrappers(); } catch (e) { /* ignore */ }
            try { installClockHooks(); } catch (e) { /* ignore */ }
            try { installStealthHooks(); } catch (e) { /* ignore */ }
            try { installNetCapture(); } catch (e) { /* ignore */ }
            log('Malleable host — patient mode lifted, hooks re-armed');
            maybeFastActivate();
        } catch (e) { /* ignore */ }
    });

    // ===== PATIENT STAND-DOWN (DISABLED FOR FAST SKIP) =====
    function standDownForPatient() {
        // Disabled: Never restore slow 1000ms timers or stand down!
        log('standDownForPatient ignored — fast skip engine active');
    }
    window.addEventListener('killurl-set-enabled', (e) => {
        masterState = e.detail?.enabled !== false;
        log('Extension enabled set to:', masterState);

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
        if (isSecurityContext() || isActualChallengeFrame()) {
            standDownForSecurity('fast-activate-blocked');
            return;
        }
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
        if (isSecurityContext() && !aggressiveMode) {
            log('Security page — refusing force-skip (aggressive mode off)');
            standDownForSecurity('force-skip-blocked');
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

        log('Force skip: driving page timers to completion...');

        // 1. Zero countdown variables FIRST (before firing callbacks)
        killCountdownVars();

        // 2. Keep wall-clock accurate for cryptographic signatures and server tokens
        timeShiftMs = 0;

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
                log(`Driving ${intervalCbs.length} timer(s) + ${trackedTimeouts.size} timeout(s) to completion…`);
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
                            try { callback.call(window, _origPerfNow ? _origPerfNow() : Date.now()); } catch (e) { /* ignore */ }
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
            log('Timer drive finished — gate should be open, clicking now…');
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
    function setupSecurityObserver() {
        if (typeof MutationObserver === 'undefined') return;
        try {
            const obs = new MutationObserver((mutations) => {
                if (window.__k7_sec) {
                    obs.disconnect();
                    return;
                }
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === 1) {
                            if (isSecurityNode(node) || (node.querySelector && node.querySelector(
                                'script[src*="cloudflare"], script[src*="turnstile"], script[src*="challenge-platform"], ' +
                                'iframe[src*="cloudflare"], iframe[src*="turnstile"], .cf-turnstile, [name="cf-turnstile-response"]'
                            ))) {
                                standDownForSecurity('mutation-observer-detected');
                                obs.disconnect();
                                return;
                            }
                        }
                    }
                }
            });
            obs.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }
    }

    if (!isProtectedDomain() && !isFinalDomain() && !isCaptchaShortenerDomain()) {
        // Unmissable boot heartbeat (always-on, not debug-gated).
        try {
            console.log('[KillURL] injector v1.4.0 ready @ ' + window.location.hostname);
        } catch (e) { /* ignore */ }
        log('engine v7.4 ready (track+drive+stealth+patient-standdown+timerewrite) — waiting for master state…');

        setupSecurityObserver();

        if (isSecurityContext()) {
            standDownForSecurity('boot-security-detected');
        } else {
            installHookWrappers();
            installClockHooks();
            // Stealth hooks (DOM node rewriting & geometry spoofing) are NOT installed
            // in track mode at boot. They install strictly on activation (activateTimerHooks)
            // to prevent tampering with anti-bot/Turnstile integrity probes on initial load.
        }
    }

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

    // Listen for security page notification from content script
    window.addEventListener('killurl-security-page', (e) => {
        standDownForSecurity(e.detail?.reason || 'content-script-event');
    });

    // ===== AUTO-ACTIVATION ON KNOWN DOMAINS =====
    // Deferred: at document_start the master state is still UNKNOWN (null), so
    // fast-activation waits for the content script's reply. An OFF reply cancels
    // the grace timer and we stay dormant; an ON reply (or the timeout with no
    // OFF) engages fast mode. Track-mode inventory keeps recording meanwhile.

    if (isSecurityContext()) {
        log('Security context detected — staying dormant');
        standDownForSecurity('boot-security-context');
    } else if (isKnownDomain()) {
        log(`Known shortener domain: ${window.location.hostname} — waiting for master state...`);
        fastActivateTimer = _origSetTimeout(() => {
            fastActivateTimer = null;
            if (arrivalCalm) {
                log('Staying dormant (arrival page)');
                return;
            }
            if (masterState === false || deactivated || isSecurityContext()) {
                log('Staying dormant (extension turned OFF, deactivated, or security detected)');
                if (isSecurityContext()) standDownForSecurity('timer-security-context');
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

    // Periodic security checks for late-loading Turnstile/Cloudflare challenges
    [50, 150, 300, 600, 1200, 2500].forEach(delay => {
        _origSetTimeout(() => {
            if (!window.__k7_sec && isSecurityContext()) {
                standDownForSecurity('poll-' + delay);
            }
        }, delay);
    });

    // ===== POST-DOM SECURITY CHECK =====
    window.addEventListener('DOMContentLoaded', () => {
        announceInjectorReady();
        if (isSecurityContext()) {
            standDownForSecurity('dom-ready');
        }
    });

    window.addEventListener('load', () => {
        if (isSecurityContext()) {
            standDownForSecurity('load');
        }
    });

})();
