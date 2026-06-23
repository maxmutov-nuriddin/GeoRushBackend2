const { authenticateSocket } = require('../middleware/auth');
const { handleLocation } = require('./handlers/locationHandler');
const { handleTerritory } = require('./handlers/territoryHandler');
const { getTrail } = require('../services/trailStore');
const onlineStore = require('../services/onlineStore');
const { tierOf } = require('../config/tiers');
const { removePlayer } = require('../services/antiCheatService');
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

// Eslatma (scale-out): har socket `user:{userId}` roomiga kiradi — shu tufayli
// io.to(`user:X`).emit va io.in(`user:X`).socketsJoin(...) Redis adapter orqali
// user qaysi instance'da bo'lsa ham yetib boradi. REDIS_URL'siz (bitta instance)
// bularning hammasi avvalgidek lokal ishlaydi — xulq farqi yo'q.

// players:init uchun jamoadagilarni har birining joriy yo'l chizig'i (trail) bilan qaytaradi —
// shunda keyin ulangan a'zo mavjud jamoa chiziqlarini darrov ko'radi.
async function buildTeammatesWithTrails(myTeamId, excludeId) {
  const members = await onlineStore.getTeamMembers(myTeamId, excludeId);
  const out = {};
  for (const [id, entry] of Object.entries(members)) {
    out[id] = { ...entry, trail: await getTrail(id) };
  }
  return out;
}

// REST API orqali jamoa o'zgarganda socket room va onlayn reestrni yangilash.
// Sinxron chaqiriladi (await'siz) — ichidagi async ish xato bersa log qilinadi.
function setPlayerTeam(io, userId, newTeamId) {
  applyTeamChange(io, userId, newTeamId)
    .catch((err) => logger.error('setPlayerTeam failed', { userId, err: err.message }));
}

async function applyTeamChange(io, userId, newTeamId) {
  const entry = await onlineStore.get(userId);

  // O'yinchi onlayn bo'lmasa ham mirror/team-set tozalansin (scale rejimida)
  if (!entry) {
    await onlineStore.setTeam(userId, newTeamId || null);
    return;
  }

  const oldTeamId = entry.teamId || null;
  const userRoom = `user:${userId}`;

  // Eski team roomdan chiqarish — socketsLeave cross-instance ishlaydi
  if (oldTeamId) {
    io.in(userRoom).socketsLeave(`team:${oldTeamId}`);
    io.to(`team:${oldTeamId}`).emit('player:left', { userId });
  }

  // Lokal + Redis reestr; boshqa instance'lardagi lokal nusxa serverSideEmit orqali
  await onlineStore.setTeam(userId, newTeamId || null);
  try {
    if (typeof io.serverSideEmit === 'function') {
      io.serverSideEmit('gr:teamChange', { userId, teamId: newTeamId || null });
    }
  } catch { /* adapter yo'q — bitta instance */ }

  if (newTeamId) {
    io.in(userRoom).socketsJoin(`team:${newTeamId}`);
    // Yangi jamoa a'zolariga xabar
    io.to(`team:${newTeamId}`).emit('player:joined', { userId, ...entry, teamId: newTeamId });
    // Yangi a'zoga mavjud jamoa a'zolarini (yo'l chiziqlari bilan) yuborish
    const teammates = await buildTeammatesWithTrails(newTeamId, userId);
    io.to(userRoom).emit('players:init', teammates);
  } else {
    // Jamoa yo'q — bo'sh init yuborish
    io.to(userRoom).emit('players:init', {});
  }
}

