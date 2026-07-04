// "Oila Doirasi" (Family Circle) API — doimiy oilaviy xavfsizlik.
// Hammasi authenticate ostida. Rollar: "parent" (zona boshqaradi, a'zo chiqaradi) va
// "child" (faqat ko'radi, o'zi chiqib ketishi mumkin). Doira egasi doim "parent".
// MAXFIYLIK: xom GPS saqlanmaydi — faqat zona kirish/chiqish voqealari (familyCircleService).
const { randomUUID } = require('crypto');
const { prisma } = require('../config/database');
const familyCircleService = require('../services/familyCircleService');
const logger = require('../utils/logger');

const USER_MIN = { id: true, username: true, color: true, activeSkinNick: true };
const MAX_ZONES = 12;             // bir doirada zonalar chegarasi (suiiste'mol himoyasi)
const MAX_MEMBERS = 12;

function io(req) { return req.app.get('io'); }

// 6 belgili taklif kodi (chalkashadigan belgilarsiz: 0/O, 1/I yo'q).
function genCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

async function getCircle(id) {
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "FamilyCircle" WHERE "id" = $1`, id);
  return rows[0] || null;
}

// Mening a'zoligim (rol bilan) — yo'q bo'lsa null.
async function getMembership(circleId, userId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "FamilyCircleMember" WHERE "circleId" = $1 AND "userId" = $2`, circleId, String(userId)
  );
  return rows[0] || null;
}

// Foydalanuvchi qaysidir doirada a'zomi? (BITTA doira qoidasi) — birinchi topilganini qaytaradi.
async function getAnyMembership(userId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "circleId" FROM "FamilyCircleMember" WHERE "userId" = $1 LIMIT 1`, String(userId)
  );
  return rows[0] || null;
}

// Doira to'liq holati (a'zolar + zonalar + mening rolim) — bitta payload.
async function circlePayload(circleId, meId) {
  const [circle, memberRows, zoneRows] = await Promise.all([
    getCircle(circleId),
    prisma.$queryRawUnsafe(`SELECT "userId","role","createdAt" FROM "FamilyCircleMember" WHERE "circleId" = $1`, circleId),
    prisma.$queryRawUnsafe(`SELECT "id","label","lat","lng","radiusM","createdById" FROM "FamilyZone" WHERE "circleId" = $1 ORDER BY "createdAt" ASC`, circleId),
  ]);
  if (!circle) return null;
  const ids = memberRows.map((m) => String(m.userId));
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: USER_MIN })
    : [];
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const myRole = memberRows.find((m) => String(m.userId) === String(meId))?.role || null;
  return {
    id: circle.id,
    name: circle.name,
    ownerId: circle.ownerId,
    inviteCode: circle.inviteCode,
    myRole,
    members: memberRows.map((m) => ({
      id: String(m.userId),
      role: m.role,
      username: byId[m.userId]?.username || null,
      color: byId[m.userId]?.color || null,
      nickStyle: byId[m.userId]?.activeSkinNick || null,
    })),
    zones: zoneRows.map((z) => ({
      id: z.id, label: z.label, lat: z.lat, lng: z.lng, radiusM: z.radiusM, createdById: z.createdById,
    })),
  };
}

// POST /api/family/create { name, role? } — doira yaratish (yaratuvchi parent bo'ladi).
async function create(req, res, next) {
  try {
    const me = String(req.user.id);
    const name = String(req.body?.name || '').trim().slice(0, 40) || 'Oilam';

    // BITTA doira qoidasi: allaqachon biror doirada bo'lsa yangi doira yaratolmaydi.
    if (await getAnyMembership(me)) return res.status(409).json({ error: 'ALREADY_IN_CIRCLE' });

    // Yagona taklif kodi (kamdan-kam to'qnashuv — bir necha urinish yetarli).
    let code = genCode();
    for (let i = 0; i < 5; i++) {
      const exists = await prisma.$queryRawUnsafe(`SELECT 1 FROM "FamilyCircle" WHERE "inviteCode" = $1`, code);
      if (!exists.length) break;
      code = genCode();
    }

    const circleId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "FamilyCircle" ("id","name","ownerId","inviteCode") VALUES ($1,$2,$3,$4)`,
      circleId, name, me, code
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "FamilyCircleMember" ("id","circleId","userId","role") VALUES ($1,$2,$3,'parent')`,
      randomUUID(), circleId, me
    );
    await familyCircleService.reloadCircle(circleId);

    res.json({ circle: await circlePayload(circleId, me) });
  } catch (err) { next(err); }
}

// POST /api/family/join { code, role? } — taklif kodi bilan qo'shilish.
async function join(req, res, next) {
  try {
    const me = String(req.user.id);
    const code = String(req.body?.code || '').trim().toUpperCase();
    const role = req.body?.role === 'parent' ? 'parent' : 'child';
    if (!code) return res.status(400).json({ error: 'CODE_REQUIRED' });

    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "FamilyCircle" WHERE "inviteCode" = $1`, code);
    const circle = rows[0];
    if (!circle) return res.status(404).json({ error: 'CIRCLE_NOT_FOUND' });

    const existing = await getMembership(circle.id, me);
    if (existing) return res.json({ circle: await circlePayload(circle.id, me) }); // allaqachon a'zo

    // BITTA doira qoidasi: boshqa doirada a'zo bo'lsa — qo'shila olmaydi.
    if (await getAnyMembership(me)) return res.status(409).json({ error: 'ALREADY_IN_CIRCLE' });

    const count = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "FamilyCircleMember" WHERE "circleId" = $1`, circle.id
    );
    if ((count[0]?.n || 0) >= MAX_MEMBERS) return res.status(409).json({ error: 'CIRCLE_FULL' });

    await prisma.$executeRawUnsafe(
      `INSERT INTO "FamilyCircleMember" ("id","circleId","userId","role") VALUES ($1,$2,$3,$4)`,
      randomUUID(), circle.id, me, role
    );
    await familyCircleService.reloadCircle(circle.id);

    // Boshqa a'zolarga xabar — yangi a'zo qo'shildi (user roomlar orqali).
    const meUser = await prisma.user.findUnique({ where: { id: me }, select: USER_MIN });
    const others = await prisma.$queryRawUnsafe(
      `SELECT "userId" FROM "FamilyCircleMember" WHERE "circleId" = $1 AND "userId" != $2`, circle.id, me
    );
    for (const o of others) {
      io(req)?.to(`user:${o.userId}`).emit('family:memberJoined', {
        circleId: circle.id, member: { id: me, username: meUser?.username, role },
      });
    }

    res.json({ circle: await circlePayload(circle.id, me) });
  } catch (err) { next(err); }
}

// GET /api/family/mine — men a'zo bo'lgan barcha doiralar (to'liq holat bilan).
async function mine(req, res, next) {
  try {
    const me = String(req.user.id);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "circleId" FROM "FamilyCircleMember" WHERE "userId" = $1 ORDER BY "createdAt" ASC`, me
    );
    const circles = [];
    for (const r of rows) {
      const p = await circlePayload(r.circleId, me);
      if (p) circles.push(p);
    }
    res.json({ circles });
  } catch (err) { next(err); }
}

