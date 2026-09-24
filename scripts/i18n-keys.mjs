#!/usr/bin/env node
// Lists every UI translation key and checks that the uk/ru dictionaries cover them.
//   node scripts/i18n-keys.mjs           — report missing / unused keys (exit 1 if something is missing)
//   node scripts/i18n-keys.mjs --list    — print all keys as JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webSrc = path.join(root, 'web/src');
const serverSrc = path.join(root, 'server/src');
const keys = new Set();

const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\"/g, '"');

// t('…') / t("…") calls, plus ternaries passed to t(): t(cond ? '…' : '…')
for (const f of fs.readdirSync(webSrc).filter((x) => /\.(jsx?|mjs)$/.test(x))) {
  const s = fs.readFileSync(path.join(webSrc, f), 'utf8');
  for (const m of s.matchAll(/\bt\(\s*(?:[\w.]+\s*\?\s*)?(['"])((?:\\.|(?!\1).)*)\1(?:\s*:\s*(['"])((?:\\.|(?!\3).)*)\3)?/g)) {
    keys.add(unescape(m[2]));
    if (m[4]) keys.add(unescape(m[4]));
  }
  // label: '…' in constant tables (tabs, stages, filters, quality) and value maps (STATUS, CATEGORY)
  for (const m of s.matchAll(/\b(?:label|title):\s*'((?:\\.|[^'])*)'/g)) keys.add(unescape(m[1]));
  for (const block of s.matchAll(/(?:STATUS|CATEGORY|STATUS_LABEL|QUALITY_LABEL)\s*=\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/:\s*'((?:\\.|[^'])*)'/g)) keys.add(unescape(m[1]));
  }
}

// Server error messages shown to users: res.json({ error: '…' }), reject('…'), throw new Error('…')
const serverKeys = new Set();
// worker/index.js and ctl.js only answer the web container (internal API), their errors never reach users
const INTERNAL = new Set(['worker/index.js', 'worker/ctl.js']);
const serverFiles = fs.readdirSync(serverSrc, { recursive: true })
  .map((f) => f.split(path.sep).join('/'))
  .filter((f) => f.endsWith('.js') && !INTERNAL.has(f));
for (const f of serverFiles) {
  const s = fs.readFileSync(path.join(serverSrc, f), 'utf8');
  for (const m of s.matchAll(/(?:error:\s*|reject\(|return\s+|finish\(job, 'failed', |job\.error = )'((?:\\.|[^'])*)'/g)) {
    const msg = unescape(m[1]);
    if (/^[A-Z]/.test(msg) && !/^[A-Z_]+$/.test(msg)) serverKeys.add(msg.endsWith(': ') ? msg.trimEnd() : msg);
  }
  for (const m of s.matchAll(/(?:new Error|super)\(\s*'((?:\\.|[^'])*)'/g)) serverKeys.add(unescape(m[1]).trimEnd());
  // Prefix messages with a variable tail, matched by tError() on "Prefix:"
  for (const m of s.matchAll(/`([A-Z][^`$]*?:) \$\{/g)) serverKeys.add(m[1]);
}
// Role and kind identifiers on the server are not messages
for (const k of serverKeys) if (!/^(euler|lcm|dpm)/.test(k) && !/^(admin|user|image|video|none)$/.test(k)) keys.add(k);
// Server messages the patterns above cannot see (built from constants or passed through helpers)
const EXTRA = [
  'Password must be at least 8 characters',
  'Interrupted by a container restart',
  'The container was stopped during generation',
  'Internal error',
  'Not found',
  'Could not build the mp4:',
];
for (const k of EXTRA) keys.add(k);
// Never translated: language names, hardware family names, identifiers
const NOT_UI = new Set(['English', 'Українська', 'Русский', 'Strix Halo', 'Strix Point', 'Krackan Point']);
for (const k of [...keys]) {
  if (!k || k.length < 2 || NOT_UI.has(k)) keys.delete(k);
}

const sorted = [...keys].sort((a, b) => a.localeCompare(b));
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(sorted, null, 1));
  process.exit(0);
}

let failed = false;
for (const lang of ['uk', 'ru']) {
  const dict = (await import(pathToFileURL(path.join(webSrc, 'locales', `${lang}.js`)))).default;
  const missing = sorted.filter((k) => !(k in dict));
  const unused = Object.keys(dict).filter((k) => !keys.has(k));
  console.log(`${lang}: ${Object.keys(dict).length} entries, ${missing.length} missing, ${unused.length} unused`);
  for (const k of missing) console.log(`  missing: ${k}`);
  for (const k of unused) console.log(`  unused:  ${k}`);
  if (missing.length) failed = true;
}
process.exit(failed ? 1 : 0);
