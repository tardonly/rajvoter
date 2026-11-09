// Signing up with a mobile number on the login page.
// The page asks for the mobile number first ('lookup'). A number that already has a login of that village is told to
// type its password (forgotten → a one-time code to the number and a new password, 'otp' + 'reset', when OTP_SEND_URL
// is set; else ask the admin); a new number chooses its own password and gets its own login at once ('signup') with
// free searches by the superadmin's rule (freeRule in _lib.js: by how many signed up in that village before), none for a
// number that already signed up elsewhere. For more searches the person pays their village admin (WhatsApp button in the app goes to that admin's number) and
// an admin adds them on the admin page (api/admin.js "credits_add").
//   POST {action: 'info'}  → {villages}   for the start page's village choice
//   POST {action: 'lookup', village (optional on the start page), phone} → {exists, free, rule, otp}   otp: a forgotten
//     password can be reset with a one-time code sent to the number (OTP_SEND_URL is set, see _lib.js)
//   POST {action: 'otp', village (optional), phone} → {sent: true}   sends the code for a password reset, only to a number
//     with a login (there); errors 'no_login', 'wait' (asked again within OTP.gap seconds, with wait = seconds left),
//     'too_many' (OTP.day codes today), 'otp_send' (the provider failed)
//   POST {action: 'reset', village (optional), phone, otp, password} → {ok}   the number's login (of that village; on the
//     start page an admin login first, else the newest) gets the password it chose; errors 'otp_wrong' | 'otp_expired' |
//     'otp_tries', 'pw_short', 'pw_taken'. The page then logs in with it (api/unlock.js)
//   POST {action: 'password', token, village, password} → {ok}   a logged-in person chooses a new password (पासवर्ड बदलें)
//   POST {action: 'signup', village, phone, name, password} → {password, token, name, phone, villages, list, perms,
//     prepaid, left, adminPhone}   password: the one the person chose (setOwnPassword in _lib.js)
//   POST {action: 'move', token, village, to} → {village, list, movesLeft}   a signed-up login picked the wrong village:
//     it moves itself to village "to" (its searches and password go along, it stays logged in), up to MOVES times; after
//     that its admin moves it (api/admin.js "move")
//   POST {action: 'request', token, village, n} → {id, phone}   any user login (signed up or made by an admin) asks for a pack of n searches (PACKS in
//     _lib.js): the request is kept (req:<id>, see getReq) with to = the admin it goes to (adminFor in _lib.js), and its
//     id goes in the WhatsApp message to phone ('' = the app's own number) as <site>/<id>; the person's open request for
//     the same pack is reused. 20 new requests a day per login.
// 10 lookups / sign-ups per internet address in 15 minutes, and 3 sign-ups a day.
// Keys: set "free" (signed-up logins not yet given paid searches), "signups:<ip>:<day>" → sign-ups today from there.
const { PACKS, adminFor, newReqId, getReq, whoIs, canBuy, payOnline, freeRule, freeFor, pipeline, phoneLogins, adminPhone, village, villageList, normPhone, OTP, otpOn, newOtp, checkOtp, badOwnPassword, ownPwHash, setOwnPassword, getUser, newLogin, today, clientIp, redis, newSession, makeToken,
  deviceName, permsOf, movesLeft, blocked, failed, send, route } = require('./_lib.js');

const SIGNUPS_PER_DAY = 3;   // per internet address


// free searches for a new login in this village: freeFor(rule, logins made by signing up there so far, retired ones
// too), none if this number signed up before
async function freeSearches(phone, slug, rule) {
  const ids = (await redis('SMEMBERS', 'users')) || [];
  const rows = ids.length ? await pipeline(ids.map((id) => ['HMGET', `user:${id}`, 'phone', 'village', 'self'])) : [];
  let n = 0;
  for (const [ph, vil, self] of rows) {
    if (self !== '1') continue;
    if (ph === phone) return 0;
    if (vil === slug) n++;
  }
  return freeFor(rule || await freeRule(), n);
}
const realVillage = (s) => { const v = village(s); return v && !v.demo ? v : null; };
// the login a password reset is for: this number's active login of that village; without a village (the start page) an
// admin login first, else the newest
async function resetLogin(phone, slug) {
  const v = slug ? realVillage(slug) : null;
  if (slug && !v) return null;
  const ids = (await phoneLogins(phone)).filter((u) => u.retired !== '1' && (!v || u.villages.includes(v.slug))).map((u) => u.id);
  const all = (await Promise.all(ids.map(getUser))).filter(Boolean)
    .sort((a, b) => (a.role === 'admin') !== (b.role === 'admin') ? (a.role === 'admin' ? -1 : 1) : a.created < b.created ? 1 : -1);
  return all[0] || null;
}

