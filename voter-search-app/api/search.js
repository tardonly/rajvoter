// POST {village, token, name, rel, ward, mark, offset, after} → {total, more, results: [...up to 10 voters, each with its
//   status mark and who set it], wards, perms}
// POST {village, token, family: "<ward>:<box>"} → {total, results: everyone at that voter's house number in that ward}
// POST {village, token, ward, all: true} → {total, results: [every voter of that ward]}   (people allowed 'wardPdf')
// A ward with no name lists the whole ward in box order (only for people allowed 'ward'); it pages with after = the last
// box shown, so marking slips while going through a filtered list doesn't skip anyone. A name search pages through its
// best 250 matches. mark filters by status mark: 'none' (no mark yet) | 'done' | 'coming' | 'absent'.
// Voters struck off the roll (del 'E' | 'S' | 'R') are found and shown, tagged, but never in a mark filter or ward slips.
// Every search checks that the password behind the token is still active and that this phone holds its newest
// session, so retiring or logging in on another phone takes effect at once.
const { village, redis, whoIs, MARKS, markKey, marksFor, allMarks, today, send, route } = require('./_lib.js');
const { load, search, family, publicFields } = require('./_search.js');

const PAGE = 10, MAX_NAMED = 250, MAX_FAMILY = 60, PER_MINUTE = 120;   // 10 slips at a time

async function withMarks(slug, list) {
  const results = list.map(publicFields);
  const marks = await marksFor(slug, results.map(markKey));
  results.forEach((r, i) => { r.mark = marks[i].m; r.markBy = marks[i].by; r.markAt = marks[i].at; });
  return results;
}

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });   // retired, opened on another phone, other village

  const minuteKey = `rate:${user.id}:${Math.floor(Date.now() / 60000)}`;
  const n = await redis('INCR', minuteKey);
  if (n === 1) await redis('EXPIRE', minuteKey, 120);
  if (n > PER_MINUTE) return send(res, 429, { error: 'slow_down' });
  if (!user.admin) {   // searches per person per day, shown on the admin page
    const dayKey = `searches:${user.id}:${today()}`;
    if (await redis('INCR', dayKey) === 1) await redis('EXPIRE', dayKey, 3 * 86400);
  }

  // every voter of one ward, in box order, to print or save that ward's slips
  if (b.all) {
    if (!user.perms.includes('wardPdf')) return send(res, 403, { error: 'no_pdf' });
    const rows = load(v.slug).rows.filter((r) => String(r.ward) === String(b.ward) && !r.del).sort((x, y) => x.box - y.box);
    if (!rows.length) return send(res, 404, { error: 'no_ward' });
    return send(res, 200, { total: rows.length, results: rows.map(publicFields) });
  }

  if (b.family) {
    const results = await withMarks(v.slug, family(v.slug, b.family).slice(0, MAX_FAMILY));
    return send(res, 200, { total: results.length, results, perms: user.perms });
  }

  const named = String(b.name || '').trim() || String(b.rel || '').trim();
  if (!named && b.ward && !user.perms.includes('ward')) return send(res, 403, { error: 'no_ward_list' });
  let hits = search(v.slug, b);
  const filter = String(b.mark || '');
  if (filter === 'none' || MARKS.includes(filter)) {
    const marks = await allMarks(v.slug);
    hits = hits.filter((r) => !r.del && ((marks[markKey(r)] || {}).m || 'none') === filter);
  }
  const total = hits.length;
  let page, more;
  if (named) {
    const limit = Math.min(total, MAX_NAMED);
    const offset = Math.min(Math.max(0, parseInt(b.offset, 10) || 0), limit);
    page = hits.slice(offset, Math.min(offset + PAGE, limit));
    more = offset + PAGE < limit;
  } else {
    const after = parseInt(b.after, 10) || 0;
    const rest = after ? hits.filter((r) => r.box > after) : hits;
    page = rest.slice(0, PAGE);
    more = rest.length > PAGE;
  }
  send(res, 200, { total, more, results: await withMarks(v.slug, page), wards: load(v.slug).wards, perms: user.perms });
});
