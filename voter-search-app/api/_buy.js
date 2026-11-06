// A UPI purchase request (api/buy.js), read by the buyer's status check and by the admin page.
const { redis, getUser, credits } = require('./_lib.js');

async function getBuy(id) {
  if (!/^[0-9a-f]{10}$/.test(String(id || ''))) return null;
  const arr = await redis('HGETALL', `buy:${id}`);
  if (!arr || !arr.length) return null;
  const x = { id };
  for (let i = 0; i < arr.length; i += 2) x[arr[i]] = arr[i + 1];
  return x;
}
// the buyer's active bought password for this village and mobile number, if any (more searches are added to it)
async function earlierBuyer(village, phone) {
  const ids = (await redis('SMEMBERS', 'users')) || [];
  return (await Promise.all(ids.map(getUser))).find((u) => u && u.role === 'user' && u.village === village
    && u.phone === phone && u.retired !== '1' && credits(u) > 0) || null;
}
module.exports = { getBuy, earlierBuyer };
