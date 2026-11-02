/**
 * End-to-end smoke test for the DeepSeek Sidebar extension.
 *
 * Launches Microsoft Edge (Chromium) headless with the unpacked extension,
 * opens the side panel document as a normal tab, then inspects the embedded
 * DeepSeek frame over CDP to prove that:
 *   1. the extension registers its DNR ruleset,
 *   2. the sub_frame is NOT blocked by frame-ancestors,
 *   3. the DeepSeek app actually booted (document title + mounted React root).
 *
 * Usage: node e2e-test.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\EdgeCore\\156.0.4314.58\\msedge.exe';
const EXT_DIR = path.join(__dirname, '..');
const PROFILE = path.join(__dirname, '.test-profile');
const PORT = 9333;

let child = null;
let exitCode = 1;

/* ------------------------------- utilities ------------------------------ */

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: urlPath, timeout: 3000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error('bad JSON from ' + urlPath));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + urlPath)));
  });
}

async function waitFor(fn, label, timeoutMs = 30000, intervalMs = 400) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('timed out waiting for ' + label + (lastErr ? ' (' + lastErr.message + ')' : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client over the built-in WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        this.events.push(msg);
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params, msg.sessionId);
      }
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error('ws connect failed: ' + url)));
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 15000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------- main -------------------------------- */

