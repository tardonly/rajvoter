// टीम: a team leader shares a WhatsApp link, workers ask to join, the leader taps जोड़ें and gives each one their wards.
// A team is a mark group (markHash in _lib.js): a candidate's, or a village's own when the leader has no candidate. Its
// leaders are the village's admins (and the superadmin) for the village's own group, and users with the "team"
// permission for their own candidate's group (or the village's own, when they have none).
// Joining changes nothing about how a worker pays: a signed-up worker keeps buying their own searches.
// Keys:  teamlink:<village>|<cand> → code   teamcode:<code> → "<village>|<cand>"   (नया लिंक बनाएं replaces both)
//        teamreq:<village>|<cand>  hash userId → time asked   (जुड़ने की अर्ज़ी)
//        teammem:<village>|<cand>  set of the team's userIds; a member's own fields: team "<village>|<cand>", wards "2,3"
//        (and teamask "<village>|<cand>" while their request waits)
//   POST {action: 'code', code} → {village, villageName, teamName}   no login: the join page's heading
//   POST {action: 'join', village, token, code} → {pending: true, teamName} | {joined: true, teamName}   a worker asks
//   POST {action: 'mine', village, token} → {team, teamName, pending, wards: [{ward, total, slip}], lead}   मेरा काम
//   POST {action: 'houses', village, token, ward} → {houses: [{house, head, n, left, key}]}   houses still waiting for slips
//   leaders, POST {village, token, action, …}:
//     'view' → {code, teamName, reqs: [{id, name, phone, at}], members: [{id, name, phone, wards, slip, total}], wards}
//     'accept' {id, wards} · 'reject' {id} · 'remove' {id} · 'wards' {id, wards} · 'newlink'  → the same as 'view'
const crypto = require('crypto');
const { village, redis, pipeline, whoIs, getUser, getUsers, getCand, candReach, allSlips, markKey, DEFAULT_PERMS, send, route } = require('../_lib.js');
const { load } = require('../_search.js');

const CODE_RE = /^[a-z0-9]{8}$/;
const groupKey = (slug, cand) => `${slug}|${cand || ''}`;
const masked = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `${d.slice(0, 2)}•••${d.slice(5)}` : ''; };
const wardList = (v, list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(',')).map((w) => parseInt(w, 10)))]
  .filter((w) => v.wards.includes(w)).sort((a, b) => a - b);

async function teamName(slug, cand) {
  const c = cand ? await getCand(cand) : null;
  return c ? c.name : village(slug).name;
}
// the group a login leads in this village, or null: admins lead the village's own group, "team" users their candidate's
function leads(user, slug) {
  if (user.demo || user.status !== 'ok') return null;
  if (user.admin) return { slug, cand: '' };
  if (user.perms.includes('team')) return { slug, cand: user.cand || '' };
  return null;
}
// per ward: voters on the roll, and how many of them got their slip (in this group's पर्ची दी set)
async function slipWards(slug, cand) {
  const given = await allSlips(slug, cand), per = {};
  for (const r of load(village(slug).data).rows) {
    if (r.del) continue;
    per[r.ward] ||= { ward: r.ward, total: 0, slip: 0 };
    per[r.ward].total++;
    if (given[markKey(r)]) per[r.ward].slip++;
  }
  return per;
}
async function linkCode(g, fresh) {
  let code = await redis('GET', `teamlink:${g}`);
  if (code && !fresh) return code;
  if (code) await redis('DEL', `teamcode:${code}`);
  code = crypto.randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(8, '0').slice(0, 8);
  await pipeline([['SET', `teamlink:${g}`, code], ['SET', `teamcode:${code}`, g]]);
  return code;
}
async function view(g, slug, cand) {
  const v = village(slug);
  const [code, reqFlat, memIds, name, per] = await Promise.all([linkCode(g), redis('HGETALL', `teamreq:${g}`), redis('SMEMBERS', `teammem:${g}`),
    teamName(slug, cand), slipWards(slug, cand)]);
  const reqAt = {};
  for (let i = 0; i < (reqFlat || []).length; i += 2) reqAt[reqFlat[i]] = reqFlat[i + 1];
  const [reqUsers, members] = await Promise.all([getUsers(Object.keys(reqAt)), getUsers(memIds || [])]);
  return {
    code, teamName: name, wards: v.wards,
    reqs: reqUsers.filter((u) => u.retired !== '1').map((u) => ({ id: u.id, name: u.name || '', phone: masked(u.phone), at: reqAt[u.id] }))
      .sort((x, y) => (x.at < y.at ? 1 : -1)),
    members: members.filter((u) => u.team === g && u.retired !== '1').map((u) => {
      const ws = wardList(v, u.wards);
      return { id: u.id, name: u.name || '', phone: masked(u.phone), wards: ws,
        slip: ws.reduce((n, w) => n + ((per[w] || {}).slip || 0), 0), total: ws.reduce((n, w) => n + ((per[w] || {}).total || 0), 0) };
    }).sort((x, y) => x.name.localeCompare(y.name, 'hi')),
  };
}

