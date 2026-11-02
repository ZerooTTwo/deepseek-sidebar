/**
 * DeepSeek Sidebar — options controller
 *
 * Settings live in chrome.storage.sync so they follow the Chrome profile.
 * The DeepSeek API key is the exception: it is stored in chrome.storage.local
 * so it never syncs to other machines or to the Google account.
 */

const DEFAULTS = {
  landingUrl: 'https://chat.deepseek.com/',
  showToolbar: true,
  translateEnabled: true,
  targetLang: 'auto',
  allowFreeEngine: false,
};

const PRESET_URLS = ['https://chat.deepseek.com/', 'https://www.deepseek.com/'];

const TEST_SENTENCE = 'Hello! This sentence checks whether select-to-translate works.';

const el = {
  version: document.getElementById('version'),
  welcome: document.getElementById('welcome'),
  radios: Array.from(document.querySelectorAll('input[name="landing"]')),
  customField: document.getElementById('custom-field'),
  customUrl: document.getElementById('custom-url'),
  customError: document.getElementById('custom-error'),
  showToolbar: document.getElementById('show-toolbar'),
  translateEnabled: document.getElementById('translate-enabled'),
  targetLang: document.getElementById('target-lang'),
  apiKey: document.getElementById('api-key'),
  toggleKey: document.getElementById('toggle-key'),
  allowFree: document.getElementById('allow-free'),
  testTranslate: document.getElementById('test-translate'),
  testResult: document.getElementById('test-result'),
  checks: document.getElementById('checks'),
  save: document.getElementById('save'),
  reset: document.getElementById('reset'),
  recheck: document.getElementById('recheck'),
  testPanel: document.getElementById('test-panel'),
  toast: document.getElementById('toast'),
};

function normalize(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!/(^|\.)deepseek\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

let toastTimer = null;

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2000);
}

function setCheck(key, status, text) {
  const row = el.checks.querySelector(`.check[data-key="${key}"]`);
  if (!row) return;
  row.classList.remove('is-ok', 'is-warn', 'is-bad');
  row.classList.add(`is-${status}`);
  row.querySelector('.check__value').textContent = text;
}

function errorText(code, message) {
  switch (code) {
    case 'need-setup':
      return '未配置翻译引擎：请填写 API Key，或启用免费翻译接口。';
    case 'bad-key':
      return 'API Key 无效或已过期。';
    case 'quota':
      return 'DeepSeek 账户余额不足。';
    case 'rate-limit':
      return '请求过于频繁，请稍后再试。';
    case 'too-long-free':
      return '免费接口单次上限约 500 字符。';
    case 'network':
      return '网络请求失败，请检查网络。';
    case 'timeout':
      return '请求超时。';
    default:
      return message || '翻译失败。';
  }
}

function paint(url) {
  const preset = PRESET_URLS.includes(url);
  const custom = !preset;

  for (const radio of el.radios) {
    if (custom) {
      radio.checked = radio.value === 'custom';
    } else {
      radio.checked = radio.value === url;
    }
  }

  el.customField.hidden = !custom;
  if (custom) el.customUrl.value = url;
  el.customField.classList.remove('is-invalid');
  el.customError.hidden = true;
}

function selectedUrl() {
  const picked = el.radios.find((r) => r.checked);
  if (!picked || picked.value === 'custom') {
    return normalize(el.customUrl.value) ?? PRESET_URLS[0];
  }
  return picked.value;
}

function validate() {
  const picked = el.radios.find((r) => r.checked);
  if (!picked || picked.value !== 'custom') {
    el.customField.classList.remove('is-invalid');
    el.customError.hidden = true;
    return true;
  }

  const ok = normalize(el.customUrl.value) !== null;
  el.customField.classList.toggle('is-invalid', !ok);
  el.customError.hidden = ok;
  return ok;
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const local = await chrome.storage.local.get({ apiKey: '' });

  paint(stored.landingUrl || DEFAULTS.landingUrl);
  el.showToolbar.checked = stored.showToolbar !== false;
  el.translateEnabled.checked = stored.translateEnabled !== false;
  el.targetLang.value = stored.targetLang || 'auto';
  el.allowFree.checked = !!stored.allowFreeEngine;
  el.apiKey.value = local.apiKey || '';
}

async function persist() {
  await chrome.storage.sync.set({
    landingUrl: selectedUrl(),
    showToolbar: el.showToolbar.checked,
    translateEnabled: el.translateEnabled.checked,
    targetLang: el.targetLang.value,
    allowFreeEngine: el.allowFree.checked,
  });
  await chrome.storage.local.set({ apiKey: el.apiKey.value.trim() });
}

