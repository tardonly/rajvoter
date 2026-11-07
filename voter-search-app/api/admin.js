// POST {token, action, ...}   token = from logging in (api/unlock) as the superadmin or a village admin
// The superadmin manages everything. A village admin sees and manages only the users of their assigned villages.
//   action "list" [, village]          → {me: {id, role, name, villages, marked}, users: [...], admins: [...] (superadmin only),
//                                         progress}   users carry perms, searchesToday, limit (today's, with any extra),
//                                         ownLimit ('' = default), extraToday and marked (slips with their marks)
//   action "add", village, name, phone → {user, password}   new user of one village (must be one of the admin's villages)
//   action "add_admin", name, phone, villages: [slug, ...] → {user, password}            (superadmin only)
//   action "villages", id, villages: [slug, ...]           → {user}   change an admin's villages (superadmin only)
//   action "reset",  id         → {user, password}   (new password for the same person; the old one stops working)
//   action "retire", id         → {ok}               (password stops working; the phone is logged out at once)
//   action "logout", id         → {ok}               (ends the person's current session; they can log in again)
//   action "phone",  id, phone  → {user}             (add or change the person's WhatsApp number; "" removes it)
//   action "perms",  id, perms  → {user}             (what a user may do: any of PERMS in _lib.js)
//   action "limit",  id, limit  → {user}             (searches a user may start per day; 0 or '' = the default)
//   action "extra",  id [, n]   → {user}             (n more searches, default 100, for today only)
//   action "clearMarks", village [, cand], status → {progress}   (removes every 'done' | 'coming' | 'absent' mark of the
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
//                                               e.g. paid to the admin; takes it out of the free sign-up count (FREE_TIERS)
//   (in "list": reqs = those requests of this admin's people, open ones first, plus the ones approved or rejected in the last 30 days,
//    each with the person's name and phone; doneRs = ₹ collected, doneByName = by whom; hand = added with खोज जोड़ें)
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
const { village, villageList, MARKS, PERMS, permsOf, allMarks, markHash, getCand, today, DAILY_SEARCHES, extraToday, dailyLimit, credits, isPrepaid, packPrice, newReqId, getReq, paidKey, normPhone, redis, pipeline, pwHash, whoIs, freshPassword, newLogin: makeLogin, getUser, blocked, failed,
  send, route } = require('./_lib.js');

// a village people and candidates can be added to: not a demo village ("demo-riri")
const realVillage = (s) => { const v = village(s); return v && !v.demo ? v : null; };
// list of village slugs from the request → only real villages, no repeats; null when none
function villageSlugs(list) {
  const ok = [...new Set((Array.isArray(list) ? list : []).filter((s) => realVillage(s)))];
  return ok.length ? ok : null;
}

const view = (u) => ({
  perms: u.role === 'user' ? permsOf(u) : PERMS.slice(), cand: u.role === 'user' ? u.cand || '' : '',
  limit: u.role === 'user' ? dailyLimit(u) : null, ownLimit: Number(u.limit) || '', extraToday: extraToday(u),
  defaultLimit: DAILY_SEARCHES,
  id: u.id, role: u.role, village: u.role === 'user' ? u.village || '' : '', villages: u.villages, name: u.name,
  phone: u.phone || '', created: u.created, lastSeen: u.lastSeen || null,
  by: u.by || '', byName: u.byName || '', credits: credits(u), prepaid: isPrepaid(u), bought: u.bought === '1', self: u.self === '1',   // signed-up logins: credits = free + paid searches in all, bought = was given paid ones   // who made this login (admin id 'admin' = the superadmin); older logins: ''
  retired: u.retired === '1', retiredAt: u.retiredAt || null,
  loggedIn: !!u.session && u.retired !== '1',
  sessionAt: u.sessionAt || null, sessionIp: u.sessionIp || null, sessionDevice: u.sessionDevice || null,
  logins: Number(u.logins || 0), kicks: Number(u.kicks || 0),
});

