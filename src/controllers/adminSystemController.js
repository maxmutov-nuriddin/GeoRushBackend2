// ─────────────────────────────────────────────────────────────────────────────
// Admin SYSTEM STATUS — server holati va bazaviy statistikalar.
// Read-only endpoint, adminAuth ortida.
// ─────────────────────────────────────────────────────────────────────────────
const { prisma } = require('../config/database');

const DAY = 24 * 60 * 60 * 1000;

async function getSystemAnalytics(req, res, next) {
  try {
    const now = Date.now();
    const since24h = new Date(now - DAY);

    // ── Baza statistikalari (parallel) ──
    const [
      totalUsers, totalTerritories, totalTeams, totalEvents, totalWarnings,
      totalAntiCheat, totalPromoCodes, totalPurchases, totalSupportChats,
      totalSupportMessages, totalReferrals, totalFriendships, totalRefreshTokens,
      onlineUsers, newUsers24h, newEvents24h,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.territory.count(),
      prisma.team.count(),
      prisma.gameEvent.count(),
      prisma.warning.count(),
      prisma.antiCheatLog.count(),
      prisma.promoCode.count(),
      prisma.premiumPurchase.count(),
      prisma.supportChat.count(),
      prisma.supportMessage.count(),
      prisma.referral.count(),
      prisma.friendship.count(),
      prisma.refreshToken.count(),
      prisma.user.count({ where: { isOnline: true } }),
      prisma.user.count({ where: { createdAt: { gte: since24h } } }),
      prisma.gameEvent.count({ where: { createdAt: { gte: since24h } } }),
    ]);

    // ── Server holati ──
    const uptimeSec = process.uptime();
    const mem = process.memoryUsage();

    // ── Umumiy yozuvlar soni (storage estimate) ──
    const totalRecords = totalUsers + totalTerritories + totalTeams + totalEvents +
      totalWarnings + totalAntiCheat + totalPromoCodes + totalPurchases +
      totalSupportChats + totalSupportMessages + totalReferrals +
      totalFriendships + totalRefreshTokens;

    res.json({
      server: {
        uptimeSec: Math.floor(uptimeSec),
        uptimeFormatted: formatUptime(uptimeSec),
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
      },
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        rssMB: Math.round(mem.rss / 1024 / 1024),
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      },
      database: {
        totalUsers,
        totalTerritories,
        totalTeams,
        totalEvents,
        totalWarnings,
        totalAntiCheat,
        totalPromoCodes,
        totalPurchases,
        totalSupportChats,
        totalSupportMessages,
        totalReferrals,
        totalFriendships,
        totalRefreshTokens,
      },
      activity: {
        onlineUsers,
        newUsers24h,
        newEvents24h,
      },
      storage: {
        totalRecords,
      },
    });
  } catch (err) { next(err); }
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

module.exports = { getSystemAnalytics };
