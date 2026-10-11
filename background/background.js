// KillURL Background Service Worker
// Handles communication between popup, content scripts, and manages state

try {
    importScripts('/shared/sites.js');
} catch (e) {
    try {
        importScripts('../shared/sites.js');
    } catch (e2) {
        console.error('[KillURL] importScripts failed:', e2);
    }
}

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

// Per-tab chain memory for LOOP detection. Earn chains ("Step N of 6") often
// enforce waits server-side: finishing the client timer instantly gets the
// token rejected and the server bounces you back to step 1 — an endless loop.
// Seeing a page for the 2nd time in one tab means exactly that, so we switch
// that tab to patient mode (wait the timer out naturally, then advance).
const visitHistoryByTab = new Map(); // tabId -> [{key, t}] (cap 30, 4-min window)
const patientTabs = new Set(); // tabIds that must wait steps out naturally
const LOOP_WINDOW_MS = 4 * 60 * 1000; // revisit only counts recent bounces

// HOSTS that have proven to enforce waits server-side (a chain looped there
// once). Persisted in storage.local with a TTL so EVERY future chain on that
// host — any tab, any browser session within the TTL — runs patient from its
// very first page instead of re-learning the lesson by bouncing once per tab.
// Each entry also carries the LEARNED REQUIRED SECONDS (s): the advertised
// countdown of the step that bounced (+ margin), so enforced hosts hold the
// gate until the earliest server-valid instant instead of watching blindly.
// Experiment fields (the self-calibrating engine):
//   m: 'unknown' (enforced, strategy untried) | 'malleable' (aged tokens pass
//      → submit instantly, no floor) | 'strict' (aged tokens rejected →
//      deadline floor only, never probe again)
//   b: bounce count observed on this host (drives probe/escalation decisions)
// Fast Remote Bypass Resolver API
// Safely queries bypass endpoints and strictly validates destinations
async function resolveShortenerUrl(shortUrl) {
    if (!shortUrl || !/^https?:\/\//i.test(shortUrl)) return null;
    try {
        const u = new URL(shortUrl);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        if (typeof KILLURL_SITES !== 'undefined' && (KILLURL_SITES.isProtected(host) || KILLURL_SITES.isFinal(host))) return null;
        
        // Note: api.bypass.vip is discontinued (returns promo text) — cleanly fall back to in-page engine
        return null;
    } catch (e) {
        // Fall back to in-page bypass
    }
    return null;
}

// Clean up any legacy learned slow-down records on startup so no site stays trapped in 25-120s waits
(async () => {
    try {
        await chrome.storage.local.remove(LEARNED_PATIENT_STORE);
        patientTabs.clear();
        console.log('[KillURL] Cleared legacy slow-down patient store — fast server skip engine active');
    } catch (e) { /* ignore */ }
})();

const LEARNED_PATIENT_STORE = 'kuLearnedPatientHosts';
const LEARNED_PATIENT_TTL_MS = 2 * 24 * 60 * 60 * 1000;

async function getLearnedPatientHosts() {
    try {
        const o = await chrome.storage.local.get(LEARNED_PATIENT_STORE);
        const now = Date.now();
        return ((o && o[LEARNED_PATIENT_STORE]) || [])
            .filter(e => e && typeof e.h === 'string' && (now - (e.t || 0)) < LEARNED_PATIENT_TTL_MS);
    } catch (e) { return []; }
}

async function learnPatientHost(host, requiredSeconds) {
    if (!host) return;
    try {
        const list = await getLearnedPatientHosts();
        // Cap required wait to 3-4s max - never lock into 25-120s stalls
        const s = (typeof requiredSeconds === 'number' && requiredSeconds > 0) ? Math.min(Math.round(requiredSeconds), 4) : 3;
        const existing = list.find(e => e.h === host);
        if (existing) {
            existing.s = s;
            existing.t = Date.now();
            existing.b = (existing.b || 0) + 1;
            existing.m = 'malleable'; // Token aging engine is always active
        } else {
            list.push({ h: host, t: Date.now(), s: s, m: 'malleable', b: 1 });
        }
        await chrome.storage.local.set({ [LEARNED_PATIENT_STORE]: list.slice(-200) });
        console.log('[KillURL] Host recorded for fast server-timer bypass:', host, '(max window: ' + s + 's)');
    } catch (e) { /* ignore */ }
}

// Experiment verdicts: malleable by default since our active token & net engine bypasses timers
async function setHostExperiment(host, verdict) {
    if (!host) return;
    try {
        const list = await getLearnedPatientHosts();
        const existing = list.find(e => e.h === host);
        if (existing) {
            existing.m = verdict;
            existing.t = Date.now();
        } else {
            list.push({ h: host, t: Date.now(), s: null, m: verdict, b: 0 });
        }
        await chrome.storage.local.set({ [LEARNED_PATIENT_STORE]: list.slice(-200) });
    } catch (e) { /* ignore */ }
}

async function getHostExperiment(host) {
    try {
        const list = await getLearnedPatientHosts();
        const e = list.find(x => host === x.h || host.endsWith('.' + x.h));
        if (!e) return { malleable: true, strict: false, bounces: 0, required: 3 };
        return {
            malleable: e.m !== 'strict',
            strict: false,
            bounces: e.b || 0,
            required: Math.min((typeof e.s === 'number' && e.s > 0) ? e.s : 3, 4)
        };
    } catch (err) { return null; }
}

// In-flight malleability probes: tabId -> { host, t }. Set when a content
// script fires a backdated submit; resolved by the NEXT CHECK_LOOP from the
// same tab (new step key = probe worked → malleable; revisit = bounced →
// strict + escalate). Expire after 90s so a stalled page can't leave a
// permanent armed probe behind.
const probeByTab = new Map(); // tabId -> { host, t }
const PROBE_TTL_MS = 90000;

// The advertised countdown of the step currently loaded in a tab (parsed by
// the content script and reported via PAGE_STATUS). When a bounce lands, THIS
// is the value of the step that FAILED — the perfect attribution for
// learning that host's true wait requirement.
const lastAdvertisedByTab = new Map(); // tabId -> seconds

// Tab state ALSO lives in chrome.storage.session: the service worker sleeps
// during long countdown waits and wakes up amnesiac — arrival memory and loop
// history must survive that, or chains randomly regress mid-flow.
const hasSessionStorage = !!(chrome.storage && chrome.storage.session);
async function persistTabState() {
    if (!hasSessionStorage) return;
    try {
        const kuTabState = {};
        const tabIds = new Set([...lastDestinationByTab.keys(), ...visitHistoryByTab.keys(), ...patientTabs, ...lastAdvertisedByTab.keys()]);
        for (const id of tabIds) {
            kuTabState[id] = {
                dest: lastDestinationByTab.get(id) || null,
                hist: visitHistoryByTab.get(id) || [],
                patient: patientTabs.has(id),
                ad: (typeof lastAdvertisedByTab.get(id) === 'number') ? lastAdvertisedByTab.get(id) : null
            };
        }
        await chrome.storage.session.set({ kuTabState });
    } catch (e) { /* ignore */ }
}
async function restoreTabState() {
    if (!hasSessionStorage) return;
    try {
        const s = await chrome.storage.session.get('kuTabState');
        const all = (s && s.kuTabState) || {};
        for (const id of Object.keys(all)) {
            const st = all[id] || {};
            if (st.dest) lastDestinationByTab.set(Number(id), st.dest);
            if (Array.isArray(st.hist) && st.hist.length) {
                // Normalize legacy plain-string entries to {key, t}.
                const norm = st.hist.map(e => (typeof e === 'string') ? { key: e, t: Date.now() } : e)
                    .filter(e => e && typeof e.key === 'string');
                if (norm.length) visitHistoryByTab.set(Number(id), norm.slice(-30));
            }
            if (st.patient) patientTabs.add(Number(id));
            if (typeof st.ad === 'number' && st.ad > 0) lastAdvertisedByTab.set(Number(id), st.ad);
        }
    } catch (e) { /* ignore */ }
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) { return ''; }
}

