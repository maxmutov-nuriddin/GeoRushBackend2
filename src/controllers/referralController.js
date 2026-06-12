const { prisma } = require('../config/database');
const { sendExpoPush } = require('../services/captureEffects');
const logger = require('../utils/logger');

// Mukofotlar env orqali sozlanadi; default: taklif qilgan 200, yangi o'yinchi 100
const REFERRER_REWARD = parseInt(process.env.REFERRER_REWARD || '200', 10);
const REFEREE_REWARD  = parseInt(process.env.REFEREE_REWARD  || '100', 10);

// GET /api/referral/me — mening referral kodim (username) va statistikam
async function getMyReferralStats(req, res, next) {
  try {
    const me = req.user.id;
    const [invited, completed] = await Promise.all([
      prisma.referral.count({ where: { referrerId: me } }),
      prisma.referral.count({ where: { referrerId: me, status: 'completed' } }),
    ]);
    res.json({
      code: req.user.username,
      invited,
      completed,
      pending: invited - completed,
      coinsEarned: completed * REFERRER_REWARD,
      referrerReward: REFERRER_REWARD,
      refereeReward: REFEREE_REWARD,
    });
  } catch (err) { next(err); }
}

// Ro'yxatdan o'tishda chaqiriladi (fire-and-forget). HECH QACHON throw qilmaydi —
// noto'g'ri/yo'q kod jimgina e'tiborsiz qoldiriladi, registratsiya buzilmaydi.
async function attachReferralOnRegister(refereeId, referralCode) {
  try {
    const code = String(referralCode || '').trim();
    if (!code) return;

    const referrer = await prisma.user.findFirst({
      where: { username: { equals: code, mode: 'insensitive' }, isBanned: false },
      select: { id: true },
    });
    if (!referrer || referrer.id === refereeId) return;

    // refereeId @unique — parallel/ikkinchi urinishda P2002 beradi, catch yutadi
    await prisma.referral.create({
      data: { referrerId: referrer.id, refereeId },
    });
    logger.info(`Referral attached: referrer=${referrer.id} referee=${refereeId}`);
  } catch (err) {
    logger.warn('attachReferralOnRegister skipped', { refereeId, err: err.message });
  }
}

// Capture pipeline'dan chaqiriladi (runPostCaptureEffects oxirida). Referee birinchi
// hududini egallaganda pending → completed, ikkala tomonga coin. HECH QACHON throw qilmaydi.
async function completeReferralIfPending({ userId, io }) {
  try {
    const ref = await prisma.referral.findUnique({ where: { refereeId: userId } });
    if (!ref || ref.status !== 'pending') return;

    // Race-safe: parallel ikki capture'da faqat bittasi yutadi (count === 1)
    const flipped = await prisma.referral.updateMany({
      where: { id: ref.id, status: 'pending' },
      data: { status: 'completed', rewardedAt: new Date() },
    });
    if (flipped.count !== 1) return;

    const [referrer, referee] = await Promise.all([
      prisma.user.update({
        where: { id: ref.referrerId },
        data: { coins: { increment: REFERRER_REWARD } },
        select: { username: true, expoPushToken: true },
      }),
      prisma.user.update({
        where: { id: ref.refereeId },
        data: { coins: { increment: REFEREE_REWARD } },
        select: { username: true },
      }),
    ]);

    // Socket xabarlar — mavjud shop:coins_earned event uslubida (handleLevelUp kabi)
    if (io) {
      io.to(`user:${ref.referrerId}`).emit('shop:coins_earned', {
        reason: `Referral: ${referee.username} birinchi hududini egalladi`,
        amount: REFERRER_REWARD,
        premiumBonus: false,
      });
      io.to(`user:${ref.refereeId}`).emit('shop:coins_earned', {
        reason: 'Referral bonusi — birinchi hudud',
        amount: REFEREE_REWARD,
        premiumBonus: false,
      });
    }

    if (referrer.expoPushToken) {
      sendExpoPush(
        referrer.expoPushToken,
        'GeoRush — Referral mukofoti 🎁',
        `${referee.username} birinchi hududini egalladi! Sizga +${REFERRER_REWARD} GeoCoins`,
      ).catch((err) => logger.warn('Referral push failed', { err: err.message }));
    }

    logger.info(`Referral completed: referrer=${ref.referrerId} (+${REFERRER_REWARD}) referee=${ref.refereeId} (+${REFEREE_REWARD})`);
  } catch (err) {
    logger.warn('completeReferralIfPending failed', { userId, err: err.message });
  }
}

module.exports = { getMyReferralStats, attachReferralOnRegister, completeReferralIfPending };
