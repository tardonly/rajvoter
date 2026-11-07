// POST {village, token} → {active, name, admin, role, villages, perms, cand (the user's candidate's name, or ''), reason, demo,
//   left (demo searches remaining, or bought searches remaining with prepaid: true), bought (a login with a daily limit:
//   its bought searches remaining), canBuy, adminPhone (canBuy: whom to ask for more searches on WhatsApp, '' → the
//   app's number)}. The app calls this when it opens.
// POST {token} (the start page) → the same, with list = the villages this login opens.
// reason when not active: 'login' (unknown/old token) | 'retired' | 'logged_out' | 'other_device' | 'other_village'
const { DEMO, village, villageList, isPrepaid, canBuy, adminPhone, creditsLeft, redis, whoIs, send, route } = require('./_lib.js');

module.exports = route(async (req, res, { token, village: slug }) => {
  const v = slug ? village(slug) : null;
  if (slug && !v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(token, v ? v.slug : null);
  if (!user) return send(res, 200, { active: false, reason: 'login' });
  if (user.status !== 'ok') return send(res, 200, { active: false, reason: user.status });
  if (user.role !== 'super' && !user.demo) await redis('HSET', `user:${user.id}`, 'lastSeen', new Date().toISOString());
  const prepaid = isPrepaid(user), buys = canBuy(user);
  const left = user.demo ? Math.max(0, DEMO.searches - (Number(await redis('GET', `searches:${user.id}`)) || 0))
    : prepaid ? await creditsLeft(user) : undefined;
  send(res, 200, { active: true, demo: !!user.demo, prepaid, left, canBuy: buys, bought: buys && !prepaid ? await creditsLeft(user) : undefined,
    name: user.name, phone: user.phone || '', adminPhone: buys ? await adminPhone(user) : '', admin: !!user.admin, role: user.role, villages: user.villages,
    list: villageList(user.villages), perms: user.perms, cand: user.candName || '' });
});
