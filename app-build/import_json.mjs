// Turns voter lists made by another team (one JSON per gram panchayat, plain or .json.gz, with "panchayat",
// "people", "ward_booth", "seats" …) into our village folders, without going back to the PDFs.
//   <file>.json(.gz)  →  <village>/voters.json (+ <village>/village.json when the folder has none)
// The village goes to our folder with the same Hindi name and पंचायत समिति (their ridi = our riri), else to the last
// part of its "panchayat" (bikaner/sri-dungargarh/adsar → adsar/); when that folder is a different village, the samiti
// is added (bigga-lunkaransar/).
// Each ward's पं.सं. / जि.प. numbers go into voters.json "seats" (wards of one village can differ); for our own wards
// they come from village.json (read from the PDF cover pages).
// Wards we already have (analysed from the PDFs, with English names and deletion reasons) are kept as they are;
// only the missing wards are added. A village we don't have yet gets a new folder.
// Their files have no English names: those are taken word by word from the names in our own villages, the rest are
// spelled out from the Hindi. Voters they mark as struck off get del "X" (no reason given).
//
// Usage:  node app-build/import_json.mjs --bucket <s3 bucket> [<s3 folder> ...] [--dry-run]
//           (each samiti folder has one sub-folder per village with a few versions of its .json.gz)
//           downloads the .json.gz files (aws CLI, already logged in) into import/ and converts them; the folders
//           default to the four samitis below. Reruns only download files that changed.
//         node app-build/import_json.mjs <file or folder> ...   [--dry-run]     files already on this Mac
// then    node app-build/encrypt.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const BUCKET = opt('--bucket')?.replace(/^s3:\/\//, '').replace(/\/+$/, '');
let inputs = args.filter((a) => !a.startsWith('--'));
const S3_FOLDERS = ['rolls/bikaner/sri-dungargarh', 'rolls/bikaner/reedee', 'rolls/bikaner/lunkaransar', 'rolls/churu/sardarshahar'];
// their पंचायत समिति folder names → the Hindi name shown in the app's village list
const SAMITI = { 'sri-dungargarh': 'श्रीडूंगरगढ़', reedee: 'रीड़ी', lunkaransar: 'लूणकरणसर', sardarshahar: 'सरदारशहर' };
if (BUCKET) {
  const into = join(root, 'import');   // stays out of git (.gitignore lets through only the app's own files)
  inputs = (inputs.length ? inputs : S3_FOLDERS).map((f) => {
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
  console.log('usage: node app-build/import_json.mjs --bucket <s3 bucket> [<s3 folder> ...] [--dry-run]\n' +
    '       node app-build/import_json.mjs <file or folder> ... [--dry-run]');
  process.exit(1);
}
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
const ourVillages = new Map();   // folder → {meta, own: has wards analysed from the PDFs}
for (const d of readdirSync(root)) {
  const f = join(root, d, 'voters.json');
  if (!existsSync(f) || !existsSync(join(root, d, 'village.json'))) continue;
  const v = JSON.parse(readFileSync(f, 'utf8')), F = Object.fromEntries(v.fields.map((x, i) => [x, i]));
  const imported = new Set(v.imported || []);   // wards this script added: their English is our guess, don't learn it
  ourVillages.set(d, { meta: JSON.parse(readFileSync(join(root, d, 'village.json'), 'utf8')),
    own: v.rows.some((r) => !imported.has(r[F.ward])) });
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
const toEnglish = (h) => (h ? h.split(' ').map(english).join(' ') : '');

// ---- read their files (newest "generated" per village wins), in sub-folders too
const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f)))
  : /\.json(\.gz)?$/.test(p) ? [p] : []);
