// POST {token, action, ...}   token = from logging in (api/unlock) as the superadmin or a village admin
// The superadmin manages everything. A village admin sees and manages only the users of their assigned villages.
//   action "list" [, village]          → {me: {role, name, villages}, users: [...], admins: [...] (superadmin only)}
//   action "add", village, name, phone → {user, password}   new user of one village (must be one of the admin's villages)
//   action "add_admin", name, phone, villages: [slug, ...] → {user, password}            (superadmin only)
//   action "villages", id, villages: [slug, ...]           → {user}   change an admin's villages (superadmin only)
//   action "reset",  id         → {user, password}   (new password for the same person; the old one stops working)
//   action "retire", id         → {ok}               (password stops working; the phone is logged out at once)
//   action "logout", id         → {ok}               (ends the person's current session; they can log in again)
//   action "phone",  id, phone  → {user}             (add or change the person's WhatsApp number; "" removes it)
// The password is shown to the admin once; only its hash is stored.
// Phone numbers are stored as digits with the country code, e.g. 919876543210, ready for a wa.me link.
const crypto = require('crypto');
const { village, redis, pwHash, whoIs, newPassword, getUser, blocked, failed, send, route } = require('./_lib.js');

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

async function freshPassword() {
  for (;;) {
    const pw = newPassword();
    if (!(await redis('GET', `pw:${pwHash(pw)}`))) return pw;
  }
}

const view = (u) => ({
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
    const users = all.filter((u) => u.role === 'user' && mayUse(u.village) && (!b.village || u.village === b.village)).map(view);
    const admins = isSuper ? all.filter((u) => u.role === 'admin').map(view) : undefined;
    return send(res, 200, { me: { role: me.role, name: me.name, villages: me.villages }, users, admins });
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
