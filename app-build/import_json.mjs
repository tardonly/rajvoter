// Turns voter lists made by another team into our village folders and builds the app, without going back to the PDFs.
// Their data: one folder per district / पंचायत समिति / gram panchayat, each with a few versions of the village's
// .json.gz ("panchayat", "people", "ward_booth", "seats" …), e.g. rajasthan/bikaner/lunkaransar/kaloo/*.json.gz.
//   → <village>/voters.json (+ <village>/village.json when the folder has none), then app-build/encrypt.mjs.
// - The newest version of each village is used (of two made at the same time, the one with more in it).
// - A village goes to our folder with the same Hindi name and पंचायत समिति (their ridi = our riri), else to the last
//   part of "panchayat" (…/kaloo → kaloo/); when that is taken by another village: kaloo-<samiti>, then
//   kaloo-<samiti>-<district>.
// - Wards we analysed from the PDFs (folders with "* All Wards.xlsx") are kept as they are; only missing wards are
//   added, and only when their Voter IDs agree with ours at the same ward + box.
// - Each ward's पं.सं. / जि.प. numbers go into voters.json "seats"; our own wards keep village.json's (cover pages).
// - English names are taken word by word from the names in our own villages, the rest spelled out from the Hindi.
//   Voters they mark as struck off get del "X" (no reason given).
// It prints only what may need a look and a summary per पंचायत समिति; every village's line is in import-report.txt.
//
// Usage:  node app-build/import_json.mjs <folder or files> ...  [--dry-run] [--no-build]
//           e.g. a whole "rajasthan" folder copied into this project: node app-build/import_json.mjs rajasthan
//         node app-build/import_json.mjs --bucket <s3 bucket> [<s3 folder> ...]  [--dry-run] [--no-build]
//           downloads the .json.gz files first (aws CLI, already logged in) into import/ (default folder: rolls,
//           everything); reruns only download files that changed
// Rerunning is safe: unchanged villages are left as they are.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run'), BUILD = !DRY && !args.includes('--no-build');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const BUCKET = opt('--bucket')?.replace(/^s3:\/\//, '').replace(/\/+$/, '');
let inputs = args.filter((a) => !a.startsWith('--'));
if (BUCKET) {
  const into = join(root, 'import');   // stays out of git (.gitignore lets through only the app's own files)
  inputs = (inputs.length ? inputs : ['rolls']).map((f) => {
    const p = f.replace(/^\/+|\/+$/g, ''), to = join(into, p);
    console.log(`downloading s3://${BUCKET}/${p} → import/${p}`);
    try {
      execFileSync('aws', ['s3', 'sync', `s3://${BUCKET}/${p}`, to, '--exclude', '*', '--include', '*.json.gz', '--only-show-errors'],
        { stdio: 'inherit' });
    } catch (e) { console.log(`download failed (${e.message.split('\n')[0]})`); process.exit(1); }
    return to;
  }).filter((p) => existsSync(p));
}
if (!inputs.length) {
  console.log('usage: node app-build/import_json.mjs <folder or files> ... [--dry-run] [--no-build]\n' +
    '       node app-build/import_json.mjs --bucket <s3 bucket> [<s3 folder> ...] [--dry-run] [--no-build]');
  process.exit(1);
}
const readJson = (f) => { const b = readFileSync(f); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString('utf8')); };
const FIELDS = ['ward', 'box', 'epic', 'hname', 'hrel', 'rel', 'house', 'age', 'sex', 'name', 'relname', 'del'];

// ---- their Hindi: a few spellings their PDF reading gets wrong (सिह for सिंह, ॅ for ँ, ॉ for ाँ, । for ा)
const MATRA = 'ािीुूृेैोौंँ़्';
function fixHi(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/ॅ/g, 'ँ').replace(/ॉं?/g, 'ाँ')
    .replace(/(?<=[क-ह])।(?=[क-ह])/g, 'ा')
    .replace(new RegExp(`सि़?ह(?![${MATRA}])`, 'g'), 'सिंह')
    .replace(new RegExp(`सिग(?![${MATRA}])`, 'g'), 'सिंग')
    .replace(/विद(?=\s|$)/g, 'विंद');
}

