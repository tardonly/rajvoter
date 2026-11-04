// POST {village, token} → {progress: [{key, name, candName, marks, wards: [{ward, total, done, coming, absent}]}]}
// वार्ड अनुसार प्रगति in the app: how many voters of each ward carry each mark. A person needs the "progress" permission
// and sees only their own group's marks (their candidate's, or the village's own when they have no candidate); an
// admin sees the village's own marks and then each candidate's, as on the admin page. Not in the demo.
// POST {village, token, status [, ward, offset]} → {total, more, rows, wards}
// मतदाता सूची in the app: the voters carrying that mark ('done' | 'coming' | 'absent') or none yet ('none'), 100 at a
// time, as in the admin page's मतदाता सूची tab, plus the per-ward counts for its buttons. Needs the "list" permission;
// a person sees their own group's marks, an admin the village's own. Not in the demo.
const { village, whoIs, send, route } = require('./_lib.js');
const { markSummary, markedList, candsOf, groupsOf } = require('./_progress.js');

module.exports = route(async (req, res, b) => {
  const v = village(b.village);
  if (!v) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });
  if (b.status) {
    if (v.demo || !user.perms.includes('list')) return send(res, 403, { error: 'no_list' });
    const cand = { id: user.admin ? '' : user.cand || '' };
    const list = await markedList(v.slug, cand.id, b.status, b.ward, b.offset);
    if (!list) return send(res, 400, { error: 'bad_mark' });
    return send(res, 200, { ...list, wards: (await markSummary(v.slug, cand)).wards });
  }
  if (v.demo || !user.perms.includes('progress')) return send(res, 403, { error: 'no_progress' });
  const groups = user.admin ? groupsOf([v.slug], await candsOf([v.slug]))
    : [{ slug: v.slug, cand: { id: user.cand || '', name: user.candName || '' } }];
  const progress = await Promise.all(groups.map((g) => markSummary(g.slug, g.cand)));
  send(res, 200, { progress: progress.map(({ key, name, candName, marks, wards }) => ({ key, name, candName, marks, wards })) });
});
