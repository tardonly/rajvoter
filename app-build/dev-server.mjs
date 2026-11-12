// Local test server that behaves like Vercel for this app: serves voter-search-app/, runs api/*.js,
// applies the village rewrites from vercel.json (/<village>, /demo/<village>, /<village>/manifest.webmanifest) and its
// redirects (the old per-village admin address /<village>/admin → /admin, the old demo address /demo-<village> →
// /demo/<village>),
// and stands in for the Upstash Redis database with an in-memory store (wiped on restart).
// Usage:  ADMIN_PASSWORD=some-test-password node app-build/dev-server.mjs   → http://127.0.0.1:8765
// DEV_USER_REDIS=1 also stands in for an outside Redis (USER_REDIS_URL, spoken over Redis's own protocol on PORT + 1),
// a second in-memory store: the app then keeps its data there, and the Upstash stand-in is the "old" database the admin
// page copies from.
import http from 'node:http';
import net from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'voter-search-app');
const PORT = Number(process.env.PORT || 8765);
process.env.DATA_KEY ||= readFileSync(join(here, 'DATA_KEY.txt'), 'utf8').trim();
process.env.ADMIN_PASSWORD ||= 'admin-test';
// DEV_UPSTASH_URL: use another dev server's store (http://127.0.0.1:<its port>/__redis) as Upstash — with MONGODB_URI set,
// the admin page then copies that server's data into MongoDB
process.env.KV_REST_API_URL = process.env.DEV_UPSTASH_URL || `http://127.0.0.1:${PORT}/__redis`;
process.env.KV_REST_API_TOKEN = 'local';
// DEV_OTP=1: sign-up asks for an OTP; the "provider" is /__otp here, and /__otp/last?mobile=<10 digits> shows the code
if (process.env.DEV_OTP) process.env.OTP_SEND_URL = `http://127.0.0.1:${PORT}/__otp?mobile={mobile}&otp={otp}`;
const otps = new Map();
if (process.env.DEV_USER_REDIS) process.env.USER_REDIS_URL = `redis://127.0.0.1:${PORT + 1}`;
const require = createRequire(import.meta.url);

// --- tiny Redis stand-in: only the commands the API uses (and the database copy: SCAN, TYPE, PTTL, HSETNX) ---
function makeStore() {
const kv = new Map(), expiry = new Map();
const alive = (k) => { if (expiry.has(k) && expiry.get(k) < Date.now()) { kv.delete(k); expiry.delete(k); } return kv.has(k); };
return function redis([cmd, ...a]) {
  switch (cmd.toUpperCase()) {
    case 'GET': return alive(a[0]) ? kv.get(a[0]) : null;
    case 'SET': {   // SET key value [EX seconds | PX ms] [NX]
      const opt = a.slice(2).map((x) => String(x).toUpperCase());
      if (opt.includes('NX') && alive(a[0])) return null;
      kv.set(a[0], String(a[1])); expiry.delete(a[0]);
      if (opt.includes('EX')) expiry.set(a[0], Date.now() + Number(a[2 + opt.indexOf('EX') + 1]) * 1000);
      if (opt.includes('PX')) expiry.set(a[0], Date.now() + Number(a[2 + opt.indexOf('PX') + 1]));
      return 'OK';
    }
    case 'SCAN': {   // everything in one step: SCAN 0 MATCH <prefix>* COUNT n → ['0', keys]
      const m = a.map((x) => String(x).toUpperCase()).indexOf('MATCH'), pre = m >= 0 ? String(a[m + 1]).replace(/\*$/, '') : '';
      return ['0', [...kv.keys()].filter((k) => alive(k) && k.startsWith(pre))];
    }
    case 'TYPE': { if (!alive(a[0])) return 'none'; const v = kv.get(a[0]); return typeof v === 'string' ? 'string' : v instanceof Set ? 'set' : 'hash'; }
    case 'PTTL': return !alive(a[0]) ? -2 : expiry.has(a[0]) ? expiry.get(a[0]) - Date.now() : -1;
    case 'PEXPIRE': expiry.set(a[0], Date.now() + Number(a[1])); return 1;
    case 'HSETNX': { const h = alive(a[0]) ? kv.get(a[0]) : {}; if (a[1] in h) return 0; h[a[1]] = String(a[2]); kv.set(a[0], h); return 1; }
    case 'DEL': return kv.delete(a[0]) ? 1 : 0;
    case 'DECR': { const n = Number(alive(a[0]) ? kv.get(a[0]) : 0) - 1; kv.set(a[0], String(n)); return n; }
    case 'INCR': { const n = Number(alive(a[0]) ? kv.get(a[0]) : 0) + 1; kv.set(a[0], String(n)); return n; }
    case 'EXPIRE': expiry.set(a[0], Date.now() + Number(a[1]) * 1000); return 1;
    case 'HSET': { const h = alive(a[0]) ? kv.get(a[0]) : {}; for (let i = 1; i < a.length; i += 2) h[a[i]] = String(a[i + 1]); kv.set(a[0], h); return 1; }
    case 'HGET': { const h = alive(a[0]) ? kv.get(a[0]) : {}; return h[a[1]] ?? null; }
    case 'HMGET': { const h = alive(a[0]) ? kv.get(a[0]) : {}; return a.slice(1).map((f) => h[f] ?? null); }
    case 'HDEL': { const h = alive(a[0]) ? kv.get(a[0]) : {}; const n = a.slice(1).filter((f) => f in h).length; a.slice(1).forEach((f) => delete h[f]); return n; }
    case 'HGETALL':return alive(a[0]) ? Object.entries(kv.get(a[0])).flat() : [];
    case 'HINCRBY': { const h = alive(a[0]) ? kv.get(a[0]) : {}; h[a[1]] = String(Number(h[a[1]] || 0) + Number(a[2])); kv.set(a[0], h); return Number(h[a[1]]); }
    case 'SADD': { const s = alive(a[0]) ? kv.get(a[0]) : new Set(), was = s.size; a.slice(1).forEach((x) => s.add(String(x))); kv.set(a[0], s); return s.size - was; }
    case 'SMEMBERS': return alive(a[0]) ? [...kv.get(a[0])] : [];
    case 'SISMEMBER': return alive(a[0]) && kv.get(a[0]).has(a[1]) ? 1 : 0;
    case 'SCARD': return alive(a[0]) ? kv.get(a[0]).size : 0;
    case 'SREM': { const s = alive(a[0]) ? kv.get(a[0]) : new Set(); return a.slice(1).filter((x) => s.delete(x)).length; }
    default: throw new Error('unsupported ' + cmd);
  }
};
}
const redis = makeStore();

