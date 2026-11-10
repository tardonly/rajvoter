// Buying a search pack online with UPI through JaduPe (jadupe.com; set JADUPE_TOKEN, see _lib.js). The money goes to the
// superadmin's JaduPe account and the searches are added by themselves once JaduPe says it is paid.
//   POST {action: 'start', token, village, n, coupon?} → {id, link}   makes a request (req:<id>, gw 'jadupe', to the superadmin)
//     for pack n, and a JaduPe transaction for its price; the phone opens link (JaduPe's payment page), which comes back
//     to /<village>?pay=<id> when done. 20 new requests a day per login (shared with the WhatsApp requests).
//   POST {action: 'check', token, village, id} → {status: 'open' | 'done' | 'rejected', n, left, bought}   the phone asks
//     after coming back; the server asks JaduPe (settleOnline in _lib.js).
//   POST <JaduPe's webhook: {txn_id, status, …}> → {ok}   set https://<site>/api/pay as the webhook URL on JaduPe. Only
//     the txn_id is used: the payment is checked with JaduPe itself, so a made-up webhook can't add searches.
const { buyVillage, couponHold, couponFor, couponPrice, PACKS, GATEWAY, payOnline, jadupe, settleOnline, newReqId, getReq, whoIs, canBuy, isPrepaid, creditsLeft, getUser, today, redis, send, route } = require('./_lib.js');

const site = (req) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'raj-voter.vercel.app');
  const proto = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'http' : 'https';
  return `${proto}://${host}`;
};

module.exports = route(async (req, res, b) => {
  if (!b.action && b.txn_id != null) {   // JaduPe's webhook
    const rid = await redis('GET', `jtxn:${String(b.txn_id).replace(/\D/g, '')}`);
    if (rid) await settleOnline(rid);
    return send(res, 200, { ok: true });
  }
  if (b.action !== 'start' && b.action !== 'check') return send(res, 400, { error: 'action' });
  const me = await whoIs(b.token, b.village);
  if (!me || me.status !== 'ok') return send(res, 401, { error: 'login' });

  if (b.action === 'check') {
    const r = await getReq(b.id);
    if (!r || r.user !== me.id || r.gw !== 'jadupe') return send(res, 404, { error: 'not_found' });
    const now = await settleOnline(r.id), u = await getUser(me.id), left = await creditsLeft(u);
    return send(res, 200, { status: now.status, n: Number(now.n), ...(isPrepaid(u) ? { left } : { bought: left }) });
  }

  if (!payOnline()) return send(res, 400, { error: 'no_online' });
  if (!canBuy(me)) return send(res, 400, { error: 'not_prepaid' });
  const pk = PACKS.find(([n]) => n === Number(b.n));
  if (!pk) return send(res, 400, { error: 'bad_credits' });
  let cpn = null, c = null;   // a coupon: its lower price and bonus searches (couponFor in _lib.js)
  if (b.coupon) {
    const r = await couponFor(b.coupon, me, pk[0]);
    if (r.error) return send(res, 400, r);
    c = r.c;
    cpn = { coupon: c.code, ...couponPrice(c, pk[0]) };
  }
  const rs = cpn ? cpn.rs : pk[1];
  const k = `reqs:${me.id}:${today()}`;
  if (await redis('INCR', k) > 20) return send(res, 429, { error: 'too_many' });
  await redis('EXPIRE', k, 86400);
  const id = await newReqId();
  if (c) { const held = await couponHold(c, me.id, id); if (held) return send(res, 409, { error: held }); }   // one open request per coupon
  const mobile = String(me.phone || '').slice(-10);
  const j = await jadupe('transactions/create', {
    type: 'any', user_name: me.name || 'User', user_email: process.env.JADUPE_EMAIL || 'noreply@raj-voter.vercel.app',
    user_mobile: /^\d{10}$/.test(mobile) ? mobile : process.env.JADUPE_MOBILE || '9999999999',
    amount: rs, redirect_url: `${site(req)}/${buyVillage(me, b.village)}?pay=${id}`,
  });
  const txn = j && j.success && j.data ? String(j.data.txnId || '').replace(/\D/g, '') : '';
  const link = j && j.success && j.data ? String(j.data.paymentLink || '') : '';
  if (!txn || !/^https?:\/\//.test(link)) {
    console.error('jadupe create', j);
    return send(res, 502, { error: 'gateway', detail: (j && j.message) || '' });
  }
  await redis('HSET', `req:${id}`, 'user', me.id, 'village', buyVillage(me, b.village), 'n', pk[0], 'rs', rs, ...(cpn ? ['coupon', cpn.coupon, 'bonus', cpn.bonus] : []), 'created', new Date().toISOString(),
    'status', 'open', 'to', GATEWAY.id, 'gw', 'jadupe', 'txn', txn, 'link', link);
  await redis('SET', `jtxn:${txn}`, id);
  await redis('SADD', 'reqs', id);   // in the admin page's list too (the superadmin's, while open)
  send(res, 200, { id, link });
});
