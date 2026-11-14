// POST {village, token, name, rel, ward, mark, offset, after} → {total, more, results: [...up to 10 voters, each with its
//   status mark and who set it, and on polling day its survey mark sm], wards, perms, survey (markModeOf in _lib.js)}
// POST {village, token, family: "<ward>:<box>"} → {total, results: everyone at that voter's house number in that ward}
// POST {village, token, ward, all: true} → {total, results: [every voter of that ward]}   once that ward is paid for
//   (₹WARD_RS, api/pay.js; the superadmin and village admins don't pay), else 402 {error: 'pay_ward', rs}. Other
//   answers carry wp: the wards this login has paid for here, or true when it doesn't pay.
// A ward with no name lists the whole ward in box order: anyone (not the demo) sees its first FREE_WARD slips, 10 at a
// time; the rest once that ward is paid for (₹WARD_RS, the same purchase as its slips' download; admins don't pay), the
// answer saying locked: true where the free ones end. It pages with after = the last
// box shown, so marking slips while going through a filtered list doesn't skip anyone. A name search pages through its
// best 250 matches. mark filters by status mark: 'none' (no mark yet) | 'done' | 'coming' | 'absent'.
// Voters struck off the roll (del 'E' | 'S' | 'R') are found and shown, tagged, but never in a mark filter or ward slips.
// Every search checks that the password behind the token is still active and that this phone holds its newest
// session, so retiring or logging in on another phone takes effect at once.
//
// Daily limit (users, and village admins the superadmin gave one; adminLimited in _lib.js): what counts is one *search*, not one request. The server hands out a
// search id with the first answer ({searchId, left}); the phone sends it back with every request that belongs to the
// same search and drops it when the search box is cleared. A request carries on the current search, for free, when its
// id is this person's current one, the search has lasted under SEARCH_STEPS requests and SEARCH_MINUTES, and it is:
// a family list or another page, the same name typed further or shortened (or a father's name added), or the same
// ward listed again. Anything else starts a new search, which counts 1 and is refused ('limit') once the person has
// used dailyLimit() today. A ward's slips (all) always count 1. The id is made and checked here, so a phone can't
// skip counting. A demo phone (see DEMO in _lib.js) gets DEMO.searches in all, and its internet address DEMO.perIp a
// day: the answer is then 'demo_limit'. A signed-up user (isPrepaid in _lib.js) has their credits in all
// instead of a daily limit: the answer is then 'credits' once they are used up. A login with a daily limit that bought
// searches uses them once the day's are used up ({bought} = how many of those are left); 'limit' when both are gone.
const crypto = require('crypto');
const { DEMO, village, whoIs, wardCfg, wardKey, wardAzKey, wardHnKey, wardFree, wardsPaid, wardsAz, wardsHn, MARKS, markKey, marksFor, allMarks, today, dailyLimit, adminLimited, credits, isPrepaid, paidKey, clientIp, redis, pipeline, send, route } = require('../_lib.js');
const { load, search, family, publicFields } = require('../_search.js');
const HI = new Intl.Collator('hi').compare;   // Hindi dictionary order, अ to ज्ञ (a ward's slips in name order)
// house numbers as numbers (2 before 10, "12" before "12A"); voters with no house number last
const HOUSE = new Intl.Collator('hi', { numeric: true }).compare;
const byHouse = (x, y) => { const a = String(x.house || '').trim(), c = String(y.house || '').trim(); return (!a - !c) || HOUSE(a, c); };

const FREE_WARD = 20;   // slips of a ward anyone may list before paying for it
const PAGE = 10, MAX_NAMED = 250, MAX_FAMILY = 60, PER_MINUTE = 60;   // 10 slips at a time
const SEARCH_STEPS = 25, SEARCH_MINUTES = 10;

const fold = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const follows = (a, b) => a.startsWith(b) || b.startsWith(a);   // "mangi" ↔ "mangilal"; '' follows anything
// takes one from a counter only while it stays within max: INCR first, and back (DECR) when that went over, so two
// searches at the same moment can't both use the last one. ttl (seconds): the counter's life when it is new.
// → the new count, or 0 when it was used up
async function takeOne(key, max, ttl) {
  const n = Number((await pipeline([...(ttl ? [['SET', key, 0, 'EX', ttl, 'NX']] : []), ['INCR', key]])).pop());
  if (n <= max) return n;
  await redis('DECR', key);
  return 0;
}

