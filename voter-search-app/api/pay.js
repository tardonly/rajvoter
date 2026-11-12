// Buying a search pack online through Razorpay (keys: payOnline in _lib.js): Razorpay's checkout window opens on our
// own page with the price, the person's name and mobile number already filled in and locked; they only choose how to pay
// (UPI, card, net banking, wallet…). The money goes to the superadmin's Razorpay account and the searches are added by
// themselves once Razorpay says the order is paid.
//   POST {action: 'start', token, village, n, coupon?} → {id, key, order, amount, name, contact, description}   makes a
//     purchase (req:<id>, gw 'razorpay') for pack n and a Razorpay order for its price; the page opens the checkout with
//     these. 20 new purchases a day per login.
//   ref (optional, in either 'start'): who asked this person to buy — their referral code or mobile number (refBuyer in
//     _lib.js); they get the referral cashback on it once it is paid (refReward). error 'ref_bad' when it names nobody.
//   POST {action: 'ref_check', token, village, ref} → {name} | {error: 'ref_bad'}   the buy window's check before paying
//   POST {action: 'check', token, village, id [, razorpay_order_id, razorpay_payment_id, razorpay_signature]}
//     → {status: 'open' | 'done' | 'rejected', n, got, bonus, left | bought}   after the checkout (with what it handed
//     back) or on coming back to the page: the server asks Razorpay (settleOnline in _lib.js). got: searches added
//     (n + bonus, a coupon's free ones); left / bought: what the person now has.
//   POST {action: 'start', token, village, ward[, az]} → the same, for ₹WARD_RS: all of that ward's slips (wardStart below;
//     az: in name order too, ₹WARD_AZ_RS more, or only that for a ward already bought;
//     {paid: true} when this login already has them, or doesn't pay); its 'check' answers {status, kind: 'ward', ward}.
//   POST <Razorpay's webhook: {event: 'order.paid' | 'payment.captured' | 'payment.authorized' | 'qr_code.credited', payload: …}> → {ok}
//     (qr_code.credited: a UPI QR a village admin made for someone, api/_routes/admin.js "agent_start")
//     optional (the page's own check is enough, and so is the admin page): in Razorpay's dashboard → Webhooks, add
//     https://<site>/api/pay with those events. It credits a person whose page closed before the check.
//   Signed with RZP_WB_SECRET (razorpayHook in _lib.js); other events are answered and ignored. Webhooks only name the
//   order: it is still checked with Razorpay itself, so even a forged one can't add searches.
//   RazorpayX's webhook (payout.processed / payout.failed / payout.reversed / payout.rejected, same URL) settles a UPI
//   withdrawal from the wallet the same way: only after asking Razorpay about the payout (wdSettle).
// The wallet (₹ cashback from invites; walletOf / wdStart in _lib.js), for a person's login:
//   POST {action: 'wallet', token, village} → {wallet, min, auto, upi, wds}   auto: UPI withdrawals go at once (RazorpayX);
//     upi: the UPI ID used last; wds: the latest withdrawals (wdView in _lib.js)
//   POST {action: 'wallet_searches', token, village, rs} → {wallet, got, left | bought}   ₹rs of it → rs searches
//   POST {action: 'wallet_upi', token, village, rs, upi} → {wallet, wd}   ₹rs of it to that UPI ID (from ₹WALLET_MIN,
//     one open withdrawal at a time, 3 a day); errors: wallet_min, wallet_low, bad_upi, wd_open, too_many, no_wallet
const { refFor, refBuyer, WALLET_MIN, UPI_RE, walletOf, hasWallet, payoutsOn, walletToSearches, getWd, wdView, wdOpen, wdStart, wdSettle, wdsOf, WARD_RS, WARD_AZ_RS, wardKey, wardAzKey, wardFree, village, buyVillage, couponHold, couponFor, couponPrice, PACKS, GATEWAY, payOnline, isTxnId, razorpayCreate, razorpaySigned, razorpayHook, settleOnline, newReqId, getReq, whoIs, canBuy, isPrepaid, creditsLeft, getUser, today, redis, send, route } = require('./_lib.js');

