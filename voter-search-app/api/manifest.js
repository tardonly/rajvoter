// GET /<village>/manifest.webmanifest (rewritten to /api/manifest?village=<village> in vercel.json)
// → the home-screen app details for that village, so "Add to Home screen" opens that village's page.
const { village } = require('./_lib.js');

module.exports = (req, res) => {
  const v = village(req.query && req.query.village);
  if (!v) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(JSON.stringify({
    name: `मतदाता खोज - ${v.title}`,
    short_name: `मतदाता खोज ${v.name}`,
    id: `/${v.slug}`,
    start_url: `/${v.slug}`,
    scope: `/${v.slug}`,
    display: 'standalone',
    background_color: '#f3f4f6',
    theme_color: '#c2185b',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
};
