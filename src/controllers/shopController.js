const { prisma } = require('../config/database');
const { getIo } = require('../socket/ioInstance');
const { SHOP_ITEMS, getItemById } = require('../config/shopItems');
const { tierOf, entitlements, TERRITORY_SLOT_PRICE, EXPANSION_PACK, TEAM_CREATE_PRICE } = require('../config/tiers');
const { applyPendingRollover } = require('../services/premiumRollover');

const DAILY_COINS = 15;

// color -> 'activeSkinColor', marker -> 'activeSkinMarker', trail -> 'activeSkinTrail'
const SKIN_FIELD = {
  color:  'activeSkinColor',
  marker: 'activeSkinMarker',
  trail:  'activeSkinTrail',
  nick:   'activeSkinNick',
};

function buildActiveSkins(user) {
  const old = user.activeSkin || null;
  return {
    color:  user.activeSkinColor  || (old?.startsWith('color_')  ? old : null),
    marker: user.activeSkinMarker || (old?.startsWith('marker_') ? old : null),
    trail:  user.activeSkinTrail  || (old?.startsWith('trail_')  ? old : null),
    nick:   user.activeSkinNick   || null,
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
    await applyPendingRollover(userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        coins: true,
        ownedSkins: true,
        activeSkinColor: true,
        activeSkinMarker: true,
        activeSkinTrail: true,
        activeSkinNick: true,
        lastDailyClaim: true,
        isPremium: true,
        premiumUntil: true,
        premiumTier: true,
        expansionsUsed: true,
        purchasedSlots: true,
        purchasedExpansions: true,
        purchasedTeamCreate: true
      }
    });

    if (!user) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });

    const ownedSkins = user.ownedSkins || [];
    const ownedItems = SHOP_ITEMS.filter(i => ownedSkins.includes(i.id));

    const nextDaily = user.lastDailyClaim
      ? new Date(user.lastDailyClaim.getTime() + 24 * 60 * 60 * 1000)
      : null;
    const canClaim = !nextDaily || new Date() >= nextDaily;

    // ── Hudud iqtisodi holati (UI sotib olish bo'limi uchun) ──
    const ent = entitlements(tierOf(user));
    const ownedTerritories = await prisma.territory.count({ where: { ownerId: userId } });
    const slotUnlimited   = !Number.isFinite(ent.territoryLimit);
    const expandUnlimited = !Number.isFinite(ent.expandLimit);
    const territory = {
      owned: ownedTerritories,
      limit: slotUnlimited ? null : ent.territoryLimit + (user.purchasedSlots || 0),
      baseLimit: slotUnlimited ? null : ent.territoryLimit,
      purchasedSlots: user.purchasedSlots || 0,
      maxPurchasedSlots: ent.maxPurchasedSlots || 0,
      slotPrice: TERRITORY_SLOT_PRICE,
      canBuySlot: !slotUnlimited && (user.purchasedSlots || 0) < (ent.maxPurchasedSlots || 0),
      expandLimit: expandUnlimited ? null : ent.expandLimit + (user.purchasedExpansions || 0),
      expandBase: expandUnlimited ? null : ent.expandLimit,
      expansionsUsed: user.expansionsUsed || 0,
      expandRemaining: expandUnlimited ? null : Math.max(0, ent.expandLimit + (user.purchasedExpansions || 0) - (user.expansionsUsed || 0)),
      purchasedExpansions: user.purchasedExpansions || 0,
      expansionPack: EXPANSION_PACK,
      canBuyExpansion: !expandUnlimited,
    };

    // ── Jamoa yaratish fishkasi (Free uchun coinda; Pro/Ultra'da tier orqali bor) ──
    const teamCreate = {
      hasViaTier: !!ent.teamCreate,                            // Pro/Ultra
      purchased:  !!user.purchasedTeamCreate,
      price:      TEAM_CREATE_PRICE,
      canBuy:     !ent.teamCreate && !user.purchasedTeamCreate, // faqat Free va hali olmagan
    };

    res.json({
      coins: user.coins || 0,
      activeSkins: buildActiveSkins(user),
      ownedItems,
      canClaim,
      nextDaily,
      territory,
      teamCreate,
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
          activeSkinNick: true,
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
        activeSkinNick: true,
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
        activeSkinNick: true,
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
        activeSkinNick: true,
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
        activeSkinNick: true,
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

// POST /api/shop/buy-territory-slot — coin bilan DOIMIY +1 hudud sloti
async function buyTerritorySlot(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const result = await prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, purchasedSlots: true, isPremium: true, premiumUntil: true, premiumTier: true }
      });
      if (!u) throw new Error('NOT_FOUND');
      const ent = entitlements(tierOf(u));
      if (!Number.isFinite(ent.territoryLimit)) throw new Error('ALREADY_UNLIMITED'); // Ultra
      if ((u.purchasedSlots || 0) >= (ent.maxPurchasedSlots || 0)) throw new Error('SLOT_CAP');
      if (u.coins < TERRITORY_SLOT_PRICE) throw new Error('NOT_ENOUGH_COINS');
      return await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: TERRITORY_SLOT_PRICE }, purchasedSlots: { increment: 1 } },
        select: { coins: true, purchasedSlots: true }
      });
    });
    res.json({ ok: true, coins: result.coins, purchasedSlots: result.purchasedSlots });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (err.message === 'ALREADY_UNLIMITED') return res.status(400).json({ error: 'Sizda hudud limiti allaqachon cheksiz', code: 'ALREADY_UNLIMITED' });
    if (err.message === 'SLOT_CAP') return res.status(400).json({ error: 'Qo\'shimcha slot chegarasiga yetdingiz', code: 'SLOT_CAP' });
    if (err.message === 'NOT_ENOUGH_COINS') {
      const u = await prisma.user.findUnique({ where: { id: req.user.id || req.user._id }, select: { coins: true } });
      return res.status(400).json({ error: 'Coinlar yetarli emas', code: 'NOT_ENOUGH_COINS', need: TERRITORY_SLOT_PRICE, have: u?.coins || 0 });
    }
    next(err);
  }
}

