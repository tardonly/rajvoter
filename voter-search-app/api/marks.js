// POST {village, token, keys: ["<ward>:<box>", …]} → {marks: {"<ward>:<box>": {m: status, by, at, sm: survey mark on
// polling day}}, perms, survey}. The app asks this every minute
// (and when it comes back on screen) for the slips it is showing, so a mark an admin sets reaches every phone
// without a new search. perms lets the page follow permission changes the admin makes meanwhile.
const { village, whoIs, marksFor, send, route } = require('./_lib.js');

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });
  const keys = (Array.isArray(b.keys) ? b.keys : []).map(String).filter((k) => /^\d{1,3}:\d{1,4}$/.test(k)).slice(0, 1000);
  const vals = await marksFor(v.slug, keys, user.cand, user.survey);
  const sv = user.survey ? [] : await marksFor(v.slug, keys, user.cand, true);   // polling day: the survey mark too
  send(res, 200, { marks: Object.fromEntries(keys.map((k, i) => [k, { m: vals[i].m, by: vals[i].by, at: vals[i].at, sm: sv[i] ? sv[i].m : '' }])),
    perms: user.perms, survey: user.survey });
});
