// POST {token, action, ...}   token = from logging in (api/unlock) as the superadmin or a village admin
// The superadmin manages everything. A village admin sees and manages users of their assigned villages as the superadmin
// allows (ADMIN_PERMS in _lib.js, field "aperms"): 'own' the users they made, 'all' every user there; 'add' new users,
// 'credits' searches for them, 'approve' their requests (and those sent to this admin). Without the permission → 'no_perm'.
//   action "list" [, village]          → {me: {id, role, name, villages}, users: [...], admins: [...] (superadmin only), …}
//                                         quick (no voter files read): users carry perms, searchesToday, limit (today's,
//                                         with any extra), ownLimit ('' = default) and extraToday
//   action "reqs"                      → {reqs, collected}   pack requests (the 🔔) and money collected, asked for after "list"
//   action "settings"                  → {freeRule, refRule, coupons}   superadmin, when one of those tabs opens
//   action "stats" [, all: n] [, only: 'marked'] (only: just {marked, survey}, no voter files read)
//   action "stats" [, all: n]          → {progress, marked: {id: slips marked}, partial, groups, survey}   the slow part,
//                                         asked for after "list": progress per ward (only groups with marks when there
//                                         are more than STATS_ALL, else the first n groups, those with marks first) and how many slips each person marked
//   action "add", village, name, phone [, cand, more, areas] → {user, password}   new user of one village (must be one of
//                                         the admin's villages); more: [slug, ...] extra villages they open too, areas:
//                                         whole ZP / PS wards ["zp:<district>|<zp>" | "ps:<district>|<samiti>|<ps>", ...]
//                                         (userVillages in _lib.js); every village these give must be the admin's
//   action "user_villages", id, more, areas → {user}   change a user's extra villages (as in "add")
//   action "add_admin", name, phone, villages: [slug, ...], samitis: ["<district>|<samiti>", ...] [, aperms] → {user, password}
//                                         (superadmin only; samitis = whole पंचायत समितियाँ, villages added there later too)
//   action "villages", id, villages, samitis               → {user}   change an admin's villages (superadmin only)
//   action "reset",  id         → {user, password}   (new password for the same person; the old one stops working)
//   action "retire", id         → {ok}               (password stops working; the phone is logged out at once)
//   action "logout", id         → {ok}               (ends the person's current session; they can log in again)
//   action "phone",  id, phone  → {user [, password]} (add or change the person's WhatsApp number; "" removes it). A
//                                                       password the person chose works only with their old number
//                                                       (ownPwHash in _lib.js), so they then get a new made-up one, shown once
//   action "perms",  id, perms  → {user}             (what a user may do: any of PERMS in _lib.js; an admin's in the app:
//                                                       superadmin only)
//   action "aperms", id, aperms → {user}             superadmin: what a village admin may do here (ADMIN_PERMS)
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
//   action "move", id, village       → {user}   moves a user to another village (both must be the admin's): their
//                                               candidate is cleared and their phone is logged out
//   action "credits_add", id, n      → {user}   n more searches (1–10000) for a login made by signing up (api/signup.js),
//                                               e.g. paid to the admin; takes it out of the set "free" (signed up, nothing bought)
//   (in "list": reqs = those requests of this admin's people that were sent to them (to, see adminFor in _lib.js; the
//    superadmin sees every one, with toName), open ones first, plus the ones approved or rejected in the last 30 days,
//    each with the person's name and phone; doneRs = ₹ collected, doneByName = by whom; hand = added with सर्च जोड़ें)
//   and collected: [{by, name, rs, n, count, settled, due}] payments collected so far by each admin (all time), what they
//   handed over to the superadmin and what is still due; a village admin gets only their own row
//   action "ledger" [, by]            → {ledger}  हिसाब of one admin (by = admin id, superadmin only; a village admin gets
//                                               their own): {by, name, collected, settled, due, pays: [{id, at, name, phone,
//                                               village, n, rs, hand}], settles: [{id, at, rs, note, byName}]}, newest first
//   action "settle_add", by, rs [, note] → {ledger}   superadmin: ₹rs received from that admin
//   action "settle_remove", by, sid      → {ledger}   superadmin: takes back a handover recorded by mistake
//   action "req_get", rid            → {req}    a pack request (api/signup.js 'request') of a person this admin manages:
//                                               {id, user, village, n, rs, created, status 'open' | 'done', doneAt, doneN,
//                                               doneByName}; someone else's → not_found
//   action "req_approve", rid, n     → {req, user}   adds n searches (as credits_add) and marks the request done, once:
//                                               a done or rejected request → already_done with {req}
//   action "coupon_set", code, kind ('pct' | 'rs' | 'bonus' | 'bonuspct'), value, maxOff, minN, maxN, maxUses, until, once, first, on, show, note, banner, bannerText, isNew
//                                         → {coupon}   superadmin: a coupon (getCoupon in _lib.js); "list" gives coupons
//   action "coupon_del", code → {ok}      superadmin
//   action "ref_rule", on, inviter, joiner → {refRule}   superadmin: referral searches (refRule in _lib.js); "list" gives
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
//   action "req_reject", rid         → {req}    closes an open request without searches (status 'rejected', doneAt,
//                                               doneByName = who rejected it)
// progress: [{key, slug, cand, name, candName, marks: {done, coming, absent}, wards: [{ward, total, done, coming, absent}],
//   backup: {n, at} | null}]   one entry per village of this admin and per candidate of it (cand '' = the village's own
//   marks): how many slips carry each mark, overall and per ward.
// cands (in "list"): [{id, name, village, created}] the candidates of this admin's villages.
// The password is shown to the admin once; only its hash is stored.
// Phone numbers are stored as digits with the country code, e.g. 919876543210, ready for a wa.me link.
const crypto = require('crypto');
const { markSummary, markedList, candsOf, groupsOf } = require('./_progress.js');
const { candReach, areaSize, areaKeyOf, areaVillages, userVillages, COUPON_RE, couponCode, getCoupon, REF_MAX, refRule, freeRule, buildIndexes, afterMove, hasOwnPassword, FREE_MAX, appPerms, ADMIN_PERMS, PROMOTED_PERMS, adminPermsOf, adminLimited, village, villageList, samitiKeys, MARKS, PERMS, permsOf, allMarks, markHash, getCand, today, DAILY_SEARCHES, extraToday, dailyLimit, credits, isPrepaid, canBuy, packPrice, newReqId, getReq, addPaid, settleOnline, paidKey, normPhone, canMoveUserData, moveUserData, phoneLogins, redis, pipeline, pwHash, whoIs, freshPassword, newLogin: makeLogin, getUser, getUsers, marksFrom, blocked, failed,
  send, route } = require('./_lib.js');

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
  phone: u.phone || '', created: u.created, lastSeen: u.lastSeen || null,
  by: u.by || '', byName: u.byName || '', credits: credits(u), prepaid: isPrepaid(u), canBuy: canBuy(u), bought: u.bought === '1', self: u.self === '1',   // signed-up logins: credits = free + paid searches in all, bought = was given paid ones   // who made this login (admin id 'admin' = the superadmin); older logins: ''
  retired: u.retired === '1', retiredAt: u.retiredAt || null,
  // referrals: who invited this login, and what this login's invites earned (refRule in _lib.js)
  refBy: u.refBy || '', refByName: u.refByName || '', refPaid: u.refPaid === '1', refBought: Number(u.refBought) || 0, refEarned: Number(u.refEarned) || 0,
  loggedIn: !!u.session && u.retired !== '1',
  sessionAt: u.sessionAt || null, sessionIp: u.sessionIp || null, sessionDevice: u.sessionDevice || null,
  logins: Number(u.logins || 0), kicks: Number(u.kicks || 0),
});

