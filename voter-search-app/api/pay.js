// Buying a search pack online through Razorpay (keys: payOnline in _lib.js): Razorpay's checkout window opens on our
// own page with the price, the person's name and mobile number already filled in and locked; they only choose how to pay
// (UPI, card, net banking, wallet…). The money goes to the superadmin's Razorpay account and the searches are added by
// themselves once Razorpay says the order is paid.
//   POST {action: 'start', token, village, n, coupon?} → {id, key, order, amount, name, contact, description}   makes a
//     purchase (req:<id>, gw 'razorpay') for pack n and a Razorpay order for its price; the page opens the checkout with
//     these. 20 new purchases a day per login.
//   POST {action: 'check', token, village, id [, razorpay_order_id, razorpay_payment_id, razorpay_signature]}
//     → {status: 'open' | 'done' | 'rejected', n, got, bonus, left | bought}   after the checkout (with what it handed
//     back) or on coming back to the page: the server asks Razorpay (settleOnline in _lib.js). got: searches added
//     (n + bonus, a coupon's free ones); left / bought: what the person now has.
//   POST {action: 'start', token, village, ward} → the same, for ₹WARD_RS: all of that ward's slips (wardStart below;
//     {paid: true} when this login already has them, or doesn't pay); its 'check' answers {status, kind: 'ward', ward}.
//   POST <Razorpay's webhook: {event: 'order.paid' | 'payment.captured' | 'payment.authorized', payload: …}> → {ok}
//     optional (the page's own check is enough, and so is the admin page): in Razorpay's dashboard → Webhooks, add
//     https://<site>/api/pay with those events. It credits a person whose page closed before the check.
//   Signed with RZP_WB_SECRET (razorpayHook in _lib.js); other events are answered and ignored. Webhooks only name the
//   order: it is still checked with Razorpay itself, so even a forged one can't add searches.
const { WARD_RS, wardKey, wardFree, village, buyVillage, couponHold, couponFor, couponPrice, PACKS, GATEWAY, payOnline, isOrderId, razorpayCreate, razorpaySigned, razorpayHook, settleOnline, newReqId, getReq, whoIs, canBuy, isPrepaid, creditsLeft, getUser, today, redis, send, route } = require('./_lib.js');

module.exports = route(async (req, res, b) => {
  if (!b.action && typeof b.event === 'string') {   // Razorpay's webhook
    if (!razorpayHook(req, b)) { console.warn('razorpay webhook: bad signature', b.event); return send(res, 400, { error: 'bad_signature' }); }
    if (!['order.paid', 'payment.captured', 'payment.authorized'].includes(b.event)) return send(res, 200, { ok: true });   // refunds, failures, links…: nothing to do
    const pl = b.payload || {}, order = (pl.order && pl.order.entity && pl.order.entity.id) || (pl.payment && pl.payment.entity && pl.payment.entity.order_id);
    const rid = isOrderId(order) ? await redis('GET', `rzp:${order}`) : null;
    if (rid) await settleOnline(rid);
    return send(res, 200, { ok: true });
  }
  if (b.action !== 'start' && b.action !== 'check') return send(res, 400, { error: 'action' });
  const me = await whoIs(b.token, b.village);
  if (!me || me.status !== 'ok') return send(res, 401, { error: 'login' });

  if (b.action === 'check') {
    const r = await getReq(b.id);
    if (!r || r.user !== me.id || !r.gw) return send(res, 404, { error: 'not_found' });
    // a forged checkout answer is refused outright; a genuine one is still checked with Razorpay (settleOnline)
    if (b.razorpay_signature && !(b.razorpay_order_id === r.txn && razorpaySigned(r.txn, b.razorpay_payment_id, b.razorpay_signature))) return send(res, 400, { error: 'bad_signature' });
    const now = await settleOnline(r.id), u = await getUser(me.id), left = await creditsLeft(u);
    if (r.kind === 'ward') return send(res, 200, { status: now.status, kind: 'ward', ward: Number(r.ward), village: r.wv });
    const got = now.status === 'done' ? Number(now.doneN) || Number(now.n) : 0;
    return send(res, 200, { status: now.status, n: Number(now.n), got, bonus: got ? Math.max(0, got - Number(now.n)) : 0, ...(isPrepaid(u) ? { left } : { bought: left }) });
  }

  if (!payOnline()) return send(res, 400, { error: 'no_online' });
  if (!canBuy(me)) return send(res, 400, { error: 'not_prepaid' });
  if (b.ward != null && b.ward !== '') return wardStart(req, res, b, me);
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
  if (c) { const held = await couponHold(c, me.id, id); if (held) return send(res, 409, { error: held }); }   // one open purchase per coupon
  const m = await razorpayCreate({ id, rs, n: pk[0] });
  if (m.error) {
    console.error('razorpay order', m.error, m.raw);
    return send(res, 502, { error: 'gateway', detail: m.error });
  }
  await redis('HSET', `req:${id}`, 'user', me.id, 'village', buyVillage(me, b.village), 'n', pk[0], 'rs', rs, ...(cpn ? ['coupon', cpn.coupon, 'bonus', cpn.bonus] : []), 'created', new Date().toISOString(),
    'status', 'open', 'to', GATEWAY.id, 'gw', 'razorpay', 'txn', m.txn);
  await redis('SET', `rzp:${m.txn}`, id);
  await redis('SADD', 'reqs', id);   // in the admin page's list too (the superadmin's)
  const mobile = String(me.phone || '').replace(/\D/g, '').slice(-10);
  send(res, 200, { id, key: process.env.RAZORPAY_KEY_ID, order: m.txn, amount: Math.round(rs * 100), name: me.name || '',
    contact: /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : '', description: `${pk[0]}${cpn && cpn.bonus ? ` + ${cpn.bonus}` : ''} searches` });
});

// the ward list comes from _villages.json: this function doesn't ship the voter data (only api/data.js does, vercel.json)
// a whole ward's slips: ₹WARD_RS for ward b.ward of village b.village (once; then search.js "all" gives it any time)
async function wardStart(req, res, b, me) {
  const v = village(b.village), w = parseInt(b.ward, 10);
  if (!v || !(w > 0) || !(v.wards || []).map(Number).includes(w)) return send(res, 400, { error: 'no_ward' });
  if (wardFree(me) || Number(await redis('SISMEMBER', wardKey(me.id, v.slug), String(w))) === 1) return send(res, 200, { paid: true });
  const k = `reqs:${me.id}:${today()}`;
  if (await redis('INCR', k) > 20) return send(res, 429, { error: 'too_many' });
  await redis('EXPIRE', k, 86400);
  const id = await newReqId();
  const m = await razorpayCreate({ id, rs: WARD_RS, ward: `${v.slug} ${w}` });
  if (m.error) {
    console.error('razorpay order', m.error, m.raw);
    return send(res, 502, { error: 'gateway', detail: m.error });
  }
  await redis('HSET', `req:${id}`, 'user', me.id, 'village', buyVillage(me, v.slug), 'kind', 'ward', 'ward', w, 'wv', v.slug, 'n', 0, 'rs', WARD_RS,
    'created', new Date().toISOString(), 'status', 'open', 'to', GATEWAY.id, 'gw', 'razorpay', 'txn', m.txn);
  await redis('SET', `rzp:${m.txn}`, id);
  await redis('SADD', 'reqs', id);
  const mobile = String(me.phone || '').replace(/\D/g, '').slice(-10);
  send(res, 200, { id, key: process.env.RAZORPAY_KEY_ID, order: m.txn, amount: WARD_RS * 100, name: me.name || '',
    contact: /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : '', description: `Ward ${w} slips` });
}