// POST /api/family/:id/zones { label, lat, lng, radiusM } — FAQAT parent.
async function addZone(req, res, next) {
  try {
    const me = String(req.user.id);
    const circleId = req.params.id;
    const membership = await getMembership(circleId, me);
    if (!membership) return res.status(404).json({ error: 'NOT_FOUND' });
    if (membership.role !== 'parent') return res.status(403).json({ error: 'PARENT_ONLY' });

    const label = String(req.body?.label || '').trim().slice(0, 30);
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    let radiusM = parseInt(req.body?.radiusM, 10);
    if (!label) return res.status(400).json({ error: 'LABEL_REQUIRED' });
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'BAD_COORDS' });
    }
    if (!Number.isFinite(radiusM)) radiusM = 120;
    radiusM = Math.max(50, Math.min(500, radiusM)); // 50..500m

    const count = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "FamilyZone" WHERE "circleId" = $1`, circleId
    );
    if ((count[0]?.n || 0) >= MAX_ZONES) return res.status(409).json({ error: 'TOO_MANY_ZONES' });

    const zoneId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "FamilyZone" ("id","circleId","label","lat","lng","radiusM","createdById")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      zoneId, circleId, label, lat, lng, radiusM, me
    );
    await familyCircleService.reloadCircle(circleId);

    await broadcastCircle(req, circleId, 'family:circleUpdated');
    res.json({ zone: { id: zoneId, label, lat, lng, radiusM, createdById: me } });
  } catch (err) { next(err); }
}

// DELETE /api/family/:id/zones/:zoneId — FAQAT parent.
async function removeZone(req, res, next) {
  try {
    const me = String(req.user.id);
    const circleId = req.params.id;
    const membership = await getMembership(circleId, me);
    if (!membership) return res.status(404).json({ error: 'NOT_FOUND' });
    if (membership.role !== 'parent') return res.status(403).json({ error: 'PARENT_ONLY' });

    await prisma.$executeRawUnsafe(
      `DELETE FROM "FamilyZone" WHERE "id" = $1 AND "circleId" = $2`, req.params.zoneId, circleId
    );
    await familyCircleService.reloadCircle(circleId);

    await broadcastCircle(req, circleId, 'family:circleUpdated');
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// GET /api/family/:id/events?limit= — oxirgi kirish/chiqish voqealari (faqat a'zolar).
async function events(req, res, next) {
  try {
    const me = String(req.user.id);
    const circleId = req.params.id;
    const membership = await getMembership(circleId, me);
    if (!membership) return res.status(404).json({ error: 'NOT_FOUND' });

    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "id","zoneId","userId","zoneLabel","kind","at"
       FROM "FamilyZoneEvent" WHERE "circleId" = $1 ORDER BY "at" DESC LIMIT $2`, circleId, limit
    );
    const ids = [...new Set(rows.map((r) => String(r.userId)))];
    const users = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } })
      : [];
    const byId = Object.fromEntries(users.map((u) => [u.id, u.username]));
    res.json({
      events: rows.map((r) => ({
        id: r.id, zoneId: r.zoneId, zoneLabel: r.zoneLabel, kind: r.kind, at: r.at,
        userId: String(r.userId), username: byId[r.userId] || null,
      })),
    });
  } catch (err) { next(err); }
}

