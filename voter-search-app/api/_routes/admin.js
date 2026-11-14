// POST {token, action, ...}   token = from logging in (api/unlock) as the superadmin or a village admin
// The superadmin manages everything. A village admin sees and manages users of their assigned villages as the superadmin
// allows (ADMIN_PERMS in _lib.js, field "aperms"): 'own' the users they made, 'all' every user there; 'add' new users.
// Without the permission → 'no_perm'. Nobody adds searches by hand: they come only from free sign-up searches, invites
// and coupons, and from paying online through Razorpay (api/pay.js).
//   action "list" [, village]          → {me: {id, role, name, villages}, users: [...], admins: [...] (superadmin only), …}
//                                         quick (no voter files read): users carry perms, searchesToday, limit (today's,
//                                         with any extra), ownLimit ('' = default) and extraToday
//   action "reqs"                      → {reqs}   superadmin: online purchases (the 🔔), asked for after "list"
//   action "settings"                  → {freeRule, refRule, coupons}   superadmin, when one of those tabs opens
//   action "stats" [, all: n] [, only: 'marked'] (only: just {marked, survey}, no voter files read)
//   action "stats" [, all: n]          → {progress, marked: {id: slips marked}, partial, groups, survey}   the slow part,
//                                         asked for after "list": progress per ward (only groups with marks when there
//                                         are more than STATS_ALL, else the first n groups, those with marks first) and how many slips each person marked
//   action "add", village, name, phone [, cand, more, areas] → {user, password}   new user of one village (must be one of
//                                         the admin's villages); more: [slug, ...] extra villages they open too, areas:
//                                         whole ZP / PS wards ["zp:<district>|<zp>" | "ps:<district>|<samiti>|<ps>", ...]
//                                         (userVillages in _lib.js); more and areas: superadmin only
//   action "user_villages", id, more, areas → {user}   change a user's extra villages (as in "add"; superadmin only)
//   action "add_admin", name, phone, villages: [slug, ...], samitis: ["<district>|<samiti>", ...] [, aperms] → {user, password}
//                                         (superadmin only; samitis = whole पंचायत समितियाँ, villages added there later too)
//   action "villages", id, villages, samitis               → {user}   change an admin's villages (superadmin only)
//   action "reset",  id [, password] → {user, password}   (new password for the same person; the old one stops working;
//                                         password: the superadmin's own choice instead of a made-up one, kept with the
//                                         person's number like one they chose (setOwnPassword in _lib.js); "add" and
//                                         "add_admin" take it too)
//   action "retire", id         → {ok}               (password stops working; the phone is logged out at once)
//   action "logout", id         → {ok}               (ends the person's current session; they can log in again)
//   action "phone",  id, phone  → {user [, password]} (add or change the person's WhatsApp number; "" removes it). A
//                                                       password the person chose works only with their old number
//                                                       (ownPwHash in _lib.js), so they then get a new made-up one, shown once
//   action "perms",  id, perms  → {user}             (what a user may do: any of PERMS in _lib.js; an admin's in the app:
//                                                       superadmin only)
//   action "aperms", id, aperms → {user}             what a village admin may do here (ADMIN_PERMS): the superadmin, or
//                                                       an admin with 'arights' on the admins they made (only powers they have)
//   action "gift", id, n        → {user}             n free searches for good to a signed-up user ('gift' or superadmin)
//   (an admin with 'admins' may also "add_admin" (their villages only), "promote", "villages" (within theirs), and
//    reset / retire / logout / phone the admins they made; with 'asearch', "limit" / "extra" on those admins)
//   action "promote", id        → {user}             superadmin: a user becomes a village admin of their village, same
//                                                       login and password, with PROMOTED_PERMS
//   ("limit" / "extra" on an admin: superadmin only; a village admin has no daily limit until one is set)
//   action "limit",  id, limit  → {user}             (searches a user may start per day; 0 or '' = the default)
//   action "extra",  id [, n]   → {user}             (n more searches, default 100, for today only)
//   action "clearMarks", village [, cand], status → {progress, …as "stats"}   (removes every 'done' | 'coming' | 'absent' mark of the
//                                         village (of that candidate's group), or 'all' of them; kept as a backup first)
//   action "restoreMarks", village [, cand]       → {progress}   (puts back the marks removed by the last clearMarks)
//   action "marked", village [, cand], status [, ward, offset] → {total, more, rows}   voters carrying a mark ('done' |
//                                         'coming' | 'absent') or none yet ('none'), in ward and box order, 100 at a time
//   action "cand_add", village, name → {cand}   new candidate (उम्मीदवार) of one village: a group of its users whose marks
//                                         only they see (see markHash in _lib.js)
//   action "cand_delete", cand       → {ok}     removes the candidate and its marks; its users go back to the village's marks
//   action "cand_set", id, cand      → {user}   puts a user of the candidate's village in that group ('' = no candidate)
//   action "party_set" [, party], name, icon → {party}   superadmin: adds a party (no party) or changes one: name and its
//                                         symbol, a small picture the admin page shrinks to a PNG/JPEG data URL ('' = none);
//                                         all of them in hash "parties" (id → JSON {name, icon, created})
//   action "party_del", party        → {ok}     superadmin: removes a party; candidates that had it show none
//   action "cand_party", cand, party → {cand}   which party a candidate stands for ('' = none); the superadmin or the
//                                               candidate's village admin. "list" gives parties [{id, name, icon}] and each
//                                               cand's party
//   action "move", id, village       → {user}   moves a user to another village (both must be the admin's): their
//                                               candidate is cleared and their phone is logged out
//   (reqs: every online purchase (api/pay.js), open ones first, plus those paid or closed in the last 30 days, each with
//    the person's name and phone; doneRs = ₹ paid. Older requests, from before searches could only be bought online, show
//    too until they are closed.)
//   action "req_get", rid            → {req}    superadmin: one purchase, asking Razorpay how its payment stands first
//   action "coupon_set", code, kind ('pct' | 'rs' | 'bonus' | 'bonuspct'), value, maxOff, minN, maxN, maxUses, until, once, first, on, show, note, banner, bannerText, isNew
//                                         → {coupon}   superadmin: a coupon (getCoupon in _lib.js); "list" gives coupons
//   action "coupon_del", code → {ok}      superadmin
//   action "coupon_uses"      → {summary: [{code, uses, people, rs, off, bonus, open, last}], rows: [{id, code, name, phone,
//                                         village, n, rs, off, bonus, at}] (latest 500), total}   superadmin: coupon
//                                         redemptions (paid purchases with doneCoupon); off = ₹ saved vs the pack's price,
//                                         bonus = free searches added, open = checkouts started with it but not paid
//   action "wd_paid", id [, utr] / "wd_back", id → {wd}   superadmin: a wallet's UPI withdrawal (wdStart in _lib.js) sent
//     by hand (with its UPI reference) / not sent, the ₹ back in the person's wallet; "settings" lists them (wds)
//   action "agent"               → {on, apct, packs, sales, agentSales, agentRs, agentCash}   a village admin (or the
//                                         superadmin, without reward) selling searches by UPI QR (agentReward in _lib.js):
//                                         whether online payment is set up, the admin's % and their latest 30 sales (set agentreqs:<admin id>)
//   action "agent_find", phone    → {person: {id, name, village}}   the active user login of that mobile number, only
//                                         among the people this admin looks after (as in "list"); else 'no_user'
//   action "agent_start", phone, n → {sale}   a purchase of pack n for that person, with a Razorpay UPI QR (razorpayQr)
//                                         to show them; 50 a day per admin. sale: {id, n, rs, status, name, phone, village,
//                                         created, closeBy, image (the QR picture), cash (the admin's ₹, once paid)}
//   action "agent_check", rid      → {sale}   asks Razorpay how it stands (settleOnline): paid → searches added, ₹ to the admin
//   action "ward_pay", on            → {wardPay}   superadmin: people pay ₹WARD_RS per ward's slips (true) or every ward is
//                                         free (false) (wardFree in _lib.js); "settings" gives wardPay and wardPayAreas
//   action "ward_cfg", rs, azRs, az, hnRs, hn → {wardCfg}   superadmin: ₹ a ward's slips, ₹ for name order and for
//                                         house-number order (1–WARD_RS_MAX), and whether each order is sold (wardCfg in _lib.js); "settings" gives wardCfg
//   action "ward_pay_area", kind ('d' | 's'), key (district | "<district>|<samiti>"), mode ('pay' | 'free' | '')
//                                      → {wardPayAreas}   superadmin: the same for one ज़िला / पंचायत समिति ('' = as above)
//   action "ward_pay_user", id, mode ('free' | 'pay' | '') → {user}   superadmin, or an admin with 'wardpay' on a user they look after: that person's own setting (user field
//                                         wardpay; '' = as for everyone); view's wardpay
//   action "ref_rule", on, pct, joiner, bonusAt, bonus, apct → {refRule}   superadmin: referral cashback (refRule in _lib.js); "list" gives
//                                         refRule to the superadmin
//   action "mark_mode", mode ('survey' | 'poll') → {survey}   the superadmin: which set of marks everyone uses from now on
//                                         (each person may switch back for themself); a village admin: their own choice
//                                         (markModeOf in _lib.js). "list" says what this admin uses as survey: true | false
//   action "free_rule", mode, people, searches, cap → {freeRule}   superadmin: free searches for sign-ups (freeRule in _lib.js):
//                                               mode 'direct' | 'halving', people 1–100000, searches 1–1000, cap (most in all
//                                               per village) 0–10000000, 0 = no limit; "settings" gives
//                                               freeRule to the superadmin
//   action "db_copy", cursor          → {next, keys, done}   superadmin: one step of moving people's data from Upstash
//                                               into USER_REDIS_URL (moveUserData in _lib.js); the admin page repeats it
//                                               from cursor '0' until next is '0'. "list" says dbCopy: 'todo' | 'done'
//                                               while both databases are set (key "usermoved" = when it finished)
//                                               With MONGODB_URI: copies everything from Upstash into MongoDB instead
//                                               (Upstash keeps its copy); "list" then also says dbTo: 'mongo'
//   action "req_reject", rid         → {req}    superadmin: closes an open purchase without searches (status 'rejected',
//                                               doneAt, doneByName = who closed it), e.g. a payment that never came
// progress: [{key, slug, cand, name, candName, marks: {done, coming, absent}, wards: [{ward, total, done, coming, absent}],
//   backup: {n, at} | null}]   one entry per village of this admin and per candidate of it (cand '' = the village's own
//   marks): how many slips carry each mark, overall and per ward.
// cands (in "list"): [{id, name, village, created}] the candidates of this admin's villages.
// The password is shown to the admin once; only its hash is stored.
// Phone numbers are stored as digits with the country code, e.g. 919876543210, ready for a wa.me link.
const crypto = require('crypto');
const { markSummary, markedList, candsOf, groupsOf } = require('../_progress.js');
const { wardPayOn, wardPayAreas, wardCfg, WARD_RS_MAX, PACKS, payOnline, razorpayQr, QR_MIN, getWd, wdView, wdOpen, wdBack, wdPaid, wdSettle, walletOf, candReach, areaSize, areaKeyOf, areaVillages, userVillages, COUPON_RE, couponCode, getCoupon, REF_MAX, REF_PCT_MAX, REF_AT_MAX, refRule, freeRule, buildIndexes, afterMove, hasOwnPassword, FREE_MAX, setOwnPassword, badOwnPassword, ownPwHash, appPerms, ADMIN_PERMS, OLD_ADMIN_PERMS, GIFT_MAX, PROMOTED_PERMS, adminPermsOf, adminLimited, village, villageList, samitiKeys, MARKS, PERMS, permsOf, allMarks, markHash, getCand, today, DAILY_SEARCHES, extraToday, dailyLimit, credits, isPrepaid, canBuy, packPrice, newReqId, getReq, addPaid, settleOnline, paidKey, normPhone, canMoveUserData, moveUserData, COPY_DONE, usesMongo, phoneLogins, redis, pipeline, pwHash, whoIs, freshPassword, newLogin: makeLogin, getUser, getUsers, marksFrom, blocked, failed,
  send, route } = require('../_lib.js');