module.exports = route(async (req, res, b) => {
  if (b.action === 'info') return send(res, 200, { villages: villageList() });

  if (b.action === 'lookup') {
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    const v = b.village ? realVillage(b.village) : null;
    if (b.village && !v) return send(res, 404, { error: 'no_village' });
    await failed(req, 'lookup');
    const rule = await freeRule();
    const mine = (await phoneLogins(phone)).filter((u) => u.retired !== '1' && (!v || u.villages.includes(v.slug)));
    return send(res, 200, { exists: mine.length > 0, free: mine.length ? 0 : v ? await freeSearches(phone, v.slug, rule) : null, rule, otp: otpOn() });
  }

  if (b.action === 'otp') {
    if (!otpOn()) return send(res, 400, { error: 'no_otp' });
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    await failed(req, 'lookup');   // each code sent counts toward this address's 10 tries in 15 minutes
    if (!(await resetLogin(phone, b.village))) return send(res, 404, { error: 'no_login' });
    const err = await newOtp(phone);
    if (err === 'wait') return send(res, 429, { error: 'wait', wait: OTP.gap });
    if (err) return send(res, err === 'too_many' ? 429 : 502, { error: err });
    return send(res, 200, { sent: true });
  }

  if (b.action === 'signup') {
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const v = realVillage(b.village);
    if (!v) return send(res, 400, { error: 'no_village' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    if (badOwnPassword(b.password)) return send(res, 400, { error: 'pw_short' });
    if ((await phoneLogins(phone)).some((u) => u.retired !== '1' && u.villages.includes(v.slug))) return send(res, 409, { error: 'exists' });
    if (await redis('GET', `pw:${ownPwHash(phone, b.password)}`)) return send(res, 409, { error: 'pw_taken' });   // this number's other login
    const k = `signups:${clientIp(req)}:${today()}`, n = await redis('INCR', k);
    await redis('EXPIRE', k, 86400);
    if (n > SIGNUPS_PER_DAY) return send(res, 429, { error: 'too_many' });
    const free = await freeSearches(phone, v.slug);
    const { id } = await newLogin(['role', 'user', 'village', v.slug, 'credits', free, 'self', '1'], name, phone, 'self', '');
    await setOwnPassword(await getUser(id), b.password);   // instead of the made-up one
    const password = String(b.password).trim();
    await redis('SADD', 'free', id);
    const sid = newSession(), now = new Date().toISOString();
    await redis('HSET', `user:${id}`, 'session', sid, 'sessionAt', now, 'sessionIp', clientIp(req), 'sessionDevice', deviceName(req),
      'lastSeen', now, 'logins', 1);
    return send(res, 200, { password, token: makeToken(id, sid), name, phone, role: 'user', admin: false, villages: [v.slug],
      list: villageList([v.slug]), perms: permsOf({}), prepaid: true, canBuy: true, online: payOnline(), left: free, movesLeft: movesLeft({ role: 'user', self: '1' }),
      adminPhone: await adminPhone({ village: v.slug }) });
  }
  if (b.action === 'reset') {   // forgotten password: the code sent to the number, then the new password
    if (!otpOn()) return send(res, 400, { error: 'no_otp' });
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    if (badOwnPassword(b.password)) return send(res, 400, { error: 'pw_short' });
    const u = await resetLogin(phone, b.village);
    if (!u) return send(res, 404, { error: 'no_login' });
    const bad = await checkOtp(phone, b.otp);
    if (bad) { await failed(req, 'lookup'); return send(res, 400, { error: bad }); }
    const err = await setOwnPassword(u, b.password);
    if (err) return send(res, 400, { error: err });
    await redis('HSET', `user:${u.id}`, 'session', '');   // a phone still logged in with the old password is logged out
    return send(res, 200, { ok: true });
  }
  if (b.action === 'password') {   // पासवर्ड बदलें: a logged-in person's own choice
    const me = await whoIs(b.token, b.village);
    if (!me || me.status !== 'ok' || me.demo) return send(res, 401, { error: 'login' });
    const err = await setOwnPassword(me, b.password);
    if (err) return send(res, 400, { error: err });
    return send(res, 200, { ok: true });
  }
  if (b.action === 'move') {
    const me = await whoIs(b.token, b.village);
    if (!me || me.status !== 'ok') return send(res, 401, { error: 'login' });
    if (!movesLeft(me)) return send(res, 403, { error: 'no_moves' });
    const v = realVillage(b.to);
    if (!v) return send(res, 400, { error: 'no_village' });
    if (v.slug === me.village) return send(res, 400, { error: 'same_village' });
    if ((await phoneLogins(me.phone)).some((u) => u.id !== me.id && u.retired !== '1' && u.villages.includes(v.slug))) return send(res, 409, { error: 'exists' });
    await redis('HSET', `user:${me.id}`, 'village', v.slug, 'cand', '', 'moves', (Number(me.moves) || 0) + 1);
    return send(res, 200, { village: v.slug, list: villageList([v.slug]), movesLeft: movesLeft(me) - 1 });
  }
  if (b.action === 'request') {
    const me = await whoIs(b.token, b.village);
    if (!me || me.status !== 'ok') return send(res, 401, { error: 'login' });
    if (!canBuy(me)) return send(res, 400, { error: 'not_prepaid' });
    const pk = PACKS.find(([n]) => n === Number(b.n));
    if (!pk) return send(res, 400, { error: 'bad_credits' });
    const openKey = `reqopen:${me.id}:${pk[0]}`, old = await getReq(await redis('GET', openKey));
    const to = await adminFor(me);
    if (old && old.status === 'open' && old.user === me.id) {
      if (old.to !== to.id) await redis('HSET', `req:${old.id}`, 'to', to.id);   // e.g. their admin has changed since
      return send(res, 200, { id: old.id, phone: to.phone });
    }
    const k = `reqs:${me.id}:${today()}`;
    if (await redis('INCR', k) > 20) return send(res, 429, { error: 'too_many' });
    await redis('EXPIRE', k, 86400);
    const id = await newReqId();
    await redis('HSET', `req:${id}`, 'user', me.id, 'village', me.village, 'n', pk[0], 'rs', pk[1], 'created', new Date().toISOString(), 'status', 'open',
      'to', to.id);
    await redis('SET', openKey, id);
    await redis('SADD', 'reqs', id);   // every request, for the admin page's list (api/admin.js "list")
    return send(res, 200, { id, phone: to.phone });
  }
  send(res, 400, { error: 'action' });
});