// POST /api/family/:id/leave — o'zi chiqib ketadi. Ega chiqsa — doira o'chadi.
async function leave(req, res, next) {
  try {
    const me = String(req.user.id);
    const circleId = req.params.id;
    const membership = await getMembership(circleId, me);
    if (!membership) return res.status(404).json({ error: 'NOT_FOUND' });
    const circle = await getCircle(circleId);

    // Ega chiqib ketsa — butun doira o'chadi (CASCADE zona/a'zo/voqealarni tozalaydi).
    if (circle && String(circle.ownerId) === me) {
      await broadcastCircle(req, circleId, 'family:circleDeleted');
      await prisma.$executeRawUnsafe(`DELETE FROM "FamilyCircle" WHERE "id" = $1`, circleId);
      familyCircleService.removeCircle(circleId);
      return res.json({ ok: true, deleted: true });
    }

    await prisma.$executeRawUnsafe(
      `DELETE FROM "FamilyCircleMember" WHERE "circleId" = $1 AND "userId" = $2`, circleId, me
    );
    await familyCircleService.reloadCircle(circleId);

    // Boshqalarga: a'zo chiqdi (ijtimoiy nazorat — chiqish sezilmay qolmaydi).
    const meUser = await prisma.user.findUnique({ where: { id: me }, select: USER_MIN });
    const others = await prisma.$queryRawUnsafe(
      `SELECT "userId" FROM "FamilyCircleMember" WHERE "circleId" = $1`, circleId
    );
    for (const o of others) {
      io(req)?.to(`user:${o.userId}`).emit('family:memberLeft', {
        circleId, userId: me, username: meUser?.username,
      });
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// Parent boshqa a'zoni chiqaradi. POST /api/family/:id/remove { userId }
async function removeMember(req, res, next) {
  try {
    const me = String(req.user.id);
    const circleId = req.params.id;
    const target = String(req.body?.userId || '');
    const membership = await getMembership(circleId, me);
    if (!membership) return res.status(404).json({ error: 'NOT_FOUND' });
    if (membership.role !== 'parent') return res.status(403).json({ error: 'PARENT_ONLY' });
    if (!target || target === me) return res.status(400).json({ error: 'BAD_TARGET' });

    const circle = await getCircle(circleId);
    if (circle && String(circle.ownerId) === target) return res.status(403).json({ error: 'CANNOT_REMOVE_OWNER' });

    await prisma.$executeRawUnsafe(
      `DELETE FROM "FamilyCircleMember" WHERE "circleId" = $1 AND "userId" = $2`, circleId, target
    );
    await familyCircleService.reloadCircle(circleId);

    io(req)?.to(`user:${target}`).emit('family:removed', { circleId });
    await broadcastCircle(req, circleId, 'family:circleUpdated');
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// Doira a'zolariga voqea yuborish (user roomlar orqali). Faqat signal — client qayta yuklaydi.
async function broadcastCircle(req, circleId, event) {
  try {
    const members = await prisma.$queryRawUnsafe(
      `SELECT "userId" FROM "FamilyCircleMember" WHERE "circleId" = $1`, circleId
    );
    for (const m of members) {
      io(req)?.to(`user:${m.userId}`).emit(event, { circleId });
    }
  } catch (err) { logger.warn('FamilyCircle broadcast skip:', err.message.split('\n')[0]); }
}

module.exports = { create, join, mine, addZone, removeZone, events, leave, removeMember };
