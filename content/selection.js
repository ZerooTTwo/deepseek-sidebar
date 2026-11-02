/**
 * DeepSeek Sidebar — 划词翻译 (select-to-translate)
 *
 * Injected into every http(s) frame. On a text selection it shows a small
 * floating 译 button; clicking it opens a popover with the translation.
 *
 * Design notes:
 *  - The UI lives in a closed-off Shadow DOM attached to a single host element,
 *    so host-page CSS can neither leak in nor be affected by our styles.
 *  - Styles are applied through a constructable stylesheet (adoptedStyleSheets)
 *    rather than a <style>/<link>, because an injected <style> is subject to the
 *    page's own `style-src` CSP and would silently vanish on strict sites.
 *  - Nothing is translated until the user clicks: selecting text alone never
 *    sends data anywhere.
 *  - Because we run in `all_frames`, the popover renders in whichever frame
 *    holds the selection, so coordinates are always correct.
 */

(() => {
  'use strict';

  if (window.__dsTranslateReady) return;
  window.__dsTranslateReady = true;

  const MIN_LEN = 1;
  const MAX_LEN = 2000;
  const REQUEST_TIMEOUT_MS = 30000;

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

  /* ------------------------------------------------------------------ *
   * Styles (applied via adoptedStyleSheets — CSP-safe)
   * ------------------------------------------------------------------ */

  const CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      color-scheme: light dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
    }

    .btn {
      position: absolute;
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 9px;
      pointer-events: auto;
      cursor: pointer;
      font: 600 14px/1 inherit;
      color: #fff;
      background: linear-gradient(135deg, #5b78ff, #4d6bfe);
      box-shadow: 0 4px 14px rgba(77, 107, 254, 0.45), 0 1px 3px rgba(0, 0, 0, 0.22);
      transition: transform 0.12s ease, filter 0.12s ease;
      animation: ds-pop 0.14s ease-out;
    }
    .btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
    .btn:active { transform: scale(0.94); }
    .btn[hidden] { display: none; }

    @keyframes ds-pop {
      from { opacity: 0; transform: scale(0.8); }
      to   { opacity: 1; transform: scale(1); }
    }

    .card {
      position: absolute;
      display: flex;
      flex-direction: column;
      max-height: min(52vh, 420px);
      pointer-events: auto;
      border-radius: 14px;
      overflow: hidden;
      background: #ffffff;
      color: #16181d;
      border: 1px solid rgba(17, 20, 45, 0.1);
      box-shadow: 0 16px 44px rgba(17, 20, 45, 0.2), 0 2px 8px rgba(17, 20, 45, 0.1);
      animation: ds-rise 0.16s ease-out;
    }
    .card[hidden] { display: none; }

    @keyframes ds-rise {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-color-scheme: dark) {
      .card {
        background: #1b1d22;
        color: #e9ebf1;
        border-color: rgba(255, 255, 255, 0.1);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.4);
      }
    }

    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 10px 8px 13px;
      border-bottom: 1px solid rgba(17, 20, 45, 0.07);
      flex: none;
    }
    @media (prefers-color-scheme: dark) {
      .head { border-bottom-color: rgba(255, 255, 255, 0.08); }
    }

    .lang {
      font: 600 11.5px/1.4 inherit;
      letter-spacing: 0.01em;
      color: #4d6bfe;
      white-space: nowrap;
    }

    .engine {
      font: 500 10.5px/1.4 inherit;
      letter-spacing: 0.02em;
      padding: 2px 6px;
      border-radius: 999px;
      color: #6b7180;
      background: rgba(17, 20, 45, 0.06);
      white-space: nowrap;
    }
    @media (prefers-color-scheme: dark) {
      .engine { color: #98a0b0; background: rgba(255, 255, 255, 0.08); }
    }

    .spacer { flex: 1 1 auto; }

    .close {
      flex: none;
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #8b90a0;
      font: 400 15px/1 inherit;
      cursor: pointer;
    }
    .close:hover { background: rgba(17, 20, 45, 0.07); color: #16181d; }
    @media (prefers-color-scheme: dark) {
      .close:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
    }

    .body {
      flex: 1 1 auto;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 11px 13px 12px;
      font: 400 13.5px/1.65 inherit;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
    }

    .body::-webkit-scrollbar { width: 8px; }
    .body::-webkit-scrollbar-thumb {
      background: rgba(17, 20, 45, 0.18);
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: content-box;
    }

    .state {
      display: flex;
      align-items: center;
      gap: 9px;
      font: 400 12.5px/1.6 inherit;
      color: #6b7180;
    }
    @media (prefers-color-scheme: dark) {
      .state { color: #98a0b0; }
    }

    .state.is-error { color: #c2410c; }
    @media (prefers-color-scheme: dark) {
      .state.is-error { color: #fb923c; }
    }

    .dot {
      flex: none;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      border: 2px solid rgba(77, 107, 254, 0.28);
      border-top-color: #4d6bfe;
      animation: ds-spin 0.75s linear infinite;
    }
    @keyframes ds-spin { to { transform: rotate(360deg); } }

    .foot {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 9px;
      border-top: 1px solid rgba(17, 20, 45, 0.07);
      background: rgba(17, 20, 45, 0.025);
      flex: none;
    }
    @media (prefers-color-scheme: dark) {
      .foot {
        border-top-color: rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
      }
    }

    .act {
      padding: 4px 9px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: #5c6272;
      font: 500 11.5px/1.6 inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .act:hover { background: rgba(17, 20, 45, 0.07); color: #16181d; }
    .act[hidden] { display: none; }
    @media (prefers-color-scheme: dark) {
      .act { color: #9aa2b2; }
      .act:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
    }

    @media (prefers-reduced-motion: reduce) {
      .btn, .card { animation: none; transition: none; }
      .dot { animation-duration: 2s; }
    }
  `;

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  let host = null;
  let root = null;
  let btn = null;
  let card = null;
  let els = null;

  let settings = { translateEnabled: true, targetLang: 'auto', allowFreeEngine: false };
  let requestSeq = 0;
  let pendingText = '';
  let lastResult = null;
  let lastSelectionRect = null;

  const isAlive = () => {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  };

  /* ------------------------------------------------------------------ *
   * UI construction
   * ------------------------------------------------------------------ */

  function buildUi() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'ds-translate-root';
    // The host must not affect layout; everything of ours lives in the shadow root.
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';

    root = host.attachShadow({ mode: 'open' });

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      // Very old engine: fall back to an inline <style> (may be blocked by CSP).
      const style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }

    btn = document.createElement('button');
    btn.className = 'btn';
    btn.type = 'button';
    btn.textContent = '译';
    btn.title = '翻译选中内容';
    btn.hidden = true;

    card = document.createElement('div');
    card.className = 'card';
    card.hidden = true;
    card.innerHTML = `
      <div class="head">
        <span class="lang"></span>
        <span class="engine" hidden></span>
        <span class="spacer"></span>
        <button class="close" type="button" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="body"></div>
      <div class="foot">
        <button class="act" type="button" data-act="copy" hidden>复制</button>
        <button class="act" type="button" data-act="retry" hidden>重试</button>
        <span class="spacer"></span>
        <button class="act" type="button" data-act="settings">设置</button>
      </div>`;

    root.append(btn, card);

    els = {
      lang: card.querySelector('.lang'),
      engine: card.querySelector('.engine'),
      body: card.querySelector('.body'),
      close: card.querySelector('.close'),
      copy: card.querySelector('[data-act="copy"]'),
      retry: card.querySelector('[data-act="retry"]'),
      settings: card.querySelector('[data-act="settings"]'),
    };

    (document.body || document.documentElement).appendChild(host);

    btn.addEventListener('mousedown', (e) => {
      // Keep the text selection alive while the button is pressed.
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void translate(pendingText);
    });

    els.close.addEventListener('click', hideCard);
    els.copy.addEventListener('click', copyResult);
    els.retry.addEventListener('click', () => void translate(pendingText));
    els.settings.addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'ds:openOptions' });
      } catch {
        /* extension went away */
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Positioning
   * ------------------------------------------------------------------ */

  function placeButton(rect) {
    const size = 28;
    const gap = 7;
    let left = rect.left + rect.width / 2 - size / 2;
    let top = rect.top - size - gap;

    if (top < 4) top = rect.bottom + gap; // no room above the selection
    left = Math.max(6, Math.min(left, window.innerWidth - size - 6));
    top = Math.max(4, Math.min(top, window.innerHeight - size - 4));

    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
  }

  function placeCard(rect) {
    const margin = 8;
    const width = Math.min(348, window.innerWidth - margin * 2);
    card.style.width = width + 'px';

    const height = Math.min(card.offsetHeight || 140, window.innerHeight - margin * 2);

    let left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    let top = rect.bottom + 9;

    if (top + height > window.innerHeight - margin) {
      const above = rect.top - height - 9;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }

    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  /* ------------------------------------------------------------------ *
   * Card rendering
   * ------------------------------------------------------------------ */

  function showLoading(target) {
    lastResult = null;
    els.lang.textContent = '译为 ' + (LANG_LABELS[target] || target);
    els.engine.hidden = true;
    els.copy.hidden = true;
    els.retry.hidden = true;
    els.body.replaceChildren();

    const state = document.createElement('div');
    state.className = 'state';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = '正在翻译…';
    state.append(dot, label);
    els.body.appendChild(state);
  }

  function showError(message, options = {}) {
    els.engine.textContent = '';
    els.engine.hidden = true;
    els.copy.hidden = true;
    els.retry.hidden = !options.canRetry;

    const state = document.createElement('div');
    state.className = 'state is-error';
    state.textContent = message;
    els.body.replaceChildren(state);

    // The outcome must be visible even if something transiently hid the card.
    card.hidden = false;
    if (lastAnchor) placeCard(lastAnchor);
  }

  function showResult(translation, engineLabel) {
    els.engine.textContent = engineLabel;
    els.engine.hidden = !engineLabel;
    els.copy.hidden = false;
    els.retry.hidden = false;

    const text = document.createElement('div');
    text.textContent = translation;
    els.body.replaceChildren(text);

    card.hidden = false;
    if (lastAnchor) placeCard(lastAnchor);
  }

  let lastAnchor = null;

  function hideButton() {
    if (btn) btn.hidden = true;
  }

  function hideCard() {
    if (card) card.hidden = true;
    lastResult = null;
    // Invalidate any in-flight request so a late reply cannot reopen the card
    // the user just closed.
    requestSeq++;
  }

  function hideAll() {
    hideButton();
    hideCard();
  }

  async function copyResult() {
    if (!lastResult) return;
    try {
      await navigator.clipboard.writeText(lastResult);
      els.copy.textContent = '已复制';
      setTimeout(() => {
        if (els) els.copy.textContent = '复制';
      }, 1200);
    } catch {
      els.copy.textContent = '复制失败';
      setTimeout(() => {
        if (els) els.copy.textContent = '复制';
      }, 1200);
    }
  }

  /* ------------------------------------------------------------------ *
   * Translation
   * ------------------------------------------------------------------ */

  function errorMessageFor(code, fallback) {
    switch (code) {
      case 'need-setup':
        return '还没有配置翻译引擎。点「设置」填入 DeepSeek API Key，或启用免费翻译接口。';
      case 'bad-key':
        return 'DeepSeek API Key 无效或已过期，请在设置中更新。';
      case 'quota':
        return 'DeepSeek 账户余额不足，请到 platform.deepseek.com 充值。';
      case 'rate-limit':
        return '请求太频繁，请稍后再试。';
      case 'too-long-free':
        return '免费翻译接口单次上限约 500 字符，长文本请在设置中配置 API Key。';
      case 'network':
        return '网络请求失败，请检查网络后重试。';
      case 'timeout':
        return '翻译超时，请重试。';
      default:
        return fallback || '翻译失败，请重试。';
    }
  }

  async function translate(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    buildUi();
    pendingText = trimmed;

    hideButton();
    card.hidden = false;
    // Anchor the card to the selection itself when we still know it.
    lastAnchor = lastSelectionRect || btnRectAnchor();
    showLoading(settings.targetLang);

    const seq = ++requestSeq;

    const request = (async () => {
      try {
        return await chrome.runtime.sendMessage({
          type: 'ds:translate',
          text: trimmed,
          targetLang: settings.targetLang,
        });
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/context invalidated|Receiving end does not exist/i.test(msg)) {
          return { ok: false, code: 'reload', message: '扩展已更新，请刷新页面后重试。' };
        }
        return { ok: false, code: 'network' };
      }
    })();

    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, code: 'timeout' }), REQUEST_TIMEOUT_MS);
    });

    const response = await Promise.race([request, timeout]);

    if (seq !== requestSeq) return; // a newer request superseded this one

    if (!response || !response.ok) {
      showError(errorMessageFor(response && response.code, response && response.message), {
        canRetry: response && response.code !== 'need-setup',
      });
      return;
    }

    lastResult = response.translation;
    showResult(response.translation, response.engineLabel || '');
    if (lastAnchor) placeCard(lastAnchor);
  }

  /** The button carries the anchor position for the card. */
  function btnRectAnchor() {
    if (!btn || btn.hidden) return lastAnchor || { left: 40, top: 40, bottom: 40, width: 0 };
    const r = btn.getBoundingClientRect();
    return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }

  /* ------------------------------------------------------------------ *
   * Selection detection
   * ------------------------------------------------------------------ */

  const SKIP_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

  function readSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const text = sel.toString().replace(/\u00a0/g, ' ').trim();
    if (text.length < MIN_LEN || text.length > MAX_LEN) return null;
    // Ignore selections that are only punctuation/whitespace/numbers.
    if (!/[\p{L}\p{N}]/u.test(text)) return null;

    let range;
    try {
      range = sel.getRangeAt(0);
    } catch {
      return null;
    }

    const node = range.startContainer;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (el && typeof el.closest === 'function' && el.closest(SKIP_SELECTOR)) return null;

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    // Selection may be scrolled out of view.
    if (rect.bottom < 0 || rect.top > window.innerHeight) return null;

    return { text, rect };
  }

  function maybeShowButton(event) {
    if (!settings.translateEnabled) return;
    if (!isAlive()) return;

    // Never react to interactions with our own UI.
    if (host && event && typeof event.composedPath === 'function') {
      if (event.composedPath().includes(host)) return;
    }

    const found = readSelection();
    if (!found) {
      hideButton();
      return;
    }

    buildUi();

    const { text, rect } = found;
    pendingText = text;
    lastSelectionRect = rect;
    placeButton(rect);
    btn.hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  let scheduled = false;

  function scheduleCheck(event) {
    if (scheduled) return;
    scheduled = true;
    // Let the browser finish updating the selection first.
    setTimeout(() => {
      scheduled = false;
      maybeShowButton(event);
    }, 12);
  }

  document.addEventListener(
    'mouseup',
    (event) => {
      if (event.button !== 0) return;
      scheduleCheck(event);
    },
    true,
  );

  document.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Shift' || (event.shiftKey && event.key.startsWith('Arrow'))) {
        scheduleCheck(event);
      }
    },
    true,
  );

  document.addEventListener(
    'mousedown',
    (event) => {
      if (!host || !card || card.hidden) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (!path.includes(host)) hideCard();
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') hideAll();
    },
    true,
  );

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if ((!sel || sel.isCollapsed) && btn && !btn.hidden) hideButton();
  });

  // Resizing must not throw away a translation the user is reading; just
  // re-anchor our floating UI to the (unchanged) selection rectangle.
  window.addEventListener(
    'resize',
    () => {
      if (!lastSelectionRect) return;
      if (btn && !btn.hidden) placeButton(lastSelectionRect);
      if (card && !card.hidden) placeCard(lastSelectionRect);
    },
    { passive: true },
  );

  window.addEventListener('blur', hideButton, { passive: true });

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */

  async function loadSettings() {
    if (!isAlive()) return;
    try {
      const sync = await chrome.storage.sync.get({
        translateEnabled: true,
        targetLang: 'auto',
        allowFreeEngine: false,
      });
      settings = {
        translateEnabled: sync.translateEnabled !== false,
        targetLang: sync.targetLang || 'auto',
        allowFreeEngine: !!sync.allowFreeEngine,
      };
      if (!settings.translateEnabled) hideAll();
    } catch {
      /* keep defaults */
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.translateEnabled) {
        settings.translateEnabled = changes.translateEnabled.newValue !== false;
        if (!settings.translateEnabled) hideAll();
      }
      if (changes.targetLang) {
        settings.targetLang = changes.targetLang.newValue || 'auto';
      }
      if (changes.allowFreeEngine) {
        settings.allowFreeEngine = !!changes.allowFreeEngine.newValue;
      }
    });
  } catch {
    /* extension reloaded */
  }

  void loadSettings();
})();
