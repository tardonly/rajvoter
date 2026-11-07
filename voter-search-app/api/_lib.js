// Shared helpers for the API routes (files starting with "_" are not routes on Vercel).
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   DATA_KEY        the key that unlocks the village data in api/_data/ (from app-build/DATA_KEY.txt)
//   ADMIN_PASSWORD  the superadmin password: manages every village and creates the village admins
//   KV_REST_API_URL / KV_REST_API_TOKEN  added automatically when you connect Upstash for Redis in Vercel
//   KEY_PREFIX      optional, default "rv:": put in front of every database key, so this app can share one
//                   Upstash database with another app (e.g. the older single-village Adsar app) without mixing data
const crypto = require('crypto');

// Vercel may add the database variables with a custom prefix (e.g. STORAGE_KV_REST_API_URL), so accept those too.
function findEnv(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  for (const [k, v] of Object.entries(process.env)) if (v && names.some((n) => k.endsWith('_' + n))) return v;
  return null;
}
const DB_URL = findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const DB_TOKEN = findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);
const KEY_PREFIX = process.env.KEY_PREFIX ?? 'rv:';

// Every command the app uses takes exactly one key, right after the command name; that key gets KEY_PREFIX.
const prefixed = ([name, key, ...args]) => [name, KEY_PREFIX + key, ...args].map(String);
async function dbPost(path, body) {
  if (!DB_URL || !DB_TOKEN) {
    const seen = Object.keys(process.env).filter((k) => /KV|REDIS|UPSTASH/.test(k)).join(', ') || 'none';
    throw new Error(`database not connected (database variables found: ${seen})`);
  }
  const r = await fetch(DB_URL + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function redis(...cmd) {
  const j = await dbPost('', prefixed(cmd));
  if (j.error) throw new Error(j.error);
  return j.result;
}
// several commands in one round trip (Upstash's /pipeline): [[name, key, ...args], ...] → their results, in order
async function pipeline(cmds) {
  const j = await dbPost('/pipeline', cmds.map(prefixed));
  if (!Array.isArray(j)) throw new Error(j.error || 'pipeline');
  return j.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

// Villages built into the app (by app-build/encrypt.mjs): slug → {name, title, ps, zp, pollTime, wards, voters}
const VILLAGES = require('./_villages.json');
// The marketing demo: /demo lists every village; /demo/<village> (e.g. /demo/riri, called "demo-riri" here) opens the voters of that village's
// first DEMO.wards wards with no password. Each phone keeps a random device id and logs in with it; it gets DEMO.searches
// searches in all (whichever demo villages they are in), and one internet address at most DEMO.perIp a day (so clearing
// the browser doesn't give more). The demo is read-only: no marks are shown or set (its marks would live apart, under
// "mark:demo-<village>", and no one can set them), no printing, no ward lists.
// (The demo page lets a visitor try the mark buttons, but those marks stay on that phone and never reach the server.)
const DEMO = { slug: 'demo', prefix: 'demo-', wards: 2, searches: 10, perIp: 30 };
// "demo-riri" → "riri"; null when slug is not a demo village
const demoOf = (slug) => (typeof slug === 'string' && slug.startsWith(DEMO.prefix) && Object.hasOwn(VILLAGES, slug.slice(DEMO.prefix.length))
  ? slug.slice(DEMO.prefix.length) : null);
const demoSlugs = () => Object.keys(VILLAGES).map((s) => DEMO.prefix + s);
// .data is the village whose voter list to read (the demo village's own slug, read by _search.js from its village)
function village(slug) {
  const from = demoOf(slug);
  if (from) {
    const v = VILLAGES[from];
    return { ...v, slug, data: slug, demo: true, title: `डेमो · ${v.title}`,
      wards: [...v.wards].sort((a, b) => a - b).slice(0, DEMO.wards) };
  }
  return typeof slug === 'string' && Object.hasOwn(VILLAGES, slug) ? { slug, data: slug, ...VILLAGES[slug] } : null;
}
const isDevice = (d) => /^[A-Za-z0-9_-]{16,64}$/.test(String(d || ''));
const demoId = (device) => `demo_${device}`;
// all villages, or only the given slugs (the villages one login may open)
const villageList = (slugs) => Object.entries(VILLAGES).filter(([slug]) => !slugs || slugs.includes(slug))
  .map(([slug, v]) => ({ slug, name: v.name, title: v.title, panchayatSamiti: v.panchayatSamiti || '', district: v.district || '' }));

function dataKey() {
  const k = process.env.DATA_KEY;
  if (!k) throw new Error('DATA_KEY not set');
  return k.trim();
}
const hmac = (s) => crypto.createHmac('sha256', Buffer.from(dataKey(), 'base64')).update(s).digest('hex');
// passwords are generated lower-case; normalising lets phones that auto-capitalise still work
const pwHash = (pw) => hmac('pw:' + String(pw || '').trim().toLowerCase());
// A login token names the person and the session code of that login: "<id>.<session>.<signature>".
// Only the newest session code is kept in Redis, so logging in on a second phone ends the first phone's session.
const sign = (id, sid) => hmac(`tok:${id}:${sid}`).slice(0, 32);
const newSession = () => crypto.randomBytes(9).toString('base64url');
const makeToken = (id, sid) => `${id}.${sid}.${sign(id, sid)}`;
function parseToken(t) {
  const [id, sid, sig] = String(t || '').split('.');
  if (!id || !sid || !sig) return null;
  const want = Buffer.from(sign(id, sid)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? { id, sid } : null;
}
function sameText(a, b) {
  const x = Buffer.from(crypto.createHash('sha256').update(String(a)).digest());
  const y = Buffer.from(crypto.createHash('sha256').update(String(b)).digest());
  return crypto.timingSafeEqual(x, y);
}

// Three kinds of login:
//   superadmin  the ADMIN_PASSWORD; every village; creates village admins and assigns them villages
//   admin       a village admin (user record with role 'admin' and villages 'a,b'); searches and adds/manages users
//               only in those villages
//   user        a person (role 'user' or missing, one village); searches only that village
// Logging into the app with the superadmin password gives a superadmin token. It is derived from the current admin password,
// so changing ADMIN_PASSWORD in Vercel signs out every admin session.
const isAdminPassword = (pw) => !!process.env.ADMIN_PASSWORD && !!pw && sameText(String(pw).trim(), process.env.ADMIN_PASSWORD.trim());
const adminToken = () => `admin.${hmac('adm:' + String(process.env.ADMIN_PASSWORD).trim()).slice(0, 32)}`;
const isAdminToken = (t) => !!process.env.ADMIN_PASSWORD && !!t && sameText(t, adminToken());

function newPassword() {  // 3 groups of 4 from an unambiguous alphabet (no 0/o/1/l/i), ~60 bits
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  const s = [...bytes].map((b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

// a new login: fields = role and village(s) [and more]; by / byName = who made it (an admin's id and name, or 'upi' for
// one bought on the login page) → {id, password}. The password is returned once; only its hash is stored.
async function freshPassword() {   // a new password no one has yet
  for (;;) {
    const pw = newPassword();
    if (!(await redis('GET', `pw:${pwHash(pw)}`))) return pw;
  }
}
async function newLogin(fields, name, phone, by, byName) {
  const id = crypto.randomBytes(5).toString('hex');
  const password = await freshPassword(), hash = pwHash(password);
  await redis('HSET', `user:${id}`, ...fields, 'name', name, 'phone', phone, 'created', new Date().toISOString(),
    'retired', '0', 'hash', hash, 'by', by, 'byName', byName);
  await redis('SET', `pw:${hash}`, id);
  await redis('SADD', 'users', id);
  return { id, password };
}

async function getUser(id) {
  const arr = await redis('HGETALL', `user:${id}`);
  if (!arr || !arr.length) return null;
  const u = { id };
  for (let i = 0; i < arr.length; i += 2) u[arr[i]] = arr[i + 1];
  u.role = u.role === 'admin' ? 'admin' : 'user';
  u.villages = u.role === 'admin' ? String(u.villages || '').split(',').filter(Boolean) : [u.village].filter(Boolean);
  return u;
}

// simple brute-force guard: 10 wrong tries per IP per 15 minutes
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
// short phone description for the admin list, e.g. "Android · Chrome"
function deviceName(req) {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'अज्ञात';
  const br = /SamsungBrowser/.test(ua) ? 'Samsung' : /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
async function blocked(req, kind) { return Number(await redis('GET', `fail:${kind}:${clientIp(req)}`)) >= 10; }
async function failed(req, kind) {
  const k = `fail:${kind}:${clientIp(req)}`;
  await redis('INCR', k);
  await redis('EXPIRE', k, 900);
}

function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}
function send(res, code, obj) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(code).json(obj);
}
function route(fn) {
  return async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    try { await fn(req, res, body(req)); }
    catch (e) { console.error(e); send(res, 500, { error: 'server', detail: e.message }); }
  };
}

// The login behind a token: the superadmin, a village admin or a person (with .status), or null.
// .admin is true for both kinds of admin; .villages lists the villages this login may open.
// status: 'ok' | 'retired' | 'logged_out' (session ended by an admin or a new password)
//         | 'other_device' (this password has since been opened on another phone)
//         | 'other_village' (slug given and this login is not for that village)
async function whoIs(token, slug) {
  if (isAdminToken(token)) {
    return { id: 'admin', name: 'सुपर एडमिन', role: 'super', admin: true, villages: Object.keys(VILLAGES), status: 'ok', perms: PERMS.slice() };
  }
  const t = parseToken(token);
  if (t && t.id.startsWith('demo_')) {   // a demo phone: no user record, nothing it may do but search
    return { id: t.id, name: 'डेमो', role: 'user', demo: true, admin: false, villages: demoSlugs(), perms: [], sid: t.sid,
      status: slug != null && slug !== DEMO.slug && !demoOf(slug) ? 'other_village' : 'ok' };
  }
  const user = t && t.id !== 'admin' ? await getUser(t.id) : null;
  if (!user) return null;
  user.admin = user.role === 'admin';
  user.perms = user.admin ? PERMS.slice() : permsOf(user);
  user.status = user.retired === '1' ? 'retired' : !user.session ? 'logged_out' : user.session !== t.sid ? 'other_device'
    : slug != null && !user.villages.includes(slug) ? 'other_village' : 'ok';
  user.sid = t.sid;
  // a user's candidate group, if it still exists and is of their village (admins never have one)
  const cand = user.role === 'user' && user.cand ? await getCand(user.cand) : null;
  user.cand = cand && cand.village === user.village ? cand.id : '';
  user.candName = user.cand ? cand.name : '';
  return user;
}

// What a user may do besides searching by name; their village admin (or the superadmin) turns these on and off per
// person. Admins and the superadmin can do all of them.
//   mark: set status marks on slips · ward: list a whole ward without a name · wardPdf: print / save a whole ward's
//   slips · print: the प्रिंट / PDF button on a slip
const PERMS = ['mark', 'ward', 'wardPdf', 'print', 'progress', 'list'];   // progress: वार्ड अनुसार प्रगति in the app,
// list: its मतदाता सूची (voters by mark) — both api/progress.js
const DEFAULT_PERMS = ['print'];   // for new users, and users added before permissions existed
const permsOf = (u) => (u.perms === undefined ? DEFAULT_PERMS.slice() : String(u.perms).split(',').filter((p) => PERMS.includes(p)));
// today's date in India, for the per-person daily search count
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
// Searches a user may start per day (see api/search.js for what one search is): their own limit if their admin set one
// (user field "limit"), else DAILY_SEARCHES, plus any extra the admin gave for today (field "extra" = "<day>:<n>").
const DAILY_SEARCHES = 500;
const extraToday = (u) => { const [d, n] = String(u.extra || '').split(':'); return d === today() ? Number(n) || 0 : 0; };
const dailyLimit = (u) => (Number(u.limit) || DAILY_SEARCHES) + extraToday(u);
// Prepaid searches (api/signup.js): a user who signed up by themselves (field "self") may start "credits" searches in all
// (free ones from signing up plus paid ones an admin added, api/admin.js "credits_add") instead of a daily limit; they
// never expire and are counted for good under "paid:<id>". Users made by an admin have a daily limit instead.
const credits = (u) => Number(u && u.credits) || 0;
const isPrepaid = (u) => !!u && u.role === 'user' && !u.demo && (u.self === '1' || credits(u) > 0);
// free searches for a login made by signing up: the first 10 sign-ups not yet given paid searches get 10 each, the next
// 10 get 2, and after that none (set "free" in api/signup.js holds those logins; "credits_add" takes a login out of it)
const FREE_TIERS = [{ upTo: 10, searches: 10 }, { upTo: 20, searches: 2 }];
// every login with this mobile number (normPhone form): [{id, role, village, villages, retired, self}]
async function phoneLogins(phone) {
  if (!phone) return [];
  const ids = (await redis('SMEMBERS', 'users')) || [];
  if (!ids.length) return [];
  const rows = await pipeline(ids.map((id) => ['HMGET', `user:${id}`, 'phone', 'role', 'village', 'villages', 'retired', 'self']));
  return ids.map((id, i) => {
    const [ph, role, vil, vils, retired, self] = rows[i] || [];
    if (ph !== phone) return null;
    return { id, role, village: vil, villages: role === 'admin' ? String(vils || '').split(',').filter(Boolean) : [vil].filter(Boolean),
      retired, self };
  }).filter(Boolean);
}
// the WhatsApp number a signed-up person asks for more searches: the admin who made the login, else an admin of its
// village (the one with the fewest villages), else '' (the app then uses its own number)
async function adminPhone(u) {
  const ids = (await redis('SMEMBERS', 'users')) || [];
  if (!ids.length) return '';
  const rows = await pipeline(ids.map((id) => ['HMGET', `user:${id}`, 'phone', 'role', 'villages', 'retired']));
  const admins = ids.map((id, i) => {
    const [phone, role, vils, retired] = rows[i] || [];
    return role === 'admin' && retired !== '1' && phone ? { id, phone, villages: String(vils || '').split(',').filter(Boolean) } : null;
  }).filter(Boolean).filter((a) => a.villages.includes(u.village));
  const own = admins.find((a) => a.id === u.by);
  if (own) return own.phone;
  admins.sort((a, b) => a.villages.length - b.villages.length);
  return admins.length ? admins[0].phone : '';
}
const paidKey = (id) => `paid:${id}`;
async function creditsLeft(u) { return Math.max(0, credits(u) - (Number(await redis('GET', paidKey(u.id))) || 0)); }
// "98765 43210", "098765-43210", "+91 98765 43210" → "919876543210"; '' when empty; null when not a valid number
function normPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10 && /^[6-9]/.test(d)) return '91' + d;
  if (d.length === 11 && d.startsWith('0')) return normPhone(d.slice(1));
  if (d.length === 12 && d.startsWith('91')) return normPhone(d.slice(2));
  if (!d.startsWith('91') && d.length >= 11 && d.length <= 15) return d;   // other countries, already with code
  return null;
}

// Status marks put on voters, one Redis hash per village and group: field "<ward>:<box>",
// value "<status>|<time>|<who's id>|<who's name>" (older marks have only "<status>|<time>" or "<status>").
// A candidate (उम्मीदवार) is a group of a village's users ("cand:<id>": name, village, created; all ids in the set
// "cands"; a user's field "cand" names theirs). A candidate's workers mark and see only "mark:<village>:c:<id>", so
// one candidate's workers never see another's marks. Everyone else (users without a candidate, and admins searching
// the village) uses the village's own "mark:<village>". The admin page shows every group's marks separately.
const MARKS = ['done', 'coming', 'absent'];   // green: done · yellow: on the way · red: not a voter here (वोटर नहीं है)
const markKey = (v) => `${parseInt(v.ward, 10)}:${parseInt(v.box, 10)}`;
const markHash = (slug, cand) => (cand ? `mark:${slug}:c:${cand}` : `mark:${slug}`);
function parseMark(val) {
  const [m = '', at = '', byId = '', by = ''] = val ? String(val).split('|') : [];
  return { m, at, byId, by };
}
async function marksFor(slug, keys, cand) {
  if (!keys.length) return [];
  const vals = (await redis('HMGET', markHash(slug, cand), ...keys)) || [];
  return keys.map((k, i) => parseMark(vals[i]));
}
async function allMarks(slug, cand) {   // "<ward>:<box>" → parsed mark, for every marked slip of the village (of that group)
  const flat = (await redis('HGETALL', markHash(slug, cand))) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = parseMark(flat[i + 1]);
  return out;
}
async function getCand(id) {
  if (!/^[0-9a-f]{8}$/.test(String(id || ''))) return null;
  const arr = await redis('HGETALL', `cand:${id}`);
  if (!arr || !arr.length) return null;
  const c = { id };
  for (let i = 0; i < arr.length; i += 2) c[arr[i]] = arr[i + 1];
  return c;
}

module.exports = { MARKS, markKey, markHash, parseMark, marksFor, allMarks, getCand, PERMS, DEFAULT_PERMS, permsOf, today, DAILY_SEARCHES, extraToday, dailyLimit,
  FREE_TIERS, credits, isPrepaid, phoneLogins, adminPhone, paidKey, creditsLeft, normPhone,
  DEMO, demoOf, demoSlugs, isDevice, demoId, village, villageList, redis, pipeline, dataKey, pwHash, newSession, makeToken, parseToken, sameText, isAdminPassword, adminToken, isAdminToken,
  whoIs, newPassword, freshPassword, newLogin, getUser, clientIp, deviceName, blocked, failed, send, route };
