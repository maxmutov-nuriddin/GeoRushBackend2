// Capture'dan KEYINGI yon effektlar — socket (territory:submit/capture) va REST
// (/api/territories/capture) yo'llari uchun YAGONA manba. Avval bu logika ikki joyda
// yarim-yarim edi: REST yo'lida (mobil!) level-up coin, level-up push, offline egalarga
// invasion push va qo'shni (neighbor) pushlar umuman yo'q edi.
//
// Scale-out: onlayn tekshiruvlar onlineStore orqali (lokal Map yoki Redis mirror),
// socket emitlari user:{id} room orqali — egasi qaysi instance'da bo'lsa ham yetadi.
const { Expo } = require('expo-server-sdk');
const { prisma } = require('../config/database');
const { tierOf, entitlements } = require('../config/tiers');
const { invalidateLeaderboardCache, emitLeaderboardUpdate } = require('../controllers/leaderboardController');
const onlineStore = require('./onlineStore');
const logger = require('../utils/logger');

const expo = new Expo();
const COINS_PER_LEVEL = 50;

async function sendExpoPush(pushToken, title, body) {
  if (!Expo.isExpoPushToken(pushToken)) return;
  try {
    await expo.sendPushNotificationsAsync([{
      to: pushToken, sound: 'default', title, body, priority: 'high',
    }]);
  } catch (err) { logger.warn('Push notification failed', { pushToken, err: err.message }); }
}

// Hujum (invasion) bildirishnomalari. Onlayn ega — socket emit (bitta event, haqiqiy foiz
// bilan); offlayn ega — Expo push. Free tier bildirishnoma olmaydi (entitlements).
async function emitInvasionNotifications(io, { attackerUsername, notifications }) {
  for (const notif of notifications || []) {
    const pct = notif.capturePercent;
    const online = await onlineStore.get(notif.ownerId);

    // 1) Onlayn (socket ulangan) — jonli in-app event. Lekin "online" bo'lsa ham app
    //    BACKGROUND'da bo'lishi mumkin (socket darrov uzilmaydi, STALE_MS=3daq), shuning
    //    uchun pastda push HAR DOIM yuboriladi; foreground'da mijoz OS-bannerni bostiradi.
    if (online && entitlements(online.tier || 'free').notifications !== 'none') {
      io.to(`user:${notif.ownerId}`).emit('territory:invaded', { attackerUsername, percent: pct });
    }

    // 2) Push — online holatidan QAT'I NAZAR (app tashqarisida/background'da kelishi uchun).
    let dbUser;
    try {
      dbUser = await prisma.user.findUnique({
        where: { id: notif.ownerId },
        select: { expoPushToken: true, isPremium: true, premiumUntil: true, premiumTier: true },
      });
    } catch (err) {
      logger.warn('Invasion lookup failed', { ownerId: notif.ownerId, err: err.message });
      continue;
    }
    if (!dbUser || !dbUser.expoPushToken || entitlements(tierOf(dbUser)).notifications === 'none') continue;

    if (pct >= 100) {
      await sendExpoPush(
        dbUser.expoPushToken,
        'GeoRush — Hudud yo\'qotildi! 💥',
        `${attackerUsername} sizning hududingizni to'liq zabt etdi!`,
      );
    } else if (pct >= 25) {
      await sendExpoPush(
        dbUser.expoPushToken,
        'GeoRush — Hududingiz hujum ostida! ⚠️',
        `${attackerUsername} sizning hududingizni ${pct}% egalladi! Tezda qaytib keling!`,
      );
    }
  }
}

// Qo'shni hudud egalariga push — faqat offlayn va Pro/Ultra egalarga.
async function sendNeighborPushes({ attackerUsername, neighborOwnerIds }) {
  if (!neighborOwnerIds?.length) return;
  const offlineIds = [];
  for (const oid of neighborOwnerIds) {
    if (!(await onlineStore.get(oid))) offlineIds.push(oid);
  }
  if (!offlineIds.length) return;
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: offlineIds }, expoPushToken: { not: null } },
      select: { expoPushToken: true, isPremium: true, premiumUntil: true, premiumTier: true },
    });
    for (const u of users) {
      if (entitlements(tierOf(u)).notifications === 'none') continue;
      await sendExpoPush(
        u.expoPushToken,
        'GeoRush — Yangi qo\'shni! 🗺️',
        `${attackerUsername} sizning yoningizda hudud egalladi!`,
      );
    }
  } catch (err) { logger.warn('Neighbor push failed', { err: err.message }); }
}