function pathOf(url) {
    try {
        const p = new URL(url).pathname || '/';
        return p.replace(/\/+$/, '') || '/';
    } catch (e) { return '/'; }
}

// Arrival test: exact same URL (ignoring #fragment), or the remembered
// destination path is a prefix of (or equal to) the current page's path.
// Query strings are ignored on the prefix branch — landing pages routinely
// gain/lose tracking params on redirect.
function exactUrlMatch(remembered, current) {
    try {
        const noHash = (u) => { const x = new URL(u); x.hash = ''; return x.href; };
        return noHash(remembered) === noHash(current);
    } catch (e) { return false; }
}
function pathIsPrefixOf(remembered, current) {
    try {
        const noHash = (u) => { const x = new URL(u); x.hash = ''; return x.href; };
        if (noHash(remembered) === noHash(current)) return true;
        const dp = pathOf(remembered);
        const cp = pathOf(current);
        if (dp === '/') return true;
        return cp === dp || cp.startsWith(dp + '/');
    } catch (e) { return false; }
}

function normUrl(url) {
    try {
        const u = new URL(url);
        u.hash = '';
        return u.href;
    } catch (e) { return url; }
}

// Loop key: host + path + step marker so multi-step flows are recognized as forward progress,
// while repeated bounces to the exact same initial step remain detectable.
function loopKey(url) {
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        let path = (u.pathname || '/').replace(/\/+$/, '') || '/';
        const step = u.searchParams.get('step') || u.searchParams.get('page') || u.searchParams.get('s') || '';
        return host + path + (step ? '?step=' + step : '');
    } catch (e) { return url; }
}

