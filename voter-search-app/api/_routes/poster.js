// POST {village, token} → {top, big}
// POST {village, token, set: 'top' | 'big', img: 'data:image/jpeg;base64,…' | ''} → {ok, top, big, ballot}
// POST {village, token, set: 'ballot', no: '2', name: 'मंजू देवी'} → the EVM row printed under the posters ('' no takes it off)
// POST {village, token, set: 'sym', img} → the election symbol shown in that row ('' takes it off)
// पर्ची सेटिंग in the app: a login's own posters for the slips it prints — "top", a banner over every slip, and "big", one
// poster over the first page of a PDF of many slips (a ward, a family). The phone shrinks each picture to a JPEG before
// sending it (index.html posterPick); '' takes it off. Kept in hash poster:<login id>, so they follow the login to
// another phone. Not in the demo.
const { village, whoIs, redis, send, route } = require('../_lib.js');

const MAX = 450 * 1024;   // characters of the data URL: ~330 KB of JPEG, far above what the phone sends
const SYM_MAX = 80 * 1024;   // the symbol: a small square picture
const JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });
  if (user.demo) return send(res, 403, { error: 'demo' });
  const key = `poster:${user.id}`;
  if (b.set === 'ballot') {
    const no = String(b.no ?? '').trim(), name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
    if (!no) await redis('HDEL', key, 'bn', 'bnm');
    else if (!/^[1-9][0-9]{0,2}$/.test(no) || name.length > 40) return send(res, 400, { error: 'bad' });
    else await redis('HSET', key, 'bn', no, 'bnm', name);
  } else if (b.set === 'sym') {
    const img = String(b.img || '');
    if (!img) await redis('HDEL', key, 'sym');
    else if (img.length > SYM_MAX) return send(res, 413, { error: 'too_big' });
    else if (!JPEG.test(img)) return send(res, 400, { error: 'bad' });
    else await redis('HSET', key, 'sym', img);
  } else if (b.set != null) {
    if (b.set !== 'top' && b.set !== 'big') return send(res, 400, { error: 'bad' });
    const img = String(b.img || '');
    if (!img) await redis('HDEL', key, b.set);
    else if (img.length > MAX) return send(res, 413, { error: 'too_big' });
    else if (!JPEG.test(img)) return send(res, 400, { error: 'bad' });
    else await redis('HSET', key, b.set, img);
  }
  const [top, big, bn, bnm, sym] = (await redis('HMGET', key, 'top', 'big', 'bn', 'bnm', 'sym')) || [];
  send(res, 200, { ok: true, top: top || '', big: big || '', ballot: { no: bn || '', name: bnm || '', sym: sym || '' } });
});
