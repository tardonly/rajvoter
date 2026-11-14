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
//   MONGODB_URI     MongoDB (added by Vercel's MongoDB Atlas integration; MONGODB_DB optional, else the database in
//                   the address, else "rajelection"). When set, it takes Upstash's place (mongoDb below): everything
//                   Upstash kept goes there, while people's data stays in USER_REDIS_URL when that is set, untouched.
//                   The superadmin copies what Upstash holds into it once (admin page, moveUserData below).
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
const MONGO_URL = findEnv(['MONGODB_URI', 'MONGO_URL', 'MONGODB_URL']);
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
function tcpDb(url, name = 'USER_REDIS_URL') {
  let c = null;
  const conn = () => {
    if (!c) {
      const Redis = require('ioredis');
      c = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: false, connectTimeout: 8000 });
      c.on('error', (e) => console.error(name + ':', e.message));
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
// … or MongoDB (MONGODB_URI), answering the same Redis commands, so nothing else in the app changes. One document per
// key in the collection "kv": {_id: key, s: string} | {h: {field: value}} | {m: [members]}, and exp (a Date) when the
// key has a time limit. A TTL index removes expired documents; until it does, reads treat them as gone and a write
// first deletes them. Hashes are changed with $setField / $getField, so any field name works (dots, a leading $).
function mongoDb(url) {
  let coll = null;
  const kv = () => coll || (coll = (async () => {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(url, { maxPoolSize: 10, serverSelectionTimeoutMS: 8000 });
    await client.connect();
    let db = client.db(process.env.MONGODB_DB || undefined);
    if (db.databaseName === 'test' && !process.env.MONGODB_DB) db = client.db('rajelection');
    const c = db.collection('kv');
    c.createIndex({ exp: 1 }, { expireAfterSeconds: 0 }).catch((e) => console.error('MONGODB_URI index:', e.message));
    return c;
  })().catch((e) => { coll = null; throw e; }));
  const READ = new Set(['GET', 'HGET', 'HMGET', 'HGETALL', 'SMEMBERS', 'SISMEMBER', 'SCARD', 'TYPE', 'PTTL']);
  const live = (d, now) => (d && !(d.exp && d.exp.getTime() <= now) ? d : null);
  const has = (o, f) => !!o && Object.prototype.hasOwnProperty.call(o, f);
  function read([cmd, , ...a], d, now) {
    switch (cmd) {
      case 'GET': return d && d.s !== undefined ? d.s : null;
      case 'HGET': return d && has(d.h, a[0]) ? d.h[a[0]] : null;
      case 'HMGET': return a.map((f) => (d && has(d.h, f) ? d.h[f] : null));
      case 'HGETALL': return d && d.h ? Object.entries(d.h).flat() : [];
      case 'SMEMBERS': return (d && d.m) || [];
      case 'SISMEMBER': return d && d.m && d.m.includes(a[0]) ? 1 : 0;
      case 'SCARD': return (d && d.m && d.m.length) || 0;
      case 'TYPE': return !d ? 'none' : d.h ? 'hash' : d.m ? 'set' : 'string';
      case 'PTTL': return !d ? -2 : d.exp ? d.exp.getTime() - now : -1;
    }
  }
  const H = { $ifNull: ['$h', {}] };
  const getF = (f) => ({ $getField: { field: { $literal: f }, input: H } });
  const num = (x) => ({ $toLong: { $ifNull: [x, '0'] } });
  const upBefore = { upsert: true, returnDocument: 'before' }, upAfter = { upsert: true, returnDocument: 'after' };
  async function write(c, [cmd, k, ...a], now) {
    const id = { _id: k };
    switch (cmd) {
      case 'SET': {   // SET key value [EX seconds | PX ms] [NX]
        const opt = a.slice(1).map((x) => x.toUpperCase()), doc = { s: a[0] };
        const ex = opt.indexOf('EX'), px = opt.indexOf('PX');
        if (ex >= 0) doc.exp = new Date(now + Number(a[ex + 2]) * 1000);
        if (px >= 0) doc.exp = new Date(now + Number(a[px + 2]));
        if (opt.includes('NX')) {
          try { await c.insertOne({ _id: k, ...doc }); return 'OK'; } catch (e) { if (e.code === 11000) return null; throw e; }
        }
        await c.replaceOne(id, doc, { upsert: true });
        return 'OK';
      }
      case 'INCR': case 'DECR': {
        const d = await c.findOneAndUpdate(id, [{ $set: { s: { $toString: { $add: [num('$s'), cmd === 'INCR' ? 1 : -1] } } } }], upAfter);
        return Number(d.s);
      }
      case 'EXPIRE': case 'PEXPIRE':
        return (await c.updateOne(id, { $set: { exp: new Date(now + Number(a[0]) * (cmd === 'EXPIRE' ? 1000 : 1)) } })).matchedCount;
      case 'DEL': return (await c.deleteOne(id)).deletedCount;
      case 'HSET': {
        let h = H;
        for (let i = 0; i < a.length; i += 2) h = { $setField: { field: { $literal: a[i] }, input: h, value: { $literal: a[i + 1] } } };
        const d = await c.findOneAndUpdate(id, [{ $set: { h } }], upBefore);
        return a.filter((f, i) => i % 2 === 0 && !has(d && d.h, f)).length;
      }
      case 'HSETNX': {
        const h = { $setField: { field: { $literal: a[0] }, input: H, value: { $ifNull: [getF(a[0]), { $literal: a[1] }] } } };
        const d = await c.findOneAndUpdate(id, [{ $set: { h } }], upBefore);
        return has(d && d.h, a[0]) ? 0 : 1;
      }
      case 'HDEL': {
        let h = H;
        for (const f of a) h = { $unsetField: { field: { $literal: f }, input: h } };
        const d = await c.findOneAndUpdate(id, [{ $set: { h } }], { returnDocument: 'before' });
        return a.filter((f) => has(d && d.h, f)).length;
      }
      case 'HINCRBY': {
        const h = { $setField: { field: { $literal: a[0] }, input: H, value: { $toString: { $add: [num(getF(a[0])), Number(a[1])] } } } };
        const d = await c.findOneAndUpdate(id, [{ $set: { h } }], upAfter);
        return Number(d.h[a[0]]);
      }
      case 'SADD': {
        const d = await c.findOneAndUpdate(id, { $addToSet: { m: { $each: a } } }, upBefore);
        return new Set(a.filter((x) => !(d && d.m && d.m.includes(x)))).size;
      }
      case 'SREM': {
        const d = await c.findOneAndUpdate(id, { $pull: { m: { $in: a } } }, { returnDocument: 'before' });
        return new Set(a.filter((x) => d && d.m && d.m.includes(x))).size;
      }
      case 'SCAN': {   // everything in one step: SCAN 0 MATCH <prefix>* → ['0', keys]
        const m = a.map((x) => x.toUpperCase()).indexOf('MATCH'), pre = m >= 0 ? a[m + 1].replace(/\*$/, '') : '';
        const re = new RegExp('^' + pre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const docs = await c.find({ _id: re, $or: [{ exp: null }, { exp: { $gt: new Date(now) } }] }, { projection: { _id: 1 } }).toArray();
        return ['0', docs.map((d) => d._id)];
      }
      default: throw new Error('unsupported ' + cmd);
    }
  }
  // Commands run in order; a run of commands on different keys goes together: the reads in one find, the writes at once.
  async function pipe(cmds) {
    const c = await kv(), out = new Array(cmds.length);
    cmds = cmds.map((x) => { const y = x.map(String); y[0] = y[0].toUpperCase(); return y; });
    for (let i = 0; i < cmds.length;) {
      const seen = new Set(), run = [];
      while (i < cmds.length && !seen.has(cmds[i][1])) { seen.add(cmds[i][1]); run.push(i++); }
      const now = Date.now();
      const reads = run.filter((j) => READ.has(cmds[j][0])), writes = run.filter((j) => !READ.has(cmds[j][0]));
      const wkeys = writes.filter((j) => cmds[j][0] !== 'SCAN').map((j) => cmds[j][1]);
      await Promise.all([
        reads.length && c.find({ _id: { $in: reads.map((j) => cmds[j][1]) } }).toArray().then((docs) => {
          const by = new Map(docs.map((d) => [d._id, live(d, now)]));
          for (const j of reads) out[j] = read(cmds[j], by.get(cmds[j][1]) || null, now);
        }),
        writes.length && (wkeys.length ? c.deleteMany({ _id: { $in: wkeys }, exp: { $lte: new Date(now) } }) : Promise.resolve())
          .then(() => Promise.all(writes.map(async (j) => { out[j] = await write(c, cmds[j], now); }))),
      ]);
    }
    return out;
  }
  // The copy from Upstash: [{key, type, value, ttl}] in one round trip. What MongoDB already has wins: a string is only
  // set where missing, a hash only gains the fields it lacks, a set gains members.
  async function importKeys(items) {
    const c = await kv(), now = Date.now(), ops = [];
    for (const { key, type, value, ttl } of items) {
      const exp = ttl > 0 ? { exp: new Date(now + ttl) } : {};
      if (type === 'string') ops.push({ updateOne: { filter: { _id: key }, update: { $setOnInsert: { s: String(value), ...exp } }, upsert: true } });
      else if (type === 'hash') {
        const obj = {};
        for (let i = 0; i < value.length; i += 2) obj[value[i]] = String(value[i + 1]);
        ops.push({ updateOne: { filter: { _id: key }, update: [{ $set: { h: { $mergeObjects: [{ $literal: obj }, H] }, ...(ttl > 0 ? { exp: { $ifNull: ['$exp', exp.exp] } } : {}) } }], upsert: true } });
      } else if (type === 'set' && value.length) {
        ops.push({ updateOne: { filter: { _id: key }, update: { $addToSet: { m: { $each: value.map(String) } }, ...(ttl > 0 ? { $setOnInsert: exp } : {}) }, upsert: true } });
      }
    }
    if (ops.length) await c.bulkWrite(ops, { ordered: false });
  }
  return { call: async (cmd) => (await pipe([cmd]))[0], pipe, importKeys };
}
const USER_DB = !USER_URL ? null : /^rediss?:\/\//i.test(USER_URL) ? tcpDb(USER_URL)
  : restDb(USER_URL.replace(/\/+$/, ''), process.env.USER_REDIS_TOKEN);
const MAIN_DB = KV_URL || !USER_DB ? restDb(KV_URL, KV_TOKEN) : USER_DB;   // only USER_REDIS_URL set: everything there
const MONGO_DB = MONGO_URL ? mongoDb(MONGO_URL) : null;   // set: MongoDB takes Upstash's place
// People's data (keys without KEY_PREFIX): logins, password index, the sign-up set, bought searches used, pack requests,
// online payments, payments per admin and their handovers, OTP codes, the "moved" marker, and the indexes of logins by
// mobile number and of the admins (buildIndexes below)
const USER_KEYS = /^(user:|pw:|users$|free$|paid:|req:|reqs$|reqopen:|reqlock:|jtxn:|rzp:|pay:|settle:|otp:|usermoved$|phone:|admins$|idxbuilt$)/;
const dbOf = (key) => (USER_DB && USER_KEYS.test(key) ? USER_DB : MONGO_DB || MAIN_DB);

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
// With MONGODB_URI set it copies Upstash into MongoDB instead and leaves Upstash as it was, as a backup; the same
// "only where missing" rule makes it safe to run again. USER_REDIS_URL is never read or written by it, and people's keys
// (USER_KEYS) are skipped when it is set, as they live there (or with COPY_SKIP_USER_KEYS, for app-build/copy-to-mongo.cjs). Upstash is read over its own protocol (REDIS_URL, which
// Vercel's Upstash integration adds) when that is set, else over REST.
const UPSTASH_TCP = /^rediss?:\/\//i.test(process.env.REDIS_URL || '') && process.env.REDIS_URL !== USER_URL ? process.env.REDIS_URL : '';
let upstashSrc = null;
const upstashForCopy = () => upstashSrc || (upstashSrc = UPSTASH_TCP ? tcpDb(UPSTASH_TCP, 'REDIS_URL (Upstash)') : KV_URL && KV_TOKEN && MAIN_DB !== USER_DB ? restDb(KV_URL, KV_TOKEN) : null);
const COPY_DONE = MONGO_DB ? 'mongocopied' : 'usermoved';   // when the copy finished; 'mongocopied' is not a USER_KEYS key
const canMoveUserData = () => (MONGO_DB ? !!upstashForCopy() : !!(USER_DB && KV_URL && KV_TOKEN && MAIN_DB !== USER_DB));
async function copyToMongo(cursor, src = upstashForCopy()) {   // src: another way to reach Upstash (app-build/copy-to-mongo.cjs)
  const [next, found] = await src.call(['SCAN', String(cursor || '0'), 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 300]);
  const keys = USER_DB || process.env.COPY_SKIP_USER_KEYS ? found.filter((k) => !USER_KEYS.test(k.slice(KEY_PREFIX.length))) : found;
  if (!keys.length) return { next: String(next), keys: 0 };
  const types = await src.pipe(keys.map((k) => ['TYPE', k]));
  const [vals, ttls] = await Promise.all([
    src.pipe(keys.map((k, i) => [{ string: 'GET', hash: 'HGETALL', set: 'SMEMBERS' }[types[i]] || 'TYPE', k])),
    src.pipe(keys.map((k) => ['PTTL', k]))]);
  await MONGO_DB.importKeys(keys.map((key, i) => ({ key, type: types[i], value: vals[i], ttl: Number(ttls[i]) })));
  return { next: String(next), keys: keys.length };
}
async function moveUserData(cursor, src) {
  if (MONGO_DB) return copyToMongo(cursor, src || undefined);
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
// (in the order given: a person's own village first)
const villageList = (slugs) => (slugs || Object.keys(VILLAGES)).filter((slug) => Object.hasOwn(VILLAGES, slug)).map((slug) => {
  const v = VILLAGES[slug];
  return { slug, name: v.name, title: v.title, panchayatSamiti: v.panchayatSamiti || '', district: v.district || '', zp: v.zp ?? '', ps: v.ps ?? '', voters: v.voters || 0 };
});

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
// ज़िला परिषद / पंचायत समिति वार्ड: every village (gram panchayat) carries the number of the ZP ward (zp, numbered per
// district) and of the PS ward (ps, numbered per samiti) it is in. A person working for a ZP or PS candidate opens every
// village of that ward: key "zp:<district>|<zp>" or "ps:<district>|<samiti>|<ps>" (kept as the ward, like an admin's
// samitis, so a village imported into it later is theirs too).
const areaKeyOf = (kind, v) => (kind === 'zp' ? `zp:${v.district || ''}|${v.zp}` : `ps:${v.district || ''}|${v.panchayatSamiti || ''}|${v.ps}`);
const areaVillages = (keys) => {
  const want = splitList(keys);
  return want.length ? Object.keys(VILLAGES).filter((s) => ['zp', 'ps'].some((k) => VILLAGES[s][k] != null && want.includes(areaKeyOf(k, VILLAGES[s])))) : [];
};
// how many villages each ZP / PS ward has, by key
let AREA_SIZE = null;
function areaSize(key) {
  if (!AREA_SIZE) {
    AREA_SIZE = {};
    for (const v of Object.values(VILLAGES)) for (const k of ['zp', 'ps']) if (v[k] != null) AREA_SIZE[areaKeyOf(k, v)] = (AREA_SIZE[areaKeyOf(k, v)] || 0) + 1;
  }
  return AREA_SIZE[key] || 0;
}
// A person (role user) has their own village (field village: sign-ups, requests and their admin go by it) and may also
// open more: villages given one by one (field more "a,b") and whole ZP / PS wards (field areas, keys joined by ",").
const userVillages = (home, more, areas) => [...new Set([home, ...[...splitList(more), ...areaVillages(areas)].filter((s) => Object.hasOwn(VILLAGES, s))])].filter(Boolean);

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
//   user        a person (role 'user' or missing, one village, maybe more: userVillages); searches only those villages
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
  await buildIndexes();   // before this login is added to them
  await redis('HSET', `user:${id}`, ...fields, 'name', name, 'phone', phone, 'created', new Date().toISOString(),
    'retired', '0', 'hash', hash, 'ownpw', '0', 'by', by, 'byName', byName);
  await redis('SET', `pw:${hash}`, id);
  await redis('SADD', 'users', id);
  if (phone) await redis('SADD', `phone:${phone}`, id);
  if (fields[fields.indexOf('role') + 1] === 'admin') await redis('SADD', 'admins', id);
  return { id, password };
}

// Indexes, so a login, a sign-up or opening the app doesn't read every login: "phone:<number>" → the ids of that number's
// logins, "admins" → the village admins' ids, "selfcount:<village>" → how many logins were made there by signing up
// (free searches go by it, freeFor). Built once from every login when the marker "idxbuilt" is missing (a database from
// before them), then kept up to date: newLogin, signup.js "signup" / "move", admin.js "phone" / "promote" / "move".
let indexed = false;
async function buildIndexes() {
  if (indexed || (indexed = !!(await redis('GET', 'idxbuilt')))) return;
  const ids = (await redis('SMEMBERS', 'users')) || [];
  const rows = ids.length ? await pipeline(ids.map((id) => ['HMGET', `user:${id}`, 'phone', 'role', 'village', 'self'])) : [];
  const cmds = [], self = {};
  ids.forEach((id, i) => {
    const [ph, role, vil, s] = rows[i] || [];
    if (ph) cmds.push(['SADD', `phone:${ph}`, id]);
    if (role === 'admin') cmds.push(['SADD', 'admins', id]);
    if (s === '1' && vil) self[vil] = (self[vil] || 0) + 1;
  });
  for (const [vil, n] of Object.entries(self)) cmds.push(['SET', `selfcount:${vil}`, n, 'NX']);
  for (let i = 0; i < cmds.length; i += 1000) await pipeline(cmds.slice(i, i + 1000));
  await redis('SET', 'idxbuilt', new Date().toISOString());
  indexed = true;
}
const selfCount = async (slug) => { await buildIndexes(); return Number(await redis('GET', `selfcount:${slug}`)) || 0; };
// a person's login moved from village `from` to `to` (signup.js "move", admin.js "move"): the sign-up count of both
// villages, and their open pack requests now belong to the new village and go to its admin (adminFor)
async function afterMove(u, from, to) {
  await buildIndexes();
  if (u.self === '1') await pipeline([['DECR', `selfcount:${from}`], ['INCR', `selfcount:${to}`]]);
  const open = await pipeline(PACKS.map(([n]) => ['GET', `reqopen:${u.id}:${n}`]));
  const admin = await adminFor({ ...u, village: to });
  for (const r of await Promise.all(open.filter(Boolean).map(getReq))) {
    if (r && r.user === u.id && r.status === 'open') await redis('HSET', `req:${r.id}`, 'village', to, 'to', admin.id);
  }
}

// A password the person chose (sign-up, or पासवर्ड बदलें in the app) is kept under pw:<hash of number + password>, so two
// people may choose the same one; a login with a number tries that first (api/unlock.js), then the made-up ones'
// pw:<hash of password>. 6–40 characters, upper and lower case the same (pwHash).
const PW_MIN = 6, PW_MAX = 40;
const ownPwHash = (phone, pw) => pwHash(`${phone}:${String(pw || '').trim()}`);
const badOwnPassword = (pw) => { const n = String(pw || '').trim().length; return n < PW_MIN || n > PW_MAX; };
// → '' when set, else 'pw_short' | 'pw_taken' (this number's other login already has it) | 'phone'
// The login is marked ownpw '1': its password works only with this number (hasOwnPassword).
async function setOwnPassword(u, pw) {
  if (badOwnPassword(pw)) return 'pw_short';
  if (!u.phone) return 'phone';
  const hash = ownPwHash(u.phone, pw), was = await redis('GET', `pw:${hash}`);
  if (was && was !== u.id) return 'pw_taken';
  if (u.hash && u.hash !== hash) await redis('DEL', `pw:${u.hash}`);
  await redis('HSET', `user:${u.id}`, 'hash', hash, 'ownpw', '1');
  await redis('SET', `pw:${hash}`, u.id);
  return '';
}
// is this login's password one the person chose (kept with their number)? Logins from before the "ownpw" mark: the
// signed-up ones are
const hasOwnPassword = (u) => u.ownpw === '1' || (u.ownpw === undefined && u.self === '1');

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
  u.more = u.role === 'admin' ? [] : splitList(u.more);   // a person's extra villages, one by one
  u.areas = u.role === 'admin' ? [] : splitList(u.areas);   // and whole ZP / PS wards
  u.villages = u.role === 'admin' ? adminVillages(u.villages, u.samitis.join(',')) : userVillages(u.village, u.more.join(','), u.areas.join(','));
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
    return { id: 'admin', name: 'सुपर एडमिन', role: 'super', admin: true, villages: Object.keys(VILLAGES), status: 'ok', perms: PERMS.slice(),
      survey: await markModeOf(null) };
  }
  const t = parseToken(token);
  if (t && t.id.startsWith('demo_')) {   // a demo phone: no user record, nothing it may do but search
    return { id: t.id, name: 'डेमो', role: 'user', demo: true, admin: false, villages: demoSlugs(), perms: [], sid: t.sid,
      status: slug != null && slug !== DEMO.slug && !demoOf(slug) ? 'other_village' : 'ok', survey: await markModeOf(null) };
  }
  const user = t && t.id !== 'admin' ? await getUser(t.id) : null;
  if (!user) return null;
  user.survey = await markModeOf(user);
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
// list: its मतदाता सूची (voters by mark) — both api/_routes/progress.js
const DEFAULT_PERMS = ['mark', 'print', 'progress'];   // for new users, and users added before permissions existed
const permsOf = (u) => (u.perms === undefined ? DEFAULT_PERMS.slice() : String(u.perms).split(',').filter((p) => PERMS.includes(p)));
// an admin's in the app: all of them until the superadmin sets them (admins made before these could be set)
const appPerms = (u) => (u.role === 'admin' && u.perms === undefined ? PERMS.slice() : permsOf(u));
// What a village admin may do on the admin page, set by the superadmin (field "aperms"; admins made before these
// existed: all of them):
//   add: make new users · own: see and look after the users they made · all: see and look after every user of their
//   villages. (Admins no longer add searches or take payments: 'credits' and 'approve' stored on older admins are ignored.)
// Powers the superadmin may hand to a trusted admin (never on by default, not even for older admins):
//   admins: make village admins of their own villages, promote their users to admin, and look after the admins they made
//   arights: tick these same boxes on the admins they made (only the ones they have themselves)
//   asearch: daily limit / extra searches of the admins they made
//   gift: free searches added for good to a signed-up (self-made) user they look after
//   wardpay: ward slips free / paid for a user they look after (wardFree; admin.js "ward_pay_user")
const ADMIN_PERMS = ['add', 'own', 'all', 'admins', 'arights', 'asearch', 'gift', 'wardpay'];
const OLD_ADMIN_PERMS = ['add', 'own', 'all'];   // an admin made before these could be set
const GIFT_MAX = 1000;   // free searches one "gift" may add
const PROMOTED_PERMS = ['add', 'own'];   // a user made admin (api/_routes/admin.js "promote")
const adminPermsOf = (u) => (u.role !== 'admin' ? [] : u.aperms === undefined ? OLD_ADMIN_PERMS.slice()
  : String(u.aperms).split(',').filter((p) => ADMIN_PERMS.includes(p)));
// today's date in India, for the per-person daily search count
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
// Searches a user may start per day (see api/_routes/search.js for what one search is): their own limit if their admin set one
// (user field "limit"), else DAILY_SEARCHES, plus any extra the admin gave for today (field "extra" = "<day>:<n>").
// A village admin has the same daily limit (adminLimited; the superadmin may change it) and may buy more searches, or
// ask the superadmin for them on WhatsApp (adminFor). The superadmin has no limit.
const DAILY_SEARCHES = 500;
const extraToday = (u) => { const [d, n] = String(u.extra || '').split(':'); return d === today() ? Number(n) || 0 : 0; };
const dailyLimit = (u) => (Number(u.limit) || DAILY_SEARCHES) + extraToday(u);
const adminLimited = (u) => u.role === 'admin';
// Prepaid searches (api/signup.js): a user who signed up by themselves (field "self") may start "credits" searches in all
// (free ones from signing up, invites and coupons, plus ones bought online, api/pay.js) instead of a daily limit; they
// never expire and are counted for good under "paid:<id>". Users made by an admin have a daily limit instead, and may
// buy searches too (canBuy): theirs are used once the day's limit is used up, and counted the same way.
const credits = (u) => Number(u && u.credits) || 0;
const isPrepaid = (u) => !!u && u.role === 'user' && !u.demo && u.self === '1';
const canBuy = (u) => !!u && (u.role === 'user' || u.role === 'admin') && !u.demo;   // not the superadmin
// the village a login's pack request is filed under: a person's own village; a village admin's, the one they are in
// (slug) when it is theirs, else their first
const buyVillage = (u, slug) => u.village || (slug && (u.villages || []).includes(slug) ? slug : (u.villages || [])[0]) || '';
// a signed-up login that picked the wrong village may move itself to another one this many times (api/signup.js "move")
const MOVES = 3;
const movesLeft = (u) => (isPrepaid(u) ? Math.max(0, MOVES - (Number(u.moves) || 0)) : 0);
// free searches for a login made by signing up, counted per village (none for a number that signed up before; api/signup.js).
// The superadmin sets the rule on the admin page (key "freerule", api/_routes/admin.js "free_rule"), FREE until then:
//   mode 'direct': the village's first `people` sign-ups get `searches` each, later ones none;
//   mode 'halving': the first `people` get `searches`, the next `people` half of it, and so on down to 1, then none
//                   (10 → 5 → 2 → 1).
//   cap: at most this many free searches in all per village (counted in hash "freegiven" by village, takeFree), 0 = no limit;
//        the sign-up that reaches it gets what is left. The referral bonus is not counted.
const FREE = { mode: 'direct', people: 10, searches: 10, cap: 0 };
const FREE_MAX = { people: 100000, searches: 1000, cap: 10000000 };
async function freeRule() {
  const h = (await redis('HGETALL', 'freerule')) || [], o = {};
  for (let i = 0; i < h.length; i += 2) o[h[i]] = h[i + 1];
  const num = (v, max, d, min = 1) => { const n = Math.floor(Number(v)); return n >= min && n <= max ? n : d; };
  return { mode: o.mode === 'halving' ? 'halving' : 'direct', people: num(o.people, FREE_MAX.people, FREE.people),
    searches: num(o.searches, FREE_MAX.searches, FREE.searches), cap: num(o.cap, FREE_MAX.cap, FREE.cap, 0) };
}
// free searches for the village's sign-up number n + 1 (n = sign-ups there so far) under rule, before the cap
function freeFor(rule, n) {
  if (rule.mode !== 'halving') return n < rule.people ? rule.searches : 0;
  return Math.floor(rule.searches / 2 ** Math.floor(n / rule.people));
}
// free searches given by signing up in this village so far. A village from before the count starts at what the current
// rule gave its sign-ups.
async function freeGiven(slug, rule) {
  const v = await redis('HGET', 'freegiven', slug);
  if (v != null) return Number(v) || 0;
  const n = await selfCount(slug);
  let s = 0;
  for (let i = 0; i < n; i++) s += freeFor(rule, i);
  await redis('HSETNX', 'freegiven', slug, s);
  return Number(await redis('HGET', 'freegiven', slug)) || 0;
}
// what a sign-up would get now: want = freeFor(...), less if the village's cap is nearly used up
const freeLeft = async (slug, rule, want) => (rule.cap && want ? Math.min(want, Math.max(0, rule.cap - await freeGiven(slug, rule))) : want);
// a sign-up takes up to `want` free searches from the village's count; returns how many it got (never past the cap,
// even with sign-ups at the same moment)
async function takeFree(slug, rule, want) {
  if (!want) return 0;
  await freeGiven(slug, rule);
  const t = Number(await redis('HINCRBY', 'freegiven', slug, want));
  const got = rule.cap ? Math.max(0, Math.min(want, rule.cap - (t - want))) : want;
  if (got < want) await redis('HINCRBY', 'freegiven', slug, got - want);
  return got;
}
// Referrals (रेफ़रल): a user's invite link is <site>/<village>?ref=<their id> (the app's 🎁 दोस्तों को रेफ़र करें button). A new
// number that signs up through it gets `joiner` extra searches (not a number that signed up before), and the login
// keeps refBy / refByName. Every time that person pays (addPaid, wardDone), the inviter gets `pct`% of what they paid as
// ₹ cashback in their wallet (walletAdd below), and on every `bonusAt`-th friend who buys (the 5th, 10th…) `bonus` ₹ more
// (refReward; field refPaid on the new login marks its first purchase; the inviter counts refBought, refCash, refBonus;
// refEarned is the searches older rewards gave). The superadmin sets it on the admin page (key "refrule",
// api/_routes/admin.js "ref_rule"), REF until then.
const REF = { on: true, pct: 5, joiner: 5, bonusAt: 5, bonus: 100, apct: 10 };   // apct: a village admin's % on a sale by QR (agentReward)
const REF_PCT_MAX = 50, REF_AT_MAX = 100;
const REF_MAX = 1000;
async function refRule() {
  const h = (await redis('HGETALL', 'refrule')) || [], o = {};
  for (let i = 0; i < h.length; i += 2) o[h[i]] = h[i + 1];
  const num = (v, d) => { const n = Math.floor(Number(v)); return n >= 0 && n <= REF_MAX && v !== undefined && v !== '' ? n : d; };
  const pct = num(o.pct, REF.pct), at = num(o.bonusAt, REF.bonusAt);
  return { on: o.on === undefined ? REF.on : o.on === '1', pct: Math.min(pct, REF_PCT_MAX), joiner: num(o.joiner, REF.joiner),
    bonusAt: Math.min(at, REF_AT_MAX), bonus: num(o.bonus, REF.bonus), apct: Math.min(num(o.apct, REF.apct), REF_PCT_MAX) };
}
// what the app needs for the invite button: this login's code, what the inviter gets and how many of their friends have
// bought (count, toward the next bonus); null for those who can't invite
async function refFor(u) {
  if (!canBuy(u) || u.role !== 'user') return null;   // admins don't invite
  const rule = await refRule();
  return rule.on ? { code: u.id, pct: rule.pct, joiner: rule.joiner, bonusAt: rule.bonusAt, bonus: rule.bonus, count: Number(u.refBought) || 0 } : null;
}
// the inviter for a new number: the ?ref= code of an invite link, or the code or mobile number typed at sign-up →
// an active user login with another number, or null
async function refInviter(code, phone) {
  code = String(code || '').trim().toLowerCase();
  let u = /^[0-9a-f]{10}$/.test(code) ? await getUser(code) : null;   // a 10-digit mobile number looks like a code too
  if (!u) {
    const ph = normPhone(code);
    const l = ph ? (await phoneLogins(ph)).find((x) => x.role === 'user' && x.retired !== '1') : null;
    u = l ? await getUser(l.id) : null;
  }
  return u && canBuy(u) && u.role === 'user' && u.retired !== '1' && u.phone !== phone ? u : null;
}

// the referrer a buyer names at checkout (api/pay.js 'start' with ref): their code (login id, as in the invite link) or
// their mobile number → an active user login that may invite, never the buyer themself (same login or number); else null
async function refBuyer(code, me) {
  code = String(code || '').trim().toLowerCase();
  let u = null;
  if (/^[0-9a-f]{10}$/.test(code)) u = await getUser(code);   // a 10-digit mobile number looks like a code too
  if (!u) {
    const ph = normPhone(code);
    if (ph) {
      const l = (await phoneLogins(ph)).find((x) => x.role === 'user' && x.retired !== '1');
      u = l ? await getUser(l.id) : null;
    }
  }
  return u && canBuy(u) && u.role === 'user' && u.retired !== '1' && u.id !== me.id && (!me.phone || u.phone !== me.phone) ? u : null;
}

// every login with this mobile number (normPhone form): [{id, role, village, villages, retired, self}]
async function phoneLogins(phone) {
  if (!phone) return [];
  await buildIndexes();
  const ids = (await redis('SMEMBERS', `phone:${phone}`)) || [];
  if (!ids.length) return [];
  const rows = await pipeline(ids.map((id) => ['HMGET', `user:${id}`, 'phone', 'role', 'village', 'villages', 'retired', 'self', 'samitis', 'more', 'areas']));
  return ids.map((id, i) => {
    const [ph, role, vil, vils, retired, self, sams, more, areas] = rows[i] || [];
    if (ph !== phone) return null;   // the number was changed since
    return { id, role, village: vil, villages: role === 'admin' ? adminVillages(vils, sams) : userVillages(vil, more, areas),
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
  if (u.role === 'admin' || u.by === 'admin') return SUPER;   // a village admin asks the superadmin
  await buildIndexes();
  const ids = (await redis('SMEMBERS', 'admins')) || [];
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
const PACKS = [[100, 50], [200, 100], [500, 200], [800, 325], [1000, 400]];
// A purchase of a pack, key req:<id>, id = 8 digits: made when a person pays online (api/pay.js 'start'). Fields:
// user, village, n, rs, created, status 'open' | 'done' | 'rejected', gw, txn, link, and once paid or closed doneAt,
// doneBy, doneByName (paid: also doneN, doneRs). Older ones (before searches could only be bought online) were WhatsApp
// requests to an admin, without gw; the superadmin can still close those (api/_routes/admin.js 'req_reject').
// what a number of searches costs: the pack's price, else 50 paise a search (SEARCH_PER_RS searches for ₹1)
const SEARCH_PER_RS = 2;
const packPrice = (n) => { const pk = PACKS.find(([k]) => k === Number(n)); return pk ? pk[1] : Math.ceil((Number(n) || 0) / SEARCH_PER_RS); };
// Coupons (कूपन), made by the superadmin on the admin page (api/_routes/admin.js "coupon_set"): hash coupon:<CODE> with kind
// 'pct' (value % off the pack's price) | 'rs' (₹value off) | 'bonus' (value extra searches) | 'bonuspct' (value % of the
// pack's searches extra), maxOff (the most it gives for 'pct': ₹ off, for 'bonuspct': extra searches; 0 = no limit), and
// its conditions:
// minN / maxN (only packs of at least minN / at most maxN searches, 0 = any), until (last day, YYYY-MM-DD, '' = none), maxUses (total, 0 = no limit),
// once '1' (once per person), first '1' (only a person's first purchase), on '1' / '0', show '1' (listed in the buy
// window for everyone it fits, api/signup.js "coupons"; else only someone who has the code can use it); used = times
// used so far; note; banner '1' (shown as a banner in the app to everyone it fits; tapping it opens the buy window with
// the coupon applied) with bannerText (its words, '' = made from the coupon).
// Set "coupons" lists the codes; cpnusers:<CODE> = who has used it. A request made with a coupon (api/signup.js
// 'request', api/pay.js 'start') keeps coupon, bonus and the lower rs; the coupon is counted as used when it is paid
// (addPaid). A price never goes below ₹1.
const COUPON_RE = /^[A-Z0-9]{3,15}$/;
const couponCode = (c) => String(c || '').trim().toUpperCase();
async function getCoupon(code) {
  code = couponCode(code);
  if (!COUPON_RE.test(code)) return null;
  const arr = await redis('HGETALL', `coupon:${code}`);
  if (!arr || !arr.length) return null;
  const c = { code };
  for (let i = 0; i < arr.length; i += 2) c[arr[i]] = arr[i + 1];
  for (const k of ['value', 'maxOff', 'minN', 'maxN', 'maxUses', 'used']) c[k] = Number(c[k]) || 0;
  for (const k of ['once', 'first', 'on', 'show', 'banner']) c[k] = c[k] === '1';
  c.until = c.until || ''; c.bannerText = c.bannerText || '';
  return c;
}
// what pack n costs with coupon c: {rs, bonus}
function couponPrice(c, n) {
  const base = packPrice(n);
  const most = (x) => (c.maxOff ? Math.min(x, c.maxOff) : x);   // the coupon's highest limit
  if (c.kind === 'pct') return { rs: Math.max(1, base - most(base - Math.round(base * (100 - c.value) / 100))), bonus: 0 };
  if (c.kind === 'rs') return { rs: Math.max(1, base - c.value), bonus: 0 };
  if (c.kind === 'bonuspct') return { rs: base, bonus: most(Math.floor(Number(n) * c.value / 100)) };
  return { rs: base, bonus: c.value };
}
// can person u use coupon `code` (for pack n, if given)? → {c} or {error}
async function couponFor(code, u, n) {
  const c = await getCoupon(code);
  if (!c) return { error: 'cpn_none' };
  if (!c.on) return { error: 'cpn_off' };
  if (c.until && today() > c.until) return { error: 'cpn_expired' };
  if (c.maxUses && c.used >= c.maxUses) return { error: 'cpn_used_up' };
  if (c.first && u.bought === '1') return { error: 'cpn_first' };
  if (c.once && await redis('SISMEMBER', `cpnusers:${c.code}`, u.id)) return { error: 'cpn_used' };
  if (n != null && c.minN && Number(n) < c.minN) return { error: 'cpn_min', minN: c.minN };
  if (n != null && c.maxN && Number(n) > c.maxN) return { error: 'cpn_max', maxN: c.maxN };
  return { c };
}
// One open request per person per coupon, and one per person with any "first purchase" coupon, so the same coupon
// can't be put on several requests and all of them paid: cpnhold:<CODE>:<user> and cpnhold:first:<user> → the request
// holding it. A newer WhatsApp request takes the coupon over (the older one goes back to the pack's own price); an
// online payment still open keeps it → 'cpn_pending' until it is paid or closed. → '' when request rid may carry c.
async function couponHold(c, uid, rid) {
  const keys = [`cpnhold:${c.code}:${uid}`, ...(c.first ? [`cpnhold:first:${uid}`] : [])];
  for (const k of keys) {
    const held = await redis('GET', k);
    if (!held || held === rid) continue;
    let r = await getReq(held);
    if (r && r.gw === 'razorpay' && r.status === 'open') r = await settleOnline(r.id);
    if (!r || r.status !== 'open' || r.user !== uid || !r.coupon) continue;
    if (r.gw === 'razorpay') return 'cpn_pending';
    await redis('HSET', `req:${r.id}`, 'coupon', '', 'rs', packPrice(r.n), 'bonus', 0);
  }
  for (const k of keys) await redis('SET', k, rid, 'EX', 90 * 86400);
  return '';
}
// counts coupon `code` as used by person uid when a request carrying it is paid, keeping its limits even then: once per
// person (cpnusers:<CODE>), maxUses in all, first purchase only (first: this payment is the person's first). false when
// it can't be used any more: the payment then gets no bonus searches (its price was already asked for and paid). A
// coupon deleted since keeps what it promised.
async function useCoupon(code, uid, first) {
  const c = await getCoupon(code);
  if (!c) return true;
  if (c.first && !first) return false;
  if (!(await redis('SADD', `cpnusers:${c.code}`, uid)) && c.once) return false;
  if (Number(await redis('HINCRBY', `coupon:${c.code}`, 'used', 1)) > c.maxUses && c.maxUses) {
    await redis('HINCRBY', `coupon:${c.code}`, 'used', -1);
    return false;
  }
  return true;
}
// the coupon as the buy window sees it
const couponView = (c) => ({ code: c.code, kind: c.kind, value: c.value, maxOff: c.maxOff, minN: c.minN, maxN: c.maxN, until: c.until, first: c.first,
  show: c.show, banner: c.banner, bannerText: c.bannerText });
async function newReqId() {   // 8 digits no request has yet
  let id;
  do id = String(crypto.randomInt(10000000, 100000000)); while (await getReq(id));
  return id;
}
// Payments: each paid purchase records doneRs = the ₹ paid and doneBy 'admin' / doneByName = GATEWAY's name; pay:rs,
// pay:n, pay:count (hashes, 'admin' → total ₹, searches, payments) add them up. (Before 2026-11 admins also collected
// payments themselves, with a हिसाब per admin; those totals stay in pay:* and settle:*, no longer shown.)
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
// n bought searches for person u, paid through `by` (GATEWAY): the searches, and the payment recorded in request r and
// in the pay:* totals
// A request approved for the pack it asked for keeps its own price; made with a coupon, it also gets the bonus searches
// once the coupon is counted as used (useCoupon: no bonus when its limits are used up meanwhile). Approved for another
// number of searches, the coupon is dropped and the price is the pack's.
async function addPaid(u, n, r, by) {
  const asked = !!r && Number(n) === Number(r.n), now = new Date().toISOString();
  const rs = asked ? Number(r.rs) || packPrice(n) : packPrice(n);
  const first = await redis('HSETNX', `user:${u.id}`, 'bought', '1');   // 1: this is the login's first purchase
  const cpn = asked && r.coupon && (await useCoupon(r.coupon, u.id, Number(first) === 1)) ? r.coupon : '';
  const bonus = cpn ? Number(r.bonus) || 0 : 0;
  await refReward(u.id, rs, r && r.ref);
  if (r && r.agent) await agentReward(r, u, rs);
  await redis('HINCRBY', `user:${u.id}`, 'credits', n + bonus);
  await redis('SREM', 'free', u.id);
  const id = r ? r.id : await newReqId();
  if (!r) {
    await redis('HSET', `req:${id}`, 'user', u.id, 'village', buyVillage(u), 'n', n, 'rs', rs, 'created', now, 'hand', '1');
    await redis('SADD', 'reqs', id);
  }
  await redis('HSET', `req:${id}`, 'status', 'done', 'doneAt', now, 'doneN', n + bonus, 'doneRs', rs, 'doneCoupon', cpn, 'doneBy', by.id, 'doneByName', by.name);
  await redis('HINCRBY', 'pay:rs', by.id, rs);
  await redis('HINCRBY', 'pay:n', by.id, n);
  await redis('HINCRBY', 'pay:count', by.id, 1);
  if (by.id !== 'admin') await redis('HSET', 'pay:name', by.id, by.name);
}
// A whole ward's slips (वार्ड की सभी पर्चियाँ, api/_routes/search.js "all") cost ₹WARD_RS, once per ward: a purchase
// (api/pay.js 'start' with a ward; req:<id> with kind 'ward', ward, wv = its village, n 0) that, once paid, puts the ward
// in the set wardpaid:<user id>:<village>, so that login may print / save it again any time. Only the superadmin never
// pays; village admins pay like everyone else (wardFree).
const WARD_RS = 50;
const wardKey = (uid, slug) => `wardpaid:${uid}:${slug}`;
// the same ward in name order too (नाम क्रम, अ–ज्ञ; api/_routes/search.js "all" with sort 'az'): ₹WARD_AZ_RS more, bought with
// the ward (₹WARD_RS + ₹WARD_AZ_RS) or later on its own; req field az '1'. Free exactly when the ward is (wardFree).
const WARD_AZ_RS = 50;
const wardAzKey = (uid, slug) => `wardaz:${uid}:${slug}`;
// Whether people pay for wards, set by the superadmin on the admin page (api/_routes/admin.js "ward_pay"): key
// "wardpay" '1' = they pay, '0' = every ward free; not set yet → env WARD_PAY=1 to pay, else free. Per person, the
// superadmin may override it (admin.js "ward_pay_user"; user field "wardpay"): 'free' = never pays, 'pay' = pays even
// while it is off for everyone, '' = as for everyone. Wards already paid for stay paid either way.
async function wardPayOn() {
  const v = await redis('GET', 'wardpay');
  return v === '1' ? true : v === '0' ? false : process.env.WARD_PAY === '1';
}
// Per ज़िला and per पंचायत समिति too (admin.js "ward_pay_area"): hash "wardpayarea", field "d:<district>" or
// "s:<district>|<samiti>" (samitiKey) = '1' pay / '0' free, by the ward's village. The person's own setting wins, then
// a self sign-up's pays (wardFree), then the samiti's, then the district's, then the switch for everyone.
async function wardPayAreas() {
  const a = (await redis('HGETALL', 'wardpayarea')) || [], o = {};
  for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = String(a[i + 1]);
  return o;
}
async function wardFree(u, slug) {
  if (!u) return false;
  if (u.role === 'super') return true;
  if (u.wardpay === 'free') return true;
  if (u.wardpay === 'pay') return false;
  // signed up by themselves with a mobile number (api/signup.js): pays even where wards are free for everyone, the
  // samiti or the district; only their own setting above (the superadmin, or an admin with 'wardpay') makes them free
  if (u.self === '1') return false;
  const v = slug && VILLAGES[slug];
  if (v) {
    const areas = await wardPayAreas(), set = areas[`s:${samitiKey(v)}`] ?? areas[`d:${v.district || ''}`];
    if (set === '1' || set === '0') return set === '0';
  }
  return !(await wardPayOn());
}
const wardsPaid = async (u, slug) => (!u || (await wardFree(u, slug)) ? [] : ((await redis('SMEMBERS', wardKey(u.id, slug))) || []).map(String));
const wardsAz = async (u, slug) => (!u || (await wardFree(u, slug)) ? [] : ((await redis('SMEMBERS', wardAzKey(u.id, slug))) || []).map(String));
async function wardDone(u, r, by) {
  const rs = Number(r.rs) || WARD_RS;
  await redis('SADD', wardKey(u.id, r.wv), String(r.ward));
  if (r.az === '1') await redis('SADD', wardAzKey(u.id, r.wv), String(r.ward));
  await refReward(u.id, rs, r.ref);
  await redis('HSET', `req:${r.id}`, 'status', 'done', 'doneAt', new Date().toISOString(), 'doneN', 0, 'doneRs', rs, 'doneBy', by.id, 'doneByName', by.name);
  await redis('HINCRBY', 'pay:rs', by.id, rs);
  await redis('HINCRBY', 'pay:count', by.id, 1);
  if (by.id !== 'admin') await redis('HSET', 'pay:name', by.id, by.name);
}
// login id paid ₹rs: its inviter (refBy) gets the rule's pct% of it as cashback, and on its first purchase it counts
// toward the inviter's refBought, every bonusAt-th of which brings the bonus too (HINCRBY: two friends buying at once
// can't both be the 5th)
// via: the referrer the buyer named at checkout (req field ref, refBuyer): a buyer with no inviter yet becomes theirs
// (refBy, so later purchases reward them too), and this purchase's cashback goes to them either way; a buyer counts once
// toward each such referrer's refBought (set refbuyers:<referrer>)
async function refReward(id, rs, via) {
  if (via) await redis('HSETNX', `user:${id}`, 'refBy', via);
  const refBy = await redis('HGET', `user:${id}`, 'refBy'), to = via || refBy;
  if (!to) return;
  if (to === refBy && via) { const inv0 = await getUser(via); if (inv0) await redis('HSETNX', `user:${id}`, 'refByName', inv0.name || ''); }
  const first = to === refBy ? Number(await redis('HSETNX', `user:${id}`, 'refPaid', '1')) === 1
    : Number(await redis('SADD', `refbuyers:${to}`, id)) === 1;
  const rule = await refRule(), inv = await getUser(to);
  if (!inv || inv.retired === '1') return;
  const count = first ? Number(await redis('HINCRBY', `user:${inv.id}`, 'refBought', 1)) : 0;
  if (!rule.on) return;
  const cash = rule.pct && rs > 0 ? Math.max(1, Math.round((rs * rule.pct) / 100)) : 0;
  const extra = first && rule.bonusAt && rule.bonus && count % rule.bonusAt === 0 ? rule.bonus : 0;
  if (!cash && !extra) return;
  await walletAdd(inv.id, cash + extra);
  await redis('HINCRBY', `user:${inv.id}`, 'refCash', cash + extra);
  if (extra) await redis('HINCRBY', `user:${inv.id}`, 'refBonus', extra);
  if (cash) await redis('HINCRBY', `user:${id}`, 'refGave', cash);
}
// Sales by a village admin (api/_routes/admin.js "agent_start"): the admin makes a Razorpay UPI QR (razorpayQr) for a
// pack for another person's login; that person scans and pays, gets the searches, and the admin (req field agent) gets
// the referral rule's apct% of the price in their wallet, once the payment is in (addPaid). Not for the superadmin's own
// sales, nor a sale to the admin's own number. Counted on the admin as agentSales / agentRs / agentCash, and on the
// purchase as agentCash.
async function agentReward(r, u, rs) {
  const ag = await getUser(r.agent);
  if (!ag || ag.role !== 'admin' || ag.retired === '1' || (ag.phone && ag.phone === u.phone)) return;
  await redis('HINCRBY', `user:${ag.id}`, 'agentSales', 1);
  await redis('HINCRBY', `user:${ag.id}`, 'agentRs', rs);
  const rule = await refRule(), cash = rule.apct && rs > 0 ? Math.max(1, Math.round((rs * rule.apct) / 100)) : 0;
  if (!cash) return;
  await walletAdd(ag.id, cash);
  await redis('HINCRBY', `user:${ag.id}`, 'agentCash', cash);
  await redis('HSET', `req:${r.id}`, 'agentCash', cash);
}
// Wallet (वॉलेट): ₹ cashback, from referrals (refReward) and, for village admins, from their QR sales (agentReward). Kept as field "wallet" on user:<id> (walletIn: all
// ever added). The person may (api/pay.js 'wallet…'):
//   - turn it into searches at any time, ₹1 = 2 searches (as the packs' price, PACKS), added to their credits;
//   - take it out to their UPI ID, from ₹WALLET_MIN up, one withdrawal open at a time: wd:<id> {user, rs, upi, status
//     'pending' | 'processing' | 'paid' | 'failed', created, doneAt, payout, utr, why}, in the sets 'wds' and wds:<user id>.
// With RazorpayX (Razorpay Payouts) set up, the money goes at once by UPI through its API. Set in Vercel, besides the
// Razorpay keys (payOnline): RAZORPAYX_ACCOUNT = the RazorpayX account number to pay from (RazorpayX dashboard → My
// Account; it needs funds in it, and payouts activated for API use). Without it, a withdrawal waits ('pending') for the
// superadmin to send the ₹ by hand and mark it on the admin page (api/_routes/admin.js 'wd_paid' / 'wd_back'). A
// failed or refused withdrawal puts the ₹ back in the wallet, once.
const WALLET_MIN = 50;
const UPI_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;
const walletOf = (u) => Math.max(0, Math.floor(Number(u && u.wallet) || 0));
const hasWallet = (u) => !!u && canBuy(u);   // users (invites) and village admins (agentReward)
const payoutsOn = () => payOnline() && /^\d{6,24}$/.test(String(process.env.RAZORPAYX_ACCOUNT || ''));
async function walletAdd(id, rs) {
  await redis('HINCRBY', `user:${id}`, 'wallet', rs);
  await redis('HINCRBY', `user:${id}`, 'walletIn', rs);
}
// takes rs ₹ out of the wallet; false (and nothing taken) when there isn't that much
async function walletTake(id, rs) {
  const left = Number(await redis('HINCRBY', `user:${id}`, 'wallet', -rs));
  if (left >= 0) return true;
  await redis('HINCRBY', `user:${id}`, 'wallet', rs);
  return false;
}
// wallet → searches: rs ₹ become rs searches
async function walletToSearches(u, rs) {
  if (!(await walletTake(u.id, rs))) return false;
  const n = rs * SEARCH_PER_RS;
  await redis('HINCRBY', `user:${u.id}`, 'credits', n);
  await redis('HINCRBY', `user:${u.id}`, 'walletSearches', n);
  return n;
}
async function getWd(id) {
  if (!/^w[0-9a-f]{12}$/.test(String(id || ''))) return null;
  const arr = await redis('HGETALL', `wd:${id}`);
  if (!arr || !arr.length) return null;
  const r = { id };
  for (let i = 0; i < arr.length; i += 2) r[arr[i]] = arr[i + 1];
  return r;
}
const wdView = (w) => ({ id: w.id, rs: Number(w.rs) || 0, upi: w.upi || '', status: w.status, created: w.created, doneAt: w.doneAt || null,
  utr: w.utr || '', why: w.why || '', auto: !!w.auto });
const wdOpen = (w) => w.status === 'pending' || w.status === 'processing';
// a withdrawal that didn't go through: the ₹ back in the wallet, once
async function wdBack(w, why) {
  if (!(await redis('HSETNX', `wd:${w.id}`, 'settled', '1'))) return getWd(w.id);   // the same lock as wdPaid: one or the other
  await redis('HINCRBY', `user:${w.user}`, 'wallet', Number(w.rs) || 0);
  await redis('HSET', `wd:${w.id}`, 'status', 'failed', 'doneAt', new Date().toISOString(), 'why', String(why || '').slice(0, 200));
  return getWd(w.id);
}
async function wdPaid(w, utr, by) {
  if (!wdOpen(w) || !(await redis('HSETNX', `wd:${w.id}`, 'settled', '1'))) return getWd(w.id);
  await redis('HSET', `wd:${w.id}`, 'status', 'paid', 'doneAt', new Date().toISOString(), 'utr', String(utr || '').slice(0, 40), 'doneBy', by || '');
  await redis('HINCRBY', `user:${w.user}`, 'walletOut', Number(w.rs) || 0);
  return getWd(w.id);
}
// asks Razorpay Payouts to send it (again, with the same idempotency key, when an earlier try got no answer)
async function wdSend(w, u) {
  const mobile = String((u && u.phone) || '').replace(/\D/g, '').slice(-10);
  let j;
  try {
    j = await razorpay('POST', 'payouts', {
      account_number: String(process.env.RAZORPAYX_ACCOUNT), amount: Math.round(Number(w.rs) * 100), currency: 'INR', mode: 'UPI', purpose: 'cashback',
      fund_account: { account_type: 'vpa', vpa: { address: w.upi },
        contact: { name: String((u && u.name) || 'User').slice(0, 50), type: 'customer', reference_id: String(w.user), ...(/^[6-9]\d{9}$/.test(mobile) ? { contact: mobile } : {}) } },
      queue_if_low_balance: true, reference_id: w.id, narration: 'Voter Search cashback', notes: { withdrawal: w.id, user: String(w.user) },
    }, { 'X-Payout-Idempotency': `wd-${w.id}` });
  } catch (e) { console.error('razorpay payout', e); return getWd(w.id); }   // no answer: stays 'processing', tried again later
  if (!j.ok || !j.id) {
    console.error('razorpay payout', j.http, j.error);
    if (j.http >= 400 && j.http < 500) return wdBack(w, (j.error && j.error.description) || `http ${j.http}`);
    return getWd(w.id);
  }
  await redis('HSET', `wd:${w.id}`, 'payout', j.id);
  return wdPayoutState({ ...w, payout: j.id }, j);
}
const PAYOUT_FAILED = ['failed', 'rejected', 'reversed', 'cancelled'];
function wdPayoutState(w, p) {
  if (p.status === 'processed') return wdPaid(w, p.utr, 'razorpayx');
  if (PAYOUT_FAILED.includes(p.status)) return wdBack(w, (p.status_details && p.status_details.description) || (p.failure_reason) || p.status);
  return getWd(w.id);
}
// a person's withdrawal: rs ₹ to upi → {wd} or {error}
async function wdStart(u, rs, upi) {
  if (!(await walletTake(u.id, rs))) return { error: 'wallet_low' };
  const id = 'w' + crypto.randomBytes(6).toString('hex'), auto = payoutsOn();
  await redis('HSET', `wd:${id}`, 'user', u.id, 'rs', rs, 'upi', upi, 'status', auto ? 'processing' : 'pending', 'created', new Date().toISOString(), ...(auto ? ['auto', '1'] : []));
  await redis('SADD', 'wds', id);
  await redis('SADD', `wds:${u.id}`, id);
  await redis('HSET', `user:${u.id}`, 'upi', upi);
  const w = await getWd(id);
  return { wd: auto ? await wdSend(w, u) : w };
}
// an automatic withdrawal still going: how it stands with Razorpay now
async function wdSettle(w) {
  if (!w || w.status !== 'processing' || !w.auto || !payOnline()) return w;
  if (!w.payout) return wdSend(w, await getUser(w.user));
  const p = await razorpay('GET', `payouts/${encodeURIComponent(w.payout)}`).catch(() => null);
  return p && p.ok ? wdPayoutState(w, p) : w;
}
// a login's withdrawals, newest first (the open automatic ones asked about first)
async function wdsOf(uid, n = 10) {
  const ids = (await redis('SMEMBERS', `wds:${uid}`)) || [];
  const all = (await Promise.all(ids.map(getWd))).filter(Boolean).sort((a, b) => (a.created < b.created ? 1 : -1)).slice(0, n);
  return Promise.all(all.map(wdSettle));
}
// Online payment (api/pay.js) through Razorpay (razorpay.com): a Razorpay order for each purchase, for its exact price,
// paid in Razorpay's checkout window on our own page (index.html buyUpi) with the person's name and mobile number filled
// in and locked, so they type nothing but choose how to pay (UPI, card, net banking, wallet…). Set in Vercel:
//   RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET   from Razorpay's dashboard → Account & Settings → API Keys (rzp_live_… for
//                                           real payments; rzp_test_… keys make test payments only)
// Without them there is no online payment.
// A purchase paid this way has gw: 'razorpay', txn = the order's id (rzp:<txn> → purchase id).
// The money goes to the superadmin's Razorpay account, so it counts as collected by the superadmin. A purchase's status
// is only ever taken from Razorpay's own API, never from what a phone or a webhook says (the checkout's signature is
// checked too, razorpaySigned, but the order is still asked about).
const GATEWAY = { id: 'admin', name: 'ऑनलाइन (Razorpay)' };   // who approves an online purchase (the superadmin)
const payOnline = () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const isOrderId = (id) => /^order_[0-9A-Za-z]{6,40}$/.test(String(id || ''));
const isQrId = (id) => /^qr_[0-9A-Za-z]{6,40}$/.test(String(id || ''));
const isTxnId = (id) => isOrderId(id) || isQrId(id);   // a purchase's txn: a checkout order, or a UPI QR (razorpayQr)
async function razorpay(method, path, body, extra) {   // path after /v1/, e.g. 'orders'; extra: more headers
  const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const r = await fetch(`${(process.env.RAZORPAY_URL || 'https://api.razorpay.com').replace(/\/+$/, '')}/v1/${path}`, {
    method, headers: { Accept: 'application/json', Authorization: `Basic ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(extra || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = { error: { description: text.slice(0, 200) } }; }
  return { ...j, ok: r.ok, http: r.status };   // j.status: the order's or payment's own status
}
// makes an order for purchase id → {txn} or {error}
async function razorpayCreate({ id, rs, n, ward }) {
  const j = await razorpay('POST', 'orders', { amount: Math.round(Number(rs) * 100), currency: 'INR', receipt: String(id),
    notes: { purchase: String(id), ...(ward ? { ward: String(ward) } : { searches: String(n) }) } });
  if (!j.ok || !isOrderId(j.id)) return { error: (j.error && j.error.description) || `http ${j.http}`, raw: j };
  return { txn: j.id };
}
// A UPI QR code (Razorpay → Payments → QR Codes; the account needs it turned on) for purchase id: single use, for the
// exact price, closing by itself after QR_MIN minutes. → {txn: its id (qr_…), image: Razorpay's picture of it, closeBy} or {error}
const QR_MIN = 30;
async function razorpayQr({ id, rs, n, who }) {
  const closeBy = Math.floor(Date.now() / 1000) + QR_MIN * 60;
  const j = await razorpay('POST', 'payments/qr_codes', { type: 'upi_qr', name: 'Voter Search', usage: 'single_use', fixed_amount: true,
    payment_amount: Math.round(Number(rs) * 100), description: `${n} searches${who ? ` · ${who}` : ''}`.slice(0, 100), close_by: closeBy,
    notes: { purchase: String(id), searches: String(n) } });
  if (!j.ok || !isQrId(j.id)) return { error: (j.error && j.error.description) || `http ${j.http}`, raw: j };
  return { txn: j.id, image: j.image_url || '', closeBy: new Date(closeBy * 1000).toISOString() };
}
// the checkout's answer: Razorpay signs "<order id>|<payment id>" with our key secret
function razorpaySigned(order, payment, sig) {
  if (!isOrderId(order) || !/^pay_[0-9A-Za-z]{6,40}$/.test(String(payment || '')) || !/^[0-9a-f]{64}$/.test(String(sig || ''))) return false;
  const want = require('crypto').createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${order}|${payment}`).digest('hex');
  return sameText(want, sig);
}
// A webhook really from Razorpay: X-Razorpay-Signature is the HMAC-SHA256 of the body with the webhook secret
// (RZP_WB_SECRET, set in Razorpay → Webhooks). Vercel hands over the body already parsed, so besides the raw text (when
// there is one) it is also tried as JSON written back out, with and without the \/ and \uXXXX escaping Razorpay uses.
// No secret set → true (the order is checked with Razorpay itself anyway, settleOnline).
function razorpayHook(req, b) {
  const secret = process.env.RZP_WB_SECRET;
  if (!secret) return true;
  const sig = String((req.headers && req.headers['x-razorpay-signature']) || '');
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const j = JSON.stringify(b), slash = j.replace(/\//g, '\\/');
  const uni = (t) => t.replace(/[\u007f-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  const raw = req.rawBody != null ? String(req.rawBody) : typeof req.body === 'string' ? req.body : null;
  return [raw, j, slash, uni(j), uni(slash)].some((t) => t != null && sameText(crypto.createHmac('sha256', secret).update(t).digest('hex'), sig));
}
// the order's state → 'paid' | 'open', with the amount paid in ₹. A payment only authorized (an account set to capture
// by hand) is captured here, so the money is taken and the order counts as paid.
async function razorpayStatus(r) {
  if (isQrId(r.txn)) {   // a UPI QR: its payments
    const ps = await razorpay('GET', `payments/qr_codes/${r.txn}/payments`);
    for (const p of (ps.ok && ps.items) || []) {
      if (p.status === 'captured') return { st: 'paid', amount: Number(p.amount) / 100 };
      if (p.status === 'authorized') {
        const c = await razorpay('POST', `payments/${p.id}/capture`, { amount: p.amount, currency: p.currency || 'INR' });
        if (c.ok && c.status === 'captured') return { st: 'paid', amount: Number(c.amount) / 100 };
      }
    }
    return { st: 'open' };
  }
  if (!isOrderId(r.txn)) return { st: 'open' };
  const o = await razorpay('GET', `orders/${r.txn}`);
  if (!o.ok) return { st: 'open' };
  if (o.status === 'paid') return { st: 'paid', amount: Number(o.amount_paid) / 100 };
  if (o.status !== 'attempted') return { st: 'open' };
  const ps = await razorpay('GET', `orders/${r.txn}/payments`);
  for (const p of (ps.ok && ps.items) || []) {
    if (p.status === 'captured') return { st: 'paid', amount: Number(p.amount) / 100 };
    if (p.status === 'authorized' && Number(p.amount) === Number(o.amount)) {
      const c = await razorpay('POST', `payments/${p.id}/capture`, { amount: p.amount, currency: p.currency || 'INR' });
      if (c.ok && c.status === 'captured') return { st: 'paid', amount: Number(c.amount) / 100 };
    }
  }
  return { st: 'open' };
}
// asks Razorpay how the purchase's payment stands: paid (at least the pack's price, give or take ₹1) → the searches are
// added, once (an order that is never paid stays open; the superadmin may close it). → the purchase as it now is
// Requests made with the gateways used before (gw 'jadupe', 'instamojo') are left as they are, for the admin to settle.
async function settleOnline(rid) {
  const r = await getReq(rid);
  if (!r || r.gw !== 'razorpay' || r.status !== 'open' || !r.txn || !payOnline()) return r;
  const s = await razorpayStatus(r);
  if (s.st === 'paid' && s.amount >= Number(r.rs) - 1) {
    const u = await getUser(r.user);
    if (u && await redis('SET', `reqlock:${r.id}`, GATEWAY.id, 'NX')) await (r.kind === 'ward' ? wardDone(u, r, GATEWAY) : addPaid(u, Number(r.n), r, GATEWAY));
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
// Two sets of marks, kept apart: the survey before the election (सर्वे: done = अपना वोट, coming = सोच रहे हैं,
// absent = विपक्ष; hashes "smark:…") and polling day (मतदान दिवस: वोट दिया / आ रहे हैं / वोटर नहीं है; "mark:…"). The
// buttons, reports, lists and "clear" work on the set in use, and on polling day each slip also shows its survey mark.
// Which set: only the superadmin decides, for everyone (keys "markmode" and "markmodeat", api/_routes/admin.js
// "mark_mode"). A person's own old choice (user fields markmode / markmodeAt) no longer counts. whoIs gives it as
// .survey, which the routes pass on.
async function markModeOf() {   // the superadmin's choice for everyone → true for the survey
  return (await redis('GET', 'markmode')) === 'survey';
}
const markKey = (v) => `${parseInt(v.ward, 10)}:${parseInt(v.box, 10)}`;
const markHash = (slug, cand, survey) => `${survey ? 'smark' : 'mark'}:${slug}${cand ? `:c:${cand}` : ''}`;
function parseMark(val) {
  const [m = '', at = '', byId = '', by = ''] = val ? String(val).split('|') : [];
  return { m, at, byId, by };
}
async function marksFor(slug, keys, cand, survey) {
  if (!keys.length) return [];
  const vals = (await redis('HMGET', markHash(slug, cand, survey), ...keys)) || [];
  return keys.map((k, i) => parseMark(vals[i]));
}
const allMarks = async (slug, cand, survey) => marksFrom(await redis('HGETALL', markHash(slug, cand, survey)));
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
  // where its workers mark: its own village and every other village one of them opens (field more, kept by candReach)
  c.villages = [...new Set([c.village, ...splitList(c.more)])].filter(Boolean);
  return c;
}
// a candidate's worker opens these villages: their marks there belong to the candidate's group, so the admin page shows
// the group in those villages too
async function candReach(id, slugs) {
  const c = await getCand(id);
  if (!c) return;
  const add = slugs.filter((s) => !c.villages.includes(s));
  if (add.length) await redis('HSET', `cand:${id}`, 'more', [...c.villages.slice(1), ...add].join(','));
}

module.exports = { SEARCH_PER_RS, WALLET_MIN, UPI_RE, walletOf, hasWallet, payoutsOn, walletToSearches, getWd, wdView, wdOpen, wdBack, wdPaid, wdStart, wdSettle, wdsOf, WARD_RS, wardKey, wardFree, wardPayOn, wardPayAreas, wardsPaid, WARD_AZ_RS, wardAzKey, wardsAz, buyVillage, candReach, areaSize, areaKeyOf, areaVillages, userVillages, buildIndexes, selfCount, afterMove, hasOwnPassword, couponHold, REF, REF_MAX, REF_PCT_MAX, REF_AT_MAX, refRule, refFor, refInviter, refBuyer, MARKS, markModeOf, markKey, markHash, parseMark, marksFor, allMarks, getCand, PERMS, DEFAULT_PERMS, permsOf, appPerms, ADMIN_PERMS, OLD_ADMIN_PERMS, GIFT_MAX, PROMOTED_PERMS, adminPermsOf, adminLimited, PW_MIN, ownPwHash, badOwnPassword, setOwnPassword, today, DAILY_SEARCHES, extraToday, dailyLimit,
  FREE, FREE_MAX, freeRule, freeFor, freeLeft, takeFree, credits, isPrepaid, canBuy, phoneLogins, adminFor, adminPhone, PACKS, packPrice, COUPON_RE, couponCode, getCoupon, couponPrice, couponFor, couponView, newReqId, isReqId, getReq, paidKey, creditsLeft, addPaid, GATEWAY, payOnline, isOrderId, isQrId, isTxnId, QR_MIN, razorpayQr, razorpayCreate, razorpaySigned, razorpayHook, settleOnline, normPhone,
  OTP, otpOn, newOtp, checkOtp, canMoveUserData, moveUserData, COPY_DONE, usesMongo: !!MONGO_DB, MOVES, movesLeft, DEMO, demoOf, demoSlugs, isDevice, demoId, village, villageList, samitiKey, samitiKeys, redis, pipeline, dataKey, pwHash, newSession, makeToken, parseToken, sameText, isAdminPassword, adminToken, isAdminToken,
  whoIs, newPassword, freshPassword, newLogin, getUser, getUsers, marksFrom, clientIp, deviceName, blocked, failed, send, route };
