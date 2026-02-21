console.log("Netflix Language Learning Extension Loaded");

// --- Global State ---
let player = null;
let currentCues = [];
let interceptedCues = [];
let registeredLangs = {}; // Object: { bcp47: { selected: boolean, displayName: string } }
// Multi-sub is now automatic based on registeredLangs state
let lastPrimaryLang = null; // Track primary language to detect changes

let activeVideoId = null;

// Timer References
let initInterval = null;
let sessionInterval = null;
let controlLoop = null;

// Loop State
let loopState = {
    active: false,
    remaining: 0,
    cue: null
};

// Sentence Mode State
let sentencePaused = false;
let sentenceLastCue = null;
let lastPlaybackTime = null;
let lastTimeCheckAt = 0;

// Settings State
let subStyle = {
    fontSize: 22,
    color: '#ffffff',
    colorAlt: '#9ad7ff',
    textOpacity: 1,
    opacity: 0.6,
    bottom: 15, // Acts as "Vertical Margin %"
    repeatCount: 1,
    multiSubEnabled: true,
    sentenceMode: false,
    langOrder: [],
    hAlign: 'center', // left, center, right (text alignment)
    vAlign: 'top',     // top, center, bottom
    hPosition: 50,    // Horizontal position 0-100 (0=left, 50=center, 100=right)
    width: 80         // Box width 10-100 (%)
};

// Load settings
try {
    const saved = localStorage.getItem('netflix-ssam-settings');
    if (saved) {
        const parsed = JSON.parse(saved);
        subStyle = { ...subStyle, ...parsed }; // Merge to ensure new keys exist
    }
} catch (e) { }

// --- Platform Interceptors (provided by adapter) ---

// --- Helper ---

// Extract language code from subtitle URL
function extractLangFromUrl(url) {
    try {
        // Try to parse URL parameters
        const urlObj = new URL(url);

        // Check common language params
        const langParam =
            urlObj.searchParams.get('lang') ||
            urlObj.searchParams.get('bcp47') ||
            urlObj.searchParams.get('language') ||
            urlObj.searchParams.get('locale');
        if (langParam) {
            const cleaned = normalizeLangToken(langParam);
            if (cleaned) return cleaned;
        }

        // Check for language code in path (e.g., /ko-KR/, /en-US/)
        const pathMatch = url.match(/\/([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)\//);
        if (pathMatch) {
            const cleaned = normalizeLangToken(pathMatch[1]);
            if (cleaned) return cleaned;
        }

        // Check for language code in query string without proper parsing
        const langMatch = url.match(/[?&](?:lang|bcp47|language|locale)=([^&]+)/);
        if (langMatch) {
            const cleaned = normalizeLangToken(langMatch[1]);
            if (cleaned) return cleaned;
        }

        // Check for bcp47 or similar parameter
        const bcp47Match = url.match(/[?&](?:bcp47|language)=([^&]+)/);
        if (bcp47Match) {
            const cleaned = normalizeLangToken(bcp47Match[1]);
            if (cleaned) return cleaned;
        }

    } catch (e) {
        // URL parsing failed, try regex patterns
    }

    return null;
}

function normalizeLangToken(token) {
    if (!token) return null;
    let t = token;
    try {
        t = decodeURIComponent(t);
    } catch (e) { }

    // Normalize separators and remove common suffixes
    t = t.replace(/_/g, '-').replace(/\.xml$/i, '').trim();
    if (!t) return null;

    // If multiple values are provided, prefer the first
    if (t.includes(',')) t = t.split(',')[0].trim();

    // Validate against a loose BCP47-like pattern (supports "ko", "es-419", "zh-Hans", "pt-BR", etc.)
    const match = t.match(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
    if (!match) return null;

    return canonicalizeBcp47(t);
}

function canonicalizeBcp47(tag) {
    const parts = tag.split('-').filter(Boolean);
    if (parts.length === 0) return tag;

    const out = [];
    // Language subtag: lower
    out.push(parts[0].toLowerCase());

    for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (p.length === 4) {
            // Script subtag: Title Case
            out.push(p[0].toUpperCase() + p.slice(1).toLowerCase());
        } else if (p.length === 2 || (p.length === 3 && /^\d+$/.test(p))) {
            // Region subtag: upper (2 letters or 3 digits)
            out.push(p.toUpperCase());
        } else {
            // Variant/extension: lower
            out.push(p.toLowerCase());
        }
    }

    return out.join('-');
}

function processSubtitleText(url, text) {
    // Check for TTML/DFXP structure
    if (text.includes('<tt') || text.includes('<p begin=')) {
        const cues = parseXMLCues(text);
        if (cues.length > 0) {
            // Try to extract language from URL first
            let lang = extractLangFromUrl(url);

            // If not found in URL, try to get from current player state
            if (!lang && player) {
                const track = player.getTimedTextTrack();
                if (track && track.bcp47 && track.bcp47 !== 'off') {
                    lang = canonicalizeBcp47(track.bcp47);
                }
            }

            // Fallback to 'unknown'
            if (!lang) {
                lang = 'unknown';
            } else if (lang !== 'unknown') {
                lang = canonicalizeBcp47(lang);
            }

            // Create a simple content hash with timings for duplicate detection
            // Timings are included so if an ad shifts the timeline, we re-parse the new subtitles
            const contentHash = cues.slice(0, 5).map(c => `${c.start}-${c.end}-${c.text}`).join('|');

            // Check for duplicates by language and content hash
            const langNorm = (lang && lang !== 'unknown') ? canonicalizeBcp47(lang) : 'unknown';
            const existing = interceptedCues.find(ic =>
                ic.videoId === activeVideoId &&
                ((ic.lang && canonicalizeBcp47(ic.lang) === langNorm) || (ic.lang === 'unknown' && langNorm === 'unknown')) &&
                ic.contentHash === contentHash
            );

            if (!existing) {
                interceptedCues.push({
                    url: url,
                    cues: cues,
                    lang: langNorm,
                    contentHash: contentHash,
                    timestamp: Date.now(),
                    videoId: activeVideoId
                });
                console.log(`[Ext] Parsed ${cues.length} cues. Language: ${lang}`);

                // Set as active cues if this is the first subtitle or current player language matches
                const currentTrackLang = player && player.getTimedTextTrack()?.bcp47
                    ? canonicalizeBcp47(player.getTimedTextTrack().bcp47)
                    : null;
                if (currentCues.length === 0 || (currentTrackLang && currentTrackLang === langNorm)) {
                    currentCues = cues;
                    // If sentence mode is enabled and we were waiting for cues, reset state
                    if (subStyle.sentenceMode) {
                        sentencePaused = false;
                        sentenceLastCue = null;
                    }
                    console.log("[Ext] Set active cues.");
                    // Toast notification removed - too intrusive
                }
            } else {
                console.log(`[Ext] Duplicate subtitle ignored for language: ${lang}`);
            }
        }
    }
}

// --- Interaction ---
function showToast(msg) {
    // Remove existing toast
    const existing = document.getElementById('netflix-ext-toast');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.id = 'netflix-ext-toast';
    div.innerText = msg;
    div.style.position = 'fixed';
    div.style.top = '10%';
    div.style.left = '50%';
    div.style.transform = 'translate(-50%, 0)';
    div.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    div.style.color = 'white';
    div.style.padding = '10px 20px';
    div.style.borderRadius = '5px';
    div.style.zIndex = '999999';
    div.style.fontSize = '24px';
    div.style.pointerEvents = 'none';
    div.style.transition = 'opacity 0.5s';
    div.style.whiteSpace = 'pre-line'; // Preserve line breaks
    document.body.appendChild(div);

    setTimeout(() => {
        div.style.opacity = '0';
        setTimeout(() => div.remove(), 500);
    }, 2000);
}


// --- Initialization & State Management ---

// Platform-specific init handled by adapter

function resetExtensionState() {
    console.log("[Ext] Resetting State...");

    if (initInterval) clearInterval(initInterval);
    if (sessionInterval) clearInterval(sessionInterval);
    if (controlLoop) clearInterval(controlLoop);
    initInterval = null;
    sessionInterval = null;
    controlLoop = null;

    player = null;

    currentCues = [];
    interceptedCues = [];
    registeredLangs = {};
    lastPrimaryLang = null;
    loopState = { active: false, remaining: 0, cue: null };
    sentencePaused = false;
    sentenceLastCue = null;

    window.removeEventListener('keydown', handleKeyDown, true);
    document.removeEventListener('fullscreenchange', handleFullscreenChange);

    const overlay = document.getElementById('netflix-ext-multisub');
    if (overlay) overlay.remove();
    const settings = document.getElementById('netflix-ext-settings');
    if (settings) settings.remove();
    const langList = document.getElementById('netflix-ext-lang-list');
    if (langList) langList.remove();
}

function handleFullscreenChange() {
    // Ensure overlays follow the fullscreen container
    const targetParent = document.fullscreenElement || document.body;
    const ids = ['netflix-ext-lang-list', 'netflix-ext-settings', 'netflix-ext-multisub'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.parentElement !== targetParent) {
            targetParent.appendChild(el);
        }
    });
}

