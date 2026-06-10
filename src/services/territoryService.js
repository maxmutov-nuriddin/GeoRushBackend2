const { prisma } = require('../config/database');
const { polygonAreaM2, toGeoJSONPolygon, estimateOverlapFraction, simplifyPolygon, pointInPolygon, segmentsIntersect } = require('./geoService');
const constants = require('../config/constants');
const { tierOf, entitlements } = require('../config/tiers');
const logger = require('../utils/logger');

// Convert [[lat,lng],...] trail points to GeoJSON Polygon coordinates [[[lng,lat],...]]
function trailToGeoJSON(points) {
  const coords = points.map(([lat, lng]) => [lng, lat]);
  // GeoJSON polygons must be closed (first === last)
  if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
    coords.push(coords[0]);
  }
  return coords;
}

function polygonsIntersectJS(poly1, poly2) {
  for (const p of poly1) {
    if (pointInPolygon(p[0], p[1], poly2)) return true;
  }
  for (const p of poly2) {
    if (pointInPolygon(p[0], p[1], poly1)) return true;
  }
  for (let i = 0; i < poly1.length - 1; i++) {
    for (let j = 0; j < poly2.length - 1; j++) {
      if (segmentsIntersect(poly1[i], poly1[i+1], poly2[j], poly2[j+1])) return true;
    }
  }
  return false;
}

// Premium faolligini tekshirish uchun yordamchi
function isActivePremium(u) {
  return !!(u && u.isPremium && u.premiumUntil && new Date() < new Date(u.premiumUntil));
}