// parties (पार्टी): hash "parties", id → JSON {name, icon, created}; icon a small PNG/JPEG data URL made by the admin page
const PARTY_ICON = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/, PARTY_ICON_MAX = 60 * 1024;
async function getParty(id) {
  if (!/^[0-9a-f]{8}$/.test(String(id || ''))) return null;
  const raw = await redis('HGET', 'parties', id);
  try { return raw ? { id, ...JSON.parse(raw) } : null; } catch { return null; }
}
async function allParties() {   // oldest first
  const flat = (await redis('HGETALL', 'parties')) || [], out = [];
  for (let i = 0; i < flat.length; i += 2) { try { out.push({ id: flat[i], ...JSON.parse(flat[i + 1]) }); } catch { /* skip a broken entry */ } }
  return out.sort((x, y) => (x.created < y.created ? -1 : 1)).map(({ id, name, icon }) => ({ id, name, icon: icon || '' }));
}

// admin permissions from the request → only known ones
const adminPermsIn = (list) => ADMIN_PERMS.filter((p) => Array.isArray(list) && list.includes(p));
// a village people and candidates can be added to: not a demo village ("demo-riri")
const realVillage = (s) => { const v = village(s); return v && !v.demo ? v : null; };
// list of village slugs from the request → only real villages, no repeats
const villageSlugs = (list) => [...new Set((Array.isArray(list) ? list : []).filter((s) => realVillage(s)))];
// list of whole पंचायत समितियाँ from the request ("<district>|<samiti>", see adminVillages in _lib.js) → only known ones
const samitiList = (list) => { const all = samitiKeys(); return [...new Set((Array.isArray(list) ? list : []).filter((k) => all.includes(k)))]; };
// how many villages each ZP / PS ward of these villages has in all (the admin page offers a ward whole only when every
// one of its villages is the admin's)
const areaSizes = (slugs) => Object.fromEntries(slugs.map(village).filter(Boolean)
  .flatMap((v) => ['zp', 'ps'].filter((k) => v[k] != null).map((k) => areaKeyOf(k, v))).map((k) => [k, areaSize(k)]));
// whole ZP / PS wards from the request (areaKeyOf in _lib.js) → only those with villages, no repeats
const areaList = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => /^(zp|ps):/.test(k) && areaVillages(k).length))];