// Counts this request against the person's limits: {searchId, left} to send back, or {error}.
async function countSearch(req, user, b, named) {
  const minuteKey = `rate:${user.id}:${Math.floor(Date.now() / 60000)}`;
  // a demo phone's searches are counted for good (30 days), not per day; its internet address is counted per day
  const prepaid = isPrepaid(user);   // signed-up / bought searches: counted for good, not per day
  const dayKey = user.demo ? `searches:${user.id}` : prepaid ? paidKey(user.id) : `searches:${user.id}:${today()}`, findKey = `find:${user.id}`;
  const ipKey = `demo-ip:${clientIp(req)}:${today()}`;
  // a daily limit plus bought searches, used after the day's (village admins too; the superadmin has no limit)
  const extra = !user.demo && !prepaid && user.role !== 'super' && credits(user) > 0;
  const [, perMinute, curRaw, usedRaw, ipRaw, paidRaw] = await pipeline([['SET', minuteKey, 0, 'EX', 120, 'NX'], ['INCR', minuteKey],
    ['GET', findKey], ['GET', dayKey], ['GET', ipKey], ['GET', paidKey(user.id)]]);
  if (perMinute > PER_MINUTE) return { error: 'slow_down' };
  if (user.admin && !adminLimited(user)) return {};   // the superadmin

  let cur = null;
  try { cur = curRaw && JSON.parse(curRaw); } catch (e) { /* start a new search */ }
  const q = { name: fold(b.name), rel: fold(b.rel), ward: String(b.ward || '') };
  const now = Date.now(), limit = user.demo ? DEMO.searches : prepaid ? credits(user) : dailyLimit(user);
  let used = Number(usedRaw) || 0, paidUsed = Number(paidRaw) || 0;
  const goesOn = !b.all && cur && b.searchId && b.searchId === cur.id && cur.n < SEARCH_STEPS
    && now - cur.start < SEARCH_MINUTES * 60e3
    && (b.family ? true : named ? follows(q.name, cur.name) && follows(q.rel, cur.rel) : !cur.name && !cur.rel && q.ward === cur.ward);
  const cmds = [];
  let next = cur;
  if (goesOn) next = { ...cur, n: cur.n + 1, ...(b.family ? {} : q) };
  else {
    // a new search: one from the day's (or a demo phone's, or a signed-up login's) searches, else one bought search
    const refused = { error: user.demo ? 'demo_limit' : prepaid ? 'credits' : 'limit', left: 0, ...(extra ? { bought: 0 } : {}) };
    if (user.demo && Number(ipRaw) >= DEMO.perIp) return refused;
    const n = await takeOne(dayKey, limit, prepaid ? 0 : (user.demo ? 30 : 3) * 86400);
    if (n) used = n;
    else {
      const p = extra ? await takeOne(paidKey(user.id), credits(user), 0) : 0;
      if (!p) return refused;
      used = Math.max(used, limit); paidUsed = p;
    }
    if (user.demo) cmds.push(['SET', ipKey, 0, 'EX', 86400, 'NX'], ['INCR', ipKey]);
    if (!b.all) next = { id: crypto.randomBytes(8).toString('base64url'), n: 1, start: now, ...q };
  }
  if (next) cmds.push(['SET', findKey, JSON.stringify(next), 'EX', SEARCH_MINUTES * 60]);
  if (cmds.length) await pipeline(cmds);
  return { searchId: next ? next.id : '', left: Math.max(0, limit - used), ...(extra ? { bought: credits(user) - paidUsed } : {}) };
}

