// POST {village, token} → {ok}. Ends this phone's session, so logging in again later isn't counted as a second phone.
const { redis, whoIs, send, route } = require('./_lib.js');

module.exports = route(async (req, res, { token, village }) => {
  const user = await whoIs(token, village || null);
  if (user && user.role !== 'super' && !user.demo && user.status === 'ok') await redis('HSET', `user:${user.id}`, 'session', '');
  send(res, 200, { ok: true });
});