// Platform-specific player/session discovery handled by adapter

function initEvents() {
    window.addEventListener('keydown', handleKeyDown, true); // Use capture phase
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    console.log("Listeners attached.");
}

function setPlayer(p) {
    player = p;
    if (!player) return;
    window.removeEventListener('keydown', handleKeyDown, true);
    initEvents();
    if (controlLoop) clearInterval(controlLoop);
    controlLoop = setInterval(runControlLoop, 100);
}

function handleVideoChange(newId) {
    if (newId === activeVideoId) return;
    console.log(`[Ext] Video Change Detected: ${activeVideoId} -> ${newId}`);
    activeVideoId = newId;
    resetExtensionState();
}

function runControlLoop() {
    if (!player) return;

    detectTimeJump();

    if (typeof registerCurrentLanguage === 'function') {
        registerCurrentLanguage();
    }

    // Update multi-sub overlay (automatic based on badge states)
    updateMultiSubOverlay();

    handleSentenceMode();

    if (loopState.active && loopState.cue) {
        const t = player.getCurrentTime();
        if (t > loopState.cue.end) {
            if (loopState.remaining > 0) {
                console.log(`Looping... Remaining: ${loopState.remaining}`);
                player.seek(loopState.cue.start);
                loopState.remaining--;
                showToast(`Loop: ${loopState.remaining + 1} left`);
            } else {
                loopState.active = false;
                console.log("Loop finished.");
            }
        }
    }
}

function detectTimeJump() {
    const now = Date.now();
    if (now - lastTimeCheckAt < 200) return;
    lastTimeCheckAt = now;

    const t = player.getCurrentTime();
    if (lastPlaybackTime === null) {
        lastPlaybackTime = t;
        return;
    }

    const delta = t - lastPlaybackTime;
    lastPlaybackTime = t;

    // Detect large forward/backward jumps (e.g., ads or seeking)
    if (Math.abs(delta) >= 5) {
        console.log(`[Ext] Time jump detected (${delta.toFixed(2)}s). Resetting cues.`);
        currentCues = [];
        sentencePaused = false;
        sentenceLastCue = null;
    }
}


function handleKeyDown(e) {
    if (!player) return;

    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    const code = e.code;
    let handled = false;

    switch (code) {
        case 'KeyA':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            seekToSubtitle(-1);
            handled = true;
            break;
        case 'KeyS':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            seekToSubtitle(0);
            handled = true;
            break;
        case 'KeyD':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (subStyle.sentenceMode && sentencePaused) {
                resumeNextSentence();
            } else {
                seekToSubtitle(1);
            }
            handled = true;
            break;
        case 'KeyW':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            toggleLanguage();
            handled = true;
            break;
        // case 'KeyQ': Favorite feature removed, using registeredLangs instead
        // case 'KeyE': Multi-sub is now automatic
        case 'KeyO':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            toggleSettings();
            handled = true;
            break;

        case 'KeyJ':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            adjustSpeed(-0.25);
            handled = true;
            break;
        case 'KeyK':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            resetSpeed();
            handled = true;
            break;
        case 'KeyL':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            adjustSpeed(0.25);
            handled = true;
            break;
        case 'KeyC':
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            exportSubtitlesToClipboard();
            handled = true;
            break;
    }

    if (handled) {
        return false; // Additional blocking
    }
}

// --- Features ---

