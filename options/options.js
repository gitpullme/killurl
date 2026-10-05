// KillURL Options Page Script

document.addEventListener('DOMContentLoaded', async () => {
    // Elements
    const enabledEl = document.getElementById('enabled');
    const autoSkip = document.getElementById('autoSkip');
    const autoRedirect = document.getElementById('autoRedirect');
    const showNotification = document.getElementById('showNotification');
    const aggressiveModeEl = document.getElementById('aggressiveMode');
    const removeAdBlockWallsEl = document.getElementById('removeAdBlockWalls');
    const adblockStealthEl = document.getElementById('adblockStealth');
    const screenShareDRMEl = document.getElementById('screenShareDRM');
    const skipDelay = document.getElementById('skipDelay');
    const enabledSites = document.getElementById('enabledSites');
    const customSites = document.getElementById('customSites');
    const customSitesRow = document.getElementById('customSitesRow');
    const siteGrid = document.getElementById('siteGrid');
    const siteCount = document.getElementById('siteCount');
    const saveBar = document.getElementById('saveBar');
    const saveBtn = document.getElementById('saveBtn');
    const resetBtn = document.getElementById('resetBtn');

    // Known shortener domains (from background)
    const SHORTENER_DOMAINS = [
        'bit.ly', 'bitly.com', 'tinyurl.com', 'goo.gl', 't.co',
        'ow.ly', 'is.gd', 'buff.ly', 'adf.ly', 'j.mp',
        'dlvr.it', 'ift.tt', 'db.tt',
        'adfoc.us', 'bc.vc', 'j.gs', 'q.gs',
        'shorte.st', 'sh.st', 'ouo.io', 'ouo.press',
        'za.gl', 'za.mn',
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
        'clicksfly.com',
        'fc-lc.com', 'fc.lc',
        'earnhub.net',
        'mboost.me',
        'short.io', 'rebrand.ly', 'rb.gy',
        'mcaf.ee', 'soo.gd', 'clck.ru',
        's.id', 'rotf.lol', 'shorturl.asia',
        'nitro-link.com', 'nitrolink.com'
    ];

    // Show real extension version
    try {
        const manifest = chrome.runtime.getManifest();
        const aboutVersion = document.getElementById('aboutVersion');
        if (aboutVersion && manifest?.version) aboutVersion.textContent = 'v' + manifest.version;
    } catch (e) { /* ignore */ }

    // Original settings for comparison
    let originalSettings = null;

    // ===== LOAD SETTINGS =====

    async function loadSettings() {
        const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (settings) {
            enabledEl.checked = settings.enabled !== false; // default ON
            autoSkip.checked = settings.autoSkip || false;
            autoRedirect.checked = settings.autoRedirect || false;
            showNotification.checked = settings.showNotification !== false;
            skipDelay.value = settings.skipDelay || 0;
            aggressiveModeEl.checked = settings.aggressiveMode || false;
            removeAdBlockWallsEl.checked = settings.removeAdBlockWalls || false;
            if (adblockStealthEl) adblockStealthEl.checked = settings.adblockStealth !== false;
            screenShareDRMEl.checked = settings.screenShareDRM || false;
            enabledSites.value = settings.enabledSites || 'all';
            customSites.value = (settings.customSites || []).join('\n');

            updateCustomSitesVisibility();
            originalSettings = JSON.stringify(getCurrentSettings());
        }
    }

    function getCurrentSettings() {
        return {
            enabled: enabledEl.checked,
            autoSkip: autoSkip.checked,
            autoRedirect: autoRedirect.checked,
            showNotification: showNotification.checked,
            aggressiveMode: aggressiveModeEl.checked,
            removeAdBlockWalls: removeAdBlockWallsEl.checked,
            adblockStealth: adblockStealthEl ? adblockStealthEl.checked : true,
            screenShareDRM: screenShareDRMEl.checked,
            skipDelay: parseInt(skipDelay.value) || 0,
            enabledSites: enabledSites.value,
            customSites: customSites.value
                .split('\n')
                .map(s => s.trim().toLowerCase())
                .filter(s => s.length > 0)
        };
    }

    // ===== POPULATE SITE GRID =====

    function populateSiteGrid() {
        siteCount.textContent = `${SHORTENER_DOMAINS.length}+`;
        siteGrid.innerHTML = '';

        // Show popular ones
        const popular = [...new Set(SHORTENER_DOMAINS)].sort();
        popular.forEach(domain => {
            const tag = document.createElement('span');
            tag.className = 'site-tag';
            tag.textContent = domain;
            siteGrid.appendChild(tag);
        });
    }

    // ===== CHANGE DETECTION =====

    function checkChanges() {
        const current = JSON.stringify(getCurrentSettings());
        if (current !== originalSettings) {
            saveBar.classList.add('visible');
        } else {
            saveBar.classList.remove('visible');
        }
    }

    // ===== CUSTOM SITES VISIBILITY =====

    function updateCustomSitesVisibility() {
        if (enabledSites.value === 'custom') {
            customSitesRow.style.display = 'flex';
        } else {
            customSitesRow.style.display = 'none';
        }
    }

    // ===== EVENT LISTENERS =====

    // All inputs trigger change detection
    [enabledEl, autoSkip, autoRedirect, showNotification, aggressiveModeEl, removeAdBlockWallsEl, screenShareDRMEl].forEach(el => {
        el.addEventListener('change', checkChanges);
    });
    if (adblockStealthEl) adblockStealthEl.addEventListener('change', checkChanges);

    [skipDelay, customSites].forEach(el => {
        el.addEventListener('input', checkChanges);
    });

    enabledSites.addEventListener('change', () => {
        updateCustomSitesVisibility();
        checkChanges();
    });

    // Save
    saveBtn.addEventListener('click', async () => {
        const settings = getCurrentSettings();
        await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
        originalSettings = JSON.stringify(settings);
        saveBar.classList.remove('visible');

        // Flash effect
        saveBtn.textContent = '✓ Saved!';
        saveBtn.style.background = 'linear-gradient(135deg, #34d399, #6ee7b7)';
        setTimeout(() => {
            saveBtn.textContent = 'Save Settings';
            saveBtn.style.background = '';
        }, 1500);
    });

    // Reset
    resetBtn.addEventListener('click', () => {
        loadSettings();
        saveBar.classList.remove('visible');
    });

    // ===== INIT =====
    await loadSettings();
    populateSiteGrid();
});
