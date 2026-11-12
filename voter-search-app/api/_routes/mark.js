// POST {village, token, ward, box, mark} → {ok, mark, by, at}. Admins of this village, the superadmin and users their
// admin allowed 'mark' mark a voter: 'done' (green), 'coming' (yellow, on the way) or 'absent' (red, not a voter here);
// '' clears the mark. Every user of the village sees the mark on the slip, with who set it and when
// (see marks.js for how phones pick up new marks); a candidate's workers mark and see only their candidate's marks
// (see markHash in _lib.js).
// POST {village, token, set: 'slip', keys: ["<ward>:<box>", …], mark: '1' | ''} → {ok, mark, by, at}: पर्ची दी, the slip was
// handed over (slipHash in _lib.js), for one voter or a whole house at once (up to 60 keys). Same permission as marks.
const { village, redis, pipeline, whoIs, MARKS, markKey, markHash, slipHash, send, route } = require('../_lib.js');
const { load } = require('../_search.js');

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });
  if (!user.perms.includes('mark') || v.demo) return send(res, 403, { error: 'no_mark' });   // the demo is read-only

  if (b.set === 'slip') {
    const rows = load(v.data).rows, onRoll = new Set(rows.filter((r) => !r.del).map(markKey));
    const keys = [...new Set((Array.isArray(b.keys) ? b.keys : [markKey(b)]).map(String))].slice(0, 60);
    if (!keys.length || keys.some((k) => !onRoll.has(k))) return send(res, 404, { error: 'not_found' });
    const on = String(b.mark || '') === '1';
    const at = new Date().toISOString(), by = String(user.name || '').replace(/\|/g, '/'), hash = slipHash(v.slug, user.cand);
    await pipeline(keys.map((k) => (on ? ['HSET', hash, k, `1|${at}|${user.id}|${by}`] : ['HDEL', hash, k])));
    return send(res, 200, { ok: true, mark: on ? '1' : '', by: on ? by : '', at: on ? at : '' });
  }
  const key = markKey(b);
  const row = load(v.data).rows.find((r) => markKey(r) === key);
  if (!row) return send(res, 404, { error: 'not_found' });
  if (row.del && b.mark) return send(res, 400, { error: 'deleted' });   // struck off the roll: nothing to mark
  const mark = String(b.mark || '');
  if (mark && !MARKS.includes(mark)) return send(res, 400, { error: 'bad_mark' });

  const at = new Date().toISOString(), by = String(user.name || '').replace(/\|/g, '/');
  const hash = markHash(v.slug, user.cand, user.survey);   // the set this person is using
  if (mark) await redis('HSET', hash, key, `${mark}|${at}|${user.id}|${by}`);
  else await redis('HDEL', hash, key);
  send(res, 200, { ok: true, mark, by: mark ? by : '', at: mark ? at : '' });
});
