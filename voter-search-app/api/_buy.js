// A UPI purchase request (api/buy.js), read by the buyer's status check and by the admin page.
const { redis } = require('./_lib.js');

async function getBuy(id) {
  if (!/^[0-9a-f]{10}$/.test(String(id || ''))) return null;
  const arr = await redis('HGETALL', `buy:${id}`);
  if (!arr || !arr.length) return null;
  const x = { id };
  for (let i = 0; i < arr.length; i += 2) x[arr[i]] = arr[i + 1];
  return x;
}
module.exports = { getBuy };
