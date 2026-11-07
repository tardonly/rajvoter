// Signing up with a mobile number, and buying searches with UPI without a payment gateway. ₹1 per search, in the packs
// of PACKS (_lib.js).
// Sign-up: the login page asks for the mobile number first ('lookup'). A number that already has a login of that village
// is told to type its password (forgotten → ask the admin); a new number gets its own login at once ('signup') with a
// few free searches: FREE_TIERS (_lib.js) by how many signed-up logins have not bought anything yet, and none for a
// number that already signed up elsewhere. After that the person buys searches.
// Buying (needs that login's token): the buyer pays the UPI ID in the UPI_ID environment variable (payee name UPI_NAME,
// default "Voter Search"), types the payment's UTR (the 12-digit number every UPI payment shows) and gets TRIAL of the
// searches at once; the superadmin checks the money arrived with that UTR on the admin page (api/admin.js, actions
// "buys" / "buy_approve" / "buy_reject"): approving adds the rest, rejecting takes the trial back. Buying is off until
// UPI_ID is set.
//   POST {action: 'info'}  → {upi, payee, packs, trial, villages}
//   POST {action: 'lookup', village (optional on the start page), phone} → {exists, free}
//   POST {action: 'signup', village, phone, name} → {password, token, name, villages, list, perms, prepaid, left}
//   POST {action: 'request', token, amount, utr} → {id, key, trial}   key = the buyer's secret for 'status'
//   POST {action: 'status', id, key} → {status: 'pending' | 'approved' | 'rejected', village, amount, name, utr, at,
//     trial, reason (when rejected)}
//   POST {action: 'auto', key, payments: [{utr, amount}]} → {results: [{utr, result}]}   payments seen in the payment
//     emails of the UPI account (app-build/payment-emails.gs, a Google Apps Script on that Gmail); key = the
//     AUTO_APPROVE_KEY environment variable. A request with that UTR and the same amount is approved at once
//     (result 'approved'), also when the buyer sends the UTR after the email came; a different amount is left for
//     the superadmin ('amount_differs'); 'waiting' = no request with that UTR yet. Off until AUTO_APPROVE_KEY is set.
// A UTR can be used once (a rejected request frees it). 10 requests / lookups per internet address in 15 minutes;
// 3 sign-ups and 3 trials per internet address a day.
// Keys: "buy:<id>" (hash: village, name, phone, amount, utr, at, status, keyHash, userId, trial, reason, decidedAt,
// decidedBy ('email' when approved by a payment email), paidAmount (from the email)), set "buys" (all ids),
// "utr:<utr>" → id, "utrpaid:<utr>" → amount seen in a payment email (7 days), set "free" (signed-up logins that have
// not bought yet),
// "signups:<ip>:<day>" / "trials:<ip>:<day>" → how many today from that address.
const crypto = require('crypto');
const { PACKS, FREE_TIERS, isPrepaid, phoneLogins, village, villageList, normPhone, newLogin, today, clientIp, redis,
  newSession, makeToken, deviceName, permsOf, whoIs, sameText, blocked, failed, send, route } = require('./_lib.js');
const { getBuy, emailPaid } = require('./_buy.js');

const TRIAL = 10;          // searches a buyer may start at once, before the superadmin has checked the payment
const PER_DAY = 3;         // sign-ups, and trials, per internet address a day

const upiId = () => String(process.env.UPI_ID || '').trim();
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
async function perDay(req, kind) {   // counts one more of this kind from this address today → still allowed?
  const k = `${kind}:${clientIp(req)}:${today()}`, n = await redis('INCR', k);
  await redis('EXPIRE', k, 86400);
  return n <= PER_DAY;
}
// free searches for a new login: by how many signed-up logins have not bought yet; none if this number signed up before
async function freeSearches(phone) {
  if ((await phoneLogins(phone)).some((u) => u.self === '1')) return 0;
  const n = Number(await redis('SCARD', 'free')) || 0;
  const tier = FREE_TIERS.find((t) => n < t.upTo);
  return tier ? tier.searches : 0;
}
const realVillage = (s) => { const v = village(s); return v && !v.demo ? v : null; };

