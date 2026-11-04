// Marks per ward (वार्ड अनुसार प्रगति), shared by the admin page (api/admin.js) and the app (api/progress.js).
const { load } = require('./_search.js');
const { village, MARKS, allMarks, markHash, getCand, redis } = require('./_lib.js');

// how many slips of a village (of one candidate's group) carry each mark, overall and per ward, and the backup its last
// "clear" left
async function markSummary(slug, cand, all) {
  all ||= await allMarks(slug, cand.id);
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
  const bk = await redis('GET', `${markHash(slug, cand.id)}:backup`);
  let backup = null;
  try { if (bk) { const j = JSON.parse(bk); backup = { n: j.flat.length / 2, at: j.at }; } } catch (e) { /* ignore a broken backup */ }
  return { key: `${slug}|${cand.id}`, slug, cand: cand.id, name: village(slug).name, candName: cand.name || '', marks,
    wards: Object.values(perWard).sort((a, b) => a.ward - b.ward), backup };
}

// the candidates of these villages, oldest first
async function candsOf(slugs) {
  const ids = (await redis('SMEMBERS', 'cands')) || [];
  return (await Promise.all(ids.map(getCand))).filter((c) => c && slugs.includes(c.village))
    .sort((x, y) => (x.created < y.created ? -1 : 1));
}
// every mark group of these villages: the village's own marks ({id: ''}) and then each of its candidates
const groupsOf = (slugs, cands) => slugs.flatMap((s) => [{ slug: s, cand: { id: '' } }, ...cands.filter((c) => c.village === s).map((c) => ({ slug: s, cand: c }))]);

module.exports = { markSummary, candsOf, groupsOf };
