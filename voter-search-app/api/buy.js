// Buying searches for one village with UPI, without a payment gateway. ₹1 per search, in the packs of PACKS (_lib.js).
// The buyer pays the UPI ID in the UPI_ID environment variable (payee name UPI_NAME, default "Voter Search"), types the
// payment's UTR (the 12-digit number every UPI payment shows) and waits; the superadmin checks the money arrived with
// that UTR and approves it on the admin page (api/admin.js, actions "buys" / "buy_approve" / "buy_reject"). Approving
// makes a new password with that many searches, or adds them to the buyer's earlier bought password (same village and
// mobile number). Buying is off (no link in the app) until UPI_ID is set.
//   POST {action: 'info'}  → {upi, payee, packs, villages}
//   POST {action: 'request', village, name, phone, amount, utr} → {id, key}   key = the buyer's secret for 'status'
//   POST {action: 'status', id, key} → {status: 'pending' | 'approved' | 'rejected', village, amount, name, utr, at,
//     password (a new login, kept 3 days for the buyer to see) | topup: true, reason (when rejected)}
// A UTR can be used once (a rejected request frees it). 10 requests per internet address in 15 minutes.
// Keys: "buy:<id>" (hash: village, name, phone, amount, utr, at, status, keyHash, userId, reason, decidedAt, decidedBy),
// set "buys" (all ids), "utr:<utr>" → id, "buypw:<id>" → the new password (3 days).
const crypto = require('crypto');
const { PACKS, village, villageList, normPhone, redis, blocked, failed, send, route } = require('./_lib.js');
const { getBuy } = require('./_buy.js');

const upiId = () => String(process.env.UPI_ID || '').trim();
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

module.exports = route(async (req, res, b) => {
  if (b.action === 'info') {
    return send(res, 200, { upi: upiId(), payee: String(process.env.UPI_NAME || 'Voter Search').trim(), packs: PACKS,
      villages: upiId() ? villageList() : [] });
  }

  if (b.action === 'request') {
    if (!upiId()) return send(res, 403, { error: 'buy_off' });
    if (await blocked(req, 'buy')) return send(res, 429, { error: 'too_many' });
    const v = village(b.village);
    if (!v || v.demo) return send(res, 400, { error: 'no_village' });
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    const amount = Number(b.amount);
    if (!PACKS.includes(amount)) return send(res, 400, { error: 'amount' });
    const utr = String(b.utr || '').replace(/\s/g, '');
    if (!/^\d{12}$/.test(utr)) return send(res, 400, { error: 'utr' });
    await failed(req, 'buy');   // counts every request, so one address can't flood the list
    const id = crypto.randomBytes(5).toString('hex'), key = crypto.randomBytes(12).toString('base64url');
    if (!(await redis('SET', `utr:${utr}`, id, 'NX'))) return send(res, 409, { error: 'utr_used' });
    await redis('HSET', `buy:${id}`, 'village', v.slug, 'name', name, 'phone', phone, 'amount', amount, 'utr', utr,
      'at', new Date().toISOString(), 'status', 'pending', 'keyHash', hashKey(key));
    await redis('SADD', 'buys', id);
    return send(res, 200, { id, key });
  }

  if (b.action === 'status') {
    const x = await getBuy(b.id);
    if (!x || !b.key || hashKey(b.key) !== x.keyHash) return send(res, 404, { error: 'not_found' });
    const out = { status: x.status, village: x.village, amount: Number(x.amount), name: x.name, utr: x.utr, at: x.at };
    if (x.status === 'approved') {
      const pw = await redis('GET', `buypw:${x.id}`);
      if (pw) out.password = pw; else if (x.topup === '1') out.topup = true;
    }
    if (x.status === 'rejected') out.reason = x.reason || '';
    return send(res, 200, out);
  }
  send(res, 400, { error: 'action' });
});
