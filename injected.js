console.log("Netflix Language Learning Extension Loaded");

// --- Global State ---
let videoPlayer = null;
let player = null;
let sessionId = null;
let currentCues = [];
let interceptedCues = [];
let favoriteLangs = []; // Array of bcp47 strings
let multiSubEnabled = false; // Multi-subtitle toggle state

let activeVideoId = null;

// Timer References
let initInterval = null;
let sessionInterval = null;
let controlLoop = null;
let urlMonitorInterval = null;

// Loop State
let loopState = {
    active: false,
    remaining: 0,
    cue: null
};

// Settings State
let subStyle = {
    fontSize: 22,
    color: '#ffffff',
    opacity: 0.6,
    bottom: 15, // Acts as "Vertical Margin %"
    repeatCount: 1,
    hAlign: 'center', // left, center, right (text alignment)
    vAlign: 'top',     // top, bottom
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

// --- XHR Interceptor ---
const originalOpen = XMLHttpRequest.prototype.open;
const originalSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    return originalOpen.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function (body) {
    // RESTRICTION: Only intercept if we are on a watch page
    if (window.location.pathname.includes('/watch/')) {
        this.addEventListener('load', function () {
            const url = this._url;
            if (url && (url.includes('/range/') || url.includes('?o=')) && (url.includes('.xml') || url.includes('nflxvideo.net'))) {
                try {
                    let text = '';
                    if (this.responseType === 'arraybuffer') {
                        const decoder = new TextDecoder('utf-8');
                        text = decoder.decode(this.response);
                    } else if (this.responseType === 'text' || this.responseType === '') {
                        text = this.responseText;
                    }

                    if (text) {
                        processSubtitleText(url, text);
                    }
                } catch (e) { }
            }
        });
    }
    return originalSend.apply(this, arguments);
};

// --- Fetch Interceptor ---
const originalFetch = window.fetch;
window.fetch = async function (...args) {
    const [resource, config] = args;
    const response = await originalFetch(resource, config);

    // RESTRICTION: Only intercept if we are on a watch page
    if (window.location.pathname.includes('/watch/')) {
        try {
            const url = (typeof resource === 'string') ? resource : resource.url;
            if (url && (url.includes('.xml') || url.includes('nflxvideo.net') || url.includes('/?o='))) {
                const clone = response.clone();
                clone.text().then(text => {
                    processSubtitleText(url, text);
                }).catch(e => { });
            }
        } catch (e) { }
    }

    return response;
};

// --- Helper ---

// Extract language code from subtitle URL
function extractLangFromUrl(url) {
    try {
        // Try to parse URL parameters
        const urlObj = new URL(url);

        // Check for lang parameter
        const langParam = urlObj.searchParams.get('lang');
        if (langParam) {
            return langParam;
        }

        // Check for language code in path (e.g., /ko-KR/, /en-US/)
        const pathMatch = url.match(/\/([a-z]{2}-[A-Z]{2})\//);
        if (pathMatch) {
            return pathMatch[1];
        }

        // Check for language code in query string without proper parsing
        const langMatch = url.match(/[?&]lang=([^&]+)/);
        if (langMatch) {
            return langMatch[1];
        }

        // Check for bcp47 or similar parameter
        const bcp47Match = url.match(/[?&](?:bcp47|language)=([^&]+)/);
        if (bcp47Match) {
            return bcp47Match[1];
        }

    } catch (e) {
        // URL parsing failed, try regex patterns
    }

    return null;
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
                    lang = track.bcp47;
                }
            }

            // Fallback to 'unknown'
            if (!lang) {
                lang = 'unknown';
            }

            // Create a simple content hash for duplicate detection
            const contentHash = cues.slice(0, 5).map(c => c.text).join('|');

            // Check for duplicates by language and content hash
            const existing = interceptedCues.find(ic =>
                ic.lang === lang && ic.contentHash === contentHash
            );

            if (!existing) {
                interceptedCues.push({
                    url: url,
                    cues: cues,
                    lang: lang,
                    contentHash: contentHash,
                    timestamp: Date.now()
                });
                console.log(`[Ext] Parsed ${cues.length} cues. Language: ${lang}`);

                // Set as active cues if this is the first subtitle or current player language matches
                if (currentCues.length === 0 || (player && player.getTimedTextTrack()?.bcp47 === lang)) {
                    currentCues = cues;
                    console.log("[Ext] Set active cues.");
                    showToast(`Subtitles Loaded: ${cues.length} lines (${lang})`);
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

// 1. Continuous URL Monitor
urlMonitorInterval = setInterval(checkUrlState, 500);

function checkUrlState() {
    const match = window.location.pathname.match(/\/watch\/(\d+)/);
    if (match) {
        const newId = match[1];
        if (newId !== activeVideoId) {
            console.log(`[Ext] Video Change Detected: ${activeVideoId} -> ${newId}`);
            activeVideoId = newId;
            resetExtensionState();
            startExtensionInit();
        }
    } else {
        if (activeVideoId !== null) {
            console.log("[Ext] Left video player.");
            activeVideoId = null;
            resetExtensionState();
        }
    }
}

function resetExtensionState() {
    console.log("[Ext] Resetting State...");

    if (initInterval) clearInterval(initInterval);
    if (sessionInterval) clearInterval(sessionInterval);
    if (controlLoop) clearInterval(controlLoop);
    if (urlMonitorInterval) clearInterval(urlMonitorInterval);
    initInterval = null;
    sessionInterval = null;
    controlLoop = null;
    urlMonitorInterval = null;

    sessionId = null;
    player = null;
    videoPlayer = null;

    currentCues = [];
    interceptedCues = [];
    favoriteLangs = [];
    loopState = { active: false, remaining: 0, cue: null };

    window.removeEventListener('keydown', handleKeyDown);

    const overlay = document.getElementById('netflix-ext-multisub');
    if (overlay) overlay.remove();
    const settings = document.getElementById('netflix-ext-settings');
    if (settings) settings.remove();
}

function startExtensionInit() {
    console.log("[Ext] Starting Extension Init...");

    initInterval = setInterval(() => {
        if (window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer) {
            clearInterval(initInterval);
            initInterval = null;

            videoPlayer = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
            console.log("Netflix Player API found. Waiting for session...");
            pollForSession();
        }
    }, 500);
}

function pollForSession() {
    sessionInterval = setInterval(() => {
        if (!videoPlayer) return;

        try {
            const sessions = videoPlayer.getAllPlayerSessionIds();
            if (sessions && sessions.length > 0) {
                const activeSession = sessions.find(s => s && s !== 'undefined');
                if (activeSession) {
                    clearInterval(sessionInterval);
                    sessionInterval = null;

                    sessionId = activeSession;
                    player = videoPlayer.getVideoPlayerBySessionId(sessionId);
                    console.log("Player session initialized:", sessionId);

                    window.removeEventListener('keydown', handleKeyDown);
                    initEvents();

                    controlLoop = setInterval(runControlLoop, 100);
                }
            }
        } catch (e) {
            console.error("Session poll error", e);
        }
    }, 1000);
}

function initEvents() {
    window.addEventListener('keydown', handleKeyDown);
    console.log("Listeners attached.");
}

function runControlLoop() {
    if (!player) return;

    if (typeof multiSubEnabled !== 'undefined' && multiSubEnabled) {
        updateMultiSubOverlay();
    }

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


function handleKeyDown(e) {
    if (!player) {
        if (videoPlayer && sessionId) {
            player = videoPlayer.getVideoPlayerBySessionId(sessionId);
        }
        if (!player) return;
    }

    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    const code = e.code;

    switch (code) {
        case 'KeyA': seekToSubtitle(-1); break;
        case 'KeyS': seekToSubtitle(0); break;
        case 'KeyD': seekToSubtitle(1); break;
        case 'KeyW': toggleLanguage(); break;
        case 'KeyQ': toggleFavorite(); break;
        case 'KeyE': toggleMultiSub(); break;
        case 'KeyO': toggleSettings(); break;

        case 'KeyZ': adjustSpeed(-0.25); break;
        case 'KeyX': resetSpeed(); break;
        case 'KeyC': adjustSpeed(0.25); break;
    }
}

// --- Features ---

function adjustSpeed(delta) {
    const video = document.querySelector('video');
    if (video) {
        let newRate = video.playbackRate + delta;
        if (newRate < 0.25) newRate = 0.25;
        if (newRate > 5.0) newRate = 5.0;
        video.playbackRate = newRate;
        showToast(`Speed: ${newRate.toFixed(2)}x`);
    }
}

function resetSpeed() {
    const video = document.querySelector('video');
    if (video) {
        video.playbackRate = 1.0;
        showToast("Speed: 1.0x");
    }
}

function toggleMultiSub() {
    multiSubEnabled = !multiSubEnabled;
    showToast(`Multi-Sub Mode: ${multiSubEnabled ? 'ON' : 'OFF'}`);

    const overlay = document.getElementById('netflix-ext-multisub');
    if (!multiSubEnabled && overlay) {
        overlay.style.display = 'none';
    } else {
        updateMultiSubOverlay();
    }
}

function updateMultiSubOverlay() {
    if (!multiSubEnabled || !player) return;

    let overlay = document.getElementById('netflix-ext-multisub');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'netflix-ext-multisub';
        overlay.style.position = 'fixed';
        overlay.style.zIndex = '9999';
        overlay.style.pointerEvents = 'none';
        overlay.style.display = 'flex';
        overlay.style.flexDirection = 'column';
        overlay.style.gap = '4px';
        document.body.appendChild(overlay);
    }

    overlay.style.display = 'flex';
    overlay.style.width = `${subStyle.width}%`;

    // --- Horizontal Position ---
    // 0% = left edge, 50% = center, 100% = right edge
    overlay.style.left = `${subStyle.hPosition}%`;
    overlay.style.right = 'auto';
    overlay.style.transform = `translateX(-${subStyle.hPosition}%)`;

    // --- Vertical Alignment ---
    // subStyle.bottom acts as "Margin from Edge"
    // If Top Align: Margin from Top. If Bottom Align: Margin from Bottom.
    if (subStyle.vAlign === 'bottom') {
        overlay.style.top = 'auto';
        overlay.style.bottom = `${subStyle.bottom}%`;
        overlay.style.flexDirection = 'column-reverse'; // Grow upwards
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


    overlay.innerHTML = '';

    const currentTime = player.getCurrentTime();
    const activeTexts = new Set();

    let currentLang = 'unknown';
    const track = player.getTimedTextTrack();
    if (track) currentLang = track.bcp47;

    interceptedCues.forEach((ic) => {
        // Skip if this is the currently displayed language
        if (ic.lang && ic.lang !== 'unknown' && ic.lang === currentLang) return;

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
                    if (ic.lang === 'unknown' && currentLang !== 'unknown') {
                        ic.lang = currentLang;
                        console.log(`[Ext] Auto-tagged 'unknown' cues as ${currentLang} (matched native text)`);
                    }
                    return;
                }
            } catch (e) {
                // DOM structure might have changed, continue anyway
                console.debug("[Ext] DOM selector warning:", e);
            }

            activeTexts.add(text);
        }
    });

    const texts = Array.from(activeTexts);

    texts.forEach(text => {
        const p = document.createElement('p');
        p.innerText = text;
        p.style.margin = '0';
        p.style.padding = '4px 8px';
        p.style.backgroundColor = `rgba(0,0,0,${subStyle.opacity})`;
        p.style.color = subStyle.color;
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

    settings = document.createElement('div');
    settings.id = 'netflix-ext-settings';
    settings.style.position = 'fixed';
    settings.style.top = '20%';
    settings.style.right = '20px';
    settings.style.backgroundColor = 'rgba(0,0,0,0.9)';
    settings.style.padding = '20px';
    settings.style.borderRadius = '8px';
    settings.style.color = 'white';
    settings.style.zIndex = '10000';
    settings.style.display = 'flex';
    settings.style.flexDirection = 'column';
    settings.style.gap = '10px';
    settings.style.minWidth = '250px';
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

    addSetting(settings, 'Text Color', 'color', subStyle.color, (val) => {
        subStyle.color = val;
        saveSettings();
    });

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
    addSelect(settings, 'Vertical Align', subStyle.vAlign, ['top', 'bottom'], (val) => {
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

    document.body.appendChild(settings);
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
    input.value = value;
    input.style.color = 'black';
    input.style.backgroundColor = 'white';
    input.style.border = '1px solid #ccc';
    input.style.padding = '4px';
    input.style.borderRadius = '4px';

    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    if (step !== undefined) input.step = step;

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

function toggleFavorite() {
    if (!player) {
        console.warn("[Ext] Player not available");
        return;
    }

    const currentTrack = player.getTimedTextTrack();
    if (!currentTrack) {
        showToast("No active track");
        return;
    }

    const lang = currentTrack.bcp47;
    const displayName = currentTrack.displayName || lang;
    const idx = favoriteLangs.indexOf(lang);

    if (idx === -1) {
        favoriteLangs.push(lang);
        showToast(`Added Favorite: ${displayName}`);

        if (interceptedCues.length > 0) {
            const currentActive = interceptedCues[interceptedCues.length - 1];
            if (currentActive && currentActive.lang === 'unknown') {
                currentActive.lang = lang;
                console.log(`[Ext] Tagged cues as ${lang}`);
            }
        }
    } else {
        favoriteLangs.splice(idx, 1);
        showToast(`Removed Favorite: ${displayName}`);
    }
    console.log("Favorites:", favoriteLangs);
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

    if (favoriteLangs.length > 0) {
        const favTracks = validTracks.filter(t => favoriteLangs.includes(t.bcp47));
        if (favTracks.length > 0) {
            targetList = favTracks;
        }
    }

    let currentIndex = -1;
    if (currentTrack && !currentTrack.isNone) {
        currentIndex = targetList.findIndex(t => t.trackId === currentTrack.trackId);
        if (currentIndex === -1) {
            currentIndex = targetList.findIndex(t => t.bcp47 === currentTrack.bcp47);
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
        const cachedForLang = interceptedCues.find(ic => ic.lang === newTrack.bcp47);
        if (cachedForLang && cachedForLang.cues) {
            currentCues = cachedForLang.cues;
            console.log(`[Ext] Using cached cues for language: ${newTrack.bcp47}`);
        } else {
            currentCues = [];
            console.log(`[Ext] No cached cues for language: ${newTrack.bcp47}, waiting for load...`);
        }
    }
}
