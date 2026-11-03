// POST {village, token, ward, box, mark} → {ok, mark}. An admin of this village (or the superadmin) marks a voter:
// 'done' (green), 'coming' (yellow, on the way) or 'absent' (red, not available); '' clears the mark.
// Marks are kept per village in one hash, field "<ward>:<box>", and every user sees them on the slips.
const { village, redis, whoIs, send, route } = require('./_lib.js');

const MARKS = ['done', 'coming', 'absent'];

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });
  if (!user.admin) return send(res, 403, { error: 'not_admin' });

  const ward = parseInt(b.ward, 10), box = parseInt(b.box, 10);
  if (!v.wards.includes(ward) || !(box > 0 && box < 10000)) return send(res, 400, { error: 'bad_voter' });
  const mark = String(b.mark || '');
  if (mark && !MARKS.includes(mark)) return send(res, 400, { error: 'bad_mark' });

  if (mark) await redis('HSET', `mark:${v.slug}`, `${ward}:${box}`, mark);
  else await redis('HDEL', `mark:${v.slug}`, `${ward}:${box}`);
  send(res, 200, { ok: true, mark });
});
