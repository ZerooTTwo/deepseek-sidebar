/**
 * Minimal ZIP writer so packaging needs no external tooling or temp files.
 * Produces a standard deflate ZIP with the extension at the archive root,
 * ready for "unzip then load unpacked" or a Web Store upload.
 *
 * Usage: node dev/pack.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '..', 'deepseek-sidebar-v1.1.0.zip');

const INCLUDE = [
  'manifest.json',
  'background.js',
  'sidepanel.html',
  'sidepanel.css',
  'sidepanel.js',
  'options.html',
  'options.css',
  'options.js',
  'README.md',
  'content/selection.js',
  'rules/frame.json',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/logo.svg',
];

/* ------------------------------- CRC-32 -------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------- packing ------------------------------- */

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

const now = dosDateTime(new Date(2026, 10, 2, 12, 0, 0));

const entries = [];
const central = [];
let offset = 0;

for (const rel of INCLUDE) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('missing file: ' + rel);

  const data = fs.readFileSync(abs);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;
  const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(now.time, 10);
  local.writeUInt16LE(now.date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  entries.push(local, name, payload);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); // version made by
  cd.writeUInt16LE(20, 6); // version needed
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(now.time, 12);
  cd.writeUInt16LE(now.date, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30); // extra
  cd.writeUInt16LE(0, 32); // comment
  cd.writeUInt16LE(0, 34); // disk
  cd.writeUInt16LE(0, 36); // internal attrs
  cd.writeUInt32LE(0, 38); // external attrs
  cd.writeUInt32LE(offset, 42);
  central.push(cd, name);

  offset += local.length + name.length + payload.length;
}

const centralBuf = Buffer.concat(central);

const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(INCLUDE.length, 8);
eocd.writeUInt16LE(INCLUDE.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...entries, centralBuf, eocd]);
fs.writeFileSync(OUT, zip);

console.log('wrote', OUT);
console.log('entries:', INCLUDE.length, '| size:', (zip.length / 1024).toFixed(1) + ' KiB');
for (const rel of INCLUDE) {
  const size = fs.statSync(path.join(ROOT, rel)).size;
  console.log('  ' + String(size).padStart(8) + '  ' + rel);
}