function adjustSpeed(delta) {
    // Try using Netflix Player API first
    if (player && typeof player.setPlaybackRate === 'function') {
        try {
            const currentRate = player.getPlaybackRate();
            let newRate = currentRate + delta;
            if (newRate < 0.25) newRate = 0.25;
            if (newRate > 5.0) newRate = 5.0;
            player.setPlaybackRate(newRate);
            showToast(`Speed: ${newRate.toFixed(2)}x`);
            return;
        } catch (e) {
            console.error('[Ext] Player API setPlaybackRate failed:', e);
        }
    }

    // Fallback to direct video element manipulation
    const video = document.querySelector('video');
    if (video) {
        const currentRate = video.playbackRate;
        let newRate = currentRate + delta;
        if (newRate < 0.25) newRate = 0.25;
        if (newRate > 5.0) newRate = 5.0;
        video.playbackRate = newRate;
        showToast(`Speed: ${newRate.toFixed(2)}x`);
    }
}

function resetSpeed() {
    // Try using Netflix Player API first
    if (player && typeof player.setPlaybackRate === 'function') {
        try {
            player.setPlaybackRate(1.0);
            showToast("Speed: 1.0x");
            return;
        } catch (e) {
            console.error('[Ext] Player API setPlaybackRate failed:', e);
        }
    }

    // Fallback to direct video element manipulation
    const video = document.querySelector('video');
    if (video) {
        video.playbackRate = 1.0;
        showToast("Speed: 1.0x");
    }
}

function exportSubtitlesToClipboard() {
    if (interceptedCues.length === 0) {
        showToast('No subtitles loaded');
        return;
    }

    // Collect all unique timestamps and organize cues by language
    const timeMap = new Map(); // timestamp -> { lang1: text, lang2: text, ... }
    const languages = new Set();

    interceptedCues.forEach(ic => {
        const lang = ic.lang || 'unknown';
        languages.add(lang);

        ic.cues.forEach(cue => {
            const timeKey = `${cue.start.toFixed(3)}-${cue.end.toFixed(3)}`;

            if (!timeMap.has(timeKey)) {
                timeMap.set(timeKey, {
                    start: cue.start,
                    end: cue.end,
                    texts: {}
                });
            }

            timeMap.get(timeKey).texts[lang] = cue.text.replace(/\n/g, ' ').replace(/\t/g, ' ');
        });
    });

    // Sort languages for consistent column order
    const sortedLangs = Array.from(languages).sort();

    // Build TSV header
    let tsv = 'Start\tEnd\t' + sortedLangs.join('\t') + '\n';

    // Sort by start time and build rows
    const sortedEntries = Array.from(timeMap.values()).sort((a, b) => a.start - b.start);

    sortedEntries.forEach(entry => {
        const startTime = formatTime(entry.start);
        const endTime = formatTime(entry.end);

        const row = [startTime, endTime];
        sortedLangs.forEach(lang => {
            row.push(entry.texts[lang] || '');
        });

        tsv += row.join('\t') + '\n';
    });

    // Copy to clipboard
    navigator.clipboard.writeText(tsv).then(() => {
        const langList = sortedLangs.join(', ');
        showToast(`Copied ${sortedEntries.length} subtitles\nLanguages: ${langList}`);
        console.log('[Ext] Exported subtitles to clipboard:', sortedEntries.length, 'rows');
    }).catch(err => {
        console.error('[Ext] Failed to copy to clipboard:', err);
        showToast('Failed to copy to clipboard');
    });
}

