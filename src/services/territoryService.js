const { prisma } = require('../config/database');
const { Prisma } = require('@prisma/client');
const polygonClipping = require('polygon-clipping');
const { polygonAreaM2, geojsonPolygonAreaM2, largestPolygonOf, differenceGeomJS, estimateOverlapFraction, simplifyPolygon, pointInPolygon, segmentsIntersect } = require('./geoService');
const { bufferToMulti, closeMerge, TOLERANCE_M, HALF_KM } = require('./territoryMergeBackfill');
const constants = require('../config/constants');
const { tierOf, entitlements } = require('../config/tiers');
const logger = require('../utils/logger');

// JS fallback (PostGIS yo'q/xato bo'lganda) — TOLERANTLIK bilan union (backfill bilan izchil).
// Morfologik "close" (~TOLERANCE_M) GPS bo'shliqlarini ko'priklaydi. newGeoPolygon: GeoJSON Polygon.
// Faqat natija YAGONA poligon bo'lsa qaytaradi (aks holda null — birlashtirmaymiz).
function unionWithOwnJS(newGeoPolygon, ownTerritories) {
  try {
    const polys = [newGeoPolygon.coordinates, ...ownTerritories.map(t => t.polygon && t.polygon.coordinates)];
    if (polys.some(c => !c || !c[0])) return null;
    const bufs = polys.map(c => bufferToMulti(c, HALF_KM)); // ~HALF kengaytirilgan (tolerantlik)
    const merged = closeMerge(polys, bufs); // close → bitta Polygon coords yoki null
    if (!merged || !merged[0]) return null;
    const geoPolygon = { type: 'Polygon', coordinates: merged };
    return { geoPolygon, area: geojsonPolygonAreaM2(merged) };
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
    // Strict union MultiPolygon bersa (orada bo'shliq) → JS tolerantlik-close bilan ko'priklaymiz.
    if (String(row.gtype || '').toUpperCase() !== 'POLYGON') return unionWithOwnJS(newGeoPolygon, ownTerritories);
    const geom = JSON.parse(row.geojson);
    if (!geom || geom.type !== 'Polygon' || !geom.coordinates || !geom.coordinates[0]) return unionWithOwnJS(newGeoPolygon, ownTerritories);
    return { geoPolygon: geom, area: Number(row.area) || 0 };
  } catch (err) {
    // PostGIS yo'q/xato — JS fallback'ga o'tamiz (lokal/test va PostGIS'siz muhitlar uchun)
    return unionWithOwnJS(newGeoPolygon, ownTerritories);
  }
}

