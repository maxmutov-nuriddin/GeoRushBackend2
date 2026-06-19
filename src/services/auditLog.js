// ─────────────────────────────────────────────────────────────────────────────
// Admin AUDIT LOG — kim qaysi admin amalini bajardi (ban/premium/coin/broadcast h.k.).
// Migration KERAK EMAS: mavjud GameEvent modeliga yoziladi (type 'admin_*', actorId=admin,
// targetId=ta'sirlangan user, data=tafsilot). O'qish: type 'admin_' bilan boshlanadiganlar.
//
// BEST-EFFORT: yozish xatosi HECH QACHON asosiy amalni buzmaydi (catch bilan yutiladi).
// Shuning uchun mavjud mutation'larga xavfsiz qo'shsa bo'ladi — logika o'zgarmaydi.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');
const logger = require('../utils/logger');

const AUDIT_PREFIX = 'admin_';

// adminId — amalni bajargan admin; type — 'admin_ban' kabi; targetUserId — ta'sirlangan user (ixtiyoriy)
function logAdminAction(adminId, type, targetUserId = null, data = {}) {
  if (!adminId || !type) return;
  const fullType = type.startsWith(AUDIT_PREFIX) ? type : AUDIT_PREFIX + type;
  // await qilmaymiz — fon'da yoziladi, asosiy javobni kechiktirmaydi/buzmaydi.
  prisma.gameEvent.create({
    data: {
      type: fullType,
      actorId: adminId,
      targetId: targetUserId || null,
      data: data && typeof data === 'object' ? data : {},
    },
  }).catch((err) => logger.warn('Audit log yozilmadi', { type: fullType, err: err.message }));
}

// O'qish — admin audit jurnali (eng yangi birinchi)
async function getAuditLog(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);
    const events = await prisma.gameEvent.findMany({
      where: { type: { startsWith: AUDIT_PREFIX } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        actor:  { select: { username: true, color: true } },
        target: { select: { username: true, color: true } },
      },
    });
    res.json({ events: events.map((e) => ({ ...e, _id: e.id })) });
  } catch (err) { next(err); }
}

module.exports = { logAdminAction, getAuditLog, AUDIT_PREFIX };
