const { prisma } = require('../config/database');

async function createPromoCode(req, res, next) {
  try {
    const { code, discountPct, maxUses, expiresAt, isActive } = req.body;

    if (!code || discountPct === undefined || !expiresAt) {
      return res.status(400).json({ error: 'Barcha maydonlar majburiy (code, discountPct, expiresAt)' });
    }

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

    res.json({ valid: true, discountPct: promo.discountPct, code: promo.code });
  } catch (err) {
    next(err);
  }
}

module.exports = { createPromoCode, getPromoCodes, deletePromoCode, togglePromoCode, checkPromoCode };
