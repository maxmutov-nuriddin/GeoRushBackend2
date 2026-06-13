const { prisma } = require('../config/database');
const { Prisma } = require('@prisma/client');
const polygonClipping = require('polygon-clipping');
const { polygonAreaM2, geojsonPolygonAreaM2, largestPolygonOf, differenceGeomJS, estimateOverlapFraction, simplifyPolygon, pointInPolygon, segmentsIntersect } = require('./geoService');
const constants = require('../config/constants');
const { tierOf, entitlements } = require('../config/tiers');
const logger = require('../utils/logger');

// JS fallback (PostGIS yo'q/xato bo'lganda) — polygon-clipping bilan union.
// newGeoPolygon: GeoJSON Polygon. ownTerritories[].polygon: GeoJSON Polygon.
// Faqat natija YAGONA poligon bo'lsa qaytaradi (aks holda null — birlashtirmaymiz).
function unionWithOwnJS(newGeoPolygon, ownTerritories) {
  try {
    const polys = [newGeoPolygon.coordinates, ...ownTerritories.map(t => t.polygon && t.polygon.coordinates)];
    if (polys.some(c => !c || !c[0])) return null;
    const result = polygonClipping.union(...polys); // MultiPolygon: [ [ring,...holes], ... ]
    if (!Array.isArray(result) || result.length !== 1) return null; // ajralgan/nuqta-teggan → birlashmaydi
    const merged = result[0];
    if (!merged || !merged[0]) return null;
    const geoPolygon = { type: 'Polygon', coordinates: merged };
    const ringLatLng = merged[0].map(([lng, lat]) => [lat, lng]); // polygonAreaM2 [lat,lng] kutadi
    return { geoPolygon, area: polygonAreaM2(ringLatLng) };
  } catch (err) {
    logger.warn('Hudud union (JS) — birlashtirilmadi:', (err.message || '').split('\n')[0]);
    return null;
  }
}

// Foydalanuvchining O'ZIGA tegishli, yangi poligon bilan tegib/ustma-ust tushgan
// hududlarini bitta umumiy poligonga birlashtiradi (ichki chegaralar eriydi → bitta kontur).
// Avval PostGIS ST_Union (production), bo'lmasa JS fallback (polygon-clipping).
// Faqat natija YAGONA Polygon bo'lsa qaytaradi (faqat nuqtada teggan → birlashtirmaymiz,
// chunki renderlar coordinates[0] — bitta halqa kutadi). Hech narsa bo'lmasa null.
async function unionWithOwn(newGeoJSONStr, newGeoPolygon, ownTerritories) {
  if (!ownTerritories.length) return null;
  try {
    const ids = ownTerritories.map(t => t.id);
    const rows = await prisma.$queryRaw`
      SELECT ST_AsGeoJSON(u) AS geojson, GeometryType(u) AS gtype, ST_Area(u::geography) AS area
      FROM (
        SELECT ST_Union(geom) AS u FROM (
          SELECT ST_MakeValid(ST_GeomFromGeoJSON(${newGeoJSONStr})) AS geom
          UNION ALL
          SELECT ST_MakeValid(ST_GeomFromGeoJSON(polygon::text)) AS geom
            FROM "Territory" WHERE id IN (${Prisma.join(ids)})
        ) parts
      ) j
    `;
    const row = rows && rows[0];
    if (!row || !row.geojson) return unionWithOwnJS(newGeoPolygon, ownTerritories);
    if (String(row.gtype || '').toUpperCase() !== 'POLYGON') return null;
    const geom = JSON.parse(row.geojson);
    if (!geom || geom.type !== 'Polygon' || !geom.coordinates || !geom.coordinates[0]) return null;
    return { geoPolygon: geom, area: Number(row.area) || 0 };
  } catch (err) {
    // PostGIS yo'q/xato — JS fallback'ga o'tamiz (lokal/test va PostGIS'siz muhitlar uchun)
    return unionWithOwnJS(newGeoPolygon, ownTerritories);
  }
}

