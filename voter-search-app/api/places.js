// The sign-up and "change village" pickers (villagePicker in index.html): ज़िला → पंचायत समिति → गाँव, in two small GETs that
// Vercel's CDN keeps, so most phones never reach this function:
//   GET /api/places            → {districts: [name, …]}   every district ('-' = villages with none); asked the most
//   GET /api/places?d=<name>   → {district, villages: [{slug, name, title, panchayatSamiti, district}]}   that district's
//                                villages, each with its samiti (the picker groups them)
// No login and no voter data: the same as signup.js 'info' gave, a district at a time. The village list is built into the
// deployment (_villages.json), and a new deployment empties the CDN, so new villages show at once after a deploy;
// the CDN times below only bound a phone's own copy (max-age) and the CDN's between deploys.
const { villageList } = require('./_lib.js');

const DISTRICTS_CDN = 86400;   // the district names: a day at the CDN
const DISTRICT_CDN = 1800;     // one district's samitis and villages: half an hour at the CDN
const BROWSER = 1800;          // a phone keeps either for half an hour

const dist = (v) => v.district || '-';
function send(res, code, obj, cdn) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cdn) {
    res.setHeader('Cache-Control', `public, max-age=${BROWSER}`);
    res.setHeader('Vercel-CDN-Cache-Control', `max-age=${cdn}, stale-while-revalidate=${cdn}`);
  } else res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
  // read with the WHATWG URL API, not req.query (see manifest.js)
  const d = new URL(req.url || '/', 'http://localhost').searchParams.get('d');
  const all = villageList();
  if (d == null || d === '') return send(res, 200, { districts: [...new Set(all.map(dist))] }, DISTRICTS_CDN);
  const villages = all.filter((v) => dist(v) === d)
    .map(({ slug, name, title, panchayatSamiti, district }) => ({ slug, name, title, panchayatSamiti, district }));
  if (!villages.length) return send(res, 404, { error: 'no_district' });
  return send(res, 200, { district: d, villages }, DISTRICT_CDN);
};
