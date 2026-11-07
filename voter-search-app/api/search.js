// POST {village, token, name, rel, ward, mark, offset, after} → {total, more, results: [...up to 10 voters, each with its
//   status mark and who set it], wards, perms}
// POST {village, token, family: "<ward>:<box>"} → {total, results: everyone at that voter's house number in that ward}
// POST {village, token, ward, all: true} → {total, results: [every voter of that ward]}   (people allowed 'wardPdf')
// A ward with no name lists the whole ward in box order (only for people allowed 'ward'); it pages with after = the last
// box shown, so marking slips while going through a filtered list doesn't skip anyone. A name search pages through its
// best 250 matches. mark filters by status mark: 'none' (no mark yet) | 'done' | 'coming' | 'absent'.
// Voters struck off the roll (del 'E' | 'S' | 'R') are found and shown, tagged, but never in a mark filter or ward slips.
// Every search checks that the password behind the token is still active and that this phone holds its newest
// session, so retiring or logging in on another phone takes effect at once.
//
// Daily limit (users only; admins have none): what counts is one *search*, not one request. The server hands out a
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
const { DEMO, village, whoIs, MARKS, markKey, marksFor, allMarks, today, dailyLimit, credits, isPrepaid, paidKey, clientIp, pipeline, send, route } = require('./_lib.js');
const { load, search, family, publicFields } = require('./_search.js');

const PAGE = 10, MAX_NAMED = 250, MAX_FAMILY = 60, PER_MINUTE = 60;   // 10 slips at a time
const SEARCH_STEPS = 25, SEARCH_MINUTES = 10;

const fold = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const follows = (a, b) => a.startsWith(b) || b.startsWith(a);   // "mangi" ↔ "mangilal"; '' follows anything

// Counts this request against the person's limits: {searchId, left} to send back, or {error}.
async function countSearch(req, user, b, named) {
  const minuteKey = `rate:${user.id}:${Math.floor(Date.now() / 60000)}`;
  // a demo phone's searches are counted for good (30 days), not per day; its internet address is counted per day
  const prepaid = isPrepaid(user);   // signed-up / bought searches: counted for good, not per day
  const dayKey = user.demo ? `searches:${user.id}` : prepaid ? paidKey(user.id) : `searches:${user.id}:${today()}`, findKey = `find:${user.id}`;
  const ipKey = `demo-ip:${clientIp(req)}:${today()}`;
  const extra = !user.demo && !prepaid && credits(user) > 0;   // a daily limit plus bought searches, used after the day's
  const [, perMinute, curRaw, usedRaw, ipRaw, paidRaw] = await pipeline([['SET', minuteKey, 0, 'EX', 120, 'NX'], ['INCR', minuteKey],
    ['GET', findKey], ['GET', dayKey], ['GET', ipKey], ['GET', paidKey(user.id)]]);
  if (perMinute > PER_MINUTE) return { error: 'slow_down' };
  if (user.admin) return {};

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
    if (used >= limit && extra && paidUsed < credits(user)) { paidUsed++; cmds.push(['INCR', paidKey(user.id)]); }
    else {
      if (used >= limit || (user.demo && Number(ipRaw) >= DEMO.perIp)) {
        return { error: user.demo ? 'demo_limit' : prepaid ? 'credits' : 'limit', left: 0, ...(extra ? { bought: 0 } : {}) };
      }
      used++;
      if (!prepaid) cmds.push(['SET', dayKey, 0, 'EX', (user.demo ? 30 : 3) * 86400, 'NX']);
      cmds.push(['INCR', dayKey]);
    }
    if (user.demo) cmds.push(['SET', ipKey, 0, 'EX', 86400, 'NX'], ['INCR', ipKey]);
    if (!b.all) next = { id: crypto.randomBytes(8).toString('base64url'), n: 1, start: now, ...q };
  }
  if (next) cmds.push(['SET', findKey, JSON.stringify(next), 'EX', SEARCH_MINUTES * 60]);
  if (cmds.length) await pipeline(cmds);
  return { searchId: next ? next.id : '', left: Math.max(0, limit - used), ...(extra ? { bought: credits(user) - paidUsed } : {}) };
}

async function withMarks(slug, list, cand) {   // cand: the searcher's candidate group, whose marks they see
  const results = list.map(publicFields);
  const marks = await marksFor(slug, results.map(markKey), cand);
  results.forEach((r, i) => { r.mark = marks[i].m; r.markBy = marks[i].by; r.markAt = marks[i].at; });
  return results;
}

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });   // retired, opened on another phone, other village

  const named = !!(String(b.name || '').trim() || String(b.rel || '').trim());
  if (!named && !b.family && b.ward && !b.all && !user.perms.includes('ward')) return send(res, 403, { error: 'no_ward_list' });
  if (b.all && !user.perms.includes('wardPdf')) return send(res, 403, { error: 'no_pdf' });
  const use = await countSearch(req, user, b, named);
  if (use.error) return send(res, 429, use);
  const left = { searchId: use.searchId, left: use.left, bought: use.bought };

  // every voter of one ward, in box order, to print or save that ward's slips
  if (b.all) {
    const rows = load(v.data).rows.filter((r) => String(r.ward) === String(b.ward) && !r.del).sort((x, y) => x.box - y.box);
    if (!rows.length) return send(res, 404, { error: 'no_ward' });
    return send(res, 200, { total: rows.length, results: rows.map(publicFields), ...left });
  }

  if (b.family) {
    const results = await withMarks(v.slug, family(v.data, b.family).slice(0, MAX_FAMILY), user.cand);
    return send(res, 200, { total: results.length, results, perms: user.perms, ...left });
  }

  let hits = search(v.data, b);
  const filter = String(b.mark || '');
  if (filter === 'none' || MARKS.includes(filter)) {
    const marks = await allMarks(v.slug, user.cand);
    hits = hits.filter((r) => !r.del && ((marks[markKey(r)] || {}).m || 'none') === filter);
  }
  const total = hits.length;
  let page, more;
  if (named) {
    const limit = Math.min(total, MAX_NAMED);
    const offset = Math.min(Math.max(0, parseInt(b.offset, 10) || 0), limit);
    page = hits.slice(offset, Math.min(offset + PAGE, limit));
    more = offset + PAGE < limit;
  } else {
    const after = parseInt(b.after, 10) || 0;
    const rest = after ? hits.filter((r) => r.box > after) : hits;
    page = rest.slice(0, PAGE);
    more = rest.length > PAGE;
  }
  send(res, 200, { total, more, results: await withMarks(v.slug, page, user.cand), wards: load(v.data).wards, perms: user.perms, ...left });
});
