// "Hamroh" API — yuruvchi ishonchli do'stini tanlaydi, u jonli kuzatadi.
// Hamma endpoint authenticate ostida. Hamroh FAQAT accepted do'st bo'la oladi.
const { randomUUID } = require('crypto');
const { prisma } = require('../config/database');
const { sendExpoPush } = require('../services/captureEffects');
const guardianService = require('../services/guardianService');
const onlineStore = require('../services/onlineStore');
const logger = require('../utils/logger');

const USER_MIN = { id: true, username: true, color: true, expoPushToken: true };

async function getSession(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM "GuardianSession" WHERE "id" = $1`, id
  );
  return rows[0] || null;
}

function io(req) { return req.app.get('io'); }

// POST /api/guardian/invite { friendId }
// Yuruvchi do'stini hamroh qilib taklif qiladi. Eski pending/active sessiyalari yopiladi.
async function invite(req, res, next) {
  try {
    const me = req.user.id;
    const { friendId } = req.body || {};
    if (!friendId || typeof friendId !== 'string') {
      return res.status(400).json({ error: 'friendId required' });
    }
    if (String(friendId) === String(me)) {
      return res.status(400).json({ error: 'SELF_NOT_ALLOWED' });
    }

    // Faqat accepted do'st hamroh bo'la oladi
    const friendship = await prisma.friendship.findFirst({
      where: {
        status: 'accepted',
        OR: [
          { requesterId: me, addresseeId: friendId },
          { requesterId: friendId, addresseeId: me },
        ],
      },
    });
    if (!friendship) return res.status(403).json({ error: 'NOT_FRIENDS' });

    // Yuruvchining eski ochiq sessiyalarini yopamiz (bitta faol sessiya qoidasi)
    await prisma.$executeRawUnsafe(
      `UPDATE "GuardianSession" SET "status"='ended', "endReason"='replaced', "endedAt"=NOW()
       WHERE "walkerId" = $1 AND "status" IN ('pending','active')`, me
    );
    guardianService.unregister(me);

    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "GuardianSession" ("id","walkerId","guardianId","status") VALUES ($1,$2,$3,'pending')`,
      id, me, friendId
    );

    const [walker, guardian] = await Promise.all([
      prisma.user.findUnique({ where: { id: me }, select: USER_MIN }),
      prisma.user.findUnique({ where: { id: friendId }, select: USER_MIN }),
    ]);

    // Hamrohga xabar: socket (onlayn bo'lsa darhol modal) + push (yopiq bo'lsa ham yetadi)
    io(req)?.to(`user:${friendId}`).emit('guardian:invite', {
      sessionId: id, walker: { id: walker.id, username: walker.username, color: walker.color },
    });
    if (guardian?.expoPushToken) {
      sendExpoPush(guardian.expoPushToken, '🛡 GeoRush Hamroh',
        `${walker.username} sizni hamroh qilib tanladi — yurishini kuzatib turing`).catch(() => {});
    }

    res.json({ session: { id, guardianId: friendId, guardianUsername: guardian?.username, status: 'pending' } });
  } catch (err) { next(err); }
}

// POST /api/guardian/:id/accept — faqat taklif qilingan hamroh
async function accept(req, res, next) {
  try {
    const me = req.user.id;
    const s = await getSession(req.params.id);
    if (!s || String(s.guardianId) !== String(me)) return res.status(404).json({ error: 'NOT_FOUND' });
    if (s.status !== 'pending') return res.status(409).json({ error: 'NOT_PENDING' });

    await prisma.$executeRawUnsafe(
      `UPDATE "GuardianSession" SET "status"='active', "updatedAt"=NOW() WHERE "id" = $1`, s.id
    );
    guardianService.register(s.walkerId, s.id, s.guardianId);

    const guardian = await prisma.user.findUnique({ where: { id: me }, select: USER_MIN });
    io(req)?.to(`user:${s.walkerId}`).emit('guardian:accepted', {
      sessionId: s.id, guardianUsername: guardian?.username,
    });

    // Hamroh darhol boshlang'ich nuqtani ko'rsin (yuruvchi onlayn bo'lsa)
    const pos = onlineStore.getLocal(String(s.walkerId));
    if (pos?.lat != null) {
      io(req)?.to(`user:${me}`).emit('guardian:walkerMoved', {
        sessionId: s.id, lat: pos.lat, lng: pos.lng, at: Date.now(),
      });
    }

    res.json({ ok: true, sessionId: s.id });
  } catch (err) { next(err); }
}

