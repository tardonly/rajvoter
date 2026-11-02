// POST {village, token, name, rel, ward, offset} → {total, offset, results: [...up to 50 voters], wards}
// Every search checks that the password behind the token is still active and that this phone holds its newest
// session, so retiring or logging in on another phone takes effect at once.
const { village, redis, whoIs, send, route } = require('./_lib.js');
const { load, search, publicFields } = require('./_search.js');

const PAGE = 50, MAX_OFFSET = 200, PER_MINUTE = 120;

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

  const hits = search(v.slug, b);
  const offset = Math.min(Math.max(0, parseInt(b.offset, 10) || 0), MAX_OFFSET);
  send(res, 200, {
    total: hits.length, offset, page: PAGE,
    results: hits.slice(offset, offset + PAGE).map(publicFields),
    wards: load(v.slug).wards,
  });
});
