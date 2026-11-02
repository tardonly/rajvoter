// Local test server that behaves like Vercel for this app: serves voter-search-app/, runs api/*.js,
// applies the village rewrites from vercel.json (/<village>, /<village>/admin, /<village>/manifest.webmanifest),
// and stands in for the Upstash Redis database with an in-memory store (wiped on restart).
// Usage:  ADMIN_PASSWORD=some-test-password node app-build/dev-server.mjs   → http://127.0.0.1:8765
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'voter-search-app');
const PORT = Number(process.env.PORT || 8765);
process.env.DATA_KEY ||= readFileSync(join(here, 'DATA_KEY.txt'), 'utf8').trim();
process.env.ADMIN_PASSWORD ||= 'admin-test';
process.env.KV_REST_API_URL = `http://127.0.0.1:${PORT}/__redis`;
process.env.KV_REST_API_TOKEN = 'local';
const require = createRequire(import.meta.url);

// --- tiny Redis stand-in: only the commands the API uses ---
const kv = new Map(), expiry = new Map();
const alive = (k) => { if (expiry.has(k) && expiry.get(k) < Date.now()) { kv.delete(k); expiry.delete(k); } return kv.has(k); };
function redis([cmd, ...a]) {
  switch (cmd.toUpperCase()) {
    case 'GET': return alive(a[0]) ? kv.get(a[0]) : null;
    case 'SET': kv.set(a[0], a[1]); return 'OK';
    case 'DEL': return kv.delete(a[0]) ? 1 : 0;
    case 'INCR': { const n = Number(alive(a[0]) ? kv.get(a[0]) : 0) + 1; kv.set(a[0], String(n)); return n; }
    case 'EXPIRE': expiry.set(a[0], Date.now() + Number(a[1]) * 1000); return 1;
    case 'HSET': { const h = alive(a[0]) ? kv.get(a[0]) : {}; for (let i = 1; i < a.length; i += 2) h[a[i]] = a[i + 1]; kv.set(a[0], h); return 1; }
    case 'HGETALL': return alive(a[0]) ? Object.entries(kv.get(a[0])).flat() : [];
    case 'HINCRBY': { const h = alive(a[0]) ? kv.get(a[0]) : {}; h[a[1]] = String(Number(h[a[1]] || 0) + Number(a[2])); kv.set(a[0], h); return Number(h[a[1]]); }
    case 'SADD': { const s = alive(a[0]) ? kv.get(a[0]) : new Set(); a.slice(1).forEach((x) => s.add(x)); kv.set(a[0], s); return 1; }
    case 'SMEMBERS': return alive(a[0]) ? [...kv.get(a[0])] : [];
    default: throw new Error('unsupported ' + cmd);
  }
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain', '.json': 'application/json' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  // same rewrites as vercel.json, used only when no file matches
  const seg = url.pathname.match(/^\/([a-z0-9-]+)(\/admin|\/manifest\.webmanifest)?$/);
  if (url.pathname === '/admin') url.pathname = '/admin.html';
  else if (seg && seg[1] !== 'api' && !existsSync(join(root, url.pathname))) {
    if (seg[2] === '/manifest.webmanifest') { url.pathname = '/api/manifest'; url.searchParams.set('village', seg[1]); }
    else url.pathname = seg[2] ? '/admin.html' : '/index.html';
  }

  if (url.pathname === '/__redis') {
    try { res.end(JSON.stringify({ result: redis(JSON.parse(raw)) })); }
    catch (e) { res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  const api = url.pathname.match(/^\/api\/([a-z]+)$/);
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
