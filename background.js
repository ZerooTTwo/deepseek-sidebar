/**
 * DeepSeek Sidebar — background service worker
 *
 * Responsibilities:
 *  1. Make clicking the toolbar icon open the side panel (same UX as the
 *     reference Kimi sidebar extension).
 *  2. Register the right-click menu entry that opens the panel from any page.
 *  3. Serve 划词翻译 requests from the content script: translate selected text
 *     either with the DeepSeek API (user's own key) or, if explicitly allowed,
 *     a free public endpoint.
 *
 * The page-embedding magic lives in rules/frame.json (see README):
 * chat.deepseek.com ships `Content-Security-Policy: frame-ancestors 'none'`,
 * which would block a plain <iframe>. The declarativeNetRequest ruleset strips
 * that header for *sub_frame* requests only, leaving normal tabs untouched.
 *
 * Why translation does not reuse the logged-in web session: the browser app
 * authenticates with a Bearer token from localStorage AND must first solve a
 * proof-of-work challenge via /api/v0/chat/create_pow_challenge before calling
 * /api/v0/chat/completion. That challenge is an anti-abuse control, so this
 * extension deliberately does not implement a solver for it.
 */

const DEFAULT_SETTINGS = {
  // side panel
  landingUrl: 'https://chat.deepseek.com/',
  showToolbar: true,
  // 划词翻译
  translateEnabled: true,
  targetLang: 'auto',
  allowFreeEngine: false,
};

const MENU_OPEN_PANEL = 'ds-open-panel';
const MENU_OPEN_WINDOW = 'ds-open-window';

const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const FREE_API = 'https://api.mymemory.translated.net/get';
const MAX_TEXT_LEN = 2000;
const FREE_MAX_CHARS = 480;

/* ------------------------------------------------------------------ *
 * Panel behaviour
 * ------------------------------------------------------------------ */

async function applyPanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn('[DeepSeek Sidebar] setPanelBehavior failed:', err);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn('[DeepSeek Sidebar] sidePanel.open failed:', err);
  }
});

/* ------------------------------------------------------------------ *
 * Context menus
 * ------------------------------------------------------------------ */

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;

    chrome.contextMenus.create({
      id: MENU_OPEN_PANEL,
      title: '在 DeepSeek 侧边栏中打开',
      contexts: ['page', 'selection', 'link', 'image'],
    });

    chrome.contextMenus.create({
      id: MENU_OPEN_WINDOW,
      title: '在独立窗口中打开 DeepSeek',
      contexts: ['page', 'selection', 'link', 'image'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_OPEN_WINDOW) {
    await openStandaloneWindow();
    return;
  }

  if (info.menuItemId !== MENU_OPEN_PANEL) return;

  try {
    if (tab && tab.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.warn('[DeepSeek Sidebar] context menu open failed:', err);
    await openStandaloneWindow();
  }
});

async function openStandaloneWindow() {
  const { landingUrl } = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.windows.create({
    url: landingUrl,
    type: 'popup',
    width: 480,
    height: 860,
  });
}

/* ------------------------------------------------------------------ *
 * 划词翻译 — engine plumbing
 * ------------------------------------------------------------------ */

const LANG_LABELS = {
  auto: '自动',
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
};

const TARGET_NAMES = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  en: 'English',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
};

const HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

/** Resolve 'auto' into a concrete target language. */
function resolveTargetLang(text, pref) {
  if (pref && pref !== 'auto' && TARGET_NAMES[pref]) return pref;
  // Chinese/Japanese/Korean source -> English; anything else -> Chinese.
  return HAS_CJK.test(text) ? 'en' : 'zh-CN';
}

function buildMessages(text, target) {
  const name = TARGET_NAMES[target] || TARGET_NAMES['zh-CN'];
  const system = [
    'You are a precise translation engine embedded in a browser sidebar.',
    `Translate the text the user sends into ${name}.`,
    'Rules:',
    '- Output ONLY the translation. No explanations, no pinyin, no notes, no quotation marks.',
    '- Preserve meaning, tone, line breaks, numbers, code, URLs and proper nouns exactly.',
    '- If the text is already in the target language, output it unchanged.',
    '- For a single word or short phrase, give the most natural equivalent only.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];
}

/** Remove wrapping quotes / stray "Translation:" prefixes models sometimes add. */
function cleanTranslation(raw) {
  let out = String(raw || '').trim();

  out = out.replace(/^(translation|译文|翻译)\s*[:：]\s*/i, '');
  out = out.replace(/^["“「]/, '').replace(/["”」]$/, '');

  return out.trim();
}

/* --------------------------- DeepSeek API ------------------------------ */

async function translateWithDeepSeek(text, target, apiKey) {
  const maxTokens = Math.min(4096, Math.max(256, Math.ceil(text.length * 2.5) + 64));

  let res;
  try {
    res = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: buildMessages(text, target),
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
    });
  } catch {
    return { ok: false, code: 'network' };
  }

  if (res.status === 401 || res.status === 403) return { ok: false, code: 'bad-key' };
  if (res.status === 402) return { ok: false, code: 'quota' };
  if (res.status === 429) return { ok: false, code: 'rate-limit' };

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || '';
    } catch {
      /* ignore */
    }
    return { ok: false, code: 'api-error', message: detail || 'DeepSeek 接口返回 ' + res.status };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, code: 'api-error', message: '返回内容无法解析' };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) return { ok: false, code: 'api-error', message: '接口没有返回译文' };

  return { ok: true, translation: cleanTranslation(content), engine: 'deepseek', engineLabel: 'DeepSeek' };
}

