// POST {village, token} → {active, name, admin, role, villages, reason}. The app calls this when it opens.
// reason when not active: 'login' (unknown/old token) | 'retired' | 'logged_out' | 'other_device' | 'other_village'
const { village, redis, whoIs, send, route } = require('./_lib.js');

module.exports = route(async (req, res, { token, village: slug }) => {
  const v = village(slug);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(token, v.slug);
  if (!user) return send(res, 200, { active: false, reason: 'login' });
  if (user.status !== 'ok') return send(res, 200, { active: false, reason: user.status });
  if (user.role !== 'super') await redis('HSET', `user:${user.id}`, 'lastSeen', new Date().toISOString());
  send(res, 200, { active: true, name: user.name, admin: !!user.admin, role: user.role, villages: user.villages });
});