// O'z hududlaridan yangi poligonga ~TOLERANCE_M masofadagi (lekin strict ro'yxatda
// bo'lmagan)larni topadi — capture-time merge backfill bilan izchil bo'lishi uchun.
// PostGIS ST_DWithin (production); xato/yo'q bo'lsa [] (lokalda strict yetarli).
async function findNearbyOwn(userId, geoJSONStr, excludeIds) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT * FROM "Territory"
      WHERE "ownerId" = ${userId}
        AND ST_DWithin(
          ST_GeomFromGeoJSON(polygon::text)::geography,
          ST_GeomFromGeoJSON(${geoJSONStr})::geography,
          ${TOLERANCE_M}
        )
    `;
    return rows
      .filter(t => !excludeIds.has(t.id))
      .map(t => ({ ...t, polygon: typeof t.polygon === 'string' ? JSON.parse(t.polygon) : t.polygon }));
  } catch (_) {
    return [];
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
    // Xabar chegaraга moslab dinamik — constants o'zgarsa o'zi yangilanadi (qattiq "5 km²" emas).
    throw Object.assign(new Error(`Territory too large (max ${constants.TERRITORY_MAX_AREA_M2 / 1_000_000} km²)`), { status: 400, code: 'AREA_TOO_LARGE' });
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
  const strictOwn = overlapping.filter(t => t.ownerId === userId);
  // Tolerantlik: ~TOLERANCE_M masofadagi o'z zonalarini ham qo'shamiz (backfill bilan izchil).
  const strictIds = new Set(strictOwn.map(t => t.id));
  const nearbyOwn = await findNearbyOwn(userId, workingStr, strictIds);
  const ownMergeCandidates = [...strictOwn, ...nearbyOwn];
  const mergeResult = ownMergeCandidates.length
    ? await unionWithOwn(workingStr, workingPolygon, ownMergeCandidates)
    : null;
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
  let updatedTerritories = []; // qisman kesilib KICHRAYGAN (o'chmagan) B zonalar — mijoz darhol yangilaydi

  // ── Himoyasiz zonalar uchun QISMAN kesish rejasi (transactiondan OLDIN hisoblanadi) ──
  // Har B uchun: B − A(finalGeoPolygon). Uch holat:
  //   'none'    — A B dan deyarli hech narsa olmadi (faqat chetidan tegib o'tdi) → B ga TEGMAYMIZ
  //   'partial' — B kichrayadi (qolgan qism ≥ MIN_AREA va yo'qotish sezilarli)
  //   'full'    — B butunlay (yoki ip-ingichka qoldiq) A ga o'tadi → o'chiriladi
  // differenceTwoGeoms o'z prisma so'rovini ishlatadi — transaction ichida emas, oldin bajaramiz.
  const STEAL_EPSILON_M2 = 1; // bundan kam yo'qotish = chegaraga tegib o'tish, bosqin emas
  const deletablePlan = [];
  for (const old of deletableList) {
    let remaining = null;
    try { remaining = await differenceTwoGeoms(old.polygon, finalGeoPolygon); } catch (_) {}
    const remArea = remaining ? remaining.area : 0;
    const lost = Math.max(0, (old.area || 0) - remArea);
    if (remaining && remArea >= constants.TERRITORY_MIN_AREA_M2) {
      if (lost < STEAL_EPSILON_M2) deletablePlan.push({ old, mode: 'none' });
      else deletablePlan.push({ old, mode: 'partial', keep: remaining, lost });
    } else {
      deletablePlan.push({ old, mode: 'full', lost: old.area || 0 });
    }
  }
  // Haqiqatan kimdandir yer olindi (bosqin) — faqat shunda invasion XP/bildirishnoma.
  const anyRealSteal = deletablePlan.some(p => p.mode !== 'none');

  const xpMultiplier = myEnt.xpMult; // Free 1× / Pro 2× / Ultra 3×
  // XP — HAQIQATDA egallangan (kesilgan) maydon asosida; bosqin bonusi faqat real yer olinsa.
  const xpGained = (
    Math.floor((finalArea / 100) * constants.XP_PER_100M2) +
    constants.XP_TERRITORY_CAPTURE_BONUS +
    (anyRealSteal ? constants.XP_INVASION_BONUS : 0)
  ) * xpMultiplier;
  // let — parallel capture race'da tranzaksiya ichida ATOMIK qiymatga to'g'rilanadi (pastda).
  let newXp   = user.xp + xpGained;
  let newLevel = calculateLevel(newXp);

  await prisma.$transaction(async (tx) => {
    stolenFrom = [];
    invasionNotifications = [];
    updatedTerritories = [];

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

    // Himoyasiz zonalar — kesish rejasiga ko'ra: none/partial/full.
    for (const plan of deletablePlan) {
      const { old, mode } = plan;
      const oldOwner = old.ownerId;

      if (mode === 'none') continue; // faqat chetidan tegib o'tildi — B ga tegmaymiz, bosqin emas

      const fraction = estimateOverlapFraction(polygonPoints, old.polygon);

      if (mode === 'partial') {
        // B kichrayadi: faqat A qamragan qism yo'qoladi. territoriesLost OSHMAYDI.
        const upd = await tx.territory.updateMany({
          where: { id: old.id },
          data: { polygon: plan.keep.geoPolygon, area: plan.keep.area },
        });
        if (upd.count === 0) continue; // parallel'da o'chirilgan — o'tkazib yuboramiz
        invasionNotifications.push({ ownerId: oldOwner, capturePercent: Math.round(fraction * 100) });
        stolenFrom.push(oldOwner);
        updatedTerritories.push({ id: old.id, ownerId: oldOwner, teamId: old.teamId || null, polygon: plan.keep.geoPolygon, area: plan.keep.area, color: old.color });
        await tx.user.update({ where: { id: oldOwner }, data: { totalArea: { decrement: plan.lost } } }).catch(() => {});
        if (old.teamId) await tx.team.update({ where: { id: old.teamId }, data: { totalArea: { decrement: plan.lost } } }).catch(() => {});
      } else {
        // 'full' — B butunlay (yoki ip-ingichka qoldiq) A ga o'tadi → o'chiriladi.
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
    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: {
        totalArea: { increment: finalArea - ownAreaSum },
        // O'z zonasini kengaytirish (merge) "yangi hudud" sanalmasin — faqat haqiqatan yangi.
        territoriesCaptured: { increment: ownMergeList.length > 0 ? 0 : 1 },
        xp: { increment: xpGained },
        level: newLevel
      },
      select: { xp: true }
    });

    // Parallel capture race himoyasi: `xp` atomik increment bo'ladi, lekin `level` yuqorida
    // tranzaksiyadan TASHQARI o'qilgan user.xp asosida hisoblangan — ikki parallel capture'da
    // stale qolishi mumkin edi. UPDATE ... RETURNING (updatedUser.xp) row-lock sabab seriyalanadi,
    // shuning uchun u HAR DOIM atomik haqiqiy xp'ni beradi. Ketma-ket (normal) capture'da
    // updatedUser.xp === newXp → bu blok NO-OP, eski xulq aynan saqlanadi.
    if (updatedUser.xp !== newXp) {
      newXp = updatedUser.xp;
      const correctLevel = calculateLevel(newXp);
      if (correctLevel !== newLevel) {
        newLevel = correctLevel;
        await tx.user.update({ where: { id: userId }, data: { level: correctLevel } });
      }
    }

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

    // ── Manfiy maydon himoyasi (#A) ──────────────────────────────────────────
    // Area hisoblash usullari (PostGIS geography ↔ JS) orasidagi drift sabab totalArea
    // 0 dan past tushishi mumkin → reyting buziladi. Faqat TEGILGAN satrlarni (id bo'yicha,
    // indeksli) 0 ga clamp qilamiz — to'g'ri qiymatlarga tegmaydi (xulq o'zgarmaydi).
    const touchedUserIds = new Set([userId, ...deletablePlan.filter(p => p.mode !== 'none').map(p => p.old.ownerId)]);
    const touchedTeamIds = new Set();
    if (user.teamId) touchedTeamIds.add(user.teamId);
    for (const own of ownMergeList) if (own.teamId) touchedTeamIds.add(own.teamId);
    for (const p of deletablePlan) if (p.mode !== 'none' && p.old.teamId) touchedTeamIds.add(p.old.teamId);
    for (const uid of touchedUserIds) {
      await tx.$executeRawUnsafe('UPDATE "User" SET "totalArea" = 0 WHERE id = $1 AND "totalArea" < 0', uid).catch(() => {});
    }
    for (const tid of touchedTeamIds) {
      await tx.$executeRawUnsafe('UPDATE "Team" SET "totalArea" = 0 WHERE id = $1 AND "totalArea" < 0', tid).catch(() => {});
    }
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

  // #B — bir egaga DUBLIKAT bildirishnoma bo'lmasin: stolenFrom va invasionNotifications'ni
  // egasi bo'yicha yagonalashtiramiz (bir egada bir nechta zona bo'lsa — bitta xabar, eng katta %).
  stolenFrom = [...new Set(stolenFrom)];
  {
    const byOwner = new Map();
    for (const n of invasionNotifications) {
      const prev = byOwner.get(n.ownerId);
      if (!prev || (n.capturePercent || 0) > (prev.capturePercent || 0)) byOwner.set(n.ownerId, n);
    }
    invasionNotifications = [...byOwner.values()];
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
    // Qisman kesilib kichraygan (o'chmagan) B zonalar — mijoz darhol yangilashi uchun
    updatedTerritories,
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
