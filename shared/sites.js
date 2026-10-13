// KillURL shared site lists — loaded by the background worker, the content
// script and the options page so every part of the extension agrees on
// WHERE it is allowed to act.
//
// Roles:
//   'custom'    — user-added site (Options → Custom Sites)
//   'shortener' — known URL shortener / earn-link host → auto-skip allowed
//   'final'     — a real destination (file host etc.) → chain ends, NEVER act
//   'protected' — major site (Discord, Google, YouTube…) → NEVER act
//   'unknown'   — anything else → only acts when reached THROUGH a shortener
//                 in the same tab (a redirect "step" page), never on its own

(function (root) {
    'use strict';
    if (root.KILLURL_SITES) return;

    const SHORTENERS = [
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
        // File hosts WITH download timers (mediafire / mega are destinations,
        // see FINAL below — they must never be "skipped")
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
        'techmint.in',
        'bcsakhi.in',
        'educatestudies.com',
        'studyinsurances.com',
        'rupeeriser.in',
        'studyeducates.com',
        'studyeducations.com',
        'insurancesstudy.com',
        // Nitro / earn-link clones (multi-step timer + token-form flow)
        'nitro-link.com',
        'nitrolink.com', 'nitro-links.com', 'nitroshare.site',
    ];

    // Real destinations. Reaching one ENDS the shortener chain: the extension
    // stands down completely (no clicks — e.g. never auto-press MediaFire's
    // Download button) and resets the tab's loop memory.
    const FINAL = [
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

    // Major sites where KillURL must never act on its own (it ran on these
    // before and pressed random Download / Continue buttons).
    const PROTECTED = [
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

    // Streaming sites — only the opt-in screen-share DRM helper may run here.
    const STREAMING = [
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

    // Shorteners with server-side checks: handled via proactive token aging,
    // request timestamp spoofing, and bypass resolver APIs for instant skips (never slow-down).
    const PATIENT_SEED = [];

    // Shorteners requiring Cloudflare Turnstile / Captcha verification before destination release.
    // MAIN-world scripts (injector.js) MUST NEVER touch these domains so that the environment
    // remains 100% byte-native, allowing Turnstile to verify without "Verification failed" errors.
    const CAPTCHA_SHORTENER = [
        'vplink.in', 'vplinks.in'
    ];

    function normHost(h) {
        return String(h || '').toLowerCase().trim().replace(/^www\./, '').replace(/\.$/, '');
    }

    function inList(host, list) {
        host = normHost(host);
        if (!host) return false;
        for (const d of list) {
            if (host === d || host.endsWith('.' + d)) return true;
        }
        return false;
    }

    // Normalize user-entered custom sites ("https://www.Foo.com/path" → "foo.com").
    function normCustom(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const raw of list) {
            let s = String(raw || '').trim().toLowerCase();
            if (!s) continue;
            s = s.replace(/^[a-z]+:\/\//, '').split(/[\/?#]/)[0].split(':')[0];
            s = normHost(s);
            if (s) out.push(s);
        }
        return out;
    }

    function classify(host, customSites) {
        host = normHost(host);
        if (!host) return 'unknown';
        if (inList(host, normCustom(customSites))) return 'custom';
        if (inList(host, FINAL)) return 'final';
        if (inList(host, PROTECTED)) return 'protected';
        if (inList(host, SHORTENERS)) return 'shortener';
        return 'unknown';
    }

    function hostOfUrl(url) {
        try { return normHost(new URL(url).hostname); } catch (e) { return ''; }
    }

    const ERROR_URL_RE = /(?:error\.php|\berrno=\d+|\borigin=download|\berror_code=\d+|\b(?:404|403|500)\.html?|\/404(?:\/|\.|$|\?)|bypass\.vip|discord\.(?:gg|com)|(?:invalid[_-]?token|session[_-]?expired|token[_-]?expired|link[_-]?expired|blocked|suspended|cheating))/i;

    function isErrorUrl(url) {
        if (!url) return true;
        try {
            const s = String(url).trim();
            if (ERROR_URL_RE.test(s)) return true;
            const u = new URL(s);
            const host = normHost(u.hostname);
            const full = u.pathname + u.search + u.hash;

            // MediaFire specific validation
            if (host === 'mediafire.com' || host.endsWith('.mediafire.com')) {
                // Must have a valid download/file/folder/view key
                if (/(?:error\.php|\berrno=\d+|\borigin=download|upgrade_support\.php|terms_of_service)/i.test(full)) return true;
                // Honeypot / poisoned decoy links generated by shorteners have fake random suffixes (e.g. /rnji, /hlos) instead of /file
                if (/\/(?:file|download)\/[a-zA-Z0-9_-]+\/[^\/]+\/(?!file(?:[\/?#]|$))[^\/?#]+/i.test(full)) return true;
                return !(/\/(?:file|download|folder|view)\/[a-zA-Z0-9_-]{4,}|\/\?[a-zA-Z0-9_-]{5,}/i.test(full));
            }
            // Mega specific validation
            if (host === 'mega.nz' || host === 'mega.io') {
                return !(/\/(?:file|folder)\/[a-zA-Z0-9_-]{6,}|#[!a-zA-Z0-9_-]{8,}/i.test(full));
            }
            // Google Drive specific validation
            if (host === 'drive.google.com') {
                return !(/\/(?:file\/d\/|drive\/folders\/|open\?id=|uc\?id=)[a-zA-Z0-9_-]{10,}/i.test(full));
            }
            return false;
        } catch (e) {
            return true;
        }
    }

    function isValidFinalDestination(url) {
        if (!url || isErrorUrl(url)) return false;
        const host = hostOfUrl(url);
        return inList(host, FINAL);
    }

    root.KILLURL_SITES = Object.freeze({
        SHORTENERS, FINAL, PROTECTED, STREAMING, PATIENT_SEED, CAPTCHA_SHORTENER,
        normHost, inList, normCustom, classify, hostOfUrl,
        isErrorUrl, isValidFinalDestination,
        isShortener: (h) => inList(h, SHORTENERS),
        isFinal: (h) => inList(h, FINAL),
        isProtected: (h) => inList(h, PROTECTED),
        isStreaming: (h) => inList(h, STREAMING),
        isCaptchaShortener: (h) => inList(h, CAPTCHA_SHORTENER),
    });
})(typeof globalThis !== 'undefined' ? globalThis : self);
