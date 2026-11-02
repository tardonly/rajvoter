// POST {village} → {village: {slug, name, title, ps, zp, pollTime, wards}}   details shown on the lock screen and slips
// POST {}        → {villages: [{slug, name, title}]}                         list for the start page
// No voter data and no login needed.
const { village, villageList, send, route } = require('./_lib.js');

module.exports = route(async (req, res, b) => {
  if (!b.village) return send(res, 200, { villages: villageList() });
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village', villages: villageList() });
  const { slug, name, title, ps, zp, pollTime, wards } = v;
  send(res, 200, { village: { slug, name, title, ps, zp, pollTime, wards } });
});
