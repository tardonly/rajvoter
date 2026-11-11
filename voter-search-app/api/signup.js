// Signing up with a mobile number on the login page.
// The page asks for the mobile number first ('lookup'). A number that already has a login of that village is told to
// type its password (forgotten → a one-time code to the number and a new password, 'otp' + 'reset', when OTP_SEND_URL
// is set; else ask the admin); a new number chooses its own password and gets its own login at once ('signup') with
// free searches by the superadmin's rule (freeRule in _lib.js: by how many signed up in that village before), none for a
// number that already signed up elsewhere. For more searches the person pays online in the app (api/pay.js).
//   POST {action: 'info'}  → {villages}   for the start page's village choice
//   POST {action: 'lookup', village (optional on the start page), phone [, ref]} → {exists, free, rule, otp, refBy}   ref: the
//     invite link's code (refInviter in _lib.js); refBy: the inviter's name, free then includes the referral bonus;   otp: a forgotten
//     password can be reset with a one-time code sent to the number (OTP_SEND_URL is set, see _lib.js)
//   POST {action: 'otp', village (optional), phone} → {sent: true}   sends the code for a password reset, only to a number
//     with a login (there); errors 'no_login', 'wait' (asked again within OTP.gap seconds, with wait = seconds left),
//     'too_many' (OTP.day codes today), 'otp_send' (the provider failed)
//   POST {action: 'reset', village (optional), phone, otp, password} → {ok}   the number's login (of that village; on the
//     start page an admin login first, else the newest) gets the password it chose; errors 'otp_wrong' | 'otp_expired' |
//     'otp_tries', 'pw_short', 'pw_taken'. The page then logs in with it (api/unlock.js)
//   POST {action: 'password', token, village, password} → {ok}   a logged-in person chooses a new password (पासवर्ड बदलें)
//   POST {action: 'signup', village, phone, name, password [, ref]} → {password, token, name, phone, villages, list, perms,
//     prepaid, left, adminPhone, ref}   ref (answer): this login's own invite code and reward (refFor in _lib.js)   password: the one the person chose (setOwnPassword in _lib.js)
//   POST {action: 'move', token, village, to} → {village, list, movesLeft}   a signed-up login picked the wrong village:
//     it moves itself to village "to" (its searches and password go along, it stays logged in), up to MOVES times; after
//     that its admin moves it (api/_routes/admin.js "move")
//   POST {action: 'coupon', token, village, code} → {coupon: {code, kind, value, minN}} or {error: 'cpn_…'}
//   POST {action: 'coupons', token, village} → {coupons: [{code, kind, value, minN, maxN, until, first}]}   the coupons the
//     superadmin lists in the buy window (show) that this login can use now, best first
//   POST {action: 'mark_mode', token, village, mode: 'survey' | 'poll'} → {survey}   this person's own choice of marks
//     (सर्वे / मतदान दिवस, markModeOf in _lib.js), until the superadmin next switches everyone
// 10 lookups / sign-ups per internet address in 15 minutes, and 3 sign-ups a day.
// Keys: set "free" (signed-up logins not yet given paid searches), "signups:<ip>:<day>" → sign-ups today from there.
const { buyVillage, getCoupon, couponHold, selfCount, afterMove, couponFor, couponPrice, couponView, refRule, refFor, refInviter, PACKS, adminFor, newReqId, getReq, whoIs, canBuy, payOnline, freeRule, freeFor, freeLeft, takeFree, pipeline, phoneLogins, adminPhone, village, villageList, normPhone, OTP, otpOn, newOtp, checkOtp, badOwnPassword, ownPwHash, setOwnPassword, getUser, newLogin, today, clientIp, redis, newSession, makeToken,
  deviceName, permsOf, movesLeft, blocked, failed, send, route } = require('./_lib.js');

const SIGNUPS_PER_DAY = 3;   // per internet address