// Geometrik AYIRISH: subject (GeoJSON Polygon) − Σ(clipTerritories[].polygon).
// Avval PostGIS ST_Difference (production), bo'lmasa polygon-clipping (JS fallback).
// Natija: { geoPolygon, area } (eng katta bo'lak, teshikli area to'g'ri) yoki null (bo'sh).
// Xato/PostGIS yo'q → JS; JS ham ishlamasa null (chaqiruvchi xavfsiz qaror qabul qiladi).
async function differenceWith(subjectGeoJSONStr, subjectGeoPolygon, clipTerritories) {
  if (!clipTerritories.length) return { geoPolygon: subjectGeoPolygon, area: geojsonPolygonAreaM2(subjectGeoPolygon.coordinates) };
  // JS yo'li (PostGIS yo'q yoki xato bo'lganda yagona ishonchli yo'l)
  const clipCoords = clipTerritories
    .map(t => (typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon))
    .map(g => g && g.coordinates)
    .filter(Boolean);
  const jsDo = () => differenceGeomJS(subjectGeoPolygon.coordinates, clipCoords);
  try {
    const ids = clipTerritories.map(t => t.id);
    const rows = await prisma.$queryRaw`
      SELECT ST_AsGeoJSON(d) AS geojson, GeometryType(d) AS gtype, ST_Area(d::geography) AS area
      FROM (
        SELECT ST_Difference(
          ST_MakeValid(ST_GeomFromGeoJSON(${subjectGeoJSONStr})),
          ST_Union(geom)
        ) AS d
        FROM (
          SELECT ST_MakeValid(ST_GeomFromGeoJSON(polygon::text)) AS geom
            FROM "Territory" WHERE id IN (${Prisma.join(ids)})
        ) clips
      ) j
    `;
    const row = rows && rows[0];
    if (!row || !row.geojson) return jsDo();
    const geom = JSON.parse(row.geojson);
    const gt = String(row.gtype || '').toUpperCase();
    if (gt === 'POLYGON' && geom.coordinates && geom.coordinates[0]) {
      return { geoPolygon: geom, area: Number(row.area) || geojsonPolygonAreaM2(geom.coordinates) };
    }
    if (gt === 'MULTIPOLYGON' && Array.isArray(geom.coordinates)) {
      const largest = largestPolygonOf(geom.coordinates);
      if (!largest) return null;
      return { geoPolygon: { type: 'Polygon', coordinates: largest.coordinates }, area: largest.area };
    }
    return null; // bo'sh (GEOMETRYCOLLECTION EMPTY va h.k.)
  } catch (err) {
    return jsDo();
  }
}

