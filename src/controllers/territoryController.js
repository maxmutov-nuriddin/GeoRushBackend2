const { prisma } = require('../config/database');
const { getTerritoriesInBounds, getUserTerritories, deleteTerritory, captureTerritory } = require('../services/territoryService');
const { runPostCaptureEffects } = require('../services/captureEffects');
const { getUserTrail, resetUserTrail } = require('../socket/handlers/locationHandler');
const { haversineDistance } = require('../services/geoService');
const { tierOf, entitlements } = require('../config/tiers');
const constants = require('../config/constants');
const logger = require('../utils/logger');

// Offline navbatdan kelgan trail (body) — anti-cheat sanity. Soxta/buzuq bo'lsa null.
// trail: [{lat,lng}] yoki [{latitude,longitude}]. Ketma-ket sakrash (>60m) yoki juda ko'p
// nuqta — rad etiladi (watcher chegaralari bilan bir xil).
// Natija: server trail bilan bir xil format — [[lat,lng],...].
function sanitizeBodyTrail(raw) {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  if (raw.length > constants.MAX_TRAIL_POINTS) return null;
  const pts = [];
  for (const p of raw) {
    const lat = Array.isArray(p) ? p[0] : (p.lat ?? p.latitude);
    const lng = Array.isArray(p) ? p[1] : (p.lng ?? p.longitude);
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const last = pts[pts.length - 1];
    if (last && haversineDistance(last[0], last[1], lat, lng) > 60) return null; // teleport/glitch
    pts.push([lat, lng]);
  }
  return pts.length >= 4 ? pts : null;
}

async function getTerritories(req, res, next) {
  try {
    const { swLat, swLng, neLat, neLng } = req.query;
    if (!swLat || !swLng || !neLat || !neLng) {
      return res.status(400).json({ error: 'Bounding box required: swLat, swLng, neLat, neLng' });
    }
    // Qat'iy tip/diapazon tekshiruvi — NaN yoki noto'g'ri koordinata raw geo-so'rovga
    // o'tib ketmasin (avval parseFloat natijasi tekshirilmasdi).
    const sLat = parseFloat(swLat), sLng = parseFloat(swLng);
    const nLat = parseFloat(neLat), nLng = parseFloat(neLng);
    const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
    const validLng = (v) => Number.isFinite(v) && v >= -180 && v <= 180;
    if (!validLat(sLat) || !validLat(nLat) || !validLng(sLng) || !validLng(nLng)) {
      return res.status(400).json({ error: 'Bounding box koordinatalari noto\'g\'ri (lat: -90..90, lng: -180..180)' });
    }
    if (sLat > nLat || sLng > nLng) {
      return res.status(400).json({ error: 'Bounding box noto\'g\'ri: SW burchak NE burchakdan kichik bo\'lishi kerak' });
    }
    const territories = await getTerritoriesInBounds(sLat, sLng, nLat, nLng);
    res.json({ territories });
  } catch (err) {
    next(err);
  }
}

async function getMyTerritories(req, res, next) {
  try {
    const userId = String(req.user.id || req.user._id);
    const territories = await getUserTerritories(userId);
    res.json({ territories });
  } catch (err) {
    next(err);
  }
}

async function removeTerritory(req, res, next) {
  try {
    const userId = String(req.user.id || req.user._id);
    await deleteTerritory(req.params.id, userId);
    res.json({ message: 'Territory removed' });
    req.app.get('io')?.to('global').emit('territory:removed', { territoryId: req.params.id });
  } catch (err) {
    next(err);
  }
}

async function updateTerritoryName(req, res, next) {
  try {
    const { name, emoji, color } = req.body;
    if (typeof name !== 'string') return res.status(400).json({ error: 'name required' });

    const userId = String(req.user.id || req.user._id);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isPremium: true, premiumUntil: true, premiumTier: true }
    });
    
    const ent = entitlements(tierOf(user));
    if (!ent.territoryName) {
      return res.status(403).json({ error: "Hudud nomini qo'yish uchun Pro yoki Ultra kerak", code: 'NAME_LOCKED' });
    }

    const update = { name: name.trim().slice(0, 60) || null };
    if (ent.territoryEmoji) { 
      if (typeof emoji === 'string') update.emoji = emoji.trim().slice(0, 8) || null;
      if (typeof color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(color)) update.color = color;
    }

    const existingTerritory = await prisma.territory.findFirst({
      where: { id: req.params.id, ownerId: userId }
    });
    
    if (!existingTerritory) return res.status(404).json({ error: 'Territory not found or not yours' });

    const territory = await prisma.territory.update({
      where: { id: req.params.id },
      data: update
    });
    
    res.json({ territory: { id: territory.id, name: territory.name, emoji: territory.emoji, color: territory.color } });
  } catch (err) {
    next(err);
  }
}

