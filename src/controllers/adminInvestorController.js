const { prisma } = require('../config/database');

exports.getInvestorDashboard = async (req, res) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    // 1. Key Metrics
    const totalUsers = await prisma.user.count();
    const mau = await prisma.user.count({ where: { lastSeen: { gte: thirtyDaysAgo } } });
    const dau = await prisma.user.count({ where: { lastSeen: { gte: oneDayAgo } } });
    const premiumUsers = await prisma.user.count({ where: { isPremium: true } });

    // Revenue calculations
    const purchases = await prisma.premiumPurchase.findMany({
      select: { amountSom: true, createdAt: true, userId: true }
    });

    const revenueThisMonth = purchases
      .filter(p => new Date(p.createdAt) >= thirtyDaysAgo)
      .reduce((sum, p) => sum + p.amountSom, 0);

    const revenuePrevMonth = purchases
      .filter(p => new Date(p.createdAt) >= sixtyDaysAgo && new Date(p.createdAt) < thirtyDaysAgo)
      .reduce((sum, p) => sum + p.amountSom, 0);

    const mrr = revenueThisMonth;
    const arr = mrr * 12;
    const totalRevenue = purchases.reduce((sum, p) => sum + p.amountSom, 0);
    const uniquePayers = new Set(purchases.map(p => p.userId));
    const ltv = uniquePayers.size > 0 ? Math.round(totalRevenue / uniquePayers.size) : 0;

    // CAC estimate (total marketing cost assumed 0, so CAC based on referral effort)
    const totalReferrals = await prisma.referral.count({ where: { status: 'completed' } });
    const cac = 0; // No marketing spend tracked

    // 2. Growth Metrics
    const usersThisMonth = await prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } });
    const usersPrevMonth = await prisma.user.count({
      where: { createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } }
    });

    const userGrowthRate = usersPrevMonth > 0
      ? Math.round(((usersThisMonth - usersPrevMonth) / usersPrevMonth) * 100)
      : (usersThisMonth > 0 ? 100 : 0);

    const revenueGrowthRate = revenuePrevMonth > 0
      ? Math.round(((revenueThisMonth - revenuePrevMonth) / revenuePrevMonth) * 100)
      : (revenueThisMonth > 0 ? 100 : 0);

    // 3. Market Metrics
    const territoryCount = await prisma.territory.count();
    const areaResult = await prisma.user.aggregate({ _sum: { totalArea: true } });
    const totalArea = areaResult._sum.totalArea || 0;

    // 4. User Engagement
    const engagementData = await prisma.user.aggregate({
      _avg: { totalPlaytimeSec: true, sessionCount: true },
      _sum: { sessionCount: true }
    });

    const avgSessionTime = engagementData._avg.totalPlaytimeSec
      ? Math.round(engagementData._avg.totalPlaytimeSec / 60)
      : 0;
    const avgSessionsPerUser = engagementData._avg.sessionCount
      ? Math.round(engagementData._avg.sessionCount * 10) / 10
      : 0;
    const stickiness = mau > 0 ? Math.round((dau / mau) * 100) : 0;

    // 5. Growth trend (monthly users for 6 months)
    const growthTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const label = monthStart.toISOString().slice(0, 7);

      const count = await prisma.user.count({
        where: { createdAt: { gte: monthStart, lte: monthEnd } }
      });

      const rev = purchases
        .filter(p => {
          const d = new Date(p.createdAt);
          return d >= monthStart && d <= monthEnd;
        })
        .reduce((sum, p) => sum + p.amountSom, 0);

      growthTrend.push({ month: label, newUsers: count, revenue: rev });
    }

    res.json({
      keyMetrics: {
        totalUsers,
        mau,
        dau,
        premiumUsers,
        mrr,
        arr,
        ltv,
        cac,
        totalRevenue,
        payingUsers: uniquePayers.size
      },
      growth: {
        userGrowthRate,
        revenueGrowthRate,
        usersThisMonth,
        usersPrevMonth
      },
      market: {
        totalTerritories: territoryCount,
        totalArea: Math.round(totalArea),
        totalReferrals
      },
      engagement: {
        avgSessionTimeMin: avgSessionTime,
        avgSessionsPerUser,
        stickiness,
        dau,
        mau
      },
      growthTrend
    });

  } catch (error) {
    console.error('getInvestorDashboard error:', error);
    res.status(500).json({ error: 'Server error fetching investor dashboard' });
  }
};
