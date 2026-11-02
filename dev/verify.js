// Build-time validation for the DeepSeek Sidebar extension.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let failures = 0;

function ok(msg) {
  console.log('  OK   ' + msg);
}
function bad(msg) {
  console.log('  FAIL ' + msg);
  failures++;
}

function readJson(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  return { data: JSON.parse(text), hasBom, text };
}

/* ---------------------------- JSON + encoding --------------------------- */
console.log('\nJSON / encoding');
const manifest = readJson('manifest.json');
if (manifest.hasBom) bad('manifest.json has a UTF-8 BOM (some Chrome builds dislike it)');
else ok('manifest.json is BOM-free UTF-8');
ok('manifest.json parses');

const rules = readJson('rules/frame.json');
ok('rules/frame.json parses (' + rules.data.length + ' rule)');

console.log('\n  name        : ' + manifest.data.name);
console.log('  version     : ' + manifest.data.version);
console.log('  description : ' + manifest.data.description);

/* ------------------------------- JS syntax ------------------------------ */
console.log('\nJavaScript syntax');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dev' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

for (const file of walk(root)) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(src, { filename: rel });
    ok(rel);
  } catch (err) {
    bad(rel + ' -> ' + err.message);
  }
}

/* --------------------------- referenced assets -------------------------- */
console.log('\nManifest asset references');
const m = manifest.data;
const refs = new Set([
  m.background.service_worker,
  m.side_panel.default_path,
  m.options_ui.page,
  ...m.declarative_net_request.rule_resources.map((r) => r.path),
  ...Object.values(m.icons),
  ...Object.values(m.action.default_icon),
]);

for (const cs of m.content_scripts || []) {
  for (const rel of [...(cs.js || []), ...(cs.css || [])]) refs.add(rel);
}
for (const rel of refs) {
  const p = path.join(root, rel);
  if (fs.existsSync(p)) ok(rel + '  (' + fs.statSync(p).size + ' B)');
  else bad(rel + ' is missing');
}

console.log('\nHTML local references');
for (const html of ['sidepanel.html', 'options.html']) {
  const text = fs.readFileSync(path.join(root, html), 'utf8');
  const re = /(href|src)="([^"]+)"/g;
  let match;
  while ((match = re.exec(text))) {
    const url = match[2];
    if (/^(https?:|data:|about:|#)/.test(url)) continue;
    const p = path.join(root, url);
    if (fs.existsSync(p)) ok(html + ' -> ' + url);
    else bad(html + ' -> ' + url + ' is missing');
  }
}

/* ------------------------ manifest sanity checks ------------------------ */
console.log('\nManifest semantics');

if (m.manifest_version === 3) ok('manifest_version is 3');
else bad('manifest_version must be 3');

const needPerms = ['sidePanel', 'declarativeNetRequest', 'storage', 'contextMenus'];
for (const p of needPerms) {
  if (m.permissions.includes(p)) ok('permission: ' + p);
  else bad('missing permission: ' + p);
}

if (m.side_panel && m.side_panel.default_path) ok('side_panel declared');
else bad('side_panel missing (needed for chrome.sidePanel)');

if (m.host_permissions.includes('*://*.deepseek.com/*')) ok('host permission covers deepseek.com');
else bad('host permission for deepseek.com missing');

// 划词翻译 wiring
const cs = (m.content_scripts || [])[0];
if (cs) {
  ok('content script: ' + cs.js.join(', ') + ' (all_frames=' + !!cs.all_frames + ')');
  if (!cs.matches.some((p) => /^https?:\/\/\*\/\*$/.test(p))) {
    bad('content script should match all http(s) pages, got ' + JSON.stringify(cs.matches));
  } else ok('content script matches all http(s) pages');
  if (!cs.all_frames) bad('content script should run in all_frames for iframe selections');
} else {
  bad('no content_scripts entry (select-to-translate needs one)');
}

if (m.permissions.includes('storage')) ok('storage permission present (settings + api key)');
else bad('storage permission missing');

// DNR ruleset path must be relative to root and exist
for (const r of m.declarative_net_request.rule_resources) {
  if (r.id && r.path && typeof r.enabled === 'boolean') ok('ruleset "' + r.id + '" declared, enabled=' + r.enabled);
  else bad('ruleset entry malformed');
}

/* ----------------------- DNR rule validity ----------------------------- */
console.log('\nDNR rule validity');
const allowedHeaderOps = new Set(['append', 'set', 'remove']);
for (const rule of rules.data) {
  const label = 'rule #' + rule.id;
  if (typeof rule.id !== 'number') bad(label + ': id must be a number');
  if (typeof rule.priority !== 'number') bad(label + ': priority must be a number');

  if (rule.action.type !== 'modifyHeaders') {
    bad(label + ': action.type should be modifyHeaders');
  } else {
    for (const h of rule.action.responseHeaders || []) {
      if (!allowedHeaderOps.has(h.operation)) bad(label + ': bad operation ' + h.operation);
      else ok(label + ': ' + h.operation + ' ' + h.header);
    }
  }

  const c = rule.condition || {};
  if (!Array.isArray(c.requestDomains) || !c.requestDomains.includes('deepseek.com')) {
    bad(label + ': condition.requestDomains must include deepseek.com');
  } else ok(label + ': requestDomains ' + JSON.stringify(c.requestDomains));

  if (!Array.isArray(c.resourceTypes) || !c.resourceTypes.includes('sub_frame')) {
    bad(label + ': condition.resourceTypes must include sub_frame');
  } else ok(label + ': resourceTypes ' + JSON.stringify(c.resourceTypes));

  if (c.resourceTypes.includes('main_frame')) {
    bad(label + ': must NOT touch main_frame (would weaken normal browsing)');
  } else ok(label + ': main_frame untouched');
}

/* ----------------------------- icon sanity ----------------------------- */
console.log('\nIcons');
const expected = { 16: 16, 32: 32, 48: 48, 128: 128 };
for (const [size, px] of Object.entries(expected)) {
  const p = path.join(root, 'icons', 'icon' + size + '.png');
  if (!fs.existsSync(p)) {
    bad('icons/icon' + size + '.png missing');
    continue;
  }
  const b = fs.readFileSync(p);
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  if (!isPng) bad('icons/icon' + size + '.png is not a PNG');
  else if (w !== Number(px) || h !== Number(px)) bad('icons/icon' + size + '.png is ' + w + 'x' + h + ', expected ' + px);
  else ok('icon' + size + '.png is ' + w + 'x' + h);
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
