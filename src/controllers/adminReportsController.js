const { prisma } = require('../config/database');

exports.getReportsData = async (req, res) => {
  try {
    const now = new Date();

    // 1. Summary Report
    const totalUsers = await prisma.user.count();
    const premiumUsers = await prisma.user.count({ where: { isPremium: true } });
    const totalTerritories = await prisma.territory.count();
    const totalTeams = await prisma.team.count();

    const purchases = await prisma.premiumPurchase.findMany({
      select: { amountSom: true, createdAt: true, userId: true }
    });
    const totalRevenue = purchases.reduce((sum, p) => sum + p.amountSom, 0);

    // 2. Weekly Comparison (this week vs last week)
    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(thisWeekStart.getDate() - 7);
    const lastWeekStart = new Date(now);
    lastWeekStart.setDate(lastWeekStart.getDate() - 14);

    const newUsersThisWeek = await prisma.user.count({ where: { createdAt: { gte: thisWeekStart } } });
    const newUsersLastWeek = await prisma.user.count({
      where: { createdAt: { gte: lastWeekStart, lt: thisWeekStart } }
    });

    const revenueThisWeek = purchases
      .filter(p => new Date(p.createdAt) >= thisWeekStart)
      .reduce((sum, p) => sum + p.amountSom, 0);
    const revenueLastWeek = purchases
      .filter(p => new Date(p.createdAt) >= lastWeekStart && new Date(p.createdAt) < thisWeekStart)
      .reduce((sum, p) => sum + p.amountSom, 0);

    const eventsThisWeek = await prisma.gameEvent.count({ where: { createdAt: { gte: thisWeekStart } } });
    const eventsLastWeek = await prisma.gameEvent.count({
      where: { createdAt: { gte: lastWeekStart, lt: thisWeekStart } }
    });

    const calcChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    // 3. Monthly Trend (last 6 months)
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const recentUsersAll = await prisma.user.findMany({
      where: { createdAt: { gte: sixMonthsAgo } },
      select: { createdAt: true }
    });
    const recentEventsAll = await prisma.gameEvent.findMany({
      where: { createdAt: { gte: sixMonthsAgo } },
      select: { createdAt: true }
    });

    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthLabel = monthStart.toISOString().slice(0, 7);

      const usersInMonth = recentUsersAll.filter(u => {
        const d = new Date(u.createdAt);
        return d >= monthStart && d <= monthEnd;
      }).length;

      const eventsInMonth = recentEventsAll.filter(e => {
        const d = new Date(e.createdAt);
        return d >= monthStart && d <= monthEnd;
      }).length;

      const revenueInMonth = purchases.filter(p => {
        const d = new Date(p.createdAt);
        return d >= monthStart && d <= monthEnd;
      }).reduce((sum, p) => sum + p.amountSom, 0);

      monthlyTrend.push({
        month: monthLabel,
        users: usersInMonth,
        events: eventsInMonth,
        revenue: revenueInMonth
      });
    }

    // 4. Key Ratios
    const premiumConversion = totalUsers > 0 ? ((premiumUsers / totalUsers) * 100).toFixed(1) : 0;
    const uniquePayers = new Set(purchases.map(p => p.userId));
    const arppu = uniquePayers.size > 0 ? Math.round(totalRevenue / uniquePayers.size) : 0;

    // DAU / MAU stickiness
    const oneDayAgo = new Date(now);
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dau = await prisma.user.count({ where: { lastSeen: { gte: oneDayAgo } } });
    const mau = await prisma.user.count({ where: { lastSeen: { gte: thirtyDaysAgo } } });
    const stickiness = mau > 0 ? Math.round((dau / mau) * 100) : 0;

    res.json({
      summary: {
        totalUsers,
        premiumUsers,
        totalRevenue,
        totalTerritories,
        totalTeams
      },
      weeklyComparison: {
        users: { current: newUsersThisWeek, previous: newUsersLastWeek, change: calcChange(newUsersThisWeek, newUsersLastWeek) },
        revenue: { current: revenueThisWeek, previous: revenueLastWeek, change: calcChange(revenueThisWeek, revenueLastWeek) },
        events: { current: eventsThisWeek, previous: eventsLastWeek, change: calcChange(eventsThisWeek, eventsLastWeek) }
      },
      monthlyTrend,
      keyRatios: {
        premiumConversion: parseFloat(premiumConversion),
        arppu,
        dau,
        mau,
        stickiness
      }
    });

  } catch (error) {
    console.error('getReportsData error:', error);
    res.status(500).json({ error: 'Server error fetching reports data' });
  }
};