async function captureTerritory(userId, rawPoints) {
  // Simplify polygon to reduce point count and avoid self-intersection artifacts
  const polygonPoints = simplifyPolygon(rawPoints, constants.POLYGON_SIMPLIFY_TOLERANCE);
  const area = polygonAreaM2(polygonPoints);

  if (area < constants.TERRITORY_MIN_AREA_M2) {
    throw Object.assign(new Error(`Territory too small (min ${constants.TERRITORY_MIN_AREA_M2} m²)`), { status: 400, code: 'AREA_TOO_SMALL' });
  }
  if (area > constants.TERRITORY_MAX_AREA_M2) {
    throw Object.assign(new Error('Territory too large (max 5 km²)'), { status: 400, code: 'AREA_TOO_LARGE' });
  }
  if (polygonPoints.length < constants.MIN_TRAIL_POINTS_FOR_POLYGON) {
    throw Object.assign(new Error('Not enough points'), { status: 400, code: 'NOT_ENOUGH_POINTS' });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { xp: true, level: true, color: true, teamId: true, isPremium: true, premiumUntil: true, premiumTier: true }
  });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  // ── Hudud limiti (Free 3 / Pro 15 / Ultra ∞) ──────────────────────────────
  const myEnt = entitlements(tierOf(user));
  if (Number.isFinite(myEnt.territoryLimit)) {
    const ownedCount = await prisma.territory.count({ where: { ownerId: userId } });
    if (ownedCount >= myEnt.territoryLimit) {
      const err = new Error(`Hudud limiti to'ldi (${myEnt.territoryLimit}). Yangisini egallash uchun eskisini o'chiring.`);
      err.status = 403;
      err.code = 'TERRITORY_LIMIT';
      err.limit = myEnt.territoryLimit;
      throw err;
    }
  }

  const geoCoords = trailToGeoJSON(polygonPoints);
  const geoPolygon = { type: 'Polygon', coordinates: [geoCoords] };
  const geoPolygonStr = JSON.stringify(geoPolygon);

  // Find all territories that intersect with the new polygon
  let overlapping = [];
  try {
    overlapping = await prisma.$queryRaw`
      SELECT * FROM "Territory"
      WHERE ST_Intersects(
        ST_GeomFromGeoJSON(polygon::text),
        ST_GeomFromGeoJSON(${geoPolygonStr})
      )
    `;
  } catch (err) {
    logger.warn('PostGIS query failed. Falling back to JS intersection.');
    const allT = await prisma.territory.findMany();
    overlapping = allT.filter(t => {
      const tJson = typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon;
      const oldPolyPoints = tJson.coordinates[0].map(([lng, lat]) => [lat, lng]);
      return polygonsIntersectJS(polygonPoints, oldPolyPoints);
    });
  }

  overlapping = overlapping.map(t => ({
    ...t,
    polygon: typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon
  }));

  // Premium egalarini topish uchun batch fetch
  const uniqueOwnerIds = [...new Set(
    overlapping
      .filter(t => t.ownerId !== userId)
      .map(t => t.ownerId)
  )];
  const ownerDocs = uniqueOwnerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: uniqueOwnerIds } },
        select: { id: true, isPremium: true, premiumUntil: true, premiumTier: true, level: true }
      })
    : [];
  const ownerMap = new Map(ownerDocs.map(o => [o.id, o]));

  // ── 1-bosqich: BARCHA hududlarni oldin tekshirish ────────────────────────
  const protectedList = [];
  const deletableList = [];

  for (const old of overlapping) {
    const oldOwner = old.ownerId;
    if (oldOwner === userId) continue;

    const owner = ownerMap.get(oldOwner);
    // Shield: tier marjasi. null=himoya yo'q (free); 5=pro (5 daraja toleransiya); 0=ultra (qat'iy).
    // Hujumchi owner.level - margin dan past bo'lsa — himoyalangan.
    const margin = owner ? entitlements(tierOf(owner)).shieldMargin : null;
    if (margin != null && user.level < (owner.level - margin)) {
      protectedList.push({ territory: old, requiredLevel: owner.level - margin });
    } else {
      deletableList.push(old);
    }
  }

  // ── 2-bosqich: Himoyalangan hudud bo'lsa — HECH NARSA yaratilmasin ───────
  if (protectedList.length > 0) {
    const requiredLevel = Math.max(...protectedList.map(p => p.requiredLevel));
    const err = new Error(`Bu hududni egalash uchun Level ${requiredLevel} bo'lish kerak`);
    err.status = 403;
    err.code   = 'PREMIUM_PROTECTED';
    err.requiredLevel = requiredLevel;
    throw err;
  }

  // ── 3-bosqich: Transaction ichida atomik zabt etish ───────────────────────
  let territory;
  let stolenFrom = [];
  let invasionNotifications = [];

  const xpMultiplier = myEnt.xpMult; // Free 1× / Pro 2× / Ultra 3×
  const xpGained = (
    Math.floor((area / 100) * constants.XP_PER_100M2) +
    constants.XP_TERRITORY_CAPTURE_BONUS +
    (deletableList.length > 0 ? constants.XP_INVASION_BONUS : 0)
  ) * xpMultiplier;
  const newXp   = user.xp + xpGained;
  const newLevel = calculateLevel(newXp);

  await prisma.$transaction(async (tx) => {
    stolenFrom = [];
    invasionNotifications = [];

    // Yangi territory yaratish
    territory = await tx.territory.create({
      data: {
        ownerId: userId,
        teamId: user.teamId || null,
        polygon: geoPolygon,
        area,
        color: user.color,
        capturedAt: new Date(),
      }
    });

    // Eski hududlarni o'chirish va statistikalarni yangilash
    for (const old of deletableList) {
      const oldOwner = old.ownerId;

      // deleteMany — parallel capture xuddi shu hududni allaqachon o'chirgan bo'lsa
      // P2025 bilan butun transaction yiqilmasin; o'chirilmagan bo'lsa stats ham o'zgarmaydi.
      const del = await tx.territory.deleteMany({ where: { id: old.id } });
      if (del.count === 0) continue;

      const fraction = estimateOverlapFraction(polygonPoints, old.polygon);
      invasionNotifications.push({ ownerId: oldOwner, capturePercent: Math.round(fraction * 100) });
      stolenFrom.push(oldOwner);

      await tx.user.update({
        where: { id: old.ownerId },
        data: {
          totalArea: { decrement: old.area },
          territoriesLost: { increment: 1 }
        }
      });
      if (old.teamId) {
        await tx.team.update({
          where: { id: old.teamId },
          data: { totalArea: { decrement: old.area } }
        });
      }
    }

    // Foydalanuvchi va jamoa statistikalarini yangilash
    await tx.user.update({
      where: { id: userId },
      data: {
        totalArea: { increment: area },
        territoriesCaptured: { increment: 1 },
        xp: { increment: xpGained },
        level: newLevel
      }
    });

    if (user.teamId) {
      await tx.team.update({
        where: { id: user.teamId },
        data: { totalArea: { increment: area } }
      });
    }

    await tx.gameEvent.create({
      data: {
        type: 'territory_captured',
        actorId: userId,
        territoryId: territory.id,
        data: { area, xpGained, stolenFrom }
      }
    });
  });

  // Find territories that touch the new one (for neighbor notifications)
  let adjacentTerritories = [];
  try {
    adjacentTerritories = await prisma.$queryRaw`
      SELECT "ownerId" FROM "Territory"
      WHERE id != ${territory.id}
        AND "ownerId" != ${userId}
        AND ST_Intersects(
          ST_GeomFromGeoJSON(polygon::text),
          ST_GeomFromGeoJSON(${geoPolygonStr})
        )
    `;
  } catch (err) {
    const allT = await prisma.territory.findMany({
      where: {
        id: { not: territory.id },
        ownerId: { not: userId }
      },
      select: { ownerId: true, polygon: true }
    });
    adjacentTerritories = allT.filter(t => {
      const tJson = typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon;
      const oldPolyPoints = tJson.coordinates[0].map(([lng, lat]) => [lat, lng]);
      return polygonsIntersectJS(polygonPoints, oldPolyPoints);
    });
  }

  const stolenSet = new Set(stolenFrom);
  const neighborNotifications = [...new Set(
    adjacentTerritories
      .map(t => t.ownerId)
      .filter(oid => !stolenSet.has(oid))
  )];

  return {
    territory: {
      id: territory.id,
      ownerId: userId,
      teamId: user.teamId || null,
      polygon: toGeoJSONPolygon(polygonPoints),
      area,
      color: user.color,
      capturedAt: territory.capturedAt,
    },
    xpGained,
    newXp,
    newLevel,
    stolenFrom,
    invasionNotifications,
    neighborNotifications,
    oldLevel: user.level,
    premiumBonus: xpMultiplier > 1,
  };
}