module.exports = route(async (req, res, b) => {
  if (b.action === 'info') {
    return send(res, 200, { upi: upiId(), payee: String(process.env.UPI_NAME || 'Voter Search').trim(), packs: PACKS, trial: TRIAL,
      villages: villageList() });
  }

  if (b.action === 'lookup') {
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    const v = b.village ? realVillage(b.village) : null;
    if (b.village && !v) return send(res, 404, { error: 'no_village' });
    await failed(req, 'lookup');
    const mine = (await phoneLogins(phone)).filter((u) => u.retired !== '1' && (!v || u.villages.includes(v.slug)));
    return send(res, 200, { exists: mine.length > 0, free: mine.length ? 0 : await freeSearches(phone) });
  }

  if (b.action === 'signup') {
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const v = realVillage(b.village);
    if (!v) return send(res, 400, { error: 'no_village' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    if ((await phoneLogins(phone)).some((u) => u.retired !== '1' && u.villages.includes(v.slug))) return send(res, 409, { error: 'exists' });
    if (!(await perDay(req, 'signups'))) return send(res, 429, { error: 'too_many' });
    const free = await freeSearches(phone);
    const { id, password } = await newLogin(['role', 'user', 'village', v.slug, 'credits', free, 'self', '1'], name, phone, 'self', '');
    await redis('SADD', 'free', id);
    const sid = newSession(), now = new Date().toISOString();
    await redis('HSET', `user:${id}`, 'session', sid, 'sessionAt', now, 'sessionIp', clientIp(req), 'sessionDevice', deviceName(req),
      'lastSeen', now, 'logins', 1);
    return send(res, 200, { password, token: makeToken(id, sid), name, phone, role: 'user', admin: false, villages: [v.slug],
      list: villageList([v.slug]), perms: permsOf({}), prepaid: true, left: free });
  }

  if (b.action === 'request') {
    if (!upiId()) return send(res, 403, { error: 'buy_off' });
    if (await blocked(req, 'buy')) return send(res, 429, { error: 'too_many' });
    const user = await whoIs(b.token);
    if (!user || user.status !== 'ok') return send(res, 401, { error: user ? user.status : 'login' });
    if (!isPrepaid(user)) return send(res, 403, { error: 'not_prepaid' });   // admins and daily-limit users don't buy
    const amount = Number(b.amount);
    if (!PACKS.includes(amount)) return send(res, 400, { error: 'amount' });
    const utr = String(b.utr || '').replace(/\s/g, '');
    if (!/^\d{12}$/.test(utr)) return send(res, 400, { error: 'utr' });
    await failed(req, 'buy');   // counts every request, so one address can't flood the list
    const id = crypto.randomBytes(5).toString('hex'), key = crypto.randomBytes(12).toString('base64url');
    if (!(await redis('SET', `utr:${utr}`, id, 'NX'))) return send(res, 409, { error: 'utr_used' });
    const trial = (await perDay(req, 'trials')) ? Math.min(TRIAL, amount) : 0;
    await redis('HSET', `buy:${id}`, 'village', user.village, 'name', user.name, 'phone', user.phone || '', 'amount', amount,
      'utr', utr, 'at', new Date().toISOString(), 'status', 'pending', 'keyHash', hashKey(key), 'userId', user.id, 'trial', trial);
    await redis('SADD', 'buys', id);
    if (trial) await redis('HINCRBY', `user:${user.id}`, 'credits', trial);
    const paid = await redis('GET', `utrpaid:${utr}`);   // the payment email came before the buyer typed the UTR
    const result = paid ? await emailPaid(await getBuy(id), paid) : '';
    return send(res, 200, { id, key, trial, approved: result === 'approved' });
  }

  if (b.action === 'auto') {
    const secret = String(process.env.AUTO_APPROVE_KEY || '').trim();
    if (await blocked(req, 'auto')) return send(res, 429, { error: 'too_many' });
    if (!secret || !sameText(String(b.key || ''), secret)) {
      await failed(req, 'auto');
      return send(res, 401, { error: 'wrong' });
    }
    const results = [];
    for (const p of (Array.isArray(b.payments) ? b.payments : []).slice(0, 50)) {
      const utr = String((p && p.utr) || '').replace(/\D/g, ''), amount = Number(p && p.amount);
      if (!/^\d{12}$/.test(utr) || !(amount > 0)) { results.push({ utr, result: 'bad' }); continue; }
      await redis('SET', `utrpaid:${utr}`, amount, 'EX', 7 * 86400);
      const x = await getBuy(await redis('GET', `utr:${utr}`));
      results.push({ utr, result: x ? await emailPaid(x, amount) : 'waiting' });
    }
    return send(res, 200, { results });
  }

  if (b.action === 'status') {
    const x = await getBuy(b.id);
    if (!x || !b.key || hashKey(b.key) !== x.keyHash) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { status: x.status, village: x.village, amount: Number(x.amount), name: x.name, utr: x.utr, at: x.at,
      trial: Number(x.trial) || 0, ...(x.status === 'rejected' ? { reason: x.reason || '' } : {}) });
  }
  send(res, 400, { error: 'action' });
});
