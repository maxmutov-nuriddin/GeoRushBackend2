const { prisma } = require('../config/database');
const { sendPremiumInvoice } = require('../bot/otpBot');
const { tierOf, entitlementsPublic } = require('../config/tiers');

// GET /api/premium/status
async function getStatus(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { isPremium: true, premiumUntil: true, premiumTier: true, telegramChatId: true, coins: true, createdAt: true }
    });

    const active = !!(user.isPremium && user.premiumUntil && new Date() < new Date(user.premiumUntil));
    const tier = tierOf(user);
    res.json({
      isPremium:      active,
      premiumUntil:   user.premiumUntil || null,
      tier,
      entitlements:   entitlementsPublic(tier),
      hasTelegramLink: !!user.telegramChatId,
      coins:          user.coins || 0,
      createdAt:      user.createdAt,
    });
  } catch (err) { next(err); }
}

// POST /api/premium/send-invoice — Telegram Stars invoice yuborish
async function sendInvoice(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { telegramChatId: true, isPremium: true, premiumUntil: true }
    });

    if (!user.telegramChatId) {
      return res.status(400).json({
        error: 'Telegram bot bilan ulanmagan',
        hint: 'Bot ichida /link komandasini yuboring va raqamingizni ulashing',
      });
    }

    const tier   = req.body.tier   || 'pro';
    const period = req.body.period || 'monthly'; // 'monthly' | 'yearly'
    const promoCode = req.body.promoCode || null;

    await sendPremiumInvoice(user.telegramChatId, req.user.id, tier, period, promoCode);
    res.json({ ok: true, message: 'Invoice Telegram ga yuborildi' });
  } catch (err) { next(err); }
}

module.exports = { getStatus, sendInvoice };
