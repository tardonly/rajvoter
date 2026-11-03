// POST {village, token, name, rel, ward, offset} → {total, offset, more, results: [...up to 10 voters, each with its mark], wards}
// With only a ward (no name), every voter of that ward in box order, 10 at a time.
// POST {village, token, ward, all: true} → {total, results: [every voter of that ward]}   (admins only)
// Every search checks that the password behind the token is still active and that this phone holds its newest
// session, so retiring or logging in on another phone takes effect at once.
const { village, redis, whoIs, markKey, marksFor, send, route } = require('./_lib.js');
const { load, search, publicFields } = require('./_search.js');

const PAGE = 10, MAX_OFFSET = 240, PER_MINUTE = 120;   // 10 slips at a time; a name search shows at most 250

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

  // admins only: every voter of one ward, in box order, to print or save that ward's slips
  if (b.all) {
    if (!user.admin) return send(res, 403, { error: 'not_admin' });
    const rows = load(v.slug).rows.filter((r) => String(r.ward) === String(b.ward)).sort((x, y) => x.box - y.box);
    if (!rows.length) return send(res, 404, { error: 'no_ward' });
    return send(res, 200, { total: rows.length, results: rows.map(publicFields) });
  }

  const hits = search(v.slug, b);
  // a name search pages up to 250 results; browsing a ward pages through the whole ward
  const last = String(b.name || '').trim() || String(b.rel || '').trim() ? MAX_OFFSET : hits.length;
  const offset = Math.min(Math.max(0, parseInt(b.offset, 10) || 0), last);
  const results = hits.slice(offset, offset + PAGE).map(publicFields);
  // the marks admins set (done / coming / absent), shown to everyone on the slips
  const marks = await marksFor(v.slug, results.map(markKey));
  results.forEach((r, i) => { r.mark = marks[i]; });
  const more = offset + PAGE < hits.length && offset + PAGE <= last;
  send(res, 200, { total: hits.length, offset, page: PAGE, more, results, wards: load(v.slug).wards });
});
