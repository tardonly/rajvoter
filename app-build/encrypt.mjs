// Builds the data for every village into the app, encrypted with the key in app-build/DATA_KEY.txt.
// A village is any top-level folder (its name is the web address, e.g. adsar → raj-voter.vercel.app/adsar) holding:
//   village.json   {"name": "आडसर", "title": "ग्राम पंचायत आडसर", "ps": 3, "zp": 35, "pollTime": "मतदान समय : ..."}
//   voters.json    the analysed voter list (see app-build/xlsx_to_json.py)
// Writes voter-search-app/api/_data/<village>.enc for each and voter-search-app/api/_villages.json (names and
// slip details, no voter data). The same key must be set as the DATA_KEY environment variable in Vercel.
//
// Usage:  node app-build/encrypt.mjs    (creates DATA_KEY.txt the first time)
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { randomBytes, createCipheriv } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const api = join(root, 'voter-search-app', 'api');
const outDir = join(api, '_data');
const keyFile = join(here, 'DATA_KEY.txt');
let created = false;
if (!existsSync(keyFile)) { writeFileSync(keyFile, randomBytes(32).toString('base64') + '\n'); created = true; }
const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
if (key.length !== 32) throw new Error('DATA_KEY.txt must hold a base64 32-byte key');

// words that are pages or folders of the site itself, so they can't be village addresses
const RESERVED = new Set(['api', 'admin', 'index', 'app-build', 'voter-search-app', 'slip-extension']);
const folders = readdirSync(root).filter((d) => !d.startsWith('.') && statSync(join(root, d)).isDirectory()
  && existsSync(join(root, d, 'village.json')));

mkdirSync(outDir, { recursive: true });
const villages = {};
for (const slug of folders.sort()) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || RESERVED.has(slug)) {
    throw new Error(`folder "${slug}": a village folder name must be lower-case English letters/digits (e.g. adsar, bigga-bas)`);
  }
  const meta = JSON.parse(readFileSync(join(root, slug, 'village.json'), 'utf8'));
  if (!meta.name) throw new Error(`${slug}/village.json needs at least "name"`);
  if (!existsSync(join(root, slug, 'voters.json'))) { console.log(`${slug}: skipped (no voters.json yet)`); continue; }
  const plain = readFileSync(join(root, slug, 'voters.json'));
  const data = JSON.parse(plain);
  const ward = data.fields.indexOf('ward');
  const wards = [...new Set(data.rows.map((r) => r[ward]))].sort((a, b) => a - b);

  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  writeFileSync(join(outDir, `${slug}.enc`),
    JSON.stringify({ v: 3, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') }));
  villages[slug] = {
    name: meta.name, title: meta.title || `ग्राम पंचायत ${meta.name}`, ps: meta.ps ?? '', zp: meta.zp ?? '',
    pollTime: meta.pollTime || 'मतदान समय : प्रातः 7 से सायं 5 बजे तक', wards, voters: data.rows.length,
  };
  console.log(`${slug}: ${data.rows.length} voters, wards ${wards.join(', ')}`);
}

// remove data of villages whose folder is gone
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.enc') && !villages[f.slice(0, -4)]) { unlinkSync(join(outDir, f)); console.log(`removed _data/${f}`); }
}
writeFileSync(join(api, '_villages.json'), JSON.stringify(villages, null, 1) + '\n');
console.log(`api/_villages.json written (${Object.keys(villages).length} villages).` +
  (created ? ' New key created in app-build/DATA_KEY.txt: copy it into the DATA_KEY environment variable in Vercel.' : ''));
