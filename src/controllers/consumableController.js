// Iste'mol buyumlari (consumables): shield / trail revive / XP boost / stealth.
// Skin xaridi (shopController.buyItem) dan ALOHIDA — ownedSkins'ga hech narsa yozilmaydi.
//
// Coin yechish ATOMIK: updateMany(where coins >= price) — ikki parallel so'rov balansni
// manfiyga tushira olmaydi (count 0 → NOT_ENOUGH_COINS).
const { prisma } = require('../config/database');
const { getIo } = require('../socket/ioInstance');
const { CONSUMABLES, getConsumableById } = require('../config/shopItems');
const { isActiveUntil, extendUntil } = require('../services/consumableService');
const logger = require('../utils/logger');

// effect → User'dagi vaqtli ustun
const TIMED_USER_FIELD = { xpBoost: 'xpBoostUntil', stealth: 'stealthUntil' };

const STATE_SELECT = {
  coins: true, xpBoostUntil: true, stealthUntil: true, reviveTokens: true, shieldTokens: true,
};

function publicState(u, now = new Date()) {
  return {
    coins: u.coins || 0,
    xpBoostUntil: isActiveUntil(u.xpBoostUntil, now) ? u.xpBoostUntil : null,
    stealthUntil: isActiveUntil(u.stealthUntil, now) ? u.stealthUntil : null,
    reviveTokens: u.reviveTokens || 0,
    shieldTokens: u.shieldTokens || 0,
  };
}

// Muddat to'planishi chegarasi: qolgan vaqt bitta davomiylikdan oshsa — yana sotilmaydi
// (eng ko'pi 2× to'planadi). Aks holda hududni coin bilan abadiy daxlsiz qilib bo'lardi.
function stackCapReached(until, durationMs, now) {
  return isActiveUntil(until, now) && new Date(until).getTime() - now.getTime() > durationMs;
}

// Coin (yoki shield token) yechish — tx ichida, atomik. Muvaffaqiyatsiz bo'lsa throw.
async function chargeUser(tx, userId, price, { useShieldToken = false } = {}) {
  const where = useShieldToken
    ? { id: userId, shieldTokens: { gte: 1 } }
    : { id: userId, coins: { gte: price } };
  const data = useShieldToken
    ? { shieldTokens: { decrement: 1 } }
    : { coins: { decrement: price } };
  const res = await tx.user.updateMany({ where, data });
  if (res.count === 0) throw new Error(useShieldToken ? 'NO_SHIELD_TOKEN' : 'NOT_ENOUGH_COINS');
}

async function applyShield(tx, userId, item, territoryId, useShieldToken, now) {
  const territory = await tx.territory.findFirst({
    where: { id: territoryId, ownerId: userId },
    select: { id: true, shieldUntil: true },
  });
  if (!territory) throw new Error('TERRITORY_NOT_FOUND');
  if (stackCapReached(territory.shieldUntil, item.durationMs, now)) throw new Error('ALREADY_MAX');
  await chargeUser(tx, userId, item.price, { useShieldToken });
  const shieldUntil = extendUntil(territory.shieldUntil, item.durationMs, now);
  await tx.territory.update({ where: { id: territory.id }, data: { shieldUntil } });
  return { territoryId: territory.id, shieldUntil };
}

async function applyTimedUserEffect(tx, userId, item, now) {
  const field = TIMED_USER_FIELD[item.effect];
  const u = await tx.user.findUnique({ where: { id: userId }, select: { [field]: true } });
  if (!u) throw new Error('NOT_FOUND');
  if (stackCapReached(u[field], item.durationMs, now)) throw new Error('ALREADY_MAX');
  await chargeUser(tx, userId, item.price);
  const until = extendUntil(u[field], item.durationMs, now);
  await tx.user.update({ where: { id: userId }, data: { [field]: until } });
  return { [field]: until };
}

async function applyRevive(tx, userId, item) {
  await chargeUser(tx, userId, item.price);
  await tx.user.update({ where: { id: userId }, data: { reviveTokens: { increment: item.amount || 1 } } });
  return {};
}

// GET /api/shop/consumables
async function getConsumables(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: STATE_SELECT });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    res.json({ items: CONSUMABLES, state: publicState(user) });
  } catch (err) { next(err); }
}

// POST /api/shop/buy-consumable { itemId, territoryId?, useShieldToken? }
async function buyConsumable(req, res, next) {
  const userId = req.user.id;
  const item = getConsumableById(req.body.itemId);
  if (!item) return res.status(400).json({ error: 'Noma\'lum buyum', code: 'BAD_ITEM' });
  const territoryId = req.body.territoryId ? String(req.body.territoryId) : null;
  if (item.needsTerritory && !territoryId) {
    return res.status(400).json({ error: 'Hududni tanlang', code: 'TERRITORY_REQUIRED' });
  }
  const useShieldToken = item.effect === 'shield' && req.body.useShieldToken === true;

  try {
    const now = new Date();
    const applied = await prisma.$transaction(async (tx) => {
      if (item.effect === 'shield') return applyShield(tx, userId, item, territoryId, useShieldToken, now);
      if (item.effect === 'revive') return applyRevive(tx, userId, item);
      return applyTimedUserEffect(tx, userId, item, now);
    });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: STATE_SELECT });

    // Shield hammaning xaritasida qalqon belgisi bilan ko'rinsin (faqat ko'rsatish).
    if (item.effect === 'shield') {
      const io = getIo();
      if (io) io.to('global').emit('territory:shielded', { territoryId: applied.territoryId, shieldUntil: applied.shieldUntil });
    }

    res.json({ ok: true, itemId: item.id, applied, state: publicState(user) });
  } catch (err) {
    const known = {
      NOT_FOUND:           [404, 'Foydalanuvchi topilmadi'],
      TERRITORY_NOT_FOUND: [404, 'Hudud topilmadi yoki sizniki emas'],
      ALREADY_MAX:         [400, 'Bu effekt allaqachon maksimal muddatda faol'],
      NO_SHIELD_TOKEN:     [400, 'Shield tokeningiz yo\'q'],
      NOT_ENOUGH_COINS:    [400, 'Coinlar yetarli emas'],
    }[err.message];
    if (!known) return next(err);
    const body = { error: known[1], code: err.message };
    if (err.message === 'NOT_ENOUGH_COINS') {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { coins: true } }).catch(() => null);
      Object.assign(body, { need: item.price, have: u?.coins || 0 });
    }
    logger.info(`Consumable buy rejected: ${userId} ${item.id} ${err.message}`);
    return res.status(known[0]).json(body);
  }
}

module.exports = { getConsumables, buyConsumable };