const AD_POPUP_HOST_RE = /popads|popcash|propellerads|adsterra|monetag|clickadu|yllix|hilltopads|exoclick|trafficjunky|juicyads|ero-advertising|richads|adcash|bidvertiser|revenuehits|evadav|admaven|rollerads|onclickmega|highcpmgate|highrevenuegate|al5sm|whomee|dood|streamtape|vupload|syndication|doubleclick|googleadservices|googlesyndication|adnxs|taboola|outbrain|criteo|mgid|revcontent|zeroredirect|offerwall|traffic|direct-link|smartlink|adroute|adlinkfly|linkvertise|loot-link|loot-labs|ad-maven|ad-delivery|delivery-engine|clcksite|tracking|trackclick|xmlclick|adtracker/i;

function isAdPopupUrl(url) {
    if (!url) return false;
    try {
        const u = String(url).trim();
        if (AD_POPUP_HOST_RE.test(u)) return true;
        if (/[?&](zoneid|bannerid|campaignid|pubid|direct_link|popunder|popup|clickid|ad_id)=/i.test(u)) return true;
    } catch (e) { return false; }
    return false;
}

const recentShortenerPopupTabs = new Map(); // tabId -> timestamp

if (chrome.tabs?.onCreated) {
    chrome.tabs.onCreated.addListener(async (tab) => {
        if (!tab || !tab.id) return;
        const openerId = tab.openerTabId;
        if (!openerId) return;

        // Check if opener tab is in shortener memory or currently on a shortener URL
        let isShortenerOpener = visitHistoryByTab.has(openerId) || patientTabs.has(openerId) || lastDestinationByTab.has(openerId);
        if (!isShortenerOpener) {
            try {
                const openerTab = await chrome.tabs.get(openerId);
                if (openerTab?.url) {
                    const h = hostOf(openerTab.url);
                    if (isKnownShortener(h)) isShortenerOpener = true;
                }
            } catch (e) { /* ignore */ }
        }
        if (!isShortenerOpener) return;

        const targetUrl = tab.pendingUrl || tab.url || '';
        if (isAdPopupUrl(targetUrl)) {
            console.log('[KillURL:BG] Closed rogue ad popup tab:', tab.id, targetUrl.slice(0, 80));
            try { chrome.tabs.remove(tab.id); } catch (e) { /* ignore */ }
            return;
        }

        // If opened from a shortener, track it for 8 seconds so deferred ad navigations are closed
        recentShortenerPopupTabs.set(tab.id, Date.now());
        setTimeout(() => { recentShortenerPopupTabs.delete(tab.id); }, 8000);
    });
}

if (chrome.tabs?.onRemoved) {
    chrome.tabs.onRemoved.addListener((tabId) => {
        lastDestinationByTab.delete(tabId);
        visitHistoryByTab.delete(tabId);
        patientTabs.delete(tabId);
        lastAdvertisedByTab.delete(tabId);
        recentShortenerPopupTabs.delete(tabId);
        persistTabState();
    });
}

