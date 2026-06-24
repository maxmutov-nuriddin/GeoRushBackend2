// ─────────────────────────────────────────────────────────────────────────────
// Admin BROADCAST — segmentlangan push e'lon yuborish.
// expo-server-sdk + User.expoPushToken allaqachon mavjud (o'yin push'lari uchun).
// Bu YANGI/qo'shimcha: mavjud push oqimiga tegmaydi. adminAuth ortida.
//
// XAVFSIZLIK/EHTIYOT:
//  • Faqat oq ro'yxatdagi segment qabul qilinadi.
//  • title/body majburiy + uzunlik cheklangan.
//  • Faqat HAQIQIY Expo tokenlar (Expo.isExpoPushToken) — yaroqsizlar tashlanadi.
//  • Expo.chunkPushNotifications bilan bo'lib-bo'lib yuboriladi (100/chunk).
//  • dryRun=true → HECH NARSA yuborilmaydi, faqat qabul qiluvchilar soni qaytariladi
//    (admin avval "nechta odamga boradi" ni xavfsiz ko'rishi uchun).
// ─────────────────────────────────────────────────────────────────────────────
const { Expo } = require('expo-server-sdk');
const { prisma } = require('../config/database');
const { logAdminAction } = require('../services/auditLog');
const logger = require('../utils/logger');

const expo = new Expo();
const DAY = 24 * 60 * 60 * 1000;
const SEGMENTS = ['all', 'premium', 'active', 'country', 'single'];

// Segment → Prisma where filtri. Hammasi push token bor + ban bo'lmaganlar bilan cheklanadi.
// Segment → Prisma where filtri. Ban bo'lmaganlar.
function buildWhere(segment, country, targetUser) {
  const base = { isAdmin: false, isBanned: false };
  switch (segment) {
    case 'premium': return { ...base, isPremium: true };
    case 'active':  return { ...base, lastSeen: { gte: new Date(Date.now() - 7 * DAY) } };
    case 'country': return { ...base, country };
    case 'single':  return { ...base, username: targetUser };
    case 'all':
    default:        return base;
  }
}

async function sendBroadcast(req, res, next) {
  try {
    const { segment = 'all', title, body, country, targetUser, dryRun } = req.body;

    if (!SEGMENTS.includes(segment)) {
      return res.status(400).json({ error: `segment noto'g'ri (${SEGMENTS.join(', ')})` });
    }
    if (segment === 'country' && (!country || !String(country).trim())) {
      return res.status(400).json({ error: "segment='country' uchun 'country' majburiy" });
    }
    if (segment === 'single' && (!targetUser || !String(targetUser).trim())) {
      return res.status(400).json({ error: "segment='single' uchun username majburiy" });
    }
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t || !b) return res.status(400).json({ error: 'title va body majburiy' });
    if (t.length > 100 || b.length > 240) {
      return res.status(400).json({ error: 'title ≤100, body ≤240 belgi bo\'lishi kerak' });
    }

    const where = buildWhere(segment, country && String(country).trim(), targetUser && String(targetUser).trim());
    const users = await prisma.user.findMany({ where, select: { id: true, expoPushToken: true } });

    // Faqat HAQIQIY Expo tokenlar
    const tokens = users
      .map((u) => u.expoPushToken)
      .filter((tok) => Expo.isExpoPushToken(tok));

    // dryRun — yubormay, faqat nechta odamga borishini qaytaramiz
    if (dryRun) {
      return res.json({ dryRun: true, segment, recipients: tokens.length, matchedUsers: users.length });
    }

    // In-app Notification larni saqlash
    if (users.length > 0) {
      const notifs = users.map(u => ({ userId: u.id, title: t, body: b }));
      await prisma.notification.createMany({ data: notifs });
    }

    // Haqiqiy yuborish — chunk'larga bo'lib
    const messages = tokens.map((tok) => ({
      to: tok, sound: 'default', title: t, body: b, priority: 'high',
      data: { type: 'admin_broadcast' },
    }));
    const chunks = expo.chunkPushNotifications(messages);
    let sent = 0, failed = 0;
    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        sent += tickets.filter((x) => x.status === 'ok').length;
        failed += tickets.filter((x) => x.status !== 'ok').length;
      } catch (err) {
        failed += chunk.length;
        logger.warn('Broadcast chunk failed', { err: err.message });
      }
    }

    // Audit log (best-effort — javobni hech qachon buzmaydi)
    logAdminAction(req.user?.id, 'admin_broadcast', null, {
      segment, country: country || null, title: t, recipients: tokens.length, sent, failed,
    });

    res.json({ ok: true, segment, recipients: tokens.length, sent, failed });
  } catch (err) { next(err); }
}

module.exports = { sendBroadcast };