// a pack request as the admin page sees it
const reqView = ({ id, user, village: v, n, rs, created, status, doneAt, doneN, doneRs, doneBy, doneByName, hand, gw, coupon, bonus, doneCoupon }) =>
  ({ id, user, village: v, n: Number(n), rs: Number(rs), created, status, doneAt: doneAt || null, doneN: Number(doneN) || 0,
    doneRs: Number(doneRs) || 0, doneBy: doneBy || '', doneByName: doneByName || '', hand: hand === '1', online: !!gw,
    coupon: coupon || '', bonus: Number(bonus) || 0, doneCoupon: doneCoupon || '' });   // online: paid by UPI on JaduPe
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
  const now = new Date().toISOString();
  // a new login made by this admin: fields = role and village(s) [and more]; → {id, password}
  const newLogin = (fields, name, phone) => makeLogin(fields, name, phone, me.id, me.name);
  // a person's extra villages from the request (b.more, b.areas) besides their own village home: → {more, areas, all} or
  // {error} when one of the villages they give is not this admin's
  const extraVillages = (home) => {
    const more = villageSlugs(b.more).filter((s) => s !== home), areas = areaList(b.areas);
    const all = userVillages(home, more.join(','), areas.join(','));
    return all.every(mayUse) ? { more, areas, all } : { error: 'not_your_village' };
  };
  const paidIn = (u, n, r) => addPaid(u, n, r, me);   // n bought searches for u, paid to this admin (see _lib.js)

  if (b.action === 'ref_rule') {   // superadmin: referrals (refRule in _lib.js)
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const n = (v) => { const x = Math.floor(Number(v)); return x >= 0 && x <= REF_MAX ? x : -1; };
    const inviter = n(b.inviter), joiner = n(b.joiner);
    if (inviter < 0 || joiner < 0) return send(res, 400, { error: 'ref_rule' });
    await redis('HSET', 'refrule', 'on', b.on ? '1' : '0', 'inviter', inviter, 'joiner', joiner, 'at', now, 'by', me.id);
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
    if (isSuper) await pipeline([['SET', 'markmode', b.mode], ['SET', 'markmodeat', now]]);   // everyone, from now on
    else await redis('HSET', `user:${me.id}`, 'markmode', b.mode, 'markmodeAt', now);   // this admin only
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
    if (r.next === '0') await redis('SET', 'usermoved', now);
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
    const [ids, cands, moved] = await Promise.all([
      redis('SMEMBERS', 'users').then((x) => x || []),
      candsOf(me.villages),
      isSuper && canMoveUserData() ? redis('GET', 'usermoved') : null]);
    const all = (await getUsers(ids)).sort((x, y) => (x.created < y.created ? 1 : -1));
    const shown = all.filter((u) => (mine(u) && (!b.village || u.village === b.village)) || (isSuper && u.role === 'admin'));
    const day = today();
    const buyers = shown.filter((u) => isPrepaid(u) || credits(u) > 0);
    const counts = shown.length ? await pipeline([...shown.map((u) => ['GET', `searches:${u.id}:${day}`]), ...buyers.map((u) => ['GET', paidKey(u.id)])]) : [];
    const searches = Object.fromEntries(shown.map((u, i) => [u.id, Number(counts[i]) || 0]));
    const paid = Object.fromEntries(buyers.map((u, i) => [u.id, Number(counts[shown.length + i]) || 0]));
    const withUse = (u) => ({ ...view(u), searchesToday: searches[u.id] || 0, paidUsed: paid[u.id] || 0 });
    const users = shown.filter((u) => mine(u) && (!b.village || u.village === b.village)).map(withUse);
    const admins = isSuper ? shown.filter((u) => u.role === 'admin').map(withUse) : undefined;
    const dbCopy = isSuper && canMoveUserData() ? (moved ? 'done' : 'todo') : undefined;
    return send(res, 200, { dbCopy, survey: me.survey, me: { id: me.id, role: me.role, name: me.name, villages: me.villages, aperms: isSuper ? ADMIN_PERMS.slice() : me.aperms }, users, admins,
      villageList: villageList(me.villages), areaSize: areaSizes(me.villages), cands: cands.map(({ id, name, village: v, created }) => ({ id, name, village: v, created })) });
      // villageList: names of my villages (the list is not public)
  }
  if (b.action === 'settings') {   // superadmin, when a settings tab opens: free searches, referrals, coupons
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    const [free, ref, codes] = await Promise.all([freeRule(), refRule(), redis('SMEMBERS', 'coupons')]);
    const coupons = (await Promise.all((codes || []).map(getCoupon))).filter(Boolean).sort((a, c) => (a.code < c.code ? -1 : 1));
    return send(res, 200, { freeRule: free, refRule: ref, coupons });
  }
  if (b.action === 'reqs') {   // pack requests (the 🔔) and money collected; after "list", so the page shows first
    // pack requests of the people this admin manages: every open one, and those approved in the last REQ_DONE_DAYS
    const since = new Date(Date.now() - REQ_DONE_DAYS * 864e5).toISOString();
    const [reqIds, payH] = await Promise.all([
      redis('SMEMBERS', 'reqs').then((x) => x || []),
      pipeline(['pay:rs', 'pay:n', 'pay:count', 'pay:name', 'pay:settled'].map((k) => ['HGETALL', k]))]);
    const reqRows = reqIds.length ? await pipeline(reqIds.map((id) => ['HGETALL', `req:${id}`])) : [];
    const h = (arr) => { const o = {}; for (let k = 0; k < (arr || []).length; k += 2) o[arr[k]] = arr[k + 1]; return o; };
    const rows = reqIds.map((id, i) => ({ id, ...h(reqRows[i]) }))
      .filter((r) => r.user && mayUse(r.village) && (r.status === 'open' || r.doneAt > since));
    const [rsO, nO, cO, nameO, sO] = payH.map(h);
    const payIds = Object.keys(rsO).filter((id) => isSuper || id === me.id);
    // only the people these requests and payments name are read, not every login
    const who = new Map((await getUsers([...new Set([...rows.flatMap((r) => [r.user, r.to]), ...payIds].filter((id) => id && id !== 'admin'))])).map((u) => [u.id, u]));
    const reqs = may('approve') ? rows.map((r) => {
      const u = who.get(r.user);   // a person of my villages, asking from one of my villages
      if (!u || u.role !== 'user' || !mayUse(u.village)) return null;
      if (!(mine(u) || r.to === me.id)) return null;   // requests of my users, or sent to me
      if (!isSuper && r.to && r.to !== me.id && r.doneBy !== me.id) return null;   // sent to someone else
      if (!isSuper && r.gw && r.status === 'open') return null;   // being paid online: added by itself once paid
      const to = r.to === 'admin' ? 'सुपर एडमिन' : r.to ? (who.get(r.to) || {}).name || '' : '';
      return { ...reqView(r), name: u.name, phone: u.phone || '', toName: isSuper ? to : '' };
    }).filter(Boolean).sort((a, b) => ((a.status === 'open') !== (b.status === 'open') ? (a.status === 'open' ? -1 : 1)
      : (a.status === 'open' ? a.created : a.doneAt) < (b.status === 'open' ? b.created : b.doneAt) ? 1 : -1)).slice(0, 300) : [];
    // payments collected so far, per admin (pay:* in _lib.js), and what each has handed over; a village admin sees only
    // their own
    const nameOf = (id) => (id === 'admin' ? 'सुपर एडमिन' : (who.get(id) || {}).name || nameO[id] || id);
    const collected = payIds.map((id) => ({ by: id, name: nameOf(id), rs: Number(rsO[id]) || 0, n: Number(nO[id]) || 0, count: Number(cO[id]) || 0,
      settled: Number(sO[id]) || 0, due: id === 'admin' ? 0 : (Number(rsO[id]) || 0) - (Number(sO[id]) || 0) })).sort((a, b) => b.rs - a.rs);
    return send(res, 200, { reqs, collected });
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
      if (!isSuper) return send(res, 403, { error: 'super_only' });
      const vs = villageSlugs(b.villages), ss = samitiList(b.samitis);
      if (!vs.length && !ss.length) return send(res, 400, { error: 'no_village' });
      fields = ['role', 'admin', 'villages', vs.join(','), 'samitis', ss.join(','), 'aperms', (Array.isArray(b.aperms) ? adminPermsIn(b.aperms) : ADMIN_PERMS).join(',')];
    }
    const { id, password } = await newLogin(fields, name, phone);
    return send(res, 200, { user: view(await getUser(id)), password });
  }

  if (b.action === 'req_get' || b.action === 'req_approve' || b.action === 'req_reject') {
    const r = await settleOnline(b.rid), u = r ? await getUser(r.user) : null;   // an online one: how its payment stands now
    if (!u || !(isSuper || (u.role === 'user' && mayUse(u.village) && mayUse(r.village) && may('approve') && (mine(u) || r.to === me.id)))) return send(res, 404, { error: 'not_found' });
    if (b.action === 'req_get') return send(res, 200, { req: reqView(r) });
    if (r.status !== 'open') return send(res, 409, { error: 'already_done', req: reqView(r) });
    if (b.action === 'req_reject') {   // e.g. no payment came: closed without searches, kept in the list as rejected
      if (!(await redis('SET', `reqlock:${r.id}`, me.id, 'NX'))) return send(res, 409, { error: 'already_done', req: reqView(await getReq(r.id)) });
      await redis('HSET', `req:${r.id}`, 'status', 'rejected', 'doneAt', now, 'doneBy', me.id, 'doneByName', me.name);
      await redis('DEL', `reqopen:${u.id}:${r.n}`);
      return send(res, 200, { req: reqView(await getReq(r.id)) });
    }
    if (!canBuy(u)) return send(res, 400, { error: 'not_prepaid' });
    const n = parseInt(b.n, 10);
    if (!(n > 0 && n <= 10000)) return send(res, 400, { error: 'bad_credits' });
    if (!(await redis('SET', `reqlock:${r.id}`, me.id, 'NX'))) return send(res, 409, { error: 'already_done', req: reqView(await getReq(r.id)) });
    await paidIn(u, n, r);
    await redis('DEL', `reqopen:${u.id}:${r.n}`);
    return send(res, 200, { req: reqView(await getReq(r.id)), user: view(await getUser(u.id)) });
  }

  // हिसाब: one admin's payments (every approved request and hand-added pack) and the money they handed over to the
  // superadmin (hash settle:<admin id>: entry id → JSON {id, at, rs, note, byName}; pay:settled adds them up), so the two can be
  // squared: due = collected − handed over. The superadmin's own collections need no handover.
  if (b.action === 'ledger' || b.action === 'settle_add' || b.action === 'settle_remove') {
    const by = isSuper ? String(b.by || '') : me.id;
    const admin = by === 'admin' ? null : await getUser(by);
    if (by !== 'admin' && !(admin && admin.role === 'admin')) return send(res, 404, { error: 'not_found' });
    const sKey = `settle:${by}`;
    if (b.action !== 'ledger') {
      if (!isSuper) return send(res, 403, { error: 'super_only' });
      if (by === 'admin') return send(res, 400, { error: 'action' });
      if (b.action === 'settle_add') {
        const rs = parseInt(b.rs, 10);
        if (!(rs > 0 && rs <= 10000000)) return send(res, 400, { error: 'bad_amount' });
        const entry = { id: crypto.randomBytes(4).toString('hex'), at: now, rs, note: String(b.note || '').trim().slice(0, 100), byName: me.name };
        await redis('HSET', sKey, entry.id, JSON.stringify(entry));
        await redis('HINCRBY', 'pay:settled', by, rs);
      } else {
        const sid = String(b.sid || ''), raw = sid && ((await redis('HMGET', sKey, sid)) || [])[0];
        if (raw && Number(await redis('HDEL', sKey, sid)) === 1) await redis('HINCRBY', 'pay:settled', by, -JSON.parse(raw).rs);
      }
    }
    const reqIds = (await redis('SMEMBERS', 'reqs')) || [];
    const rows = reqIds.length ? await pipeline(reqIds.map((id) => ['HGETALL', `req:${id}`])) : [];
    const done = reqIds.map((id, i) => {
      const r = { id }, arr = rows[i] || [];
      for (let k = 0; k < arr.length; k += 2) r[arr[k]] = arr[k + 1];
      return r;
    }).filter((r) => r.status === 'done' && r.doneBy === by);
    const people = new Map((await getUsers([...new Set(done.map((r) => r.user))])).map((u) => [u.id, u]));
    const pays = done.map((r) => {
      const u = people.get(r.user) || {};
      return { id: r.id, at: r.doneAt, name: u.name || '?', phone: u.phone || '', village: r.village, n: Number(r.doneN) || 0, rs: Number(r.doneRs) || 0, hand: r.hand === '1' };
    }).sort((x, y) => (x.at < y.at ? 1 : -1));
    const sArr = (await redis('HGETALL', sKey)) || [];
    const settles = sArr.filter((x, k) => k % 2).map((x) => JSON.parse(x)).sort((x, y) => (x.at < y.at ? 1 : -1));
    const collectedRs = pays.reduce((t, p) => t + p.rs, 0), settled = settles.reduce((t, x) => t + x.rs, 0);
    return send(res, 200, { ledger: { by, name: admin ? admin.name : 'सुपर एडमिन', collected: collectedRs, settled,
      due: by === 'admin' ? 0 : collectedRs - settled, pays, settles } });
  }

  // everything below acts on one person: a village admin only on users of their villages, the superadmin on anyone
  const user = b.id ? await getUser(String(b.id)) : null;
  if (!user || !(isSuper || mine(user))) return send(res, 404, { error: 'not_found' });

  if (b.action === 'promote') {   // superadmin: a user becomes a village admin of their village, with the same login
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });
    if (!realVillage(user.village)) return send(res, 400, { error: 'no_village' });
    await redis('HSET', `user:${user.id}`, 'role', 'admin', 'villages', user.villages.join(','), 'samitis', '', 'cand', '',
      'aperms', PROMOTED_PERMS.join(','), 'perms', appPerms(user).join(','), 'promotedAt', now);
    await buildIndexes();
    await redis('SADD', 'admins', user.id);
    await redis('SREM', 'free', user.id);
    return send(res, 200, { user: view(await getUser(user.id)) });
  }
  if (b.action === 'aperms') {   // superadmin: what a village admin may do on the admin page
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    if (user.role !== 'admin') return send(res, 400, { error: 'not_admin' });
    await redis('HSET', `user:${user.id}`, 'aperms', adminPermsIn(b.aperms).join(','));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'villages') {
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    if (user.role !== 'admin') return send(res, 400, { error: 'not_admin' });
    const vs = villageSlugs(b.villages), ss = samitiList(b.samitis);
    if (!vs.length && !ss.length) return send(res, 400, { error: 'no_village' });
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
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });
    const ex = extraVillages(user.village);
    if (ex.error) return send(res, 403, { error: ex.error });
    // villages given by another admin (or the superadmin) that this admin doesn't look after stay as they are
    const keepMore = user.more.filter((s) => !mayUse(s)), keepAreas = user.areas.filter((k) => !areaVillages(k).every(mayUse));
    const more = [...new Set([...keepMore, ...ex.more])], areas = [...new Set([...keepAreas, ...ex.areas])];
    await redis('HSET', `user:${user.id}`, 'more', more.join(','), 'areas', areas.join(','));
    if (user.cand) await candReach(user.cand, userVillages(user.village, more.join(','), areas.join(',')));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'perms') {
    if (user.role !== 'user' && !isSuper) return send(res, 400, { error: 'not_user' });   // an admin's: the superadmin sets them
    const perms = PERMS.filter((p) => Array.isArray(b.perms) && b.perms.includes(p));
    await redis('HSET', `user:${user.id}`, 'perms', perms.join(','));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'credits_add') {
    if (!may('credits')) return send(res, 403, { error: 'no_perm' });
    if (!canBuy(user)) return send(res, 400, { error: 'not_prepaid' });   // admins and demo logins
    const n = parseInt(b.n, 10);
    if (!(n > 0 && n <= 10000)) return send(res, 400, { error: 'bad_credits' });
    await paidIn(user, n, null);
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'limit' || b.action === 'extra') {
    if (user.role !== 'user' && !isSuper) return send(res, 400, { error: 'not_user' });   // an admin's: the superadmin sets it
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