// Streaming platforms with DRM protection
const STREAMING_DOMAINS = (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.STREAMING) ? KILLURL_SITES.STREAMING : [
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
// Note: MediaFire, Mega, Google Drive etc. are FINAL DESTINATIONS, NOT shorteners!
const SHORTENER_DOMAINS = (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.SHORTENERS) ? KILLURL_SITES.SHORTENERS : [
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
    'vplink.in', 'vplinks.in',
    // File hosting / download with timers (mediafire and mega REMOVED - they are destinations)
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
            const hostname = message.hostname ? message.hostname.replace(/^www\./, '').toLowerCase() : '';
            const isProt = typeof KILLURL_SITES !== 'undefined' ? KILLURL_SITES.isProtected(hostname) : false;
            const isFin = typeof KILLURL_SITES !== 'undefined' ? KILLURL_SITES.isFinal(hostname) : false;
            const isShortener = (!isProt && !isFin) ? isKnownShortener(hostname) : false;
            sendResponse({
                isShortener,
                isProtected: isProt,
                isFinal: isFin,
                domains: typeof KILLURL_SITES !== 'undefined' ? KILLURL_SITES.SHORTENERS : SHORTENER_DOMAINS
            });
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
                await restoreTabState();
                if (sender.tab && message.url) {
                    const destHost = hostOf(message.url);
                    const isShortener = (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isShortener) ? KILLURL_SITES.isShortener(destHost) : isKnownShortener(destHost);
                    const isErr = (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isErrorUrl) ? KILLURL_SITES.isErrorUrl(message.url) : false;

                    // Intermediate shorteners and error URLs are NEVER valid final destinations!
                    if (isShortener || isErr) {
                        console.log('[KillURL:BG] Discarding non-final destination candidate:', message.url);
                        sendResponse({ success: false });
                        return;
                    }

                    const isFinalDest = (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isValidFinalDestination) ? KILLURL_SITES.isValidFinalDestination(message.url) : false;
                    chrome.action.setBadgeText({ text: '!', tabId: sender.tab.id });
                    chrome.action.setBadgeBackgroundColor({ color: '#10b981', tabId: sender.tab.id });

                    if (isFinalDest) {
                        lastDestinationByTab.set(sender.tab.id, message.url);
                        await persistTabState();
                        // Auto-redirect only if this is an authentic final destination and autoRedirect is enabled
                        if (s.autoRedirect || message.autoRedirect) {
                            console.log('[KillURL] Auto-redirecting tab to authentic final destination:', message.url);
                            chrome.tabs.update(sender.tab.id, { url: message.url });
                        }
                    }
                }
                sendResponse({ success: true });
            })();
            return true;

        case 'RESOLVE_BYPASS':
            // Fast remote bypass resolution request from content script or popup
            (async () => {
                try {
                    const dest = await resolveShortenerUrl(message.url);
                    if (dest && !(typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isErrorUrl && KILLURL_SITES.isErrorUrl(dest))) {
                        if (sender.tab?.id) {
                            lastDestinationByTab.set(sender.tab.id, dest);
                            await persistTabState();
                        }
                        sendResponse({ success: true, destination: dest });
                        return;
                    }
                } catch (e) { /* ignore */ }
                sendResponse({ success: false });
            })();
            return true;

        case 'CHAIN_COMPLETED':
            // Destination reached — clean up tab state and set success badge
            (async () => {
                try {
                    await restoreTabState();
                    const tabId = sender.tab?.id;
                    if (tabId != null) {
                        lastDestinationByTab.delete(tabId);
                        visitHistoryByTab.delete(tabId);
                        patientTabs.delete(tabId);
                        await persistTabState();
                        try {
                            await chrome.action.setBadgeText({ text: '✓', tabId });
                            await chrome.action.setBadgeBackgroundColor({ color: '#10b981', tabId });
                        } catch (err) {}
                    }
                } catch (e) { /* ignore */ }
                sendResponse({ success: true });
            })();
            return true;

        case 'CHECK_ARRIVED':
            // "Am I the destination page?" — content script asks on every load.
            (async () => {
                let arrived = false;
                try {
                    await restoreTabState();
                    const tabId = sender.tab?.id;
                    const hereHost = hostOf(message.url);

                    // Error, penalty, or honeypot pages are NEVER an arrival!
                    if (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isErrorUrl && KILLURL_SITES.isErrorUrl(message.url)) {
                        sendResponse({ arrived: false, isError: true });
                        return;
                    }

                    // Known shorteners are NEVER an arrival!
                    if ((typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isShortener(hereHost)) || isKnownShortener(hereHost)) {
                        sendResponse({ arrived: false, isShortener: true });
                        return;
                    }

                    // 1. Direct check: Is this host in the FINAL list (MediaFire, Mega, Google Drive, etc.)?
                    if (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isFinal(hereHost)) {
                        // Double check that it's a real file download link and not an error page
                        if (!KILLURL_SITES.isErrorUrl(message.url)) {
                            arrived = true;
                            if (tabId != null) {
                                lastDestinationByTab.delete(tabId);
                                visitHistoryByTab.delete(tabId);
                                patientTabs.delete(tabId);
                                await persistTabState();
                                try {
                                    await chrome.action.setBadgeText({ text: '✓', tabId });
                                    await chrome.action.setBadgeBackgroundColor({ color: '#10b981', tabId });
                                } catch (err) {}
                            }
                            sendResponse({ arrived: true, isFinal: true });
                            return;
                        }
                    }

                    // 2. Remembered destination match
                    const remembered = (tabId != null) ? lastDestinationByTab.get(tabId) : null;
                    if (remembered && message.url && !KILLURL_SITES.isErrorUrl(remembered)) {
                        const destHost = hostOf(remembered);
                        if (destHost && hereHost && !isKnownShortener(hereHost)) {
                            const isMatch = (destHost === hereHost && pathIsPrefixOf(remembered, message.url)) ||
                                (typeof KILLURL_SITES !== 'undefined' && (KILLURL_SITES.isFinal(destHost) || KILLURL_SITES.isFinal(hereHost)));
                            if (isMatch) {
                                arrived = true;
                                lastDestinationByTab.delete(tabId);
                                if (exactUrlMatch(remembered, message.url) || (typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isFinal(hereHost))) {
                                    visitHistoryByTab.delete(tabId);
                                    patientTabs.delete(tabId);
                                }
                                await persistTabState();
                                if (tabId != null) {
                                    try {
                                        await chrome.action.setBadgeText({ text: '✓', tabId });
                                        await chrome.action.setBadgeBackgroundColor({ color: '#10b981', tabId });
                                    } catch (err) {}
                                }
                            }
                        }
                    }
                } catch (e) { /* ignore */ }
                sendResponse({ arrived });
            })();
            return true;

        case 'CHECK_LOOP':
            // HOST-SCOPED enforcement, never tab-scoped: the verdict is a
            // function of the CURRENT page's host only (seed list or learned
            // list), evaluated fresh on every load. A tab that bounced on one
            // host no longer forces patient behavior onto every other host in
            // the same tab — that blanket stickiness was the "protection in
            // wrong places" bug. Visit history is ALWAYS recorded (patient or
            // not) so bounces can be learned and arrivals stay detectable.
            (async () => {
                let loop = false;
                let learnedHit = false;
                let visits = 1;
                let hostVisits = 1;
                let required = null;
                let malleable = false;
                let strict = false;
                let bounces = 0;
                try {
                    await restoreTabState();
                    const tabId = sender.tab?.id;
                    if (tabId != null && message.url) {
                        const curHost = hostOf(message.url);

                        // 0. Resolve any in-flight malleability probe from the
                        // previous page in this tab. A FRESH step key means the
                        // backdated submit advanced the chain (verdict:
                        // malleable); landing on a seen key means it bounced
                        // (verdict: strict — deadline floor only from now on).
                        // Stale probes (>90s, stalled page) resolve to nothing.
                        try {
                            const probe = probeByTab.get(tabId);
                            if (probe && (Date.now() - probe.t) < PROBE_TTL_MS) {
                                const seenBefore = (() => {
                                    try {
                                        const h = visitHistoryByTab.get(tabId) || [];
                                        return h.some(e => e && e.key === loopKey(message.url));
                                    } catch (e) { return false; }
                                })();
                                if (!seenBefore) {
                                    await setHostExperiment(probe.host, 'malleable');
                                    console.log('[KillURL] Probe SUCCEEDED — aged tokens pass on', probe.host);
                                } else {
                                    await setHostExperiment(probe.host, 'strict');
                                    console.log('[KillURL] Probe FAILED (bounced) — strict deadline only on', probe.host);
                                }
                            }
                            probeByTab.delete(tabId);
                        } catch (e) { /* ignore */ }

                        // 1. Seed hosts / learned hosts: Fast Server-Timer Bypass mode
                        const learned = await getLearnedPatientHosts();
                        const entry = learned.find(e => curHost === e.h || curHost.endsWith('.' + e.h));
                        if (entry) {
                            loop = true;
                            learnedHit = true;
                            required = Math.min((typeof entry.s === 'number' && entry.s > 0) ? entry.s : 3, 4);
                            malleable = true;
                            strict = false;
                            bounces = entry.b || 0;
                        } else {
                            malleable = true;
                        }

                        // 2. Revisit detection (always recorded)
                        const now = Date.now();
                        const fresh = (hist) => (hist || []).filter(e => e && (now - e.t) < LOOP_WINDOW_MS).slice(-30);
                        let hist = fresh(visitHistoryByTab.get(tabId));
                        const cur = loopKey(message.url);
                        const prev = hist.filter(e => e.key === cur).length;
                        visits = prev + 1;
                        hist.push({ key: cur, t: now });
                        hist = hist.slice(-30);
                        visitHistoryByTab.set(tabId, hist);
                        hostVisits = hist.filter(e => e.key.startsWith(curHost + '/')).length;

                        // 3. Repeat bounce: keep tight 3-4s window, never lock into 25-120s stalls
                        if (prev >= 1) {
                            loop = true;
                            const failedAd = lastAdvertisedByTab.get(tabId);
                            let guess = (typeof failedAd === 'number' && failedAd > 0) ? Math.min(failedAd, 4) : 3;
                            lastAdvertisedByTab.delete(tabId);
                            await learnPatientHost(curHost, guess);
                            required = guess;
                            malleable = true;
                        }
                        await persistTabState();
                    }
                } catch (e) { /* ignore */ }
                sendResponse({ loop, learned: learnedHit, visits, hostVisits, required, malleable: true, strict: false, bounces });
            })();
            return true;

        case 'PROBE_STARTED':
            // A content script just fired a backdated (aged-token) submit.
            // Remember it so the NEXT CHECK_LOOP from this tab can score it:
            // fresh step = aged tokens pass (malleable), revisit = rejected.
            try {
                if (sender.tab?.id != null && message.host) {
                    probeByTab.set(sender.tab.id, { host: String(message.host), t: Date.now() });
                }
                sendResponse({ success: true });
            } catch (e) {
                try { sendResponse({ success: false }); } catch (err) { /* ignore */ }
            }
            return true;

        case 'RESET_LEARNED_PATIENT':
            (async () => {
                try {
                    await chrome.storage.local.remove(LEARNED_PATIENT_STORE);
                    patientTabs.clear();
                    try { await chrome.storage.session.remove('kuTabState'); } catch (e) { /* ignore */ }
                    console.log('[KillURL] Learned patient hosts cleared');
                } catch (e) { /* ignore */ }
                sendResponse({ success: true });
            })();
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
                    // Remember this step's advertised countdown. When a bounce
                    // lands next, THIS value is what the FAILED step required —
                    // the attribution used to learn the host's true wait.
                    if (typeof message.advertised === 'number' && message.advertised > 0) {
                        lastAdvertisedByTab.set(sender.tab.id, message.advertised);
                        persistTabState();
                    }
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
    // Check if a popup tab opened from a shortener navigated to an ad
    if (changeInfo.url && recentShortenerPopupTabs.has(tabId)) {
        if (isAdPopupUrl(changeInfo.url)) {
            console.log('[KillURL:BG] Closed deferred ad popup tab:', tabId, changeInfo.url.slice(0, 80));
            recentShortenerPopupTabs.delete(tabId);
            try { chrome.tabs.remove(tabId); } catch (e) { /* ignore */ }
            return;
        }
    }

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
                // Background remote bypass resolution in parallel
                resolveShortenerUrl(tab.url).then(async (dest) => {
                    if (dest && !(typeof KILLURL_SITES !== 'undefined' && KILLURL_SITES.isErrorUrl && KILLURL_SITES.isErrorUrl(dest))) {
                        lastDestinationByTab.set(tabId, dest);
                        await persistTabState();
                        try {
                            await chrome.tabs.sendMessage(tabId, {
                                type: 'RESOLVER_FOUND_DESTINATION',
                                url: dest
                            });
                        } catch (e) {}
                        if (currentSettings.autoRedirect || currentSettings.autoSkip) {
                            console.log('[KillURL] Auto-redirecting via remote bypass resolver:', dest);
                            chrome.tabs.update(tabId, { url: dest });
                        }
                    }
                }).catch(() => {});

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