async function withMarks(slug, list, cand, survey) {   // cand: the searcher's candidate group, whose marks they see
  const results = list.map(publicFields);
  const keys = results.map(markKey);   // the marks and (polling day) the survey marks too, read at the same time
  const [marks, sv] = await Promise.all([marksFor(slug, keys, cand, survey), survey ? [] : marksFor(slug, keys, cand, true)]);
  results.forEach((r, i) => { r.mark = marks[i].m; r.markBy = marks[i].by; r.markAt = marks[i].at; r.sm = sv[i] ? sv[i].m : ''; });
  return results;
}

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  // the app asks this once when a village opens (warm() in index.html): starts this server and unlocks the village's
  // list into memory, so the person's first search doesn't wait for that. Nothing is read from Redis or sent back.
  if (b.warm) { load(v.data); return send(res, 200, { ok: true }); }
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });   // retired, opened on another phone, other village

  const named = !!(String(b.name || '').trim() || String(b.rel || '').trim());
  if (!named && !b.family && b.ward && !b.all && user.demo) return send(res, 403, { error: 'no_ward_list' });
  // this login doesn't pay for wards (wardFree in _lib.js); the superadmin's prices and name-order switch (wardCfg)
  const [wfree, wc] = await Promise.all([wardFree(user, v.slug), wardCfg()]);
  if (b.all && !user.demo && !wfree && Number(await redis('SISMEMBER', wardKey(user.id, v.slug), String(parseInt(b.ward, 10)))) !== 1) {
    return send(res, 402, { error: 'pay_ward', rs: wc.rs });
  }
  // name order (अ–ज्ञ) is bought on its own (wc.azRs, api/pay.js wardStart with az); switched off: only wards already bought in it
  const az = b.all && b.sort === 'az';
  if (az && !user.demo && !(wfree && wc.az) && Number(await redis('SISMEMBER', wardAzKey(user.id, v.slug), String(parseInt(b.ward, 10)))) !== 1) {
    return wc.az ? send(res, 402, { error: 'pay_az', rs: wc.azRs }) : send(res, 403, { error: 'az_off' });
  }
  // house-number order (मकान नंबर क्रम): the same, wc.hnRs / wc.hn
  const hn = b.all && b.sort === 'hn';
  if (hn && !user.demo && !(wfree && wc.hn) && Number(await redis('SISMEMBER', wardHnKey(user.id, v.slug), String(parseInt(b.ward, 10)))) !== 1) {
    return wc.hn ? send(res, 402, { error: 'pay_hn', rs: wc.hnRs }) : send(res, 403, { error: 'hn_off' });
  }
  if (b.all && user.demo) return send(res, 403, { error: 'no_pdf' });
  const use = await countSearch(req, user, b, named);
  if (use.error) return send(res, 429, use);
  const left = { searchId: use.searchId, left: use.left, bought: use.bought };

  // every voter of one ward, in box order, to print or save that ward's slips
  if (b.all) {
    const rows = load(v.data).rows.filter((r) => String(r.ward) === String(b.ward) && !r.del)
      .sort(az ? (x, y) => HI(x.hname || x.name || '', y.hname || y.name || '') || HI(x.hrel || x.relname || '', y.hrel || y.relname || '') || x.box - y.box
        : hn ? (x, y) => byHouse(x, y) || x.box - y.box : (x, y) => x.box - y.box);
    if (!rows.length) return send(res, 404, { error: 'no_ward' });
    return send(res, 200, { total: rows.length, results: rows.map(publicFields), ...left });
  }

  if (b.family) {
    const results = await withMarks(v.slug, family(v.data, b.family).slice(0, MAX_FAMILY), user.cand, user.survey);
    return send(res, 200, { total: results.length, results, perms: user.perms, survey: user.survey, ...left });
  }

  let hits = search(v.data, b);
  const filter = String(b.mark || '');
  if (filter === 'none' || MARKS.includes(filter)) {
    const marks = await allMarks(v.slug, user.cand, user.survey);
    hits = hits.filter((r) => !r.del && ((marks[markKey(r)] || {}).m || 'none') === filter);
  }
  const total = hits.length;
  let page, more, locked = false;
  if (named) {
    const limit = Math.min(total, MAX_NAMED);
    const offset = Math.min(Math.max(0, parseInt(b.offset, 10) || 0), limit);
    page = hits.slice(offset, Math.min(offset + PAGE, limit));
    more = offset + PAGE < limit;
  } else {
    const after = parseInt(b.after, 10) || 0;
    const rest = after ? hits.filter((r) => r.box > after) : hits;
    const open = wfree || Number(await redis('SISMEMBER', wardKey(user.id, v.slug), String(parseInt(b.ward, 10)))) === 1;
    const room = open ? PAGE : Math.max(0, Math.min(PAGE, FREE_WARD - (hits.length - rest.length)));   // free ones not shown yet
    page = rest.slice(0, room);
    more = rest.length > page.length && (open || hits.length - rest.length + page.length < FREE_WARD);
    locked = !open && rest.length > page.length && !more;
  }
  // marks and the wards paid for, read at the same time (wfree is known already, so not asked again)
  const [results, wp, wz, wh] = await Promise.all([withMarks(v.slug, page, user.cand, user.survey),
    wfree || wardsPaid(user, v.slug, false), wfree && wc.az ? true : wardsAz(user, v.slug, false),
    wfree && wc.hn ? true : wardsHn(user, v.slug, false)]);
  send(res, 200, { total, more, ...(locked ? { locked: true, rs: wc.rs } : {}), wc, results, wards: load(v.data).wards, perms: user.perms, survey: user.survey,
    wp, wz, wh, ...left });
});
