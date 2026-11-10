// Shared helpers for the API routes (files starting with "_" are not routes on Vercel).
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   DATA_KEY        the key that unlocks the village data in api/_data/ (from app-build/DATA_KEY.txt)
//   ADMIN_PASSWORD  the superadmin password: manages every village and creates the village admins
//   KV_REST_API_URL / KV_REST_API_TOKEN  added automatically when you connect Upstash for Redis in Vercel
//   USER_REDIS_URL  your own Redis, outside Vercel, for people's data: redis://user:password@host:port (rediss:// for
//                   TLS), or an Upstash REST address https://… with USER_REDIS_TOKEN. When set, the logins (names, mobile
//                   numbers, passwords, sessions), bought searches, pack requests and payments are kept there (USER_KEYS
//                   below), and Upstash keeps the rest: slip marks, candidates, search counters, rate limits, demo counts.
//                   Logins made before it was set are moved over once by the superadmin (admin page, moveUserData below).
//   OTP_SEND_URL    optional: sign-up then checks the mobile number with a one-time code (sendOtp below). The address
//                   of the SMS / voice OTP provider's send API with {mobile} (10 digits), {mobile91} (with 91) and {otp}
//                   where those go, and the API key in it too. 2Factor (2factor.in):
//                   https://2factor.in/API/V1/<API key>/SMS/{mobile}/{otp}/<template name>  (voice call: …/VOICE/{mobile}/{otp})
//                   GET by default; OTP_SEND_METHOD=POST with OTP_SEND_BODY (the same placeholders, e.g. JSON) posts
//                   instead. A reply that isn't 2xx, or says "Status": "Error" / false, counts as not sent.
//   KEY_PREFIX      optional, default "rv:": put in front of every database key, so this app can share one
//                   database with another app (e.g. the older single-village Adsar app) without mixing data
const crypto = require('crypto');

// Vercel may add the database variables with a custom prefix (e.g. STORAGE_KV_REST_API_URL), so accept those too.
function findEnv(names) {
  for (const n of names) if (process.env[n]) return process.env[n];
  for (const [k, v] of Object.entries(process.env)) if (v && names.some((n) => k.endsWith('_' + n))) return v;
  return null;
}
const KV_URL = findEnv(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const KV_TOKEN = findEnv(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);
const USER_URL = process.env.USER_REDIS_URL || '';
const KEY_PREFIX = process.env.KEY_PREFIX ?? 'rv:';

// A database: call(cmd) runs one command, pipe(cmds) several in one round trip; both take whole keys (prefix included).
// Upstash over HTTPS (REST) …
function restDb(url, token) {
  async function post(path, body) {
    if (!url || !token) {
      const seen = Object.keys(process.env).filter((k) => /KV|REDIS|UPSTASH/.test(k)).join(', ') || 'none';
      throw new Error(`database not connected (database variables found: ${seen})`);
    }
    const r = await fetch(url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }
  return {
    async call(cmd) { const j = await post('', cmd.map(String)); if (j.error) throw new Error(j.error); return j.result; },
    async pipe(cmds) {
      const j = await post('/pipeline', cmds.map((c) => c.map(String)));
      if (!Array.isArray(j)) throw new Error(j.error || 'pipeline');
      return j.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
    },
  };
}
// … or any Redis over its own protocol (ioredis), one connection kept per running function
function tcpDb(url) {
  let c = null;
  const conn = () => {
    if (!c) {
      const Redis = require('ioredis');
      c = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: false, connectTimeout: 8000 });
      c.on('error', (e) => console.error('USER_REDIS_URL:', e.message));
    }
    return c;
  };
  return {
    call: (cmd) => conn().call(...cmd.map(String)),
    async pipe(cmds) {
      const p = conn().pipeline();
      for (const cmd of cmds) p.call(...cmd.map(String));
      return (await p.exec()).map(([e, r]) => { if (e) throw e; return r; });
    },
  };
}
const USER_DB = !USER_URL ? null : /^rediss?:\/\//i.test(USER_URL) ? tcpDb(USER_URL)
  : restDb(USER_URL.replace(/\/+$/, ''), process.env.USER_REDIS_TOKEN);
const MAIN_DB = KV_URL || !USER_DB ? restDb(KV_URL, KV_TOKEN) : USER_DB;   // only USER_REDIS_URL set: everything there
// People's data (keys without KEY_PREFIX): logins, password index, the sign-up set, bought searches used, pack requests,
// online payments, payments per admin and their handovers, OTP codes, and the "moved" marker
const USER_KEYS = /^(user:|pw:|users$|free$|paid:|req:|reqs$|reqopen:|reqlock:|jtxn:|pay:|settle:|otp:|usermoved$)/;
const dbOf = (key) => (USER_DB && USER_KEYS.test(key) ? USER_DB : MAIN_DB);

