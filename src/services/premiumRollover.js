const { prisma } = require('../config/database');

// Kechiktirilgan premium uzaytirish bonusini ISHGA TUSHIRADI (lazy).
// Foydalanuvchi faol tarifni qayta olganda (uzaytirish) bonus darrov berilmaydi —
// `pendingResetAt` (joriy muddat tugashi) belgilanadi. Shu vaqt yetganda bu funksiya
// kengaytirish budjetini tiklaydi (expansionsUsed=0) va kechiktirilgan coinlarni beradi.
// Tez-tez chaqiriladigan joylarda (capture, premium status, shop) ishlaydi — idempotent.
async function applyPendingRollover(userId) {
  if (!userId) return false;
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { pendingResetAt: true, pendingCoins: true, pendingTier: true },
  });
  if (!u || !u.pendingResetAt || new Date() < u.pendingResetAt) return false;

  await prisma.user.update({
    where: { id: userId },
    data: {
      // Kechiktirilgan yangi daraja bo'lsa (Pro→Ultra) — endi o'tadi.
      ...(u.pendingTier ? { premiumTier: u.pendingTier, premiumIsGift: false } : {}),
      expansionsUsed: 0,
      coins: { increment: u.pendingCoins || 0 },
      pendingResetAt: null,
      pendingCoins: 0,
      pendingTier: null,
    },
  });
  return true;
}

module.exports = { applyPendingRollover };