// POST /api/guardian/:id/decline — hamroh rad etadi
async function decline(req, res, next) {
  try {
    const me = req.user.id;
    const s = await getSession(req.params.id);
    if (!s || String(s.guardianId) !== String(me)) return res.status(404).json({ error: 'NOT_FOUND' });
    if (s.status !== 'pending') return res.status(409).json({ error: 'NOT_PENDING' });

    await prisma.$executeRawUnsafe(
      `UPDATE "GuardianSession" SET "status"='ended', "endReason"='declined', "endedAt"=NOW() WHERE "id" = $1`, s.id
    );
    io(req)?.to(`user:${s.walkerId}`).emit('guardian:declined', { sessionId: s.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// POST /api/guardian/:id/end { reason: 'arrived' | 'cancelled' }
// Yuruvchi ham, hamroh ham tugatishi mumkin. 'arrived' faqat yuruvchidan keladi.
async function end(req, res, next) {
  try {
    const me = String(req.user.id);
    const s = await getSession(req.params.id);
    if (!s || (String(s.walkerId) !== me && String(s.guardianId) !== me)) {
      return res.status(404).json({ error: 'NOT_FOUND' });
    }
    if (s.status === 'ended') return res.json({ ok: true });

    const isWalker = String(s.walkerId) === me;
    const reason = isWalker && req.body?.reason === 'arrived' ? 'arrived' : 'cancelled';

    await prisma.$executeRawUnsafe(
      `UPDATE "GuardianSession" SET "status"='ended', "endReason"=$2, "endedAt"=NOW() WHERE "id" = $1`,
      s.id, reason
    );
    guardianService.unregister(s.walkerId);

    const otherId = isWalker ? s.guardianId : s.walkerId;
    io(req)?.to(`user:${otherId}`).emit('guardian:ended', { sessionId: s.id, reason });

    // "Yetib oldi" — hamrohga push (asosiy tinchlantiruvchi xabar)
    if (reason === 'arrived') {
      const [walker, guardian] = await Promise.all([
        prisma.user.findUnique({ where: { id: s.walkerId }, select: USER_MIN }),
        prisma.user.findUnique({ where: { id: s.guardianId }, select: USER_MIN }),
      ]);
      if (guardian?.expoPushToken) {
        sendExpoPush(guardian.expoPushToken, '✅ GeoRush Hamroh',
          `${walker?.username || 'Yuruvchi'} manzilga yetib oldi`).catch(() => {});
      }
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
}

// POST /api/guardian/:id/sos — FAQAT yuruvchi, faol sessiyada. Hamrohga shoshilinch xabar.
async function sos(req, res, next) {
  try {
    const me = String(req.user.id);
    const s = await getSession(req.params.id);
    if (!s || String(s.walkerId) !== me) return res.status(404).json({ error: 'NOT_FOUND' });
    if (s.status !== 'active') return res.status(409).json({ error: 'NOT_ACTIVE' });

    const pos = onlineStore.getLocal(me);
    const [walker, guardian] = await Promise.all([
      prisma.user.findUnique({ where: { id: s.walkerId }, select: USER_MIN }),
      prisma.user.findUnique({ where: { id: s.guardianId }, select: USER_MIN }),
    ]);

    io(req)?.to(`user:${s.guardianId}`).emit('guardian:sos', {
      sessionId: s.id,
      walkerUsername: walker?.username,
      lat: pos?.lat ?? null, lng: pos?.lng ?? null, at: Date.now(),
    });
    if (guardian?.expoPushToken) {
      const where = pos?.lat != null ? ` (${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)})` : '';
      sendExpoPush(guardian.expoPushToken, '🆘 GeoRush SOS!',
        `${walker?.username || 'Yuruvchi'} yordam so'rayapti!${where} Ilovani oching.`).catch(() => {});
    }

    logger.info('Guardian SOS', { sessionId: s.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// GET /api/guardian/active — menga tegishli ochiq sessiyalar (yuruvchi yoki hamroh sifatida)
async function activeSessions(req, res, next) {
  try {
    const me = req.user.id;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT * FROM "GuardianSession"
       WHERE ("walkerId" = $1 OR "guardianId" = $1) AND "status" IN ('pending','active')
       ORDER BY "createdAt" DESC LIMIT 10`, me
    );
    const ids = [...new Set(rows.flatMap((r) => [r.walkerId, r.guardianId]))];
    const users = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true, color: true } })
      : [];
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    res.json({
      sessions: rows.map((r) => ({
        id: r.id, status: r.status, createdAt: r.createdAt,
        role: String(r.walkerId) === String(me) ? 'walker' : 'guardian',
        walker: byId[r.walkerId] || { id: r.walkerId },
        guardian: byId[r.guardianId] || { id: r.guardianId },
      })),
    });
  } catch (err) { next(err); }
}

module.exports = { invite, accept, decline, end, sos, activeSessions };