const files = inputs.flatMap((p) => (existsSync(p) ? walk(p) : (console.log(`${p}: not found`), [])));
const byVillage = new Map();   // their "panchayat" (district/samiti/village) → newest file
for (const f of files) {
  if (f.endsWith('.json') && files.includes(f + '.gz')) continue;   // same file twice (packed and unpacked)
  let d;
  try {
    const buf = readFileSync(f);
    d = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8'));
  } catch (e) { console.log(`${basename(f)}: not readable (${e.message})`); continue; }
  if (!d.panchayat || !Array.isArray(d.people)) { console.log(`${basename(f)}: not a village file, skipped`); continue; }
  const key = String(d.panchayat).toLowerCase(), prev = byVillage.get(key);
  // each village folder has a few versions: the newest wins, and of two made at the same time the one with more in it
  const rank = (x) => [String(x.generated || ''), Object.keys(x).length, x.people.length];
  const older = (a, b) => { const [p, q] = [rank(a), rank(b)]; return p[0] !== q[0] ? p[0] < q[0] : p[1] !== q[1] ? p[1] < q[1] : p[2] <= q[2]; };
  if (prev && older(d, prev.d)) { console.log(`${basename(f)}: older copy of ${key}, skipped`); continue; }
  if (prev) console.log(`${basename(prev.f)}: older copy of ${key}, skipped`);
  byVillage.set(key, { f, d });
}

// folder for each village: ours with the same Hindi name and samiti; else the last part of "panchayat" if that folder
// is free or the same samiti; else "<village>-<samiti>"
const samitiOf = (d) => { const p = String(d.panchayat).toLowerCase().split('/'); return p.at(-2) || ''; };
const samitiHi = (d) => SAMITI[samitiOf(d)] || d.tehsil || '';
const nameKey = (name, samiti) => `${fold(String(name || '').replace(/\s+/g, ''))}|${fold(samiti || '')}`;
const byName = new Map();
for (const [dir, { meta, own }] of [...ourVillages].sort()) {
  const k = nameKey(meta.name, meta.panchayatSamiti);
  if (!byName.has(k) || (own && !ourVillages.get(byName.get(k)).own)) byName.set(k, dir);
}
const target = new Map();   // folder → {f, d}
for (const [key, v] of [...byVillage].sort()) {
  const slug = key.split('/').pop(), ours = ourVillages.get(slug);
  let folder = byName.get(nameKey(v.d.name, samitiHi(v.d)));
  if (!folder) folder = !ours || fold(ours.meta.panchayatSamiti || '') === fold(samitiHi(v.d)) ? slug : `${slug}-${samitiOf(v.d)}`;
  if (target.has(folder)) folder = `${slug}-${samitiOf(v.d)}`;
  if (target.has(folder)) { console.log(`${v.d.panchayat}: two villages for ${folder}/, skipped`); continue; }
  if (folder !== slug) console.log(`${v.d.panchayat} → ${folder}/`);
  target.set(folder, v);
}

// ---- convert each village
for (const [slug, { f, d }] of [...target].sort()) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) { console.log(`${basename(f)}: folder name "${slug}" not usable, skipped`); continue; }
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
    if (diff > same / 20) { console.log(`${slug}: their list doesn't match ours (${diff} Voter IDs differ, ${same} same), skipped`); continue; }
    if (ours.fields.join() !== FIELDS.join()) { console.log(`${slug}: our voters.json has other columns, skipped`); continue; }
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
      district: d.district || '', panchayatSamiti: samitiHi(d), tehsil: d.tehsil || '' };
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
  console.log(`${slug} (${d.name}, ${samitiHi(d)}): ` + (ours
    ? `kept our wards ${[...keep].sort((a, b) => a - b).join(', ') || '–'}, added ${imported.length ? `wards ${imported.join(', ')}` : 'nothing'}`
    : `new village, wards ${imported.join(', ')}`) +
    ` → ${rows.length - gone(rows)} voters (+${gone(rows)} struck off)` +
    (added.length ? `; English names: ${Math.round(100 * (1 - guessed / Math.max(words.length, 1)))}% of words from our lists` : '') +
    (groups.length > 1 ? `; पं.सं./जि.प. by ward: ${groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`}: ${g.s}`).join(', ')}` : '') +
    (wrong.length ? `; CHECK: their पं.सं./जि.प. for our wards ${wrong.join(', ')} differ from our cover pages (kept ours)` : ''));
  if (DRY || !added.length) continue;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'voters.json'), JSON.stringify({ kendra: allKendra, fields: FIELDS, rows, imported, seats }));
  if (!hasMeta) writeFileSync(join(folder, 'village.json'), JSON.stringify(meta, null, 2) + '\n');
}
if (DRY) console.log('(dry run: nothing written)');
