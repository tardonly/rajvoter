// Marks per ward (वार्ड अनुसार प्रगति) and the voters behind them (मतदाता सूची), shared by the admin page (api/_routes/admin.js)
// and the app (api/_routes/progress.js).
const { load } = require('./_search.js');
const { village, MARKS, allMarks, allSlips, markHash, getCand, redis } = require('./_lib.js');

// how many slips of a village (of one candidate's group) carry each mark, overall and per ward, and the backup its last
// "clear" left
// survey: which set of marks (markModeOf in _lib.js); all, bk: already read (the admin page reads every village at once)
async function markSummary(slug, cand, survey, all, bk, slips) {
  all ||= await allMarks(slug, cand.id, survey);
  const zero = () => Object.fromEntries(MARKS.map((m) => [m, 0]));
  const marks = zero(), perWard = {};
  const onRoll = new Set();
  for (const r of load(slug).rows) {
    perWard[r.ward] ||= { ward: r.ward, total: 0, ...zero() };
    if (r.del) continue;   // struck off the roll: not counted
    perWard[r.ward].total++;
    onRoll.add(`${r.ward}:${r.box}`);
  }
  for (const [key, { m }] of Object.entries(all)) {
    if (!MARKS.includes(m) || !onRoll.has(key)) continue;
    marks[m]++;
    const w = perWard[key.split(':')[0]];
    if (w) w[m]++;
  }
  // पर्ची दी: how many slips were handed over (slip), overall and per ward
  let slip = 0;
  for (const w of Object.values(perWard)) w.slip = 0;
  for (const key of Object.keys(slips || (slips = await allSlips(slug, cand.id)))) {
    if (!onRoll.has(key)) continue;
    slip++;
    const w = perWard[key.split(':')[0]];
    if (w) w.slip++;
  }
  if (bk === undefined) bk = await redis('GET', `${markHash(slug, cand.id, survey)}:backup`);
  let backup = null;
  try { if (bk) { const j = JSON.parse(bk); backup = { n: j.flat.length / 2, at: j.at }; } } catch (e) { /* ignore a broken backup */ }
  return { key: `${slug}|${cand.id}`, slug, cand: cand.id, name: village(slug).name, candName: cand.name || '', marks, slip,
    wards: Object.values(perWard).sort((a, b) => a.ward - b.ward), backup };
}

// मतदाता सूची: voters of a village (of one candidate's group) carrying a mark ('done' | 'coming' | 'absent') or none yet
// ('none'), or whose slip was handed over ('slip') or not yet ('noslip'), in ward and box order, LIST_PAGE at a time from offset; null for an unknown status
const LIST_PAGE = 100;
async function markedList(slug, candId, survey, status, ward, offset) {
  const slipList = status === 'slip' || status === 'noslip';   // पर्ची दी / पर्ची नहीं दी
  if (status !== 'none' && !slipList && !MARKS.includes(status)) return null;
  const all = slipList ? await allSlips(slug, candId) : await allMarks(slug, candId, survey);
  const want = (r) => {
    const m = all[`${r.ward}:${r.box}`];
    if (slipList) return !!m === (status === 'slip');
    return status === 'none' ? !(m && MARKS.includes(m.m)) : !!m && m.m === status;
  };
  const hits = load(slug).rows.filter((r) => !r.del && (!ward || String(r.ward) === String(ward)) && want(r))
    .sort((x, y) => x.ward - y.ward || x.box - y.box);
  const from = Math.max(0, Number(offset) || 0);
  const rows = hits.slice(from, from + LIST_PAGE).map(({ ward: w, box, hname, name, hrel, relname, rel, house, age, sex }) => {
    const m = all[`${w}:${box}`];
    return { ward: w, box, hname, name, hrel, relname, rel, house, age, sex, by: m ? m.by : '', at: m ? m.at : '' };
  });
  return { total: hits.length, more: from + rows.length < hits.length, rows };
}

// the candidates of these villages, oldest first; reach: also those whose workers only mark in them (a ZP / PS
// candidate of another village, getCand in _lib.js)
async function candsOf(slugs, reach) {
  const ids = (await redis('SMEMBERS', 'cands')) || [];
  return (await Promise.all(ids.map(getCand))).filter((c) => c && (reach ? c.villages : [c.village]).some((s) => slugs.includes(s)))
    .sort((x, y) => (x.created < y.created ? -1 : 1));
}
// every mark group of these villages: the village's own marks ({id: ''}) and then each of its candidates
const groupsOf = (slugs, cands) => slugs.flatMap((s) => [{ slug: s, cand: { id: '' } }, ...cands.filter((c) => c.villages.includes(s)).map((c) => ({ slug: s, cand: c }))]);

module.exports = { markSummary, markedList, candsOf, groupsOf };
