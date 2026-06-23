const { prisma } = require('../config/database');

exports.getNotificationsAnalytics = async (req, res) => {
  try {
    const totalUsers = await prisma.user.count();

    // 1. Push token coverage
    const usersWithToken = await prisma.user.count({
      where: { expoPushToken: { not: null } }
    });
    const usersWithoutToken = totalUsers - usersWithToken;
    const tokenCoverage = totalUsers > 0 ? Math.round((usersWithToken / totalUsers) * 100) : 0;

    // 2. Active tokens (lastSeen in 7 days AND has token)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const activeTokens = await prisma.user.count({
      where: {
        expoPushToken: { not: null },
        lastSeen: { gte: sevenDaysAgo }
      }
    });

    const staleTokens = await prisma.user.count({
      where: {
        expoPushToken: { not: null },
        lastSeen: { lt: thirtyDaysAgo }
      }
    });

    // 3. Platform distribution (estimate from token format)
    const tokensRaw = await prisma.user.findMany({
      where: { expoPushToken: { not: null } },
      select: { expoPushToken: true }
    });

    let iosCount = 0;
    let androidCount = 0;
    let otherCount = 0;
    tokensRaw.forEach(u => {
      const token = u.expoPushToken || '';
      if (token.startsWith('ExponentPushToken')) {
        otherCount++;
      } else if (token.includes('apns') || token.length === 64) {
        iosCount++;
      } else {
        androidCount++;
      }
    });

    // 4. Notification readiness per segment
    const premiumWithToken = await prisma.user.count({
      where: { isPremium: true, expoPushToken: { not: null } }
    });
    const premiumTotal = await prisma.user.count({ where: { isPremium: true } });

    const active7dWithToken = await prisma.user.count({
      where: {
        lastSeen: { gte: sevenDaysAgo },
        expoPushToken: { not: null }
      }
    });
    const active7dTotal = await prisma.user.count({
      where: { lastSeen: { gte: sevenDaysAgo } }
    });

    // 5. Token registration trend (last 30 days, from user createdAt who have tokens)
    const recentTokenUsers = await prisma.user.findMany({
      where: {
        expoPushToken: { not: null },
        createdAt: { gte: thirtyDaysAgo }
      },
      select: { createdAt: true }
    });

    const dailyTokens = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      dailyTokens[d.toISOString().split('T')[0]] = 0;
    }
    recentTokenUsers.forEach(u => {
      const dateKey = new Date(u.createdAt).toISOString().split('T')[0];
      if (dailyTokens[dateKey] !== undefined) dailyTokens[dateKey]++;
    });

    const tokenTrend = Object.keys(dailyTokens).sort().map(date => ({
      date,
      count: dailyTokens[date]
    }));

    res.json({
      coverage: {
        totalUsers,
        usersWithToken,
        usersWithoutToken,
        tokenCoverage
      },
      tokens: {
        total: usersWithToken,
        active: activeTokens,
        stale: staleTokens
      },
      platforms: {
        ios: iosCount,
        android: androidCount,
        expo: otherCount
      },
      segments: {
        all: { reachable: usersWithToken, total: totalUsers },
        premium: { reachable: premiumWithToken, total: premiumTotal },
        active7d: { reachable: active7dWithToken, total: active7dTotal }
      },
      tokenTrend
    });

  } catch (error) {
    console.error('getNotificationsAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching notifications analytics' });
  }
};
