const { prisma } = require('../config/database');
const logger = require('../utils/logger');

// To'liq narxlar (so'm) — bot/otpBot.js dagi basePrices bilan bir xil bo'lishi shart.
const BASE_PRICES = {
  pro:   { monthly: 39900, yearly: 399000 },
  ultra: { monthly: 79900, yearly: 799000 },
};

function baseSomFor(tier, period) {
  return BASE_PRICES[tier]?.[period] ?? BASE_PRICES.pro.monthly;
}

// Chegirmadan keyingi so'm narxi — otpBot.calculateSomPrice bilan bir xil mantiq.
function discountedSom(tier, period, discountPct = 0) {
  const base = baseSomFor(tier, period);
  if (!discountPct) return base;
  if (discountPct >= 100) return 0;
  return Math.max(1000, Math.round(base * (1 - discountPct / 100)));
}

// Har bir HAQIQIY premium xaridini ledger'ga yozadi. Hech qachon throw qilmaydi —
// yozuv muvaffaqiyatsiz bo'lsa ham premium faollashtirish jarayoni buzilmasin.
async function recordPremiumPurchase({
  userId, tier = 'pro', period = 'monthly', method,
  amountSom = 0, amountStars = 0, baseSom = 0, discountPct = 0, promoCode = null,
}) {
  try {
    if (!userId || !method) return null;
    return await prisma.premiumPurchase.create({
      data: {
        userId: String(userId),
        tier, period, method,
        amountSom: Math.round(amountSom) || 0,
        amountStars: Math.round(amountStars) || 0,
        baseSom: Math.round(baseSom) || 0,
        discountPct: Math.round(discountPct) || 0,
        promoCode: promoCode ? String(promoCode).toUpperCase() : null,
      },
    });
  } catch (err) {
    logger.warn('PremiumPurchase yozish xatosi:', err.message?.split('\n')[0]);
    return null;
  }
}

module.exports = { recordPremiumPurchase, discountedSom, baseSomFor, BASE_PRICES };