module.exports = route(async (req, res, b) => {
  if (b.action === 'code') {   // the join link's heading, before any login
    const g = CODE_RE.test(String(b.code || '')) ? await redis('GET', `teamcode:${b.code}`) : null;
    if (!g) return send(res, 404, { error: 'team_link' });
    const [slug, cand] = g.split('|');
    return send(res, 200, { village: slug, villageName: village(slug).name, teamName: await teamName(slug, cand) });
  }

  const v = village(b.village);
  if (!v || v.demo) return send(res, 404, { error: 'no_village' });
  const user = await whoIs(b.token, v.slug);
  if (!user) return send(res, 401, { error: 'login' });
  if (user.status !== 'ok') return send(res, 403, { error: user.status });

  if (b.action === 'join') {
    const g = CODE_RE.test(String(b.code || '')) ? await redis('GET', `teamcode:${b.code}`) : null;
    if (!g) return send(res, 404, { error: 'team_link' });
    const [slug, cand] = g.split('|');
    if (slug !== v.slug || user.role !== 'user' || user.village !== slug) return send(res, 400, { error: 'team_other' });   // admins lead, they don't join
    const name = await teamName(slug, cand);
    if ((await getUser(user.id)).team === g) return send(res, 200, { joined: true, teamName: name });
    await pipeline([['HSET', `teamreq:${g}`, user.id, new Date().toISOString()], ['HSET', `user:${user.id}`, 'teamask', g]]);
    return send(res, 200, { pending: true, teamName: name });
  }

  if (b.action === 'mine' || b.action === 'houses') {
    const me = await getUser(user.id) || {};
    const g = me.team || '';
    const [slug, cand] = g ? g.split('|') : [v.slug, user.cand || ''];
    const ws = slug === v.slug ? wardList(v, me.wards) : [];
    if (b.action === 'houses') {   // बाकी घर: houses of one of my wards with someone still waiting for a slip
      const ward = parseInt(b.ward, 10);
      if (!ws.includes(ward) && !leads(user, v.slug)) return send(res, 403, { error: 'not_your_ward' });
      const given = await allSlips(v.slug, cand), houses = new Map();
      for (const r of load(v.data).rows) {
        if (r.ward !== ward || r.del) continue;
        const h = String(r.house || '').trim() || `#${r.box}`;
        if (!houses.has(h)) houses.set(h, { house: h, head: null, n: 0, left: 0, key: markKey(r) });
        const x = houses.get(h);
        x.n++;
        if (!given[markKey(r)]) x.left++;
        // the family's name: its eldest man, else its eldest voter
        const age = Number(r.age) || 0, man = /^(M|पु)/i.test(String(r.sex || ''));
        if (!x.head || (man && !x.head.man) || (man === x.head.man && age > x.head.age)) x.head = { name: r.hname || r.name, age, man };
      }
      const list = [...houses.values()].filter((x) => x.left).map((x) => ({ ...x, head: x.head.name }))
        .sort((x, y) => (parseInt(x.house, 10) || 1e9) - (parseInt(y.house, 10) || 1e9) || String(x.house).localeCompare(String(y.house)));
      return send(res, 200, { ward, houses: list.slice(0, 400), more: list.length > 400, total: list.length });
    }
    const pending = !g && !!me.teamask && !!(await redis('HGET', `teamreq:${me.teamask}`, user.id));
    const per = ws.length ? await slipWards(v.slug, cand) : {};
    return send(res, 200, { team: !!g, teamName: g ? await teamName(slug, cand) : '', pending, lead: !!leads(user, v.slug),
      wards: ws.map((w) => ({ ward: w, total: (per[w] || {}).total || 0, slip: (per[w] || {}).slip || 0 })) });
  }

  // ---------- the leader's टीम screen ----------
  const lead = leads(user, v.slug);
  if (!lead) return send(res, 403, { error: 'no_team' });
  const g = groupKey(lead.slug, lead.cand);
  const member = async () => {   // the person the leader acts on: a login of this village
    const u = await getUser(String(b.id || ''));
    return u && u.role === 'user' && u.village === v.slug ? u : null;
  };
  if (b.action === 'newlink') await linkCode(g, true);
  else if (b.action === 'accept' || b.action === 'wards') {
    const u = await member();
    if (!u) return send(res, 404, { error: 'no_user' });
    if (b.action === 'wards' && u.team !== g) return send(res, 404, { error: 'no_user' });
    const fields = ['team', g, 'wards', wardList(v, b.wards).join(',')];
    if (b.action === 'accept') {
      fields.push('cand', lead.cand);
      if (u.perms === undefined) fields.push('perms', DEFAULT_PERMS.join(','));
      if (u.team && u.team !== g) await redis('SREM', `teammem:${u.team}`, u.id);   // from another team to this one
    }
    await pipeline([['HSET', `user:${u.id}`, ...fields], ['HDEL', `user:${u.id}`, 'teamask'], ['SADD', `teammem:${g}`, u.id], ['HDEL', `teamreq:${g}`, u.id]]);
    if (b.action === 'accept' && lead.cand) await candReach(lead.cand, u.villages);
  } else if (b.action === 'reject') {
    const id = String(b.id || '');
    await pipeline([['HDEL', `teamreq:${g}`, id], ...(/^[\w-]{1,64}$/.test(id) ? [['HDEL', `user:${id}`, 'teamask']] : [])]);
  }
  else if (b.action === 'remove') {
    const u = await member();
    if (u && u.team === g) {
      await pipeline([['HDEL', `user:${u.id}`, 'team', 'wards'], ['SREM', `teammem:${g}`, u.id], ...(lead.cand ? [['HSET', `user:${u.id}`, 'cand', '']] : [])]);
    }
  } else if (b.action !== 'view') return send(res, 400, { error: 'bad_action' });
  send(res, 200, await view(g, lead.slug, lead.cand));
});
