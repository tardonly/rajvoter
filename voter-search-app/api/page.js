// GET /<village> (rewritten to /api/page?village=<village> in vercel.json) → index.html with that village's own title,
// description and canonical address, so Google can list each village page on its own (they are in sitemap.xml).
// Only the public village details from _villages.json go in (name, samiti, district, voter and ward counts); the voter
// list itself still needs a login. An address that is not a village gets the page unchanged with "noindex".
// /demo also comes here (it matches /<village>): it is served unchanged and stays indexable (index.html gives it its
// own title in the browser).
const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const VILLAGES = require('./_villages.json');

let html;   // index.html, read once per instance (vercel.json "includeFiles" puts it next to the function)
const page = () => html || (html = readFileSync([join(__dirname, '..', 'index.html'), join(process.cwd(), 'index.html')]
  .find((f) => existsSync(f)), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the village's own <title>, description and addresses in place of the home page's
function forVillage(slug, v) {
  const url = `https://www.rajelection.com/${slug}`;
  const where = [v.panchayatSamiti && `पंचायत समिति ${v.panchayatSamiti}`, v.district && `ज़िला ${v.district}`].filter(Boolean).join(', ');
  const wards = (v.wards || []).length;
  const title = `${v.title} मतदाता सूची (वोटर लिस्ट)${v.district ? ` — ${v.district}` : ''} | Voter Search`;
  const desc = `${v.title}${where ? ` (${where})` : ''} की वार्ड वार मतदाता सूची` +
    `${v.voters ? `: ${v.voters} मतदाता` : ''}${wards ? `, ${wards} वार्ड` : ''}। नाम से वोटर खोजें, मतदाता पर्ची प्रिंट करें, ` +
    `मतदान के दिन निशान लगाएं। Rajasthan panchayat voter list for ${slug.replace(/-/g, ' ')}.`;
  const set = (h, re, val) => {
    if (!re.test(h)) throw new Error(`index.html: no match for ${re}`);
    return h.replace(re, (_, a, b) => `${a}${esc(val)}${b}`);
  };
  let h = page();
  h = set(h, /(<title>)[^<]*(<\/title>)/, title);
  h = set(h, /(<meta name="description" content=")[^"]*(">)/, desc);
  h = set(h, /(<link rel="canonical" href=")[^"]*(">)/, url);
  h = set(h, /(<meta property="og:url" content=")[^"]*(">)/, url);
  h = set(h, /(<meta property="og:title" content=")[^"]*(">)/, title);
  h = set(h, /(<meta property="og:description" content=")[^"]*(">)/, desc);
  h = set(h, /(<meta name="twitter:title" content=")[^"]*(">)/, title);
  h = set(h, /(<meta name="twitter:description" content=")[^"]*(">)/, desc);
  return h;
}

module.exports = (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  // req.url is "/api/page?village=<village>" or the original "/<village>", depending on the rewrite
  const slug = (u.searchParams.get('village') || u.pathname.split('/')[1] || '').toLowerCase();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (slug === 'demo') return res.end(page());
  if (!/^[a-z0-9-]+$/.test(slug) || !Object.hasOwn(VILLAGES, slug)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    return res.end(page());
  }
  res.end(forVillage(slug, VILLAGES[slug]));
};