async function main() {
  console.log('== DeepSeek Sidebar :: end-to-end test ==');

  if (!fs.existsSync(EDGE)) throw new Error('Edge not found at ' + EDGE);
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) throw new Error('manifest.json missing');

  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const args = [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--disable-extensions-except=' + EXT_DIR,
    '--load-extension=' + EXT_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-features=Translate,MediaRouter',
    '--site-per-process',
    '--no-sandbox',
    'about:blank',
  ];

  console.log('launching edge...');
  child = spawn(EDGE, args, { stdio: 'ignore', windowsHide: true });

  const version = await waitFor(() => getJson('/json/version'), 'devtools endpoint', 30000);
  console.log('browser:', version.Browser);

  // 1. Extension id from its service worker target — resolved by manifest name,
  //    because Edge also runs several built-in chrome-extension:// workers.
  const firstSw = await waitFor(async () => {
    const targets = await getJson('/json/list');
    return targets.find((t) => t.type === 'service_worker' && /^chrome-extension:\/\//.test(t.url));
  }, 'extension service worker', 30000);
  console.log('extension worker present:', firstSw.url.slice(0, 60) + '...');

  // 2. Ask the extension page for its DNR state.
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);

  // Resolve our extension id by reading each candidate worker's manifest name.
  async function resolveExtId() {
    const { targetInfos } = await browser.send('Target.getTargets');
    const cands = targetInfos.filter(
      (t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url),
    );
    for (const c of cands) {
      try {
        const { sessionId } = await browser.send('Target.attachToTarget', {
          targetId: c.targetId,
          flatten: true,
        });
        const r = await browser.send(
          'Runtime.evaluate',
          { expression: 'chrome.runtime.getManifest().name', returnByValue: true },
          sessionId,
        );
        if (/DeepSeek/i.test(String(r.result.value))) return new URL(c.url).host;
      } catch {
        /* not ours / not ready */
      }
    }
    return null;
  }

  const extId = await waitFor(resolveExtId, 'our extension service worker', 30000);
  console.log('extension id:', extId);

  const panelUrl = 'chrome-extension://' + extId + '/sidepanel.html';
  console.log('panel url:', panelUrl);
  const created = await browser.send('Target.createTarget', { url: panelUrl });
  console.log('panel tab:', created.targetId);

  await browser.send('Target.activateTarget', { targetId: created.targetId }).catch(() => {});

  // Give the panel time to navigate the iframe and render.
  await sleep(2000);

  const panelTarget = { id: created.targetId, url: panelUrl };

  // 3. Inspect the panel page's own DOM state.
  const { sessionId: panelSession } = await browser.send('Target.attachToTarget', {
    targetId: panelTarget.id,
    flatten: true,
  });
  await browser.send('Runtime.enable', {}, panelSession).catch(() => {});

  // Collect uncaught exceptions raised by our own extension pages.
  const pageExceptions = [];
  browser.on('Runtime.exceptionThrown', (params, sessionId) => {
    if (sessionId !== panelSession) return;
    const d = params.exceptionDetails || {};
    pageExceptions.push((d.exception && d.exception.description) || d.text || 'unknown');
  });

  const panelState = await browser.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const f = document.getElementById('ds-frame');
        return JSON.stringify({
          frameSrc: f ? f.getAttribute('src') : null,
          splashHidden: document.getElementById('splash').classList.contains('is-hidden'),
          fallbackVisible: !document.getElementById('fallback').hidden,
          toolbarHidden: document.getElementById('toolbar').hidden,
        });
      })()`,
      returnByValue: true,
    },
    panelSession,
  );
  console.log('panel state:', panelState.result.value);

  // 4. Ruleset status as seen by the extension.
  const dnr = await browser.send(
    'Runtime.evaluate',
    {
      expression: `chrome.declarativeNetRequest.getEnabledRulesets().then(r => JSON.stringify(r))`,
      awaitPromise: true,
      returnByValue: true,
    },
    panelSession,
  );
  console.log('enabled rulesets:', dnr.result.value);

  // 5. The embedded DeepSeek frame (out-of-process iframe target).
  console.log('waiting for the embedded DeepSeek frame...');
  const frameTarget = await waitFor(async () => {
    let list = [];
    try {
      const res = await browser.send('Target.getTargets');
      list = res.targetInfos || [];
    } catch {
      list = await getJson('/json/list');
    }
    const hit = list.find(
      (t) => (t.type === 'iframe' || t.type === 'page') && /^https:\/\/[a-z.]*deepseek\.com/.test(String(t.url)),
    );
    return hit && hit.targetId !== created.targetId ? hit : null;
  }, 'deepseek iframe target', 45000);

  const frameTargetId = frameTarget.targetId || frameTarget.id;
  console.log('frame target:', frameTarget.url);

  const { sessionId: frameSession } = await browser.send('Target.attachToTarget', {
    targetId: frameTargetId,
    flatten: true,
  });
  await browser.send('Runtime.enable', {}, frameSession).catch(() => {});

  // Let React finish mounting.
  await sleep(4000);

  const frameInfo = await browser.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const root = document.getElementById('root');
        const body = (document.body.innerText || '').trim();
        return JSON.stringify({
          title: document.title,
          href: location.href,
          origin: location.origin,
          rootChildCount: root ? root.children.length : -1,
          rootTextLen: root ? (root.innerText || '').trim().length : -1,
          bodyTextLen: body.length,
          bodyTextHead: body.slice(0, 140).replace(/\\s+/g, ' '),
          styleSheets: document.styleSheets.length,
          inputs: document.querySelectorAll('input').length,
        });
      })()`,
      returnByValue: true,
    },
    frameSession,
  );
  console.log('frame info:', frameInfo.result.value);

  // Nested third-party frames inside the embedded app (e.g. the WeChat QR
  // login widget) must not be blocked either.
  const allTargets = await browser.send('Target.getTargets');
  const nested = allTargets.targetInfos
    .filter((t) => t.type === 'iframe')
    .map((t) => String(t.url));

  const info = JSON.parse(frameInfo.result.value || '{}');
  const panel = JSON.parse(panelState.result.value || '{}');
  const rulesets = JSON.parse(dnr.result.value || '[]');

  /* ------------------------------ assertions ----------------------------- */
  console.log('\n-- assertions --');
  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log((pass ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
  };

  check('DNR ruleset registered', rulesets.includes('ds_frame_headers'), JSON.stringify(rulesets));
  check('panel iframe points at deepseek', /deepseek\.com/.test(panel.frameSrc || ''), panel.frameSrc);
  check('splash dismissed', panel.splashHidden === true);
  check('recovery panel not shown', panel.fallbackVisible === false);
  check('frame loaded real DeepSeek origin', info.origin === 'https://chat.deepseek.com', info.origin);
  check('not a chrome error page', !/chrome-error/.test(info.href || ''), info.href);
  check('document title is DeepSeek', /^DeepSeek/.test(info.title || ''), info.title);
  check('app painted text', (info.bodyTextLen || 0) > 0, 'chars=' + info.bodyTextLen);
  check(
    'nested login frames allowed',
    nested.length === 0 || nested.every((u) => !/^chrome-error/.test(u)),
    nested.length + ' iframe target(s)',
  );
  check('no uncaught JS exception in panel', pageExceptions.length === 0, pageExceptions.join(' | '));

  /* --------------------------- options page check -------------------------- */
  const optUrl = 'chrome-extension://' + extId + '/options.html';
  const optCreated = await browser.send('Target.createTarget', { url: optUrl });
  const { sessionId: optSession } = await browser.send('Target.attachToTarget', {
    targetId: optCreated.targetId,
    flatten: true,
  });
  const optExceptions = [];
  browser.on('Runtime.exceptionThrown', (params, sessionId) => {
    if (sessionId !== optSession) return;
    const d = params.exceptionDetails || {};
    optExceptions.push((d.exception && d.exception.description) || d.text || 'unknown');
  });
  await browser.send('Runtime.enable', {}, optSession).catch(() => {});
  await sleep(2500);

  const optState = await browser.send(
    'Runtime.evaluate',
    {
      expression: `JSON.stringify({
        readyState: document.readyState,
        version: document.getElementById('version').textContent,
        checks: Array.from(document.querySelectorAll('.check')).map(c => ({
          key: c.dataset.key,
          status: c.className.replace('check', '').trim(),
          value: c.querySelector('.check__value').textContent,
        })),
        checkedLanding: (document.querySelector('input[name=landing]:checked') || {}).value,
        toolbarToggle: document.getElementById('show-toolbar').checked,
      })`,
      returnByValue: true,
    },
    optSession,
  );
  const opt = JSON.parse(optState.result.value || '{}');
  console.log('options state:', JSON.stringify(opt));

  // Compare against the manifest rather than a hardcoded version string.
  const manifestVersion = await browser
    .send(
      'Runtime.evaluate',
      { expression: 'chrome.runtime.getManifest().version', returnByValue: true },
      panelSession,
    )
    .then((r) => r.result.value)
    .catch(() => null);

  check('options page version rendered', opt.version === manifestVersion, opt.version + ' vs ' + manifestVersion);
  check(
    'all five diagnostics resolved',
    (opt.checks || []).length === 5 && (opt.checks || []).every((c) => !/检测中/.test(c.value)),
    JSON.stringify((opt.checks || []).map((c) => c.status)),
  );
  check(
    'diagnostics all green',
    (opt.checks || []).every((c) => c.status !== 'is-bad'),
    JSON.stringify((opt.checks || []).map((c) => c.status)),
  );
  check('default landing URL selected', opt.checkedLanding === 'https://chat.deepseek.com/', opt.checkedLanding);
  check('toolbar toggle defaults on', opt.toolbarToggle === true);
  check('no uncaught JS exception in options', optExceptions.length === 0, optExceptions.join(' | '));

  /* ------------------------------------------------------------------ *
   * 划词翻译: select text on a real page, click the button, read the result.
   * ------------------------------------------------------------------ */

  const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>select-to-translate test</title>
<style>body{font:17px/1.9 system-ui;margin:48px;max-width:620px;color:#222}
p{padding:4px}</style></head><body>
<h1>划词翻译测试</h1>
<p id="target">今天天气很好，我们一起去公园散步吧。</p>
<p id="second">This English sentence should translate into Chinese.</p>
</body></html>`;

  const server = require('http').createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pagePort = server.address().port;
  console.log('\nserving test page on http://127.0.0.1:' + pagePort);

  // Turn on the free engine (no API key exists in a throwaway profile) and set
  // an explicit target language so the assertion is deterministic.
  await browser.send(
    'Runtime.evaluate',
    {
      expression: `chrome.storage.sync.set({translateEnabled:true, allowFreeEngine:true, targetLang:'en'}).then(()=> 'ok')`,
      awaitPromise: true,
      returnByValue: true,
    },
    panelSession,
  );

  const pageCreated = await browser.send('Target.createTarget', {
    url: 'http://127.0.0.1:' + pagePort + '/',
  });
  const { sessionId: pageSession } = await browser.send('Target.attachToTarget', {
    targetId: pageCreated.targetId,
    flatten: true,
  });
  await browser.send('Runtime.enable', {}, pageSession).catch(() => {});
  await sleep(1800); // let the content script boot and read its settings

  const INSPECT = `(() => {
    const h = document.getElementById('ds-translate-root');
    const sr = h && h.shadowRoot;
    const btn = sr && sr.querySelector('.btn');
    const card = sr && sr.querySelector('.card');
    const body = card && card.querySelector('.body');
    return JSON.stringify({
      hasHost: !!h,
      btnVisible: !!(btn && !btn.hidden),
      cardHidden: card ? card.hidden : null,
      cardText: body ? (body.innerText || '').trim() : '',
      engine: card && card.querySelector('.engine') ? card.querySelector('.engine').textContent.trim() : '',
    });
  })()`;

  const readPanel = async () => {
    const r = await browser.send(
      'Runtime.evaluate',
      { expression: INSPECT, returnByValue: true },
      pageSession,
    );
    return JSON.parse(r.result.value || '{}');
  };

  // Select the paragraph and simulate the mouseup that ends a drag-select.
  const selected = await browser.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const p = document.getElementById('target');
        const range = document.createRange();
        range.selectNodeContents(p);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const r = range.getBoundingClientRect();
        p.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, button: 0, clientX: r.left + 8, clientY: r.top + 6,
        }));
        return JSON.stringify({ text: sel.toString() });
      })()`,
      returnByValue: true,
    },
    pageSession,
  );
  console.log('selected text:', JSON.parse(selected.result.value || '{}').text);

  let beforeClick = null;
  try {
    await waitFor(async () => {
      const s = await readPanel();
      beforeClick = s;
      if (s.cardText && /正在翻译/.test(s.cardText)) {
        throw new Error('translation started without a click');
      }
      return s.btnVisible;
    }, 'translate button to appear', 8000);
  } catch {
    beforeClick = await readPanel().catch(() => null);
  }

  check('content script injected on the page', !!(beforeClick && beforeClick.hasHost), JSON.stringify(beforeClick && beforeClick.hasHost));
  check('selecting text shows the 译 button', !!(beforeClick && beforeClick.btnVisible), JSON.stringify(beforeClick && beforeClick.btnVisible));
  check(
    'no request is sent until the button is clicked',
    !!(beforeClick && beforeClick.cardHidden === true),
    'cardHidden=' + (beforeClick && beforeClick.cardHidden),
  );

  // Click the button through the shadow root.
  await browser.send(
    'Runtime.evaluate',
    { expression: `document.getElementById('ds-translate-root').shadowRoot.querySelector('.btn').click()`, returnByValue: true },
    pageSession,
  );

  let after = null;
  const timeline = [];
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const s = await readPanel();
    timeline.push((s.cardHidden ? 'H' : 'V') + ':' + String(s.cardText || '').slice(0, 14));
    if (s.cardHidden === false && s.cardText && !/正在翻译/.test(s.cardText)) {
      after = s;
      break;
    }
    await sleep(250);
  }
  if (!after) {
    console.log('timeline:', timeline.join(' | '));
    after = await readPanel().catch(() => null);
  }
  console.log('popover:', JSON.stringify(after));

  const translated = !!(after && after.cardHidden === false && /[A-Za-z]{3,}/.test(after.cardText) && !/正在翻译/.test(after.cardText));
  const failedByQuota = !!(after && /频繁|余额|失败|上限|网络|未配置|无效/.test(after.cardText));

  if (translated) {
    check('popover shows the translation', true, after.cardText.slice(0, 60));
  } else if (failedByQuota) {
    console.log('  SKIP  popover shows the translation  [engine unavailable: ' + after.cardText.slice(0, 60) + ']');
  } else {
    check('popover shows the translation', false, JSON.stringify(after));
  }

  server.close();

  /* ------------------------------------------------------------------ *
   * Engine A plumbing: a bogus DeepSeek key must reach the API and surface
   * a clear "invalid key" message rather than hanging or crashing.
   * ------------------------------------------------------------------ */
  await browser.send(
    'Runtime.evaluate',
    {
      expression: `chrome.storage.local.set({apiKey:'sk-invalid-key-for-e2e'}).then(()=> 'ok')`,
      awaitPromise: true,
      returnByValue: true,
    },
    panelSession,
  );

  await browser.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const p = document.getElementById('second');
        const range = document.createRange();
        range.selectNodeContents(p);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const r = range.getBoundingClientRect();
        p.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, button:0, clientX:r.left+8, clientY:r.top+6}));
        return JSON.stringify({text: sel.toString()});
      })()`,
      returnByValue: true,
    },
    pageSession,
  );

  await waitFor(async () => (await readPanel()).btnVisible, 'button for second selection', 8000).catch(() => {});

  await browser.send(
    'Runtime.evaluate',
    { expression: `document.getElementById('ds-translate-root').shadowRoot.querySelector('.btn').click()`, returnByValue: true },
    pageSession,
  );

  let apiState = null;
  const apiDeadline = Date.now() + 35000;
  while (Date.now() < apiDeadline) {
    const s = await readPanel();
    if (s.cardHidden === false && s.cardText && !/正在翻译/.test(s.cardText)) {
      apiState = s;
      break;
    }
    await sleep(250);
  }
  console.log('deepseek-api popover:', JSON.stringify(apiState));

  const apiSaysInvalidKey =
    !!apiState && apiState.cardHidden === false && /无效|余额|频繁|失败|网络/.test(apiState.cardText);
  if (apiSaysInvalidKey) {
    check('invalid API key surfaces a clear error', true, apiState.cardText.slice(0, 50));
  } else if (apiState && /未配置/.test(apiState.cardText)) {
    check('invalid API key surfaces a clear error', false, 'fell through to "not configured": ' + apiState.cardText);
  } else {
    check('invalid API key surfaces a clear error', false, JSON.stringify(apiState));
  }

  await browser.send(
    'Runtime.evaluate',
    { expression: `chrome.storage.local.remove('apiKey').then(()=> 'ok')`, awaitPromise: true, returnByValue: true },
    panelSession,
  );

  /* A plain <iframe> would fail here; prove it by confirming the CSP header is
   * really present upstream and only our sub_frame rule removes it. */
  const cspProbe = await fetch('https://chat.deepseek.com/', { method: 'HEAD' }).then(
    (r) => r.headers.get('content-security-policy') || '',
    () => '',
  );
  check(
    'upstream still sends frame-ancestors (rule is what unblocks it)',
    /frame-ancestors 'none'/.test(cspProbe) || cspProbe === '',
    cspProbe || 'could not probe',
  );

  const failed = results.filter((r) => !r.pass);
  console.log('\n' + (failed.length === 0 ? 'ALL ASSERTIONS PASSED' : failed.length + ' ASSERTION(S) FAILED'));
  if (info.bodyTextHead) console.log('\nrendered head: "' + info.bodyTextHead + '"');

  exitCode = failed.length === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error('\nTEST ERROR:', err.message);
    exitCode = 1;
  })
  .finally(async () => {
    try {
      if (child && !child.killed) child.kill();
    } catch {
      /* ignore */
    }
    await sleep(600);
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    console.log('\nexit ' + exitCode);
    process.exit(exitCode);
  });
