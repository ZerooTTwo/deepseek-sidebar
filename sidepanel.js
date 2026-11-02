/**
 * DeepSeek Sidebar — side panel controller
 *
 * Renders the official DeepSeek web app (https://chat.deepseek.com/) edge to
 * edge inside the Chrome side panel, wrapped in a loading splash and a
 * recovery screen so a blocked frame never leaves the user staring at white.
 *
 * Note: the embedded page is cross-origin, so we can neither read nor script
 * its DOM. All we can observe is the frame's `load` event — hence the timeout
 * based recovery path below.
 */

const DEFAULTS = {
  landingUrl: 'https://chat.deepseek.com/',
  showToolbar: true,
};

/** After this long the splash steps aside even if `load` hasn't fired yet. */
const SOFT_REVEAL_MS = 4000;

/** Hard deadline: past this we assume the frame is blocked and offer recovery. */
const LOAD_TIMEOUT_MS = 22000;

const el = {
  frame: document.getElementById('ds-frame'),
  splash: document.getElementById('splash'),
  fallback: document.getElementById('fallback'),
  toolbar: document.getElementById('toolbar'),
  splashText: document.querySelector('.splash__text'),
};

/** URL currently being loaded, or null once a load has succeeded. */
let pendingUrl = null;
/** URL of the frame as of the last explicit navigation. */
let currentUrl = DEFAULTS.landingUrl;
let loadTimer = null;
let softRevealTimer = null;
let splashHidden = false;
/** Optional message (e.g. a disabled ruleset) to keep on the splash. */
let bootNotice = null;

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

/** Only ever embed a plain http(s) DeepSeek URL. */
function normalizeTarget(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULTS.landingUrl;
    if (!/(^|\.)deepseek\.com$/i.test(url.hostname)) return DEFAULTS.landingUrl;
    return url.toString();
  } catch {
    return DEFAULTS.landingUrl;
  }
}

async function readSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

/* ------------------------------------------------------------------ *
 * Frame loading
 * ------------------------------------------------------------------ */

function showSplash(message) {
  splashHidden = false;
  el.splash.classList.remove('is-hidden');
  if (message) el.splashText.textContent = message;
  el.fallback.hidden = true;
  el.frame.classList.remove('is-ready');
}

function hideSplash() {
  if (splashHidden) return;
  splashHidden = true;
  el.splash.classList.add('is-hidden');
  el.frame.classList.add('is-ready');
  el.fallback.hidden = true;
}

function showFallback() {
  splashHidden = true;
  el.splash.classList.add('is-hidden');
  el.fallback.hidden = false;
  el.frame.classList.remove('is-ready');
}

function clearLoadTimer() {
  if (loadTimer !== null) {
    clearTimeout(loadTimer);
    loadTimer = null;
  }
  if (softRevealTimer !== null) {
    clearTimeout(softRevealTimer);
    softRevealTimer = null;
  }
}

/**
 * Point the frame at `url` and arm the recovery timer.
 * @param {string} url
 * @param {{soft?: boolean}} [opts] soft = keep the current pixels visible
 */
function loadFrame(url, opts = {}) {
  const target = normalizeTarget(url);
  currentUrl = target;
  pendingUrl = target;
  clearLoadTimer();

  if (!opts.soft) {
    showSplash(bootNotice || '正在连接 DeepSeek…');
  } else {
    el.fallback.hidden = true;
  }

  // Re-assigning the same src would be a no-op; force a real navigation.
  if (el.frame.getAttribute('src') === target) {
    el.frame.src = 'about:blank';
    // Give the renderer a frame to settle before re-navigating.
    setTimeout(() => {
      el.frame.src = target;
    }, 30);
  } else {
    el.frame.setAttribute('src', target);
  }

  // Step aside early: once the document commits, DeepSeek paints progressively
  // and a lingering splash would hide an already-interactive page.
  softRevealTimer = setTimeout(() => {
    softRevealTimer = null;
    if (!splashHidden) hideSplash();
  }, SOFT_REVEAL_MS);

  // The recovery screen still waits for the real deadline.
  loadTimer = setTimeout(() => {
    loadTimer = null;
    if (pendingUrl) {
      pendingUrl = null;
      showFallback();
    }
  }, LOAD_TIMEOUT_MS);
}

el.frame.addEventListener('load', () => {
  const src = el.frame.getAttribute('src');

  // The placeholder navigation we perform before a reload must not count.
  if (!src || src === 'about:blank') return;

  // Any later load (in-app route change, sign-in redirect) can end the splash.
  clearLoadTimer();
  pendingUrl = null;
  hideSplash();
});

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

async function runAction(action) {
  switch (action) {
    case 'reload':
      loadFrame(currentUrl, { soft: true });
      break;

    case 'tab':
      try {
        await chrome.runtime.sendMessage({ type: 'ds:openTab', url: currentUrl });
      } catch {
        /* service worker asleep — opening a tab is a convenience, not critical */
      }
      break;

    case 'window':
      try {
        await chrome.runtime.sendMessage({ type: 'ds:openWindow', url: currentUrl });
      } catch {
        /* ignore */
      }
      break;

    case 'options':
      try {
        await chrome.runtime.sendMessage({ type: 'ds:openOptions' });
      } catch {
        /* ignore */
      }
      break;

    case 'retry':
      loadFrame(currentUrl);
      break;

    default:
      break;
  }
}

document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const trigger = target.closest('[data-act]');
  if (!trigger) return;
  event.preventDefault();
  void runAction(trigger.dataset.act);
});

/* ------------------------------------------------------------------ *
 * Live settings
 * ------------------------------------------------------------------ */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;

  if (changes.showToolbar) {
    el.toolbar.hidden = !changes.showToolbar.newValue;
  }

  if (changes.landingUrl) {
    const next = normalizeTarget(changes.landingUrl.newValue);
    if (next !== currentUrl) loadFrame(next);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ds:reload') {
    loadFrame(currentUrl, { soft: true });
  }
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

(async function boot() {
  const settings = await readSettings();

  el.toolbar.hidden = !settings.showToolbar;

  // Surface a note if the ruleset that unblocks framing is somehow off, so the
  // user sees an actionable hint instead of a bare "refused to connect".
  try {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    if (!enabled.includes('ds_frame_headers')) {
      console.warn('[DeepSeek Sidebar] framing ruleset is disabled');
      bootNotice = '拦截规则未启用，DeepSeek 可能无法嵌入…';
    }
  } catch {
    /* API unavailable — carry on */
  }

  loadFrame(settings.landingUrl);
})();
