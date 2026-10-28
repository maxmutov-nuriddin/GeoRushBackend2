// So'mda to'lanadigan tanga paketlari (Click / Payme) — provayderdan mustaqil buyurtma qatlami.
// Oqim: checkout → PaymentOrder('pending') → provayder callback → grantPaidOrder (bir marta).
//
// IDEMPOTENTLIK: mahsulot faqat `UPDATE ... WHERE status='pending'` muvaffaqiyatli bo'lgan
// tranzaksiyada beriladi — provayder callback'ni necha marta qayta yubormasin, coin bir marta.
// Narx doim serverdagi COIN_PACKS'dan olinadi; mijoz summani bermaydi.
const { randomUUID } = require('crypto');
const { prisma } = require('../config/database');
const { COIN_PACKS, isActivePremium } = require('../config/tiers');
const logger = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const PROVIDERS = ['click', 'payme'];

function getPack(productId) {
  return Object.prototype.hasOwnProperty.call(COIN_PACKS, productId) ? COIN_PACKS[productId] : null;
}

function publicPacks(user) {
  return Object.entries(COIN_PACKS).map(([id, p]) => ({
    id,
    priceSom: p.priceSom,
    coins: p.coins,
    proDays: p.proDays || 0,
    shieldTokens: p.shieldTokens || 0,
    oncePerUser: !!p.oncePerUser,
    available: !(p.oncePerUser && user?.starterPackBought),
  }));
}

async function createOrder({ userId, provider, productId }) {
  if (!PROVIDERS.includes(provider)) throw Object.assign(new Error('Noma\'lum to\'lov usuli'), { status: 400, code: 'BAD_PROVIDER' });
  const pack = getPack(productId);
  if (!pack) throw Object.assign(new Error('Noma\'lum paket'), { status: 400, code: 'BAD_PACK' });

  if (pack.oncePerUser) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { starterPackBought: true } });
    if (!u) throw Object.assign(new Error('Foydalanuvchi topilmadi'), { status: 404 });
    if (u.starterPackBought) throw Object.assign(new Error('Starter Pack faqat bir marta olinadi'), { status: 409, code: 'ALREADY_BOUGHT' });
  }

  return prisma.paymentOrder.create({
    data: { id: randomUUID(), userId, provider, productId, amountSom: pack.priceSom },
  });
}

// Starter Pack'ning 3 kunlik Pro qismi: faol premium bo'lsa muddat uzayadi (tier tushirilmaydi —
// Ultra Ultra'ligicha qoladi), bo'lmasa sovg'a sifatida Pro (welcome coin berilmaydi).
function starterPremiumData(user, proDays, now) {
  const add = proDays * DAY_MS;
  if (isActivePremium(user)) {
    return { premiumUntil: new Date(new Date(user.premiumUntil).getTime() + add) };
  }
  return { isPremium: true, premiumTier: 'pro', premiumIsGift: true, premiumUntil: new Date(now.getTime() + add) };
}

// Paket mazmunini beradi. Bir martalik paket ikkinchi marta to'langan bo'lsa (ikki ochiq
// buyurtma parallel to'langan holat) — faqat coin beriladi, Pro/shield takrorlanmaydi.
async function grantPack(tx, order, pack, now) {
  const data = { coins: { increment: pack.coins } };
  if (pack.oncePerUser) {
    const u = await tx.user.findUnique({
      where: { id: order.userId },
      select: { starterPackBought: true, isPremium: true, premiumUntil: true, premiumTier: true },
    });
    if (u && !u.starterPackBought) {
      Object.assign(data, { starterPackBought: true }, starterPremiumData(u, pack.proDays || 0, now));
      if (pack.shieldTokens) data.shieldTokens = { increment: pack.shieldTokens };
    } else {
      logger.warn(`Starter Pack ikkinchi marta to'landi — faqat coin berildi: order=${order.id}`);
    }
  }
  return tx.user.update({ where: { id: order.userId }, data, select: { coins: true } });
}

// Provayder "to'landi" deganda chaqiriladi. { order, granted } qaytaradi:
// granted=false — buyurtma allaqachon to'langan/bekor (takroriy callback), hech narsa berilmadi.
async function grantPaidOrder(orderId, extra = {}) {
  const now = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    const flipped = await tx.paymentOrder.updateMany({
      where: { id: orderId, status: 'pending' },
      data: { status: 'paid', paidAt: now, ...extra },
    });
    const order = await tx.paymentOrder.findUnique({ where: { id: orderId } });
    if (flipped.count === 0) return { order, granted: false };

    const pack = getPack(order.productId);
    if (!pack) throw new Error(`Unknown pack on paid order ${order.id}`);
    const user = await grantPack(tx, order, pack, now);

    // Daromad ledger'i — admin Revenue shu jadvaldan hisoblaydi (Stars tanga xaridi bilan bir xil shakl)
    await tx.premiumPurchase.create({
      data: {
        id: randomUUID(), userId: order.userId, tier: 'coins', period: order.productId,
        method: order.provider, amountSom: order.amountSom, baseSom: order.amountSom,
        chargeId: `${order.provider}:${order.id}`,
      },
    });
    return { order, granted: true, coins: user.coins, pack };
  });

  if (outcome.granted) notifyPaid(outcome);
  return outcome;
}

function notifyPaid({ order, coins, pack }) {
  try {
    const { getIo } = require('../socket/ioInstance');
    const io = getIo();
    if (!io) return;
    io.to(`user:${order.userId}`).emit('shop:coins_earned', { reason: 'To\'lov qabul qilindi', amount: pack.coins });
    io.to(`user:${order.userId}`).emit('payment:completed', { orderId: order.id, productId: order.productId, coins });
  } catch (err) { logger.warn('Payment notify failed', { orderId: order.id, err: err.message }); }
}

async function cancelOrder(orderId, extra = {}) {
  return prisma.paymentOrder.updateMany({
    where: { id: orderId, status: 'pending' },
    data: { status: 'cancelled', ...extra },
  });
}

module.exports = { PROVIDERS, getPack, publicPacks, createOrder, grantPaidOrder, cancelOrder };