// DEV_USER_REDIS: the outside Redis, over the Redis protocol (RESP) as ioredis speaks it
if (process.env.DEV_USER_REDIS) {
  const store = makeStore();
  const enc = (v) => v === null || v === undefined ? '$-1\r\n' : typeof v === 'number' ? `:${v}\r\n`
    : Array.isArray(v) ? `*${v.length}\r\n${v.map(enc).join('')}` : `$${Buffer.byteLength(String(v))}\r\n${v}\r\n`;
  net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {   // one command: *<n>\r\n then n × $<len>\r\n<bytes>\r\n
        let at = 0;
        const line = () => { const e = buf.indexOf('\r\n', at); if (e < 0) return null; const l = buf.subarray(at, e).toString(); at = e + 2; return l; };
        const head = line(); if (head === null) return;
        const n = Number(head.slice(1)), cmd = [];
        for (let i = 0; i < n; i++) {
          const len = line(); if (len === null || buf.length < at + Number(len.slice(1)) + 2) return;
          cmd.push(buf.subarray(at, at + Number(len.slice(1))).toString()); at += Number(len.slice(1)) + 2;
        }
        buf = buf.subarray(at);
        try { sock.write(/^(CLIENT|SELECT|INFO)$/i.test(cmd[0]) ? '+OK\r\n' : enc(store(cmd))); }
        catch (e) { sock.write(`-ERR ${e.message}\r\n`); }
      }
    });
  }).listen(PORT + 1, '127.0.0.1');
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.json': 'application/json', '.mp4': 'video/mp4' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  // same rewrites as vercel.json, used only when no file matches
  const seg = url.pathname.match(/^\/([a-z0-9-]+)(\/admin|\/manifest\.webmanifest)?$/);
  if (seg && seg[1] !== 'api' && seg[2] === '/admin') { res.writeHead(307, { Location: '/admin' }); return res.end(); }
  if (seg && !seg[2] && seg[1].startsWith('demo-')) { res.writeHead(307, { Location: `/demo/${seg[1].slice(5)}` }); return res.end(); }
  if (/^\/demo\/[a-z0-9-]+$/.test(url.pathname)) url.pathname = '/index.html';   // a demo village: /demo/<village>
  else if (url.pathname === '/promo') url.pathname = '/promo.html';   // the videos page
  else if (url.pathname === '/admin' || /^\/\d{8}$/.test(url.pathname)) url.pathname = '/admin.html';   // /<8 digits>: a search request
  else if (seg && seg[1] !== 'api' && !existsSync(join(root, url.pathname))) {
    if (seg[2] === '/manifest.webmanifest') { url.pathname = '/api/manifest'; url.searchParams.set('village', seg[1]); }
    else url.pathname = '/index.html';
  }

  // a video with no local copy: the same redirect to jsDelivr (GitHub repo ramcala/rajelection-videos) as vercel.json
  if (/^\/[a-z0-9-]+\.mp4$/.test(url.pathname) && !existsSync(join(root, url.pathname))) {
    const to = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')).redirects.find((r) => r.source.includes('.mp4'));
    if (to) { res.writeHead(307, { Location: to.destination.replace(':name', url.pathname.slice(1, -4)) }); return res.end(); }
  }

  if (url.pathname === '/__otp') { otps.set(url.searchParams.get('mobile'), url.searchParams.get('otp')); return res.end('{"status":"success"}'); }
  if (url.pathname === '/__otp/last') return res.end(JSON.stringify({ otp: otps.get(url.searchParams.get('mobile')) || null }));
  if (url.pathname === '/__redis') {
    try { res.end(JSON.stringify({ result: redis(JSON.parse(raw)) })); }
    catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  if (url.pathname === '/__redis/pipeline') {
    res.end(JSON.stringify(JSON.parse(raw).map((c) => { try { return { result: redis(c) }; } catch (e) { return { error: e.message }; } })));
    return;
  }
  const api = url.pathname.match(/^\/api\/([a-z]+)$/);
  // the same rewrite as vercel.json: the functions that need the voter data all run in api/data.js
  if (api && ['search', 'mark', 'admin', 'progress', 'poster', 'team'].includes(api[1])) { url.searchParams.set('fn', api[1]); api[1] = 'data'; req.url = `/api/data${url.search}`; }
  if (api && existsSync(join(root, 'api', api[1] + '.js'))) {
    req.body = raw ? JSON.parse(raw) : {};
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    return require(join(root, 'api', api[1] + '.js'))(req, res);
  }
  // static files; api/ sources and the encrypted data are never served, same as on Vercel
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = join(root, p);
  if (p.startsWith('/api/') || !file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`dev server on http://127.0.0.1:${PORT}`));
