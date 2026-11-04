// Voter data + fuzzy search, run on the server so the full list never reaches a phone.
// Each village's data ships encrypted (api/_data/<village>.enc) and is decrypted in memory with the DATA_KEY
// environment variable, the first time that village is searched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataKey } = require('./_lib.js');

const cache = new Map();
function load(slug) {     // slug must already be checked against the village list
  if (cache.has(slug)) return cache.get(slug);
  const name = `${slug}.enc`;
  const file = [path.join(__dirname, '_data', name), path.join(process.cwd(), 'api', '_data', name)].find((p) => fs.existsSync(p));
  const enc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(dataKey(), 'base64'), Buffer.from(enc.iv, 'base64'));
  d.setAuthTag(Buffer.from(enc.tag, 'base64'));
  const data = JSON.parse(Buffer.concat([d.update(Buffer.from(enc.ct, 'base64')), d.final()]).toString('utf8'));
  const F = Object.fromEntries(data.fields.map((f, i) => [f, i]));
  const rows = data.rows.map((r) => {
    const o = {};
    for (const f in F) o[f] = r[F[f]];
    o.kendra = data.kendra[o.ward];
    o.del = o.del || '';   // 'E' death, 'S' shifted, 'R' repeated: struck off the final roll, still shown (tagged)
    o._nEn = normEn(o.name); o._rEn = normEn(o.relname); o._nHi = normHi(o.hname); o._rHi = normHi(o.hrel);
    o._epic = String(o.epic || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return o;
  });
  const v = { rows, wards: [...new Set(rows.map((r) => r.ward))].sort((a, b) => a - b) };
  cache.set(slug, v);
  return v;
}

// English: fold spellings that sound alike (ee/i, oo/u, w/v, sh/s, kh/k, ph/f, ksh/x, ai/e, doubled letters, spaces).
function normEn(s) {
  s = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  s = s.replace(/ksh/g, 'x').replace(/chh/g, 'c').replace(/ch/g, 'c').replace(/sh/g, 's').replace(/ph/g, 'f')
       .replace(/([kgbdtj])h/g, '$1').replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k')
       .replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/ay/g, 'ai').replace(/ai/g, 'e').replace(/au/g, 'o')
       .replace(/y/g, 'i').replace(/m(?=[bp])/g, 'n');
  return s.replace(/(.)\1+/g, '$1');
}
// Hindi: ignore nukta, halant, anusvara/chandrabindu and long/short vowel differences; श/ष→स, ण→न.
function normHi(s) {
  s = String(s || '').normalize('NFD').replace(/[\s़्ऀ-ः॰‌‍]/g, '');
  return s.replace(/ी/g, 'ि').replace(/ू/g, 'ु').replace(/ै/g, 'े').replace(/ौ/g, 'ो').replace(/ॉ/g, 'ा')
          .replace(/[शष]/g, 'स').replace(/[णञङ]/g, 'न');
}
const isHindi = (s) => /[ऀ-ॿ]/.test(s);

// Smallest number of edits that turns q into some part of t (so "mangi" matches inside "mangilal").
// Swapping two neighbouring letters ("parkash" for "prakash") counts as one edit.
function approx(q, t) {
  const m = q.length, n = t.length;
  let prev2 = new Array(n + 1).fill(0), prev = new Array(n + 1).fill(0), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = q.charCodeAt(i - 1) === t.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
      if (i > 1 && j > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
    }
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  let best = m;
  for (let j = 0; j <= n; j++) if (prev[j] < best) best = prev[j];
  return best;
}
const allowed = (len) => (len <= 3 ? 0 : len <= 8 ? 1 : len <= 12 ? 2 : 3);

// lower score = better match; null = no match
function score(q, t) {
  const d = approx(q, t);
  if (d > allowed(q.length)) return null;
  let s = d * 10 + Math.abs(t.length - q.length) * 0.05;
  if (t.startsWith(q)) s -= 4;
  if (t === q) s -= 3;
  return s;
}

function search(slug, { name = '', rel = '', ward = '' }) {
  const { rows } = load(slug);
  name = String(name).trim().slice(0, 60); rel = String(rel).trim().slice(0, 60);
  const pool = ward ? rows.filter((r) => String(r.ward) === String(ward)) : rows;
  if (!name && !rel) return ward ? [...pool].sort((a, b) => a.box - b.box) : [];   // only a ward: all its voters in box order
  if (/^\d{1,4}$/.test(name) && !rel) return pool.filter((r) => r.box === +name);            // box number
  const wb = !rel && name.match(/^(\d{1,3})\s*[/-]\s*(\d{1,4})$/);                            // "3/25" = ward 3, box 25
  if (wb) return rows.filter((r) => r.ward === +wb[1] && r.box === +wb[2]);
  if ((/\d{3,}/.test(name) && /[a-z]/i.test(name)) || /^rj\W?\d/i.test(name)) {                // voter ID
    const k = name.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return pool.filter((r) => r._epic.includes(k));
  }
  const nq = name && (isHindi(name) ? ['_nHi', normHi(name)] : ['_nEn', normEn(name)]);
  const rq = rel && (isHindi(rel) ? ['_rHi', normHi(rel)] : ['_rEn', normEn(rel)]);
  if ((nq && !nq[1]) || (rq && !rq[1])) return [];
  const hits = [];
  for (const r of pool) {
    let s = 0;
    if (nq) { const x = score(nq[1], r[nq[0]]); if (x === null) continue; s += x; }
    if (rq) { const x = score(rq[1], r[rq[0]]); if (x === null) continue; s += x; }
    hits.push([s, r]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1].ward - b[1].ward || a[1].box - b[1].box);
  return hits.map((h) => h[1]);
}

// everyone with the same house number in the same ward as voter "<ward>:<box>", by box number
function family(slug, key) {
  const [ward, box] = String(key).split(':').map(Number);
  const { rows } = load(slug);
  const me = rows.find((r) => r.ward === ward && r.box === box);
  if (!me) return [];
  if (!String(me.house || '').trim()) return [me];
  return rows.filter((r) => r.ward === ward && r.house === me.house).sort((a, b) => a.box - b.box);
}

const publicFields = ({ ward, box, epic, hname, hrel, rel, house, age, sex, name, relname, kendra, del }) =>
  ({ ward, box, epic, hname, hrel, rel, house, age, sex, name, relname, kendra, del });

module.exports = { load, search, family, publicFields };