// POST /api/shop/buy-expansions — coin bilan ISTE'MOL kengaytirish to'plami (+EXPANSION_PACK.amount)
async function buyExpansions(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const result = await prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, purchasedExpansions: true, isPremium: true, premiumUntil: true, premiumTier: true }
      });
      if (!u) throw new Error('NOT_FOUND');
      const ent = entitlements(tierOf(u));
      if (!Number.isFinite(ent.expandLimit)) throw new Error('ALREADY_UNLIMITED'); // Ultra
      if (u.coins < EXPANSION_PACK.price) throw new Error('NOT_ENOUGH_COINS');
      return await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: EXPANSION_PACK.price }, purchasedExpansions: { increment: EXPANSION_PACK.amount } },
        select: { coins: true, purchasedExpansions: true }
      });
    });
    res.json({ ok: true, coins: result.coins, purchasedExpansions: result.purchasedExpansions, added: EXPANSION_PACK.amount });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (err.message === 'ALREADY_UNLIMITED') return res.status(400).json({ error: 'Sizda kengaytirish allaqachon cheksiz', code: 'ALREADY_UNLIMITED' });
    if (err.message === 'NOT_ENOUGH_COINS') {
      const u = await prisma.user.findUnique({ where: { id: req.user.id || req.user._id }, select: { coins: true } });
      return res.status(400).json({ error: 'Coinlar yetarli emas', code: 'NOT_ENOUGH_COINS', need: EXPANSION_PACK.price, have: u?.coins || 0 });
    }
    next(err);
  }
}

// POST /api/shop/buy-team-create — Free: coin bilan jamoa yaratish huquqi (doimiy)
async function buyTeamCreate(req, res, next) {
  try {
    const userId = req.user.id || req.user._id;
    const result = await prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, purchasedTeamCreate: true, isPremium: true, premiumUntil: true, premiumTier: true }
      });
      if (!u) throw new Error('NOT_FOUND');
      if (entitlements(tierOf(u)).teamCreate) throw new Error('ALREADY_VIA_TIER'); // Pro/Ultra — kerak emas
      if (u.purchasedTeamCreate) throw new Error('ALREADY_OWNED');
      if (u.coins < TEAM_CREATE_PRICE) throw new Error('NOT_ENOUGH_COINS');
      return await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: TEAM_CREATE_PRICE }, purchasedTeamCreate: true },
        select: { coins: true, purchasedTeamCreate: true }
      });
    });
    res.json({ ok: true, coins: result.coins, purchasedTeamCreate: result.purchasedTeamCreate });
  } catch (err) {
    if (err.message === 'NOT_FOUND') return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (err.message === 'ALREADY_VIA_TIER') return res.status(400).json({ error: 'Sizda jamoa yaratish allaqachon bor', code: 'ALREADY_VIA_TIER' });
    if (err.message === 'ALREADY_OWNED') return res.status(409).json({ error: 'Jamoa yaratish huquqi allaqachon sizda bor', code: 'ALREADY_OWNED' });
    if (err.message === 'NOT_ENOUGH_COINS') {
      const u = await prisma.user.findUnique({ where: { id: req.user.id || req.user._id }, select: { coins: true } });
      return res.status(400).json({ error: 'Coinlar yetarli emas', code: 'NOT_ENOUGH_COINS', need: TEAM_CREATE_PRICE, have: u?.coins || 0 });
    }
    next(err);
  }
}

module.exports = { getShopItems, getMyShop, buyItem, equipItem, unequipItem, dailyClaim, buyTerritorySlot, buyExpansions, buyTeamCreate };