async function getTerritoriesInBounds(swLat, swLng, neLat, neLng) {
  // Clamp to valid ranges (±180 lng, ±90 lat)
  const cSwLat = Math.max(-90,  Math.min(90,  swLat));
  const cNeLat = Math.max(-90,  Math.min(90,  neLat));
  const cSwLng = Math.max(-180, Math.min(180, swLng));
  const cNeLng = Math.max(-180, Math.min(180, neLng));

  // If the viewport spans the whole world in either axis, skip the spatial filter
  const spansFullWorld = (neLng - swLng) >= 360 || (neLat - swLat) >= 180;
  const validBox = cSwLng < cNeLng && cSwLat < cNeLat;

  let territories = [];

  if (!spansFullWorld && validBox) {
    const bboxPolygon = {
      type: 'Polygon',
      coordinates: [[
        [cSwLng, cSwLat],
        [cNeLng, cSwLat],
        [cNeLng, cNeLat],
        [cSwLng, cNeLat],
        [cSwLng, cSwLat],
      ]],
    };
    const bboxStr = JSON.stringify(bboxPolygon);
    
    try {
      const rawTerritories = await prisma.$queryRaw`
        SELECT t.*, 
               u.username as "ownerUsername", 
               u.level as "ownerLevel", 
               u.color as "ownerColor", 
               u."isPremium" as "ownerIsPremium", 
               u."premiumUntil" as "ownerPremiumUntil"
        FROM "Territory" t
        LEFT JOIN "User" u ON t."ownerId" = u.id
        WHERE ST_Intersects(
          ST_GeomFromGeoJSON(t.polygon::text),
          ST_GeomFromGeoJSON(${bboxStr})
        )
        LIMIT 500
      `;
      territories = rawTerritories;
    } catch (err) {
      const allT = await prisma.territory.findMany({
        include: { owner: { select: { username: true, level: true, color: true, isPremium: true, premiumUntil: true } } }
      });
      const bboxPoints = [
        [cSwLat, cSwLng],
        [cSwLat, cNeLng],
        [cNeLat, cNeLng],
        [cNeLat, cSwLng],
        [cSwLat, cSwLng]
      ];
      const filtered = allT.filter(t => {
        const tJson = typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon;
        const oldPolyPoints = tJson.coordinates[0].map(([lng, lat]) => [lat, lng]);
        return polygonsIntersectJS(oldPolyPoints, bboxPoints);
      });
      territories = filtered.slice(0, 500).map(t => ({
        ...t,
        ownerUsername: t.owner?.username,
        ownerLevel: t.owner?.level,
        ownerColor: t.owner?.color,
        ownerIsPremium: t.owner?.isPremium,
        ownerPremiumUntil: t.owner?.premiumUntil
      }));
    }
  } else {
    try {
      territories = await prisma.$queryRaw`
        SELECT t.*, 
               u.username as "ownerUsername", 
               u.level as "ownerLevel", 
               u.color as "ownerColor", 
               u."isPremium" as "ownerIsPremium", 
               u."premiumUntil" as "ownerPremiumUntil"
        FROM "Territory" t
        LEFT JOIN "User" u ON t."ownerId" = u.id
        LIMIT 500
      `;
    } catch (err) {
      const allT = await prisma.territory.findMany({
        take: 500,
        include: { owner: { select: { username: true, level: true, color: true, isPremium: true, premiumUntil: true } } }
      });
      territories = allT.map(t => ({
        ...t,
        ownerUsername: t.owner?.username,
        ownerLevel: t.owner?.level,
        ownerColor: t.owner?.color,
        ownerIsPremium: t.owner?.isPremium,
        ownerPremiumUntil: t.owner?.premiumUntil
      }));
    }
  }

  const now = new Date();
  return territories.map((t) => ({
    id: t.id,
    ownerId: t.ownerId,
    ownerUsername: t.ownerUsername,
    ownerLevel: t.ownerLevel,
    ownerIsPremium: !!(
      t.ownerIsPremium &&
      t.ownerPremiumUntil &&
      now < new Date(t.ownerPremiumUntil)
    ),
    teamId: t.teamId || null,
    area: t.area,
    color: t.color,
    capturedAt: t.capturedAt,
    geometry: typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon,
  }));
}

