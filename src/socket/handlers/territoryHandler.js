const { captureTerritory } = require('../../services/territoryService');
const { runPostCaptureEffects } = require('../../services/captureEffects');
const { getUserTrail, resetUserTrail } = require('./locationHandler');
const { haversineDistance } = require('../../services/geoService');
const onlineStore = require('../../services/onlineStore');
const constants = require('../../config/constants');
const logger = require('../../utils/logger');

// Server trailidan polygon yasab, territory capture qiluvchi umumiy funksiya.
// territory:capture va territory:submit ikkalasi ham shu funksiyani ishlatadi —
// client dan kelgan nuqtalarga ISHONILMAYDI, faqat server trailidan foydalaniladi.
async function processCaptureFromServerTrail(socket, io, userId) {
  const trail = await getUserTrail(userId);

  if (trail.length < constants.MIN_TRAIL_POINTS_FOR_POLYGON) {
    socket.emit('territory:error', { message: 'Not enough trail points to capture territory' });
    return;
  }

  // ── Yopilish sharti: oxirgi nuqta boshlang'ich nuqtaga yaqin bo'lishi SHART ──
  // Halqa start'ga qaytib yopilmasa — saqlamaymiz (na auto, na qo'lda). Avval ochiq
  // trail oxirini boshiga to'g'ri chiziq bilan ulab MAJBURAN yopilardi (kartada keraksiz
  // diagonal chiziq + start'ga qaytmasdan zabt etish). Server yagona haqiqat manbai.
  const start = trail[0];
  const end = trail[trail.length - 1];
  const distToStart = haversineDistance(start[0], start[1], end[0], end[1]);
  if (distToStart > constants.TERRITORY_CLOSE_DISTANCE_M) {
    socket.emit('territory:error', {
      code: 'LOOP_NOT_CLOSED',
      message: 'Hududni yopish uchun boshlang\'ich nuqtaga qayting',
    });
    return;
  }

  // Start'ga qaytildi — trailni boshiga ulab halqani yopamiz.
  const polygon = [...trail, trail[0]];

  try {
    const result = await captureTerritory(userId, polygon);

    // Server trailini darhol tozalaymiz — aks holda keyingi capture eski (allaqachon
    // zabt etilgan) nuqtalarni ham qo'shib yuboradi. Client o'z trailini o'zi tozalaydi,
    // lekin server xotirasidagi nusxa shu yerda tozalanishi shart.
    await resetUserTrail(userId);
    const player = onlineStore.getLocal(userId);
    const teamId = player?.teamId || null;
    if (teamId) io.to(`team:${teamId}`).emit('team:trailReset', { userId });

    const capturedMsg = result.premiumBonus
      ? `Territory captured! +${result.xpGained} XP ⚡ (2x Premium)`
      : `Territory captured! +${result.xpGained} XP`;
    socket.emit('territory:captured', { ...result, message: capturedMsg });

    io.to('global').emit('territory:new', {
      territory: result.territory,
      capturedBy: {
        userId,
        username: player?.username,
        level: result.newLevel,
      },
      xpGained: result.xpGained,
      stolenFrom: result.stolenFrom,
    });

    await runPostCaptureEffects({
      io,
      userId,
      username: player?.username,
      result,
      capturerSocket: socket,
    });

    logger.info(`Territory captured by ${userId}: area=${result.territory.area.toFixed(0)}m², xp=${result.xpGained}`);
  } catch (err) {
    if (err.code === 'PREMIUM_PROTECTED') {
      socket.emit('territory:blocked', {
        code: 'PREMIUM_PROTECTED',
        message: err.message,
        requiredLevel: err.requiredLevel,
      });
    } else if (err.code === 'FULLY_PROTECTED' && err.shieldBlocked?.length) {
      // Do'kon shield'i bilan himoyalangan hudud — mijoz alohida "qalqon" xabarini ko'rsatadi
      socket.emit('territory:shield_blocked', {
        code: 'SHIELD_PROTECTED',
        message: 'Bu hudud 24 soatlik shield bilan himoyalangan',
        territoryIds: err.shieldBlocked,
        full: true,
      });
    } else if (err.code === 'TERRITORY_LIMIT') {
      socket.emit('territory:blocked', {
        code: 'TERRITORY_LIMIT',
        message: err.message,
        limit: err.limit,
      });
    } else {
      socket.emit('territory:error', { message: err.message || 'Failed to capture territory' });
      if (!err.status) logger.error('Unexpected territory capture error', err);
    }
  }
}

function handleTerritory(io, socket) {
  const { userId } = socket;

  socket.on('territory:capture', () => {
    processCaptureFromServerTrail(socket, io, userId);
  });

  // Client dan kelgan points ISHLATILMAYDI — server o'z trailidan foydalanadi.
  // Frontend territoriya yopilganini aniqlashi bilan bu event yuboriladi.
  socket.on('territory:submit', () => {
    processCaptureFromServerTrail(socket, io, userId);
  });
}

module.exports = { handleTerritory };