// free searches for a new login in this village: freeFor(rule, logins made by signing up there so far, retired ones
// too: selfcount in _lib.js), none if this number signed up before; plus the referral bonus (refRule in _lib.js) when it
// came through a friend's link (ref: the inviter). The village's cap (rule.cap) can make it less; take: this is the
// sign-up itself, so the searches are counted against the cap (takeFree), otherwise only looked at (lookup).
async function freeSearches(phone, slug, rule, ref, take) {
  if ((await phoneLogins(phone)).some((u) => u.self === '1')) return 0;
  rule = rule || await freeRule();
  const rr = ref ? await refRule() : null, want = freeFor(rule, await selfCount(slug));
  return (take ? await takeFree(slug, rule, want) : await freeLeft(slug, rule, want)) + (rr && rr.on ? rr.joiner : 0);
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
    const rule = await freeRule(), inv = await refInviter(b.ref, phone);
    const mine = (await phoneLogins(phone)).filter((u) => u.retired !== '1' && (!v || u.villages.includes(v.slug)));
    return send(res, 200, { exists: mine.length > 0, free: mine.length ? 0 : v ? await freeSearches(phone, v.slug, rule, inv) : null, rule, otp: otpOn(),
      refBy: inv && !mine.length ? inv.name : '' });
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
    const inv = await refInviter(b.ref, phone);   // came through a friend's invite link
    const free = await freeSearches(phone, v.slug, null, inv, true);
    const { id } = await newLogin(['role', 'user', 'village', v.slug, 'credits', free, 'self', '1', ...(inv ? ['refBy', inv.id, 'refByName', inv.name] : [])],
      name, phone, 'self', '');
    await redis('INCR', `selfcount:${v.slug}`);   // this village's sign-ups (freeSearches)
    await setOwnPassword(await getUser(id), b.password);   // instead of the made-up one
    const password = String(b.password).trim();
    await redis('SADD', 'free', id);
    const sid = newSession(), now = new Date().toISOString();
    await redis('HSET', `user:${id}`, 'session', sid, 'sessionAt', now, 'sessionIp', clientIp(req), 'sessionDevice', deviceName(req),
      'lastSeen', now, 'logins', 1);
    return send(res, 200, { password, token: makeToken(id, sid), name, phone, role: 'user', admin: false, villages: [v.slug],
      list: villageList([v.slug]), perms: permsOf({}), prepaid: true, canBuy: true, online: payOnline(), left: free, movesLeft: movesLeft({ role: 'user', self: '1' }),
      adminPhone: await adminPhone({ village: v.slug }), ref: await refFor({ id, role: 'user' }) });
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
    await afterMove(me, me.village, v.slug);   // its open requests go along, to the new village's admin
    return send(res, 200, { village: v.slug, list: villageList([v.slug]), movesLeft: movesLeft(me) - 1 });
  }
  if (b.action === 'mark_mode') {   // सर्वे / मतदान दिवस: which marks this person uses (markModeOf in _lib.js)
    const me = await whoIs(b.token, b.village);
    if (!me || me.status !== 'ok' || me.demo) return send(res, 401, { error: 'login' });
    if (me.role === 'super') return send(res, 403, { error: 'super_only' });   // the superadmin: on the admin page, for everyone
    if (b.mode !== 'survey' && b.mode !== 'poll') return send(res, 400, { error: 'bad_mark' });
    await redis('HSET', `user:${me.id}`, 'markmode', b.mode, 'markmodeAt', new Date().toISOString());
    return send(res, 200, { survey: b.mode === 'survey' });
  }
  if (b.action === 'coupons') {   // the buy window's list of coupons to tap, and the app's coupon banners (banner: true)
    const me = await whoIs(b.token, b.village);
    if (!me || me.status !== 'ok') return send(res, 401, { error: 'login' });
    if (!canBuy(me)) return send(res, 200, { coupons: [] });
    const codes = (await redis('SMEMBERS', 'coupons')) || [];
    const all = (await Promise.all(codes.map(getCoupon))).filter((c) => c && (c.show || c.banner));
    const fits = (await Promise.all(all.map((c) => couponFor(c.code, me)))).filter((r) => r.c).map((r) => r.c);
    const worth = (c) => couponPrice(c, c.maxN || 1000);   // best first: the most off (or the most extra) on the biggest pack it takes
    fits.sort((x, y) => (worth(x).rs - worth(y).rs) || (worth(y).bonus - worth(x).bonus));
    return send(res, 200, { coupons: fits.slice(0, 10).map(couponView) });
  }
  if (b.action === 'coupon') {   // the buy window's "कूपन लागू करें": is this code good for this login?
    const me = await whoIs(b.token, b.village);
    if (!me || me.status !== 'ok') return send(res, 401, { error: 'login' });
    if (await blocked(req, 'coupon')) return send(res, 429, { error: 'too_many' });
    const r = await couponFor(b.code, me);
    if (r.error) { if (r.error === 'cpn_none') await failed(req, 'coupon'); return send(res, 400, r); }
    return send(res, 200, { coupon: couponView(r.c) });
  }
  send(res, 400, { error: 'action' });
});