async function getUserTerritories(userId) {
  const territories = await prisma.territory.findMany({
    where: { ownerId: userId },
    orderBy: { capturedAt: 'desc' }
  });
  return territories.map(t => ({
    ...t,
    polygon: typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon
  }));
}

async function deleteTerritory(territoryId, userId) {
  const territory = await prisma.territory.findFirst({
    where: { id: territoryId, ownerId: userId }
  });
  if (!territory) throw Object.assign(new Error('Territory not found or not yours'), { status: 404 });

  await prisma.territory.delete({ where: { id: territoryId } });

  await prisma.user.update({
    where: { id: userId },
    data: { totalArea: { decrement: territory.area } }
  });

  // Hudud jamoa nomidan egallangan bo'lsa, jamoa maydoni ham kamayishi shart —
  // aks holda team leaderboard'da o'chirilgan hudud "osilib" qolardi.
  if (territory.teamId) {
    await prisma.team.update({
      where: { id: territory.teamId },
      data: { totalArea: { decrement: territory.area } }
    }).catch(() => {}); // jamoa allaqachon o'chirilgan bo'lishi mumkin
  }

  return { id: territory.id, area: territory.area };
}

function calculateLevel(xp) {
  const thresholds = constants.LEVELS;
  let level = 1;
  for (let i = 0; i < thresholds.length; i++) {
    if (xp >= thresholds[i]) level = i + 1;
    else break;
  }
  return Math.min(level, thresholds.length);
}

module.exports = { captureTerritory, getTerritoriesInBounds, getUserTerritories, deleteTerritory };
