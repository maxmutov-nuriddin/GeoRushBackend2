const { prisma } = require('../config/database');
const { getIo } = require('../socket/ioInstance');
const { SHOP_ITEMS, getItemById } = require('../config/shopItems');
const { tierOf, entitlements } = require('../config/tiers');

const DAILY_COINS = 15;

// color -> 'activeSkinColor', marker -> 'activeSkinMarker', trail -> 'activeSkinTrail'
const SKIN_FIELD = {
  color:  'activeSkinColor',
  marker: 'activeSkinMarker',
  trail:  'activeSkinTrail',
};

function buildActiveSkins(user) {
  const old = user.activeSkin || null;
  return {
    color:  user.activeSkinColor  || (old?.startsWith('color_')  ? old : null),
    marker: user.activeSkinMarker || (old?.startsWith('marker_') ? old : null),
    trail:  user.activeSkinTrail  || (old?.startsWith('trail_')  ? old : null),
  };
}

async function syncColorChange(userId, color) {
  await prisma.territory.updateMany({
    where: { ownerId: userId },
    data: { color }
  });
  const io = getIo();
  if (io) io.emit('user:colorUpdate', { userId: userId.toString(), color });
}

// GET /api/shop/items
async function getShopItems(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        coins: true,
        ownedSkins: true,
        isPremium: true,
        premiumUntil: true,
        premiumTier: true,
        activeSkinColor: true,
        activeSkinMarker: true,
        activeSkinTrail: true
      }
    });

    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const ownedSkins  = user.ownedSkins || [];
    const activeSkins = buildActiveSkins(user);
    const ultraFree   = entitlements(tierOf(user)).freeSkins; // Ultra — barcha skinlar bepul
    const items = SHOP_ITEMS.map(item => ({
      ...item,
      owned:  ownedSkins.includes(item.id) || ultraFree,
      active: activeSkins[item.type] === item.id,
      free:   ultraFree && !ownedSkins.includes(item.id),
    }));
    res.json({ items, coins: user.coins || 0, activeSkins });
  } catch (err) {
    next(err);
  }
}

// GET /api/shop/me
async function getMyShop(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        coins: true,
        ownedSkins: true,
        activeSkinColor: true,
        activeSkinMarker: true,
        activeSkinTrail: true,
        lastDailyClaim: true
      }
    });

    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const ownedSkins = user.ownedSkins || [];
    const ownedItems = SHOP_ITEMS.filter(i => ownedSkins.includes(i.id));

    const nextDaily = user.lastDailyClaim
      ? new Date(user.lastDailyClaim.getTime() + 24 * 60 * 60 * 1000)
      : null;
    const canClaim = !nextDaily || new Date() >= nextDaily;

    res.json({
      coins: user.coins || 0,
      activeSkins: buildActiveSkins(user),
      ownedItems,
      canClaim,
      nextDaily,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/shop/buy
async function buyItem(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId kerak' });

    const item = getItemById(itemId);
    if (!item) return res.status(404).json({ error: 'Item topilmadi' });

    const colorChanged = item.type === 'color';

    // Atomik: yetarli coin bor VA skin hali yo'q bo'lsagina sotib oladi.
    const result = await prisma.$transaction(async (tx) => {
      const cur = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, ownedSkins: true }
      });
      if (!cur) throw new Error('NOT_FOUND');
      if ((cur.ownedSkins || []).includes(itemId)) {
        throw new Error('ALREADY_OWNED');
      }
      if (cur.coins < item.price) {
        throw new Error('NOT_ENOUGH_COINS');
      }

      const updateData = {
        coins: { decrement: item.price },
        ownedSkins: { push: itemId },
        [SKIN_FIELD[item.type]]: itemId
      };
      if (colorChanged) updateData.color = item.value;

      return await tx.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          coins: true,
          ownedSkins: true,
          activeSkinColor: true,
          activeSkinMarker: true,
          activeSkinTrail: true,
          color: true
        }
      });
    });

    if (colorChanged) await syncColorChange(userId, item.value);

    res.json({ ok: true, coins: result.coins, activeSkins: buildActiveSkins(result), color: result.color, item });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (err.message === 'ALREADY_OWNED') return res.status(409).json({ error: 'Bu skin allaqachon sizda bor' });
    if (err.message === 'NOT_ENOUGH_COINS') {
       const user = await prisma.user.findUnique({ where: { id: req.user.id || req.user._id }, select: { coins: true } });
       return res.status(400).json({ error: 'Coinlar yetarli emas', need: getItemById(req.body.itemId).price, have: user?.coins || 0 });
    }
    next(err);
  }
}

