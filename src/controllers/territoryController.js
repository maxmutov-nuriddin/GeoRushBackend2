const { prisma } = require('../config/database');
const { getTerritoriesInBounds, getUserTerritories, deleteTerritory, captureTerritory } = require('../services/territoryService');
const { runPostCaptureEffects } = require('../services/captureEffects');
const { getUserTrail, resetUserTrail } = require('../socket/handlers/locationHandler');
const { detectClosedPolygon } = require('../services/geoService');
const { tierOf, entitlements } = require('../config/tiers');
const logger = require('../utils/logger');

async function getTerritories(req, res, next) {
  try {
    const { swLat, swLng, neLat, neLng } = req.query;
    if (!swLat || !swLng || !neLat || !neLng) {
      return res.status(400).json({ error: 'Bounding box required: swLat, swLng, neLat, neLng' });
    }
    const territories = await getTerritoriesInBounds(
      parseFloat(swLat), parseFloat(swLng),
      parseFloat(neLat), parseFloat(neLng),
    );
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
    const trail = await getUserTrail(userId);
    if (!Array.isArray(trail) || trail.length < 4) {
      return res.status(400).json({
        error: 'Yetarli GPS yo\'l yo\'q. Internet ulanishini tekshirib, biroz yurib qaytaring.',
        code: 'NOT_ENOUGH_POINTS',
      });
    }

    let polygon = detectClosedPolygon(trail);
    if (!polygon) polygon = [...trail, trail[0]];

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