module.exports = route(async (req, res, b) => {
  if (!b.action && typeof b.event === 'string') {   // Razorpay's webhook
    if (!razorpayHook(req, b)) { console.warn('razorpay webhook: bad signature', b.event); return send(res, 400, { error: 'bad_signature' }); }
    if (/^payout\./.test(b.event)) {   // RazorpayX: a wallet withdrawal (its reference_id is the withdrawal's id)
      const p = (b.payload && b.payload.payout && b.payload.payout.entity) || {};
      const w = await getWd(p.reference_id);
      if (w && w.payout === p.id) await wdSettle(w);
      return send(res, 200, { ok: true });
    }
    if (!['order.paid', 'payment.captured', 'payment.authorized', 'qr_code.credited'].includes(b.event)) return send(res, 200, { ok: true });   // refunds, failures, links…: nothing to do
    const pl = b.payload || {}, order = (pl.qr_code && pl.qr_code.entity && pl.qr_code.entity.id) || (pl.order && pl.order.entity && pl.order.entity.id)
      || (pl.payment && pl.payment.entity && pl.payment.entity.order_id);
    const rid = isTxnId(order) ? await redis('GET', `rzp:${order}`) : null;
    if (rid) await settleOnline(rid);
    return send(res, 200, { ok: true });
  }
  if (!['start', 'check', 'ref_check', 'wallet', 'wallet_searches', 'wallet_upi'].includes(b.action)) return send(res, 400, { error: 'action' });
  const me = await whoIs(b.token, b.village);
  if (!me || me.status !== 'ok') return send(res, 401, { error: 'login' });
  if (b.action.startsWith('wallet')) return wallet(res, b, me);
  let via = null;   // the referrer named at checkout
  if (b.ref && (b.action === 'start' || b.action === 'ref_check')) {
    via = await refBuyer(b.ref, me);
    if (!via) return send(res, 400, { error: 'ref_bad' });
  }
  if (b.action === 'ref_check') return send(res, 200, via ? { name: via.name || '' } : { error: 'ref_bad' });

  if (b.action === 'check') {
    const r = await getReq(b.id);
    if (!r || r.user !== me.id || !r.gw) return send(res, 404, { error: 'not_found' });
    // a forged checkout answer is refused outright; a genuine one is still checked with Razorpay (settleOnline)
    if (b.razorpay_signature && !(b.razorpay_order_id === r.txn && razorpaySigned(r.txn, b.razorpay_payment_id, b.razorpay_signature))) return send(res, 400, { error: 'bad_signature' });
    const now = await settleOnline(r.id), u = await getUser(me.id), left = await creditsLeft(u);
    if (r.kind === 'ward') return send(res, 200, { status: now.status, kind: 'ward', ward: Number(r.ward), village: r.wv, az: r.az === '1' });
    const got = now.status === 'done' ? Number(now.doneN) || Number(now.n) : 0;
    return send(res, 200, { status: now.status, n: Number(now.n), got, bonus: got ? Math.max(0, got - Number(now.n)) : 0, ...(isPrepaid(u) ? { left } : { bought: left }) });
  }

  if (!payOnline()) return send(res, 400, { error: 'no_online' });
  if (!canBuy(me)) return send(res, 400, { error: 'not_prepaid' });
  if (b.ward != null && b.ward !== '') return wardStart(req, res, b, me, via);
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
  await redis('HSET', `req:${id}`, 'user', me.id, 'village', buyVillage(me, b.village), 'n', pk[0], 'rs', rs, ...(cpn ? ['coupon', cpn.coupon, 'bonus', cpn.bonus] : []), ...(via ? ['ref', via.id] : []), 'created', new Date().toISOString(),
    'status', 'open', 'to', GATEWAY.id, 'gw', 'razorpay', 'txn', m.txn);
  await redis('SET', `rzp:${m.txn}`, id);
  await redis('SADD', 'reqs', id);   // in the admin page's list too (the superadmin's)
  const mobile = String(me.phone || '').replace(/\D/g, '').slice(-10);
  send(res, 200, { id, key: process.env.RAZORPAY_KEY_ID, order: m.txn, amount: Math.round(rs * 100), name: me.name || '',
    contact: /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : '', description: `${pk[0]}${cpn && cpn.bonus ? ` + ${cpn.bonus}` : ''} searches` });
});