// Ikki IN-MEMORY geometriya farqi: subject − clip (ikkalasi GeoJSON Polygon).
// B (himoyasiz zona) − A (yangi egallangan) hisoblash uchun. PostGIS → JS fallback.
// Natija: { geoPolygon, area } (B ning qolgan eng katta bo'lagi) yoki null (butunlay yo'qoldi).
async function differenceTwoGeoms(subjectGeoPolygon, clipGeoPolygon) {
  const subjStr = JSON.stringify(subjectGeoPolygon);
  const clipStr = JSON.stringify(clipGeoPolygon);
  const jsDo = () => differenceGeomJS(subjectGeoPolygon.coordinates, [clipGeoPolygon.coordinates]);
  try {
    const rows = await prisma.$queryRaw`
      SELECT ST_AsGeoJSON(d) AS geojson, GeometryType(d) AS gtype, ST_Area(d::geography) AS area
      FROM (SELECT ST_Difference(
        ST_MakeValid(ST_GeomFromGeoJSON(${subjStr})),
        ST_MakeValid(ST_GeomFromGeoJSON(${clipStr}))
      ) AS d) j
    `;
    const row = rows && rows[0];
    if (!row || !row.geojson) return jsDo();
    const geom = JSON.parse(row.geojson);
    const gt = String(row.gtype || '').toUpperCase();
    if (gt === 'POLYGON' && geom.coordinates && geom.coordinates[0]) {
      return { geoPolygon: geom, area: Number(row.area) || geojsonPolygonAreaM2(geom.coordinates) };
    }
    if (gt === 'MULTIPOLYGON' && Array.isArray(geom.coordinates)) {
      const largest = largestPolygonOf(geom.coordinates);
      return largest ? { geoPolygon: { type: 'Polygon', coordinates: largest.coordinates }, area: largest.area } : null;
    }
    return null;
  } catch (err) {
    return jsDo();
  }
}

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

  // Hudud limiti (Free 3 / Pro 15 / Ultra ∞) — tekshiruv quyiroqda: o'z hududlari bilan
  // BIRLASHADIGAN egallash hudud sonini OSHIRMAYDI, shuning uchun limitга qarshi emas.
  const myEnt = entitlements(tierOf(user));

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

  // ── Egasi (boshqa) hududlarini shield bo'yicha ajratish: himoyalangan vs olinadigan ──
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

  const protectedList = [];  // himoyalangan (shield) — A maydonidan kesib chiqariladi
  const deletableList = [];  // himoyasiz — A qamragan qismi olinadi (qisman/to'liq)

  for (const old of overlapping) {
    if (old.ownerId === userId) continue;
    const owner = ownerMap.get(old.ownerId);
    // Shield: null=himoya yo'q (free); 5=pro; 0=ultra. Hujumchi owner.level - margin dan past → himoyalangan.
    const margin = owner ? entitlements(tierOf(owner)).shieldMargin : null;
    if (margin != null && user.level < (owner.level - margin)) protectedList.push(old);
    else deletableList.push(old);
  }

  // ── Himoyalangan zonalarni A poligonidan KESIB CHIQARAMIZ (eski throw o'rniga) ──
  // A faqat himoyalangan zonalardan TASHQARI maydonni oladi; B niki buzilmaydi.
  let workingPolygon = geoPolygon;
  let workingStr = geoPolygonStr;
  let workingArea = area;
  if (protectedList.length > 0) {
    const diff = await differenceWith(geoPolygonStr, geoPolygon, protectedList);
    if (!diff || diff.area < constants.TERRITORY_MIN_AREA_M2) {
      // Himoyalangan zonalarni ayirgach yetarli maydon qolmadi — egallab bo'lmaydi
      const err = new Error('Bu hudud himoyalangan zonalar ichida — egallab bo\'lmaydi');
      err.status = 403;
      err.code = 'FULLY_PROTECTED';
      throw err;
    }
    workingPolygon = diff.geoPolygon;
    workingStr = JSON.stringify(diff.geoPolygon);
    workingArea = diff.area;
  }

  // ── O'z hududlari bilan BIRLASHTIRISH (kesilgan poligon ustida) ──
  // Yangi (kesilgan) poligonga tegib tushgan o'z hududlarini bitta umumiy poligonga qo'shamiz.
  const ownMergeCandidates = overlapping.filter(t => t.ownerId === userId);
  const mergeResult = await unionWithOwn(workingStr, workingPolygon, ownMergeCandidates);
  const ownMergeList = mergeResult ? ownMergeCandidates : [];
  const ownAreaSum = ownMergeList.reduce((s, t) => s + (t.area || 0), 0);
  const finalGeoPolygon = mergeResult ? mergeResult.geoPolygon : workingPolygon;
  const finalArea = mergeResult ? (mergeResult.area || workingArea) : workingArea;

  // Hudud limiti — faqat YANGI (birlashmaydigan) hudud qo'shilganda qo'llanadi.
  if (!mergeResult && Number.isFinite(myEnt.territoryLimit)) {
    const ownedCount = await prisma.territory.count({ where: { ownerId: userId } });
    if (ownedCount >= myEnt.territoryLimit) {
      const err = new Error(`Hudud limiti to'ldi (${myEnt.territoryLimit}). Yangisini egallash uchun eskisini o'chiring.`);
      err.status = 403;
      err.code = 'TERRITORY_LIMIT';
      err.limit = myEnt.territoryLimit;
      throw err;
    }
  }

  // ── Transaction ichida atomik zabt etish ───────────────────────────────────
  let territory;
  let stolenFrom = [];
  let invasionNotifications = [];

  const xpMultiplier = myEnt.xpMult; // Free 1× / Pro 2× / Ultra 3×
  // XP — HAQIQATDA egallangan (kesilgan) maydon asosida, adolatli.
  const xpGained = (
    Math.floor((finalArea / 100) * constants.XP_PER_100M2) +
    constants.XP_TERRITORY_CAPTURE_BONUS +
    (deletableList.length > 0 ? constants.XP_INVASION_BONUS : 0)
  ) * xpMultiplier;
  const newXp   = user.xp + xpGained;
  const newLevel = calculateLevel(newXp);

  // ── Himoyasiz zonalar uchun QISMAN kesish rejasi (transactiondan OLDIN hisoblanadi) ──
  // Har B uchun: B − A(finalGeoPolygon). Qolsa → B kichrayadi (update); bo'sh → to'liq delete.
  // differenceTwoGeoms o'z prisma so'rovini ishlatadi — transaction ichida emas, oldin bajaramiz.
  const deletablePlan = [];
  for (const old of deletableList) {
    let remaining = null;
    try { remaining = await differenceTwoGeoms(old.polygon, finalGeoPolygon); } catch (_) {}
    const keep = remaining && remaining.area >= constants.TERRITORY_MIN_AREA_M2 ? remaining : null;
    deletablePlan.push({ old, keep });
  }

  await prisma.$transaction(async (tx) => {
    stolenFrom = [];
    invasionNotifications = [];

    // Yangi territory yaratish (birlashgan bo'lsa — umumiy poligon va maydon bilan)
    territory = await tx.territory.create({
      data: {
        ownerId: userId,
        teamId: user.teamId || null,
        polygon: finalGeoPolygon,
        area: finalArea,
        color: user.color,
        capturedAt: new Date(),
      }
    });

    // Birlashtirilgan O'Z eski hududlarini o'chiramiz (yangi umumiy poligon ularni qamraydi).
    for (const own of ownMergeList) {
      const del = await tx.territory.deleteMany({ where: { id: own.id } });
      if (del.count === 0) continue;
      if (own.teamId) {
        await tx.team.update({
          where: { id: own.teamId },
          data: { totalArea: { decrement: own.area } }
        }).catch(() => {});
      }
    }

    // Himoyasiz zonalar — QISMAN kesish: B qoladigan bo'lsa kichraytiramiz, aks holda to'liq o'chiramiz.
    for (const { old, keep } of deletablePlan) {
      const oldOwner = old.ownerId;
      const fraction = estimateOverlapFraction(polygonPoints, old.polygon);

      if (keep) {
        // B kichrayadi: faqat A qamragan qism yo'qoladi (B − A). To'liq yo'qolmagani uchun
        // territoriesLost OSHMAYDI; totalArea faqat yo'qolgan qism (old.area − keep.area) kamayadi.
        const lost = Math.max(0, old.area - keep.area);
        const upd = await tx.territory.updateMany({
          where: { id: old.id },
          data: { polygon: keep.geoPolygon, area: keep.area },
        });
        if (upd.count === 0) continue; // parallel'da o'chirilgan bo'lsa — o'tkazib yuboramiz
        invasionNotifications.push({ ownerId: oldOwner, capturePercent: Math.round(fraction * 100) });
        stolenFrom.push(oldOwner);
        if (lost > 0) {
          await tx.user.update({ where: { id: oldOwner }, data: { totalArea: { decrement: lost } } }).catch(() => {});
          if (old.teamId) await tx.team.update({ where: { id: old.teamId }, data: { totalArea: { decrement: lost } } }).catch(() => {});
        }
      } else {
        // B butunlay A ichida — to'liq o'chiriladi (avvalgi xulq).
        const del = await tx.territory.deleteMany({ where: { id: old.id } });
        if (del.count === 0) continue;
        invasionNotifications.push({ ownerId: oldOwner, capturePercent: Math.round(fraction * 100) });
        stolenFrom.push(oldOwner);
        await tx.user.update({
          where: { id: oldOwner },
          data: { totalArea: { decrement: old.area }, territoriesLost: { increment: 1 } }
        });
        if (old.teamId) {
          await tx.team.update({ where: { id: old.teamId }, data: { totalArea: { decrement: old.area } } });
        }
      }
    }

    // Foydalanuvchi va jamoa statistikalarini yangilash.
    // Birlashganda: yangi umumiy maydon QO'SHILADI, birlashtirilgan eski o'z hududlar
    // maydoni AYIRILADI (ustma-ust qism ikki marta sanalmasin). Birlashmasa ownAreaSum=0.
    await tx.user.update({
      where: { id: userId },
      data: {
        totalArea: { increment: finalArea - ownAreaSum },
        territoriesCaptured: { increment: 1 },
        xp: { increment: xpGained },
        level: newLevel
      }
    });

    if (user.teamId) {
      // Yangi umumiy maydonni jamoaga qo'shamiz; birlashtirilgan o'z hududlar maydoni
      // yuqorida ularning OWN teamId'sidan ayirilgan (odatda shu jamoa).
      await tx.team.update({
        where: { id: user.teamId },
        data: { totalArea: { increment: finalArea } }
      });
    }

    await tx.gameEvent.create({
      data: {
        type: 'territory_captured',
        actorId: userId,
        territoryId: territory.id,
        data: { area: finalArea, xpGained, stolenFrom, merged: ownMergeList.length }
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
      polygon: finalGeoPolygon,
      area: finalArea,
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
    // Birlashtirilgan (o'chirilgan) o'z hududlar id'lari — mijoz kartadan olib tashlaydi
    mergedFrom: ownMergeList.map(t => t.id),
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
