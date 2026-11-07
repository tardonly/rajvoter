// Signing up with a mobile number on the login page.
// The page asks for the mobile number first ('lookup'). A number that already has a login of that village is told to
// type its password (forgotten → ask the admin); a new number gets its own login at once ('signup') with a few free
// searches: FREE_TIERS (_lib.js) by how many signed-up logins have not been given paid searches yet, and none for a
// number that already signed up elsewhere. For more searches the person pays the admin (WhatsApp button in the app) and
// an admin adds them on the admin page (api/admin.js "credits_add").
//   POST {action: 'info'}  → {villages}   for the start page's village choice
//   POST {action: 'lookup', village (optional on the start page), phone} → {exists, free}
//   POST {action: 'signup', village, phone, name} → {password, token, name, phone, villages, list, perms, prepaid, left}
// 10 lookups / sign-ups per internet address in 15 minutes, and 3 sign-ups a day.
// Keys: set "free" (signed-up logins not yet given paid searches), "signups:<ip>:<day>" → sign-ups today from there.
const { FREE_TIERS, phoneLogins, village, villageList, normPhone, newLogin, today, clientIp, redis, newSession, makeToken,
  deviceName, permsOf, blocked, failed, send, route } = require('./_lib.js');

const SIGNUPS_PER_DAY = 3;   // per internet address

// free searches for a new login: by how many signed-up logins have no paid searches yet; none if this number signed up
// before
async function freeSearches(phone) {
  if ((await phoneLogins(phone)).some((u) => u.self === '1')) return 0;
  const n = Number(await redis('SCARD', 'free')) || 0;
  const tier = FREE_TIERS.find((t) => n < t.upTo);
  return tier ? tier.searches : 0;
}
const realVillage = (s) => { const v = village(s); return v && !v.demo ? v : null; };

module.exports = route(async (req, res, b) => {
  if (b.action === 'info') return send(res, 200, { villages: villageList() });

  if (b.action === 'lookup') {
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    const v = b.village ? realVillage(b.village) : null;
    if (b.village && !v) return send(res, 404, { error: 'no_village' });
    await failed(req, 'lookup');
    const mine = (await phoneLogins(phone)).filter((u) => u.retired !== '1' && (!v || u.villages.includes(v.slug)));
    return send(res, 200, { exists: mine.length > 0, free: mine.length ? 0 : await freeSearches(phone) });
  }

  if (b.action === 'signup') {
    if (await blocked(req, 'lookup')) return send(res, 429, { error: 'too_many' });
    const v = realVillage(b.village);
    if (!v) return send(res, 400, { error: 'no_village' });
    const phone = normPhone(b.phone);
    if (!phone) return send(res, 400, { error: 'phone' });
    const name = String(b.name || '').trim().slice(0, 60);
    if (!name) return send(res, 400, { error: 'name' });
    if ((await phoneLogins(phone)).some((u) => u.retired !== '1' && u.villages.includes(v.slug))) return send(res, 409, { error: 'exists' });
    const k = `signups:${clientIp(req)}:${today()}`, n = await redis('INCR', k);
    await redis('EXPIRE', k, 86400);
    if (n > SIGNUPS_PER_DAY) return send(res, 429, { error: 'too_many' });
    const free = await freeSearches(phone);
    const { id, password } = await newLogin(['role', 'user', 'village', v.slug, 'credits', free, 'self', '1'], name, phone, 'self', '');
    await redis('SADD', 'free', id);
    const sid = newSession(), now = new Date().toISOString();
    await redis('HSET', `user:${id}`, 'session', sid, 'sessionAt', now, 'sessionIp', clientIp(req), 'sessionDevice', deviceName(req),
      'lastSeen', now, 'logins', 1);
    return send(res, 200, { password, token: makeToken(id, sid), name, phone, role: 'user', admin: false, villages: [v.slug],
      list: villageList([v.slug]), perms: permsOf({}), prepaid: true, left: free });
  }
  send(res, 400, { error: 'action' });
});
