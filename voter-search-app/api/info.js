// POST {village} → {village: {slug, name, title, ps, zp, pollTime, wards}}   details shown on the lock screen and slips
// No voter data and no login needed. The list of villages is only given after login (unlock / check).
const { village, send, route } = require('./_lib.js');

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const { slug, name, title, ps, zp, pollTime, wards } = v;
  send(res, 200, { village: { slug, name, title, ps, zp, pollTime, wards } });
});
