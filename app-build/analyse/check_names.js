// Step 2 check: node app-build/analyse/check_names.js <work folder> <ward>
// Checks <work>/names/w<ward>.json (the names read from the page images) against the PDF text layer and prints problems.
const fs = require('fs'), path = require('path');
const P = require('./pdftext.js');
const dir = path.resolve(process.argv[2]), w = process.argv[3];
const man = JSON.parse(fs.readFileSync(path.join(dir, 'img', `w${w}_manifest.json`), 'utf8'));
const file = path.join(dir, 'names', `w${w}.json`);
const names = JSON.parse(fs.readFileSync(file, 'utf8'));
const key = (c) => `${c.section}:${c.box}`;
const got = new Map(names.map((n) => [key(n), n]));
const want = Object.entries(man).flatMap(([page, cs]) => cs.map((c) => ({ ...c, page: +page })));
let bad = 0;
const say = (...a) => { bad++; console.log(...a); };
for (const c of want) {
  if (c.section === 'deletion') continue;   // the deletion supplement repeats main-list cards; no names needed
  if (c.section === 'main' && c.mark) continue;   // deleted (E/S/R) or replaced by a correction (#): not on the final roll
  const n = got.get(key(c));
  if (!n) { say(`MISSING  page ${c.page} box ${c.box} (${c.section})`); continue; }
  for (const f of ['hname', 'hrel', 'name', 'relname']) if (!String(n[f] || '').trim()) say(`EMPTY    box ${c.box} ${f}`);
  if (/[a-z]/i.test(n.hname + n.hrel) || /[ऀ-ॿ]/.test(n.name + n.relname)) say(`SCRIPT   box ${c.box}: Hindi fields must be Devanagari, English fields Latin`);
  for (const [f, s] of [['hname', c.nameSkel], ['hrel', c.relSkel]]) {
    if (!s) continue;   // text layer had nothing; can't check
    const sc = P.exactScore(n[f] || '', s);
    if (sc < 0.85) say(`CHECK    page ${c.page} box ${c.box} ${f}="${n[f]}" fits the PDF letters "${s}" only ${sc.toFixed(2)}`);
  }
}
const extra = names.filter((n) => !want.some((c) => key(c) === key(n)));
for (const n of extra) say(`EXTRA    box ${n.box} (${n.section}) is not in the PDF list`);
console.log(bad ? `${bad} problem(s)` : `OK: ${names.length} entries, all match`);