function initializeSocket(io) {
  io.use(authenticateSocket);

  // Boshqa instance jamoa o'zgarishini e'lon qilganda lokal nusxani yangilaymiz
  // (faqat scale rejimida keladi; bitta instance'da bu event umuman bo'lmaydi)
  io.on('gr:teamChange', ({ userId, teamId }) => {
    onlineStore.setLocalTeam(userId, teamId || null);
  });

  // Redis rejimида: heartbeat + o'lik instance qoldiqlarini tozalash
  onlineStore.startMaintenance();

  io.on('connection', async (socket) => {
    const { userId, username } = socket;
    logger.debug(`Player connected: ${username} (${userId})`);

    // Cross-instance manzillash uchun shaxsiy room
    socket.join(`user:${userId}`);

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
        socket.data.isAdmin = true;
        onlineStore.adminJoined();
      } else if (user) {
        const teamId = user.teamId?.toString() || null;
        onlineStore.addLocal(userId, {
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
        socket.data.connectedAt = Date.now(); // sessiya boshlanishi — disconnect'da davomiylik hisoblanadi

        if (teamId) socket.join(`team:${teamId}`);
      }
    } catch (err) {
      logger.error('Error on socket connect', err);
    }

    socket.join('global');

    // Faqat bir jamoadagilarni yuborish
    const myTeamId = onlineStore.getLocal(userId)?.teamId || null;
    const teammates = myTeamId ? await buildTeammatesWithTrails(myTeamId, userId) : {};
    socket.emit('players:init', teammates);

    if (myTeamId) {
      socket.to(`team:${myTeamId}`).emit('player:joined', { userId, username, ...onlineStore.getLocal(userId) });
    }

    handleLocation(io, socket);
    handleTerritory(io, socket);

    socket.on('disconnect', async (reason) => {
      logger.debug(`Player disconnected: ${username} — ${reason}`);

      if (socket.data.isAdmin) onlineStore.adminLeft();

      // Reconnect race himoyasi: yangi socket allaqachon ulangan bo'lsa (shu yoki
      // BOSHQA instance'da — getMirror GLOBAL haqiqatni o'qiydi), eski socketning
      // kechikkan disconnect'i yangi ulanishni o'chirib yubormasin.
      const mirror = await onlineStore.getMirror(userId);
      if (mirror && mirror.socketId !== socket.id) {
        // User boshqa socketda davom etmoqda. Bizning lokal nusxa aynan shu eski
        // socketniki bo'lsa — faqat lokalni tozalaymiz (mirror/trail/DB'ga tegmaymiz).
        const localEntry = onlineStore.getLocal(userId);
        if (localEntry && localEntry.socketId === socket.id) onlineStore.dropLocalOnly(userId);
        return;
      }

      const entry = onlineStore.getLocal(userId) || mirror;
      const teamId = entry?.teamId || null;
      onlineStore.removeLocal(userId);
      removePlayer(userId);

      // Sessiya davomiyligi (connect→disconnect). Faqat OQILONA oraliq hisobga olinadi
      // (5 soniya .. 12 soat) — soxta/osilib qolgan sessiyalar o'rtachani buzmasin.
      // Bu blok faqat HAQIQIY disconnect'da ishlaydi (reconnect-race yuqorida return qilingan).
      const sessionSec = socket.data.connectedAt
        ? Math.round((Date.now() - socket.data.connectedAt) / 1000) : 0;
      const validSession = sessionSec >= 5 && sessionSec <= 12 * 3600;
      try {
        await prisma.user.update({
          where: { id: userId },
          data: {
            isOnline: false, socketId: null, lastSeen: new Date(),
            ...(validSession ? { totalPlaytimeSec: { increment: sessionSec }, sessionCount: { increment: 1 } } : {}),
          },
        });
      } catch (err) {
        logger.error('Error on socket disconnect', err);
      }

      // Kunlik agregat (DailyStat) — bugungi UMUMIY kirib-chiqishlar (unik emas) + ilova vaqti.
      // Kümulyativ User maydonlariga TEGMAYDI — alohida qo'shimcha. Xato bo'lsa ham disconnect
      // oqimini buzmaydi (alohida try/catch). Kunlik UNIK kirganlar (DAU) — User.lastSeen orqali.
      if (validSession) {
        try {
          const d = new Date();
          const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          await prisma.$executeRawUnsafe(
            `INSERT INTO "DailyStat" ("date","playtimeSec","sessionCount","updatedAt")
             VALUES ($1, $2, 1, CURRENT_TIMESTAMP)
             ON CONFLICT ("date") DO UPDATE
               SET "playtimeSec"  = "DailyStat"."playtimeSec"  + $2,
                   "sessionCount" = "DailyStat"."sessionCount" + 1,
                   "updatedAt"    = CURRENT_TIMESTAMP`,
            dayKey, sessionSec
          );
        } catch (err) {
          logger.warn('DailyStat upsert skip:', err.message?.split('\n')[0]);
        }
      }

      if (teamId) io.to(`team:${teamId}`).emit('player:left', { userId });
    });
  });
}

// Avvalgi API bilan moslik: shu instance'dagi onlayn o'yinchilar (oddiy obyekt)
function getOnlinePlayers() {
  return Object.fromEntries(onlineStore.localEntries());
}

// Lokal jonli Map — faqat shu instance socketlari (hot path uchun)
function getOnlinePlayersMap() {
  return onlineStore.localEntries();
}

module.exports = { initializeSocket, getOnlinePlayers, getOnlinePlayersMap, setPlayerTeam };
