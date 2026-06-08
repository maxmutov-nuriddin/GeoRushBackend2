const { Expo } = require('expo-server-sdk');
const { captureTerritory } = require('../../services/territoryService');
const { getUserTrail } = require('./locationHandler');
const { detectClosedPolygon } = require('../../services/geoService');
const { invalidateLeaderboardCache, emitLeaderboardUpdate } = require('../../controllers/leaderboardController');
const { prisma } = require('../../config/database');
const constants = require('../../config/constants');
const { tierOf, entitlements } = require('../../config/tiers');
const logger = require('../../utils/logger');

const expo = new Expo();
const INVASION_MILESTONES = [25, 50, 75, 100];

async function sendExpoPush(pushToken, title, body) {
  if (!Expo.isExpoPushToken(pushToken)) return;
  try {
    await expo.sendPushNotificationsAsync([{
      to: pushToken, sound: 'default', title, body, priority: 'high',
    }]);
  } catch (err) { logger.warn('Push notification failed', { pushToken, err: err.message }); }
}

async function emitInvasionNotifications(io, onlinePlayers, attackerId, invasionNotifications) {
  const attacker = onlinePlayers.get(attackerId)?.username || 'Noma\'lum';
  for (const notif of invasionNotifications) {
    const owner = onlinePlayers.get(notif.ownerId);
    const pct = notif.capturePercent;
    const crossed = INVASION_MILESTONES.filter((m) => pct >= m);
    if (!crossed.length) continue;

    // Hujum bildirishnomasi — faqat Pro/Ultra (Free olmaydi)
    let dbUser = null;
    if (owner?.socketId) {
      if (entitlements(owner.tier || 'free').notifications === 'none') continue;
    } else {
      try {
        dbUser = await prisma.user.findUnique({
          where: { id: notif.ownerId },
          select: { expoPushToken: true, isPremium: true, premiumUntil: true, premiumTier: true }
        });
      } catch (err) { logger.warn('Invasion push lookup failed', { ownerId: notif.ownerId, err: err.message }); continue; }
      if (entitlements(tierOf(dbUser)).notifications === 'none') continue;
    }

    for (const milestone of crossed) {
      if (owner?.socketId) {
        io.to(owner.socketId).emit('territory:invaded', { attackerUsername: attacker, percent: milestone });
      } else if (dbUser?.expoPushToken) {
        if (milestone === 25 && pct < 100) {
          await sendExpoPush(
            dbUser.expoPushToken,
            'GeoRush — Hududingiz hujum ostida! ⚠️',
            `${attacker} sizning hududingizni 25% egalladi! Tezda qaytib keling!`,
          );
        } else if (milestone === 100) {
          await sendExpoPush(
            dbUser.expoPushToken,
            'GeoRush — Hudud yo\'qotildi! 💥',
            `${attacker} sizning hududingizni to'liq zabt etdi!`,
          );
        }
      }
    }
  }
}

const COINS_PER_LEVEL = 50;

const isActivePremium = (u) =>
  !!(u && u.isPremium && u.premiumUntil && new Date() < new Date(u.premiumUntil));

async function sendLevelUpPush(userId, newLevel) {
  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { expoPushToken: true }
    });
    if (dbUser?.expoPushToken) {
      await sendExpoPush(
        dbUser.expoPushToken,
        `GeoRush — Daraja oshdi! 🎉`,
        `Tabriklaymiz! Siz ${newLevel}-darajaga chiqdingiz! +${COINS_PER_LEVEL} GeoCoins!`,
      );
    }
  } catch (err) { logger.warn('Level-up push failed', { userId, newLevel, err: err.message }); }
}

async function giveCoinsOnLevelUp(userId, newLevel, socket) {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { isPremium: true, premiumUntil: true, premiumTier: true }
    });
    const multiplier = entitlements(tierOf(u)).coinMult; // Free 1× / Pro 1.5× / Ultra 2×
    const amount = Math.round(COINS_PER_LEVEL * multiplier);
    await prisma.user.update({
      where: { id: userId },
      data: { coins: { increment: amount } }
    });
    socket.emit('shop:coins_earned', {
      reason: `${newLevel}-daraja uchun mukofot`,
      amount,
      premiumBonus: multiplier > 1,
    });
  } catch {}
}

