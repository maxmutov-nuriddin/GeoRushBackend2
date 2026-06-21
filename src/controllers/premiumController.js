const { prisma } = require('../config/database');
const { sendPremiumInvoice } = require('../bot/otpBot');
const { tierOf, entitlementsPublic } = require('../config/tiers');
const logger = require('../utils/logger');

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
  } catch (err) {
    // Telegram/bot xatosini umumiy 500 ga "yutib yubormaymiz" — aniq sababni logga yozib,
    // foydalanuvchiga tushunarli xabar + hint qaytaramiz (diagnostika oson bo'lishi uchun).
    const tgMsg = err?.response?.body?.description || err?.message || 'Nomaʼlum xato';
    logger.warn('Premium invoice yuborilmadi:', tgMsg);

    let hint = 'Telegram botini oching va "Start" bosing, soʻng qayta urinib koʻring.';
    if (/blocked/i.test(tgMsg)) hint = 'Siz botni bloklagansiz. Telegramda botni blокdan chiqaring va qayta urinib koʻring.';
    else if (/chat not found|initiate/i.test(tgMsg)) hint = 'Bot bilan suhbat boshlanmagan. Telegramda botni oching va "Start" bosing.';
    else if (/Bot ishlamayapti/i.test(tgMsg)) hint = 'Bot serverda ishga tushmagan (token yoki polling konflikti). Administrator bilan bogʻlaning.';
    else if (/CURRENCY|amount/i.test(tgMsg)) hint = 'Toʻlov summasi notoʻgʻri sozlangan. Administrator bilan bogʻlaning.';

    return res.status(502).json({ error: 'Toʻlov chiptasini yuborib boʻlmadi', detail: tgMsg, hint });
  }
}

module.exports = { getStatus, sendInvoice };
