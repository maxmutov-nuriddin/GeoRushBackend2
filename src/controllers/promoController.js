const { prisma } = require('../config/database');

const TIERS = ['all', 'pro', 'ultra'];
const PERIODS = ['all', 'monthly', 'yearly'];

// Foydalanuvchi bu promokodni AVVAL muvaffaqiyatli ishlatganmi (to'lov bo'lgan).
// PremiumPurchase'da userId + promoCode bo'yicha tekshiramiz (har user 1 marta).
async function userAlreadyUsedPromo(userId, code) {
  if (!userId || !code) return false;
  try {
    const cnt = await prisma.premiumPurchase.count({
      where: { userId: String(userId), promoCode: code.toUpperCase() },
    });
    return cnt > 0;
  } catch {
    return false; // PremiumPurchase yo'q/xato — bloklamaymiz (xavfsiz default)
  }
}

// Promokod berilgan tarif/davrga tegishlimi. 'all' — har doim mos.
function promoApplies(promo, tier, period) {
  if (!promo) return false;
  const at = promo.appliesTier || 'all';
  const ap = promo.appliesPeriod || 'all';
  const tierOk = at === 'all' || at === tier;
  const periodOk = ap === 'all' || ap === period;
  return tierOk && periodOk;
}

async function createPromoCode(req, res, next) {
  try {
    const { code, discountPct, maxUses, expiresAt, isActive } = req.body;

    if (!code || discountPct === undefined || !expiresAt) {
      return res.status(400).json({ error: 'Barcha maydonlar majburiy (code, discountPct, expiresAt)' });
    }
    const pct = Number(discountPct);
    if (isNaN(pct) || pct < 1 || pct > 100) {
      return res.status(400).json({ error: 'discountPct 1 dan 100 gacha bo\'lishi kerak' });
    }

    // Tarif/davr cheklovi — ruxsat etilgan qiymatlar, default 'all'
    const appliesTier = TIERS.includes(req.body.appliesTier) ? req.body.appliesTier : 'all';
    const appliesPeriod = PERIODS.includes(req.body.appliesPeriod) ? req.body.appliesPeriod : 'all';

    const uppercaseCode = code.toUpperCase().trim();
    const existing = await prisma.promoCode.findUnique({ where: { code: uppercaseCode } });
    if (existing) {
      return res.status(400).json({ error: 'Bu kod allaqachon mavjud' });
    }

    const promo = await prisma.promoCode.create({
      data: {
        code:        uppercaseCode,
        discountPct: Number(discountPct),
        maxUses:     maxUses ? Number(maxUses) : null,
        expiresAt:   new Date(expiresAt),
        isActive:    isActive !== undefined ? Boolean(isActive) : true,
        appliesTier,
        appliesPeriod,
      },
    });

    res.json({ promo });
  } catch (err) {
    next(err);
  }
}

async function getPromoCodes(req, res, next) {
  try {
    const promoCodes = await prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ promoCodes });
  } catch (err) {
    next(err);
  }
}

async function deletePromoCode(req, res, next) {
  try {
    await prisma.promoCode.delete({ where: { id: req.params.id } });
    res.json({ message: "O'chirildi" });
  } catch (err) {
    next(err);
  }
}

async function togglePromoCode(req, res, next) {
  try {
    const { isActive } = req.body;
    if (isActive === undefined) {
      return res.status(400).json({ error: 'isActive majburiy' });
    }
    const promo = await prisma.promoCode.update({
      where: { id: req.params.id },
      data:  { isActive: Boolean(isActive) },
    });
    res.json({ promo });
  } catch (err) {
    next(err);
  }
}

async function checkPromoCode(req, res, next) {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Promokod kiritilmagan' });

    const uppercaseCode = code.toUpperCase().trim();
    const promo = await prisma.promoCode.findUnique({ where: { code: uppercaseCode } });

    if (!promo || !promo.isActive) {
      return res.status(404).json({ error: 'Bunday promokod topilmadi yoki faol emas' });
    }
    if (new Date() > promo.expiresAt) {
      return res.status(400).json({ error: "Promokodning muddati tugagan" });
    }
    if (promo.maxUses && promo.usesCount >= promo.maxUses) {
      return res.status(400).json({ error: 'Promokoddan foydalanish limiti tugagan' });
    }

    // Tarif/davr berilgan bo'lsa — moslikni tekshiramiz (berilmasa — eski xulq)
    const { tier, period } = req.body;
    if ((tier || period) && !promoApplies(promo, tier, period)) {
      return res.status(400).json({ error: 'Bu promokod tanlangan tarif/davrga tegishli emas' });
    }

    // Har foydalanuvchi promokodni FAQAT BIR MARTA ishlatadi
    const reqUserId = req.user && (req.user.id || req.user._id);
    if (reqUserId && await userAlreadyUsedPromo(reqUserId, uppercaseCode)) {
      return res.status(400).json({ error: 'Siz bu promokodni allaqachon ishlatgansiz', code: 'ALREADY_USED' });
    }

    res.json({
      valid: true,
      discountPct: promo.discountPct,
      code: promo.code,
      appliesTier: promo.appliesTier || 'all',
      appliesPeriod: promo.appliesPeriod || 'all',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { createPromoCode, getPromoCodes, deletePromoCode, togglePromoCode, checkPromoCode, promoApplies, userAlreadyUsedPromo };