async function getMyStats(req, res, next) {
  try {
    const userId = String(req.user.id || req.user._id);
    const territories = await prisma.territory.findMany({
      where: { ownerId: userId },
      select: { area: true, capturedAt: true }
    });
    const biggestTerritory = territories.reduce((max, t) => Math.max(max, t.area), 0);
    const activeDays = new Set(territories.map((t) =>
      new Date(t.capturedAt).toISOString().slice(0, 10)
    )).size;
    const u = req.user;
    res.json({
      stats: {
        totalArea: u.totalArea,
        totalDistance: u.totalDistance,
        xp: u.xp,
        level: u.level,
        territoriesCaptured: u.territoriesCaptured,
        territoriesLost: u.territoriesLost,
        currentTerritories: territories.length,
        biggestTerritory,
        activeDays,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function captureFromRest(req, res, next) {
  try {
    const userId = String(req.user.id || req.user._id);

    // Scale rejimida trail Redis'da — REST so'rovi qaysi instance'ga tushishidan
    // qat'i nazar topiladi; bitta instance rejimida xotiradan (avvalgidek).
    let trail = await getUserTrail(userId);

    // Offline egallash: internet uzilganda mobil ilova trailni navbatga saqlab, keyin
    // body'da yuboradi. Server trail yetarsiz bo'lsa va body'da to'g'ri trail bo'lsa —
    // anti-cheat sanity'dan o'tkazib qabul qilamiz (aks holda offline capture hech ishlamasdi).
    if (!Array.isArray(trail) || trail.length < 4) {
      const bodyTrail = sanitizeBodyTrail(req.body && req.body.trail);
      if (bodyTrail) trail = bodyTrail;
    }

    if (!Array.isArray(trail) || trail.length < 4) {
      return res.status(400).json({
        error: 'Yetarli GPS yo\'l yo\'q. Internet ulanishini tekshirib, biroz yurib qaytaring.',
        code: 'NOT_ENOUGH_POINTS',
      });
    }

    // ── Yopilish sharti: oxirgi nuqta boshlang'ich nuqtaga yaqin bo'lishi SHART ──
    // Halqa start'ga qaytib yopilmasa — saqlamaymiz. Avval ochiq trail oxirini boshiga
    // to'g'ri chiziq bilan ulab majburan yopilardi (start'ga qaytmasdan zabt etish).
    const start = trail[0];
    const end = trail[trail.length - 1];
    if (haversineDistance(start[0], start[1], end[0], end[1]) > constants.TERRITORY_CLOSE_DISTANCE_M) {
      return res.status(400).json({
        error: 'Hududni yopish uchun boshlang\'ich nuqtaga qayting',
        code: 'LOOP_NOT_CLOSED',
      });
    }

    const polygon = [...trail, trail[0]];

    const result = await captureTerritory(userId, polygon);

    await resetUserTrail(userId);

    const io = req.app.get('io');
    let username = req.user.username;
    if (io) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, teamId: true }
      });
      username = user?.username || username;

      if (user?.teamId) io.to(`team:${user.teamId}`).emit('team:trailReset', { userId });

      // user:{id} room — socket qaysi instance'da bo'lsa ham yetib boradi
      io.to(`user:${userId}`).emit('territory:captured', {
        ...result,
        message: `Territory captured! +${result.xpGained} XP`,
      });

      io.to('global').emit('territory:new', {
        territory: result.territory,
        capturedBy: {
          userId,
          username,
          level: result.newLevel,
          color: req.user.color,
        },
        xpGained: result.xpGained,
        stolenFrom: result.stolenFrom,
      });

      // Birlashtirilgan o'z eski hududlari — barcha mijozlar kartadan olib tashlasin
      if (Array.isArray(result.mergedFrom) && result.mergedFrom.length) {
        for (const removedId of result.mergedFrom) {
          io.to('global').emit('territory:removed', { territoryId: removedId });
        }
      }

      // Qisman kesilib KICHRAYGAN B zonalar — barcha mijozlar darhol yangi shaklга yangilasin
      if (Array.isArray(result.updatedTerritories) && result.updatedTerritories.length) {
        for (const ut of result.updatedTerritories) {
          io.to('global').emit('territory:updated', { territory: ut });
        }
      }
    }

    res.json({
      territory: result.territory,
      xpGained: result.xpGained,
      newXp: result.newXp,
      newLevel: result.newLevel,
      stolenFrom: result.stolenFrom,
    });

    // Yon effektlar (invasion/qo'shni pushlar, leaderboard, level-up coin/push) —
    // javobni kechiktirmaslik uchun fire-and-forget. Socket yo'li bilan BIR XIL xulq.
    if (io) {
      runPostCaptureEffects({
        io,
        userId,
        username,
        result,
      }).catch((err) => logger.warn('Post-capture effects failed (REST)', { err: err.message }));
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code, requiredLevel: err.requiredLevel, limit: err.limit });
    next(err);
  }
}

async function getTerritoryHistory(req, res, next) {
  try {
    const userId = String(req.user.id || req.user._id);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { isPremium: true, premiumUntil: true, premiumTier: true }
    });
    
    const ent = entitlements(tierOf(user));
    if (!ent.historyDays) {
      return res.status(403).json({ error: 'Hudud tarixi Pro yoki Ultra uchun', code: 'HISTORY_LOCKED' });
    }
    const days = Number.isFinite(ent.historyDays) ? ent.historyDays : null;
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date(0);

    const events = await prisma.gameEvent.findMany({
      where: {
        type: 'territory_captured',
        createdAt: { gte: since },
        OR: [
          { actorId: userId },
          // stolenFrom — massiv; `equals` massiv ichidagi elementni hech qachon topmaydi,
          // shu sabab "yo'qotilgan" yozuvlar tarixda chiqmas edi. JSONB uchun to'g'risi: array_contains.
          { data: { path: ['stolenFrom'], array_contains: [userId] } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        actor: {
          select: { id: true, username: true }
        }
      }
    });

    const history = events.map((e) => {
      const actorId = e.actor?.id || e.actorId;
      const mine = actorId === userId;
      const data = typeof e.data === 'string' ? JSON.parse(e.data) : (e.data || {});
      return {
        id: e.id,
        type: mine ? 'captured' : 'lost',
        area: data.area || 0,
        xpGained: mine ? (data.xpGained || 0) : 0,
        by: mine ? null : (e.actor?.username || '?'),
        at: e.createdAt,
      };
    });
    res.json({ history, days });
  } catch (err) {
    next(err);
  }
}

module.exports = { getTerritories, getMyTerritories, removeTerritory, updateTerritoryName, getMyStats, captureFromRest, getTerritoryHistory };
