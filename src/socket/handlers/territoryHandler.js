const { captureTerritory } = require('../../services/territoryService');
const { runPostCaptureEffects } = require('../../services/captureEffects');
const { getUserTrail, resetUserTrail } = require('./locationHandler');
const { detectClosedPolygon } = require('../../services/geoService');
const constants = require('../../config/constants');
const logger = require('../../utils/logger');

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

    // Server trailini darhol tozalaymiz — aks holda keyingi capture eski (allaqachon
    // zabt etilgan) nuqtalarni ham qo'shib yuboradi. Client o'z trailini o'zi tozalaydi,
    // lekin server xotirasidagi nusxa shu yerda tozalanishi shart.
    resetUserTrail(userId);
    const teamId = onlinePlayers.get(userId)?.teamId || null;
    if (teamId) io.to(`team:${teamId}`).emit('team:trailReset', { userId });

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

    await runPostCaptureEffects({
      io,
      userId,
      username: onlinePlayers.get(userId)?.username,
      result,
      onlinePlayers,
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