const view = (u) => ({
  perms: appPerms(u), aperms: adminPermsOf(u), cand: u.role === 'user' ? u.cand || '' : '',
  // an admin without a limit from the superadmin: null (no limit)
  limit: u.role === 'user' || adminLimited(u) ? dailyLimit(u) : null, ownLimit: Number(u.limit) || '', extraToday: extraToday(u),
  defaultLimit: DAILY_SEARCHES,
  id: u.id, role: u.role, village: u.role === 'user' ? u.village || '' : '', villages: u.villages, name: u.name,
  ownVillages: u.ownVillages || [], samitis: u.samitis || [],   // an admin's: given one by one, and whole samitis
  more: u.more || [], areas: u.areas || [],   // a person's extra villages: one by one, and whole ZP / PS wards
  phone: u.phone || '', note: u.note || '', created: u.created, lastSeen: u.lastSeen || null,
  by: u.by || '', byName: u.byName || '', credits: credits(u), prepaid: isPrepaid(u), canBuy: canBuy(u), bought: u.bought === '1', self: u.self === '1',   // signed-up logins: credits = free + paid searches in all, bought = was given paid ones   // who made this login (admin id 'admin' = the superadmin); older logins: ''
  retired: u.retired === '1', retiredAt: u.retiredAt || null,
  wardpay: u.wardpay === 'free' || u.wardpay === 'pay' ? u.wardpay : '',   // ward slips: this person's own setting (wardFree in _lib.js)
  // referrals: who invited this login, and what this login's invites earned (refRule in _lib.js)
  refBy: u.refBy || '', refByName: u.refByName || '', refPaid: u.refPaid === '1', refBought: Number(u.refBought) || 0, refEarned: Number(u.refEarned) || 0,
  refCash: Number(u.refCash) || 0, refBonus: Number(u.refBonus) || 0, wallet: walletOf(u), walletOut: Number(u.walletOut) || 0,   // ₹: referral cashback earned, in the wallet now, taken out by UPI
  loggedIn: !!u.session && u.retired !== '1',
  sessionAt: u.sessionAt || null, sessionIp: u.sessionIp || null, sessionDevice: u.sessionDevice || null,
  logins: Number(u.logins || 0), kicks: Number(u.kicks || 0),
});

// a pack request as the admin page sees it
const reqView = ({ id, user, village: v, kind, ward, wv, n, rs, created, status, doneAt, doneN, doneRs, doneBy, doneByName, hand, gw, coupon, bonus, doneCoupon, agent, agentName, agentCash }) =>
  ({ id, user, agent: agent || '', agentName: agentName || '', agentCash: Number(agentCash) || 0, village: v, n: Number(n), rs: Number(rs), created, status, doneAt: doneAt || null, doneN: Number(doneN) || 0,
    doneRs: Number(doneRs) || 0, doneBy: doneBy || '', doneByName: doneByName || '', hand: hand === '1', online: !!gw,
    coupon: coupon || '', bonus: Number(bonus) || 0, doneCoupon: doneCoupon || '',
    ...(kind === 'ward' ? { kind, ward: Number(ward), wv: wv || v } : {}) });   // kind 'ward': a whole ward's slips (api/pay.js wardStart)   // online: paid by UPI through a gateway (gw)
const REQ_DONE_DAYS = 30;
const STATS_ALL = 30;   // "stats" gives every mark group's progress up to this many groups   // approved requests stay in the list this long

