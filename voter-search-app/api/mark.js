// POST {village, token, ward, box, mark} → {ok, mark}. An admin of this village (or the superadmin) marks a voter:
// 'done' (green), 'coming' (yellow, on the way) or 'absent' (red, not available); '' clears the mark.
// Every user of the village sees the mark on the slip (see marks.js for how phones pick up new marks).
const { village, redis, whoIs, MARKS, markKey, send, route } = require('./_lib.js');
const { load } = require('./_search.js');

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });
  if (!user.admin) return send(res, 403, { error: 'not_admin' });

  const key = markKey(b);
  if (!load(v.slug).rows.some((r) => markKey(r) === key)) return send(res, 404, { error: 'not_found' });
  const mark = String(b.mark || '');
  if (mark && !MARKS.includes(mark)) return send(res, 400, { error: 'bad_mark' });

  if (mark) await redis('HSET', `mark:${v.slug}`, key, `${mark}|${new Date().toISOString()}`);
  else await redis('HDEL', `mark:${v.slug}`, key);
  send(res, 200, { ok: true, mark });
});