// Level oshganda: global broadcast + push + coin mukofoti (tier coinMult bilan).
async function handleLevelUp(io, { userId, username, result, capturerSocket }) {
  const oldLevel = result.oldLevel || onlineStore.getLocal(userId)?.level || 1;
  if (!(result.newLevel > oldLevel)) return;

  const player = onlineStore.getLocal(userId);
  if (player) player.level = result.newLevel;

  io.to('global').emit('player:levelup', { userId, username, newLevel: result.newLevel });

  let dbUser = null;
  try {
    dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { expoPushToken: true, isPremium: true, premiumUntil: true, premiumTier: true },
    });
  } catch (err) { logger.warn('Level-up lookup failed', { userId, err: err.message }); }

  const multiplier = entitlements(tierOf(dbUser)).coinMult; // Free 1× / Pro 1.5× / Ultra 2×
  const amount = Math.round(COINS_PER_LEVEL * multiplier);
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { coins: { increment: amount } },
    });
    const coinsEvent = {
      reason: `${result.newLevel}-daraja uchun mukofot`,
      amount,
      premiumBonus: multiplier > 1,
    };
    if (capturerSocket) capturerSocket.emit('shop:coins_earned', coinsEvent);
    else io.to(`user:${userId}`).emit('shop:coins_earned', coinsEvent);
  } catch (err) { logger.warn('Level-up coins failed', { userId, err: err.message }); }

  if (dbUser?.expoPushToken) {
    await sendExpoPush(
      dbUser.expoPushToken,
      'GeoRush — Daraja oshdi! 🎉',
      `Tabriklaymiz! Siz ${result.newLevel}-darajaga chiqdingiz! +${amount} GeoCoins!`,
    );
  }
}

// Capture'dan keyingi barcha yon effektlar (territory:new broadcast'dan tashqari —
// u chaqiruvchi tomonda qoladi). Hech bir xato capture natijasini buzmaydi.
async function runPostCaptureEffects({ io, userId, username, result, capturerSocket = null }) {
  const attackerUsername = username || 'Noma\'lum';

  try {
    await emitInvasionNotifications(io, {
      attackerUsername,
      notifications: result.invasionNotifications,
    });
  } catch (err) { logger.warn('Invasion notifications failed', { err: err.message }); }

  try {
    await sendNeighborPushes({
      attackerUsername,
      neighborOwnerIds: result.neighborNotifications,
    });
  } catch (err) { logger.warn('Neighbor pushes failed', { err: err.message }); }

  invalidateLeaderboardCache();
  emitLeaderboardUpdate(io);

  try {
    await handleLevelUp(io, { userId, username: attackerUsername, result, capturerSocket });
  } catch (err) { logger.warn('Level-up effects failed', { err: err.message }); }

  // Referral: bu userning birinchi capture'i bo'lsa, taklif mukofotlarini beradi.
  // Lazy require — referralController bu fayldan sendExpoPush oladi, top-level
  // require qilinsa circular dependency'da bo'sh export kelib qolardi.
  try {
    const { completeReferralIfPending } = require('../controllers/referralController');
    await completeReferralIfPending({ userId, io });
  } catch (err) { logger.warn('Referral reward failed', { err: err.message }); }

  // Do'kon shield'i tufayli raqib hududlari kesib chiqarilgan bo'lsa — o'yinchiga xabar
  // (capture o'zi muvaffaqiyatli; bu faqat "nega maydon kichikroq" tushuntirishi).
  try {
    if (Array.isArray(result.shieldBlocked) && result.shieldBlocked.length) {
      const event = {
        code: 'SHIELD_PROTECTED',
        message: 'Ba\'zi hududlar 24 soatlik shield bilan himoyalangan — ular kesib chiqarildi',
        territoryIds: result.shieldBlocked,
        full: false,
      };
      if (capturerSocket) capturerSocket.emit('territory:shield_blocked', event);
      else io.to(`user:${userId}`).emit('territory:shield_blocked', event);
    }
  } catch (err) { logger.error('Shield-blocked notify failed', err); }

  // B2B Sponsored Zone — hudud bazaga yozilgandan KEYIN, to'liq izolyatsiyada.
  // Lazy require — sponsoredZone territoryService'ni yuklaydi (circular himoya).
  try {
    const { checkAndRewardSponsoredZones } = require('./sponsoredZone');
    const polygonStr = result.territory?.polygon ? JSON.stringify(result.territory.polygon) : null;
    await checkAndRewardSponsoredZones(userId, polygonStr, io, {
      onLevelUp: (lv) => handleLevelUp(io, { userId, username: attackerUsername, result: lv, capturerSocket }),
    });
  } catch (err) { logger.error('Sponsored zone check failed', err); }
}

module.exports = { runPostCaptureEffects, sendExpoPush };
