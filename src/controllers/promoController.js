const { prisma } = require('../config/database');

async function createPromoCode(req, res, next) {
  try {
    const { code, discountPct, maxUses, expiresHours } = req.body;
    if (!code || discountPct === undefined || !expiresHours) {
      return res.status(400).json({ error: "Barcha maydonlar majburiy (code, discountPct, expiresHours)" });
    }

    const uppercaseCode = code.toUpperCase().trim();
    const existing = await prisma.promoCode.findUnique({ where: { code: uppercaseCode } });
    if (existing) {
      return res.status(400).json({ error: "Bu kod allaqachon mavjud" });
    }

    const expiresAt = new Date(Date.now() + expiresHours * 60 * 60 * 1000);

    const promo = await prisma.promoCode.create({
      data: {
        code: uppercaseCode,
        discountPct: Number(discountPct),
        maxUses: maxUses ? Number(maxUses) : null,
        expiresAt,
        isActive: true
      }
    });

    res.json({ promo: { ...promo, _id: promo.id } });
  } catch (err) {
    next(err);
  }
}

async function getPromoCodes(req, res, next) {
  try {
    const promos = await prisma.promoCode.findMany({
      orderBy: { createdAt: 'desc' }
    });
    const mapped = promos.map(p => ({ ...p, _id: p.id }));
    res.json({ promos: mapped });
  } catch (err) {
    next(err);
  }
}

async function deletePromoCode(req, res, next) {
  try {
    await prisma.promoCode.delete({
      where: { id: req.params.id }
    });
    res.json({ message: "O'chirildi" });
  } catch (err) {
    next(err);
  }
}

async function checkPromoCode(req, res, next) {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Promokod kiritilmagan" });

    const uppercaseCode = code.toUpperCase().trim();
    const promo = await prisma.promoCode.findUnique({ where: { code: uppercaseCode } });

    if (!promo || !promo.isActive) {
      return res.status(404).json({ error: "Bunday promokod topilmadi yoki faol emas" });
    }

    if (new Date() > promo.expiresAt) {
      return res.status(400).json({ error: "Promokodning muddati tugagan" });
    }

    if (promo.maxUses && promo.usesCount >= promo.maxUses) {
      return res.status(400).json({ error: "Promokoddan foydalanish limiti tugagan" });
    }

    res.json({ valid: true, discountPct: promo.discountPct, code: promo.code });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createPromoCode,
  getPromoCodes,
  deletePromoCode,
  checkPromoCode
};