/* ---------------------------- Free engine ------------------------------ */

function freeSourceLang(text) {
  return HAS_CJK.test(text) ? 'zh-CN' : 'en';
}

async function translateWithFree(text, target) {
  if (text.length > FREE_MAX_CHARS) {
    return { ok: false, code: 'too-long-free' };
  }

  const source = freeSourceLang(text);
  if (source === target) {
    // Nothing to translate; echo back rather than burning a request.
    return { ok: true, translation: text, engine: 'none', engineLabel: '' };
  }

  const url =
    FREE_API +
    '?q=' +
    encodeURIComponent(text) +
    '&langpair=' +
    encodeURIComponent(source + '|' + target);

  let res;
  try {
    res = await fetch(url, { method: 'GET' });
  } catch {
    return { ok: false, code: 'network' };
  }

  if (res.status === 429) return { ok: false, code: 'rate-limit' };
  if (!res.ok) return { ok: false, code: 'api-error', message: '免费接口返回 ' + res.status };

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, code: 'api-error', message: '返回内容无法解析' };
  }

  const status = Number(data?.responseStatus);
  if (data?.quotaFinished) return { ok: false, code: 'rate-limit' };
  if (status && status !== 200) {
    return { ok: false, code: 'api-error', message: data?.responseDetails || '免费接口错误' };
  }

  const out = data?.responseData?.translatedText;
  if (!out) return { ok: false, code: 'api-error', message: '免费接口没有返回译文' };

  return { ok: true, translation: cleanTranslation(out), engine: 'free', engineLabel: '免费接口' };
}

/* ------------------------------ Dispatch ------------------------------- */

/** Small session cache so re-selecting the same text is instant. */
const translationCache = new Map();
const CACHE_LIMIT = 60;

function cacheKey(text, target, apiKey, allowFree) {
  const engine = apiKey ? 'ds' : allowFree ? 'free' : 'none';
  return engine + '|' + target + '|' + text;
}

function rememberCache(key, value) {
  if (translationCache.size >= CACHE_LIMIT) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
  translationCache.set(key, value);
}

async function handleTranslate(message) {
  const text = String(message.text || '').trim().slice(0, MAX_TEXT_LEN);
  if (!text) return { ok: false, code: 'empty' };

  const sync = await chrome.storage.sync.get({
    targetLang: 'auto',
    allowFreeEngine: false,
  });
  const { apiKey } = await chrome.storage.local.get({ apiKey: '' });

  const target = resolveTargetLang(text, message.targetLang || sync.targetLang);
  const allowFree = !!sync.allowFreeEngine;
  const key = cacheKey(text, target, apiKey, allowFree);

  const cached = translationCache.get(key);
  if (cached) return { ...cached, cached: true };

  let result;
  if (apiKey) {
    result = await translateWithDeepSeek(text, target, apiKey);
  } else if (allowFree) {
    result = await translateWithFree(text, target);
  } else {
    result = { ok: false, code: 'need-setup' };
  }

  if (result.ok) {
    result.targetLang = target;
    rememberCache(key, result);
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Messaging
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  switch (message.type) {
    case 'ds:translate': {
      handleTranslate(message).then(
        (result) => sendResponse(result),
        (err) => {
          console.warn('[DeepSeek Sidebar] translate failed:', err);
          sendResponse({ ok: false, code: 'network' });
        },
      );
      return true;
    }

    case 'ds:openTab': {
      chrome.tabs.create({ url: message.url }).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
      return true;
    }

    case 'ds:openWindow': {
      chrome.windows
        .create({ url: message.url, type: 'popup', width: 480, height: 860 })
        .then(
          () => sendResponse({ ok: true }),
          (err) => sendResponse({ ok: false, error: String(err) }),
        );
      return true;
    }

    case 'ds:openOptions': {
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });

  buildContextMenus();
  await applyPanelBehavior();

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  buildContextMenus();
  void applyPanelBehavior();
});

void applyPanelBehavior();