// POST /api/shop/equip
async function equipItem(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId kerak' });

    const item = getItemById(itemId);
    if (!item) return res.status(404).json({ error: 'Item topilmadi' });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        ownedSkins: true,
        isPremium: true,
        premiumUntil: true,
        premiumTier: true,
        activeSkinColor: true,
        activeSkinMarker: true,
        activeSkinTrail: true,
        color: true
      }
    });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const ultraFree = entitlements(tierOf(user)).freeSkins;
    if (!ultraFree && !(user.ownedSkins || []).includes(itemId)) {
      return res.status(403).json({ error: 'Bu skin sizga tegishli emas' });
    }

    const colorChanged = item.type === 'color';
    
    const updateData = {
      [SKIN_FIELD[item.type]]: itemId
    };
    if (colorChanged) updateData.color = item.value;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        activeSkinColor: true,
        activeSkinMarker: true,
        activeSkinTrail: true,
        color: true
      }
    });

    if (colorChanged) await syncColorChange(userId, item.value);

    res.json({ ok: true, activeSkins: buildActiveSkins(updatedUser), color: updatedUser.color });
  } catch (err) {
    next(err);
  }
}

// POST /api/shop/unequip
async function unequipItem(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const { itemId } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        activeSkinColor: true,
        activeSkinMarker: true,
        activeSkinTrail: true,
        color: true,
        ownedSkins: true
      }
    });
    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const DEFAULT_COLOR = '#00ff88';
    
    let updateData = {};

    if (itemId) {
      const item = getItemById(itemId);
      if (item) {
        updateData[SKIN_FIELD[item.type]] = null;
        if (item.type === 'color') {
          updateData.color = DEFAULT_COLOR;
        }
      }
    } else {
      updateData.activeSkinColor  = null;
      updateData.activeSkinMarker = null;
      updateData.activeSkinTrail  = null;
      updateData.color = DEFAULT_COLOR;
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        activeSkinColor: true,
        activeSkinMarker: true,
        activeSkinTrail: true,
        color: true
      }
    });

    if (updateData.color === DEFAULT_COLOR) {
      await syncColorChange(userId, DEFAULT_COLOR);
    }

    res.json({ ok: true, activeSkins: buildActiveSkins(updatedUser), color: updatedUser.color });
  } catch (err) {
    next(err);
  }
}

// POST /api/shop/daily
async function dailyClaim(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const now = new Date();
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isPremium: true,
        premiumUntil: true,
        premiumTier: true,
        lastDailyClaim: true,
        coins: true
      }
    });
    if (!u) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const tier = tierOf(u);
    const earned = entitlements(tier).dailyCoins; // Free 15 / Pro 15 / Ultra 30
    const premiumActive = tier !== 'free';

    // Atomik
    const result = await prisma.$transaction(async (tx) => {
      const cur = await tx.user.findUnique({
        where: { id: userId },
        select: { lastDailyClaim: true }
      });
      
      if (cur.lastDailyClaim && cur.lastDailyClaim > cutoff) {
        throw new Error('ALREADY_CLAIMED');
      }
      
      return await tx.user.update({
        where: { id: userId },
        data: {
          coins: { increment: earned },
          lastDailyClaim: now
        },
        select: { coins: true, lastDailyClaim: true }
      });
    });

    res.json({ ok: true, coins: result.coins, earned, premiumBonus: premiumActive });
  } catch (err) {
    if (err.message === 'ALREADY_CLAIMED') {
       const u = await prisma.user.findUnique({ where: { id: req.user.id || req.user._id }, select: { lastDailyClaim: true } });
       const nextAt = u?.lastDailyClaim
         ? new Date(u.lastDailyClaim.getTime() + 24 * 60 * 60 * 1000)
         : new Date();
       return res.status(429).json({ error: 'Kundalik mukofot allaqachon olindi', nextAt });
    }
    next(err);
  }
}

module.exports = { getShopItems, getMyShop, buyItem, equipItem, unequipItem, dailyClaim };
