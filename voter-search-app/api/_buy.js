// A UPI purchase request (api/buy.js), read by the buyer's status check and by the admin page, and its approval
// (by the superadmin on the admin page, or by a payment email: api/buy.js "auto").
const { redis } = require('./_lib.js');

async function getBuy(id) {
  if (!/^[0-9a-f]{10}$/.test(String(id || ''))) return null;
  const arr = await redis('HGETALL', `buy:${id}`);
  if (!arr || !arr.length) return null;
  const x = { id };
  for (let i = 0; i < arr.length; i += 2) x[arr[i]] = arr[i + 1];
  return x;
}
// the money arrived: the rest of the pack (beyond the trial searches the buyer got at once) goes on their login
async function approveBuy(x, by) {
  const id = x.userId;
  await redis('HINCRBY', `user:${id}`, 'credits', Number(x.amount) - (Number(x.trial) || 0));
  await redis('HSET', `user:${id}`, 'bought', '1');
  await redis('SREM', 'free', id);   // a login that bought no longer counts against the free sign-ups (FREE_TIERS)
  await redis('HSET', `buy:${x.id}`, 'status', 'approved', 'decidedAt', new Date().toISOString(), 'decidedBy', by);
}
// a payment seen in a payment email ("utrpaid:<utr>" → amount): approves the pending request with that UTR when the
// amounts match; otherwise only notes the amount on it for the superadmin → 'approved' | 'amount_differs' | 'decided'
async function emailPaid(x, paid) {
  await redis('HSET', `buy:${x.id}`, 'paidAmount', paid);
  if (x.status !== 'pending') return 'decided';
  if (Number(paid) !== Number(x.amount)) return 'amount_differs';
  await approveBuy(x, 'email');
  return 'approved';
}
module.exports = { getBuy, approveBuy, emailPaid };
