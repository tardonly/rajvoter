// POST {token, action, ...}   token = from logging in (api/unlock) as the superadmin or a village admin
// The superadmin manages everything. A village admin sees and manages only the users of their assigned villages.
//   action "list" [, village]          → {me: {role, name, villages, marked}, users: [...], admins: [...] (superadmin only),
//                                         progress}   users carry perms, searchesToday, limit (today's, with any extra),
//                                         ownLimit ('' = default), extraToday and marked (slips with their marks)
//   action "add", village, name, phone → {user, password}   new user of one village (must be one of the admin's villages)
//   action "add_admin", name, phone, villages: [slug, ...] → {user, password}            (superadmin only)
//   action "villages", id, villages: [slug, ...]           → {user}   change an admin's villages (superadmin only)
//   action "reset",  id         → {user, password}   (new password for the same person; the old one stops working)
//   action "retire", id         → {ok}               (password stops working; the phone is logged out at once)
//   action "logout", id         → {ok}               (ends the person's current session; they can log in again)
//   action "phone",  id, phone  → {user}             (add or change the person's WhatsApp number; "" removes it)
//   action "perms",  id, perms  → {user}             (what a user may do: any of 'mark', 'ward', 'wardPdf', 'print')
//   action "limit",  id, limit  → {user}             (searches a user may start per day; 0 or '' = the default)
//   action "extra",  id [, n]   → {user}             (n more searches, default 100, for today only)
//   action "clearMarks", village, status → {progress}   (removes every 'done' | 'coming' | 'absent' mark of the village,
//                                                       or 'all' of them; the removed marks are kept as a backup first)
//   action "restoreMarks", village       → {progress}   (puts back the marks removed by that village's last clearMarks)
//   action "marked", village, status [, ward, offset] → {total, more, rows}   voters carrying a mark ('done' | 'coming' |
//                                         'absent') or none yet ('none'), in ward and box order, LIST_PAGE at a time
// progress: [{slug, name, marks: {done, coming, absent}, wards: [{ward, total, done, coming, absent}], backup: {n, at} | null}]
//   one entry per village of this admin: how many slips carry each mark, overall and per ward.
// The password is shown to the admin once; only its hash is stored.
// Phone numbers are stored as digits with the country code, e.g. 919876543210, ready for a wa.me link.
const crypto = require('crypto');
const { load } = require('./_search.js');
const { village, villageList, MARKS, PERMS, permsOf, allMarks, today, DAILY_SEARCHES, extraToday, dailyLimit, redis, pwHash, whoIs, newPassword, getUser, blocked, failed,
  send, route } = require('./_lib.js');

// "98765 43210", "098765-43210", "+91 98765 43210" → "919876543210"; '' when empty; null when not a valid number
function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && /^[6-9]/.test(d)) return '91' + d;
  if (d.length === 11 && d.startsWith('0')) return normPhone(d.slice(1));
  if (d.length === 12 && d.startsWith('91')) return normPhone(d.slice(2));
  if (!d.startsWith('91') && d.length >= 11 && d.length <= 15) return d;   // other countries, already with code
  return null;
}
// list of village slugs from the request → only real villages, no repeats; null when none
function villageSlugs(list) {
  const ok = [...new Set((Array.isArray(list) ? list : []).filter((s) => village(s)))];
  return ok.length ? ok : null;
}

// how many slips of a village carry each mark, overall and per ward, and the backup its last "clear" left
async function markSummary(slug, all) {
  all ||= await allMarks(slug);
  const zero = () => Object.fromEntries(MARKS.map((m) => [m, 0]));
  const marks = zero(), perWard = {};
  const onRoll = new Set();
  for (const r of load(slug).rows) {
    perWard[r.ward] ||= { ward: r.ward, total: 0, ...zero() };
    if (r.del) continue;   // struck off the roll: not counted
    perWard[r.ward].total++;
    onRoll.add(`${r.ward}:${r.box}`);
  }
  for (const [key, { m }] of Object.entries(all)) {
    if (!MARKS.includes(m) || !onRoll.has(key)) continue;
    marks[m]++;
    const w = perWard[key.split(':')[0]];
    if (w) w[m]++;
  }
  const bk = await redis('GET', `mark:${slug}:backup`);
  let backup = null;
  try { if (bk) { const j = JSON.parse(bk); backup = { n: j.flat.length / 2, at: j.at }; } } catch (e) { /* ignore a broken backup */ }
  return { slug, name: village(slug).name, marks, wards: Object.values(perWard).sort((a, b) => a.ward - b.ward), backup };
}

const LIST_PAGE = 100;   // voters per page in the "marked" list

async function freshPassword() {
  for (;;) {
    const pw = newPassword();
    if (!(await redis('GET', `pw:${pwHash(pw)}`))) return pw;
  }
}