// the ward list comes from _villages.json: this function doesn't ship the voter data (only api/data.js does, vercel.json)
// a whole ward's slips: ₹WARD_RS for ward b.ward of village b.village (once; then search.js "all" gives it any time)
async function wardStart(req, res, b, me, via) {
  const v = village(b.village), w = parseInt(b.ward, 10), az = !!b.az;
  if (!v || !(w > 0) || !(v.wards || []).map(Number).includes(w)) return send(res, 400, { error: 'no_ward' });
  if (await wardFree(me)) return send(res, 200, { paid: true, az: true });
  const has = Number(await redis('SISMEMBER', wardKey(me.id, v.slug), String(w))) === 1;
  const hasAz = has && Number(await redis('SISMEMBER', wardAzKey(me.id, v.slug), String(w))) === 1;
  if (has && (!az || hasAz)) return send(res, 200, { paid: true, az: hasAz });
  // az: the ward in name order too, ₹WARD_AZ_RS more (only that, for a ward bought before in box order)
  const rs = (has ? 0 : WARD_RS) + (az ? WARD_AZ_RS : 0);
  const k = `reqs:${me.id}:${today()}`;
  if (await redis('INCR', k) > 20) return send(res, 429, { error: 'too_many' });
  await redis('EXPIRE', k, 86400);
  const id = await newReqId();
  const m = await razorpayCreate({ id, rs, ward: `${v.slug} ${w}${az ? ' az' : ''}` });
  if (m.error) {
    console.error('razorpay order', m.error, m.raw);
    return send(res, 502, { error: 'gateway', detail: m.error });
  }
  await redis('HSET', `req:${id}`, 'user', me.id, 'village', buyVillage(me, v.slug), 'kind', 'ward', 'ward', w, 'wv', v.slug, 'n', 0, 'rs', rs, ...(az ? ['az', '1'] : []), ...(via ? ['ref', via.id] : []),
    'created', new Date().toISOString(), 'status', 'open', 'to', GATEWAY.id, 'gw', 'razorpay', 'txn', m.txn);
  await redis('SET', `rzp:${m.txn}`, id);
  await redis('SADD', 'reqs', id);
  const mobile = String(me.phone || '').replace(/\D/g, '').slice(-10);
  send(res, 200, { id, key: process.env.RAZORPAY_KEY_ID, order: m.txn, amount: rs * 100, name: me.name || '',
    contact: /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : '', description: has ? `Ward ${w} slips in name order` : `Ward ${w} slips${az ? ' + name order' : ''}` });
}

// the wallet's actions (see the top of this file)
async function wallet(res, b, me) {
  if (!hasWallet(me)) return send(res, 403, { error: 'no_wallet' });
  const rs = Math.floor(Number(b.rs));
  if (b.action === 'wallet_searches') {
    if (!(rs >= 1)) return send(res, 400, { error: 'wallet_amount' });
    const got = await walletToSearches(me, rs);
    if (!got) return send(res, 400, { error: 'wallet_low' });
    const u = await getUser(me.id), left = await creditsLeft(u);
    return send(res, 200, { wallet: walletOf(u), got, ...(isPrepaid(u) ? { left } : { bought: left }) });
  }
  if (b.action === 'wallet_upi') {
    const upi = String(b.upi || '').trim().toLowerCase();
    if (!(rs >= WALLET_MIN)) return send(res, 400, { error: 'wallet_min', min: WALLET_MIN });
    if (!UPI_RE.test(upi)) return send(res, 400, { error: 'bad_upi' });
    if ((await wdsOf(me.id, 20)).some(wdOpen)) return send(res, 409, { error: 'wd_open' });
    const k = `wdday:${me.id}:${today()}`;
    if (await redis('INCR', k) > 3) return send(res, 429, { error: 'too_many' });
    await redis('EXPIRE', k, 86400);
    const r = await wdStart(me, rs, upi);
    if (r.error) return send(res, 400, r);
    return send(res, 200, { wallet: walletOf(await getUser(me.id)), wd: wdView(r.wd) });
  }
  const wds = await wdsOf(me.id), u = await getUser(me.id);   // after wdsOf: a failed withdrawal is back in the wallet
  send(res, 200, { wallet: walletOf(u), min: WALLET_MIN, auto: payoutsOn(), upi: u.upi || '', wds: wds.map(wdView), ref: await refFor(u) });
}
