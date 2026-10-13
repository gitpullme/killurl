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

    // Completely dormant in Cloudflare Turnstile, reCAPTCHA, and hCaptcha challenge iframes
    const frameHost = (window.location.hostname || '').toLowerCase();
    if (
        frameHost.includes('challenges.cloudflare.com') ||
        frameHost.includes('challenge-platform') ||
        frameHost.includes('recaptcha.net') ||
        frameHost.includes('hcaptcha.com')
    ) {
        return;
    }

    // Synchronously pre-seed shortcut cookies without destroying blog session tracking:
    try {
        if (frameHost.includes('bcsakhi') || frameHost.includes('educatestudies')) {
            if (!document.cookie.includes('adcadg=')) {
                document.cookie = 'adcadg=insurance,online_colleges,study_abroad,finance,loan; path=/; max-age=3600';
            }
        }
        if (frameHost.includes('rupeeriser') || frameHost.includes('studyeducates')) {
            if (!document.cookie.includes('_uocat=')) {
                document.cookie = '_uocat=value; path=/; max-age=86400';
            }
        }
    } catch (e) { /* ignore */ }

    // ===== STATE =====
    let isShortenerPage = false;
    let isKnownShortener = false; // Confirmed via background domain list
    let isSecurityPage = false; // Cloudflare/captcha detected
    let isProtectedSite = false; // Discord, Google, etc.
    let isFinalSite = false; // Mediafire, Mega, Google Drive, etc.
    let destinationUrl = null;
    let countdownDetected = false;
    let settings = { enabled: true };
    let settingsLoaded = false; // true once GET_SETTINGS resolved in this context
    let userArmed = false; // true once the user explicitly hit Skip on THIS page
    let arrivedAtDestination = false; // true when this page IS the found destination
    // Patient mode: this HOST enforces step timing server-side (proven by a
    // bounce, or seeded/learned). NO timer driving, NO clock shift, NO var
    // freezing — those tricks get the token rejected. But we do NOT wait
    // blindly either: we hold only the single gate-crossing action until the
    // earliest instant the server must accept (learned seconds, or the page's
    // own advertised countdown + margin, or observed natural completion —
    // whichever proves legal first). The wait costs the user zero attention.
    let patientMode = false;
    let enforcedRequired = null; // learned required seconds for this host (from background)
    let stepT0 = 0; // when this step page loaded (real, unshifted time)
    let advertisedWait = null; // max countdown seconds this page advertises
    let sawCountdownMove = false; // the visible count actually ticked at least once
    let hostVisitCount = 1; // same-host loads in this tab (diagnostic only now)
    // Self-experiment state for this page/host. The engine doesn't assume HOW
    // a host validates — it tries fast, then deadline, then (on repeat bounces
    // with a malleable token) ONE backdated submit, and remembers the verdict.
    let hostMalleable = false; // aged tokens pass here → submit instantly
    let hostStrict = false; // aged tokens bounced here → deadline only, no probes
    let hostBounces = 0; // bounces observed on this host (from background)
    let pageTokens = null; // inspector result for THIS page (null = not scanned yet)
    let probeTried = false; // a backdated probe already fired on this page
    let pendingTimeRewrite = null; // {targetMs, ttlMs} re-sent until the injector acks via handshake

    function enterPatientMode(source, required) {
        if (typeof required === 'number' && required > 0) {
            enforcedRequired = Math.min(Math.max(enforcedRequired || 0, required), 3); // Max 3s floor
        }
        if (patientMode) return;
        patientMode = true;
        console.log(`[KillURL] Server-side timer bypass mode (${source}) — accelerating timers`);
        try {
            window.dispatchEvent(new CustomEvent('killurl-patient'));
        } catch (e) { /* ignore */ }
    }

    // DEADLINE GATE: in server-timer bypass mode, client timers fast-forward and
    // form/net tokens are backdated, so the gate opens within at most ~2s (for initial DOM init).
    function gateReady() {
        const rem = readCountdownValue();
        if ((rem != null && rem > 0) || countdownIsLive()) return false;
        return true;
    }

    function gateRemainingMs() {
        try {
            const rem = readCountdownValue();
            if (rem != null && rem > 0) return rem * 1000;
            return 0;
        } catch (e) { return 0; }
    }
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
    let skipRetriesScheduled = false;
    function ticksDoneSeenFor(token) {
        return lastTicksDoneToken >= token;
    }

    function postDriveClickWave(source) {
        if (!isEnabled()) return;
        if (isProtectedSite || isFinalSite) return;
        if (isSecurityPage && !settings.aggressiveMode) return;
        if (isCaptchaPending()) {
            console.log(`[KillURL] Post-drive click wave withheld: Captcha / Turnstile is pending`);
            return;
        }
        console.log(`[KillURL] Post-drive click wave (${source})`);
        revealHiddenElements();
        removeOverlays();
        handleProgressBars();
        forceEnableButtons();
        // Give short settle delay (250ms) for page's timer completion callbacks / AJAX token fetches to run
        setTimeout(() => {
            if (!isEnabled()) return;
            if (destinationUrl || isCaptchaPending()) return;
            clickContinueButton();
            submitTokenFormIfReady();
            findDestinationUrl();
        }, 250);
        // Secondary wave in case the completion handler renders async
        setTimeout(() => {
            if (!isEnabled()) return;
            if (destinationUrl || isCaptchaPending()) return;
            revealHiddenElements();
            forceEnableButtons();
            clickContinueButton();
            submitTokenFormIfReady();
            findDestinationUrl();
        }, 900);
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
            // Patient state rides along on every broadcast: whichever moment
            // the injector actually loads, its FIRST state message already
            // tells it to stand down — no fast-activation window can open.
            // Proven-malleable hosts are EXCLUDED: aged tokens make elapsed
            // time irrelevant there, so the injector must stay armed for the
            // drive. A dedicated killurl-malleable event lifts even a
            // seed-booted stand-down (ordering-proof either way).
            if (patientMode && !hostMalleable) {
                window.dispatchEvent(new CustomEvent('killurl-patient'));
            }
            if (hostMalleable) {
                try {
                    window.dispatchEvent(new CustomEvent('killurl-malleable'));
                } catch (e) { /* ignore */ }
            }
            // Pending fetch/XHR time-rewrite arm (malleable hosts / probes).
            // Re-dispatched on every broadcast so late injector loads still
            // get it; the injector enforces its own TTL.
            if (pendingTimeRewrite) {
                try {
                    window.dispatchEvent(new CustomEvent('killurl-arm-time-rewrite', {
                        detail: pendingTimeRewrite
                    }));
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
    }

    // ===== SECURITY PAGE & CAPTCHA DETECTION =====
    // These pages must NEVER be interfered with (interstitial blocking challenges)

    const CAPTCHA_SHORTENER_DOMAINS = [
        'vplink.in', 'vplinks.in'
    ];

    function isCaptchaShortenerDomain(h) {
        h = (h || window.location.hostname || '').replace(/^www\./, '').toLowerCase();
        if (typeof sites !== 'undefined' && sites && typeof sites.isCaptchaShortener === 'function') {
            return sites.isCaptchaShortener(h);
        }
        return CAPTCHA_SHORTENER_DOMAINS.some(d => h === d || h.endsWith('.' + d));
    }

    const PACED_DOMAINS = [
        'rupeeriser.in', 'bcsakhi.in', 'techmint.in',
        'educatestudies.com', 'studyinsurances.com',
        'studyeducations.com', 'insurancesstudy.com',
        'studyeducates.com'
    ];

    function isPacedDomain(h) {
        h = (h || window.location.hostname || '').replace(/^www\./, '').toLowerCase();
        return PACED_DOMAINS.some(d => h === d || h.endsWith('.' + d));
    }

    function isInterstitialSecurityPage() {
        try {
            const url = (window.location.href || '').toLowerCase();
            const hostname = (window.location.hostname || '').toLowerCase();

            // Cloudflare challenge domain / platform URLs
            if (hostname === 'challenges.cloudflare.com' || hostname.endsWith('.challenges.cloudflare.com')) return true;
            if (url.includes('cf_chl_') || url.includes('__cf_chl_')) return true;

            // Full-page blocking challenge elements
            if (document.querySelector('#cf-challenge-running, #challenge-running, #challenge-stage')) {
                return true;
            }

            const html = document.documentElement?.innerHTML || '';
            if (html.includes('id="cf-challenge-running"') ||
                html.includes('id="challenge-running"') ||
                html.includes('id="challenge-stage"')) {
                return true;
            }

            const title = (document.title || '').trim();
            const bodyText = document.body?.textContent || '';
            if (title === 'Just a moment...' || title.includes('Just a moment...')) {
                if (bodyText.includes('Checking if the site connection is secure') ||
                    bodyText.includes('Performing security verification') ||
                    bodyText.includes('Cloudflare')) {
                    return true;
                }
            }
            if (bodyText.includes('Performing security verification') && html.includes('cf-')) return true;
            if (bodyText.includes('Checking if the site connection is secure') && html.includes('cf-')) return true;
            if (bodyText.includes('DDoS protection by') && bodyText.includes('Cloudflare')) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    function hasCaptchaOrTurnstile() {
        try {
            if (isCaptchaShortenerDomain()) return true;
            if (document.querySelector(
                '.cf-turnstile, [name="cf-turnstile-response"], [data-sitekey], ' +
                'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], ' +
                'script[src*="challenges.cloudflare.com"], script[src*="turnstile/v0/api.js"], ' +
                '.g-recaptcha, [name="g-recaptcha-response"], iframe[src*="recaptcha"], script[src*="recaptcha"], ' +
                '.h-captcha, [name="h-captcha-response"], iframe[src*="hcaptcha"], script[src*="hcaptcha"], ' +
                '.cf-turnstile-wrapper, .cf-chl-widget'
            )) {
                return true;
            }
            const html = document.documentElement?.innerHTML || '';
            if (html.includes('challenges.cloudflare.com/turnstile') || html.includes('turnstile/v0/api.js') || html.includes('cf-turnstile')) {
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function checkSecurityPage() {
        return isInterstitialSecurityPage();
    }

    function checkSecurityPageDOM() {
        return isInterstitialSecurityPage();
    }

    // Check if a captcha or Turnstile is actively pending/unsolved on this page
    function isCaptchaPending() {
        try {
            // 1. Cloudflare Turnstile
            const turnstileEl = document.querySelector('.cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
            const turnstileInput = document.querySelector('[name="cf-turnstile-response"]');
            if (turnstileEl || turnstileInput) {
                if (turnstileInput) {
                    const token = (turnstileInput.value || '').trim();
                    if (!token || token.length < 10) return true; // Unsolved or pending
                } else {
                    return true; // Widget exists but response input not yet generated
                }
            }

            // 2. Google reCAPTCHA
            const recaptchaEl = document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]');
            const recaptchaInput = document.querySelector('[name="g-recaptcha-response"]');
            if (recaptchaEl || recaptchaInput) {
                if (recaptchaInput) {
                    const token = (recaptchaInput.value || '').trim();
                    if (!token || token.length < 10) return true;
                } else {
                    return true;
                }
            }

            // 3. hCaptcha
            const hcaptchaEl = document.querySelector('.h-captcha, iframe[src*="hcaptcha"]');
            const hcaptchaInput = document.querySelector('[name="h-captcha-response"]');
            if (hcaptchaEl || hcaptchaInput) {
                if (hcaptchaInput) {
                    const token = (hcaptchaInput.value || '').trim();
                    if (!token || token.length < 10) return true;
                } else {
                    return true;
                }
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function hasSolvedCaptchaToken() {
        try {
            const turnstileInput = document.querySelector('[name="cf-turnstile-response"]');
            if (turnstileInput && (turnstileInput.value || '').trim().length >= 10) return true;
            const recaptchaInput = document.querySelector('[name="g-recaptcha-response"]');
            if (recaptchaInput && (recaptchaInput.value || '').trim().length >= 10) return true;
            const hcaptchaInput = document.querySelector('[name="h-captcha-response"]');
            if (hcaptchaInput && (hcaptchaInput.value || '').trim().length >= 10) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    let lastCaptchaPending = false;
    let captchaGateOpened = false;
    function checkCaptchaResolution() {
        if (isCaptchaShortenerDomain()) {
            // Dedicated startVplinkFinalController manages Turnstile, server pacing, and destination capture
            return;
        }

        const pending = isCaptchaPending();
        const hasToken = hasSolvedCaptchaToken();
        if ((lastCaptchaPending && !pending) || (hasToken && !captchaGateOpened)) {
            captchaGateOpened = true;
            console.log('[KillURL] Captcha / Turnstile verified successfully! Gate opened.');
            isSecurityPage = false;

            setTimeout(() => {
                if (!isEnabled()) return;
                if (destinationUrl) return;
                clickContinueButton();
                submitTokenFormIfReady();
                findDestinationUrl();
            }, 600);
        }
        lastCaptchaPending = pending;
    }

    // ===== TEXT PATTERNS (for DETECTION only, not auto-action) =====

    const COUNTDOWN_TEXT_PATTERNS = [
        /please wait\s*\d*/i,
        /\bwait\s*\d+\s*second/i,
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
        /\bwait\s*for\s*\d+/i,
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
        /\bwait\s*a\s*moment/i,
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
        /^download\s*link$/i,
        /^go\s*to\s*link$/i,
        /^visit\s*(link|page|site|url)$/i,
        /^get\s*download\s*link$/i,
        /^generate\s*(download\s*)?link$/i,
        /^access\s*link$/i,
        /^open\s*link$/i,
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
        /\bwait\s+\d+/i,
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
        '#link1s-time', '#tp-time', '#link1s-wait1', '#tp-wait1',
        '#ce-time', '#ce-wait1', '.ce-time', '.ce-wait1',
        '[id*="link1s"]', '[id*="tp-"]',
        '[id*="time"]', '[class*="time"]',
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
        'a.btn-success', 'a.btn-primary', 'a.btn-info',
        'button#continue', 'button.continue',
        'button#skip', 'button.skip',
        'button#getlink', 'button.getlink', 'button#get-link',
        '#btn-main a', '.btn-main a',
        '#wpsafe-link a', '.wpsafe-link a',
        '#wpsafe-generate a',
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
            if (isCaptchaShortenerDomain()) {
                console.log('[KillURL] Captcha shortener domain (' + window.location.hostname + ') — omitting injector.js to preserve Turnstile verification');
                return;
            }
            if (isSecurityPage || isInterstitialSecurityPage() || hasCaptchaOrTurnstile()) {
                console.log('[KillURL] Security / Captcha page detected — skipping injector.js insertion');
                return;
            }
            const pageWindow = typeof window.wrappedJSObject !== 'undefined' ? window.wrappedJSObject : window;
            if (!pageWindow.__k7_ld) {
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
        try {
            const mv = chrome.runtime.getManifest?.().version || '?';
            console.log('[KillURL] content boot v' + mv + ' @ ' + window.location.hostname);
        } catch (e) { /* ignore */ }
        const sites = window.KILLURL_SITES || (typeof globalThis !== 'undefined' ? globalThis.KILLURL_SITES : null);
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();

        try {
            settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        } catch (e) {
            settings = {};
        }
        // Default to enabled for old installs without the flag
        if (typeof settings.enabled === 'undefined') settings.enabled = true;
        settingsLoaded = true;

        // If this is a captcha shortener domain (e.g. vplink.in) or multi-step blog, register multi-step chain start
        if (isCaptchaShortenerDomain() || hostname.includes('rupeeriser')) {
            try { chrome.runtime.sendMessage({ type: 'REGISTER_CHAIN_START' }); } catch (e) { /* ignore */ }
        }

        // Pre-seed shortcut cookies for multi-step blog chains
        try {
            if (hostname.includes('bcsakhi') || hostname.includes('educatestudies')) {
                if (!document.cookie.includes('adcadg=')) {
                    document.cookie = 'adcadg=insurance,online_colleges,study_abroad,finance,loan; path=/; max-age=3600';
                }
            }
            if (hostname.includes('rupeeriser') || hostname.includes('studyeducates')) {
                if (!document.cookie.includes('_uocat=')) {
                    document.cookie = '_uocat=value; path=/; max-age=86400';
                }
            }
        } catch (e) { /* ignore */ }

        // Effective-state heartbeat: the two most common "nothing happens"
        // causes are a master switch left OFF and autoSkip left OFF — both
        // are answered by this single line, no guessing needed.
        try {
            console.log('[KillURL] state: enabled=' + (settings.enabled !== false) +
                ' autoSkip=' + !!settings.autoSkip +
                ' aggressive=' + !!settings.aggressiveMode +
                ' adWalls=' + !!settings.removeAdBlockWalls +
                ' stealth=' + (settings.adblockStealth !== false));
        } catch (e) { /* ignore */ }

        // Master switch OFF → stay completely dormant
        if (settings.enabled === false) {
            console.log('[KillURL] Extension is turned OFF — dormant');
            return;
        }

        // Direct MediaFire error page detector (e.g. errno=320)
        if (hostname.includes('mediafire.com') && (window.location.href.includes('error.php') || window.location.href.includes('errno='))) {
            renderSmartBar({
                step: 'FILE DELETED',
                message: '❌ MediaFire Error 320: File was deleted from MediaFire by its uploader. (Not a KillURL bypass error).',
                icon: '⚠️',
                isReady: false
            });
            return;
        }

        // Auto-recovery for raw JSON /links/go screen
        const currentPath = (window.location.pathname || '').toLowerCase();
        if (currentPath.endsWith('/links/go') || currentPath.includes('/links/go')) {
            let rawJsonHandled = false;
            function checkRawJsonRecovery() {
                if (rawJsonHandled) return false;
                try {
                    const raw = document.body ? (document.body.innerText || document.body.textContent || '') : '';
                    const trimmed = raw.trim();
                    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                        const data = JSON.parse(trimmed);
                        if (data && data.url) {
                            rawJsonHandled = true;
                            console.log('[KillURL] /links/go raw JSON recovery processing destination:', data.url);
                            processCandidateDestination(data.url);
                            return true;
                        }
                    }
                } catch (e) { /* ignore */ }
                return false;
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', checkRawJsonRecovery);
            } else {
                checkRawJsonRecovery();
            }
            setInterval(checkRawJsonRecovery, 500);
        }

        // Iframe context (ad frames etc.): dormant except the ritual-X
        // watcher. Nothing inside a frame is ever auto-clicked, submitted,
        // revealed or navigated — but a click-ads modal rendered in a frame
        // still gets its X pressed.
        let inIframe = false;
        try { inIframe = window.self !== window.top; } catch (e) { inIframe = true; }
        if (inIframe) {
            const frameHost = (window.location.hostname || '').toLowerCase();
            const frameUrl = (window.location.href || '').toLowerCase();
            if (frameHost.includes('challenges.cloudflare.com') ||
                frameHost.includes('recaptcha.net') ||
                frameHost.includes('hcaptcha.com') ||
                frameUrl.includes('/turnstile/') ||
                frameUrl.includes('/cdn-cgi/challenge-platform/')) {
                // NEVER touch the DOM or install observers inside Captcha / Turnstile challenge iframes!
                return;
            }
            console.log('[KillURL] Iframe context — ritual-X watcher only');
            try { watchRitualModals(); } catch (e) { /* ignore */ }
            try { dismissInstructionModals({ aggressive: false, xOnly: true }); } catch (e) { /* ignore */ }
            try { handleAdGateOverlays(); } catch (e) { /* ignore */ }
            if (settings.removeAdBlockWalls) {
                try { watchAdBlockWalls({ iframe: true }); } catch (e) { /* ignore */ }
            }
            return;
        }

        // 1. Protected domain check (Discord, Google, etc. — NEVER disrupt)
        if (sites && sites.isProtected(hostname)) {
            isProtectedSite = true;
            // Streaming site exception: ONLY allow DRM bypass if user turned it on
            if (sites.isStreaming(hostname) && settings.screenShareDRM) {
                console.log('[KillURL] Streaming site on protected domain with DRM bypass active:', hostname);
                ensureInjectorLoaded();
                broadcastStatesToInjector();
                return;
            }
            console.log('[KillURL] Protected domain — KillURL is dormant on', hostname);
            return;
        }

        // 2. Final destination check (Mediafire, Mega, Google Drive, etc. — NEVER skip)
        if (sites && sites.isFinal(hostname)) {
            if (!sites.isErrorUrl(window.location.href)) {
                isFinalSite = true;
                arrivedAtDestination = true;
                console.log('[KillURL] Final destination reached (' + hostname + ') — standing down completely');
                try {
                    chrome.runtime.sendMessage({ type: 'CHAIN_COMPLETED', url: window.location.href });
                } catch (e) { /* ignore */ }
                return;
            } else {
                console.log('[KillURL] Error page detected on destination host (' + window.location.href + ') — not marking completed');
            }
        }

        // 3. Site scope check ('known', 'custom', 'all')
        if (settings.enabledSites === 'known') {
            const isKnown = sites ? sites.isShortener(hostname) : false;
            const customList = sites ? sites.normCustom(settings.customSites) : [];
            const isCustom = sites ? sites.inList(hostname, customList) : false;
            if (!isKnown && !isCustom) {
                console.log('[KillURL] Site not in known shorteners scope — dormant:', hostname);
                return;
            }
        } else if (settings.enabledSites === 'custom') {
            const customList = sites ? sites.normCustom(settings.customSites) : [];
            const isCustom = sites ? sites.inList(hostname, customList) : false;
            if (!isCustom) {
                console.log('[KillURL] Site not in custom sites list — dormant:', hostname);
                return;
            }
        }

        // Standalone ritual-modal watcher: independent of skip flows, autopilot
        // and waiter, so instruction modals get their X pressed whenever they
        // appear — even on pages where no skip ever engages. X-press only.
        // Watch-ad gates get their own Continue pressed the same way.
        try { watchRitualModals(); } catch (e) { /* ignore */ }
        try { dismissInstructionModals({ aggressive: false, xOnly: true }); } catch (e) { /* ignore */ }
        try { handleAdGateOverlays(); } catch (e) { /* ignore */ }
        // Always-on wall remover (the Auto-Remove toggle): sweeps all three
        // wall species on every DOM change instead of 4 fixed timeouts.
        if (settings.removeAdBlockWalls) {
            try { watchAdBlockWalls(); } catch (e) { /* ignore */ }
        }

        // 4. Seed patient mode immediately if known server-side timing check host (e.g. vplink.in)
        if (sites && sites.inList(hostname, sites.PATIENT_SEED)) {
            enterPatientMode('seed');
        }

        // 5. Arrival + loop checks FIRST. The injector must never receive its
        // "master ON" (which fast-activates it on known shortener domains)
        // before we know whether this chain is patient — that ordering race
        // used to fast-forward timers for a moment right after a bounce and
        // defeated loop protection entirely.
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

        // Loop check: been here before in this tab, or has this HOST proven
        // server-side waits (seeded or learned, with required seconds)?
        // Patient BEFORE the injector loads so it can never fast-activate.
        // stepT0 marks real step arrival for the deadline gate.
        stepT0 = Date.now();
        try {
            const lp = await chrome.runtime.sendMessage({ type: 'CHECK_LOOP', url: window.location.href });
            if (typeof lp?.hostVisits === 'number') hostVisitCount = lp.hostVisits;
            if (typeof lp?.bounces === 'number') hostBounces = lp.bounces;
            if (lp?.strict) hostStrict = true;
            if (lp?.loop) {
                enterPatientMode(lp?.learned ? 'learned server-timed host' : 'revisit #' + (lp.visits || '?'), lp?.required);
            }
            if (lp?.malleable) {
                hostMalleable = true;
                pendingTimeRewrite = null;
                console.log('[KillURL] Host malleable — fast server skip engine active');
            }
            // Passive token scan shortly after load (powers the probe path).
            setTimeout(() => { try { inspectTokens(); } catch (e) { /* ignore */ } }, 2000);
        } catch (e) { /* background unreachable: proceed normally */ }

        // Security check: interstitial challenge vs captcha widget
        if (isInterstitialSecurityPage()) {
            isSecurityPage = true;
            console.log('[KillURL] Interstitial security challenge page detected — standing down');
            return;
        }

        if (isCaptchaShortenerDomain() || hasCaptchaOrTurnstile()) {
            console.log('[KillURL] Captcha shortener / widget present — omitting injector.js to preserve Turnstile integrity');
        } else {
            // 6. Only now inject the MAIN-world injector — its first state
            // broadcast already carries patient/arrival information.
            ensureInjectorLoaded();
            broadcastStatesToInjector();
        }
        if (settings.screenShareDRM) {
            console.log('[KillURL] DRM screen share bypass setting sent to MAIN world: ENABLED');
        }

        // Listen for events from MAIN world injector (attach once)
        if (!mainListenersAttached) {
            mainListenersAttached = true;

            // Global click capture in content script: prevent ad clicks and enforce _self on links
            try {
                document.addEventListener('click', (e) => {
                    if (!isEnabled()) return;
                    try {
                        const a = e.target?.closest?.('a[href]');
                        if (a) {
                            const href = (a.href || a.getAttribute('href') || '').trim();
                            if (href && isAdUrl(href)) {
                                console.log('[KillURL] Blocked click on ad link in content script:', href.slice(0, 80));
                                e.preventDefault();
                                e.stopPropagation();
                                return;
                            }
                            if (isNewTabTarget(a.target) || isNewTabTarget(a.getAttribute('target'))) {
                                a.target = '_self';
                                a.setAttribute('target', '_self');
                            }
                        }
                    } catch (err) { /* ignore */ }
                }, true);
            } catch (e) { /* ignore */ }

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

            window.addEventListener('killurl-destination-found', (e) => {
                if (!isEnabled()) return;
                const url = e.detail?.url;
                if (url && isValidDestination(url)) {
                    console.log('[KillURL] Destination link received from main world:', url);
                    processCandidateDestination(url);
                }
            });

            window.addEventListener('killurl-turnstile-solved', (e) => {
                if (!isEnabled()) return;
                console.log('[KillURL] Turnstile solved in main world');
                renderSmartBar({
                    step: 'MEDIAFIRE ACCESS',
                    message: 'Turnstile verified! Unlocking MediaFire link...',
                    icon: '⚡',
                    isReady: false
                });
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
                if (isInterstitialSecurityPage()) {
                    console.log('[KillURL] Security challenge confirmed by injector — disabling');
                    isSecurityPage = true;
                    stopContinuousScanner();
                    if (e.detail?.aggressiveWatching) {
                        console.log('[KillURL] Aggressive mode: waiting for CF to complete...');
                    }
                } else {
                    console.log('[KillURL] Security notice received but page is active content — keeping scanner running');
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

        setupPrematureClickGuard();

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
        if (isProtectedSite || isFinalSite) {
            console.log('[KillURL] Turned ON, but site is protected or final destination — staying dormant');
            return;
        }
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
        // Check security page (interstitial challenge)
        if (isInterstitialSecurityPage()) {
            isSecurityPage = true;
            if (!settings.aggressiveMode) {
                console.log('[KillURL] Interstitial security page detected — all actions disabled');
                return;
            }
            console.log('[KillURL] Interstitial security page detected — aggressive mode, continuing...');
        }

        if (hasCaptchaOrTurnstile() || isCaptchaShortenerDomain()) {
            console.log('[KillURL] Turnstile / Captcha detected on DOM ready — main world kept native');
            try {
                window.dispatchEvent(new CustomEvent('killurl-turnstile-detected', { detail: { reason: 'dom-ready-turnstile' } }));
            } catch (e) { /* ignore */ }
        }

        // DETECTION only — no skipping
        detectShortenerPage();
        setupPrematureClickGuard();
        setupMutationObserver();
        startContinuousScanner();
        if (isPacedDomain()) {
            startPacedStepController();
        } else if (isCaptchaShortenerDomain()) {
            startVplinkFinalController();
        }

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
                if (isInterstitialSecurityPage()) {
                    isSecurityPage = true;
                    if (!settings.aggressiveMode) {
                        stopContinuousScanner();
                        return;
                    }
                }
                if (hasCaptchaOrTurnstile()) {
                    try {
                        window.dispatchEvent(new CustomEvent('killurl-turnstile-detected', { detail: { reason: 'interval-turnstile' } }));
                    } catch (e) { /* ignore */ }
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
            checkCaptchaResolution();
            if (isSecurityPage && !settings.aggressiveMode) {
                if (isCaptchaPending()) return;
                if (isInterstitialSecurityPage()) {
                    stopContinuousScanner();
                    return;
                }
                isSecurityPage = false;
            }

            scanCount++;
            passiveScan();

            // ACTIVE AUTO-ADVANCE FOR SHORTENER PAGES:
            // When waiting on intermediate earn blogs / shortener steps:
            // 1. If an initial verification button exists, click it to start the timer.
            // 2. If countdown is actively ticking, wait for it to finish.
            // 3. When countdown finishes, advance cleanly.
            // Never auto-advance or force-click on captcha shortener domains (e.g. vplink.in)
            if (!isCaptchaShortenerDomain() && !isFinalSite && !isProtectedSite) {
                if (isPacedDomain()) {
                    // Dedicated PacedStepController manages pacing, smart bar, and advancing
                    return;
                }
                // Immediately dismiss deceptive ad overlays (e.g. #adOverlay on bcsakhi)
                try {
                    const adOverlay = document.getElementById('adOverlay');
                    if (adOverlay) adOverlay.remove();
                    const gcont = document.getElementById('gcont');
                    if (gcont && gcont.style.position !== 'static') gcont.style.position = 'static';
                } catch (e) { /* ignore */ }

                patientScrollNudge();

                // Check for initial verification / start button first
                if (autoPressAllowed() && !unloading && !destinationUrl && !isCaptchaPending()) {
                    if (clickInitialVerificationButton()) {
                        return;
                    }
                }

                // If countdown is actively ticking, wait and display remaining time
                const rem = readCountdownValue();
                if (rem != null && rem > 0) {
                    renderSmartBar({
                        step: 'COUNTDOWN',
                        message: `Waiting for timer completion (~${rem}s remaining)...`,
                        telemetry: '⏳ Active Countdown • ⚡ Auto-Skip Standing By',
                        remaining: rem,
                        total: Math.max(10, rem),
                        progressPct: Math.min(100, Math.max(0, ((Math.max(10, rem) - rem) / Math.max(10, rem)) * 100)),
                        icon: '⏳',
                        isReady: false
                    });
                    return;
                }

                // On paced domains, if countdown has reached 0 or completed, ensure terminal buttons are unhidden
                if (isPacedDomain()) {
                    const cross = document.getElementById('cross-snp2');
                    if (cross && cross.style.display === 'none') {
                        const tEl = document.getElementById('link1s-time');
                        const tVal = tEl ? parseInt(tEl.textContent, 10) : null;
                        if ((tVal !== null && !isNaN(tVal) && tVal <= 0) || (rem != null && rem <= 0)) {
                            cross.style.display = 'block';
                        }
                    }
                    const tp = document.getElementById('tp-snp2');
                    if (tp && tp.style.display === 'none') {
                        const tEl = document.getElementById('tp-time');
                        const tVal = tEl ? parseInt(tEl.textContent, 10) : null;
                        if ((tVal !== null && !isNaN(tVal) && tVal <= 0) || (rem != null && rem <= 0)) {
                            tp.style.display = 'block';
                        }
                    }
                }

                if (!countdownIsLive() && autoPressAllowed() && !unloading && !destinationUrl) {
                    forceEnableButtons();
                    if (!isCaptchaPending()) {
                        clickContinueButton();
                        submitTokenFormIfReady();
                    }
                }
            }

            // Stop scanning after 2 minutes
            if (scanCount > 400) {
                stopContinuousScanner();
            }
        }, 300);
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
                // Capture the advertised wait: the largest wait-bound number in
                // this page's text. This feeds the deadline floor (advertised+2)
                // and the bounce attribution sent to the background.
                try {
                    const nums = [];
                    for (const p2 of [/please\s*wait[^\n]{0,40}/gi, /\bwait\s+\d+[^\n]{0,30}/gi, /\d+\s*seconds?\s*(remaining|left)[^\n]{0,20}/gi, /(?:continue|proceed)[^\n]{0,12}in\s*\d+/gi, /(\d{1,3}):(\d{2})/g]) {
                        let m;
                        while ((m = p2.exec(bodyText)) !== null) {
                            const v = parseCountdownSeconds(m[0]);
                            if (v != null && v > 0) nums.push(v);
                            if (m[0].length === 0) break;
                        }
                    }
                    for (const v of nums) {
                        if (advertisedWait == null || v > advertisedWait) advertisedWait = v;
                    }
                } catch (e) { /* ignore */ }
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
                            if (advertisedWait == null || num > advertisedWait) advertisedWait = num;
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
                try {
                    const parts = text.split(':').map(x => parseInt(x, 10));
                    const secs = parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
                    if (secs > 0 && (advertisedWait == null || secs > advertisedWait)) advertisedWait = secs;
                } catch (e) { /* ignore */ }
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
                    // Button detected for status display. Do NOT send FOUND_DESTINATION from here:
                    // interactive buttons must be clicked when their timer finishes, not force-redirected!
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
        if (isCaptchaShortenerDomain()) {
            console.log('[KillURL] Captcha shortener domain — auto-skip standing by for captcha completion');
            return;
        }
        if (isPacedDomain()) {
            console.log('[KillURL] Paced domain — auto-skip strictly delegated to PacedStepController');
            return;
        }
        if (skipAttempted) return;
        if (!settings.autoSkip) return;
        // NOTE: no late-patient heuristic here. Patient engagement comes only
        // from host-scoped evidence (seed list, learned list, exact revisit) —
        // a visit-count heuristic put protection on innocent multi-step pages.
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

        // Patient chain (loop detected): no driving, no nuking — prep gently
        // and let the waiter advance on natural completion. A few spaced
        // nudges cover slow-loading steps; the waiter does the real work.
        // EXCEPTION: proven-malleable hosts go instant — aged tokens make
        // elapsed time irrelevant, so the drive is safe again.
        if (patientMode && !hostMalleable) {
            console.log('[KillURL] Server timer mode: waiting for authentic countdown completion');
            executePatientSkip();
            armAutopilot();
            return;
        }

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
                if (unloading || destinationUrl) return;
                if (!autoPressAllowed()) return;
                const rem = readCountdownValue();
                if (((rem != null && rem > 0) || countdownIsLive()) && !settings.aggressiveMode) {
                    console.log(`[KillURL] Auto-skip attempt ${index + 1} deferred — countdown actively running (~${rem}s remaining)`);
                    return;
                }
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
        if (isProtectedSite || isFinalSite) return;
        if (isSecurityPage && !settings.aggressiveMode) return;
        const hostname = window.location.hostname.replace(/^www\./, '');

        chrome.runtime.sendMessage(
            { type: 'CHECK_SHORTENER', hostname },
            (response) => {
                if (response?.isShortener) {
                    isKnownShortener = true;
                    isShortenerPage = true;
                    notifyStatus();
                    try {
                        chrome.runtime.sendMessage({ type: 'RESOLVE_BYPASS', url: window.location.href }, (resp) => {
                            if (resp && resp.destination) {
                                console.log('[KillURL] Remote resolver resolved destination:', resp.destination);
                                setDestination(resp.destination);
                            }
                        });
                    } catch (e) { /* ignore */ }
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
        if (isProtectedSite || isFinalSite) return false;
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
            chrome.runtime.sendMessage({
                type: 'PAGE_STATUS',
                detected: true,
                advertised: (typeof advertisedWait === 'number' && advertisedWait > 0) ? advertisedWait : null
            });
        } catch (e) { /* ignore */ }
        findDestinationUrl();
    }

    // ===== EXECUTE GENTLE SKIP (auto-skip — DOM only, doesn't kill timers) =====
    // Safe to run early — won't break page loading

    function executeGentleSkip() {
        if (!isEnabled()) return;
        if (isProtectedSite || isFinalSite || isPacedDomain() || isCaptchaShortenerDomain()) return;
        if (isSecurityPage && !settings.aggressiveMode) return;
        if (isCaptchaPending()) return;

        if (patientMode && !hostMalleable) {
            console.log('[KillURL] Gentle skip in server-timer bypass mode — delegating to bypass skip');
            executePatientSkip();
            return;
        }

        console.log('[KillURL] Gentle skip — DOM manipulation only...');

        // DOM manipulation — reveal buttons, remove overlays
        revealHiddenElements();
        removeOverlays();
        handleProgressBars();
        forceEnableButtons();
        findDestinationUrl();

        // Try clicking continue buttons only if countdown is not actively ticking
        setTimeout(() => {
            if (!isEnabled()) return;
            if (isPacedDomain() || isCaptchaShortenerDomain()) return;
            if (countdownIsLive() || isCaptchaPending()) return;
            clickContinueButton();
            submitTokenFormIfReady();
            findDestinationUrl();
        }, 500);
    }

    // ===== EXECUTE SKIP (manual click or escalated auto-skip — full nuclear) =====
    // This clears ALL timers and zeros variables — can break page loading if run too early

    function executeSkip() {
        if (!isEnabled()) {
            console.log('[KillURL] Skip blocked — extension is turned OFF');
            return;
        }
        if (isProtectedSite || isPacedDomain() || isCaptchaShortenerDomain()) {
            console.log('[KillURL] Skip blocked — protected or paced site');
            return;
        }
        if (isFinalSite) {
            console.log('[KillURL] Skip blocked — final destination reached');
            return;
        }
        if (isSecurityPage && !settings.aggressiveMode) {
            console.log('[KillURL] Skipping blocked — security page (aggressive mode off)');
            return;
        }
        if (isCaptchaPending()) {
            console.log('[KillURL] Skipping blocked — Captcha / Turnstile pending');
            return;
        }

        const activeRemaining = readCountdownValue();
        if (((activeRemaining != null && activeRemaining > 0) || countdownIsLive()) && !settings.aggressiveMode) {
            console.log(`[KillURL] Force-skip withheld — countdown is active (~${activeRemaining}s remaining). Waiting for natural completion to preserve authentic server timestamps.`);
            return;
        }

        if (isSecurityPage && settings.aggressiveMode) {
            console.log('[KillURL] Aggressive mode: forcing skip despite security page detection');
        }

        console.log('[KillURL] Executing skip...');
        // Manual skips arm the autopilot so chained steps keep advancing.
        // This is explicit per-page consent: the user asked THIS page to act.
        userArmed = true;

        if (patientMode && !hostMalleable) {
            console.log('[KillURL] Server timer bypass mode: accelerating skip with aged tokens');
            armAutopilot();
            executePatientSkip();
            return;
        }
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
        // (lost event, slow drive), still run the post-drive routine at +2.5s.
        setTimeout(() => {
            if (skipToken !== skipSequence) return;
            if (!isEnabled()) return;
            if (destinationUrl) return;
            if (window.location.href !== skipHref) return;
            if (ticksDoneSeenFor(skipToken)) return;
            console.log('[KillURL] Ticks-done event missing — running fallback click wave');
            postDriveClickWave('fallback-2.5s');
        }, 2500);

        // 3. DOM manipulation — reveal buttons, remove overlays
        revealHiddenElements();
        removeOverlays();
        handleProgressBars();
        forceEnableButtons();

        // 4. Try clicking continue buttons only if there is NO live countdown
        setTimeout(() => {
            if (!isEnabled()) return;
            if (!countdownIsLive()) {
                clickContinueButton();
                submitTokenFormIfReady();
                findDestinationUrl();
            }
        }, 500);

        // 5. Retry at intervals (longer window for stubborn multi-step templates)
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();
        const isStubbornSite = hostname === 'earnbox.in' ||
            hostname.endsWith('nitro-link.com') || hostname.endsWith('nitrolink.com') ||
            hasTokenForm();

        const retryDelays = isStubbornSite
            ? [500, 1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 13000, 16000, 20000, 25000]
            : [500, 1000, 2000, 3000, 5000, 8000, 12000];

        if (!skipRetriesScheduled) {
            skipRetriesScheduled = true;
            retryDelays.forEach(delay => {
                setTimeout(() => {
                    if (!isEnabled()) return;
                    if (unloading || destinationUrl) return;
                    if (!autoPressAllowed()) return;
                    revealHiddenElements();
                    forceEnableButtons();
                    forceCountdownTextToZero();
                    clickContinueButton();
                    submitTokenFormIfReady();
                    findDestinationUrl();
                }, delay);
            });
        }
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
            const ancestor = el.closest('[class*="captcha" i], [id*="captcha" i], [class*="turnstile" i], [class*="challenge" i], .cf-turnstile');
            if (ancestor) return true;
            // Also check if el is or is inside a form with an unsolved captcha
            const form = el.closest('form');
            if (form && form.querySelector('.cf-turnstile, [name="cf-turnstile-response"], .g-recaptcha, .h-captcha') && isCaptchaPending()) {
                return true;
            }
        } catch (e) { return true; }
        return false;
    }

    function isSafeToClick(el) {
        try {
            if (!el || el.disabled) return false;
            if (isProtectedWidget(el)) return false;
            if (isCaptchaPending()) return false;
            const type = (el.getAttribute('type') || '').toLowerCase();
            if (type === 'checkbox' || type === 'radio') return false; // never auto-toggle opt-ins
            const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
            if (/captcha|i'm not a robot|i am not a robot|turnstile/.test(text)) return false;

            // Reject buttons displaying wait or loading text
            if (/(?:please\s*wait|wait\s*\d+|wait\s*in|\b\d+\s*s\b|generating\s*link|generating\.\.\.|loading\.\.\.)/i.test(text)) {
                return false;
            }

            // Reject elements with ad URLs, ad redirects, or error/penalty URLs
            const href = (el.getAttribute('href') || el.dataset?.url || el.dataset?.href || '').trim();
            if (href) {
                if (isAdUrl(href)) return false;
                if (isErrorDestination(href)) return false;
            }

            // Reject elements inside ad containers or sponsored wrappers
            if (el.closest('.adsbygoogle, [class*="adsense" i], [id*="adsense" i], [class*="ad-banner" i], [id*="ad-banner" i], [class*="ad-box" i], [id*="ad-box" i], [class*="ad_container" i], [id*="ad_container" i], [class*="taboola" i], [id*="taboola" i], [class*="outbrain" i], [id*="outbrain" i], [class*="mgid" i], [id*="mgid" i], [class*="popads" i], [id*="popads" i]')) {
                return false;
            }
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
        const lower = t.toLowerCase();
        if (/(?:please\s*wait|wait\s*\d+|wait\s*in|\b\d+\s*s\b|generating\s*link|generating\.\.\.|loading\.\.\.)/i.test(lower)) {
            return false;
        }
        for (const pattern of BUTTON_TEXT_PATTERNS) {
            if (pattern.test(t)) return true;
        }
        if (loose) {
            for (const pattern of BUTTON_TEXT_PATTERNS_LOOSE_EXTRA) {
                if (pattern.test(t)) return true;
            }
        }
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
        if (patientMode) return;
        const rem = readCountdownValue();
        if (((rem != null && rem > 0) || countdownIsLive()) && !settings.aggressiveMode) return;
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
    // HARD RULES: only with canAutoAct consent, only token-style forms, and
    // NEVER login/payment/upload forms — a CSRF token plus a "Continue"
    // button describes every login page on the web. In patient mode, submit
    // only when no live timer is running (never force it early). Max one
    // submit per 5s per page: token replays get rejected and look like abuse.
    let lastSubmitT = 0;
    // New-tab press suppression: ONE synthetic press on a target=_blank
    // opener is enough — it either advanced (tab opened, job done) or the
    // gate swallowed it. Pressing again only opens DUPLICATE tabs, and our
    // retry/autopilot/waiter loops would otherwise press hundreds of times
    // (each new tab also runs the extension). So after any new-tab press,
    // automatic loops go quiet for 45s; manual Skip always still works.
    // Per-element tracking additionally caps the SAME opener to one press
    // per 120s, so a wrong-target press never blocks a different button.
    let suppressAutoPressUntil = 0;
    const blankPressedAt = new WeakMap();
    function autoPressAllowed() { return Date.now() >= suppressAutoPressUntil; }
    // Per HTML spec only _self/_parent/_top (or no target at all) navigate an
    // existing browsing context. _blank, _new, "blank" and ANY other named
    // target open a new tab — templates use all of these, so matching only
    // '_blank' lets whole tab-storms through undetected.
    function isNewTabTarget(t) {
        try {
            t = (t || '').trim().toLowerCase();
            return t !== '' && t !== '_self' && t !== '_parent' && t !== '_top';
        } catch (e) { return false; }
    }

    const AD_URL_RE = /googlesyndication|googleadservices|doubleclick|googletagservices|adservice\.google|pagead|adsbygoogle|adsrvr|adnxs|criteo|taboola|outbrain|revcontent|mgid|amazon-adsystem|apstag|pubmatic|rubicon|moatads|2mdn\.net|prebid|pbjs|pop-?under|banner-?ads|popads|adnxs-simple|popcash|propellerads|adsterra|monetag|clickadu|yllix|hilltopads|exoclick|trafficjunky|juicyads|ero-advertising|richads|adcash|bidvertiser|revenuehits|evadav|admaven|rollerads|onclickmega|highcpmgate|highrevenuegate|al5sm|whomee|dood|streamtape|vupload/i;

    function isAdUrl(url) {
        if (!url) return false;
        try {
            const u = String(url).trim();
            if (!u || u === '#' || u.startsWith('javascript:')) return false;
            return AD_URL_RE.test(u) || /[?&](zoneid|bannerid|campaignid|pubid|direct_link|popunder|popup)=/i.test(u);
        } catch (e) { return false; }
    }

    function enforceSameTabTarget(el) {
        if (!el) return;
        try {
            const a = el.tagName === 'A' ? el : (el.closest ? el.closest('a[href]') : null);
            if (a) {
                if (isNewTabTarget(a.getAttribute('target')) || isNewTabTarget(a.target)) {
                    console.log('[KillURL] Rewrote CTA target from ' + (a.target || a.getAttribute('target')) + ' to _self');
                    a.target = '_self';
                    a.setAttribute('target', '_self');
                }
            }
        } catch (e) { /* ignore */ }
        try {
            const f = el.tagName === 'FORM' ? el : (el.closest ? el.closest('form') : null);
            if (f) {
                if (isNewTabTarget(f.getAttribute('target')) || isNewTabTarget(f.target)) {
                    console.log('[KillURL] Rewrote form target from ' + (f.target || f.getAttribute('target')) + ' to _self');
                    f.target = '_self';
                    f.setAttribute('target', '_self');
                }
            }
        } catch (e) { /* ignore */ }
    }

    function opensNewTab(el) {
        try {
            if (!el || el.nodeType !== 1) return false;
            const a = el.tagName === 'A' ? el : (el.closest ? el.closest('a[href]') : null);
            if (!a) return false;
            const href = a.getAttribute('href') || '';
            if (!/^https?:/i.test(href)) return false;
            return isNewTabTarget(a.getAttribute('target'));
        } catch (e) { return false; }
    }
    function noteNewTabPress(el) {
        suppressAutoPressUntil = Date.now() + 45000;
        try {
            if (el) blankPressedAt.set(el, Date.now());
            const label = ((el && (el.textContent || el.value)) || '').trim().slice(0, 60);
            console.log('[KillURL] New-tab press recorded — auto-press paused 45s:', label, '| via:', pressCallerTag());
        } catch (e) { /* ignore */ }
    }
    // Who initiated this press (for the audit trail — tells us exactly which
    // loop pressed when tabs multiply).
    function pressCallerTag() {
        try {
            const st = new Error().stack || '';
            const names = [...st.matchAll(/at ([^\s(]+)/g)]
                .map(m => m[1].split('.').pop())
                .filter(n => !/^(pressCallerTag|noteNewTabPress|dispatchFullClickSequence|Error|Object\.|<anonymous>)$/.test(n))
                .slice(0, 3);
            return names.length ? names.join(' < ') : '?';
        } catch (e) { return '?'; }
    }
    function blankPressFresh(el) {
        try {
            const t = el ? blankPressedAt.get(el) : 0;
            return !t || (Date.now() - t > 120000);
        } catch (e) { return true; }
    }
    // Set the moment this page starts unloading: a navigation already won the
    // race, so any further synthetic press can only fork a stray duplicate tab.
    let unloading = false;
    try {
        window.addEventListener('pagehide', () => { unloading = true; }, { capture: true });
        // Back-forward cache restore is NOT an unload — re-arm pressing.
        window.addEventListener('pageshow', () => { unloading = false; }, { capture: true });
    } catch (e) { /* ignore */ }
    // ===== TOKEN INSPECTOR (passive — never alters anything) =====
    // Earn steps gate on tokens (URL params, hidden inputs, storage). Some
    // carry their own issue-time IN THE CLEAR (plain base64 JSON, or an
    // unsigned 2-part JWT): the server then trusts client-visible time, which
    // is backdateable. A 3-part JWT or a payload WITH a signature/hash field
    // beside the time means tampering breaks it (not malleable). Values are
    // NEVER logged — only shapes (keys + kinds).
    const TOKEN_NAME_RE = /token|_token|csrf|authenticity|__requestverificationtoken|link_id|alias|slug|hash|key|nonce|state|payload|data|d$/i;
    const TOKEN_TIME_KEY_RE = /^(iat|issued|issued_at|timestamp|timestamps|ts|t|time|created|created_at|starttime|start_time|wait_start|begin|begin_at)$|(_at|_time|timestamp)$/i;
    const TOKEN_SIG_KEY_RE = /sig(nature)?|hmac|hash|checksum|digest|mac$/i;

    function plausibleTime(v) {
        try {
            if (typeof v !== 'number' || !isFinite(v)) return null;
            const nowMs = Date.now();
            if (Math.abs(v - nowMs) < 10 * 365 * 24 * 3600 * 1000) return 'ms';
            if (Math.abs(v - nowMs / 1000) < 10 * 365 * 24 * 3600) return 's';
            return null;
        } catch (e) { return null; }
    }

    function b64ToJson(raw) {
        try {
            let s = String(raw || '').trim().replace(/\s+/g, '');
            if (s.length < 8 || s.length > 20000) return null;
            s = s.replace(/-/g, '+').replace(/_/g, '/');
            while (s.length % 4) s += '=';
            if (!/^[A-Za-z0-9+/=]+$/.test(s)) return null;
            const bin = atob(s);
            if (/[^\x20-\x7E]/.test(bin.slice(0, 64))) {
                // Possibly UTF-8 JSON — decode carefully.
                try {
                    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
                    const txt = new TextDecoder().decode(bytes);
                    const o = JSON.parse(txt);
                    return (o && typeof o === 'object') ? o : null;
                } catch (e2) { return null; }
            }
            const o = JSON.parse(bin);
            return (o && typeof o === 'object') ? o : null;
        } catch (e) { return null; }
    }

    function analyzeDecodedObject(o) {
        // Returns { timeKeys: [...], signed: bool } — signed means a
        // signature/hash field sits BESIDE the time: backdating breaks it.
        const keys = Object.keys(o || {});
        const timeKeys = keys.filter(k => {
            try { return TOKEN_TIME_KEY_RE.test(k) && plausibleTime(o[k]) != null; } catch (e) { return false; }
        });
        const signed = keys.some(k => { try { return TOKEN_SIG_KEY_RE.test(k); } catch (e) { return false; } });
        return { timeKeys, signed };
    }

    function analyzeTokenValue(raw) {
        // Returns null (not a token payload) or { kind, timeKeys, malleable,
        // probeable, payload }. malleable = safe for INSTANT aged submits (no
        // signature anywhere that rewriting could break). probeable = worth
        // ONE backdate attempt (a 3-part JWT's detached signature segment may
        // or may not be verified — trying costs one bounce at most).
        try {
            const s = String(raw || '').trim();
            if (!s) return null;
            if (s.indexOf('.') > 0) {
                const parts = s.split('.');
                if (parts.length === 3) {
                    const payload = b64ToJson(parts[1]);
                    if (!payload) return null;
                    const a = analyzeDecodedObject(payload);
                    const probeable = a.timeKeys.length > 0;
                    return { kind: 'jwt', timeKeys: a.timeKeys, malleable: false, probeable, payload };
                }
                if (parts.length === 2) {
                    const payload = b64ToJson(parts[1]);
                    if (!payload) return null;
                    const a = analyzeDecodedObject(payload);
                    // No signature segment at all: whatever time is inside is trusted as-is.
                    const m = a.timeKeys.length > 0;
                    return { kind: 'jwt-unsigned', timeKeys: a.timeKeys, malleable: m, probeable: m, payload };
                }
            }
            const o = b64ToJson(s);
            if (!o) return null;
            const a = analyzeDecodedObject(o);
            const m = a.timeKeys.length > 0 && !a.signed;
            return { kind: 'b64json', timeKeys: a.timeKeys, malleable: m, probeable: m, payload: o };
        } catch (e) { return null; }
    }

    function inspectTokens() {
        if (pageTokens) return pageTokens;
        const found = [];
        const consider = (channel, name, raw) => {
            try {
                const r = analyzeTokenValue(raw);
                // NOTE: raw values are never stored — only shapes. Rewriting
                // re-reads the live DOM value at submit time.
                if (r) found.push({ channel, name: String(name).slice(0, 48), kind: r.kind, timeKeys: r.timeKeys, malleable: r.malleable, probeable: r.probeable });
            } catch (e) { /* ignore */ }
        };
        try {
            const params = new URLSearchParams(window.location.search);
            params.forEach((v, k) => {
                if (TOKEN_NAME_RE.test(k) || String(v).length > 24) consider('query', k, v);
            });
        } catch (e) { /* ignore */ }
        try {
            document.querySelectorAll('input[type="hidden"]').forEach(inp => {
                const n = (inp.name || inp.id || '').toLowerCase();
                const v = inp.value || '';
                if (!v) return;
                if (TOKEN_NAME_RE.test(n) || v.length > 24) consider('hidden', n || '(anon)', v);
            });
        } catch (e) { /* ignore */ }
        try {
            for (const store of [window.localStorage, window.sessionStorage]) {
                try {
                    for (let i = 0; i < store.length; i++) {
                        const k = store.key(i);
                        if (!k || !TOKEN_NAME_RE.test(k)) continue;
                        consider('storage', k, store.getItem(k));
                        if (found.length > 12) break;
                    }
                } catch (e) { /* per-store guard (blocked access) */ }
                if (found.length > 12) break;
            }
        } catch (e) { /* ignore */ }
        pageTokens = {
            tokens: found.slice(0, 12),
            malleableCount: found.filter(t => t.malleable).length,
            probeableCount: found.filter(t => t.probeable).length
        };
        try {
            if (found.length) {
                console.log('[KillURL] Token inspector: ' + found.map(t =>
                    t.channel + ':' + t.name + '(' + t.kind + (t.malleable ? ',AGEABLE' : (t.probeable ? ',probe-only' : ',fixed')) + ')'
                ).join(' '));
            }
        } catch (e) { /* ignore */ }
        return pageTokens;
    }

    // ===== TOKEN AGING (backdating) =====
    // Rewrites ONLY time-like fields inside an already-analyzed token value,
    // shifting them to targetMs (a moment in the past). Structure, nonces and
    // any signature segments pass through byte-identical. Returns the aged
    // value, or null if the value isn't an ageable token after all.
    function jsonToB64Url(obj) {
        try {
            const json = JSON.stringify(obj);
            const bin = String.fromCharCode(...new TextEncoder().encode(json));
            return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        } catch (e) { return null; }
    }
    function jsonToB64(obj) {
        try {
            const json = JSON.stringify(obj);
            const bin = String.fromCharCode(...new TextEncoder().encode(json));
            return btoa(bin);
        } catch (e) { return null; }
    }
    function scaleTimeValue(v, targetMs) {
        try {
            const scale = plausibleTime(v);
            if (scale === 'ms') return targetMs;
            if (scale === 's') return Math.floor(targetMs / 1000);
            return v;
        } catch (e) { return v; }
    }
    function ageTokenValue(raw, analysis, targetMs) {
        try {
            if (!analysis || !analysis.timeKeys || !analysis.timeKeys.length) return null;
            const aged = {};
            const setAged = (obj) => {
                const out = {};
                try {
                    for (const k of Object.keys(obj || {})) {
                        out[k] = analysis.timeKeys.includes(k) ? scaleTimeValue(obj[k], targetMs) : obj[k];
                    }
                } catch (e) { return null; }
                return out;
            };
            if (analysis.kind === 'b64json') {
                const o = b64ToJson(String(raw || '').trim());
                if (!o) return null;
                const out = setAged(o);
                return out ? jsonToB64(out) : null;
            }
            if (analysis.kind === 'jwt-unsigned' || analysis.kind === 'jwt') {
                const parts = String(raw || '').trim().split('.');
                if (parts.length < 2) return null;
                const o = b64ToJson(parts[1]);
                if (!o) return null;
                const out = setAged(o);
                const enc = jsonToB64Url(out);
                if (!enc) return null;
                parts[1] = enc;
                return parts.join('.');
            }
            return null;
        } catch (e) { return null; }
    }

    // Rewrite ageable hidden-input times inside ONE form, in place.
    // Returns the number of inputs aged. Fires input/change so page frameworks
    // (and the injector's own hooks) observe the new values.
    // allowProbeOnly=true also ages probe-only shapes (e.g. signed JWTs whose
    // detached signature may or may not verify) — used ONLY by the one-shot
    // probe, never by the steady-state malleable path.
    function ageFormTokens(form, targetMs, allowProbeOnly) {
        if (isCaptchaShortenerDomain() || isSecurityPage) return 0;
        let n = 0;
        try {
            form.querySelectorAll('input[type="hidden"], input[style*="display: none"], input[style*="display:none"]').forEach(inp => {
                try {
                    const name = (inp.name || inp.id || '').toLowerCase();
                    const val = (inp.value || '').trim();
                    // Direct countdown inputs zeroing
                    if (/^(timer|countdown|time_left|wait_time|remaining|seconds)$/i.test(name) && /^\d+$/.test(val)) {
                        inp.value = '0';
                        try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                        try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
                        n++;
                        return;
                    }
                    // Elapsed inputs to 60s
                    if (/^(elapsed|duration)$/i.test(name) && /^\d+$/.test(val)) {
                        inp.value = '60';
                        try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                        try { inp.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
                        n++;
                        return;
                    }
                    // Do NOT mutate authentic timestamps, signatures, or CSRF/security tokens
                } catch (e) { /* ignore */ }
            });
        } catch (e) { /* ignore */ }
        return n;
    }

    // ONE backdated probe submit for this page. Fires only when every cheaper
    // explanation is exhausted (enforced host, already bounced, not strict,
    // ageable token present). Reports PROBE_STARTED so the background scores
    // the outcome on the next page load (fresh step = malleable wins).
    function tryBackdateProbe(form, btn) {
        if (isCaptchaShortenerDomain() || isSecurityPage) return false;
        if (probeTried || hostStrict || !patientMode) return false;
        if (hostBounces < 2) return false;
        let n = 0;
        let ageMs = 0;
        try {
            const floor = (typeof enforcedRequired === 'number' && enforcedRequired > 0)
                ? enforcedRequired : ((advertisedWait || 30) + 2);
            ageMs = Date.now() - (floor + 10) * 1000;
            n = ageFormTokens(form, ageMs, true);
        } catch (e) { /* ignore */ }
        if (!n) return false;
        probeTried = true;
        // Cover JS-driven posts too: arm the injector's in-flight rewriter for
        // this page (TTL enforced injector-side). Also stash it for the
        // handshake re-broadcasts in case the injector loads late.
        pendingTimeRewrite = { targetMs: ageMs, ttlMs: 60000 };
        try {
            window.dispatchEvent(new CustomEvent('killurl-arm-time-rewrite', {
                detail: { targetMs: ageMs, ttlMs: 60000 }
            }));
        } catch (e) { /* ignore */ }
        try {
            chrome.runtime.sendMessage({
                type: 'PROBE_STARTED',
                host: window.location.hostname.replace(/^www\./, '').toLowerCase()
            });
        } catch (e) { /* ignore */ }
        console.log('[KillURL] Backdate probe fired (' + n + ' token field(s) aged) — scoring on next page');
        return true;
    }

    // Exactly-once submit ledger: one submit burns a single-use server nonce,
    // so re-submitting the SAME form while its response is still in flight
    // (autopilot + waiter + retries all firing) self-inflicts the rejection
    // loop. Same form may retry only after 20s with no navigation.
    const submittedFormSigs = new Map(); // sig -> timestamp
    function formSig(form, hiddenNames) {
        try {
            return ((form.getAttribute('action') || '').trim().toLowerCase() + '|' + hiddenNames).slice(0, 220);
        } catch (e) { return ''; }
    }

    // Collect candidate token forms once per call: all safety filters
    // (protected widgets, credential/payment/upload fields, CTA match,
    // click-safety, token markers, countdown/armed context) applied up front.
    // Returns [{ form, btn, sig }] — sig feeds the exactly-once ledger.
    function collectTokenForms() {
        const out = [];
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
                out.push({ form, btn, sig: formSig(form, hiddenNames) });
            }
        } catch (e) { /* ignore */ }
        return out;
    }

    function submitTokenFormIfReady() {
        if (!canAutoAct()) return false;
        if (isCaptchaShortenerDomain()) return false;
        // Unloading (navigation already won) — submitting now can only fork
        // a stray duplicate tab.
        if (unloading) return false;
        if (isCaptchaPending()) return false;
        // Inspector must run before the gate: the malleable fast-path inside
        // gateReady() needs pageTokens populated on the very first call.
        if (!pageTokens) { try { inspectTokens(); } catch (e) { /* ignore */ } }
        if (Date.now() - lastSubmitT < 5000) return false;
        let cands = [];
        try { cands = collectTokenForms(); } catch (e) { /* ignore */ }
        if (!cands.length) return false;
        // PROBE FIRST — before the deadline gate, because the whole point of
        // the probe is to skip the wait. One backdated shot per page; the
        // background scores it on the next load (fresh step = malleable wins).
        if (patientMode && !hostMalleable && !hostStrict && !probeTried && hostBounces >= 2) {
            for (const { form, btn, sig } of cands) {
                if (tryBackdateProbe(form, btn)) {
                    try {
                        if (sig) submittedFormSigs.set(sig, Date.now());
                        enforceSameTabTarget(form);
                        if (btn) enforceSameTabTarget(btn);
                        unloading = true;
                        suppressAutoPressUntil = Date.now() + 3000;
                        lastSubmitT = Date.now();
                        if (typeof form.requestSubmit === 'function') {
                            form.requestSubmit(btn);
                        } else {
                            btn.click();
                        }
                    } catch (e) { /* ignore */ }
                    return true;
                }
            }
        }
        // Deadline gate: early token posts are exactly what gets rejected into
        // a loop. Holds on enforced hosts until the server-valid instant.
        if (!gateReady()) return false;
        try {
            for (const { form, btn, sig } of cands) {
                // Exactly-once ledger: skip forms submitted <20s ago on this page.
                try {
                    const prev = sig ? submittedFormSigs.get(sig) : 0;
                    if (prev && Date.now() - prev < 20000) continue;
                    if (sig) submittedFormSigs.set(sig, Date.now());
                } catch (e) { /* ignore */ }
                // Age hidden time fields and zero countdowns before submitting
                try {
                    if (ageFormTokens(form, Date.now() - 60000, false) > 0) {
                        console.log('[KillURL] Submitting with aged token / zeroed timer…');
                    }
                } catch (e) { /* ignore */ }
                enforceSameTabTarget(form);
                if (btn) enforceSameTabTarget(btn);
                unloading = true;
                suppressAutoPressUntil = Date.now() + 3000;
                console.log('[KillURL] Auto-submitting token form...');
                lastSubmitT = Date.now();
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

    // Live-vs-frozen timer model. The old approach ("wait text present?" )
    // stalled forever on templates whose countdown sentence never updates
    // ("Please wait 21 seconds" frozen while a separate script enables the
    // button). Instead we trust MOVEMENT: hold only while a second-value is
    // actually ticking down. Frozen text for 12s+ = press.
    function parseCountdownSeconds(text) {
        try {
            const t = String(text || '').trim();
            if (!t) return null;
            // Ignore article metadata (reading times, publish timestamps, comments, dates)
            if (/min(?:ute)?s?\s*read|read\s*time|ago|comments?|posted|published|updated/i.test(t)) return null;
            let m = t.match(/^(-?\d{1,3})\s*(?:s|sec|seconds?)?$/i);
            if (m) return parseInt(m[1], 10);
            m = t.match(/(\d{1,3}):(\d{2})/);
            if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
            m = t.match(/(?:continue|proceed).{0,12}in\s*(\d+)/i);
            if (m) return parseInt(m[1], 10);
            const w = t.search(/please\s*wait|wait|remaining|left|countdown/i);
            if (w >= 0) {
                m = t.slice(w, w + 40).match(/\d+/);
                if (m) return parseInt(m[0], 10);
            }
            return null;
        } catch (e) { return null; }
    }

    // Current countdown value in whole seconds, or null when nothing
    // timer-shaped is on screen. ("Step 1 of 6" parses to null on purpose.)
    function readCountdownValue() {
        try {
            for (const selector of COUNTDOWN_SELECTORS) {
                let el = null;
                try { el = document.querySelector(selector); } catch (e) { continue; }
                if (el && isVisible(el)) {
                    const text = (el.textContent || '').trim();
                    if (text && text.length < 40) {
                        const v = parseCountdownSeconds(text);
                        if (v != null) return Math.max(0, v);
                    }
                }
            }

            // On paced shortener domains, captcha shorteners, or if CTA exists, do NOT fall back to searching bodyText,
            // which matches static marketing/instructional headings like "WAIT 10 SECONDS TO GET LINK"!
            if (isPacedDomain() || isCaptchaShortenerDomain() || hasPressableCTA()) return null;

            const bodyText = document.body?.innerText || '';
            const pats = [
                /please\s*wait[^\n]{0,40}/i,
                /\bwait\s+\d+[^\n]{0,30}/i,
                /\d+\s*seconds?\s*(remaining|left)[^\n]{0,20}/i,
                /(?:continue|proceed)[^\n]{0,12}in\s*\d+[^\n]{0,10}/i
            ];
            for (const p of pats) {
                const m = bodyText.match(p);
                if (m) {
                    const v = parseCountdownSeconds(m[0]);
                    if (v != null) return Math.max(0, v);
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function hasAnyWaitSignal() {
        try {
            for (const selector of COUNTDOWN_SELECTORS) {
                let el = null;
                try { el = document.querySelector(selector); } catch (e) { continue; }
                if (el && isVisible(el) && (el.textContent || '').trim()) return true;
            }
            const bodyText = document.body?.innerText || '';
            if (/please\s*wait|\bwait\s+\d+|\d+\s*seconds?\s*(remaining|left)|countdown/i.test(bodyText)) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    let countHistory = []; // {t, v|null} samples of the last seconds
    let everSawLiveCountdown = false;
    let firstSignalT = 0; // first sighting of anything timer-shaped (this page)
    let firstPositiveT = 0; // first sighting of a positive count (this page)
    function countdownIsLive() {
        try {
            const now = Date.now();
            const WINDOW = 12000;
            const v = readCountdownValue();
            const sig = v != null || hasAnyWaitSignal();
            countHistory.push({ t: now, v });
            countHistory = countHistory.filter(h => now - h.t < WINDOW);
            if (sig && !firstSignalT) firstSignalT = now;
            if (v != null && v > 0) {
                everSawLiveCountdown = true;
                if (!firstPositiveT) firstPositiveT = now;
            }
            if (v != null && v <= 0) return false; // reading zero = finished
            if (!sig) return false; // nothing timer-shaped here at all
            // Wait-signal but no digits (still rendering?): only hold briefly if NO CTA is ready.
            // If a pressable CTA is already visible and enabled, let it proceed!
            if (v == null) {
                if (hasPressableCTA()) return false;
                return (now - firstSignalT) < 3000;
            }
            for (let i = 1; i < countHistory.length; i++) {
                const a = countHistory[i - 1].v;
                const b = countHistory[i].v;
                if (a != null && b != null && a !== b) {
                    sawCountdownMove = true;
                    return true; // moved = alive
                }
            }
            // Static value: only "young" relative to its FIRST sighting, not a
            // sliding window (which would stay young forever under polling).
            return (now - firstPositiveT) < WINDOW;
        } catch (e) { return false; }
    }

    // A pressable call-to-action exists right now (visible, enabled, safe)?
    // Used by the waiter: no live timer + a CTA = press it.
    function hasPressableCTA() {
        try {
            const clickables = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]');
            for (const el of clickables) {
                try {
                    if (!isVisible(el) || el.disabled) continue;
                    if (!isSafeToClick(el)) continue;
                    const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                    if (matchesCTA(text, true)) return true;
                } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    // Patient skip: ZERO page interference. No reveal, no overlay removal, no
    // progress faking, no enabling disabled buttons — anti-bypass scripts watch
    // their gate elements for exactly those style/class/disabled mutations and
    // answer with a bounce to step 1 even when the wait was honored. The page
    // must open its own gate; we press the instant it legally opens.
    function executePatientSkip() {
        if (!isEnabled()) return;
        if (isProtectedSite || isFinalSite) return;
        if (isSecurityPage && !settings.aggressiveMode) return;
        console.log('[KillURL] Server timer mode — preparing clean advancement…');
        try { dismissInstructionModals({ aggressive: true }); } catch (e) { /* ignore */ }
        removeOverlays();
        patientScrollNudge();
        findDestinationUrl();

        // If a countdown is actively running, DO NOT dispatch force-skip or fake zero
        const rem = readCountdownValue();
        if ((rem != null && rem > 0) || countdownIsLive()) {
            console.log(`[KillURL] Server timer mode: countdown active (~${rem}s) — waiting for natural timer completion`);
            waitForNaturalCompletionThenAdvance();
            return;
        }

        revealHiddenElements();
        handleProgressBars();
        forceEnableButtons();
        forceCountdownTextToZero();

        // Age tokens on all forms immediately
        try {
            document.querySelectorAll('form').forEach(f => {
                ageFormTokens(f, Date.now() - 60000, false);
            });
        } catch (e) { /* ignore */ }

        waitForNaturalCompletionThenAdvance();
    }

    // "Scroll down to continue" templates only reveal the CTA after scrolling.
    // Programmatic smooth scrolling is indistinguishable from a reader, so
    // nudge gently (rate-limited) when the page asks for it.
    let lastScrollNudge = 0;
    function patientScrollNudge() {
        try {
            if (Date.now() - lastScrollNudge < 3500) return;
            const bodyText = document.body?.innerText || '';
            const scrollPrompt = /scroll\s*(down\s*)?to\s*(continue|get|see|view|unlock|start|proceed)/i.test(bodyText) ||
                /scroll\s*down/i.test(bodyText) ||
                /bottom\s*of\s*(the\s*)?page/i.test(bodyText);

            // Also nudge scroll if sitting near top of page and waiting for CTA/timer
            const needsScroll = scrollPrompt || (window.scrollY < 120 && (isShortenerPage || countdownDetected));
            if (!needsScroll) return;

            lastScrollNudge = Date.now();
            window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
            try { window.dispatchEvent(new Event('scroll')); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
    }

    let completionWaiter = null;
    let lastWaiterPress = 0;
    function waitForNaturalCompletionThenAdvance() {
        if (completionWaiter) return; // one waiter per page
        if (!isEnabled()) return;
        const startHref = window.location.href;
        const t0 = Date.now();
        console.log('[KillURL] Server timer bypass: holding brief settle, then advancing…');
        try { showPageHint('KillURL: bypassing countdown…'); } catch (e) { /* ignore */ }
        completionWaiter = setInterval(() => {
            try {
                if (!isEnabled() || unloading || window.location.href !== startHref || destinationUrl) {
                    clearInterval(completionWaiter);
                    completionWaiter = null;
                    return;
                }
                if (Date.now() - t0 > 8000) {
                    clearInterval(completionWaiter);
                    completionWaiter = null;
                    console.log('[KillURL] Server timer bypass: timeout reached (8s) — forcing click wave');
                    postDriveClickWave('timeout-fallback');
                    return;
                }
                findDestinationUrl();
                patientScrollNudge();
                try { dismissInstructionModals({ aggressive: true }); } catch (e) { /* ignore */ }
                try { handleAdGateOverlays(); } catch (e) { /* ignore */ }
                try {
                    const remMs = gateRemainingMs();
                    if (remMs > 0) {
                        updatePageHint('KillURL: auto-advancing in ~' + Math.ceil(remMs / 1000) + 's…');
                    }
                } catch (e) { /* ignore */ }
                if (gateReady() && hasPressableCTA() && autoPressAllowed() && !unloading) {
                    if (Date.now() - lastWaiterPress < 1000) return;
                    lastWaiterPress = Date.now();
                    clearInterval(completionWaiter);
                    completionWaiter = null;
                    console.log('[KillURL] Gate open — advancing now');
                    clickContinueButton();
                    submitTokenFormIfReady();
                    setTimeout(() => findDestinationUrl(), 400);
                }
            } catch (e) { /* ignore */ }
        }, 300);
    }

    // Autopilot: once armed (auto-skip engaged or user hit Skip), watch the DOM
    // for up to 60s and advance every chained step the moment its button/form
    // becomes available. This is what cracks multi-step templates hands-free.
    let autopilotArmed = false;
    let autopilotObserver = null;
    let autopilotTimer = null;

    function armAutopilot() {
        if (!isEnabled()) return;
        if (isCaptchaShortenerDomain()) return;
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
        if (isCaptchaShortenerDomain()) { disarmAutopilot(); return; }
        if (unloading) return;
        if (isProtectedSite || isFinalSite) { disarmAutopilot(); return; }
        // Deadline gate: hold clicks/submits until the server-valid instant.
        // (Timer theater was already killed instantly — only the crossing waits.)
        if (!gateReady()) {
            findDestinationUrl();
            try { dismissInstructionModals({ aggressive: !patientMode }); } catch (e) { /* ignore */ }
            try { handleAdGateOverlays(); } catch (e) { /* ignore */ }
            return;
        }
        // A new-tab press already happened recently: the chain advanced (or a
        // duplicate would open). Stay quiet; manual Skip bypasses this.
        if (!autoPressAllowed()) {
            findDestinationUrl();
            return;
        }
        const now = Date.now();
        if (now - lastAutopilotClick < 800) return; // max ~1 click/sec, human-like
        // Destination already found via fetch hook? Offer it and stop.
        if (destinationUrl) { disarmAutopilot(); return; }
        // Cosmetics are always safe (display-only, zero HTTP requests): kill
        // the timer display, reveal hidden CTAs, enable the button NOW — even
        // on enforced steps. Only the gate-crossing itself waits. This also
        // guarantees the final press always has something pressable.
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
        if (isErrorDestination(candidate)) {
            console.log('[KillURL] Rejected error/honeypot candidate as destination:', candidate.slice(0, 100));
            return false;
        }
        if (isValidDestination(candidate)) {
            const sites = window.KILLURL_SITES || (typeof globalThis !== 'undefined' ? globalThis.KILLURL_SITES : null);
            const candHost = sites ? sites.hostOfUrl(candidate) : '';

            // Intermediate shorteners are NOT final destinations!
            if (sites && sites.isShortener(candHost)) {
                return false;
            }

            const isFinalDest = sites ? sites.isFinal(candHost) : false;

            // Reject invalid/error URLs for final destinations (e.g. MediaFire error or keyless pages)
            if (isFinalDest && sites && sites.isErrorUrl(candidate)) {
                console.log('[KillURL] Rejected incomplete/invalid final destination URL:', candidate.slice(0, 100));
                return false;
            }

            if (destinationUrl !== candidate) {
                console.log('[KillURL] Destination found:' + (isFinalDest ? ' [FINAL DESTINATION]' : ''), candidate.slice(0, 120));
            }
            destinationUrl = candidate;
            try { chrome.runtime.sendMessage({ type: 'FOUND_DESTINATION', url: destinationUrl }); } catch (e) { /* */ }
            try { window.dispatchEvent(new CustomEvent('killurl-release-vars')); } catch (e) { /* */ }

            if (isFinalDest) {
                processCandidateDestination(candidate);
                return true;
            }
            return true;
        }
        return false;
    }

    function findDestinationUrl() {
        // On captcha shortener domains (vplink.in) and paced blog chains, destination harvesting
        // is strictly managed by startVplinkFinalController and startPacedStepController
        if (isCaptchaShortenerDomain() || isPacedDomain()) return;
        // If countdown is actively ticking, do not harvest premature destination links
        if (countdownIsLive()) return;

        // 1. Known selector patterns (check visible and ready elements only)
        const seen = new Set();
        for (const selector of DESTINATION_SELECTORS) {
            try {
                document.querySelectorAll(selector).forEach(el => {
                    if (seen.has(el)) return;
                    seen.add(el);
                    if (!isVisible(el) || el.disabled) return;
                    if (!isSafeToClick(el)) return;
                    const href = el.getAttribute('href') || el.dataset?.url || el.dataset?.href ||
                        el.dataset?.link || el.dataset?.redirect || el.dataset?.target;
                    if (href && !isErrorDestination(href) && setDestination(href)) return;
                });
                if (destinationUrl) return;
            } catch (e) { /* skip */ }
        }

        // 2. Text-based link scan (smart CTA matcher)
        const allLinks = document.querySelectorAll('a[href]');
        for (const link of allLinks) {
            if (!isVisible(link) || link.disabled) continue;
            if (!isSafeToClick(link)) continue;
            const href = link.getAttribute('href');
            if (!href || href === '#' || href.startsWith('javascript:')) continue;
            if (isErrorDestination(href)) continue;

            const text = ((link.textContent || '') + ' ' + (link.getAttribute('aria-label') || '')).trim();
            if (!text) continue;

            if (matchesCTA(text) && setDestination(href)) return;
        }

        // 3. Token-form actions carrying the next-step URL
        try {
            document.querySelectorAll('form[action]').forEach(form => {
                const action = form.getAttribute('action');
                if (action && action !== '#' && !isErrorDestination(action) && setDestination(action)) return;
            });
            if (destinationUrl) return;
        } catch (e) { /* ignore */ }

        // 4. onclick / data-* attributes anywhere
        try {
            document.querySelectorAll('[onclick], [data-url], [data-href], [data-link], [data-redirect], [data-target], [data-destination], [data-next]').forEach(el => {
                const onclick = el.getAttribute('onclick') || '';
                if (onclick) {
                    const m = onclick.match(/https?:\/\/[^'"()\s]+/i);
                    if (m && !isErrorDestination(m[0]) && setDestination(m[0])) return;
                }
                const d = el.dataset || {};
                for (const key of ['url', 'href', 'link', 'redirect', 'target', 'destination', 'next']) {
                    if (d[key] && !isErrorDestination(d[key]) && setDestination(d[key])) return;
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
                    if (url && url.startsWith('http') && !isErrorDestination(url) && setDestination(url)) return;
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
        if (isCaptchaShortenerDomain() || isCaptchaPending() || isSecurityPage) return;
        const rem = readCountdownValue();
        if (((rem != null && rem > 0) || countdownIsLive()) && !settings.aggressiveMode) return;
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
                enforceSameTabTarget(el);
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
        if (isCaptchaShortenerDomain() || isCaptchaPending() || isSecurityPage) return;
        const rem = readCountdownValue();
        if (((rem != null && rem > 0) || countdownIsLive()) && !settings.aggressiveMode) return;
        document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]').forEach(el => {
            const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
            if (!text) return;

            if (matchesCTA(text)) {
                if (isProtectedWidget(el)) return;
                enforceSameTabTarget(el);
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
                    if (urlMatch && urlMatch[1] && !isErrorDestination(urlMatch[1])) {
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
        if (isCaptchaShortenerDomain() || isCaptchaPending() || isSecurityPage) return;
        // Click-ads instruction modals + watch-ad gates first (they gate the
        // whole step; full interference allowed here — skip-flow context).
        try { dismissInstructionModals({ aggressive: true }); } catch (e) { /* ignore */ }
        try { handleAdGateOverlays({ aggressive: true }); } catch (e) { /* ignore */ }
        // Immediately eliminate deceptive ad overlays (e.g. bcsakhi's #adOverlay)
        try {
            const adOverlay = document.getElementById('adOverlay');
            if (adOverlay) adOverlay.remove();
            const gcont = document.getElementById('gcont');
            if (gcont && gcont.style.position !== 'static') gcont.style.position = 'static';
        } catch (e) { /* ignore */ }

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
                    if (el.id === 'gcont' || el.closest('#gcont')) return;
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

    // "Click ads, wait & come back" instruction modals (SweetAlert-style
    // overlays with a dimmed backdrop). These are NOT adblock walls — they
    // demand a ritual: click an ad image, wait ~15s, return for Get Link.
    // Text signatures in English + Hindi (as seen on earn-blog templates).
    const RITUAL_MODAL_PATTERNS = [
        /click\s*(image|ads?)\s*(&|and)?\s*wait/i,
        /wait\s*&\s*(back|come\s*back)/i,
        /click\s*ads\s*wait/i,
        /come\s*back.*(get\s*link|download)/i,
        /get\s*link\s*-\s*download/i,
        /फोटो पर क्लिक/i,
        /सेकंड रुकें/i,
        /वापस आएं/i,
        /LINK पाने/i,
    ];

    function matchesRitualText(text) {
        if (!text) return false;
        for (const p of RITUAL_MODAL_PATTERNS) {
            if (p.test(text)) return true;
        }
        return false;
    }

    // Is this element a modal close control? × glyphs always count; text/class
    // matches only count on non-navigating elements (never hijack a real link).
    function looksLikeClose(c) {
        try {
            if (!c || c.nodeType !== 1) return false;
            const label = ((c.textContent || '') + ' ' + (c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('alt') || '') + ' ' + (c.getAttribute('title') || '')).trim();
            const cls = ((c.className && c.className.baseVal !== undefined ? c.className.baseVal : c.className) || '').toString().toLowerCase();
            if (/^[×✕✖❌✗×]+$/.test(label)) return true;
            const href = (c.getAttribute && c.getAttribute('href')) || '';
            const isNavLink = /^https?:/i.test(href);
            if (/close|dismiss/.test(cls) && !isNavLink) return true;
            if (/^(close|dismiss|cancel)$/i.test(label) && !isNavLink) return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    // Find a modal's close control: inside it, then its parent, then siblings
    // (template X buttons often sit OUTSIDE the white box), then by screen
    // position near the modal's top-right corner.
    function findCloseControl(modalEl) {
        try {
            const scopes = [modalEl];
            try {
                const parent = modalEl.parentElement;
                if (parent && parent !== document.body && parent !== document.documentElement) {
                    scopes.push(parent);
                    for (const sib of parent.children) {
                        if (sib !== modalEl && !modalEl.contains(sib)) scopes.push(sib);
                    }
                }
            } catch (e) { /* ignore */ }
            for (const scope of scopes) {
                let found = null;
                try {
                    const controls = scope.querySelectorAll('button, a, [role="button"], span, div, i, img, svg');
                    for (const c of controls) {
                        if (c === modalEl) continue;
                        if (looksLikeClose(c) && !isProtectedWidget(c)) { found = c; break; }
                    }
                } catch (e) { /* ignore */ }
                if (found) return found;
            }
        } catch (e) { /* ignore */ }
        return findCloseByPosition(modalEl);
    }

    function findCloseByPosition(modalEl) {
        try {
            const r = modalEl.getBoundingClientRect?.();
            if (!r || r.width === 0 || r.height === 0) return null;
            const pts = [
                [r.right - 14, r.top - 28],
                [r.right + 6, r.top - 10],
                [r.right - 14, r.top - 8],
                [r.right - 44, r.top - 28]
            ];
            for (const [x, y] of pts) {
                if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
                let stack = [];
                try { stack = document.elementsFromPoint(x, y); } catch (e) { continue; }
                for (const s of stack) {
                    if (s === document.body || s === document.documentElement) break;
                    const label = ((s.textContent || '') + ' ' + (s.getAttribute?.('aria-label') || '')).trim();
                    if (/^[×✕✖❌✗×]+$/.test(label) && !isProtectedWidget(s)) return s;
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    let lastModalSweep = 0;
    let ritualClickDone = false;

    // Dismiss click-ads instruction modals. Modes:
    //  - xOnly (watcher/iframe/patient): press the modal's own X and clean up
    //    its backdrop — a pure user-equivalent action, DOM otherwise untouched.
    //  - aggressive (skip flows): additionally remove closeless modals.
    // Afterwards (non-xOnly), attempt the ritual click itself on a SAFE target
    // (new-tab or JS-handled — never a plain same-tab link, which would
    // navigate away from the step): inline handlers still run, so
    // cookie/timestamp unlocks get satisfied without opening ad tabs by hand.
    // Returns number of modals dismissed.
    function dismissInstructionModals(opts) {
        const aggressive = !!(opts && opts.aggressive) && !(opts && opts.xOnly);
        const xOnly = !!(opts && opts.xOnly);
        const force = !!(opts && opts.force);
        try {
            if (!isEnabled()) return 0;
            if (isProtectedSite || isFinalSite) return 0;
            // Explicit user clicks bypass the sweep throttle; background
            // sweeps stay throttled.
            if (!force && Date.now() - lastModalSweep < 3000) return 0;
            // Cheap pre-check: no ritual wording anywhere → nothing to do.
            const bodyText = document.body?.innerText || '';
            if (!matchesRitualText(bodyText)) return 0;
            lastModalSweep = Date.now();

            const seen = new Set();
            const candidates = [];
            const collect = (el) => {
                if (!el || el.nodeType !== 1 || seen.has(el)) return;
                seen.add(el);
                if (isProtectedWidget(el)) return;
                candidates.push(el);
            };
            try {
                document.querySelectorAll(
                    '.swal-modal, .swal-overlay, [role="dialog"], .modal, [class*="modal"], [id*="modal"], ' +
                    '[class*="popup"], [class*="swal"], [class*="overlay"], [class*="backdrop"], .popup, .overlay'
                ).forEach(collect);
            } catch (e) { /* ignore */ }
            // Fixed/absolute-position containers (catch-all for custom modals).
            try {
                document.querySelectorAll('div, section, aside').forEach(el => {
                    if (seen.has(el)) return;
                    let pos = '';
                    try { pos = window.getComputedStyle(el).position; } catch (e) { return; }
                    if ((pos === 'fixed' || pos === 'absolute' || pos === 'sticky') && (el.textContent || '').length > 0) collect(el);
                });
            } catch (e) { /* ignore */ }

            let dismissed = 0;
            for (const el of candidates) {
                let text = '';
                try { text = (el.innerText || el.textContent || '').slice(0, 600); } catch (e) { continue; }
                if (!matchesRitualText(text)) continue;

                // Capture ritual ad links BEFORE touching the modal.
                let ritualLinks = [];
                try {
                    ritualLinks = [...el.querySelectorAll('a[href]')].filter(a => {
                        const href = a.getAttribute('href') || '';
                        return href && href !== '#' && !href.startsWith('javascript:');
                    });
                } catch (e) { /* ignore */ }

                // 1. Press its own close control (exactly what the user does).
                let closed = false;
                try {
                    const closer = findCloseControl(el);
                    if (closer) {
                        // Routed through the guarded press: an ad-network × is
                        // often itself a new-tab opener.
                        try { dispatchFullClickSequence(closer); } catch (e) { /* ignore */ }
                        closed = true;
                    }
                } catch (e) { /* ignore */ }

                // 2. No close control: only remove in aggressive mode. In
                // patient/xOnly mode we leave the DOM untouched (anti-bypass
                // scripts watch for exactly these mutations).
                if (!closed && aggressive) {
                    try {
                        const stillThere = document.contains(el);
                        el.remove();
                        closed = stillThere;
                    } catch (e) { /* ignore */ }
                }
                if (!closed) continue;

                dismissed++;
                console.log('[KillURL] Dismissed click-ads instruction modal');
                // NOTE: the ritual click happens below, independent of close
                // success (a closeless modal's links are its only way forward).
            }

            // Ritual click: independent of whether anything closed. Pressing
            // the ad target in place is user-equivalent in every mode (no DOM
            // removal involved) — and for closeless modals it is the ONLY way
            // forward. Watcher/iframe sweeps (xOnly) skip it.
            if (!xOnly) {
                try {
                    // Re-collect: the modal above may have been removed already.
                    const links = [];
                    try {
                        document.querySelectorAll('.swal-modal a[href], [role="dialog"] a[href], .modal a[href]').forEach(a => {
                            const href = a.getAttribute('href') || '';
                            if (href && href !== '#' && !href.startsWith('javascript:') && !links.includes(a)) links.push(a);
                        });
                    } catch (e) { /* ignore */ }
                    if (links.length) attemptRitualClick(links);
                    else attemptRitualClick(null); // page-level image-link fallback inside
                } catch (e) { /* ignore */ }
            }

            if (dismissed > 0) {
                // Backdrops left behind by the dismissed modal(s).
                try {
                    document.querySelectorAll('.modal-backdrop, .swal-overlay, [class*="backdrop"], .fade.show').forEach(bd => {
                        try {
                            if (isProtectedWidget(bd)) return;
                            const t = (bd.textContent || '').trim();
                            if (t.length > 120) return; // real content, not a dim layer
                            bd.remove();
                        } catch (e) { /* ignore */ }
                    });
                } catch (e) { /* ignore */ }
                // Restore scrolling the modal may have locked.
                try {
                    document.body.style.setProperty('overflow', 'auto', 'important');
                    document.documentElement.style.setProperty('overflow', 'auto', 'important');
                    document.body.classList.remove('modal-open', 'no-scroll', 'swal-open', 'popup-open', 'overflow-hidden');
                    document.documentElement.classList.remove('modal-open', 'overflow-hidden');
                } catch (e) { /* ignore */ }
            }
            return dismissed;
        } catch (e) { return 0; }
    }

    // Perform the "click the ad image" half of the ritual WITHOUT opening ad
    // tabs by hand: a synthetic press still runs the page's inline handlers,
    // so cookie/timestamp unlocks get satisfied. Only SAFE targets: new-tab
    // links or JS-handled controls. Plain same-tab links are never touched
    // (clicking those would navigate away from the step = chain broken).
    function attemptRitualClick(modalLinks) {
        try {
            if (ritualClickDone) return false;
            if (!isEnabled()) return false;
            if (isProtectedSite || isFinalSite) return false;
            if (isSecurityPage && !settings.aggressiveMode) return false;

            const pool = [];
            (modalLinks || []).forEach(a => { if (a && document.contains(a)) pool.push(a); });
            // Page-level fallback: the ritual image usually lives in the post
            // (the modal itself is often text-only, as in the report).
            try {
                document.querySelectorAll('a[href] img').forEach(img => {
                    const a = img.closest('a[href]');
                    if (a && !pool.includes(a)) pool.push(a);
                });
            } catch (e) { /* ignore */ }

            for (const a of pool) {
                let href = '';
                try { href = a.getAttribute('href') || ''; } catch (e) { continue; }
                if (!href || href === '#') continue;
                const target = (a.getAttribute('target') || '').toLowerCase();
                const onclick = a.getAttribute('onclick') || '';
                const isJsHandled = !!onclick || href.startsWith('javascript:');
                const opensInNewTab = isNewTabTarget(target);
                // Skip plain same-tab navigations — chain-breaking risk.
                if (!opensInNewTab && !isJsHandled) continue;
                if (isProtectedWidget(a)) continue;
                try { a.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
                try { clearPointBlockers(a); } catch (e) { /* ignore */ }
                dispatchFullClickSequence(a);
                ritualClickDone = true;
                console.log('[KillURL] Ritual ad-click attempted (inline handlers run, no manual ad tab needed)');
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    // Standalone ritual/ad-gate watcher: independent of skip flows, autopilot
    // and waiter. Watches the DOM for click-ads instruction modals and
    // watch-ad gates appearing at ANY time — pressing their own X/Continue is
    // user-equivalent (never removal, never ad clicks here). The text
    // pre-checks mean it is a no-op on ordinary pages.
    let ritualWatcher = null;
    function watchRitualModals() {
        if (ritualWatcher) return;
        try {
            if (!document.documentElement) {
                // document_start race: retry once the DOM exists.
                document.addEventListener('DOMContentLoaded', () => {
                    try { watchRitualModals(); } catch (e) { /* ignore */ }
                    try { dismissInstructionModals({ aggressive: false, xOnly: true }); } catch (e) { /* ignore */ }
                    try { handleAdGateOverlays(); } catch (e) { /* ignore */ }
                }, { once: true });
                return;
            }
            ritualWatcher = new MutationObserver(() => {
                try { dismissInstructionModals({ aggressive: false, xOnly: true }); } catch (e) { /* ignore */ }
                try { handleAdGateOverlays(); } catch (e) { /* ignore */ }
            });
            ritualWatcher.observe(document.documentElement, { childList: true, subtree: true });
        } catch (e) { /* ignore */ }
    }

    // Always-on wall remover, tied to the "Auto-Remove Ad Walls" toggle. The
    // old implementation only fired 4 fixed timeouts after load and only knew
    // adblock wording — so late-appearing walls, ritual modals and ad-gates
    // sat forever while the toggle was ON. This watcher instead sweeps ALL
    // three wall species whenever the DOM changes (throttled), for as long as
    // the page lives. Text-gated throughout: a no-op on ordinary pages.
    let wallWatcher = null;
    let lastWallSweep = 0;
    // full=false (iframes): adblock-text walls only — no modal removal, no
    // ritual/ad-gate presses from inside a frame (a synthetic press there
    // could escape the frame via target=_top or window.top navigation).
    function sweepAllWalls(full) {
        if (!isEnabled()) return 0;
        if (isProtectedSite || isFinalSite) return 0;
        if (!settings.removeAdBlockWalls) return 0;
        if (Date.now() - lastWallSweep < 4000) return 0;
        lastWallSweep = Date.now();
        let n = 0;
        try { n += removeAdBlockWalls() || 0; } catch (e) { /* ignore */ }
        if (full === false) return n;
        try { n += dismissInstructionModals({ aggressive: true, force: true }) || 0; } catch (e) { /* ignore */ }
        try { n += handleAdGateOverlays({ aggressive: true, force: true }) || 0; } catch (e) { /* ignore */ }
        return n;
    }
    function watchAdBlockWalls(opts) {
        if (wallWatcher) return;
        const full = !(opts && opts.iframe);
        try {
            if (!document.documentElement) {
                document.addEventListener('DOMContentLoaded', () => {
                    try { watchAdBlockWalls(opts); } catch (e) { /* ignore */ }
                    try { sweepAllWalls(full); } catch (e) { /* ignore */ }
                }, { once: true });
                return;
            }
            console.log('[KillURL] Auto wall remover armed (adblock walls + ritual modals + ad gates)');
            wallWatcher = new MutationObserver(() => {
                try { sweepAllWalls(full); } catch (e) { /* ignore */ }
            });
            wallWatcher.observe(document.documentElement, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['style', 'class', 'hidden']
            });
            try { sweepAllWalls(full); } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
    }

    // "Watch an ad to unlock" gate overlays (a third species: neither a
    // countdown timer nor an adblock wall nor a click-ads modal). Signature:
    // a full-screen dim overlay demanding you watch an N-second ad, with its
    // own CONTINUE button. The right move is NOT removal — it's pressing
    // THEIR continue (the ritual action itself: starts their flow, sets their
    // cookies), then letting the normal engine take whatever unlocks.
    const AD_GATE_PATTERNS = [
        /watch\s*(a\s*)?(\d+\s*)?(second\s*)?ad/i,
        /unlock the link/i,
        /click\s*"continue"/i,
        /watch.*to\s*(unlock|access|continue)/i,
        /ad\s*ends\s*in/i,
        /(continue|begin|start)\s*after\s*(the\s*)?ad/i,
    ];

    function matchesAdGateText(text) {
        if (!text) return false;
        for (const p of AD_GATE_PATTERNS) {
            if (p.test(text)) return true;
        }
        return false;
    }

    // Parse "watch a 10-second ad" → 10. Feeds the deadline machinery
    // (advertisedWait) so enforced hosts hold the right floor.
    function parseAdGateDuration(text) {
        try {
            const m = String(text || '').match(/watch[^\n]{0,30}?(\d+)\s*-?\s*second/i) ||
                String(text || '').match(/(\d+)\s*-?\s*second[^\n]{0,20}?ad/i);
            if (m) {
                const v = parseInt(m[1], 10);
                if (v > 0 && v <= 300) return v;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    let lastAdGateSweep = 0;
    function handleAdGateOverlays(opts) {
        const aggressive = !!(opts && opts.aggressive);
        const force = !!(opts && opts.force);
        try {
            if (!isEnabled()) return 0;
            if (isProtectedSite || isFinalSite) return 0;
            if (isSecurityPage && !settings.aggressiveMode) return 0;
            if (!force && Date.now() - lastAdGateSweep < 5000) return 0;
            const bodyText = document.body?.innerText || '';
            if (!matchesAdGateText(bodyText)) return 0;
            lastAdGateSweep = Date.now();

            const seen = new Set();
            const candidates = [];
            const collect = (el) => {
                if (!el || el.nodeType !== 1 || seen.has(el)) return;
                seen.add(el);
                if (isProtectedWidget(el)) return;
                candidates.push(el);
            };
            // Known gate ids first (this report: #adOverlay camelCase).
            try {
                document.querySelectorAll('#adOverlay, [id*="adoverlay" i], [class*="adoverlay" i]').forEach(collect);
            } catch (e) { /* ignore */ }
            // Full-screen dim layers (the classic gate anatomy).
            try {
                document.querySelectorAll('div, section, aside').forEach(el => {
                    if (seen.has(el)) return;
                    let pos = '', w = 0, h = 0;
                    try {
                        const cs = window.getComputedStyle(el);
                        pos = cs.position;
                        w = parseFloat(cs.width) || el.offsetWidth || 0;
                        h = parseFloat(cs.height) || el.offsetHeight || 0;
                    } catch (e) { return; }
                    if ((pos === 'fixed' || pos === 'absolute') && w >= window.innerWidth * 0.8 && h >= window.innerHeight * 0.5) collect(el);
                });
            } catch (e) { /* ignore */ }

            let handled = 0;
            for (const el of candidates) {
                let text = '';
                try { text = (el.innerText || el.textContent || '').slice(0, 600); } catch (e) { continue; }
                if (!matchesAdGateText(text)) continue;

                // Feed the deadline machinery: "watch a 10-second ad" → 10.
                try {
                    const dur = parseAdGateDuration(text);
                    if (dur && (advertisedWait == null || dur > advertisedWait)) {
                        advertisedWait = dur;
                        console.log('[KillURL] Ad-gate duration parsed:', dur + 's');
                    }
                } catch (e) { /* ignore */ }

                // Find the gate's own action button and press it. The container
                // already qualified as an ad gate, so its CTA is the ritual.
                // Never press a plain same-tab anchor (that would navigate the
                // step away); buttons and new-tab/JS controls are safe.
                let pressed = false;
                try {
                    const btns = el.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]');
                    for (const b of btns) {
                        if (!isVisible(b) || b.disabled) continue;
                        if (isProtectedWidget(b)) continue;
                        if (!isSafeToClick(b)) continue;
                        if (b.tagName === 'A') {
                            const ahref = b.getAttribute('href') || '';
                            const atarget = (b.getAttribute('target') || '').toLowerCase();
                            const aonclick = b.getAttribute('onclick') || '';
                            if (/^https?:/i.test(ahref) && atarget !== '_blank' && !aonclick) continue;
                        }
                        const label = ((b.textContent || b.value || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
                        if (!/continue|watch|unlock|play|start|proceed|verify|get\s*link/i.test(label)) continue;
                        try { el.scrollIntoView?.(); } catch (e) { /* ignore */ }
                        try { clearPointBlockers(b); } catch (e) { /* ignore */ }
                        dispatchFullClickSequence(b);
                        pressed = true;
                        console.log('[KillURL] Ad-gate Continue pressed:', label.slice(0, 50));
                        break;
                    }
                } catch (e) { /* ignore */ }

                // Buttonless gate and nothing to press: remove only when the
                // caller allows DOM interference.
                if (!pressed && aggressive) {
                    try {
                        if (document.contains(el)) {
                            el.remove();
                            pressed = true;
                            console.log('[KillURL] Ad-gate overlay removed (no action button)');
                        }
                    } catch (e) { /* ignore */ }
                }
                if (pressed) handled++;
            }
            return handled;
        } catch (e) { return 0; }
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
    // Returns true only if the press actually fired (callers must not count
    // skipped presses against retry budgets, or loops stall doing nothing).
    function dispatchFullClickSequence(el) {
        try {
            if (unloading) return false;
            enforceSameTabTarget(el);
            if (!isSafeToClick(el)) return false;

            // Never re-press the SAME new-tab opener: each press opens a tab,
            // so a second press can only ever open a duplicate.
            if (opensNewTab(el)) {
                if (!blankPressFresh(el)) return false;
                noteNewTabPress(el);
            }
            const rect = el.getBoundingClientRect?.();
            const cx = rect ? rect.left + rect.width / 2 : 0;
            const cy = rect ? rect.top + rect.height / 2 : 0;
            const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: 1 };
            try { el.dispatchEvent(new PointerEvent('pointerover', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new PointerEvent('pointerenter', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            // A tiny mousemove before the press — templates that count
            // interaction signals expect at least one movement first.
            try { el.dispatchEvent(new MouseEvent('mousemove', { ...base, clientX: cx + 4, clientY: cy - 3, buttons: 0 })); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new PointerEvent('pointerdown', base)); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new MouseEvent('mousedown', base)); } catch (e) { /* ignore */ }
            try { el.focus?.(); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            try { el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 })); } catch (e) { /* ignore */ }
            el.click();
            suppressAutoPressUntil = Date.now() + 5000;
            return true;
        } catch (e) { /* ignore */ }
        return false;
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

    // Click a CTA with strict single-shot execution to prevent multi-tab cascades.
    function clickWhenReady(el, timeoutMs = 6000) {
        if (!el || !isSafeToClick(el) || unloading) return false;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }
        clearPointBlockers(el);
        const pageHref = window.location.href;
        let clicks = 0;
        const MAX_CLICKS = 1;
        let observer = null;
        let poller = null;
        const cleanup = () => {
            if (poller) { clearInterval(poller); poller = null; }
            if (observer) { observer.disconnect(); observer = null; }
        };
        const doClick = () => {
            if (!isEnabled() || unloading) { cleanup(); return; }
            if (clicks >= MAX_CLICKS) { cleanup(); return; }
            if (!document.contains(el)) { cleanup(); return; }
            if (!isSafeToClick(el)) return;
            if (opensNewTab(el) && !autoPressAllowed()) return;
            if (dispatchFullClickSequence(el)) {
                clicks++;
                cleanup();
            } else {
                clearPointBlockers(el);
            }
        };
        doClick();
        if (clicks >= MAX_CLICKS) return true;
        try {
            observer = new MutationObserver(() => {
                if (clicks >= MAX_CLICKS || unloading) { cleanup(); return; }
                setTimeout(doClick, 150);
            });
            observer.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
            poller = setInterval(() => {
                if (!isEnabled() || unloading || clicks >= MAX_CLICKS || destinationUrl || window.location.href !== pageHref) {
                    cleanup();
                    return;
                }
                doClick();
                findDestinationUrl();
            }, 700);
            setTimeout(() => {
                cleanup();
                if (isEnabled() && !unloading && window.location.href === pageHref && !destinationUrl && clicks === 0) {
                    showPageHint('KillURL: timer skipped — click Continue once yourself to proceed');
                }
            }, timeoutMs);
        } catch (e) { /* ignore */ }
        return true;
    }

    // ===== SMART PROCESS BAR & PACED STEP CONTROLLER =====

    function ensureSmartBarStyles() {
        if (document.getElementById('killurl-smart-styles')) return;
        const style = document.createElement('style');
        style.id = 'killurl-smart-styles';
        style.textContent = `
            #killurl-smart-bar {
                position: fixed !important;
                bottom: 24px !important;
                left: 50% !important;
                transform: translateX(-50%) !important;
                background: rgba(15, 23, 42, 0.94) !important;
                backdrop-filter: blur(16px) !important;
                -webkit-backdrop-filter: blur(16px) !important;
                border: 1px solid rgba(56, 189, 248, 0.35) !important;
                box-shadow: 0 10px 32px rgba(0, 0, 0, 0.65), 0 0 20px rgba(56, 189, 248, 0.25) !important;
                border-radius: 9999px !important;
                padding: 8px 18px !important;
                display: flex !important;
                align-items: center !important;
                gap: 12px !important;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
                font-size: 13px !important;
                color: #f1f5f9 !important;
                z-index: 2147483647 !important;
                user-select: none !important;
                pointer-events: auto !important;
                cursor: default !important;
                transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease, border-color 0.2s ease !important;
                line-height: 1.4 !important;
                overflow: hidden !important;
                max-width: 94vw !important;
            }
            #killurl-smart-bar:hover {
                transform: translateX(-50%) scale(1.015) !important;
                box-shadow: 0 12px 36px rgba(0, 0, 0, 0.75), 0 0 28px rgba(56, 189, 248, 0.35) !important;
            }
            #killurl-smart-bar.ku-success {
                border-color: rgba(34, 197, 94, 0.6) !important;
                box-shadow: 0 10px 32px rgba(0, 0, 0, 0.75), 0 0 25px rgba(34, 197, 94, 0.4) !important;
            }
            .ku-icon-wrap {
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                width: 24px !important;
                height: 24px !important;
                border-radius: 50% !important;
                background: rgba(56, 189, 248, 0.18) !important;
                box-shadow: 0 0 10px rgba(56, 189, 248, 0.3) !important;
                font-size: 13px !important;
                flex-shrink: 0 !important;
                animation: ku-pulse 2s infinite ease-in-out !important;
            }
            @keyframes ku-pulse {
                0%, 100% { transform: scale(1); opacity: 1; }
                50% { transform: scale(1.15); opacity: 0.85; }
            }
            .ku-step-pill {
                background: rgba(56, 189, 248, 0.18) !important;
                color: #38bdf8 !important;
                border: 1px solid rgba(56, 189, 248, 0.35) !important;
                font-size: 10.5px !important;
                font-weight: 700 !important;
                letter-spacing: 0.6px !important;
                text-transform: uppercase !important;
                padding: 3px 8px !important;
                border-radius: 6px !important;
                white-space: nowrap !important;
                flex-shrink: 0 !important;
            }
            #killurl-smart-bar.ku-success .ku-step-pill {
                background: rgba(34, 197, 94, 0.2) !important;
                color: #4ade80 !important;
                border-color: rgba(34, 197, 94, 0.4) !important;
            }
            .ku-info-col {
                display: flex !important;
                flex-direction: column !important;
                gap: 1px !important;
                min-width: 0 !important;
                flex-shrink: 1 !important;
            }
            .ku-msg-text {
                color: #f8fafc !important;
                font-weight: 600 !important;
                font-size: 12.5px !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
            }
            .ku-telemetry-text {
                color: #94a3b8 !important;
                font-weight: 500 !important;
                font-size: 10px !important;
                white-space: nowrap !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                letter-spacing: 0.2px !important;
                display: flex !important;
                align-items: center !important;
                gap: 4px !important;
            }
            .ku-progress-cluster {
                display: flex !important;
                align-items: center !important;
                gap: 7px !important;
                flex-shrink: 0 !important;
            }
            .ku-progress-track {
                width: 80px !important;
                height: 6px !important;
                background: rgba(255, 255, 255, 0.12) !important;
                border: 1px solid rgba(255, 255, 255, 0.12) !important;
                border-radius: 9999px !important;
                overflow: hidden !important;
                position: relative !important;
            }
            .ku-progress-fill {
                height: 100% !important;
                background: linear-gradient(90deg, #38bdf8, #818cf8, #34d399) !important;
                border-radius: 9999px !important;
                transition: width 0.12s linear !important;
                box-shadow: 0 0 8px rgba(56, 189, 248, 0.6) !important;
            }
            .ku-pct-badge {
                font-size: 10.5px !important;
                font-weight: 700 !important;
                color: #cbd5e1 !important;
                font-variant-numeric: tabular-nums !important;
                min-width: 28px !important;
                text-align: right !important;
            }
            .ku-timer-pill {
                background: rgba(245, 158, 11, 0.18) !important;
                color: #fbbf24 !important;
                border: 1px solid rgba(245, 158, 11, 0.4) !important;
                font-size: 11px !important;
                font-weight: 700 !important;
                font-variant-numeric: tabular-nums !important;
                padding: 3px 9px !important;
                border-radius: 9999px !important;
                white-space: nowrap !important;
                flex-shrink: 0 !important;
                transition: all 0.2s ease !important;
                box-shadow: 0 0 10px rgba(245, 158, 11, 0.2) !important;
            }
            .ku-timer-pill.ready {
                background: rgba(34, 197, 94, 0.22) !important;
                color: #4ade80 !important;
                border-color: rgba(34, 197, 94, 0.5) !important;
                box-shadow: 0 0 12px rgba(34, 197, 94, 0.4) !important;
            }
            .ku-dest-btn {
                background: linear-gradient(135deg, #10b981, #059669) !important;
                color: #ffffff !important;
                font-size: 12px !important;
                font-weight: 700 !important;
                padding: 4px 14px !important;
                border-radius: 9999px !important;
                text-decoration: none !important;
                display: inline-flex !important;
                align-items: center !important;
                gap: 5px !important;
                box-shadow: 0 0 14px rgba(16, 185, 129, 0.6) !important;
                cursor: pointer !important;
                transition: transform 0.15s ease, box-shadow 0.15s ease !important;
                white-space: nowrap !important;
                flex-shrink: 0 !important;
            }
            .ku-dest-btn:hover {
                transform: scale(1.05) !important;
                box-shadow: 0 0 20px rgba(16, 185, 129, 0.9) !important;
                color: #ffffff !important;
            }
            .ku-url-pill {
                background: rgba(255, 255, 255, 0.08) !important;
                color: #94a3b8 !important;
                border: 1px solid rgba(255, 255, 255, 0.18) !important;
                font-size: 11px !important;
                padding: 3px 9px !important;
                border-radius: 6px !important;
                cursor: pointer !important;
                max-width: 220px !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
                transition: all 0.2s ease !important;
                flex-shrink: 1 !important;
            }
            .ku-url-pill:hover {
                background: rgba(255, 255, 255, 0.15) !important;
                color: #f1f5f9 !important;
                border-color: rgba(56, 189, 248, 0.45) !important;
            }
            .ku-dest-btn.ku-dead-btn {
                background: linear-gradient(135deg, #f59e0b, #d97706) !important;
                box-shadow: 0 0 10px rgba(245, 158, 11, 0.4) !important;
            }
            .ku-dest-btn.ku-dead-btn:hover {
                box-shadow: 0 0 16px rgba(245, 158, 11, 0.7) !important;
            }
            #killurl-smart-bar.ku-warning-bar {
                border-color: rgba(245, 158, 11, 0.4) !important;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 20px rgba(245, 158, 11, 0.25) !important;
            }
            .ku-progress-line {
                position: absolute !important;
                bottom: 0 !important;
                left: 0 !important;
                height: 3px !important;
                background: linear-gradient(90deg, #38bdf8, #818cf8, #34d399) !important;
                box-shadow: 0 0 8px rgba(56, 189, 248, 0.7) !important;
                transition: width 0.12s linear !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function renderSmartBar({ step, message, telemetry, remaining, total, progressPct, icon, isReady, destinationUrl, buttonText, noAutoRedirect }) {
        try {
            ensureSmartBarStyles();
            let bar = document.getElementById('killurl-smart-bar');
            if (!bar || !bar.querySelector('.ku-telemetry-text')) {
                if (!bar) {
                    bar = document.createElement('div');
                    bar.id = 'killurl-smart-bar';
                    document.documentElement.appendChild(bar);
                }
                bar.innerHTML = `
                    <div class="ku-icon-wrap"><span class="ku-icon">⚡</span></div>
                    <div class="ku-step-pill">KILLURL</div>
                    <div class="ku-info-col">
                        <div class="ku-msg-text">Processing...</div>
                        <div class="ku-telemetry-text" style="display: none;"></div>
                    </div>
                    <div class="ku-progress-cluster" style="display: none;">
                        <div class="ku-progress-track">
                            <div class="ku-progress-fill" style="width: 0%;"></div>
                        </div>
                        <span class="ku-pct-badge">0%</span>
                    </div>
                    <div class="ku-timer-pill" style="display: none;"></div>
                    <div class="ku-progress-line" style="width: 0%;"></div>
                `;
            }

            const iconEl = bar.querySelector('.ku-icon');
            const stepEl = bar.querySelector('.ku-step-pill');
            const msgEl = bar.querySelector('.ku-msg-text');
            const telemEl = bar.querySelector('.ku-telemetry-text');
            const timerEl = bar.querySelector('.ku-timer-pill');
            const progClusterEl = bar.querySelector('.ku-progress-cluster');
            const progFillEl = bar.querySelector('.ku-progress-fill');
            const pctBadgeEl = bar.querySelector('.ku-pct-badge');
            const progLineEl = bar.querySelector('.ku-progress-line');

            if (iconEl) iconEl.textContent = icon || '⚡';
            if (stepEl) stepEl.textContent = step || 'KILLURL';
            if (msgEl) msgEl.textContent = message || '';

            if (telemEl) {
                if (telemetry) {
                    telemEl.textContent = telemetry;
                    telemEl.style.display = 'flex';
                } else {
                    telemEl.style.display = 'none';
                }
            }

            if (destinationUrl) {
                bar.classList.add('ku-success');
                if (noAutoRedirect) {
                    bar.classList.add('ku-warning-bar');
                } else {
                    bar.classList.remove('ku-warning-bar');
                }
                let destEl = bar.querySelector('.ku-dest-btn');
                if (!destEl) {
                    destEl = document.createElement('a');
                    destEl.className = 'ku-dest-btn';
                    destEl.target = '_blank';
                    destEl.rel = 'noopener noreferrer';
                    destEl.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        unloading = true;
                        window.location.href = destEl.href;
                    });
                    bar.appendChild(destEl);
                }
                destEl.href = destinationUrl;
                destEl.textContent = buttonText || (destinationUrl.includes('mediafire.com') ? '⬇️ Download File (MediaFire)' : '⬇️ Open Download');
                if (noAutoRedirect) {
                    destEl.classList.add('ku-dead-btn');
                } else {
                    destEl.classList.remove('ku-dead-btn');
                }
                destEl.style.display = 'inline-flex';

                let urlPill = bar.querySelector('.ku-url-pill');
                if (!urlPill) {
                    urlPill = document.createElement('span');
                    urlPill.className = 'ku-url-pill';
                    urlPill.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        try {
                            navigator.clipboard.writeText(destinationUrl).then(() => {
                                const orig = urlPill.textContent;
                                urlPill.textContent = 'Copied to clipboard! ✓';
                                setTimeout(() => { urlPill.textContent = orig; }, 1500);
                            }).catch(() => {});
                        } catch (e) {}
                    });
                    bar.appendChild(urlPill);
                }
                urlPill.textContent = destinationUrl;
                urlPill.title = 'Click to copy: ' + destinationUrl;
                urlPill.style.display = 'inline-block';
            }

            if (timerEl) {
                if (typeof remaining === 'number') {
                    timerEl.textContent = (destinationUrl && !noAutoRedirect)
                        ? `Auto-redirect in ${Math.max(0, remaining)}s`
                        : `⏱️ ${Math.max(0, remaining)}s`;
                    timerEl.classList.toggle('ready', remaining <= 0);
                    timerEl.style.display = 'inline-block';
                } else if (remaining) {
                    timerEl.textContent = remaining;
                    timerEl.classList.remove('ready');
                    timerEl.style.display = 'inline-block';
                } else if (isReady) {
                    timerEl.textContent = '🚀 Ready!';
                    timerEl.classList.add('ready');
                    timerEl.style.display = 'inline-block';
                } else {
                    timerEl.style.display = 'none';
                }
            }

            let pct = null;
            if (typeof progressPct === 'number') {
                pct = Math.max(0, Math.min(100, progressPct));
            } else if (typeof remaining === 'number' && typeof total === 'number' && total > 0) {
                pct = Math.max(0, Math.min(100, ((total - remaining) / total) * 100));
            } else if (destinationUrl || isReady) {
                pct = 100;
            }

            if (progClusterEl) {
                if (pct !== null) {
                    progClusterEl.style.display = 'flex';
                    if (progFillEl) progFillEl.style.width = pct.toFixed(1) + '%';
                    if (pctBadgeEl) pctBadgeEl.textContent = Math.round(pct) + '%';
                } else {
                    progClusterEl.style.display = 'none';
                }
            }

            if (progLineEl) {
                if (pct !== null) {
                    progLineEl.style.width = pct.toFixed(1) + '%';
                    progLineEl.style.display = 'block';
                } else {
                    progLineEl.style.display = 'none';
                }
            }

            if (bar._kuT) clearTimeout(bar._kuT);
            bar._kuT = setTimeout(() => {
                try { bar.remove(); } catch (e) { /* ignore */ }
            }, 30000);
        } catch (e) { /* ignore */ }
    }

    let destCountdownActive = false;
    let destCountdownInterval = null;
    let verifyingUrl = null;

    function handleAuthenticDestinationCaptured(url) {
        if (destCountdownActive) return;
        destCountdownActive = true;
        destinationUrl = url;

        try { chrome.runtime.sendMessage({ type: 'FOUND_DESTINATION', url: destinationUrl }); } catch (err) { /* */ }

        const totalSeconds = 20;
        const startT = Date.now();

        const updateBar = () => {
            const elapsed = (Date.now() - startT) / 1000;
            const remaining = Math.max(0, Math.ceil(totalSeconds - elapsed));
            const pct = Math.min(100, Math.max(0, (elapsed / totalSeconds) * 100));

            renderSmartBar({
                step: url.includes('mediafire.com') ? 'MEDIAFIRE READY' : 'DOWNLOAD READY',
                message: 'Authentic download link unlocked!',
                telemetry: '✅ Authentic Link Verified • 🛡️ Decoy Error 320 Filtered',
                icon: '🎉',
                isReady: true,
                destinationUrl: url,
                remaining: remaining,
                total: totalSeconds,
                progressPct: pct,
                buttonText: url.includes('mediafire.com') ? '⬇️ Download File (MediaFire)' : '⬇️ Open Download'
            });
        };

        updateBar();

        if (destCountdownInterval) clearInterval(destCountdownInterval);
        destCountdownInterval = setInterval(() => {
            const elapsed = (Date.now() - startT) / 1000;
            if (elapsed >= totalSeconds) {
                clearInterval(destCountdownInterval);
                destCountdownInterval = null;
                if (settings.autoRedirect !== false && !unloading) {
                    unloading = true;
                    window.location.href = url;
                }
            } else {
                updateBar();
            }
        }, 150);
    }

    function handleDeadDestinationCaptured(url, reason) {
        if (destCountdownActive) return;
        destCountdownActive = true;
        destinationUrl = url;

        let secondsRemaining = 20;
        const totalSeconds = 20;
        const is320 = reason === 'file_deleted_320' || (typeof url === 'string' && (url.includes('320') || url.includes('error.php')));

        const updateBar = () => {
            renderSmartBar({
                step: is320 ? 'FILE DELETED (320)' : 'DEAD LINK (404)',
                message: is320
                    ? '⚠️ MediaFire Error 320: File deleted by uploader. Auto-redirect blocked.'
                    : '⚠️ Destination file expired or missing on server. Auto-redirect blocked.',
                icon: '⚠️',
                isReady: false,
                destinationUrl: url,
                noAutoRedirect: true,
                remaining: secondsRemaining,
                total: totalSeconds,
                buttonText: is320 ? 'Open MediaFire Anyway' : 'Open Link Anyway'
            });
        };

        updateBar();

        if (destCountdownInterval) clearInterval(destCountdownInterval);
        destCountdownInterval = setInterval(() => {
            secondsRemaining--;
            if (secondsRemaining <= 0) {
                clearInterval(destCountdownInterval);
                destCountdownInterval = null;
                // Never auto-redirect to a dead link! Keep the bar visible with the link pill copyable.
            } else {
                updateBar();
            }
        }, 1000);
    }

    function processCandidateDestination(rawUrl) {
        if (!rawUrl) return;
        const url = rawUrl.trim();
        if (!url || url.includes('javascript:') || destCountdownActive) return;

        // 1. Synchronous check: reject known error destination patterns (honeypots, error pages, dead suffixes)
        if (isErrorDestination(url)) {
            console.log('[KillURL] Candidate URL is an error/honeypot destination, rejected from capture:', url);
            // Never capture error/decoy links — user requested: do not capture if error!
            return;
        }

        if (verifyingUrl === url) return;
        verifyingUrl = url;

        // 2. Pre-flight health check via background service worker
        renderSmartBar({
            step: 'VERIFYING FILE',
            message: 'Verifying file authenticity on server...',
            icon: '🔍',
            isReady: false
        });

        try {
            chrome.runtime.sendMessage({ type: 'CHECK_URL_HEALTH', url }, (res) => {
                verifyingUrl = null;
                if (chrome.runtime.lastError || !res) {
                    handleAuthenticDestinationCaptured(url);
                    return;
                }

                if (res.valid === false) {
                    console.log('[KillURL] Destination health check failed (error/dead file):', res);
                    // Do not capture dead/corrupted links
                    return;
                }

                // Authentic alive link confirmed!
                const liveUrl = res.finalUrl || url;
                handleAuthenticDestinationCaptured(liveUrl);
            });
        } catch (e) {
            verifyingUrl = null;
            handleAuthenticDestinationCaptured(url);
        }
    }

    function showPageHint(text) {
        updatePageHint(text);
    }

    function updatePageHint(text) {
        if (!text) return;
        renderSmartBar({
            step: 'KILLURL',
            message: text,
            icon: '⚡'
        });
    }

    function isCategoryArchivePage() {
        // If single-article verification / timer element is already in DOM, it is definitely a post, not an archive
        if (document.getElementById('btn6') ||
            document.getElementById('btn7') ||
            document.getElementById('btn1') ||
            document.getElementById('ce-time') ||
            document.getElementById('ce-wait1') ||
            document.getElementById('tp-snp') ||
            document.getElementById('tp-snp2') ||
            document.getElementById('cross-snp') ||
            document.getElementById('cross-snp2') ||
            document.getElementById('startCountdownBtn') ||
            document.querySelector('.start-countdown, .button-61, button#btn6, button#btn7, button#btn1')) {
            return false;
        }

        // Check WordPress archive body classes
        const bClass = document.body?.className || '';
        if (/\b(archive|category|blog|home|search-results)\b/i.test(bClass)) {
            return true;
        }

        // Check path: if root, category slug without sub-post slug (e.g. /studyeducates/ or /studyinsurances/)
        const path = window.location.pathname.toLowerCase().replace(/\/+$/, '');
        const segments = path.split('/').filter(Boolean);
        if (segments.length <= 1) {
            // Check if there are article headings in DOM
            const headings = document.querySelectorAll('article h2 a, h2.entry-title a, .entry-title a, h2.post-title a, .post-title a');
            if (headings.length > 0) return true;
        }
        if (segments.length > 0 && (segments[0] === 'category' || segments[0] === 'tag' || segments[0] === 'author')) {
            return true;
        }

        return false;
    }

    function findArticlePostLink() {
        const currentHost = window.location.hostname.replace(/^www\./, '').toLowerCase();
        const currentPath = window.location.pathname.toLowerCase().replace(/\/+$/, '');
        const segments = currentPath.split('/').filter(Boolean);
        const catSlug = segments[0] || '';

        const selectors = [
            'h2.entry-title a',
            'article h2 a',
            '.entry-title a',
            'h2.post-title a',
            '.post-title a',
            'main article a[href]',
            'article a[href]'
        ];

        // 1. Heading links
        for (const sel of selectors) {
            const links = Array.from(document.querySelectorAll(sel));
            for (const a of links) {
                const raw = (a.getAttribute('href') || a.href || '').trim();
                if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) continue;
                try {
                    const u = new URL(raw, window.location.href);
                    const uHost = u.hostname.replace(/^www\./, '').toLowerCase();
                    const uPath = u.pathname.toLowerCase().replace(/\/+$/, '');
                    if (uHost === currentHost && uPath !== currentPath) {
                        if (!catSlug || uPath.includes(catSlug) || uPath.split('/').filter(Boolean).length >= 2) {
                            return u.href;
                        }
                    }
                } catch (e) {}
            }
        }

        // 2. Category links with slug
        if (catSlug) {
            const links = Array.from(document.querySelectorAll(`a[href*="/${catSlug}/"]`));
            for (const a of links) {
                const raw = (a.getAttribute('href') || a.href || '').trim();
                try {
                    const u = new URL(raw, window.location.href);
                    const uHost = u.hostname.replace(/^www\./, '').toLowerCase();
                    const uPath = u.pathname.toLowerCase().replace(/\/+$/, '');
                    if (uHost === currentHost && uPath !== currentPath && uPath.length > currentPath.length + 3) {
                        return u.href;
                    }
                } catch (e) {}
            }
        }

        // 3. Any article link on same host
        const allLinks = Array.from(document.querySelectorAll('a[href]'));
        for (const a of allLinks) {
            const raw = (a.getAttribute('href') || a.href || '').trim();
            if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) continue;
            try {
                const u = new URL(raw, window.location.href);
                const uHost = u.hostname.replace(/^www\./, '').toLowerCase();
                const uPath = u.pathname.toLowerCase().replace(/\/+$/, '');
                const parts = uPath.split('/').filter(Boolean);
                if (uHost === currentHost && parts.length >= 1 && uPath !== currentPath) {
                    if (!['privacy-policy', 'terms', 'contact', 'about', 'disclaimer'].some(x => uPath.includes(x))) {
                        return u.href;
                    }
                }
            } catch (e) {}
        }
        return null;
    }

    let pacedControllerStarted = false;
    let pacedAdvanceExecuted = false;

    async function startPacedStepController() {
        if (!isEnabled()) return;
        if (!isPacedDomain()) return;
        if (pacedControllerStarted) return;

        const host = window.location.hostname.replace(/^www\./, '').toLowerCase();
        const path = window.location.pathname.toLowerCase();
        const search = window.location.search || '';

        // 1. Gateway redirect query pages (e.g. ?insurancesstudy=, ?educationsuniversities=)
        if (search.includes('insurancesstudy=') || search.includes('educationsuniversities=') || search.includes('educationstudies=')) {
            console.log('[KillURL] Gateway redirect query page detected — monitoring auto-hop');
            renderSmartBar({
                step: `GATEWAY TRANSIT (${host})`,
                message: 'Routing through secure transit gateway...',
                telemetry: '⚡ Instant Transit Hop • Auto-Navigating to Article',
                remaining: 0,
                total: 1,
                progressPct: 100,
                icon: '⚡',
                isReady: true
            });
            setTimeout(() => {
                if (window.location.search.includes('insurancesstudy=') || window.location.search.includes('educationsuniversities=') || window.location.search.includes('educationstudies=')) {
                    const fallbackPost = findArticlePostLink();
                    if (fallbackPost) {
                        console.log('[KillURL] Gateway auto-navigating to article post:', fallbackPost);
                        window.location.href = fallbackPost;
                    }
                }
            }, 350);
            return;
        }

        // 2. Category Archive / Post Listing Hop
        if (isCategoryArchivePage()) {
            const articleLink = findArticlePostLink();
            if (articleLink) {
                console.log('[KillURL] Category Archive detected — auto-hopping into post:', articleLink);
                renderSmartBar({
                    step: `ROUTING ARTICLE (${host})`,
                    message: 'Category listing detected • Entering blog post article...',
                    telemetry: '⚡ Category Archive Detected • Auto-Navigating to Single Post',
                    remaining: 0,
                    total: 1,
                    progressPct: 100,
                    icon: '⚡',
                    isReady: true
                });
                setTimeout(() => {
                    window.location.href = articleLink;
                }, 150);
                setTimeout(() => {
                    if (isCategoryArchivePage()) {
                        console.log('[KillURL] Category hop watchdog navigating to:', articleLink);
                        window.location.href = articleLink;
                    }
                }, 1500);
                return;
            }
        }

        pacedControllerStarted = true;
        console.log('[KillURL] Paced Step Controller initialized on:', window.location.href);

        const qSearch = search.toLowerCase();

        // 1. Precise Step 2 Detection (Article 2 of 3)
        // Signals: presence of btn6/btn7/ce-wait1/ce-time, nextbtn(), studyeducates path or host, or query signals
        const hasStep2Signals = qSearch.includes('educationsuniversities') ||
                                path.includes('studyeducates') ||
                                host.includes('studyeducates') ||
                                !!document.getElementById('btn6') ||
                                !!document.getElementById('btn7') ||
                                !!document.getElementById('ce-wait1') ||
                                !!document.getElementById('ce-time') ||
                                (document.documentElement && document.documentElement.innerHTML.includes('nextbtn()'));

        // 2. Precise Step 3 Detection (Final Article 3 of 3)
        // Signals: bcsakhi host, educatestudies without Step 2 elements, or tp-snp2 / cross-snp2
        const hasStep3Signals = host.includes('bcsakhi') ||
                                path.includes('bcsakhi') ||
                                (!hasStep2Signals && (host.includes('educatestudies') || path.includes('educatestudies')));

        let stepNum = 1;
        let stepLabel = 'STEP 1/3';

        if (hasStep2Signals) {
            stepNum = 2;
            stepLabel = 'STEP 2/3';
        } else if (hasStep3Signals) {
            stepNum = 3;
            stepLabel = 'FINAL STEP 3/3';
        } else {
            try {
                const chainInfo = await chrome.runtime.sendMessage({ type: 'GET_CHAIN_ELAPSED' });
                if (chainInfo && chainInfo.step === 2) {
                    stepNum = 2;
                    stepLabel = 'STEP 2/3';
                } else if (chainInfo && chainInfo.step === 3) {
                    stepNum = 3;
                    stepLabel = 'FINAL STEP 3/3';
                }
            } catch (e) { /* ignore */ }
        }

        // Pre-seed shortcut cookies without destroying blog session tracking:
        try {
            if (stepNum === 3 || host.includes('bcsakhi') || host.includes('educatestudies')) {
                if (!document.cookie.includes('adcadg=')) {
                    document.cookie = 'adcadg=insurance,online_colleges,study_abroad,finance,loan; path=/; max-age=3600';
                }
                try {
                    window.specialActionHandler = function() { return true; };
                } catch (e) {}
            } else {
                if (!document.cookie.includes('_uocat=')) {
                    document.cookie = '_uocat=value; path=/; max-age=86400';
                }
            }
        } catch (e) { /* ignore */ }

        // Remove deceptive overlays
        try {
            const adOverlay = document.getElementById('adOverlay');
            if (adOverlay) adOverlay.remove();
            const gcont = document.getElementById('gcont');
            if (gcont && gcont.style.position !== 'static') gcont.style.position = 'static';
        } catch (e) { /* ignore */ }

        function triggerPacedInitialAction(sNum) {
            try {
                if (sNum === 2) {
                    const btn6 = document.getElementById('btn6');
                    if (btn6) {
                        btn6.style.setProperty('display', 'block', 'important');
                        btn6.style.setProperty('visibility', 'visible', 'important');
                        btn6.removeAttribute('disabled');
                        dispatchFullClickSequence(btn6);
                    }
                    if (typeof window.nextbtn === 'function') {
                        try { window.nextbtn(); } catch (e) {}
                    }
                } else {
                    const initBtn = document.getElementById('tp-snp') ||
                                    document.getElementById('cross-snp') ||
                                    document.getElementById('startCountdownBtn') ||
                                    document.querySelector('button.start-countdown, a.start-countdown');
                    if (initBtn && isVisible(initBtn)) {
                        dispatchFullClickSequence(initBtn);
                    }
                }
            } catch (e) { /* ignore */ }
        }

        // Trigger initial step action immediately on page load so native countdown runs naturally from t=0
        triggerPacedInitialAction(stepNum);
        setTimeout(() => triggerPacedInitialAction(stepNum), 500);
        setTimeout(() => triggerPacedInitialAction(stepNum), 1500);

        function findPacedAdvanceCTA(sNum) {
            if (sNum === 2) {
                const s2 = document.getElementById('btn1') ||
                           document.getElementById('btn7') ||
                           document.querySelector('button#btn1, button#btn7, a#btn1, a#btn7, .btn1, .btn7, button#nextbtn, a#nextbtn, .nextbtn, a[href*="learn_more.php"], a[href*="bcsakhi"], a[href*="educatestudies"]');
                if (s2) return s2;
            } else if (sNum === 3) {
                const s3 = document.getElementById('tp-snp2') ||
                           document.getElementById('cross-snp2') ||
                           document.querySelector('button.button-61, button#tp-snp2, button#cross-snp2, .button-61, a.button-61, a[href*="learn_more.php"], a[href*="vplink"], a[href*="mediafire"]');
                if (s3) return s3;
            }

            const general = document.getElementById('tp-snp2') ||
                            document.getElementById('cross-snp2') ||
                            document.getElementById('btn1') ||
                            document.getElementById('btn7') ||
                            document.querySelector('button.button-61, .button-61, a[href*="learn_more.php"]');
            if (general) return general;

            const cands = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], div[role="button"]'));
            for (const el of cands) {
                if (!isVisible(el)) continue;
                const txt = (el.textContent || el.value || '').trim().toLowerCase();
                if (/^(continue|get link|next step|proceed|click here to continue)$/i.test(txt) ||
                    (txt.length < 35 && /continue|get link|next step/i.test(txt))) {
                    return el;
                }
            }
            return null;
        }

        const cleanHost = host.replace(/^www\./, '');
        const stepBadge = `${stepLabel} (${cleanHost})`;
        const PACED_STEP_FLOOR_SEC = 15; // Minimum 15-second pacing floor required by backend server
        const detectedWait = readCountdownValue();
        let targetDuration = Math.max(PACED_STEP_FLOOR_SEC, (detectedWait != null && detectedWait > 0) ? detectedWait : PACED_STEP_FLOOR_SEC);
        let totalSec = targetDuration;
        const startTime = Date.now();

        const initialMsg = (stepNum === 3)
            ? 'Securing authentic MediaFire clearance on final article...'
            : (stepNum === 2 ? 'Synchronizing transit token on Article 2...' : 'Bypassing ad overlays & validating transit session...');
        const initialIcon = (stepNum === 3) ? '🔒' : '⚡';
        const initialTelem = (stepNum === 3)
            ? '🛡️ AroShield Gate Active • 🍪 Cookies Intact'
            : '🛡️ Stealth Pacing Active • 🚫 Adblock Stealth';

        renderSmartBar({
            step: stepBadge,
            message: initialMsg,
            telemetry: initialTelem,
            remaining: totalSec,
            total: totalSec,
            progressPct: 0,
            icon: initialIcon,
            isReady: false
        });

        // 100ms high-precision unfreezable ticker loop with smooth progress tracking
        const pacedInterval = setInterval(async () => {
            if (!isEnabled()) {
                clearInterval(pacedInterval);
                return;
            }

            const elapsedMs = Date.now() - startTime;
            const elapsedSec = elapsedMs / 1000;

            // During initial 2 seconds only, adapt totalSec if page shows a legitimate higher countdown
            if (elapsedSec < 2.0) {
                const pageRem = readCountdownValue();
                if (pageRem != null && pageRem > 0 && pageRem <= 30) {
                    const requiredTotal = Math.max(PACED_STEP_FLOOR_SEC, Math.ceil(pageRem));
                    if (requiredTotal > totalSec) {
                        totalSec = requiredTotal;
                    }
                }
            }

            const remainingSec = Math.max(0, Math.ceil(totalSec - elapsedSec));
            const progressPct = Math.min(100, Math.max(0, (elapsedSec / totalSec) * 100));

            const btnReady = !!findPacedAdvanceCTA(stepNum);

            // Complete strictly after the pacing duration has elapsed (never stuck on moving goalpost!)
            if (elapsedSec >= totalSec) {
                clearInterval(pacedInterval);
                const doneMsg = (stepNum === 3)
                    ? 'MediaFire clearance secured! Unlocking destination...'
                    : (stepNum === 2 ? 'Step 2 cleared! Auto-clicking Continue...' : 'Step 1 cleared! Auto-clicking Continue...');
                const doneIcon = (stepNum === 3) ? '✅' : '🚀';
                const doneTelem = '✅ Pacing Verified • 🚀 Auto-Advancing to Next Step';

                renderSmartBar({
                    step: stepBadge,
                    message: doneMsg,
                    telemetry: doneTelem,
                    remaining: 0,
                    total: totalSec,
                    progressPct: 100,
                    icon: doneIcon,
                    isReady: true
                });

                setTimeout(() => {
                    executePacedStepAdvance(stepNum);
                }, 200);
                return;
            }

            // Dynamic behind-the-scenes telemetry message based on elapsed progress
            let stepMsg = initialMsg;
            let stepTelem = initialTelem;
            if (elapsedSec < (totalSec * 0.35)) {
                stepTelem = '🛡️ Stealth Pacing Active • 🍪 Session Synced • 🚫 Ad Walls Neutralized';
            } else if (elapsedSec < (totalSec * 0.75)) {
                stepMsg = (stepNum === 3)
                    ? 'Validating token authorization with MediaFire gateway...'
                    : (stepNum === 2 ? 'Verifying Transit Step 2 with server...' : 'Simulating natural interaction & pacing...');
                stepTelem = `⏳ ${totalSec}s Server Lock • 🤖 Human Behavior Emulated`;
            } else {
                stepMsg = (stepNum === 3)
                    ? 'Final clearance ready soon • Arming destination unlock...'
                    : (stepNum === 2 ? 'Transit token confirmed • Arming Step 2 advance...' : 'Step 1 almost complete • Arming Continue trigger...');
                stepTelem = btnReady ? '🎯 Continue Button Ready • Advancing Soon' : '🔍 Scanning for Continue CTA Button';
            }

            renderSmartBar({
                step: stepBadge,
                message: stepMsg,
                telemetry: stepTelem,
                remaining: remainingSec,
                total: totalSec,
                progressPct: progressPct,
                icon: (stepNum === 3) ? '🔒' : '⚡',
                isReady: false
            });
        }, 100);
    }

    let pacedAdvanceInProgress = false;
    let recoveryTier = 0;
    let recoveryTimer = null;

    async function executePacedStepAdvance(stepNum, isRecovery = false) {
        if (pacedAdvanceInProgress && !isRecovery) return;
        pacedAdvanceInProgress = true;

        const currentHost = window.location.hostname.replace(/^www\./, '').toLowerCase();
        const navFrom = window.location.href;

        if (isRecovery) {
            recoveryTier++;
            console.log(`[KillURL] Self-Recovery Watchdog Tier ${recoveryTier} executing on step ${stepNum}...`);
            renderSmartBar({
                step: (stepNum === 3) ? `FINAL STEP 3/3 (${currentHost})` : `STEP ${stepNum}/3 (${currentHost})`,
                message: `Self-Recovery Active (Tier ${recoveryTier}) • Rescuing step ${stepNum} navigation...`,
                telemetry: `🔄 Autonomous Watchdog • Tier ${recoveryTier} Unblock Sequence Active`,
                remaining: 0,
                progressPct: 100,
                icon: '🔄',
                isReady: true
            });
        } else {
            recoveryTier = 0;
            console.log(`[KillURL] Advancing paced step ${stepNum}...`);
            renderSmartBar({
                step: (stepNum === 3) ? `FINAL STEP 3/3 (${currentHost})` : `STEP ${stepNum}/3 (${currentHost})`,
                message: (stepNum === 3) ? 'Unlocking destination • Redirecting to MediaFire gateway...' : `Step ${stepNum} complete! Loading next article...`,
                telemetry: '🚀 Transit Button Clicked • Navigating Forward',
                remaining: 0,
                progressPct: 100,
                icon: '⚡',
                isReady: true
            });

            try {
                await chrome.runtime.sendMessage({ type: 'ADVANCE_CHAIN_STEP' });
            } catch (e) { /* ignore */ }
        }

        // Pre-seed shortcut cookies without destroying blog session tracking:
        try {
            if (stepNum === 3 || window.location.hostname.includes('bcsakhi') || window.location.hostname.includes('educatestudies')) {
                if (!document.cookie.includes('adcadg=')) {
                    document.cookie = 'adcadg=insurance,online_colleges,study_abroad,finance,loan; path=/; max-age=3600';
                }
            } else {
                if (!document.cookie.includes('_uocat=')) {
                    document.cookie = '_uocat=value; path=/; max-age=86400';
                }
            }
        } catch (e) { /* ignore */ }

        // Unhide and enable all potential advance candidate elements
        const ALL_ADVANCE_SELECTORS = [
            '#btn1', '#btn7', '.btn1', '.btn7', '#tp-snp2', '#cross-snp2',
            '.button-61', 'button.button-61', 'a.button-61', '#nextbtn', '.nextbtn',
            'a[href*="learn_more.php"]', 'a[href*="bcsakhi"]', 'a[href*="educatestudies"]', 'a[href*="vplink"]'
        ];
        for (const sel of ALL_ADVANCE_SELECTORS) {
            try {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.setProperty('display', 'block', 'important');
                    el.style.setProperty('visibility', 'visible', 'important');
                    el.style.setProperty('opacity', '1', 'important');
                    el.style.setProperty('pointer-events', 'auto', 'important');
                    el.style.setProperty('z-index', '999999', 'important');
                    el.removeAttribute('disabled');
                    el.classList.remove('disabled');
                    if (el.tagName === 'A') el.target = '_self';
                });
            } catch (e) {}
        }

        if (stepNum === 2) {
            const btn6 = document.getElementById('btn6');
            if (btn6) {
                btn6.removeAttribute('disabled');
                try { dispatchFullClickSequence(btn6); } catch (e) {}
            }
            if (typeof window.nextbtn === 'function') {
                try { window.nextbtn(); } catch (e) {}
            }
            const btn7 = document.getElementById('btn7');
            if (btn7) {
                btn7.removeAttribute('disabled');
                try { dispatchFullClickSequence(btn7); } catch (e) {}
            }
        }

        // Find primary advance CTA
        const advanceCTA = findPacedAdvanceCTA(stepNum);
        let anchor = advanceCTA?.tagName === 'A' ? advanceCTA : (advanceCTA?.closest('a[href]') || document.querySelector('a[href*="learn_more.php"], a[href*="bcsakhi"], a[href*="educatestudies"]'));

        if (advanceCTA) {
            try { dispatchFullClickSequence(advanceCTA); } catch (e) {}
            try { advanceCTA.click(); } catch (e) {}
        }
        if (anchor && anchor !== advanceCTA) {
            try { dispatchFullClickSequence(anchor); } catch (e) {}
            try { anchor.click(); } catch (e) {}
        }

        // If anchor has a cross-domain forward target href, provide a 400ms direct-navigation fallback
        const anchorHref = anchor?.getAttribute('href') || advanceCTA?.getAttribute('href');
        if (anchorHref && !anchorHref.startsWith('#') && !anchorHref.startsWith('javascript:')) {
            try {
                const u = new URL(anchorHref, window.location.href);
                const uHost = u.hostname.replace(/^www\./, '').toLowerCase();
                if (uHost !== currentHost || (u.pathname && u.pathname !== window.location.pathname)) {
                    setTimeout(() => {
                        if (window.location.href === navFrom) {
                            console.log('[KillURL] Fallback direct navigation to CTA target:', u.href);
                            window.location.href = u.href;
                        }
                    }, 400);
                }
            } catch (e) {}
        }

        // Arm Autonomous Self-Recovery Watchdog
        if (recoveryTimer) clearTimeout(recoveryTimer);
        recoveryTimer = setTimeout(() => {
            try {
                // If page already navigated, recovery succeeded!
                if (window.location.href !== navFrom) return;

                // Reset any premature unloading flag so recovery actions can proceed
                unloading = false;

                if (recoveryTier === 0) {
                    // Tier 1: Check form submissions, onclick handlers, and re-dispatch clicks
                    console.log('[KillURL] Self-Recovery: Tier 1 - Submitting forms and re-triggering CTAs');
                    const forms = Array.from(document.querySelectorAll('form'));
                    const transitForm = forms.find(f => (f.action || '').includes('learn_more') || (f.action || '').includes('educate') || (f.action || '').includes('bcsakhi') || (f.action || '').includes('study'));
                    if (transitForm) {
                        try { transitForm.submit(); return; } catch (e) {}
                    }
                    // Check button data-href / onclick
                    const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                    for (const b of buttons) {
                        const dHref = b.getAttribute('data-href') || b.getAttribute('data-url') || b.getAttribute('data-link');
                        if (dHref && !dHref.startsWith('#') && !dHref.startsWith('javascript:')) {
                            const res = new URL(dHref, window.location.href).href;
                            console.log('[KillURL] Self-Recovery Tier 1 found data-href:', res);
                            window.location.href = res;
                            return;
                        }
                    }
                    executePacedStepAdvance(stepNum, true);
                } else if (recoveryTier === 1) {
                    // Tier 2: Deep scan of DOM anchors for valid forward transit target
                    console.log('[KillURL] Self-Recovery: Tier 2 - Deep scanning anchors for transit destination');
                    const targetPatterns = (stepNum === 2)
                        ? ['bcsakhi', 'educatestudies', 'learn_more.php']
                        : (stepNum === 3 ? ['vplink', 'mediafire', 'learn_more.php'] : ['studyeducates', 'educatestudies', 'bcsakhi']);

                    const allA = Array.from(document.querySelectorAll('a[href]'));
                    for (const a of allA) {
                        const h = (a.getAttribute('href') || '').trim();
                        if (!h || h.startsWith('#') || h.startsWith('javascript:')) continue;
                        try {
                            const u = new URL(h, window.location.href);
                            const uHost = u.hostname.replace(/^www\./, '').toLowerCase();
                            const uPath = u.pathname.toLowerCase();
                            // Must match forward target and NOT be self/same category
                            if (targetPatterns.some(p => uHost.includes(p) || uPath.includes(p))) {
                                if (u.href !== window.location.href && uPath !== window.location.pathname) {
                                    console.log('[KillURL] Self-Recovery Tier 2 navigating directly to forward target:', u.href);
                                    window.location.href = u.href;
                                    return;
                                }
                            }
                        } catch (e) {}
                    }
                    executePacedStepAdvance(stepNum, true);
                } else {
                    // Tier 3: Session-Preserved Autonomous Auto-Reload
                    // Preserves cookies and clears frozen JavaScript DOM locks cleanly without user intervention!
                    console.log('[KillURL] Self-Recovery: Tier 3 - Performing session-preserved autonomous auto-reload');
                    renderSmartBar({
                        step: (stepNum === 3) ? `FINAL STEP 3/3 (${currentHost})` : `STEP ${stepNum}/3 (${currentHost})`,
                        message: 'Self-Recovery active • Auto-refreshing to clear transit lock...',
                        telemetry: '🔄 Session Preserved • Auto-Reloading Page Safely',
                        remaining: 0,
                        progressPct: 100,
                        icon: '🔄',
                        isReady: true
                    });
                    setTimeout(() => {
                        window.location.reload();
                    }, 500);
                }
            } catch (e) {
                console.error('[KillURL] Error during self-recovery:', e);
            }
        }, 1500);
    }

    let vplinkFinalStarted = false;
    // No more MAIN world event listener for killurl-aro-setup — page runs natively.
    // We use a fixed 10s assumption (AroShield default) since we can't intercept the setup call.
    const VPLINK_WAIT_SEC = 15; // 15-second server-verified pacing floor

    function startVplinkFinalController() {
        if (!isEnabled()) return;
        if (vplinkFinalStarted) return;
        vplinkFinalStarted = true;

        let turnstileSolvedT = null;
        let pollCount = 0;
        console.log('[KillURL] Vplink Final Controller (zero-fingerprint mode) on:', window.location.href);

        renderSmartBar({
            step: 'CAPTCHA GATEWAY (vplink.in)',
            message: 'Waiting for Cloudflare Turnstile verification...',
            telemetry: '🛡️ Zero-Fingerprint Active • 🤖 Captcha Solver Running',
            remaining: VPLINK_WAIT_SEC,
            total: VPLINK_WAIT_SEC,
            progressPct: 0,
            icon: '🛡️',
            isReady: false
        });

        // Comprehensive selector list for destination buttons/links on vplink
        const DEST_SELECTORS = [
            '#get-link', 'a.get-link', 'a#getlink', '#btn-main', 'a.btn-main',
            '#getlink', '.getlink', 'a#get-link', 'a.getlink',
            'a[href*="mediafire.com"]', 'a[href*="mega.nz"]', 'a[href*="drive.google.com"]',
            'a[href*="gofile.io"]', 'a[href*="pixeldrain.com"]'
        ];

        function scanForDestinationLink() {
            for (const sel of DEST_SELECTORS) {
                try {
                    const els = document.querySelectorAll(sel);
                    for (const el of els) {
                        const href = (el.getAttribute('href') || '').trim();
                        if (href && !href.includes('javascript:') && !href.startsWith('#') &&
                            !href.includes(window.location.hostname) &&
                            /^https?:\/\//i.test(href) &&
                            isValidDestination(href) &&
                            !isErrorDestination(href)) {
                            return href;
                        }
                    }
                } catch (e) { /* ignore */ }
            }
            // Also scan all anchors for any final destination link
            try {
                const allAnchors = document.querySelectorAll('a[href]');
                for (const a of allAnchors) {
                    const href = (a.getAttribute('href') || '').trim();
                    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
                    if (href.includes(window.location.hostname)) continue;
                    if (/^https?:\/\//i.test(href) && isValidDestination(href) && !isErrorDestination(href)) {
                        return href;
                    }
                }
            } catch (e) { /* ignore */ }
            return null;
        }

        // Watch for navigation away from vplink (page redirecting to destination)
        let navigationCaptured = false;
        try {
            window.addEventListener('beforeunload', () => {
                navigationCaptured = true;
            });
        } catch (e) { /* ignore */ }

        const vplinkPoll = setInterval(() => {
            if (!isEnabled()) {
                clearInterval(vplinkPoll);
                return;
            }
            pollCount++;

            // 1. Check if Cloudflare Turnstile has solved
            const hasTurnstile = hasSolvedCaptchaToken();

            if (!hasTurnstile) {
                renderSmartBar({
                    step: 'CAPTCHA GATEWAY (vplink.in)',
                    message: 'Verifying Cloudflare Turnstile...',
                    telemetry: '🤖 Turnstile Solver • 🛡️ Zero-Fingerprint Mode Active',
                    remaining: VPLINK_WAIT_SEC,
                    total: VPLINK_WAIT_SEC,
                    progressPct: 15,
                    icon: '🛡️',
                    isReady: false
                });
                return; // Strictly hold: never scan or click while Turnstile is pending!
            }

            // Turnstile is verified! Record the solve time on first occurrence
            if (!turnstileSolvedT) {
                turnstileSolvedT = Date.now();
                console.log('[KillURL] Turnstile verified on vplink! AroShield 15s server pacing lock started.');
            }

            const domWait = readCountdownValue();
            const vplinkTotal = Math.max(VPLINK_WAIT_SEC, (domWait != null && domWait > 0) ? domWait : VPLINK_WAIT_SEC);

            const elapsedMs = Date.now() - turnstileSolvedT;
            const elapsedSec = elapsedMs / 1000;
            const remainingSec = Math.max(0, Math.ceil(vplinkTotal - elapsedSec));
            const progressPct = Math.min(100, Math.max(0, (elapsedSec / vplinkTotal) * 100));

            if (remainingSec > 0) {
                renderSmartBar({
                    step: 'MEDIAFIRE ACCESS',
                    message: 'Turnstile verified! AroShield server timer counting down...',
                    telemetry: `✅ Turnstile Solved • ⏳ Server Pacing (${remainingSec}s remaining)`,
                    remaining: remainingSec,
                    total: vplinkTotal,
                    progressPct: progressPct,
                    icon: '⏳',
                    isReady: false
                });
                return; // Strictly hold: never scan or click while 15s pacing timer is running!
            }

            // Turnstile verified AND full pacing duration elapsed!
            // First, scan DOM for destination link
            const foundHref = scanForDestinationLink();
            if (foundHref && isValidDestination(foundHref) && !isErrorDestination(foundHref)) {
                clearInterval(vplinkPoll);
                console.log('[KillURL] Authentic destination found on vplink (DOM scan):', foundHref);
                processCandidateDestination(foundHref);
                return;
            }

            renderSmartBar({
                step: 'MEDIAFIRE ACCESS',
                message: 'Pacing complete! Intercepting authentic MediaFire link...',
                telemetry: '🔍 Deep Network & DOM Scanner Intercepting Link',
                remaining: 0,
                total: vplinkTotal,
                progressPct: 100,
                icon: '🚀',
                isReady: true
            });

            // Check if Get Link button has become clickable and trigger it naturally
            const ctaBtn = document.getElementById('get-link') ||
                           document.querySelector('a.get-link, a#getlink, #btn-main, a.btn-main, button#get-link');
            if (ctaBtn && !ctaBtn.hasAttribute('disabled') && !ctaBtn.classList.contains('disabled')) {
                const ctaHref = (ctaBtn.getAttribute('href') || ctaBtn.href || '').trim();
                if (ctaHref && isValidDestination(ctaHref) && !isErrorDestination(ctaHref)) {
                    clearInterval(vplinkPoll);
                    console.log('[KillURL] Authentic destination ready on CTA:', ctaHref);
                    processCandidateDestination(ctaHref);
                    return;
                }
                try {
                    dispatchFullClickSequence(ctaBtn);
                } catch (e) {
                    try { ctaBtn.click(); } catch (e2) {}
                }
            }

            // After 60 seconds of post-turnstile polling (600 iterations at 100ms), stop polling
            if (pollCount >= 600) {
                clearInterval(vplinkPoll);
            }
        }, 100);

        // Additionally, set up a MutationObserver to catch the destination link the moment it appears AFTER pacing
        try {
            const observer = new MutationObserver((mutations) => {
                if (!hasSolvedCaptchaToken()) return;
                if (!turnstileSolvedT) return;
                if ((Date.now() - turnstileSolvedT) / 1000 < VPLINK_WAIT_SEC) return;

                const href = scanForDestinationLink();
                if (href && isValidDestination(href) && !isErrorDestination(href)) {
                    observer.disconnect();
                    clearInterval(vplinkPoll);
                    console.log('[KillURL] Authentic destination found on vplink (MutationObserver):', href);
                    processCandidateDestination(href);
                }
            });
            observer.observe(document.documentElement || document.body || document, {
                childList: true, subtree: true, attributes: true, attributeFilter: ['href']
            });
            // Auto-disconnect after 90s
            setTimeout(() => { try { observer.disconnect(); } catch (e) {} }, 90000);
        } catch (e) { /* ignore */ }
    }

    let lastInitialBtnClickT = 0;
    function clickInitialVerificationButton() {
        if (!isEnabled()) return false;
        if (isProtectedSite || isFinalSite) return false;
        if (isCaptchaShortenerDomain()) return false;
        if (isSecurityPage && !settings.aggressiveMode) return false;
        if (isCaptchaPending()) return false;
        if (Date.now() - lastInitialBtnClickT < 1500) return false;

        const triggerSelectors = [
            '#startCountdownBtn', '.start-countdown-btn', 'button#startCountdownBtn',
            '#cross-snp', '#tp-snp',
            '#start-btn', '.start-btn', '#start-timer', '#start-countdown',
            '#verify-now', '.verify-now', '#btn-verify', '.btn-verify',
            'button[id*="startCountdown" i]', 'button[class*="start-countdown" i]',
            'button[id*="start-countdown" i]', 'button[class*="start-countdown" i]'
        ];

        for (const selector of triggerSelectors) {
            try {
                const btn = document.querySelector(selector);
                if (btn && isVisible(btn) && !btn.disabled && isSafeToClick(btn)) {
                    const text = ((btn.textContent || btn.value || '')).trim().toLowerCase();
                    if (text.includes('counting') || text.includes('please wait') || text.includes('waiting')) continue;
                    console.log('[KillURL] Clicking initial countdown trigger button matching selector:', selector);
                    lastInitialBtnClickT = Date.now();
                    navigateOrClick(btn);
                    return true;
                }
            } catch (e) { /* skip */ }
        }

        // Fallback text matching for visible initial verification buttons
        try {
            const clickables = document.querySelectorAll('button, a.btn, a[role="button"], input[type="button"]');
            for (const el of clickables) {
                if (!isVisible(el) || el.disabled || !isSafeToClick(el)) continue;
                const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
                if (/^(?:click\s*(?:here\s*)?to\s*(?:verify|start)|verify\s*to\s*continue|start\s*verification)$/i.test(text)) {
                    console.log('[KillURL] Clicking initial countdown trigger button by text match:', text);
                    lastInitialBtnClickT = Date.now();
                    navigateOrClick(el);
                    return true;
                }
            }
        } catch (e) { /* skip */ }

        return false;
    }

    function clickContinueButton() {
        if (!isEnabled()) return false;
        if (isProtectedSite || isFinalSite) return false;
        if (isCaptchaShortenerDomain()) return false;
        if (isPacedDomain()) return false; // Managed strictly by PacedStepController
        if (isSecurityPage && !settings.aggressiveMode) return false;
        if (isCaptchaPending()) {
            console.log('[KillURL] Captcha / Turnstile pending — waiting for completion before clicking');
            return false;
        }

        // Site-specific handlers
        const hostname = window.location.hostname.replace(/^www\./, '').toLowerCase();

        // earnbox.in specific handling
        if (hostname === 'earnbox.in') {
            const found = clickEarnboxButton();
            if (found) return true;
            console.log('[KillURL] earnbox.in: Falling back to generic handler...');
        }

        // 0. If an initial countdown trigger button is waiting to be pressed, press it to start the timer!
        if (clickInitialVerificationButton()) {
            return true;
        }

        // Comprehensive button selectors for earn blogs, shorteners, and WordPress templates
        const buttonSelectors = [
            '#skip', '.skip', 'a#skip', 'a.skip',
            '#continue', '.continue', 'a#continue', 'a.continue',
            '#go-link', '.go-link', 'a#go-link', 'a.go-link',
            '#getlink', '.getlink', 'a#getlink', 'a.getlink',
            '#btn-main', '.btn-main', 'a#btn-main', 'a.btn-main',
            '#land-btn', '.land-btn',
            '#cross-snp2', '#tp-snp2',
            'button.button-61', '.button-61',
            'a[href*="learn_more.php"] button', 'a[href*="learn_more.php"]',
            '#btn6', '.btn6', 'a#btn6', 'button#btn6',
            '#btn2', '.btn2', '#btn1', '.btn1', '#btn0', '.btn0',
            '#gotolink', '.gotolink', 'a#gotolink', 'button#gotolink',
            '#c-btn', '.c-btn', '#cbtn', '.cbtn', 'a#cbtn', 'button#cbtn',
            '#makinglink', '.makinglink', 'a#makinglink',
            '#nextbtn', '.nextbtn', 'button#nextbtn', 'a#nextbtn',
            '#submit-btn', '.submit-btn', 'button#submit-btn',
            '#show-link', '.show-link', 'a#show-link',
            '#f-btn', '.f-btn', 'button#f-btn',
            '#generate', '.generate', 'button#generate', 'a#generate',
            '#verify-btn', '.verify-btn', 'button#verify-btn', 'a#verify-btn',
            '#wpsafe-link a', '#wpsafe-link button', '#wpsafe-link',
            '.wpsafe-link a', '.wpsafe-link button', '.wpsafe-link',
            '#wpsafe-generate a', '#wpsafe-generate button', '#wpsafe-generate',
            '#wpsafe-wait a', '#wpsafe-wait button',
            '#scroll-to-continue', '.scroll-to-continue',
            '#continue-btn', '.continue-btn',
            '#skip-btn', '.skip-btn',
            '#link-btn', '.link-btn', '#get-link', '.get-link',
            '#verify', '.verify', 'form#go-link button', 'form.go-link button',
            'a.btn-primary', 'button.btn-primary', 'a.btn-success', 'button.btn-success',
            'a.btn-info', 'button.btn-info',
            '[id*="continue"]', '[id*="getlink"]', '[id*="get-link"]', '[id*="gotolink"]',
        ];

        // 1. Check visible matching buttons
        for (const selector of buttonSelectors) {
            try {
                const btn = document.querySelector(selector);
                if (btn && isVisible(btn) && !btn.disabled && isSafeToClick(btn)) {
                    // If countdown is actively ticking down with positive numbers, hold
                    const v = readCountdownValue();
                    if (v != null && v > 0) {
                        console.log('[KillURL] Visible button found (' + selector + '), but countdown is ticking (' + v + 's remaining)');
                        return false;
                    }
                    console.log('[KillURL] Clicking visible button matching selector:', selector);
                    navigateOrClick(btn);
                    return true;
                }
            } catch (e) { /* skip */ }
        }

        // 2. Fallback: smart text-based click on visible elements
        const clickables = document.querySelectorAll('a, button, input[type="submit"], input[type="button"], [role="button"]');
        for (const el of clickables) {
            if (!isVisible(el) || el.disabled) continue;
            if (!isSafeToClick(el)) continue;
            const text = ((el.textContent || el.value || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
            if (matchesCTA(text, true)) {
                const v = readCountdownValue();
                if (v != null && v > 0) {
                    console.log('[KillURL] CTA text matched (' + text.slice(0, 30) + '), but countdown is ticking (' + v + 's)');
                    return false;
                }
                console.log('[KillURL] Clicking Continue by text match:', text.slice(0, 60));
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
        if (!autoPressAllowed()) return false;
        const v = readCountdownValue();
        if ((v != null && v > 0) || countdownIsLive()) return false;
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
                    if (!autoPressAllowed()) return;
                    dispatchFullClickSequence(el);
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
                if (!autoPressAllowed()) return;
                dispatchFullClickSequence(btn);
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
                    if (!autoPressAllowed()) return;
                    if (href && href !== '#' && !href.startsWith('javascript:')) {
                        navigateOrClick(el);
                    } else {
                        dispatchFullClickSequence(el);
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

    async function navigateOrClick(el) {
        if (!isSafeToClick(el)) return;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ }

        // On multi-step blog chains, pacing is strictly managed by startPacedStepController
        if (isPacedDomain() || isCaptchaShortenerDomain() || el.id === 'tp-snp2' || el.id === 'cross-snp2') {
            return;
        }

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

        // Strip error href if present so clicking won't follow error page
        if (href && isErrorDestination(href)) {
            try { el.removeAttribute('href'); } catch (e) { /* ignore */ }
            return;
        }

        // Always enforce same-tab target to prevent new tab explosions
        enforceSameTabTarget(el);

        // Always click the element first so page event handlers,
        // AJAX token fetches, form submissions, and analytics/session updates run naturally!
        console.log('[KillURL] Clicking CTA element:', (el.textContent || el.value || el.id || el.className || 'button').trim().slice(0, 60));
        suppressAutoPressUntil = Date.now() + 2500;
        const navFrom = window.location.href;

        // Dispatch full human click sequence FIRST (unloading must not be true during the click!)
        const parentLink = el.closest('a[href]');
        if (parentLink) {
            try { parentLink.click(); } catch (e) { /* ignore */ }
            dispatchFullClickSequence(parentLink);
        }
        const clicked = dispatchFullClickSequence(el);
        if (clicked) {
            unloading = true;
            setTimeout(() => {
                try {
                    if (window.location.href === navFrom) unloading = false;
                } catch (e) { unloading = false; }
            }, 2500);
        }

        // If clicking did not trigger navigation after a settle window,
        // and el is a genuine external link (not javascript/hash), navigate as fallback
        if (href && (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) && isValidDestination(href)) {
            let resolved = href;
            try { resolved = new URL(href, window.location.href).href; } catch (e) { /* keep raw */ }
            if (!isErrorDestination(resolved) && resolved !== window.location.href) {
                setTimeout(() => {
                    try {
                        if (!unloading || window.location.href === navFrom) {
                            console.log('[KillURL] Fallback direct navigation via CTA href:', resolved);
                            unloading = true;
                            window.location.href = resolved;
                        }
                    } catch (e) { /* ignore */ }
                }, 1200);
            }
        }
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

    // Ad/tracker hosts are NEVER destinations: capturing (or, worse,
    // navigating to) a "Click here" ad link is how chains derail into ad
    // loops and how false arrivals poison loop memory. Mirrors the injector's
    // bait list; host-focused so first-party links are never affected.
    const AD_HOST_RE = /googlesyndication|googleadservices|doubleclick|googletagservices|adservice\.google|pagead|adsbygoogle|adsrvr|adnxs|criteo|taboola|outbrain|revcontent|mgid|amazon-adsystem|apstag|pubmatic|rubicon|moatads|2mdn\.net|prebid|pbjs|popads|adform\.net|propellerads|adsterra|exoclick|adcash|popcash|clickadu/i;

    function isAdHost(url) {
        try {
            return AD_HOST_RE.test(new URL(url, window.location.href).hostname);
        } catch (e) { return false; }
    }

    const ERROR_DEST_RE = /(?:error\.php|\berrno=\d+|\borigin=download|\berror_code=\d+|\b(?:404|403|500)\.html?|\/404(?:\/|\.|$|\?)|bypass\.vip|discord\.(?:gg|com)|(?:invalid[_-]?token|session[_-]?expired|token[_-]?expired|link[_-]?expired|blocked|suspended|cheating))/i;

    function isErrorDestination(url) {
        if (!url) return true;
        const sites = window.KILLURL_SITES || (typeof globalThis !== 'undefined' ? globalThis.KILLURL_SITES : null);
        if (sites && typeof sites.isErrorUrl === 'function') {
            return sites.isErrorUrl(url);
        }
        try {
            const s = String(url).trim();
            if (ERROR_DEST_RE.test(s)) return true;
            const u = new URL(s, window.location.href);
            const host = u.hostname.replace(/^www\./, '').toLowerCase();
            const full = u.pathname + u.search + u.hash;
            if (host === 'mediafire.com' || host.endsWith('.mediafire.com')) {
                if (/(?:error\.php|\berrno=\d+|\borigin=download|upgrade_support\.php|terms_of_service)/i.test(full)) return true;
                // Honeypot / poisoned decoy links generated by shorteners have fake random suffixes (e.g. /rnji, /hlos) instead of /file
                if (/\/(?:file|download)\/[a-zA-Z0-9_-]+\/[^\/]+\/(?!file(?:[\/?#]|$))[^\/?#]+/i.test(full)) return true;
                return !(/\/(?:file|download|folder|view)\/[a-zA-Z0-9_-]{4,}|\/\?[a-zA-Z0-9_-]{5,}/i.test(full));
            }
            if (host === 'mega.nz' || host === 'mega.io') {
                return !(/\/(?:file|folder)\/[a-zA-Z0-9_-]{6,}|#[!a-zA-Z0-9_-]{8,}/i.test(full));
            }
            if (host === 'drive.google.com') {
                return !(/\/(?:file\/d\/|drive\/folders\/|open\?id=|uc\?id=)[a-zA-Z0-9_-]{10,}/i.test(full));
            }
            return false;
        } catch (e) {
            return true;
        }
    }

    function isValidDestination(url) {
        if (!url) return false;
        url = url.trim();
        if (isErrorDestination(url)) return false;
        if (url.includes('learn_more.php') || url.includes('/studyeducates/') || url.includes('/educatestudies/')) return true;
        if (url.startsWith('/go/') || url.startsWith('/out/') || url.startsWith('/redirect/') || url.startsWith('/link/')) return true;
        if (isPacedDomain()) {
            try {
                const u = new URL(url, window.location.href);
                if (isPacedDomain(u.hostname)) return true;
            } catch (e) { /* ignore */ }
        }
        if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
        if (isAdHost(url)) return false;
        try {
            const u = new URL(url);
            // Avatar/profile images are page furniture, never destinations.
            const hn = u.hostname.replace(/^www\./, '').toLowerCase();
            if (/^(secure\.)?gravatar\.com$|libravatar|robohash|ui-avatars|pravatar/i.test(hn)) return false;
            const destHost = u.hostname.replace(/^www\./, '');
            const currentHost = window.location.hostname.replace(/^www\./, '');
            return destHost !== currentHost;
        } catch (e) {
            return false;
        }
    }

    // ===== PREMATURE CLICK GUARD =====
    // Intercept and block user clicks on Continue / Next buttons while a countdown
    // is ticking down. Clicking these before the server-side timer elapses invalidates
    // the security token in the shortener's database, producing dead download links.
    let clickGuardInstalled = false;
    function setupPrematureClickGuard() {
        if (clickGuardInstalled) return;
        clickGuardInstalled = true;
        document.addEventListener('click', (e) => {
            if (!isEnabled()) return;
            if (isSecurityPage && !settings.aggressiveMode) return;
            // On paced domains, let PacedStepController manage pacing — never block user clicks and NEVER tamper with session cookies!
            if (isPacedDomain()) {
                return;
            }
            const rem = readCountdownValue();
            const live = countdownIsLive();
            if ((rem != null && rem > 0) || live) {
                const btn = e.target?.closest?.('a, button, input[type="submit"], input[type="button"], [role="button"]');
                if (btn) {
                    const text = (((btn.textContent || btn.value || '') + ' ' + (btn.id || '')).trim()).toLowerCase();
                    // Allow ALL initial countdown trigger / verification buttons (never block clicks to start or verify!)
                    if (btn.id === 'startCountdownBtn' ||
                        btn.id === 'cross-snp' ||
                        btn.id === 'tp-snp' ||
                        btn.className?.toLowerCase?.().includes('start-countdown') ||
                        text.includes('verify') ||
                        text.includes('start') ||
                        text.includes('robot') ||
                        text.includes('human')) {
                        return;
                    }

                    // If button is cross-snp2, tp-snp2, btn7, btn6, btn1 and is VISIBLE, never block it!
                    const advanceBtn = (btn.id === 'cross-snp2' || btn.id === 'tp-snp2' || btn.id === 'btn7' || btn.id === 'btn6' || btn.id === 'btn1') ? btn : btn.querySelector?.('#cross-snp2, #tp-snp2, #btn7, #btn6, #btn1');
                    if (advanceBtn && isVisible(advanceBtn) && !advanceBtn.disabled) {
                        return;
                    }

                    // ONLY block terminal advance buttons (cross-snp2 and tp-snp2 that navigate to learn_more.php)
                    const isTerminalAdvance = btn.id === 'cross-snp2' ||
                        btn.id === 'tp-snp2' ||
                        !!btn.closest('a[href*="learn_more.php"]');
                    if (isTerminalAdvance) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        const waitSec = (rem != null && rem > 0) ? `~${rem}s` : 'a few seconds';
                        console.log(`[KillURL] Premature click blocked (${waitSec} remaining on timer) to preserve valid download link.`);
                        updatePageHint(`⏳ Waiting for timer (${waitSec} remaining) — clicking early kills the download link!`);
                    }
                }
            }
        }, true);
    }

    // ===== MUTATION OBSERVER (passive — detection only) =====

    function setupMutationObserver() {
        if (mutationObserverAttached) return;
        mutationObserverAttached = true;
        const observer = new MutationObserver((mutations) => {
            if (!isEnabled()) return;
            if (isProtectedSite || isFinalSite) return;

            checkCaptchaResolution();

            if (isSecurityPage && !settings.aggressiveMode) return;

            let shouldScan = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            // Check if interstitial CF challenge was injected after load
                            if (isInterstitialSecurityPage()) {
                                isSecurityPage = true;
                                if (!settings.aggressiveMode) {
                                    stopContinuousScanner();
                                    return;
                                }
                            }

                            // If turnstile or captcha was injected after load, notify injector to stand down
                            const nodeHtml = (node.innerHTML || node.outerHTML || '').toLowerCase();
                            const nodeSrc = (node.getAttribute?.('src') || '').toLowerCase();
                            if (nodeHtml.includes('challenges.cloudflare.com/turnstile') || nodeHtml.includes('cf-turnstile') || nodeSrc.includes('challenges.cloudflare.com')) {
                                try {
                                    window.dispatchEvent(new CustomEvent('killurl-turnstile-detected', { detail: { reason: 'mutation-turnstile' } }));
                                } catch (e) { /* ignore */ }
                            }

                            const text = (node.textContent || '').toLowerCase();
                            if (text.includes('continue') || text.includes('skip') ||
                                text.includes('get link') || text.includes('scroll down') ||
                                text.includes('download link') || text.includes('click here')) {
                                shouldScan = true;
                            }
                        }
                    }
                }

                if (mutation.type === 'attributes') {
                    const target = mutation.target;
                    if (mutation.attributeName === 'disabled' || mutation.attributeName === 'style' ||
                        mutation.attributeName === 'class' || mutation.attributeName === 'href' || mutation.attributeName === 'value') {
                        const text = (target.textContent || '').toLowerCase();
                        if (text.includes('continue') || text.includes('skip') ||
                            text.includes('get link') || text.includes('scroll down')) {
                            shouldScan = true;
                        }
                        if (target.name === 'cf-turnstile-response' || target.name === 'g-recaptcha-response' || target.name === 'h-captcha-response') {
                            checkCaptchaResolution();
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
            attributeFilter: ['style', 'class', 'disabled', 'href', 'aria-disabled', 'aria-hidden', 'value']
        });
    }

    // ===== AD-BLOCK WALL REMOVAL =====

    function removeAdBlockWalls() {
        if (!isEnabled()) return 0;
        if (isCaptchaShortenerDomain() || isCaptchaPending() || isSecurityPage) return 0;
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
                if (isProtectedSite) {
                    sendResponse({ success: false, isProtected: true, destinationUrl });
                    break;
                }
                if (isFinalSite) {
                    sendResponse({ success: false, isFinal: true, destinationUrl });
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
                if (isProtectedSite || isFinalSite) { sendResponse({ success: false }); break; }
                isKnownShortener = true;
                isShortenerPage = true;
                if (message.autoSkip) settings.autoSkip = true;
                if (message.autoRedirect) settings.autoRedirect = true;
                notifyStatus();
                // Query remote bypass resolver in parallel
                try {
                    chrome.runtime.sendMessage({ type: 'RESOLVE_BYPASS', url: window.location.href }, (resp) => {
                        if (resp && resp.destination) {
                            console.log('[KillURL] Remote resolver resolved destination:', resp.destination);
                            setDestination(resp.destination);
                        }
                    });
                } catch (e) { /* ignore */ }
                maybeAutoSkip();
                sendResponse({ success: true });
                break;

            case 'RESOLVER_FOUND_DESTINATION':
                if (message.url) {
                    console.log('[KillURL] Received resolver destination from background:', message.url);
                    setDestination(message.url);
                }
                sendResponse({ success: true });
                break;

            case 'GET_STATUS':
                sendResponse({
                    enabled: isEnabled(),
                    arrived: arrivedAtDestination || isFinalSite,
                    patient: patientMode,
                    gateInSec: (() => { try { const r = gateRemainingMs(); return r < 0 ? null : Math.ceil(r / 1000); } catch (e) { return null; } })(),
                    isShortenerPage,
                    isKnownShortener,
                    isSecurityPage,
                    isProtected: isProtectedSite,
                    isFinal: isFinalSite,
                    aggressiveMode: !!settings.aggressiveMode,
                    countdownDetected,
                    destinationUrl,
                    hostname: window.location.hostname,
                    scanCount
                });
                break;

            case 'DO_REDIRECT':
                if (!isEnabled()) { sendResponse({ success: false, disabled: true }); break; }
                if (isProtectedSite) { sendResponse({ success: false, disabled: true }); break; }
                if (message.url) {
                    window.location.href = message.url;
                } else if (destinationUrl) {
                    window.location.href = destinationUrl;
                }
                sendResponse({ success: true });
                break;

            case 'REMOVE_ADBLOCK_WALL':
                if (!isEnabled()) { sendResponse({ success: false, disabled: true, removed: 0 }); break; }
                if (isProtectedSite) { sendResponse({ success: false, disabled: true, removed: 0 }); break; }
                // Manual button = explicit consent: sweep EVERY wall species
                // (adblock walls, click-ads instruction modals, watch-ad
                // gates) with throttles bypassed and full removal allowed.
                // That's why the old code reported "nothing" while a modal
                // stood in plain sight — it only checked adblock wording.
                let wallsRemoved = 0;
                try { wallsRemoved += removeAdBlockWalls() || 0; } catch (e) { /* ignore */ }
                try { wallsRemoved += dismissInstructionModals({ aggressive: true, force: true }) || 0; } catch (e) { /* ignore */ }
                try {
                    const gates = handleAdGateOverlays({ aggressive: true, force: true }) || 0;
                    wallsRemoved += gates;
                } catch (e) { /* ignore */ }
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
                if (isProtectedSite) {
                    sendResponse({
                        enabled: true,
                        isProtected: true,
                        isShortenerPage: false,
                        isKnownShortener: false,
                        isSecurityPage: false,
                        countdownDetected: false,
                        destinationUrl: null,
                        hostname: window.location.hostname,
                        scanCount: 0
                    });
                    break;
                }
                if (isFinalSite) {
                    sendResponse({
                        enabled: true,
                        isFinal: true,
                        arrived: true,
                        isShortenerPage: false,
                        isKnownShortener: false,
                        isSecurityPage: false,
                        countdownDetected: false,
                        destinationUrl: null,
                        hostname: window.location.hostname,
                        scanCount: 0
                    });
                    break;
                }
                isShortenerPage = false;
                countdownDetected = false;
                countdownGunSeen = false;
                destinationUrl = null;
                skipRetriesScheduled = false;
                isSecurityPage = false;
                scanCount = 0;
                try {
                    maybeAutoSkip._withheldLogged = false;
                    countHistory = [];
                    everSawLiveCountdown = false;
                    firstSignalT = 0;
                    firstPositiveT = 0;
                } catch (e) { /* ignore */ }

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
                        isProtected: isProtectedSite,
                        isFinal: isFinalSite,
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
                // Toggle flipped on with the page already open: arm the wall
                // watcher now instead of waiting for a reload. Frames get the
                // walls-only sweep (never modal removal or ad presses).
                if (settings.removeAdBlockWalls) {
                    let framed = false;
                    try { framed = window.self !== window.top; } catch (e) { framed = true; }
                    try {
                        if (framed) { watchAdBlockWalls({ iframe: true }); sweepAllWalls(false); }
                        else { watchAdBlockWalls(); sweepAllWalls(true); }
                    } catch (e) { /* ignore */ }
                }
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
            if (!pageWindow.__k7_ld) {
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
    // Unmissable boot heartbeat (always-on, not debug-gated): if this line
    // never appears, the content script isn't running here at all (extension
    // not reloaded/disabled, or page excluded) — check chrome://extensions.
    try {
        console.log('[KillURL] content v1.4.0 loaded @ ' + window.location.hostname);
    } catch (e) { /* ignore */ }
    init();
})();
