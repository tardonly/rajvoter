// The one function that carries the voter data (api/_data, ~44 MB): /api/search, /api/mark, /api/admin,
// /api/progress and /api/poster all run here (vercel.json rewrites them to /api/data?fn=<name>), so Vercel stores the data once per
// deployment instead of once per function. The handlers themselves are in api/_routes/<name>.js.
// Depending on the rewrite, req.url is "/api/data?fn=<name>" or the original "/api/<name>" (see manifest.js), so both
// are read.
const ROUTES = {
  search: () => require('./_routes/search.js'),
  mark: () => require('./_routes/mark.js'),
  admin: () => require('./_routes/admin.js'),
  progress: () => require('./_routes/progress.js'),
  poster: () => require('./_routes/poster.js'),
};

module.exports = (req, res) => {
  const u = new URL(req.url || '/', 'http://localhost');
  const name = u.searchParams.get('fn') || u.pathname.split('/').pop();
  const route = Object.prototype.hasOwnProperty.call(ROUTES, name) && ROUTES[name];
  if (!route) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"not_found"}'); }
  return route()(req, res);
};