// Every command the app uses takes exactly one key, right after the command name; that key gets KEY_PREFIX.
const prefixed = ([name, key, ...args]) => [name, KEY_PREFIX + key, ...args];
const redis = (...cmd) => dbOf(cmd[1]).call(prefixed(cmd));
// several commands in one round trip: [[name, key, ...args], ...] → their results, in order (one trip per database)
async function pipeline(cmds) {
  const out = new Array(cmds.length), groups = new Map();
  cmds.forEach((c, i) => { const db = dbOf(c[1]); if (!groups.has(db)) groups.set(db, []); groups.get(db).push(i); });
  await Promise.all([...groups].map(async ([db, idx]) => {
    const res = await db.pipe(idx.map((i) => prefixed(cmds[i])));
    idx.forEach((i, j) => { out[i] = res[j]; });
  }));
  return out;
}

// Moving people's data to USER_REDIS_URL: copies Upstash's USER_KEYS into it, then removes them from Upstash, one SCAN
// step per call (cursor '0' to start; → {next, keys}, next '0' = done). What is already in the new database wins: a value
// is only filled in where it is missing (strings SET NX, hash fields HSETNX, set members SADD), so it is safe to run again.
const canMoveUserData = () => !!(USER_DB && KV_URL && KV_TOKEN && MAIN_DB !== USER_DB);
async function moveUserData(cursor) {
  const [next, found] = await MAIN_DB.call(['SCAN', String(cursor || '0'), 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 300]);
  const keys = found.filter((k) => USER_KEYS.test(k.slice(KEY_PREFIX.length)));
  if (!keys.length) return { next: String(next), keys: 0 };
  const types = await MAIN_DB.pipe(keys.map((k) => ['TYPE', k]));
  const vals = await MAIN_DB.pipe(keys.map((k, i) => [{ string: 'GET', hash: 'HGETALL', set: 'SMEMBERS' }[types[i]] || 'TYPE', k]));
  const ttls = await MAIN_DB.pipe(keys.map((k) => ['PTTL', k]));
  const writes = [];
  keys.forEach((k, i) => {
    const v = vals[i], ttl = Number(ttls[i]);
    if (types[i] === 'string') writes.push(ttl > 0 ? ['SET', k, v, 'PX', ttl, 'NX'] : ['SET', k, v, 'NX']);
    else if (types[i] === 'hash') for (let j = 0; j < v.length; j += 2) writes.push(['HSETNX', k, v[j], v[j + 1]]);
    else if (types[i] === 'set' && v.length) writes.push(['SADD', k, ...v]);
    if ((types[i] === 'hash' || types[i] === 'set') && ttl > 0) writes.push(['PEXPIRE', k, ttl]);
  });
  for (let i = 0; i < writes.length; i += 1000) await USER_DB.pipe(writes.slice(i, i + 1000));
  await MAIN_DB.pipe(keys.map((k) => ['DEL', k]));   // only once they are safely in the new database
  return { next: String(next), keys: keys.length };
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

// A village admin looks after the villages given to them one by one (field villages "a,b") and every village of the
// पंचायत समितियाँ given to them whole (field samitis, keys "<district>|<samiti>" joined by ","), so a village imported
// into such a samiti later is theirs at once.
const samitiKey = (v) => `${v.district || ''}|${v.panchayatSamiti || ''}`;
const samitiKeys = () => [...new Set(Object.values(VILLAGES).filter((v) => v.panchayatSamiti).map(samitiKey))];
const splitList = (s) => String(s || '').split(',').filter(Boolean);
function adminVillages(villages, samitis) {
  const whole = splitList(samitis);
  return [...new Set([...splitList(villages), ...Object.keys(VILLAGES).filter((s) => whole.includes(samitiKey(VILLAGES[s])))])];
}

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

// A password the person chose (sign-up, or पासवर्ड बदलें in the app) is kept under pw:<hash of number + password>, so two
// people may choose the same one; a login with a number tries that first (api/unlock.js), then the made-up ones'
// pw:<hash of password>. 6–40 characters, upper and lower case the same (pwHash).
const PW_MIN = 6, PW_MAX = 40;
const ownPwHash = (phone, pw) => pwHash(`${phone}:${String(pw || '').trim()}`);
const badOwnPassword = (pw) => { const n = String(pw || '').trim().length; return n < PW_MIN || n > PW_MAX; };
// → '' when set, else 'pw_short' | 'pw_taken' (this number's other login already has it) | 'phone'
async function setOwnPassword(u, pw) {
  if (badOwnPassword(pw)) return 'pw_short';
  if (!u.phone) return 'phone';
  const hash = ownPwHash(u.phone, pw), was = await redis('GET', `pw:${hash}`);
  if (was && was !== u.id) return 'pw_taken';
  if (u.hash && u.hash !== hash) await redis('DEL', `pw:${u.hash}`);
  await redis('HSET', `user:${u.id}`, 'hash', hash);
  await redis('SET', `pw:${hash}`, u.id);
  return '';
}

const getUser = async (id) => userFrom(id, await redis('HGETALL', `user:${id}`));
// many logins in one round trip (the admin page's lists)
async function getUsers(ids) {
  const rows = ids.length ? await pipeline(ids.map((id) => ['HGETALL', `user:${id}`])) : [];
  return ids.map((id, i) => userFrom(id, rows[i])).filter(Boolean);
}
function userFrom(id, arr) {
  if (!arr || !arr.length) return null;
  const u = { id };
  for (let i = 0; i < arr.length; i += 2) u[arr[i]] = arr[i + 1];
  u.role = u.role === 'admin' ? 'admin' : 'user';
  u.ownVillages = u.role === 'admin' ? splitList(u.villages) : [];   // given one by one
  u.samitis = u.role === 'admin' ? splitList(u.samitis) : [];
  u.villages = u.role === 'admin' ? adminVillages(u.villages, u.samitis.join(',')) : [u.village].filter(Boolean);
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
// One-time codes for signing up (api/signup.js "otp"): a 6-digit code, kept hashed under "otp:<phone>" for OTP_TTL
// seconds with how many wrong tries it had; a new one only after OTP_GAP seconds, OTP_DAY a day per number.
const OTP = { ttl: 600, gap: 30, day: 5, tries: 5 };
const otpOn = () => !!process.env.OTP_SEND_URL;
async function sendOtp(phone, code) {   // phone: 91XXXXXXXXXX → true when the provider took it
  const fill = (s) => String(s || '').replaceAll('{mobile91}', phone).replaceAll('{mobile}', phone.slice(-10)).replaceAll('{otp}', code);
  const post = /^post$/i.test(process.env.OTP_SEND_METHOD || '');
  try {
    const r = await fetch(fill(process.env.OTP_SEND_URL), post
      ? { method: 'POST', headers: { 'Content-Type': process.env.OTP_SEND_TYPE || 'application/json' }, body: fill(process.env.OTP_SEND_BODY) } : {});
    const text = await r.text();
    if (!r.ok || /"(status|type|success)"\s*:\s*("?(false|error|failed)"?|0)\b/i.test(text)) { console.error('otp send', r.status, text.slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('otp send', e.message); return false; }
}
// → '' when sent, else 'wait' (asked again within OTP.gap), 'too_many' (OTP.day today) or 'otp_send' (provider failed)
async function newOtp(phone) {
  const k = `otp:${phone}`, sent = Number(await redis('HGET', k, 'at')) || 0;
  if (Date.now() - sent < OTP.gap * 1000) return 'wait';
  const dk = `otp:day:${phone}:${today()}`;
  if (await redis('INCR', dk) > OTP.day) return 'too_many';
  await redis('EXPIRE', dk, 86400);
  const code = String(crypto.randomInt(100000, 1000000));
  if (!(await sendOtp(phone, code))) return 'otp_send';
  await redis('HSET', k, 'hash', hmac(`otp:${phone}:${code}`), 'tries', 0, 'at', Date.now());
  await redis('EXPIRE', k, OTP.ttl);
  return '';
}
// → '' when right (the code is then used up), else 'otp_expired' | 'otp_tries' | 'otp_wrong'
async function checkOtp(phone, code) {
  const k = `otp:${phone}`, [hash, tries] = (await redis('HMGET', k, 'hash', 'tries')) || [];
  if (!hash) return 'otp_expired';
  if (Number(tries) >= OTP.tries) return 'otp_tries';
  if (!sameText(hmac(`otp:${phone}:${String(code || '').replace(/\D/g, '')}`), hash)) { await redis('HINCRBY', k, 'tries', 1); return 'otp_wrong'; }
  await redis('DEL', k);
  return '';
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
  user.perms = appPerms(user);
  user.aperms = adminPermsOf(user);
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
const DEFAULT_PERMS = ['mark', 'print', 'progress'];   // for new users, and users added before permissions existed
const permsOf = (u) => (u.perms === undefined ? DEFAULT_PERMS.slice() : String(u.perms).split(',').filter((p) => PERMS.includes(p)));
// an admin's in the app: all of them until the superadmin sets them (admins made before these could be set)
const appPerms = (u) => (u.role === 'admin' && u.perms === undefined ? PERMS.slice() : permsOf(u));
// What a village admin may do on the admin page, set by the superadmin (field "aperms"; admins made before these
// existed: all of them):
//   add: make new users · own: see and look after the users they made · all: see and look after every user of their
//   villages · credits: add searches to those users · approve: approve or reject their search requests (and the ones sent
//   to this admin)
const ADMIN_PERMS = ['add', 'own', 'all', 'credits', 'approve'];
const PROMOTED_PERMS = ['add', 'own', 'credits', 'approve'];   // a user made admin (api/admin.js "promote")
const adminPermsOf = (u) => (u.role !== 'admin' ? [] : u.aperms === undefined ? ADMIN_PERMS.slice()
  : String(u.aperms).split(',').filter((p) => ADMIN_PERMS.includes(p)));
// today's date in India, for the per-person daily search count
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
// Searches a user may start per day (see api/search.js for what one search is): their own limit if their admin set one
// (user field "limit"), else DAILY_SEARCHES, plus any extra the admin gave for today (field "extra" = "<day>:<n>").
// A village admin has no limit unless the superadmin set one (adminLimited); then the same rule.
const DAILY_SEARCHES = 500;
const extraToday = (u) => { const [d, n] = String(u.extra || '').split(':'); return d === today() ? Number(n) || 0 : 0; };
const dailyLimit = (u) => (Number(u.limit) || DAILY_SEARCHES) + extraToday(u);
const adminLimited = (u) => u.role === 'admin' && Number(u.limit) > 0;
// Prepaid searches (api/signup.js): a user who signed up by themselves (field "self") may start "credits" searches in all
// (free ones from signing up plus paid ones an admin added, api/admin.js "credits_add") instead of a daily limit; they
// never expire and are counted for good under "paid:<id>". Users made by an admin have a daily limit instead, and may
// buy searches too (canBuy): theirs are used once the day's limit is used up, and counted the same way.
const credits = (u) => Number(u && u.credits) || 0;
const isPrepaid = (u) => !!u && u.role === 'user' && !u.demo && u.self === '1';
const canBuy = (u) => !!u && u.role === 'user' && !u.demo;
// a signed-up login that picked the wrong village may move itself to another one this many times (api/signup.js "move")
const MOVES = 3;
const movesLeft = (u) => (isPrepaid(u) ? Math.max(0, MOVES - (Number(u.moves) || 0)) : 0);
// free searches for a login made by signing up, counted per village (none for a number that signed up before; api/signup.js).
// The superadmin sets the rule on the admin page (key "freerule", api/admin.js "free_rule"), FREE until then:
//   mode 'direct': the village's first `people` sign-ups get `searches` each, later ones none;
//   mode 'halving': the first `people` get `searches`, the next `people` half of it, and so on down to 1, then none
//                   (10 → 5 → 2 → 1).
const FREE = { mode: 'direct', people: 10, searches: 10 };
const FREE_MAX = { people: 100000, searches: 1000 };
async function freeRule() {
  const h = (await redis('HGETALL', 'freerule')) || [], o = {};
  for (let i = 0; i < h.length; i += 2) o[h[i]] = h[i + 1];
  const num = (v, max, d) => { const n = Math.floor(Number(v)); return n >= 1 && n <= max ? n : d; };
  return { mode: o.mode === 'halving' ? 'halving' : 'direct', people: num(o.people, FREE_MAX.people, FREE.people),
    searches: num(o.searches, FREE_MAX.searches, FREE.searches) };
}
// free searches for the village's sign-up number n + 1 (n = sign-ups there so far) under rule
function freeFor(rule, n) {
  if (rule.mode !== 'halving') return n < rule.people ? rule.searches : 0;
  return Math.floor(rule.searches / 2 ** Math.floor(n / rule.people));
}
// every login with this mobile number (normPhone form): [{id, role, village, villages, retired, self}]
async function phoneLogins(phone) {
  if (!phone) return [];
  const ids = (await redis('SMEMBERS', 'users')) || [];
  if (!ids.length) return [];
  const rows = await pipeline(ids.map((id) => ['HMGET', `user:${id}`, 'phone', 'role', 'village', 'villages', 'retired', 'self', 'samitis']));
  return ids.map((id, i) => {
    const [ph, role, vil, vils, retired, self, sams] = rows[i] || [];
    if (ph !== phone) return null;
    return { id, role, village: vil, villages: role === 'admin' ? adminVillages(vils, sams) : [vil].filter(Boolean),
      retired, self };
  }).filter(Boolean);
}
// whom a signed-up person asks for more searches (the WhatsApp number, and whose 🔔 the request goes to): the one who
// made the login, i.e. the superadmin, or a village admin while still active, with a number and looking after the
// village; for a login the person made themself (or whose admin is gone): an admin of the village, the one with the
// fewest villages; with none, the superadmin. → {id, phone}; the superadmin is {id: 'admin', phone: ''} (the app then
// uses its own number)
const SUPER = { id: 'admin', phone: '' };
async function adminFor(u) {
  if (u.by === 'admin') return SUPER;
  const ids = (await redis('SMEMBERS', 'users')) || [];
  if (!ids.length) return SUPER;
  const rows = await pipeline(ids.map((id) => ['HMGET', `user:${id}`, 'phone', 'role', 'villages', 'retired', 'samitis']));
  const admins = ids.map((id, i) => {
    const [phone, role, vils, retired, sams] = rows[i] || [];
    return role === 'admin' && retired !== '1' && phone ? { id, phone, villages: adminVillages(vils, sams) } : null;
  }).filter(Boolean).filter((a) => a.villages.includes(u.village));
  const own = admins.find((a) => a.id === u.by);
  if (own) return own;
  admins.sort((a, b) => a.villages.length - b.villages.length);
  return admins[0] || SUPER;
}
const adminPhone = async (u) => (await adminFor(u)).phone;
// search packs a person can ask for: [searches, ₹] (the same list is in index.html and admin.html)
const PACKS = [[100, 100], [200, 200], [500, 400], [800, 650], [1000, 800]];
// A request for a pack (api/signup.js 'request'), key req:<id>, id = 8 digits: the WhatsApp message to the admin carries
// only <site>/<id>, which opens the admin page; the admin logs in and sees who asked (api/admin.js 'req_get'). Fields:
// user, village, n, rs, created, status 'open' | 'done' | 'rejected', and once approved or rejected doneAt, doneBy,
// doneByName (approved: also doneN, doneRs).
// reqopen:<user>:<n> → that person's open request for that pack, so asking again sends the same link.
// what a number of searches costs: the pack's price, else ₹1 a search
const packPrice = (n) => { const pk = PACKS.find(([k]) => k === Number(n)); return pk ? pk[1] : Number(n) || 0; };
async function newReqId() {   // 8 digits no request has yet
  let id;
  do id = String(crypto.randomInt(10000000, 100000000)); while (await getReq(id));
  return id;
}
// Payments: each approved request (and each hand-added "सर्च जोड़ें" on the admin page, which gets an approved request of
// its own with hand: '1') records doneRs = the ₹ collected and doneBy / doneByName = the admin who collected it;
// pay:rs, pay:n, pay:count (hashes, admin id → total ₹, searches, payments) and pay:name (admin id → name) add them up
// for the superadmin.
const isReqId = (id) => /^\d{8}$/.test(String(id || ''));
async function getReq(id) {
  if (!isReqId(id)) return null;
  const arr = await redis('HGETALL', `req:${id}`);
  if (!arr || !arr.length) return null;
  const r = { id };
  for (let i = 0; i < arr.length; i += 2) r[arr[i]] = arr[i + 1];
  return r;
}
const paidKey = (id) => `paid:${id}`;
async function creditsLeft(u) { return Math.max(0, credits(u) - (Number(await redis('GET', paidKey(u.id))) || 0)); }
// n bought searches for person u, collected by `by` ({id, name}: an admin, or GATEWAY): the searches, and the payment
// recorded in request r (none: a hand-added one, which gets its own request, already approved) and in the pay:* totals
async function addPaid(u, n, r, by) {
  const rs = packPrice(n), now = new Date().toISOString();
  await redis('HINCRBY', `user:${u.id}`, 'credits', n);
  await redis('HSET', `user:${u.id}`, 'bought', '1');
  await redis('SREM', 'free', u.id);
  const id = r ? r.id : await newReqId();
  if (!r) {
    await redis('HSET', `req:${id}`, 'user', u.id, 'village', u.village, 'n', n, 'rs', rs, 'created', now, 'hand', '1');
    await redis('SADD', 'reqs', id);
  }
  await redis('HSET', `req:${id}`, 'status', 'done', 'doneAt', now, 'doneN', n, 'doneRs', rs, 'doneBy', by.id, 'doneByName', by.name);
  await redis('HINCRBY', 'pay:rs', by.id, rs);
  await redis('HINCRBY', 'pay:n', by.id, n);
  await redis('HINCRBY', 'pay:count', by.id, 1);
  if (by.id !== 'admin') await redis('HSET', 'pay:name', by.id, by.name);
}
// Online UPI payment through JaduPe (jadupe.com, api/pay.js), when JADUPE_TOKEN (the API token from JaduPe's "APIs and
// Documentation" page) is set. The money goes to the superadmin's JaduPe merchant account, so it counts as collected
// by the superadmin. A request paid this way has gw: 'jadupe', txn = JaduPe's transaction id (jtxn:<txn> → request id)
// and link = the payment page. Its status is only ever taken from JaduPe's check-payment-status API, never from what a
// phone or the webhook says.
const GATEWAY = { id: 'admin', name: 'UPI ऑनलाइन (JaduPe)' };
const payOnline = () => !!process.env.JADUPE_TOKEN;
async function jadupe(path, payload) {
  const r = await fetch((process.env.JADUPE_URL || 'https://jadupe.com/api/') + path, {
    method: payload ? 'POST' : 'GET',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.JADUPE_TOKEN}` },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { success: false, message: text.slice(0, 200) }; }
}
// asks JaduPe how an online request's payment stands: completed (paid at least the pack's price, give or take ₹1) →
// the searches are added, once; timeout / error → the request is closed as rejected. → the request as it now is
async function settleOnline(rid) {
  const r = await getReq(rid);
  if (!r || r.gw !== 'jadupe' || !r.txn || r.status !== 'open') return r;
  const s = await jadupe('check-payment-status', { txn_id: String(r.txn) });
  const t = s && s.success && s.data && s.data.transaction;
  if (!t) return r;
  const st = String(t.status || '').toLowerCase();
  if (st === 'completed' && Number(t.amount) >= Number(r.rs) - 1) {
    const u = await getUser(r.user);
    if (u && await redis('SET', `reqlock:${r.id}`, GATEWAY.id, 'NX')) await addPaid(u, Number(r.n), r, GATEWAY);
  } else if ((st === 'timeout' || st === 'error') && await redis('SET', `reqlock:${r.id}`, GATEWAY.id, 'NX')) {
    await redis('HSET', `req:${r.id}`, 'status', 'rejected', 'doneAt', new Date().toISOString(), 'doneBy', GATEWAY.id,
      'doneByName', `${GATEWAY.name}: ${st === 'timeout' ? 'समय खत्म' : 'भुगतान नहीं हुआ'}`);
  }
  return getReq(rid);
}
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
const allMarks = async (slug, cand) => marksFrom(await redis('HGETALL', markHash(slug, cand)));
function marksFrom(flat) {   // "<ward>:<box>" → parsed mark, for every marked slip of the village (of that group)
  flat ||= [];
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

module.exports = { MARKS, markKey, markHash, parseMark, marksFor, allMarks, getCand, PERMS, DEFAULT_PERMS, permsOf, appPerms, ADMIN_PERMS, PROMOTED_PERMS, adminPermsOf, adminLimited, PW_MIN, ownPwHash, badOwnPassword, setOwnPassword, today, DAILY_SEARCHES, extraToday, dailyLimit,
  FREE, FREE_MAX, freeRule, freeFor, credits, isPrepaid, canBuy, phoneLogins, adminFor, adminPhone, PACKS, packPrice, newReqId, isReqId, getReq, paidKey, creditsLeft, addPaid, GATEWAY, payOnline, jadupe, settleOnline, normPhone,
  OTP, otpOn, newOtp, checkOtp, canMoveUserData, moveUserData, MOVES, movesLeft, DEMO, demoOf, demoSlugs, isDevice, demoId, village, villageList, samitiKey, samitiKeys, redis, pipeline, dataKey, pwHash, newSession, makeToken, parseToken, sameText, isAdminPassword, adminToken, isAdminToken,
  whoIs, newPassword, freshPassword, newLogin, getUser, getUsers, marksFrom, clientIp, deviceName, blocked, failed, send, route };