// ---- English names: a dictionary of Hindi word → English word from our own villages (names typed from the PDFs)
const fold = (s) => s.normalize('NFD').replace(/[़्ऀ-ः]/g, '').replace(/ी/g, 'ि').replace(/ू/g, 'ु')
  .replace(/[शष]/g, 'स').replace(/ण/g, 'न').replace(/ड़/g, 'ड');
const dict = new Map();   // Hindi word, folded → Map(english → count)
function learn(h, e) {
  const hw = fixHi(h).split(' '), ew = String(e || '').trim().split(/\s+/);
  if (!h || !e || hw.length !== ew.length) return;
  hw.forEach((w, i) => {
    const c = dict.get(fold(w)) || new Map(); c.set(ew[i], (c.get(ew[i]) || 0) + 1); dict.set(fold(w), c);
  });
}
// our villages: folder → {meta, own}; own = analysed from the PDFs (has "* All Wards.xlsx"), the source of the
// dictionary (wards this script added are only our guess, so not learnt from)
const ourVillages = new Map();
for (const d of readdirSync(root)) {
  if (!existsSync(join(root, d, 'village.json')) || !existsSync(join(root, d, 'voters.json'))) continue;
  const own = readdirSync(join(root, d)).some((f) => /All Wards\.xlsx$/.test(f) && !f.startsWith('~$'));
  ourVillages.set(d, { meta: JSON.parse(readFileSync(join(root, d, 'village.json'), 'utf8')), own });
  if (!own) continue;
  const v = JSON.parse(readFileSync(join(root, d, 'voters.json'), 'utf8')), F = Object.fromEntries(v.fields.map((x, i) => [x, i]));
  const imported = new Set(v.imported || []);
  for (const r of v.rows) if (!imported.has(r[F.ward])) { learn(r[F.hname], r[F.name]); learn(r[F.hrel], r[F.relname]); }
}
const best = (c) => [...c].sort((a, b) => b[1] - a[1])[0][0];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
// the spelling most used for that word, counting the ways it is written in Hindi (कँवर, कंवर, कवर) together
const known = (w) => (dict.has(fold(w)) ? best(dict.get(fold(w))) : null);

// spelled out letter by letter, dropping the a a Hindi speaker doesn't say (end of word, "kamala" → "kamla")
const C = { क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'n', च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n', ट: 't', ठ: 'th', ड: 'd',
  ढ: 'dh', ण: 'n', त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n', प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm', य: 'y', र: 'r', ल: 'l',
  ळ: 'l', व: 'v', श: 'sh', ष: 'sh', स: 's', ह: 'h', 'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f' };