// a pack request as the admin page sees it
const reqView = ({ id, user, village: v, n, rs, created, status, doneAt, doneN, doneRs, doneBy, doneByName, hand }) =>
  ({ id, user, village: v, n: Number(n), rs: Number(rs), created, status, doneAt: doneAt || null, doneN: Number(doneN) || 0,
    doneRs: Number(doneRs) || 0, doneBy: doneBy || '', doneByName: doneByName || '', hand: hand === '1' });
const REQ_DONE_DAYS = 30;   // approved requests stay in the list this long

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
  const now = new Date().toISOString();
  // a new login made by this admin: fields = role and village(s) [and more]; → {id, password}
  const newLogin = (fields, name, phone) => makeLogin(fields, name, phone, me.id, me.name);
  // n bought searches for person u, paid to this admin: the searches, and the payment recorded in request r (none: a
  // hand-added one, which gets its own request, already approved) and in the pay:* totals (see _lib.js)
  async function paidIn(u, n, r) {
    const rs = packPrice(n);
    await redis('HINCRBY', `user:${u.id}`, 'credits', n);
    await redis('HSET', `user:${u.id}`, 'bought', '1');
    await redis('SREM', 'free', u.id);
    const id = r ? r.id : await newReqId();
    if (!r) {
      await redis('HSET', `req:${id}`, 'user', u.id, 'village', u.village, 'n', n, 'rs', rs, 'created', now, 'hand', '1');
      await redis('SADD', 'reqs', id);
    }
    await redis('HSET', `req:${id}`, 'status', 'done', 'doneAt', now, 'doneN', n, 'doneRs', rs, 'doneBy', me.id, 'doneByName', me.name);
    await redis('HINCRBY', 'pay:rs', me.id, rs);
    await redis('HINCRBY', 'pay:n', me.id, n);
    await redis('HINCRBY', 'pay:count', me.id, 1);
    await redis('HSET', 'pay:name', me.id, me.name);
  }

  if (b.action === 'list') {
    const ids = (await redis('SMEMBERS', 'users')) || [];
    const all = (await Promise.all(ids.map(getUser))).filter(Boolean).sort((x, y) => (x.created < y.created ? 1 : -1));
    // marks of my villages (each candidate's apart): progress, and how many slips each person marked
    const cands = await candsOf(me.villages), groups = groupsOf(me.villages, cands);
    const marksBy = await Promise.all(groups.map((g) => allMarks(g.slug, g.cand.id)));
    const progress = await Promise.all(groups.map((g, i) => markSummary(g.slug, g.cand, marksBy[i])));
    const marked = {};
    for (const m of marksBy) for (const { byId } of Object.values(m)) if (byId) marked[byId] = (marked[byId] || 0) + 1;
    const day = today();
    const searches = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, Number(await redis('GET', `searches:${id}:${day}`)) || 0])));
    const paid = Object.fromEntries(await Promise.all(all.filter((u) => isPrepaid(u)).map(async (u) => [u.id, Number(await redis('GET', paidKey(u.id))) || 0])));
    const withUse = (u) => ({ ...view(u), searchesToday: searches[u.id] || 0, paidUsed: paid[u.id] || 0, marked: marked[u.id] || 0 });
    const users = all.filter((u) => u.role === 'user' && mayUse(u.village) && (!b.village || u.village === b.village)).map(withUse);
    const admins = isSuper ? all.filter((u) => u.role === 'admin').map(withUse) : undefined;
    // pack requests of the people this admin manages: every open one, and those approved in the last REQ_DONE_DAYS
    const mine = new Map(all.filter((u) => u.role === 'user' && mayUse(u.village)).map((u) => [u.id, u]));
    const reqIds = (await redis('SMEMBERS', 'reqs')) || [];
    const reqRows = reqIds.length ? await pipeline(reqIds.map((id) => ['HGETALL', `req:${id}`])) : [];
    const since = new Date(Date.now() - REQ_DONE_DAYS * 864e5).toISOString();
    const reqs = reqIds.map((id, i) => {
      const r = { id }, arr = reqRows[i] || [];
      for (let k = 0; k < arr.length; k += 2) r[arr[k]] = arr[k + 1];
      const u = mine.get(r.user);   // a person of my villages, asking from one of my villages
      if (!u || !mayUse(r.village) || (r.status !== 'open' && !(r.doneAt > since))) return null;
      return { ...reqView(r), name: u.name, phone: u.phone || '' };
    }).filter(Boolean).sort((a, b) => ((a.status === 'open') !== (b.status === 'open') ? (a.status === 'open' ? -1 : 1)
      : (a.status === 'open' ? a.created : a.doneAt) < (b.status === 'open' ? b.created : b.doneAt) ? 1 : -1)).slice(0, 300);
    // payments collected so far, per admin (pay:* in _lib.js), and what each has handed over; a village admin sees only
    // their own
    let collected;
    {
      const [rsH, nH, cH, nameH, sH] = await pipeline(['pay:rs', 'pay:n', 'pay:count', 'pay:name', 'pay:settled'].map((k) => ['HGETALL', k]));
      const h = (arr) => { const o = {}; for (let k = 0; k < (arr || []).length; k += 2) o[arr[k]] = arr[k + 1]; return o; };
      const rsO = h(rsH), nO = h(nH), cO = h(cH), nameO = h(nameH), sO = h(sH);
      const nameOf = (id) => (id === 'admin' ? 'सुपर एडमिन' : (all.find((u) => u.id === id) || {}).name || nameO[id] || id);
      collected = Object.keys(rsO).map((id) => ({ by: id, name: nameOf(id), rs: Number(rsO[id]) || 0, n: Number(nO[id]) || 0, count: Number(cO[id]) || 0,
        settled: Number(sO[id]) || 0, due: id === 'admin' ? 0 : (Number(rsO[id]) || 0) - (Number(sO[id]) || 0) }))
        .filter((c) => isSuper || c.by === me.id).sort((a, b) => b.rs - a.rs);
    }
    return send(res, 200, { me: { id: me.id, role: me.role, name: me.name, villages: me.villages, marked: marked[me.id] || 0 }, users, admins, reqs, collected,
      villageList: villageList(me.villages), progress, cands: cands.map(({ id, name, village: v, created }) => ({ id, name, village: v, created })) });
      // villageList: names of my villages (the list is not public)
  }

  // the mark group a request names: the village's own marks (no cand) or one of its candidates'
  async function groupOf() {
    if (!realVillage(b.village)) return { error: [400, 'no_village'] };
    if (!mayUse(b.village)) return { error: [403, 'not_your_village'] };
    if (!b.cand) return { cand: { id: '' } };
    const c = await getCand(b.cand);
    return c && c.village === b.village ? { cand: c } : { error: [404, 'no_cand'] };
  }

  if (b.action === 'marked') {
    const g = await groupOf();
    if (g.error) return send(res, g.error[0], { error: g.error[1] });
    const list = await markedList(b.village, g.cand.id, b.status, b.ward, b.offset);
    if (!list) return send(res, 400, { error: 'bad_mark' });
    return send(res, 200, list);
  }

  if (b.action === 'clearMarks' || b.action === 'restoreMarks') {
    const g = await groupOf();
    if (g.error) return send(res, g.error[0], { error: g.error[1] });
    const key = markHash(b.village, g.cand.id), backupKey = `${key}:backup`;
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
    const groups = groupsOf(me.villages, await candsOf(me.villages));
    return send(res, 200, { progress: await Promise.all(groups.map((x) => markSummary(x.slug, x.cand))) });
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
    for (const u of (await Promise.all(ids.map(getUser))).filter((u) => u && u.cand === c.id)) await redis('HSET', `user:${u.id}`, 'cand', '');
    await redis('DEL', markHash(c.village, c.id));
    await redis('DEL', `${markHash(c.village, c.id)}:backup`);
    await redis('SREM', 'cands', c.id);
    await redis('DEL', `cand:${c.id}`);
    return send(res, 200, { ok: true });
  }

  if (b.action === 'add' || b.action === 'add_admin') {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    const phone = normPhone(b.phone);
    if (phone === null) return send(res, 400, { error: 'phone' });
    let fields;
    if (b.action === 'add') {
      if (!realVillage(b.village)) return send(res, 400, { error: 'no_village' });
      if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
      fields = ['role', 'user', 'village', b.village];
      if (b.cand) {   // straight into a candidate's group
        const c = await getCand(b.cand);
        if (!c || c.village !== b.village) return send(res, 404, { error: 'no_cand' });
        fields.push('cand', c.id);
      }
    } else {
      if (!isSuper) return send(res, 403, { error: 'super_only' });
      const vs = villageSlugs(b.villages);
      if (!vs) return send(res, 400, { error: 'no_village' });
      fields = ['role', 'admin', 'villages', vs.join(',')];
    }
    const { id, password } = await newLogin(fields, name, phone);
    return send(res, 200, { user: view(await getUser(id)), password });
  }

  if (b.action === 'req_get' || b.action === 'req_approve' || b.action === 'req_reject') {
    const r = await getReq(b.rid), u = r ? await getUser(r.user) : null;
    if (!u || !(isSuper || (u.role === 'user' && mayUse(u.village) && mayUse(r.village)))) return send(res, 404, { error: 'not_found' });
    if (b.action === 'req_get') return send(res, 200, { req: reqView(r) });
    if (r.status !== 'open') return send(res, 409, { error: 'already_done', req: reqView(r) });
    if (b.action === 'req_reject') {   // e.g. no payment came: closed without searches, kept in the list as rejected
      if (!(await redis('SET', `reqlock:${r.id}`, me.id, 'NX'))) return send(res, 409, { error: 'already_done', req: reqView(await getReq(r.id)) });
      await redis('HSET', `req:${r.id}`, 'status', 'rejected', 'doneAt', now, 'doneBy', me.id, 'doneByName', me.name);
      await redis('DEL', `reqopen:${u.id}:${r.n}`);
      return send(res, 200, { req: reqView(await getReq(r.id)) });
    }
    if (!isPrepaid(u)) return send(res, 400, { error: 'not_prepaid' });
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
    const people = new Map(await Promise.all([...new Set(done.map((r) => r.user))].map(async (id) => [id, await getUser(id)])));
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
  if (!user || !(isSuper || (user.role === 'user' && mayUse(user.village)))) return send(res, 404, { error: 'not_found' });

  if (b.action === 'villages') {
    if (!isSuper) return send(res, 403, { error: 'super_only' });
    if (user.role !== 'admin') return send(res, 400, { error: 'not_admin' });
    const vs = villageSlugs(b.villages);
    if (!vs) return send(res, 400, { error: 'no_village' });
    await redis('HSET', `user:${user.id}`, 'villages', vs.join(','));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'move') {   // a person to another village: their candidate (of the old village) goes, and they log in again
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });
    if (!realVillage(b.village)) return send(res, 400, { error: 'no_village' });
    if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
    if (b.village !== user.village) await redis('HSET', `user:${user.id}`, 'village', b.village, 'cand', '', 'session', '');
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
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'perms') {
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });   // admins can always do everything
    const perms = PERMS.filter((p) => Array.isArray(b.perms) && b.perms.includes(p));
    await redis('HSET', `user:${user.id}`, 'perms', perms.join(','));
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'credits_add') {
    if (!isPrepaid(user)) return send(res, 400, { error: 'not_prepaid' });   // admin-made logins have a daily limit
    const n = parseInt(b.n, 10);
    if (!(n > 0 && n <= 10000)) return send(res, 400, { error: 'bad_credits' });
    await paidIn(user, n, null);
    return send(res, 200, { user: view(await getUser(user.id)) });
  }

  if (b.action === 'limit' || b.action === 'extra') {
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });   // admins have no limit
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
    await redis('HSET', `user:${user.id}`, 'hash', hash, 'retired', '0', 'session', '');
    await redis('SET', `pw:${hash}`, user.id);
    return send(res, 200, { user: view(await getUser(user.id)), password });
  }

  if (b.action === 'phone') {
    const phone = normPhone(b.phone);
    if (phone === null) return send(res, 400, { error: 'phone' });
    await redis('HSET', `user:${user.id}`, 'phone', phone);
    return send(res, 200, { user: view(await getUser(user.id)) });
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
