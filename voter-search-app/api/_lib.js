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
async function redis(name, key, ...args) {
  const cmd = [name, KEY_PREFIX + key, ...args];
  if (!DB_URL || !DB_TOKEN) {
    const seen = Object.keys(process.env).filter((k) => /KV|REDIS|UPSTASH/.test(k)).join(', ') || 'none';
    throw new Error(`database not connected (database variables found: ${seen})`);
  }
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Villages built into the app (by app-build/encrypt.mjs): slug → {name, title, ps, zp, pollTime, wards, voters}
const VILLAGES = require('./_villages.json');
const village = (slug) => (typeof slug === 'string' && Object.hasOwn(VILLAGES, slug) ? { slug, ...VILLAGES[slug] } : null);
// all villages, or only the given slugs (the villages one login may open)
const villageList = (slugs) => Object.entries(VILLAGES).filter(([slug]) => !slugs || slugs.includes(slug))
  .map(([slug, v]) => ({ slug, name: v.name, title: v.title }));

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
  const user = t && t.id !== 'admin' ? await getUser(t.id) : null;
  if (!user) return null;
  user.admin = user.role === 'admin';
  user.perms = user.admin ? PERMS.slice() : permsOf(user);
  user.status = user.retired === '1' ? 'retired' : !user.session ? 'logged_out' : user.session !== t.sid ? 'other_device'
    : slug != null && !user.villages.includes(slug) ? 'other_village' : 'ok';
  user.sid = t.sid;
  return user;
}

// What a user may do besides searching by name; their village admin (or the superadmin) turns these on and off per
// person. Admins and the superadmin can do all of them.
//   mark: set status marks on slips · ward: list a whole ward without a name · wardPdf: print / save a whole ward's
//   slips · print: the प्रिंट / PDF button on a slip
const PERMS = ['mark', 'ward', 'wardPdf', 'print'];
const DEFAULT_PERMS = ['print'];   // for new users, and users added before permissions existed
const permsOf = (u) => (u.perms === undefined ? DEFAULT_PERMS.slice() : String(u.perms).split(',').filter((p) => PERMS.includes(p)));
// today's date in India, for the per-person daily search count
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// Status marks put on voters, one Redis hash per village "mark:<village>": field "<ward>:<box>",
// value "<status>|<time>|<who's id>|<who's name>" (older marks have only "<status>|<time>" or "<status>").
// Everyone who can open the village sees them on the slips, with who set them and when.
const MARKS = ['done', 'coming', 'absent'];   // green: done · yellow: on the way · red: not available
const markKey = (v) => `${parseInt(v.ward, 10)}:${parseInt(v.box, 10)}`;
function parseMark(val) {
  const [m = '', at = '', byId = '', by = ''] = val ? String(val).split('|') : [];
  return { m, at, byId, by };
}
async function marksFor(slug, keys) {
  if (!keys.length) return [];
  const vals = (await redis('HMGET', `mark:${slug}`, ...keys)) || [];
  return keys.map((k, i) => parseMark(vals[i]));
}
async function allMarks(slug) {   // "<ward>:<box>" → parsed mark, for every marked slip of the village
  const flat = (await redis('HGETALL', `mark:${slug}`)) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = parseMark(flat[i + 1]);
  return out;
}

module.exports = { MARKS, markKey, parseMark, marksFor, allMarks, PERMS, DEFAULT_PERMS, permsOf, today, village, villageList, redis, dataKey, pwHash, newSession, makeToken, parseToken, sameText, isAdminPassword, adminToken, isAdminToken,
  whoIs, newPassword, getUser, clientIp, deviceName, blocked, failed, send, route };