async function sendNeighborPushes(onlinePlayers, attackerId, neighborOwnerIds) {
  if (!neighborOwnerIds.length) return;
  const attacker = onlinePlayers.get(attackerId)?.username || 'Noma\'lum';
  const offlineIds = neighborOwnerIds.filter((oid) => !onlinePlayers.get(oid)?.socketId);
  if (!offlineIds.length) return;
  try {
    const users = await prisma.user.findMany({
      where: {
        id: { in: offlineIds },
        expoPushToken: { not: null },
      },
      select: { expoPushToken: true, isPremium: true, premiumUntil: true, premiumTier: true }
    });
    for (const u of users) {
      if (entitlements(tierOf(u)).notifications === 'none') continue; // Free — bildirishnoma yo'q
      await sendExpoPush(
        u.expoPushToken,
        'GeoRush — Yangi qo\'shni! 🗺️',
        `${attacker} sizning yoningizda hudud egalladi!`,
      );
    }
  } catch {}
}

// Server trailidan polygon yasab, territory capture qiluvchi umumiy funksiya.
// territory:capture va territory:submit ikkalasi ham shu funksiyani ishlatadi —
// client dan kelgan nuqtalarga ISHONILMAYDI, faqat server trailidan foydalaniladi.
async function processCaptureFromServerTrail(socket, io, onlinePlayers, userId) {
  const trail = getUserTrail(userId);

  if (trail.length < constants.MIN_TRAIL_POINTS_FOR_POLYGON) {
    socket.emit('territory:error', { message: 'Not enough trail points to capture territory' });
    return;
  }

  // Avval geometrik kesishish orqali polygon aniqlaymiz
  let polygon = detectClosedPolygon(trail);
  if (!polygon) {
    // Frontend proximity bilan yopgan bo'lishi mumkin — trail ni boshiga ulab yopamiz
    polygon = [...trail, trail[0]];
  }

  try {
    const result = await captureTerritory(userId, polygon);

    const capturedMsg = result.premiumBonus
      ? `Territory captured! +${result.xpGained} XP ⚡ (2x Premium)`
      : `Territory captured! +${result.xpGained} XP`;
    socket.emit('territory:captured', { ...result, message: capturedMsg });

    io.to('global').emit('territory:new', {
      territory: result.territory,
      capturedBy: {
        userId,
        username: onlinePlayers.get(userId)?.username,
        level: result.newLevel,
      },
      xpGained: result.xpGained,
      stolenFrom: result.stolenFrom,
    });

    await emitInvasionNotifications(io, onlinePlayers, userId, result.invasionNotifications || []);
    await sendNeighborPushes(onlinePlayers, userId, result.neighborNotifications || []);

    invalidateLeaderboardCache();
    emitLeaderboardUpdate(io);

    if (result.newLevel > (result.oldLevel || onlinePlayers.get(userId)?.level || 1)) {
      const player = onlinePlayers.get(userId);
      if (player) player.level = result.newLevel;
      io.to('global').emit('player:levelup', {
        userId,
        username: onlinePlayers.get(userId)?.username,
        newLevel: result.newLevel,
      });
      await sendLevelUpPush(userId, result.newLevel);
      await giveCoinsOnLevelUp(userId, result.newLevel, socket);
    }

    logger.info(`Territory captured by ${userId}: area=${result.territory.area.toFixed(0)}m², xp=${result.xpGained}`);
  } catch (err) {
    if (err.code === 'PREMIUM_PROTECTED') {
      socket.emit('territory:blocked', {
        code: 'PREMIUM_PROTECTED',
        message: err.message,
        requiredLevel: err.requiredLevel,
      });
    } else {
      socket.emit('territory:error', { message: err.message || 'Failed to capture territory' });
      if (!err.status) logger.error('Unexpected territory capture error', err);
    }
  }
}

function handleTerritory(io, socket, onlinePlayers) {
  const { userId } = socket;

  socket.on('territory:capture', () => {
    processCaptureFromServerTrail(socket, io, onlinePlayers, userId);
  });

  // Client dan kelgan points ISHLATILMAYDI — server o'z trailidan foydalanadi.
  // Frontend territoriya yopilganini aniqlashi bilan bu event yuboriladi.
  socket.on('territory:submit', () => {
    processCaptureFromServerTrail(socket, io, onlinePlayers, userId);
  });
}

module.exports = { handleTerritory };