function chromeMajor() {
  const match = navigator.userAgent.match(/Chrome\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

async function runDiagnostics() {
  try {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    if (enabled.includes('ds_frame_headers')) {
      setCheck('rules', 'ok', '已启用，可移除嵌入限制');
    } else {
      setCheck('rules', 'bad', '未启用 — 请在 chrome://extensions 重新加载扩展');
    }
  } catch {
    setCheck('rules', 'bad', '无法读取规则状态');
  }

  try {
    const granted = await chrome.permissions.contains({
      origins: ['*://*.deepseek.com/*'],
    });
    if (granted) {
      setCheck('perm', 'ok', '已授权 deepseek.com');
    } else {
      setCheck('perm', 'bad', '未授权 deepseek.com');
    }
  } catch {
    setCheck('perm', 'warn', '无法检测');
  }

  try {
    const local = await chrome.storage.local.get({ apiKey: '' });
    const sync = await chrome.storage.sync.get(DEFAULTS);
    if (local.apiKey) {
      setCheck('engine', 'ok', 'DeepSeek API（已配置 Key）');
    } else if (sync.allowFreeEngine) {
      setCheck('engine', 'warn', '免费接口（未配置 Key）');
    } else {
      setCheck('engine', 'warn', '未配置 — 划词翻译暂不可用');
    }
  } catch {
    setCheck('engine', 'warn', '无法检测');
  }

  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    setCheck('panel', 'ok', '可用');
  } else {
    setCheck('panel', 'bad', '不可用 — 需要 Chrome 116+');
  }

  const major = chromeMajor();
  if (major >= 116) {
    setCheck('browser', 'ok', `Chrome ${major}`);
  } else if (major >= 114) {
    setCheck('browser', 'warn', `Chrome ${major}（建议 116+）`);
  } else {
    setCheck('browser', 'bad', major ? `Chrome ${major} 过低` : '非 Chrome 内核');
  }
}

for (const radio of el.radios) {
  radio.addEventListener('change', () => {
    const isCustom = radio.value === 'custom';
    el.customField.hidden = !isCustom;
    if (isCustom) {
      el.customUrl.focus();
      if (!el.customUrl.value) el.customUrl.value = PRESET_URLS[0];
    }
    validate();
  });
}

el.customUrl.addEventListener('input', validate);

el.toggleKey.addEventListener('click', () => {
  const showing = el.apiKey.type === 'text';
  el.apiKey.type = showing ? 'password' : 'text';
  el.toggleKey.textContent = showing ? '显示' : '隐藏';
});

el.save.addEventListener('click', async () => {
  if (!validate()) {
    el.customUrl.focus();
    return;
  }

  await persist();
  toast('设置已保存');
  void runDiagnostics();

  chrome.runtime.sendMessage({ type: 'ds:settingsChanged' }).catch(() => {});
});

el.reset.addEventListener('click', async () => {
  await chrome.storage.sync.set({ ...DEFAULTS });
  await chrome.storage.local.set({ apiKey: '' });

  paint(DEFAULTS.landingUrl);
  el.showToolbar.checked = DEFAULTS.showToolbar;
  el.translateEnabled.checked = DEFAULTS.translateEnabled;
  el.targetLang.value = DEFAULTS.targetLang;
  el.allowFree.checked = DEFAULTS.allowFreeEngine;
  el.apiKey.value = '';
  el.apiKey.type = 'password';
  el.toggleKey.textContent = '显示';
  el.testResult.textContent = '';

  toast('已恢复默认设置');
  void runDiagnostics();
});

el.recheck.addEventListener('click', () => {
  for (const row of el.checks.querySelectorAll('.check')) {
    row.classList.remove('is-ok', 'is-warn', 'is-bad');
    row.querySelector('.check__value').textContent = '检测中…';
  }
  void runDiagnostics();
});

el.testPanel.addEventListener('click', async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    toast('已展开侧边栏');
  } catch (err) {
    toast('无法展开侧边栏：' + (err?.message || err));
  }
});

el.testTranslate.addEventListener('click', async () => {
  if (!validate()) {
    el.customUrl.focus();
    return;
  }

  el.testTranslate.disabled = true;
  el.testResult.className = 'test-result';
  el.testResult.textContent = '正在翻译…';

  try {
    // Use the values currently on screen, not whatever was last saved.
    await persist();

    const res = await chrome.runtime.sendMessage({
      type: 'ds:translate',
      text: TEST_SENTENCE,
      targetLang: el.targetLang.value,
    });

    if (res && res.ok) {
      el.testResult.className = 'test-result is-ok';
      el.testResult.textContent = `✓ ${res.translation}` + (res.engineLabel ? `（${res.engineLabel}）` : '');
      toast('翻译成功');
    } else {
      el.testResult.className = 'test-result is-bad';
      el.testResult.textContent = '✕ ' + errorText(res && res.code, res && res.message);
    }
  } catch (err) {
    el.testResult.className = 'test-result is-bad';
    el.testResult.textContent = '✕ ' + (err?.message || '请求失败');
  } finally {
    el.testTranslate.disabled = false;
    void runDiagnostics();
  }
});

(async function boot() {
  el.version.textContent = chrome.runtime.getManifest().version;

  if (new URLSearchParams(location.search).get('welcome') === '1') {
    el.welcome.hidden = false;
  }

  await loadSettings();
  await runDiagnostics();
})();