const V = { अ: 'a', आ: 'a', इ: 'i', ई: 'ee', उ: 'u', ऊ: 'oo', ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au', ऑ: 'o' };
const M = { 'ा': 'a', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o' };
function spell(w) {
  const s = [...w.normalize('NFC').replace(/([कखगजडढफ])़/g, (m) => m.normalize('NFC'))];
  const out = [];   // [{t, schwa}]
  for (let i = 0; i < s.length; i++) {
    const ch = s[i], nx = s[i + 1];
    if (C[ch]) {
      if (nx === '्') { out.push({ t: C[ch] }); i++; }
      else if (M[nx]) { out.push({ t: C[ch] + M[nx] }); i++; }
      else out.push({ t: C[ch] + 'a', schwa: true });
    } else if (V[ch]) out.push({ t: V[ch] });
    else if (ch === 'ं' || ch === 'ँ') out.push({ t: /^[pbm]/.test(C[nx] || '') ? 'm' : 'n' });
    else if (M[ch]) out.push({ t: M[ch] });
  }
  if (out.length > 1 && out.at(-1).schwa) out.at(-1).t = out.at(-1).t.slice(0, -1);
  for (let i = 1; i < out.length - 1; i++) {   // CV-Ca-CV → CVC-CV
    if (out[i].schwa && /[aeiou]$/.test(out[i - 1].t) && /[aeiou]$/.test(out[i + 1].t)) {
      out[i].t = out[i].t.slice(0, -1); out[i].schwa = false;
    }
  }
  return out.map((o) => o.t).join('');
}
// a word we don't know may be two we do, written together (किशनसिंह = किशन + सिंह), or end in one (… + सिंह)
function english(word) {
  const k = known(word);
  if (k) return k;
  const s = [...word];
  let tail = null;
  for (let i = 2; i <= s.length - 2; i++) {
    if (!/[क-हअ-औ]/.test(s[i]) || /[़्]/.test(s[i - 1])) continue;   // split only before a letter, not a vowel sign
    const a = known(s.slice(0, i).join('')), b = known(s.slice(i).join(''));
    if (a && b) return cap(a) + b.toLowerCase();
    if (b && !tail) tail = cap(spell(s.slice(0, i).join(''))) + b.toLowerCase();
  }
  return tail || cap(spell(word));
}
const memo = new Map();
const toEnglish = (h) => (h ? h.split(' ').map((w) => memo.get(w) ?? memo.set(w, english(w)).get(w)).join(' ') : '');

// ---- read their files: which is the newest version of each village (only a few details are kept in memory)
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((f) => walk(join(p, f)))
  : /\.json(\.gz)?$/.test(p) ? [p] : []);
const files = inputs.flatMap((p) => (existsSync(p) ? walk(p) : (console.log(`${p}: not found`), [])));
const fileSet = new Set(files);
const byVillage = new Map();   // their "panchayat" (district/samiti/village) → newest file
const rank = (x) => [x.generated, x.keys, x.people];
const older = (a, b) => { const [p, q] = [rank(a), rank(b)]; return p[0] !== q[0] ? p[0] < q[0] : p[1] !== q[1] ? p[1] < q[1] : p[2] <= q[2]; };
const notes = [];   // what may need a look
let unreadable = 0;
for (const f of files) {
  if (f.endsWith('.json') && fileSet.has(f + '.gz')) continue;   // same file twice (packed and unpacked)
  let d;
  try { d = readJson(f); } catch (e) { notes.push(`${f}: not readable (${e.message})`); unreadable++; continue; }
  if (!d.panchayat || !Array.isArray(d.people)) { notes.push(`${f}: not a village file, skipped`); continue; }
  const v = { f, panchayat: String(d.panchayat).toLowerCase(), name: d.name, tehsil: d.tehsil, district: d.district,
    generated: String(d.generated || ''), keys: Object.keys(d).length, people: d.people.length };
  const prev = byVillage.get(v.panchayat);
  if (!prev || older(prev, v)) byVillage.set(v.panchayat, v);
}

// folder for each village
const parts = (v) => v.panchayat.split('/').map((x) => x.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
const samitiHi = (v) => v.tehsil || parts(v).at(-2) || '';   // their "tehsil" is the पंचायत समिति's name
const nameKey = (name, samiti) => `${fold(String(name || '').replace(/\s+/g, ''))}|${fold(samiti || '')}`;
const RESERVED = new Set(['api', 'admin', 'index', 'demo', 'import', 'app-build', 'voter-search-app', 'slip-extension', 'node-modules']);
const byName = new Map();
for (const [dir, { meta, own }] of [...ourVillages].sort()) {
  const k = nameKey(meta.name, meta.panchayatSamiti);
  if (!byName.has(k) || (own && !ourVillages.get(byName.get(k)).own)) byName.set(k, dir);
}
const target = new Map();   // folder → village
const taken = (folder, v) => target.has(folder) || RESERVED.has(folder) || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(folder)
  || (ourVillages.has(folder) ? fold(ourVillages.get(folder).meta.panchayatSamiti || '') !== fold(samitiHi(v))
    : existsSync(join(root, folder)) || inputs.some((p) => basename(p) === folder));
for (const v of [...byVillage.values()].sort((a, b) => (a.panchayat < b.panchayat ? -1 : 1))) {
  const [slug, samiti = 'x', district = 'x'] = parts(v).reverse();
  let folder = byName.get(nameKey(v.name, samitiHi(v)));
  if (!folder || target.has(folder)) folder = [slug, `${slug}-${samiti}`, `${slug}-${samiti}-${district}`].find((x) => !taken(x, v));
  if (!folder) { notes.push(`${v.panchayat}: no free folder name, skipped`); continue; }
  if (folder !== slug && !ourVillages.has(folder)) notes.push(`${v.panchayat} → ${folder}/ (${slug}/ is taken)`);
  target.set(folder, v);
}

// ---- convert each village
const report = [], perSamiti = new Map();
const count = (v, k, n = 1) => {
  const key = `${v.district || '?'} · ${samitiHi(v)}`, c = perSamiti.get(key) || { new: 0, more: 0, same: 0, skipped: 0, voters: 0 };
  c[k] += n; perSamiti.set(key, c);
};
for (const [slug, v] of [...target].sort()) {
  const d = readJson(v.f);
  const folder = join(root, slug);
  const kendra = {};
  for (const [w, b] of Object.entries(d.ward_booth || {})) {
    const name = `${b.name || ''}${b.part ? ` ${b.part}` : ''}`.replace(/[\s,]+$/, '').replace(/\s+/g, ' ').trim();
    kendra[w] = `${b.b}-${name}`;
  }
  const theirs = d.people.filter((p) => p.v === 1 && p.w && p.sr).sort((a, b) => a.w - b.w || a.sr - b.sr)
    .map((p) => {
      const hname = fixHi(p.n), hrel = fixHi(p.rv);
      return [p.w, p.sr, p.e || '', hname, hrel, p.r || '', p.h && p.h !== '?' ? String(p.h).trim() : '', p.a ?? '',
        p.g === 'f' ? 'स्त्री' : 'पुरुष', toEnglish(hname), toEnglish(hrel), p.x ? 'X' : ''];
    });

  // keep the wards we analysed ourselves; check they are the same list (same Voter ID at the same ward + box)
  let ours = null, keep = new Set();
  if (existsSync(join(folder, 'voters.json'))) {
    ours = JSON.parse(readFileSync(join(folder, 'voters.json'), 'utf8'));
    const F = Object.fromEntries(ours.fields.map((x, i) => [x, i]));
    for (const w of new Set(ours.rows.map((r) => r[F.ward]))) if (!(ours.imported || []).includes(w)) keep.add(w);
    const at = new Map(ours.rows.map((r) => [`${r[F.ward]}:${r[F.box]}`, r]));
    let same = 0, diff = 0;
    for (const r of theirs) {
      const o = keep.has(r[0]) && at.get(`${r[0]}:${r[1]}`);
      if (!o || !r[2] || !o[F.epic]) continue;
      if (o[F.epic] === r[2]) same++; else diff++;
    }
    if (diff > same / 20) { notes.push(`${slug}: their list doesn't match ours (${diff} Voter IDs differ, ${same} same), skipped`); count(v, 'skipped'); continue; }
    if (ours.fields.join() !== FIELDS.join()) { notes.push(`${slug}: our voters.json has other columns, skipped`); count(v, 'skipped'); continue; }
  }
  const added = theirs.filter((r) => !keep.has(r[0]));
  const rows = [...(ours ? ours.rows.filter((r) => keep.has(r[0])) : []), ...added].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const imported = [...new Set(added.map((r) => r[0]))].sort((a, b) => a - b);
  const allKendra = { ...kendra, ...(ours ? Object.fromEntries(Object.entries(ours.kendra).filter(([w]) => keep.has(+w))) : {}) };

  const all = Object.values(d.seats || {}).map((s) => JSON.stringify(s));
  const seat = all.length ? JSON.parse(all.sort((a, b) => all.filter((x) => x === b).length - all.filter((x) => x === a).length)[0]) : [];
  const hasMeta = existsSync(join(folder, 'village.json'));
  const meta = hasMeta ? JSON.parse(readFileSync(join(folder, 'village.json'), 'utf8'))
    : { name: d.name, title: `ग्राम पंचायत ${d.name}`, ps: seat[0] ?? '', zp: seat[1] ?? '', pollTime: 'मतदान समय : प्रातः 7 से सायं 6 बजे तक',
      district: d.district || '', panchayatSamiti: samitiHi(v), tehsil: d.tehsil || '' };
  // पं.सं. / जि.प. of each ward: our wards as read from the PDF cover pages, the added ones from their file
  const seats = {}, wrong = [];
  for (const w of [...new Set(rows.map((r) => r[0]))]) {
    const theirSeat = d.seats?.[w];
    seats[w] = keep.has(w) ? ours.seats?.[w] || [meta.ps, meta.zp] : theirSeat || [meta.ps, meta.zp];
    if (keep.has(w) && theirSeat && theirSeat.join() !== seats[w].join()) wrong.push(`${w} (${theirSeat.join('/')})`);
  }
  const groups = [];
  for (const [w, s] of Object.entries(seats)) {
    const g = groups.at(-1);
    if (g && g.s === s.join('/')) g.to = w; else groups.push({ from: w, to: w, s: s.join('/') });
  }

  const gone = (rs) => rs.filter((r) => r[11]).length;
  const words = added.flatMap((r) => [r[3], r[4]]).join(' ').split(' ').filter(Boolean);
  const guessed = words.filter((w) => !known(w)).length;
  const line = `${slug} (${d.name}, ${samitiHi(v)}): ` + (ours
    ? `kept our wards ${[...keep].sort((a, b) => a - b).join(', ') || '–'}, added ${imported.length ? `wards ${imported.join(', ')}` : 'nothing'}`
    : `new village, wards ${imported.join(', ')}`) +
    ` → ${rows.length - gone(rows)} voters (+${gone(rows)} struck off)` +
    (added.length ? `; English names: ${Math.round(100 * (1 - guessed / Math.max(words.length, 1)))}% of words from our lists` : '') +
    (groups.length > 1 ? `; पं.सं./जि.प. by ward: ${groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`}: ${g.s}`).join(', ')}` : '') +
    (wrong.length ? `; CHECK: their पं.सं./जि.प. for our wards ${wrong.join(', ')} differ from our cover pages (kept ours)` : '');
  report.push(line);
  if (wrong.length) notes.push(line);
  if (!theirs.length) notes.push(`${slug}: no voters in their file`);
  const json = JSON.stringify({ kendra: allKendra, fields: FIELDS, rows, imported, seats });
  const changed = added.length && (!ours || readFileSync(join(folder, 'voters.json'), 'utf8') !== json);
  count(v, !ours ? 'new' : changed ? 'more' : 'same');
  count(v, 'voters', rows.length - gone(rows));
  if (DRY || !changed) continue;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'voters.json'), json);
  if (!hasMeta) writeFileSync(join(folder, 'village.json'), JSON.stringify(meta, null, 2) + '\n');
}

// ---- summary
writeFileSync(join(root, 'import-report.txt'), [...notes.map((n) => `! ${n}`), ...report].join('\n') + '\n');
for (const n of notes) console.log(`! ${n}`);
const tot = { new: 0, more: 0, same: 0, skipped: 0, voters: 0 };
console.log('\nजिला · पंचायत समिति: new villages · wards added or updated · unchanged · skipped · voters');
for (const [k, c] of [...perSamiti].sort()) {
  console.log(`  ${k}: ${c.new} · ${c.more} · ${c.same} · ${c.skipped} · ${c.voters}`);
  for (const x in tot) tot[x] += c[x];
}
console.log(`all: ${tot.new} new, ${tot.more} with wards added or updated, ${tot.same} unchanged, ${tot.skipped} skipped; ${tot.voters} voters` +
  ` in ${target.size} villages from ${files.length} files${unreadable ? ` (${unreadable} unreadable)` : ''}. Every village: import-report.txt`);
if (DRY) console.log('(dry run: nothing written)');
else if (BUILD) { console.log('\nbuilding the app data (encrypt.mjs) …'); execFileSync('node', [join(here, 'encrypt.mjs')], { stdio: 'inherit' }); }