module.exports = route(async (req, res, b) => {
  if (!process.env.ADMIN_PASSWORD) return send(res, 500, { error: 'server', detail: 'ADMIN_PASSWORD not set' });
  if (await blocked(req, 'admin')) return send(res, 429, { error: 'too_many' });
  const me = await whoIs(b.token);
  if (!me || !me.admin) {
    await failed(req, 'admin');
    return send(res, 401, { error: 'wrong' });
  }
  if (me.status !== 'ok') return send(res, 403, { error: me.status });   // village admin retired or logged out
  const isSuper = me.role === 'super';
  const mayUse = (slug) => me.villages.includes(slug);
  // what this admin may do (ADMIN_PERMS in _lib.js; the superadmin everything), and whose users they see and look after:
  // 'all' every user of their villages, 'own' those they made
  const may = (p) => isSuper || me.aperms.includes(p);
  const mine = (u) => !!u && u.role === 'user' && (isSuper || (mayUse(u.village) && (may('all') || (may('own') && u.by === me.id))));
  // an admin this one made and still looks after ('admins'); the superadmin: every admin
  const mineAdmin = (u) => !!u && u.role === 'admin' && (isSuper || (may('admins') && u.by === me.id));
  // powers a non-super admin hands on: only ones they have; a target's other powers (given by the superadmin) are kept
  const grantable = (want, had = []) => (isSuper ? adminPermsIn(want)
    : ADMIN_PERMS.filter((p) => (me.aperms.includes(p) ? Array.isArray(want) && want.includes(p) : had.includes(p))));
  // villages / whole samitis a non-super admin may give an admin they make: only their own
  const ownSamitis = (ss) => isSuper || ss.every((k) => (me.samitis || []).includes(k));
  const ownVillages = (vs) => isSuper || vs.every((s) => mayUse(s));
  // a password the superadmin typed for a login (b.password): '' none, else an error code or null when it can be used
  const typedPw = () => String(b.password || '').trim();
  const badTypedPw = async (phone, id = '') => {
    const pw = typedPw();
    if (!isSuper) return 'super_only';
    if (badOwnPassword(pw)) return 'pw_short';
    if (!phone) return 'phone';   // it works only together with the mobile number
    const was = await redis('GET', `pw:${ownPwHash(phone, pw)}`);
    return was && was !== id ? 'pw_taken' : null;
  };
  const now = new Date().toISOString();
  // a new login made by this admin: fields = role and village(s) [and more]; → {id, password}
  const newLogin = (fields, name, phone) => makeLogin(fields, name, phone, me.id, me.name);
  // a person's extra villages from the request (b.more, b.areas) besides their own village home: → {more, areas, all} or
  // {error}. Only the superadmin gives them (a village admin's request may carry none).
  const extraVillages = (home) => {
    const more = villageSlugs(b.more).filter((s) => s !== home), areas = areaList(b.areas);
    if ((more.length || areas.length) && !isSuper) return { error: 'super_only' };
    return { more, areas, all: userVillages(home, more.join(','), areas.join(',')) };
  };

  // selling searches by UPI QR for someone else (agentReward in _lib.js; see the top of this file)
  const saleView = async (r) => {
    const u = await getUser(r.user) || {};
    return { id: r.id, n: Number(r.n), rs: Number(r.rs), status: r.status, name: u.name || '', phone: u.phone || '', village: r.village || '',
      created: r.created, closeBy: r.closeBy || '', image: r.status === 'open' ? r.qrimg || '' : '', cash: Number(r.agentCash) || 0, got: Number(r.doneN) || 0 };
  };
  const seller = me.role === 'admin' || isSuper;
  const personOf = async (raw) => {
    const ph = normPhone(raw);
    if (!ph) return null;
    // only a person this admin looks after (mine: the ones they made, or all of their villages' with 'all')
    const us = await getUsers((await phoneLogins(ph)).filter((x) => x.role === 'user' && x.retired !== '1').map((x) => x.id));
    return us.find((u) => canBuy(u) && u.retired !== '1' && mine(u)) || null;
  };
  if (b.action === 'agent') {
    if (!seller) return send(res, 403, { error: 'no_perm' });
    const ids = (await redis('SMEMBERS', `agentreqs:${me.id}`)) || [];
    const latest = (await Promise.all(ids.map(getReq))).filter(Boolean).sort((x, y) => (x.created < y.created ? 1 : -1)).slice(0, 30);
    const sales = await Promise.all(latest.map(saleView));
    const u = isSuper ? {} : await getUser(me.id);
    return send(res, 200, { on: payOnline(), apct: isSuper ? 0 : (await refRule()).apct, packs: PACKS, qrMin: QR_MIN, sales,
      agentSales: Number(u.agentSales) || 0, agentRs: Number(u.agentRs) || 0, agentCash: Number(u.agentCash) || 0 });
  }
  if (b.action === 'agent_find' || b.action === 'agent_start') {
    if (!seller) return send(res, 403, { error: 'no_perm' });
    const p = await personOf(b.phone);
    if (!p) return send(res, 404, { error: 'no_user' });
    if (b.action === 'agent_find') return send(res, 200, { person: { id: p.id, name: p.name || '', village: p.village || '' } });
    if (!payOnline()) return send(res, 400, { error: 'no_online' });
    const pk = PACKS.find(([k]) => k === Number(b.n));
    if (!pk) return send(res, 400, { error: 'bad_credits' });
    const k = `agentday:${me.id}:${today()}`;
    if (await redis('INCR', k) > 50) return send(res, 429, { error: 'too_many' });
    await redis('EXPIRE', k, 86400);
    const id = await newReqId();
    const q = await razorpayQr({ id, rs: pk[1], n: pk[0], who: p.name || '' });
    if (q.error) { console.error('razorpay qr', q.error, q.raw); return send(res, 502, { error: 'gateway', detail: q.error }); }
    await redis('HSET', `req:${id}`, 'user', p.id, 'village', p.village || '', 'n', pk[0], 'rs', pk[1], 'created', now, 'status', 'open',
      'to', 'admin', 'gw', 'razorpay', 'txn', q.txn, 'qrimg', q.image, 'closeBy', q.closeBy, 'agent', me.id, 'agentName', me.name || '');
    await redis('SET', `rzp:${q.txn}`, id);
    await redis('SADD', 'reqs', id);
    await redis('SADD', `agentreqs:${me.id}`, id);
    return send(res, 200, { sale: await saleView(await getReq(id)) });
  }
  if (b.action === 'agent_check') {
    const r = await getReq(b.rid);
    if (!r || r.agent !== me.id) return send(res, 404, { error: 'not_found' });
    return send(res, 200, { sale: await saleView(await settleOnline(r.id)) });
  }

  if (b.action === 'ward_pay') {   // superadmin: ward slips paid or free for everyone (wardFree in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    await redis('SET', 'wardpay', b.on ? '1' : '0');
    return send(res, 200, { wardPay: await wardPayOn() });
  }
  if (b.action === 'ward_cfg') {   // superadmin: ward slip prices and whether name / house-number order is sold (wardCfg in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const rs = parseInt(b.rs, 10), azRs = parseInt(b.azRs, 10), hnRs = parseInt(b.hnRs, 10), ok = (n) => n >= 1 && n <= WARD_RS_MAX;
    if (!ok(rs) || !ok(azRs) || !ok(hnRs)) return send(res, 400, { error: 'bad_price' });
    await redis('HSET', 'wardcfg', 'rs', String(rs), 'azrs', String(azRs), 'az', b.az ? '1' : '0', 'hnrs', String(hnRs), 'hn', b.hn ? '1' : '0');
    return send(res, 200, { wardCfg: await wardCfg() });
  }
  if (b.action === 'ward_pay_area') {   // superadmin: ward slips paid or free in one ज़िला or पंचायत समिति (wardFree in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const ok = b.kind === 'd' ? villageList().some((v) => v.district === b.key) : b.kind === 's' && samitiKeys().includes(b.key);
    if (!ok) return send(res, 400, { error: 'no_area' });
    const f = `${b.kind}:${b.key}`;
    if (b.mode === 'pay' || b.mode === 'free') await redis('HSET', 'wardpayarea', f, b.mode === 'pay' ? '1' : '0');
    else await redis('HDEL', 'wardpayarea', f);
    return send(res, 200, { wardPayAreas: await wardPayAreas() });
  }
  if (b.action === 'ref_rule') {   // superadmin: referrals (refRule in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const n = (v, max) => { const x = Math.floor(Number(v)); return v !== '' && v != null && x >= 0 && x <= max ? x : -1; };
    const apct = b.apct === undefined ? (await refRule()).apct : n(b.apct, REF_PCT_MAX);
    const pct = n(b.pct, REF_PCT_MAX), joiner = n(b.joiner, REF_MAX), bonusAt = n(b.bonusAt, REF_AT_MAX), bonus = n(b.bonus, REF_MAX);
    if (pct < 0 || joiner < 0 || bonusAt < 0 || bonus < 0 || apct < 0) return send(res, 400, { error: 'ref_rule' });
    await redis('HSET', 'refrule', 'on', b.on ? '1' : '0', 'pct', pct, 'apct', apct, 'joiner', joiner, 'bonusAt', bonusAt, 'bonus', bonus, 'at', now, 'by', me.id);
    return send(res, 200, { refRule: await refRule() });
  }
  if (b.action === 'coupon_set') {   // superadmin: make or change a coupon (getCoupon in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const code = couponCode(b.code), num = (v, max) => { const x = Math.floor(Number(v) || 0); return x >= 0 && x <= max ? x : -1; };
    const kind = ['pct', 'rs', 'bonus', 'bonuspct'].includes(b.kind) ? b.kind : '';
    const value = num(b.value, kind === 'pct' ? 99 : kind === 'bonuspct' ? 1000 : 10000), minN = num(b.minN, 10000), maxN = num(b.maxN, 10000), maxUses = num(b.maxUses, 1000000);
    const maxOff = kind === 'pct' || kind === 'bonuspct' ? num(b.maxOff, 1000000) : 0;   // the most ₹ off / extra searches, 0 = no limit
    const until = String(b.until || '');
    if (!COUPON_RE.test(code)) return send(res, 400, { error: 'cpn_code' });
    if (!kind || value < 1 || minN < 0 || maxN < 0 || (maxN && maxN < minN) || maxUses < 0 || maxOff < 0 || (until && !/^\d{4}-\d{2}-\d{2}$/.test(until))) return send(res, 400, { error: 'cpn_rule' });
    const old = await getCoupon(code);
    if (b.isNew && old) return send(res, 409, { error: 'cpn_exists' });
    await redis('HSET', `coupon:${code}`, 'kind', kind, 'value', value, 'maxOff', maxOff, 'minN', minN, 'maxN', maxN, 'maxUses', maxUses, 'until', until,
      'once', b.once ? '1' : '0', 'first', b.first ? '1' : '0', 'on', b.on ? '1' : '0', 'show', b.show ? '1' : '0', 'note', String(b.note || '').slice(0, 100),
      'banner', b.banner ? '1' : '0', 'bannerText', String(b.bannerText || '').trim().slice(0, 120),
      ...(old ? [] : ['used', 0, 'created', now]), 'at', now);
    await redis('SADD', 'coupons', code);
    return send(res, 200, { coupon: await getCoupon(code) });
  }
  if (b.action === 'coupon_del') {   // superadmin: delete a coupon; requests already made with it keep their price
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const code = couponCode(b.code);
    if (!COUPON_RE.test(code)) return send(res, 400, { error: 'cpn_code' });
    await redis('DEL', `coupon:${code}`, `cpnusers:${code}`);
    await redis('SREM', 'coupons', code);
    return send(res, 200, { ok: true });
  }
  if (b.action === 'mark_mode') {   // survey marks or polling-day marks (markModeOf in _lib.js)
    if (b.mode !== 'survey' && b.mode !== 'poll') return send(res, 400, { error: 'bad_mark' });
    if (!isSuper) return send(res, 403, { error: 'super_only' });   // only the superadmin, for everyone
    await pipeline([['SET', 'markmode', b.mode], ['SET', 'markmodeat', now]]);
    return send(res, 200, { survey: b.mode === 'survey' });
  }
  if (b.action === 'free_rule') {   // superadmin: free searches for sign-ups (freeRule in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const n = (v, max) => { const x = Math.floor(Number(v)); return x >= 1 && x <= max ? x : 0; };
    const mode = b.mode === 'halving' ? 'halving' : b.mode === 'direct' ? 'direct' : '';
    const people = n(b.people, FREE_MAX.people), searches = n(b.searches, FREE_MAX.searches);
    const cap = b.cap === undefined || b.cap === '' ? 0 : Math.floor(Number(b.cap));   // 0 = no limit
    if (!mode || !people || !searches || !(cap >= 0 && cap <= FREE_MAX.cap)) return send(res, 400, { error: 'free_rule' });
    await redis('HSET', 'freerule', 'mode', mode, 'people', people, 'searches', searches, 'cap', cap, 'at', now, 'by', me.id);
    return send(res, 200, { freeRule: await freeRule() });
  }
  if (b.action === 'db_copy') {
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    if (!canMoveUserData()) return send(res, 400, { error: 'no_db_copy' });
    const r = await moveUserData(b.cursor);
    if (r.next === '0') await redis('SET', COPY_DONE, now);
    return send(res, 200, { ...r, done: r.next === '0' });
  }

  // "stats": the slow part of the admin page, asked for after "list" has shown it: progress per ward (it reads each
  // village's voter file) and how many slips each person marked. Every village's marks and last-clear backup are read in
  // one round trip; with more than STATS_ALL groups (the superadmin has hundreds of villages) only the groups that have
  // marks, a backup or a candidate get a progress table (all: true asks for every one).
  const stats = async (all, onlyMarked) => {
    const cands = await candsOf(me.villages, true), groups = groupsOf(me.villages, cands);
    const read = groups.length ? await pipeline(groups.flatMap((g) => [['HGETALL', markHash(g.slug, g.cand.id, me.survey)], ['GET', `${markHash(g.slug, g.cand.id, me.survey)}:backup`]])) : [];
    const marksBy = groups.map((g, i) => marksFrom(read[2 * i]));
    const marked = {};
    for (const m of marksBy) for (const { byId } of Object.values(m)) if (byId) marked[byId] = (marked[byId] || 0) + 1;
    if (onlyMarked) return { marked, survey: me.survey };   // the person list's numbers: no voter files read
    // all: how many groups to give (a page of STATS_ALL more each time the page asks), those with marks first
    // a candidate shows in its own village even before any marks; in its workers' other villages only once marked there
    const busy = (i) => (groups[i].cand.id && groups[i].cand.village === groups[i].slug) || read[2 * i + 1] || Object.keys(marksBy[i]).length;
    const idx = groups.map((g, i) => i);
    const keep = groups.length <= STATS_ALL ? idx
      : all ? [...idx.filter(busy), ...idx.filter((i) => !busy(i))].slice(0, Math.max(STATS_ALL, all)).sort((x, y) => x - y)
      : idx.filter(busy);
    const progress = await Promise.all(keep.map((i) => markSummary(groups[i].slug, groups[i].cand, me.survey, marksBy[i], read[2 * i + 1])));
    return { progress, marked, partial: keep.length < groups.length, groups: groups.length, survey: me.survey };
  };
  if (b.action === 'stats') return send(res, 200, await stats(Math.min(10000, Math.max(0, parseInt(b.all, 10) || 0)), b.only === 'marked'));
  if (b.action === 'list') {   // quick: what the person list needs (requests: "reqs"; tab settings: "settings")
    const [ids, cands, moved, parties] = await Promise.all([
      redis('SMEMBERS', 'users').then((x) => x || []),
      candsOf(me.villages),
      isSuper && canMoveUserData() ? redis('GET', COPY_DONE) : null,
      allParties()]);
    let all = (await getUsers(ids)).sort((x, y) => (x.created < y.created ? 1 : -1));
    if (!isSuper) {   // a village admin never sees another admin (but the ones they made), nor an admin's person login
      const adminPhones = new Set(all.filter((u) => u.role === 'admin' && u.phone).map((u) => u.phone));
      all = all.filter((u) => mineAdmin(u) || !(u.phone && adminPhones.has(u.phone)));
    }
    const shown = all.filter((u) => (mine(u) && (!b.village || u.village === b.village)) || mineAdmin(u));
    const day = today();
    const buyers = shown.filter((u) => isPrepaid(u) || credits(u) > 0);
    const counts = shown.length ? await pipeline([...shown.map((u) => ['GET', `searches:${u.id}:${day}`]), ...buyers.map((u) => ['GET', paidKey(u.id)])]) : [];
    const searches = Object.fromEntries(shown.map((u, i) => [u.id, Number(counts[i]) || 0]));
    const paid = Object.fromEntries(buyers.map((u, i) => [u.id, Number(counts[shown.length + i]) || 0]));
    const withUse = (u) => ({ ...view(u), searchesToday: searches[u.id] || 0, paidUsed: paid[u.id] || 0 });
    const users = shown.filter((u) => mine(u) && (!b.village || u.village === b.village)).map(withUse);
    const admins = isSuper || may('admins') ? shown.filter((u) => u.role === 'admin').map(withUse) : undefined;
    const dbCopy = isSuper && canMoveUserData() ? (moved ? 'done' : 'todo') : undefined;
    return send(res, 200, { dbCopy, dbTo: dbCopy && usesMongo ? 'mongo' : undefined, survey: me.survey, me: { id: me.id, role: me.role, name: me.name, villages: me.villages, samitis: isSuper ? [] : me.samitis || [], aperms: isSuper ? ADMIN_PERMS.slice() : me.aperms }, users, admins,
      villageList: villageList(me.villages), areaSize: areaSizes(me.villages), parties,
      cands: cands.map(({ id, name, village: v, created, party }) => ({ id, name, village: v, created, party: party || '' })) });
      // villageList: names of my villages (the list is not public)
  }
  if (b.action === 'settings') {   // superadmin, when a settings tab opens: free searches, referrals, coupons
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const [free, ref, codes, wdIds] = await Promise.all([freeRule(), refRule(), redis('SMEMBERS', 'coupons'), redis('SMEMBERS', 'wds')]);
    const coupons = (await Promise.all((codes || []).map(getCoupon))).filter(Boolean).sort((a, c) => (a.code < c.code ? -1 : 1));
    // wallet withdrawals: the open ones, then the latest 100 done
    const all = (await Promise.all((wdIds || []).map(getWd))).filter(Boolean).sort((a, c) => (wdOpen(a) !== wdOpen(c) ? (wdOpen(a) ? -1 : 1) : a.created < c.created ? 1 : -1)).slice(0, 100);
    const ws = await Promise.all(all.map(wdSettle));
    const who = new Map((await getUsers([...new Set(ws.map((w) => w.user))])).map((u) => [u.id, u]));
    const wds = ws.map((w) => ({ ...wdView(w), user: w.user, name: (who.get(w.user) || {}).name || '', phone: (who.get(w.user) || {}).phone || '' }));
    return send(res, 200, { freeRule: free, refRule: ref, coupons, wds, wardPay: await wardPayOn(), wardPayAreas: await wardPayAreas(), wardCfg: await wardCfg() });
  }
  if (b.action === 'wd_paid' || b.action === 'wd_back') {   // superadmin: a UPI withdrawal sent by hand, or not sent
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const w = await getWd(b.id);
    if (!w) return send(res, 404, { error: 'not_found' });
    if (!wdOpen(w)) return send(res, 409, { error: 'wd_done' });
    const now = b.action === 'wd_paid' ? await wdPaid(w, b.utr, me.id) : await wdBack(w, 'admin');
    return send(res, 200, { wd: wdView(now) });
  }
  if (b.action === 'coupon_uses') {   // superadmin: every paid purchase that used a coupon (doneCoupon, addPaid in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const reqIds = (await redis('SMEMBERS', 'reqs')) || [];
    const reqRows = reqIds.length ? await pipeline(reqIds.map((id) => ['HGETALL', `req:${id}`])) : [];
    const h = (arr) => { const o = {}; for (let k = 0; k < (arr || []).length; k += 2) o[arr[k]] = arr[k + 1]; return o; };
    const all = reqIds.map((id, i) => ({ id, ...h(reqRows[i]) }));
    const used = all.filter((r) => r.user && r.status === 'done' && r.doneCoupon);
    const open = all.filter((r) => r.user && r.status === 'open' && r.coupon);   // checkout started with a coupon, not paid (yet)
    const who = new Map((await getUsers([...new Set(used.map((r) => r.user))])).map((u) => [u.id, u]));
    const rows = used.map((r) => {
      const u = who.get(r.user) || {}, n = Number(r.n) || 0, rs = Number(r.doneRs) || 0;
      return { id: r.id, code: r.doneCoupon, user: r.user, name: u.name || '', phone: u.phone || '', village: r.village || '', n, rs,
        off: Math.max(0, packPrice(n) - rs), bonus: Math.max(0, (Number(r.doneN) || 0) - n), at: r.doneAt || r.created || '' };
    }).sort((a, c) => (a.at < c.at ? 1 : -1));
    const by = {};
    for (const r of rows) {
      const s = by[r.code] || (by[r.code] = { code: r.code, uses: 0, people: new Set(), rs: 0, off: 0, bonus: 0, open: 0, last: '' });
      s.uses++; s.people.add(r.user); s.rs += r.rs; s.off += r.off; s.bonus += r.bonus; if (r.at > s.last) s.last = r.at;
    }
    for (const r of open) (by[r.coupon] || (by[r.coupon] = { code: r.coupon, uses: 0, people: new Set(), rs: 0, off: 0, bonus: 0, open: 0, last: '' })).open++;
    const summary = Object.values(by).map((s) => ({ ...s, people: s.people.size })).sort((a, c) => c.uses - a.uses || (a.code < c.code ? -1 : 1));
    return send(res, 200, { summary, rows: rows.slice(0, 500), total: rows.length });
  }
  if (b.action === 'reqs') {   // online purchases (the 🔔), superadmin only; after "list", so the page shows first
    if (!isSuper) return send(res, 200, { reqs: [] });
    const since = new Date(Date.now() - REQ_DONE_DAYS * 864e5).toISOString();
    const reqIds = (await redis('SMEMBERS', 'reqs')) || [];
    const reqRows = reqIds.length ? await pipeline(reqIds.map((id) => ['HGETALL', `req:${id}`])) : [];
    const h = (arr) => { const o = {}; for (let k = 0; k < (arr || []).length; k += 2) o[arr[k]] = arr[k + 1]; return o; };
    const rows = reqIds.map((id, i) => ({ id, ...h(reqRows[i]) })).filter((r) => r.user && (r.status === 'open' || r.doneAt > since));
    const who = new Map((await getUsers([...new Set(rows.map((r) => r.user))])).map((u) => [u.id, u]));   // only the people named
    const reqs = rows.map((r) => {
      const u = who.get(r.user);
      return u ? { ...reqView(r), name: u.name, phone: u.phone || '' } : null;
    }).filter(Boolean).sort((a, b) => ((a.status === 'open') !== (b.status === 'open') ? (a.status === 'open' ? -1 : 1)
      : (a.status === 'open' ? a.created : a.doneAt) < (b.status === 'open' ? b.created : b.doneAt) ? 1 : -1)).slice(0, 300);
    return send(res, 200, { reqs });
  }

  // the mark group a request names: the village's own marks (no cand) or one of its candidates'
  async function groupOf() {
    if (!realVillage(b.village)) return { error: [400, 'no_village'] };
    if (!mayUse(b.village)) return { error: [403, 'not_your_village'] };
    if (!b.cand) return { cand: { id: '' } };
    const c = await getCand(b.cand);
    return c && c.villages.includes(b.village) ? { cand: c } : { error: [404, 'no_cand'] };
  }

  if (b.action === 'marked') {
    const g = await groupOf();
    if (g.error) return send(res, g.error[0], { error: g.error[1] });
    const list = await markedList(b.village, g.cand.id, me.survey, b.status, b.ward, b.offset);
    if (!list) return send(res, 400, { error: 'bad_mark' });
    return send(res, 200, list);
  }

  if (b.action === 'clearMarks' || b.action === 'restoreMarks') {
    const g = await groupOf();
    if (g.error) return send(res, g.error[0], { error: g.error[1] });
    const key = markHash(b.village, g.cand.id, me.survey), backupKey = `${key}:backup`;
    if (b.action === 'clearMarks') {
      if (b.status !== 'all' && !MARKS.includes(b.status)) return send(res, 400, { error: 'bad_mark' });
      const flat = (await redis('HGETALL', key)) || [];
      const gone = [];
      for (let i = 0; i < flat.length; i += 2) if (b.status === 'all' || String(flat[i + 1]).split('|')[0] === b.status) gone.push(flat[i], flat[i + 1]);
      if (gone.length) {
        await redis('SET', backupKey, JSON.stringify({ at: now, flat: gone }));   // only the last clear can be undone
        const keys = gone.filter((x, i) => i % 2 === 0);
        for (let i = 0; i < keys.length; i += 500) await redis('HDEL', key, ...keys.slice(i, i + 500));
      }
    } else {
      const bk = await redis('GET', backupKey);
      if (!bk) return send(res, 404, { error: 'no_backup' });
      const { flat } = JSON.parse(bk);
      for (let i = 0; i < flat.length; i += 1000) await redis('HSET', key, ...flat.slice(i, i + 1000));
      await redis('DEL', backupKey);
    }
    return send(res, 200, await stats(Math.min(10000, Math.max(0, parseInt(b.all, 10) || 0))));
  }

  if (b.action === 'cand_add') {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    if (!realVillage(b.village)) return send(res, 400, { error: 'no_village' });
    if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
    const id = crypto.randomBytes(4).toString('hex');
    await redis('HSET', `cand:${id}`, 'name', name, 'village', b.village, 'created', now);
    await redis('SADD', 'cands', id);
    return send(res, 200, { cand: await getCand(id) });
  }

  if (b.action === 'party_set') {   // superadmin: a party (पार्टी) and its symbol, to put on candidates
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const name = String(b.name || '').trim().slice(0, 60), icon = String(b.icon || '');
    if (!name) return send(res, 400, { error: 'name' });
    if (icon && (icon.length > PARTY_ICON_MAX || !PARTY_ICON.test(icon))) return send(res, 400, { error: 'bad_icon' });
    const old = b.party ? await getParty(b.party) : null;
    if (b.party && !old) return send(res, 404, { error: 'no_party' });
    const id = old ? old.id : crypto.randomBytes(4).toString('hex');
    const party = { name, icon, created: old ? old.created : now };
    await redis('HSET', 'parties', id, JSON.stringify(party));
    return send(res, 200, { party: { id, ...party } });
  }
  if (b.action === 'party_del') {
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    if (!(await getParty(b.party))) return send(res, 404, { error: 'no_party' });
    await redis('HDEL', 'parties', b.party);
    return send(res, 200, { ok: true });
  }
  if (b.action === 'cand_party') {   // the party a candidate stands for ('' = none)
    const c = await getCand(b.cand);
    if (!c || !mayUse(c.village)) return send(res, 404, { error: 'no_cand' });
    const party = String(b.party || '');
    if (party && !(await getParty(party))) return send(res, 404, { error: 'no_party' });
    await redis('HSET', `cand:${c.id}`, 'party', party);
    return send(res, 200, { cand: await getCand(c.id) });
  }

  if (b.action === 'cand_delete') {
    const c = await getCand(b.cand);
    if (!c || !mayUse(c.village)) return send(res, 404, { error: 'no_cand' });
    const ids = (await redis('SMEMBERS', 'users')) || [];
    for (const u of (await getUsers(ids)).filter((u) => u.cand === c.id)) await redis('HSET', `user:${u.id}`, 'cand', '');
    for (const slug of c.villages) for (const sv of [false, true]) {   // both sets of marks, in every village it marked in
      await redis('DEL', markHash(slug, c.id, sv));
      await redis('DEL', `${markHash(slug, c.id, sv)}:backup`);
    }
    await redis('SREM', 'cands', c.id);
    await redis('DEL', `cand:${c.id}`);
    return send(res, 200, { ok: true });
  }

  if (b.action === 'add' || b.action === 'add_admin') {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    const phone = normPhone(b.phone);
    // a person's login opens only with its mobile number and password (unlock.js), so it needs a number
    if (phone === null || (b.action === 'add' && !phone)) return send(res, 400, { error: 'phone' });
    let fields;
    if (b.action === 'add') {
      if (!may('add')) return send(res, 403, { error: 'no_perm' });
      if (!realVillage(b.village)) return send(res, 400, { error: 'no_village' });
      if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
      const ex = extraVillages(b.village);
      if (ex.error) return send(res, 403, { error: ex.error });
      fields = ['role', 'user', 'village', b.village, ...(ex.more.length || ex.areas.length ? ['more', ex.more.join(','), 'areas', ex.areas.join(',')] : [])];
      if (b.cand) {   // straight into a candidate's group
        const c = await getCand(b.cand);
        if (!c || c.village !== b.village) return send(res, 404, { error: 'no_cand' });
        fields.push('cand', c.id);
        await candReach(c.id, ex.all);
      }
    } else {
      if (!may('admins')) return send(res, 403, { error: 'no_perm' });
      const vs = villageSlugs(b.villages), ss = samitiList(b.samitis);
      if (!vs.length && !ss.length) return send(res, 400, { error: 'no_village' });
      if (!ownVillages(vs) || !ownSamitis(ss)) return send(res, 403, { error: 'not_your_village' });
      fields = ['role', 'admin', 'villages', vs.join(','), 'samitis', ss.join(','), 'aperms', grantable(Array.isArray(b.aperms) ? b.aperms : OLD_ADMIN_PERMS).join(',')];
    }
    if (typedPw()) {   // the superadmin's own password for this login
      const bad = await badTypedPw(phone);
      if (bad) return send(res, bad === 'super_only' ? 403 : 400, { error: bad });
    }
    const { id, password } = await newLogin(fields, name, phone);
    if (typedPw()) {
      const err = await setOwnPassword(await getUser(id), typedPw());
      if (err) return send(res, 400, { error: err, user: view(await getUser(id)), password });   // made with the made-up one
      return send(res, 200, { user: view(await getUser(id)), password: typedPw() });
    }
    return send(res, 200, { user: view(await getUser(id)), password });
  }

  if (b.action === 'req_get' || b.action === 'req_reject') {   // superadmin: one online purchase
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const r = await settleOnline(b.rid), u = r ? await getUser(r.user) : null;   // how its payment stands now
    if (!u) return send(res, 404, { error: 'not_found' });
    if (b.action === 'req_get') return send(res, 200, { req: reqView(r) });
    if (r.status !== 'open') return send(res, 409, { error: 'already_done', req: reqView(r) });
    if (!(await redis('SET', `reqlock:${r.id}`, me.id, 'NX'))) return send(res, 409, { error: 'already_done', req: reqView(await getReq(r.id)) });
    await redis('HSET', `req:${r.id}`, 'status', 'rejected', 'doneAt', now, 'doneBy', me.id, 'doneByName', me.name);
    await redis('DEL', `reqopen:${u.id}:${r.n}`);
    return send(res, 200, { req: reqView(await getReq(r.id)) });
  }

  // everything below acts on one person: a village admin only on users of their villages, the superadmin on anyone
  const user = b.id ? await getUser(String(b.id)) : null;
  if (!user || !(isSuper || mine(user) || mineAdmin(user))) return send(res, 404, { error: 'not_found' });
  // nor manage an admin through that admin's person login (same mobile number; see "list")
  if (!isSuper && !mineAdmin(user) && user.phone && (await phoneLogins(user.phone)).some((x) => x.role === 'admin')) return send(res, 404, { error: 'not_found' });

  if (b.action === 'promote') {   // a user becomes a village admin of their village, with the same login ('admins')
    if (!may('admins')) return send(res, 403, { error: 'no_perm' });
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });
    if (!realVillage(user.village)) return send(res, 400, { error: 'no_village' });
    if (!ownVillages(user.villages)) return send(res, 403, { error: 'not_your_village' });
    await redis('HSET', `user:${user.id}`, 'role', 'admin', 'villages', user.villages.join(','), 'samitis', '', 'cand', '',
      'aperms', grantable(PROMOTED_PERMS).join(','), 'perms', appPerms(user).join(','), 'promotedAt', now,
      ...(isSuper ? [] : ['by', me.id, 'byName', me.name]));   // promoted by an admin: now one they look after
    await buildIndexes();
    await redis('SADD', 'admins', user.id);
    await redis('SREM', 'free', user.id);
    return send(res, 200, { user: view(await getUser(user.id)) });
  }
  if (b.action === 'aperms') {   // what a village admin may do on the admin page (the superadmin, or 'arights')
    if (!may('arights')) return send(res, 403, { error: 'no_perm' });
    if (user.role !== 'admin') return send(res, 400, { error: 'not_admin' });
    await redis('HSET', `user:${user.id}`, 'aperms', grantable(b.aperms, user.aperms).join(','));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'villages') {
    if (!may('admins')) return send(res, 403, { error: 'no_perm' });
    if (user.role !== 'admin') return send(res, 400, { error: 'not_admin' });
    const vs = villageSlugs(b.villages), ss = samitiList(b.samitis);
    if (!vs.length && !ss.length) return send(res, 400, { error: 'no_village' });
    if (!ownVillages(vs) || !ownSamitis(ss)) return send(res, 403, { error: 'not_your_village' });
    await redis('HSET', `user:${user.id}`, 'villages', vs.join(','), 'samitis', ss.join(','));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'move') {   // a person to another village: their candidate (of the old village) goes, and they log in again
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });
    if (!realVillage(b.village)) return send(res, 400, { error: 'no_village' });
    if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
    if (b.village !== user.village) {
      if ((await phoneLogins(user.phone)).some((x) => x.id !== user.id && x.retired !== '1' && x.villages.includes(b.village))) return send(res, 409, { error: 'exists' });
      await redis('HSET', `user:${user.id}`, 'village', b.village, 'cand', '', 'session', '');
      await afterMove(user, user.village, b.village);   // sign-up count, and their open requests go to the new village
    }
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'cand_set') {
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });   // admins see the village's marks
    let id = '';
    if (b.cand) {
      const c = await getCand(b.cand);
      if (!c || c.village !== user.village) return send(res, 404, { error: 'no_cand' });
      id = c.id;
    }
    await redis('HSET', `user:${user.id}`, 'cand', id);
    if (id) await candReach(id, user.villages);
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'user_villages') {   // the villages a person opens besides their own (ZP / PS candidates' workers)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });
    const { more, areas } = extraVillages(user.village);
    await redis('HSET', `user:${user.id}`, 'more', more.join(','), 'areas', areas.join(','));
    if (user.cand) await candReach(user.cand, userVillages(user.village, more.join(','), areas.join(',')));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'note') {   // the admins' own note on a person: shown only on the admin page, never in the app
    await redis('HSET', `user:${user.id}`, 'note', String(b.note || '').trim().slice(0, 1000));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'perms') {
    if (user.role !== 'user' && !isSuper) return send(res, 400, { error: 'not_user' });   // an admin's: the superadmin sets them
    const perms = PERMS.filter((p) => Array.isArray(b.perms) && b.perms.includes(p));
    await redis('HSET', `user:${user.id}`, 'perms', perms.join(','));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'ward_pay_user') {   // superadmin / 'wardpay': this person pays for ward slips or not, whatever the switch for everyone says
    if (!isSuper && !(may('wardpay') && mine(user))) return send(res, 403, { error: 'no_perm' });   // an admin's: superadmin only
    if (user.role !== 'user' && user.role !== 'admin') return send(res, 400, { error: 'not_user' });   // only the superadmin never pays
    const mode = ['free', 'pay'].includes(b.mode) ? b.mode : '';
    await redis('HSET', `user:${user.id}`, 'wardpay', mode);
    return send(res, 200, { user: view(await getUser(user.id)) });
  }
  if (b.action === 'limit' || b.action === 'extra') {
    if (user.role !== 'user' && !may('asearch')) return send(res, 403, { error: 'no_perm' });   // an admin's: superadmin or 'asearch'
    if (b.action === 'limit') {
      const n = b.limit === '' || b.limit == null ? 0 : parseInt(b.limit, 10);
      if (!(n >= 0 && n <= 5000)) return send(res, 400, { error: 'bad_limit' });
      await redis('HSET', `user:${user.id}`, 'limit', n ? String(n) : '');
    } else {
      const n = parseInt(b.n, 10) || 100;
      if (!(n > 0 && n <= 5000)) return send(res, 400, { error: 'bad_limit' });
      await redis('HSET', `user:${user.id}`, 'extra', `${today()}:${extraToday(user) + n}`);
    }
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'gift') {   // free searches for good to a signed-up user (creditsLeft in _lib.js)
    if (!may('gift')) return send(res, 403, { error: 'no_perm' });
    if (!isPrepaid(user)) return send(res, 400, { error: 'not_prepaid' });
    const n = parseInt(b.n, 10);
    if (!(n > 0 && n <= GIFT_MAX)) return send(res, 400, { error: 'bad_limit' });
    await pipeline([['HINCRBY', `user:${user.id}`, 'credits', n], ['HINCRBY', `user:${user.id}`, 'gifted', n]]);
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'reset' && typedPw()) {   // the superadmin's own choice of password
    const bad = await badTypedPw(user.phone, user.id);
    if (bad) return send(res, bad === 'super_only' ? 403 : 400, { error: bad });
    const err = await setOwnPassword(user, typedPw());
    if (err) return send(res, 400, { error: err });
    await redis('HSET', `user:${user.id}`, 'retired', '0', 'session', '');
    return send(res, 200, { user: view(await getUser(user.id)), password: typedPw() });
  }
  if (b.action === 'reset') {
    const password = await freshPassword(), hash = pwHash(password);
    if (user.hash) await redis('DEL', `pw:${user.hash}`);
    await redis('HSET', `user:${user.id}`, 'hash', hash, 'ownpw', '0', 'retired', '0', 'session', '');
    await redis('SET', `pw:${hash}`, user.id);
    return send(res, 200, { user: view(await getUser(user.id)), password });
  }

  if (b.action === 'phone') {
    const phone = normPhone(b.phone);
    if (phone === null || (user.role === 'user' && !phone)) return send(res, 400, { error: 'phone' });   // see 'add'
    if (phone === (user.phone || '')) return send(res, 200, { user: view(user) });
    await buildIndexes();
    let password;   // a password the person chose is kept with the old number: a new made-up one instead
    if (hasOwnPassword(user)) {
      password = await freshPassword();
      const hash = pwHash(password);
      if (user.hash) await redis('DEL', `pw:${user.hash}`);
      await redis('HSET', `user:${user.id}`, 'hash', hash, 'ownpw', '0', 'session', '');
      await redis('SET', `pw:${hash}`, user.id);
    }
    await redis('HSET', `user:${user.id}`, 'phone', phone);
    if (user.phone) await redis('SREM', `phone:${user.phone}`, user.id);
    if (phone) await redis('SADD', `phone:${phone}`, user.id);
    return send(res, 200, { user: view(await getUser(user.id)), password });
  }

  if (b.action === 'retire') {
    await redis('HSET', `user:${user.id}`, 'retired', '1', 'retiredAt', now, 'session', '');
    return send(res, 200, { ok: true });
  }

  if (b.action === 'logout') {
    await redis('HSET', `user:${user.id}`, 'session', '');
    return send(res, 200, { ok: true });
  }

  send(res, 400, { error: 'action' });
});