function formatTime(milliseconds) {
    const totalSeconds = milliseconds / 1000;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = (totalSeconds % 60).toFixed(3);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.padStart(6, '0')}`;
}

function isAdPlaying() {
    if (!player) return false;
    return document.querySelector('[data-uia^="ad-"]') !== null ||
        document.querySelector('[data-uia="ads-info-text"]') !== null ||
        document.querySelector('.ad-break-container') !== null ||
        document.querySelector('.PlayerControlsNeo__ad-container') !== null ||
        document.querySelector('.ad-timer') !== null ||
        (player.getDuration && player.getDuration() < 120000); // Usually ads are short (< 2 min)
}

// Helper function to check if multi-sub should be shown
function shouldShowMultiSub() {
    if (!player) return false;
    if (!subStyle.multiSubEnabled) return false;

    // Detect if an ad is currently playing using common Netflix ad DOM elements
    if (isAdPlaying()) return false;

    // Use lastPrimaryLang instead of querying player
    // This ensures Multi-Sub shows selected languages even when subtitles are off
    const currentLang = lastPrimaryLang;

    // Check if any registered language (except primary) is selected for Multi-Sub
    return Object.keys(registeredLangs).some(lang => {
        return lang !== currentLang && registeredLangs[lang].selected;
    });
}

function updateMultiSubOverlay() {
    // Check if multi-sub should be shown (automatic based on badge states)
    if (!shouldShowMultiSub()) {
        // Hide overlay if no enabled secondary languages
        const overlay = document.getElementById('netflix-ext-multisub');
        if (overlay) {
            overlay.style.display = 'none';
        }
        return;
    }

    if (!player) return;

    let overlay = document.getElementById('netflix-ext-multisub');
    const targetContainer = document.fullscreenElement || document.body;

    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'netflix-ext-multisub';
        overlay.style.position = 'fixed';
        overlay.style.zIndex = '2147483647'; // Max z-index
        overlay.style.pointerEvents = 'none';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.gap = '4px';
        targetContainer.appendChild(overlay);
    } else {
        // Ensure it's in the correct container (moves it if needed)
        if (overlay.parentElement !== targetContainer) {
            targetContainer.appendChild(overlay);
        }
    }

    overlay.style.display = 'flex';
    overlay.style.width = `${subStyle.width}%`;

    // --- Horizontal Position ---
    // 0% = left edge, 50% = center, 100% = right edge
    overlay.style.left = `${subStyle.hPosition}%`;
    overlay.style.right = 'auto';
    const yTransform = (subStyle.vAlign === 'center') ? '-50%' : '0';
    overlay.style.transform = `translate(${-subStyle.hPosition}%, ${yTransform})`;

    // --- Vertical Alignment ---
    // subStyle.bottom acts as "Margin from Edge"
    // If Top Align: Margin from Top. If Bottom Align: Margin from Bottom.
    if (subStyle.vAlign === 'bottom') {
        overlay.style.top = 'auto';
        overlay.style.bottom = `${subStyle.bottom}%`;
        overlay.style.flexDirection = 'column-reverse'; // Grow upwards
    } else if (subStyle.vAlign === 'center') {
        overlay.style.top = '50%';
        overlay.style.bottom = 'auto';
        overlay.style.flexDirection = 'column'; // Grow downwards
    } else {
        // TOP (default)
        // If user wants it roughly at the same place as before (15% bottom -> 85% top)
        // We should interpret 'bottom' param carefully if we want backwards compat visually.
        // BUT, keeping it simple: value is always "Margin from chosen edge".
        overlay.style.top = `${subStyle.bottom}%`;
        overlay.style.bottom = 'auto';
        overlay.style.flexDirection = 'column'; // Grow downwards
    }

    // --- Horizontal Alignment ---
    overlay.style.textAlign = subStyle.hAlign; // left, center, right
    if (subStyle.hAlign === 'left') overlay.style.alignItems = 'flex-start';
    else if (subStyle.hAlign === 'right') overlay.style.alignItems = 'flex-end';
    else overlay.style.alignItems = 'center';


    if (typeof overlay.replaceChildren === 'function') {
        overlay.replaceChildren();
    } else {
        while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
    }

    const currentTime = player.getCurrentTime();
    const langToText = new Map();

    // Use lastPrimaryLang to determine which language to exclude from overlay
    const currentLang = lastPrimaryLang || 'unknown';

    interceptedCues.forEach((ic) => {
        if (ic.videoId !== activeVideoId) return;
        // Skip if this is the currently displayed language
        const icLangNorm = (ic.lang && ic.lang !== 'unknown') ? canonicalizeBcp47(ic.lang) : 'unknown';
        if (icLangNorm !== 'unknown' && icLangNorm === currentLang) return;

        // Filter by registered & enabled
        // Special case: Allow 'unknown' cues to be shown if there are registered languages
        // This handles the case where cues loaded before language detection
        const reg = registeredLangs[icLangNorm];

        // Show if: (1) registered AND selected, OR (2) unknown AND we have other registered languages
        const shouldShow = (reg && reg.selected) ||
            (icLangNorm === 'unknown' && Object.keys(registeredLangs).length > 0);

        if (!shouldShow) return;

        const cue = ic.cues.find(c => currentTime >= c.start && currentTime <= c.end);
        if (cue && cue.text) {
            const text = cue.text.trim();

            try {
                const nativeTextElements = document.querySelectorAll('.player-timedtext-text-container span');
                let nativeText = "";
                nativeTextElements.forEach(el => {
                    if (el && el.innerText) {
                        nativeText += el.innerText + " ";
                    }
                });

                // Skip if this text matches the native subtitle (meaning it's the same language)
                const nativeTrimmed = nativeText.trim();
                if (nativeTrimmed && (nativeText.includes(text) || text.includes(nativeTrimmed))) {
                    // If this was marked as 'unknown', we can now tag it
                    if (icLangNorm === 'unknown' && currentLang !== 'unknown') {
                        ic.lang = currentLang;
                        console.log(`[Ext] Auto-tagged 'unknown' cues as ${currentLang} (matched native text)`);
                    }
                    return;
                }
            } catch (e) {
                // DOM structure might have changed, continue anyway
                console.debug("[Ext] DOM selector warning:", e);
            }

            if (!langToText.has(icLangNorm)) {
                langToText.set(icLangNorm, text);
            }
        }
    });

    const activeLangs = Array.from(langToText.keys());
    const regOrder = getOrderedLangs();
    activeLangs.sort((a, b) => {
        const ai = regOrder.indexOf(a);
        const bi = regOrder.indexOf(b);
        const aRank = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
        const bRank = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
        if (aRank !== bRank) return aRank - bRank;
        return a.localeCompare(b);
    });

    activeLangs.forEach((lang, idx) => {
        const text = langToText.get(lang);
        if (!text) return;
        const p = document.createElement('p');
        p.innerText = text;
        p.style.margin = '0';
        p.style.padding = '4px 8px';
        p.style.backgroundColor = `rgba(0,0,0,${subStyle.opacity})`;
        const baseColor = (idx % 2 === 0) ? subStyle.color : subStyle.colorAlt;
        p.style.color = colorWithOpacity(baseColor, subStyle.textOpacity);
        p.style.fontSize = `${subStyle.fontSize}px`;
        p.style.fontWeight = 'bold';
        p.style.borderRadius = '4px';
        p.style.textShadow = '1px 1px 2px black, -1px -1px 2px black';
        p.style.whiteSpace = 'pre-line'; // Preserve line breaks
        overlay.appendChild(p);
    });
}

function toggleSettings() {
    let settings = document.getElementById('netflix-ext-settings');
    if (settings) {
        settings.remove();
        return;
    }

    const targetParent = document.fullscreenElement || document.body;
    settings = document.createElement('div');
    settings.id = 'netflix-ext-settings';
    settings.style.position = 'fixed';
    settings.style.top = '50%';
    settings.style.transform = 'translateY(-50%)';
    settings.style.right = '20px';
    settings.style.backgroundColor = 'rgba(0,0,0,0.9)';
    settings.style.padding = '20px';
    settings.style.borderRadius = '8px';
    settings.style.color = 'white';
    settings.style.zIndex = '2147483647';
    settings.style.display = 'flex';
    settings.style.flexDirection = 'column';
    settings.style.gap = '10px';
    settings.style.minWidth = '250px';
    settings.style.maxWidth = '90vw';
    settings.style.maxHeight = '90vh';
    settings.style.overflowY = 'auto';
    settings.style.overflowX = 'hidden';
    settings.style.boxShadow = '0 0 10px rgba(0,0,0,0.5)';

    const title = document.createElement('h3');
    title.innerText = "Multi-Sub Settings";
    title.style.margin = '0 0 10px 0';
    title.style.color = '#fff';
    settings.appendChild(title);

    addSetting(settings, 'Font Size (px)', 'number', subStyle.fontSize, (val) => {
        subStyle.fontSize = parseInt(val);
        saveSettings();
    });

    addCheckbox(settings, 'Sentence Mode (Auto Pause)', subStyle.sentenceMode, (checked) => {
        subStyle.sentenceMode = checked;
        if (!checked) {
            sentencePaused = false;
            sentenceLastCue = null;
        }
        saveSettings();
    });

    addCheckbox(settings, 'Multi-Sub Enabled', subStyle.multiSubEnabled, (checked) => {
        subStyle.multiSubEnabled = checked;
        saveSettings();
        updateMultiSubOverlay();
    });

    addSetting(settings, 'Text Color', 'color', subStyle.color, (val) => {
        subStyle.color = val;
        saveSettings();
    });

    addSetting(settings, 'Text Color 2', 'color', subStyle.colorAlt, (val) => {
        subStyle.colorAlt = val;
        saveSettings();
    });

    addSetting(settings, 'Text Opacity (0-1)', 'range', subStyle.textOpacity, (val) => {
        subStyle.textOpacity = parseFloat(val);
        saveSettings();
    }, 0, 1, 0.05);

    addSetting(settings, 'Opacity (0-1)', 'range', subStyle.opacity, (val) => {
        subStyle.opacity = parseFloat(val);
        saveSettings();
    }, 0, 1, 0.1);

    addSetting(settings, 'Vertical Margin (%)', 'range', subStyle.bottom, (val) => {
        subStyle.bottom = parseInt(val);
        saveSettings();
    }, 0, 90, 1);

    // Horizontal Align (Select)
    addSelect(settings, 'Horizontal Align', subStyle.hAlign, ['left', 'center', 'right'], (val) => {
        subStyle.hAlign = val;
        saveSettings();
    });

    // Vertical Align (Select)
    addSelect(settings, 'Vertical Align', subStyle.vAlign, ['top', 'center', 'bottom'], (val) => {
        subStyle.vAlign = val;
        saveSettings();
    });

    addSetting(settings, 'Horizontal Position (%)', 'range', subStyle.hPosition, (val) => {
        subStyle.hPosition = parseInt(val);
        saveSettings();
    }, 0, 100, 1);

    addSetting(settings, 'Box Width (%)', 'range', subStyle.width, (val) => {
        subStyle.width = parseInt(val);
        saveSettings();
    }, 10, 100, 1);

    addSetting(settings, 'Repeat Count', 'number', subStyle.repeatCount, (val) => {
        let n = parseInt(val);
        if (n < 1) n = 1;
        subStyle.repeatCount = n;
        saveSettings();
    }, 1, 10, 1);

    const closeBtn = document.createElement('button');
    closeBtn.innerText = "Close";
    closeBtn.style.marginTop = '10px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.padding = '5px 10px';
    closeBtn.style.color = 'black';
    closeBtn.onclick = () => settings.remove();
    settings.appendChild(closeBtn);

    targetParent.appendChild(settings);
}

function addSetting(parent, label, type, value, onChange, min, max, step) {
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    const lbl = document.createElement('label');
    lbl.innerText = label;
    lbl.style.fontSize = '12px';
    lbl.style.marginBottom = '4px';
    lbl.style.color = '#ccc';

    const input = document.createElement('input');
    input.type = type;

    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    if (step !== undefined) input.step = step;

    input.value = value;

    input.style.color = 'black';
    input.style.backgroundColor = 'white';
    input.style.border = '1px solid #ccc';
    input.style.padding = '4px';
    input.style.borderRadius = '4px';

    input.addEventListener('input', (e) => {
        onChange(e.target.value);
        updateMultiSubOverlay();
    });

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
    });

    container.appendChild(lbl);
    container.appendChild(input);
    parent.appendChild(container);
}

function addCheckbox(parent, label, checked, onChange) {
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '8px';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;

    const lbl = document.createElement('label');
    lbl.innerText = label;
    lbl.style.fontSize = '12px';
    lbl.style.color = '#ccc';

    input.addEventListener('change', (e) => {
        onChange(e.target.checked);
    });

    input.addEventListener('keydown', (e) => {
        e.stopPropagation();
    });

    container.appendChild(input);
    container.appendChild(lbl);
    parent.appendChild(container);
}

function colorWithOpacity(color, opacity) {
    const hex = (color || '').trim();
    const m = hex.match(/^#([0-9a-fA-F]{6})$/);
    if (!m) return color;
    const intVal = parseInt(m[1], 16);
    const r = (intVal >> 16) & 255;
    const g = (intVal >> 8) & 255;
    const b = intVal & 255;
    const a = Math.min(1, Math.max(0, opacity));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

window.SSAMCore = {
    processSubtitleText,
    setPlayer,
    handleVideoChange
};

function addSelect(parent, label, value, options, onChange) {
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.flexDirection = 'column';

    const lbl = document.createElement('label');
    lbl.innerText = label;
    lbl.style.fontSize = '12px';
    lbl.style.marginBottom = '4px';
    lbl.style.color = '#ccc';

    const select = document.createElement('select');
    select.style.color = 'black';
    select.style.backgroundColor = 'white';
    select.style.border = '1px solid #ccc';
    select.style.padding = '4px';
    select.style.borderRadius = '4px';

    options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt;
        option.innerText = opt.charAt(0).toUpperCase() + opt.slice(1);
        if (opt === value) option.selected = true;
        select.appendChild(option);
    });

    select.addEventListener('change', (e) => {
        onChange(e.target.value);
        updateMultiSubOverlay();
    });

    select.addEventListener('keydown', (e) => {
        e.stopPropagation();
    });

    container.appendChild(lbl);
    container.appendChild(select);
    parent.appendChild(container);
}

function saveSettings() {
    localStorage.setItem('netflix-ssam-settings', JSON.stringify(subStyle));
}

function seekToSubtitle(offset) {
    if (!player) {
        console.warn("[Ext] Player not available for seek");
        return;
    }

    const currentTime = player.getCurrentTime();

    setTimeout(updateMultiSubOverlay, 100);

    if (!currentCues || currentCues.length === 0) {
        if (interceptedCues.length > 0 && interceptedCues[interceptedCues.length - 1]) {
            const lastIntercepted = interceptedCues[interceptedCues.length - 1];
            if (lastIntercepted.cues) {
                currentCues = lastIntercepted.cues;
            }
        }
    }

    if (!currentCues || currentCues.length === 0) {
        return;
    }

    performSeek(currentTime, offset);
}

function performSeek(currentTime, offset) {
    if (!currentCues || currentCues.length === 0) {
        console.warn("[Ext] No cues available for seek");
        return;
    }

    let idx = -1;
    for (let i = 0; i < currentCues.length; i++) {
        if (currentTime >= currentCues[i].start && currentTime <= currentCues[i].end) {
            idx = i;
            break;
        }
        if (currentTime < currentCues[i].start) {
            idx = i;
            break;
        }
    }

    if (idx === -1 && currentCues.length > 0 && currentTime > currentCues[currentCues.length - 1].end) {
        idx = currentCues.length;
    }

    let targetIdx = idx;

    const isInGap = (idx < currentCues.length && idx >= 0 && currentTime < currentCues[idx].start);

    if (offset === 0) { // Repeat / Loop Trigger
        if (isInGap) targetIdx = Math.max(0, idx - 1);
        else targetIdx = idx;

        // --- LOOP LOGIC ---
        if (subStyle.repeatCount > 1) {
            const cue = currentCues[targetIdx];
            if (cue) {
                loopState.active = true;
                loopState.cue = cue;
                loopState.remaining = subStyle.repeatCount - 1;
                console.log(`Loop initiated. Repeats left: ${loopState.remaining}`);
            }
        } else {
            loopState.active = false;
        }

    } else if (offset === 1) { // Next
        loopState.active = false; // Cancel loop on Nav
        if (isInGap) targetIdx = idx;
        else targetIdx = idx + 1;
    } else if (offset === -1) { // Prev
        loopState.active = false; // Cancel loop on Nav
        targetIdx = idx - 1;
    }

    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx >= currentCues.length) targetIdx = currentCues.length - 1;

    const targetCue = currentCues[targetIdx];
    if (targetCue) {
        console.log(`Seeking to: ${targetCue.start} (${targetCue.text})`);
        player.seek(targetCue.start);
        showToast(targetCue.text);
        sentencePaused = false;
    }
}

function resolveCurrentLang() {
    if (lastPrimaryLang) return lastPrimaryLang;
    if (player) {
        const track = player.getTimedTextTrack();
        if (track && track.bcp47 && track.bcp47 !== 'off') {
            return canonicalizeBcp47(track.bcp47);
        }
    }
    return null;
}

function getCuesForLang(lang) {
    if (!lang || lang === 'unknown') return null;
    const target = canonicalizeBcp47(lang);
    for (let i = interceptedCues.length - 1; i >= 0; i--) {
        const ic = interceptedCues[i];
        const icLang = (ic.lang && ic.lang !== 'unknown') ? canonicalizeBcp47(ic.lang) : 'unknown';
        if (ic.videoId === activeVideoId && icLang === target && ic.cues && ic.cues.length > 0) {
            return ic.cues;
        }
    }
    return null;
}

function getActiveCueInfo(time) {
    if (!currentCues || currentCues.length === 0) return null;
    for (let i = 0; i < currentCues.length; i++) {
        const c = currentCues[i];
        if (time >= c.start && time <= c.end) {
            return { cue: c, index: i };
        }
        if (time < c.start) {
            return { cue: null, index: i };
        }
    }
    return { cue: null, index: currentCues.length - 1 };
}

function pausePlayback() {
    if (player && typeof player.pause === 'function') {
        player.pause();
        return;
    }
    const video = document.querySelector('video');
    if (video) video.pause();
}

function resumePlayback() {
    if (player && typeof player.play === 'function') {
        player.play();
        return;
    }
    const video = document.querySelector('video');
    if (video) video.play();
}

function handleSentenceMode() {
    if (!subStyle.sentenceMode) return;
    if (!player) return;
    if (isAdPlaying()) return; // Do not pause playback during ads

    if (!currentCues || currentCues.length === 0) {
        const lang = resolveCurrentLang();
        const cues = getCuesForLang(lang);
        if (cues && cues.length > 0) {
            currentCues = cues;
        } else {
            return;
        }
    }

    const t = player.getCurrentTime();
    const info = getActiveCueInfo(t);

    if (info && info.cue) {
        sentenceLastCue = info.cue;
    }

    const epsilon = 0.05;
    if (sentenceLastCue && !sentencePaused && t >= (sentenceLastCue.end - epsilon)) {
        pausePlayback();
        sentencePaused = true;
        showToast('Paused');
    }
}

function resumeNextSentence() {
    if (!player) return;
    if (!currentCues || currentCues.length === 0) return;

    let idx = -1;
    if (sentenceLastCue) {
        idx = currentCues.findIndex(c => c.start === sentenceLastCue.start && c.end === sentenceLastCue.end);
    }
    if (idx === -1) {
        const t = player.getCurrentTime();
        performSeek(t, 1);
        resumePlayback();
        sentencePaused = false;
        return;
    }

    const nextIdx = Math.min(idx + 1, currentCues.length - 1);
    const nextCue = currentCues[nextIdx];
    if (nextCue) {
        player.seek(nextCue.start);
        resumePlayback();
        sentencePaused = false;
        showToast(nextCue.text || 'Next');
    }
}

// Extract text from XML element while preserving line breaks from <br> tags
function extractTextWithLineBreaks(element) {
    let text = '';
    for (let node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            // Handle <br> tags by adding newline
            if (node.nodeName.toLowerCase() === 'br') {
                text += '\n';
            } else {
                // Recursively process other elements (like <span>)
                text += extractTextWithLineBreaks(node);
            }
        }
    }
    return text;
}

function parseXMLCues(xmlText) {
    try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        const paragraphs = xmlDoc.getElementsByTagName("p");
        const cues = [];

        let tickRate = 10000;
        const root = xmlDoc.documentElement;
        if (root.getAttribute("ttp:tickRate")) tickRate = parseInt(root.getAttribute("ttp:tickRate"));
        else if (root.getAttribute("tickRate")) tickRate = parseInt(root.getAttribute("tickRate"));

        for (let i = 0; i < paragraphs.length; i++) {
            const p = paragraphs[i];
            const begin = parseTime(p.getAttribute("begin"), tickRate);
            const end = parseTime(p.getAttribute("end"), tickRate);

            // Extract text while preserving line breaks from <br> tags
            let text = extractTextWithLineBreaks(p);

            if (!Number.isNaN(begin)) {
                cues.push({ start: begin, end: end, text: text });
            }
        }
        return cues;
    } catch (e) {
        return [];
    }
}

function parseTime(timeStr, tickRate) {
    if (!timeStr) return 0;

    // Handle tick format (e.g., "12345t")
    if (timeStr.endsWith('t')) {
        const tickValue = timeStr.slice(0, -1);
        if (tickValue === '') return 0;
        const parsed = parseInt(tickValue);
        if (isNaN(parsed)) return 0;
        return (parsed / tickRate) * 1000;
    }

    // Handle HH:MM:SS format
    if (timeStr.includes(':')) {
        const parts = timeStr.split(':');
        if (parts.length === 3) {
            const hours = parseInt(parts[0]);
            const minutes = parseInt(parts[1]);
            const seconds = parseFloat(parts[2]);
            if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return 0;
            return (hours * 3600 + minutes * 60 + seconds) * 1000;
        }
    }

    // Fallback to direct parse
    const result = parseFloat(timeStr);
    return isNaN(result) ? 0 : result;
}

function toggleLanguage() {
    if (!player) {
        console.warn("[Ext] Player not available");
        return;
    }

    const trackList = player.getTimedTextTrackList();
    if (!trackList || trackList.length <= 1) return;

    let currentTrack = player.getTimedTextTrack();

    // Explicitly Filter out "Off" tracks (isNone=true)
    const validTracks = trackList.filter(t => !t.isNone && t.bcp47 !== 'off');

    if (validTracks.length === 0) return;

    let targetList = validTracks;

    // Use registeredLangs to prioritize languages
    const registeredTracks = validTracks.filter(t => {
        const lang = canonicalizeBcp47(t.bcp47 || '');
        return lang && registeredLangs[lang];
    });
    if (registeredTracks.length > 0) {
        targetList = registeredTracks;
    }

    let currentIndex = -1;
    if (currentTrack && !currentTrack.isNone) {
        currentIndex = targetList.findIndex(t => t.trackId === currentTrack.trackId);
        if (currentIndex === -1) {
            const currentLang = canonicalizeBcp47(currentTrack.bcp47 || '');
            currentIndex = targetList.findIndex(t => canonicalizeBcp47(t.bcp47 || '') === currentLang);
        }
    }

    // If current is off (or not found in target list), we start from the beginning of the list
    let nextIndex = 0;
    if (currentIndex !== -1) {
        nextIndex = (currentIndex + 1) % targetList.length;
    }

    const newTrack = targetList[nextIndex];

    if (newTrack) {
        console.log("Switching lang to:", newTrack.bcp47);
        player.setTextTrack(newTrack);
        showToast(`Language: ${newTrack.displayName || newTrack.bcp47}`);

        // Try to find cached subtitles for the new language
        if (cachedForLang && cachedForLang.cues) {
            currentCues = cachedForLang.cues;
            console.log(`[Ext] Using cached cues for language: ${newTrack.bcp47}`);
        } else {
            currentCues = [];
            console.log(`[Ext] No cached cues for language: ${newTrack.bcp47}, waiting for load...`);
        }
    }
}

// --- Dynamic Multi-Sub Logic ---

function registerCurrentLanguage() {
    if (!player) return;
    const track = player.getTimedTextTrack();

    // Debug logging (commented out to reduce console noise)
    // console.log("[Ext] Track Info:", track.bcp47, track.displayName, track.isNone);

    // Precise "Off" detection
    if (!track) {
        if (lastPrimaryLang !== null) {
            lastPrimaryLang = null;
            updateLanguageListUI();
        }
        return;
    }
    if (track.isNone) {
        if (lastPrimaryLang !== null) {
            lastPrimaryLang = null;
            updateLanguageListUI();
        }
        return;
    }
    if (track.bcp47 === 'off') {
        if (lastPrimaryLang !== null) {
            lastPrimaryLang = null;
            updateLanguageListUI();
        }
        return;
    }

    // Check for display names that indicate "Off"
    // RESTORED: Name-based check required because Netflix sometimes assigns 'en' code to 'Off' track.
    const name = (track.displayName || "").toLowerCase();
    if (name === 'off' || name === '끄기') {
        // console.log(`[Ext] Detected Off state with bcp47: ${track.bcp47}, displayName: ${track.displayName}`);
        if (lastPrimaryLang !== null) {
            // console.log(`[Ext] Clearing primary language due to Off state`);
            lastPrimaryLang = null;
            updateLanguageListUI();
        }
        return;
    }

    const lang = canonicalizeBcp47(track.bcp47);
    if (!lang) return; // Invalid bcp47

    const displayName = track.displayName || lang;

    const normLang = canonicalizeBcp47(lang);

    if (!registeredLangs[normLang]) {
        console.log(`[Ext] Registering new language: ${lang} (${displayName})`);
        registeredLangs[normLang] = {
            selected: true, // Auto-select by default
            displayName: displayName
        };
        if (!Array.isArray(subStyle.langOrder)) subStyle.langOrder = [];
        if (!subStyle.langOrder.includes(normLang)) {
            subStyle.langOrder.push(normLang);
            saveSettings();
        }

        // Re-tag any 'unknown' cues as this language
        // This handles the case where subtitles loaded before language was detected
        const unknownCues = interceptedCues.filter(ic => ic.lang === 'unknown');
        if (unknownCues.length > 0) {
            console.log(`[Ext] Re-tagging ${unknownCues.length} 'unknown' cue sets as ${lang}`);
            unknownCues.forEach(ic => {
                ic.lang = lang;
            });
        }

        updateLanguageListUI();
    } else {
        // Update display name if it changed (e.g. from a weird state to a correct one)
        if (registeredLangs[normLang].displayName !== displayName) {
            console.log(`[Ext] Updating display name for ${lang}: ${registeredLangs[normLang].displayName} -> ${displayName}`);
            registeredLangs[normLang].displayName = displayName;
            updateLanguageListUI();
        }
    }

    // Check if primary language changed (to update badge colors)
    if (lastPrimaryLang !== normLang) {
        console.log(`[Ext] Primary language changed: ${lastPrimaryLang} -> ${lang}`);
        lastPrimaryLang = normLang;
        updateLanguageListUI();
    }
}

function updateLanguageListUI() {
    let container = document.getElementById('netflix-ext-lang-list');
    if (!container) {
        container = document.createElement('div');
        container.id = 'netflix-ext-lang-list';
        container.style.position = 'fixed';
        container.style.top = '20px';
        container.style.right = '20px';
        container.style.display = 'flex';
        container.style.flexDirection = 'row-reverse';
        container.style.flexWrap = 'wrap';
        container.style.gap = '5px';
        container.style.justifyContent = 'flex-start';
        container.style.alignItems = 'flex-start';
        container.style.zIndex = '2147483647';
        container.style.pointerEvents = 'auto'; // Must be clickable
        document.body.appendChild(container);
    }

    // Ensure it stays on top / attached to correct parent in fullscreen
    const targetParent = document.fullscreenElement || document.body;
    if (container.parentElement !== targetParent) {
        targetParent.appendChild(container);
    }

    // Clear and rebuild (avoid TrustedHTML requirement)
    if (typeof container.replaceChildren === 'function') {
        container.replaceChildren();
    } else {
        while (container.firstChild) container.removeChild(container.firstChild);
    }

    // Use lastPrimaryLang instead of querying player to avoid stale data
    const currentLang = lastPrimaryLang;

    const orderedLangs = getOrderedLangs();
    orderedLangs.forEach(lang => {
        const normLang = canonicalizeBcp47(lang);
        const data = registeredLangs[lang];
        const badge = document.createElement('div');
        badge.innerText = data.displayName;
        badge.style.padding = '5px 10px';
        badge.style.borderRadius = '20px'; // Pill shape
        badge.style.cursor = 'pointer';
        badge.style.fontSize = '14px';
        badge.style.fontWeight = 'bold';
        badge.style.userSelect = 'none';
        badge.style.transition = 'all 0.2s';
        badge.style.boxShadow = '0 2px 4px rgba(0,0,0,0.3)';

        // Check if this is the primary language
        const isPrimary = (normLang === currentLang);

        let baseBg = '';
        let hoverBg = '';
        let baseOpacity = 1;
        let hoverOpacity = 1;

        if (isPrimary) {
            // Primary language - Softer Green
            baseBg = 'rgba(46, 204, 113, 0.35)';
            hoverBg = 'rgba(46, 204, 113, 0.8)';
            badge.style.color = 'white';
            baseOpacity = 0.65;
            hoverOpacity = 1;
            badge.style.border = '1px solid rgba(255, 255, 255, 0.45)';
        } else if (data.selected) {
            // Selected for Multi-Sub - Softer Blue (previous primary color)
            baseBg = 'rgba(52, 152, 219, 0.35)';
            hoverBg = 'rgba(52, 152, 219, 0.8)';
            badge.style.color = 'white';
            baseOpacity = 0.65;
            hoverOpacity = 1;
        } else {
            // Unselected (hidden from Multi-Sub) - Grey
            baseBg = 'rgba(0, 0, 0, 0.25)';
            hoverBg = 'rgba(0, 0, 0, 0.6)';
            badge.style.color = '#aaa';
            baseOpacity = 0.5;
            hoverOpacity = 0.9;
        }
        badge.style.backgroundColor = baseBg;
        badge.style.opacity = baseOpacity;

        badge.onmouseenter = () => {
            badge.style.backgroundColor = hoverBg;
            badge.style.opacity = hoverOpacity;
        };
        badge.onmouseleave = () => {
            badge.style.backgroundColor = baseBg;
            badge.style.opacity = baseOpacity;
        };

        // Click Handling (Single vs Double)
        let clickTimer = null;

        badge.draggable = true;
        badge.dataset.lang = normLang;
        badge.ondragstart = (e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', normLang);
        };
        badge.ondragover = (e) => {
            e.preventDefault();
        };
        badge.ondrop = (e) => {
            e.preventDefault();
            const src = e.dataTransfer.getData('text/plain');
            const target = normLang;
            if (!src || !target || src === target) return;
            const order = getOrderedLangs();
            const from = order.indexOf(src);
            const to = order.indexOf(target);
            if (from === -1 || to === -1) return;
            order.splice(from, 1);
            order.splice(to, 0, src);
            subStyle.langOrder = order;
            saveSettings();
            updateLanguageListUI();
            updateMultiSubOverlay();
        };

        badge.onclick = (e) => {
            e.stopPropagation();

            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
                // Double Click Action: Switch Language or Turn Off
                if (isPrimary) {
                    // If clicking primary badge, turn off subtitles
                    turnOffSubtitles();
                } else {
                    // If clicking non-primary badge, switch to that language
                    switchLanguage(normLang);
                }
            } else {
                clickTimer = setTimeout(() => {
                    clickTimer = null;
                    // Single Click Action: Toggle Visibility
                    data.selected = !data.selected;
                    updateLanguageListUI();
                    updateMultiSubOverlay();
                }, 250); // 250ms delay to wait for potential second click
            }
        };

        container.appendChild(badge);
    });
}

function getOrderedLangs() {
    const order = Array.isArray(subStyle.langOrder) ? [...subStyle.langOrder] : [];
    const reg = Object.keys(registeredLangs);
    reg.forEach(lang => {
        if (!order.includes(lang)) order.push(lang);
    });
    return order.filter(lang => registeredLangs[lang]);
}

function turnOffSubtitles() {
    if (!player) return;

    const trackList = player.getTimedTextTrackList();
    if (!trackList) return;

    // Find the 'Off' track
    const offTrack = trackList.find(t => {
        const name = (t.displayName || "").toLowerCase();
        return name === 'off' || name === '끄기' || t.isNone || t.bcp47 === 'off';
    });

    if (offTrack) {
        console.log(`[Ext] Double-click primary: turning off subtitles`);
        player.setTextTrack(offTrack);
        showToast('Subtitles: Off');

        // Update UI to reflect no primary language
        setTimeout(() => {
            updateLanguageListUI();
            updateMultiSubOverlay();
        }, 100); // Small delay to ensure player state has updated
    }
}

function switchLanguage(targetLang) {
    if (!player) return;

    const trackList = player.getTimedTextTrackList();
    if (!trackList) return;

    // Filter out 'Off' tracks to avoid switching to them
    const validTracks = trackList.filter(t => {
        const name = (t.displayName || "").toLowerCase();
        return name !== 'off' && name !== '끄기' && !t.isNone;
    });

    const targetNorm = canonicalizeBcp47(targetLang || '');
    const targetTrack = validTracks.find(t => canonicalizeBcp47(t.bcp47 || '') === targetNorm);
    if (targetTrack) {
        console.log(`[Ext] Double-click switch to: ${targetLang}`);
        player.setTextTrack(targetTrack);
        showToast(`Switched to: ${targetTrack.displayName || targetLang}`);

        // Update UI to reflect the new primary language
        setTimeout(() => {
            updateLanguageListUI();
            updateMultiSubOverlay();
        }, 100); // Small delay to ensure player state has updated
    }
}