const view = (u) => ({
  perms: u.role === 'user' ? permsOf(u) : PERMS.slice(),
  limit: u.role === 'user' ? dailyLimit(u) : null, ownLimit: Number(u.limit) || '', extraToday: extraToday(u),
  defaultLimit: DAILY_SEARCHES,
  id: u.id, role: u.role, village: u.role === 'user' ? u.village || '' : '', villages: u.villages, name: u.name,
  phone: u.phone || '', created: u.created, lastSeen: u.lastSeen || null,
  retired: u.retired === '1', retiredAt: u.retiredAt || null,
  loggedIn: !!u.session && u.retired !== '1',
  sessionAt: u.sessionAt || null, sessionIp: u.sessionIp || null, sessionDevice: u.sessionDevice || null,
  logins: Number(u.logins || 0), kicks: Number(u.kicks || 0),
});

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

  if (b.action === 'list') {
    const ids = (await redis('SMEMBERS', 'users')) || [];
    const all = (await Promise.all(ids.map(getUser))).filter(Boolean).sort((x, y) => (x.created < y.created ? 1 : -1));
    // marks of my villages: progress, and how many slips each person marked
    const marksBy = await Promise.all(me.villages.map((s) => allMarks(s)));
    const progress = await Promise.all(me.villages.map((s, i) => markSummary(s, marksBy[i])));
    const marked = {};
    for (const m of marksBy) for (const { byId } of Object.values(m)) if (byId) marked[byId] = (marked[byId] || 0) + 1;
    const day = today();
    const searches = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, Number(await redis('GET', `searches:${id}:${day}`)) || 0])));
    const withUse = (u) => ({ ...view(u), searchesToday: searches[u.id] || 0, marked: marked[u.id] || 0 });
    const users = all.filter((u) => u.role === 'user' && mayUse(u.village) && (!b.village || u.village === b.village)).map(withUse);
    const admins = isSuper ? all.filter((u) => u.role === 'admin').map(withUse) : undefined;
    return send(res, 200, { me: { role: me.role, name: me.name, villages: me.villages, marked: marked[me.id] || 0 }, users, admins,
      villageList: villageList(me.villages), progress });   // names of my villages (the list is not public)
  }

  if (b.action === 'marked') {
    if (!village(b.village)) return send(res, 400, { error: 'no_village' });
    if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
    if (b.status !== 'none' && !MARKS.includes(b.status)) return send(res, 400, { error: 'bad_mark' });
    const all = await allMarks(b.village);
    const want = (r) => {
      const m = all[`${r.ward}:${r.box}`];
      return b.status === 'none' ? !(m && MARKS.includes(m.m)) : !!m && m.m === b.status;
    };
    const hits = load(b.village).rows.filter((r) => !r.del && (!b.ward || String(r.ward) === String(b.ward)) && want(r))
      .sort((x, y) => x.ward - y.ward || x.box - y.box);
    const offset = Math.max(0, Number(b.offset) || 0);
    const rows = hits.slice(offset, offset + LIST_PAGE).map(({ ward, box, hname, name, hrel, relname, rel, house, age, sex }) => {
      const m = all[`${ward}:${box}`];
      return { ward, box, hname, name, hrel, relname, rel, house, age, sex, by: m ? m.by : '', at: m ? m.at : '' };
    });
    return send(res, 200, { total: hits.length, more: offset + rows.length < hits.length, rows });
  }

  if (b.action === 'clearMarks' || b.action === 'restoreMarks') {
    if (!village(b.village)) return send(res, 400, { error: 'no_village' });
    if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
    const key = `mark:${b.village}`, backupKey = `mark:${b.village}:backup`;
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
    return send(res, 200, { progress: await Promise.all(me.villages.map((s) => markSummary(s))) });
  }

  if (b.action === 'add' || b.action === 'add_admin') {
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    const phone = normPhone(b.phone);
    if (phone === null) return send(res, 400, { error: 'phone' });
    let fields;
    if (b.action === 'add') {
      if (!village(b.village)) return send(res, 400, { error: 'no_village' });
      if (!mayUse(b.village)) return send(res, 403, { error: 'not_your_village' });
      fields = ['role', 'user', 'village', b.village];
    } else {
      if (!isSuper) return send(res, 403, { error: 'super_only' });
      const vs = villageSlugs(b.villages);
      if (!vs) return send(res, 400, { error: 'no_village' });
      fields = ['role', 'admin', 'villages', vs.join(',')];
    }
    const id = crypto.randomBytes(5).toString('hex');
    const password = await freshPassword(), hash = pwHash(password);
    await redis('HSET', `user:${id}`, ...fields, 'name', name, 'phone', phone, 'created', now, 'retired', '0', 'hash', hash);
    await redis('SET', `pw:${hash}`, id);
    await redis('SADD', 'users', id);
    return send(res, 200, { user: view(await getUser(id)), password });
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

  if (b.action === 'perms') {
    if (user.role !== 'user') return send(res, 400, { error: 'not_user' });   // admins can always do everything
    const perms = PERMS.filter((p) => Array.isArray(b.perms) && b.perms.includes(p));
    await redis('HSET', `user:${user.id}`, 'perms', perms.join(','));
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
