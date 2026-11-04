// GET /<village>/manifest.webmanifest (rewritten to /api/manifest?village=<village> in vercel.json)
// → the home-screen app details for that village, so "Add to Home screen" opens that village's page.
const { DEMO, village } = require('./_lib.js');

// The village is read with the WHATWG URL API, not req.query: Vercel fills req.query with Node's url.parse(), which
// logs a DEP0169 deprecation warning. Depending on the rewrite, req.url is "/api/manifest?village=<village>" or the
// original "/<village>/manifest.webmanifest", so both are understood.
// ?page=home (the start page, /) and ?page=demo (the demo's village list, /demo) get an app of their own too.
const app = (name, shortName, page) => ({
  name, short_name: shortName, id: page, start_url: page, scope: page,
  display: 'standalone',
  background_color: '#f3f4f6',
  theme_color: '#c2185b',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});
module.exports = (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  const pick = u.searchParams.get('page');
  let body;
  if (pick === 'home') body = app('मतदाता खोज', 'मतदाता खोज', '/');
  else if (pick === 'demo') body = app('मतदाता खोज - डेमो', 'मतदाता खोज डेमो', '/demo');
  else {
    const v = village(u.searchParams.get('village') || u.pathname.split('/')[1]);
    if (!v) { res.statusCode = 404; return res.end('not found'); }
    const page = v.demo ? `/demo/${v.slug.slice(DEMO.prefix.length)}` : `/${v.slug}`;   // a demo village lives at /demo/<village>
    body = app(`मतदाता खोज - ${v.title}`, `मतदाता खोज ${v.name}`, page);
  }
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(JSON.stringify(body));
};
