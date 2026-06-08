const { authenticateSocket } = require('../middleware/auth');
const { handleLocation, getUserTrail } = require('./handlers/locationHandler');
const { handleTerritory } = require('./handlers/territoryHandler');
const { tierOf } = require('../config/tiers');
const { removePlayer } = require('../services/antiCheatService');
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

// Online players: userId (string) -> { socketId, username, lat, lng, color, teamId, level }
const onlinePlayers = new Map();

function getOnlinePlayers() {
  return Object.fromEntries(onlinePlayers);
}

// players:init uchun jamoadagilarni har birining joriy yo'l chizig'i (trail) bilan qaytaradi —
// shunda keyin ulangan a'zo mavjud jamoa chiziqlarini darrov ko'radi.
function teammatesWithTrails(myTeamId, excludeId) {
  return Object.fromEntries(
    [...onlinePlayers]
      .filter(([id, p]) => p.teamId === myTeamId && id !== excludeId)
      .map(([id, p]) => [id, { ...p, trail: getUserTrail(id) }]),
  );
}

// REST API orqali jamoa o'zgarganda socket roomni yangilash
function setPlayerTeam(io, userId, newTeamId) {
  const player = onlinePlayers.get(userId);
  if (!player) return;

  const oldTeamId = player.teamId;

  // Eski team roomdan chiqish
  if (oldTeamId) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) sock.leave(`team:${oldTeamId}`);
    io.to(`team:${oldTeamId}`).emit('player:left', { userId });
  }

  player.teamId = newTeamId || null;

  // Yangi team roomga kirish
  if (newTeamId) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.join(`team:${newTeamId}`);
      // Yangi jamoa a'zolariga xabar
      io.to(`team:${newTeamId}`).emit('player:joined', { userId, ...player });
      // Yangi a'zoga mavjud jamoa a'zolarini (yo'l chiziqlari bilan) yuborish
      const teammates = teammatesWithTrails(newTeamId, userId);
      sock.emit('players:init', teammates);
    }
  } else {
    // Jamoa yo'q — bo'sh init yuborish
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) sock.emit('players:init', {});
  }
}

function initializeSocket(io) {
  io.use(authenticateSocket);

  io.on('connection', async (socket) => {
    const { userId, username } = socket;
    logger.debug(`Player connected: ${username} (${userId})`);

    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          color: true,
          teamId: true,
          level: true,
          isAdmin: true,
          isBanned: true,
          activeSkinMarker: true,
          activeSkinTrail: true,
          isPremium: true,
          premiumUntil: true,
          premiumTier: true,
        }
      });
      if (user?.isBanned) {
        socket.emit('error', { message: 'Akkaunt bloklangan', code: 'BANNED' });
        socket.disconnect(true);
        return;
      }
      if (user?.isAdmin) {
        socket.join('admin');
      } else if (user) {
        const teamId = user.teamId?.toString() || null;
        onlinePlayers.set(userId, {
          socketId: socket.id,
          username,
          lat: null,
          lng: null,
          color:      user.color,
          teamId,
          level:      user.level,
          markerSkin: user.activeSkinMarker || null,
          trailSkin:  user.activeSkinTrail  || null,
          isPremium:  !!(user.isPremium && user.premiumUntil && new Date() < new Date(user.premiumUntil)),
          tier:       tierOf(user),
        });

        await prisma.user.update({
          where: { id: userId },
          data: { isOnline: true, socketId: socket.id, lastSeen: new Date() },
        });

        if (teamId) socket.join(`team:${teamId}`);
      }
    } catch (err) {
      logger.error('Error on socket connect', err);
    }

    socket.join('global');

    // Faqat bir jamoadagilarni yuborish
    const myTeamId = onlinePlayers.get(userId)?.teamId || null;
    const teammates = myTeamId ? teammatesWithTrails(myTeamId, userId) : {};
    socket.emit('players:init', teammates);

    if (myTeamId) {
      socket.to(`team:${myTeamId}`).emit('player:joined', { userId, username, ...onlinePlayers.get(userId) });
    }

    handleLocation(io, socket, onlinePlayers);
    handleTerritory(io, socket, onlinePlayers);

    socket.on('disconnect', async (reason) => {
      logger.debug(`Player disconnected: ${username} — ${reason}`);
      const teamId = onlinePlayers.get(userId)?.teamId || null;
      onlinePlayers.delete(userId);
      removePlayer(userId);

      try {
        await prisma.user.update({
          where: { id: userId },
          data: { isOnline: false, socketId: null, lastSeen: new Date() },
        });
      } catch (err) {
        logger.error('Error on socket disconnect', err);
      }

      if (teamId) io.to(`team:${teamId}`).emit('player:left', { userId });
    });
  });
}

module.exports = { initializeSocket, getOnlinePlayers, setPlayerTeam };
