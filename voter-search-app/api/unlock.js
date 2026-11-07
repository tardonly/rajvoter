// POST {village, password} → {name, token, admin, role, villages} for an active password of that village,
//   a village admin of that village, or the superadmin password.
// POST {password} (no village, from the admin page) → the same, but only for the superadmin or a village admin.
// POST {password, home: true} (the start page) → the same for any active password; list = the villages it opens.
// POST {village: 'demo' or 'demo-<village>', device} → a demo login for that phone (device = a random id the phone keeps),
//   with left = how many of its demo searches remain and list = the demo villages. No password.
// A password of another village → 403 {error: 'other_village', village, villageName} so the app can point there.
// Each login starts a new session; a phone still using an older session of the same password is logged out
// on its next request. The token is sent with every search; an admin token also opens the admin page.
const { isPrepaid, creditsLeft, getCand, DEMO, demoSlugs, isDevice, demoId, village, villageList, PERMS, permsOf, redis, pwHash, newSession, makeToken, isAdminPassword, adminToken, getUser, clientIp,
  deviceName, blocked, failed, send, route } = require('./_lib.js');

const STILL_IN_USE_MS = 30 * 60 * 1000;   // previous phone used within 30 min → counts as "two phones at once"

module.exports = route(async (req, res, { password, village: slug, home, device }) => {
  const v = slug ? village(slug) : null;
  if (slug === DEMO.slug || (v && v.demo)) {
    if (!isDevice(device)) return send(res, 400, { error: 'device' });
    const used = Number(await redis('GET', `searches:${demoId(device)}`)) || 0;
    return send(res, 200, { name: 'डेमो', token: makeToken(demoId(device), 'demo'), admin: false, role: 'user', demo: true,
      villages: demoSlugs(), list: demoSlugs().map((s) => village(s)).map(({ slug: s, name, title, panchayatSamiti, district }) =>
        ({ slug: s, name, title, panchayatSamiti: panchayatSamiti || '', district: district || '' })),
      perms: [], left: Math.max(0, DEMO.searches - used) });
  }
  if (slug && !v) return send(res, 404, { error: 'no_village' });
  if (await blocked(req, 'unlock')) return send(res, 429, { error: 'too_many' });
  if (isAdminPassword(password)) {
    const list = villageList();
    return send(res, 200, { name: 'सुपर एडमिन', token: adminToken(), admin: true, role: 'super', villages: list.map((x) => x.slug), list, perms: PERMS.slice() });
  }
  const id = password ? await redis('GET', `pw:${pwHash(password)}`) : null;
  const user = id ? await getUser(id) : null;
  if (!user) {
    await failed(req, 'unlock');
    return send(res, 401, { error: 'wrong' });
  }
  if (user.retired === '1') return send(res, 403, { error: 'retired' });
  if (v && !user.villages.includes(v.slug)) {
    const own = village(user.villages[0]);
    return send(res, 403, { error: 'other_village', village: own ? own.slug : '', villageName: own ? own.name : '' });
  }
  if (!v && !home && user.role !== 'admin') return send(res, 403, { error: 'not_admin' });   // a person's password on the admin page

  const now = new Date(), sid = newSession();
  const cand = user.role === 'user' && user.cand ? await getCand(user.cand) : null;   // shown on the app's top bar
  const stillInUse = !!user.session && !!user.lastSeen && now - Date.parse(user.lastSeen) < STILL_IN_USE_MS;
  await redis('HSET', `user:${id}`, 'session', sid, 'sessionAt', now.toISOString(), 'sessionIp', clientIp(req),
    'sessionDevice', deviceName(req), 'lastSeen', now.toISOString());
  await redis('HINCRBY', `user:${id}`, 'logins', 1);
  if (stillInUse) await redis('HINCRBY', `user:${id}`, 'kicks', 1);
  const prepaid = isPrepaid(user);   // signed-up / bought searches: how many are left
  send(res, 200, { name: user.name, phone: user.phone || '', token: makeToken(id, sid), admin: user.role === 'admin', role: user.role, villages: user.villages,
    prepaid, left: prepaid ? await creditsLeft(user) : undefined,
    list: villageList(user.villages), perms: user.role === 'admin' ? PERMS.slice() : permsOf(user),
    cand: cand && cand.village === user.village ? cand.name : '' });
});
