const { prisma } = require('../config/database');

exports.getGrowthAnalytics = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const newUsers = await prisma.user.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo }
      },
      select: { createdAt: true }
    });

    const activeUsers = await prisma.user.findMany({
      where: {
        lastSeen: { gte: thirtyDaysAgo }
      },
      select: { lastSeen: true }
    });

    // Gruppalash
    const dailyGrowth = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      dailyGrowth[d.toISOString().split('T')[0]] = { newUsers: 0, activeUsers: 0 };
    }

    newUsers.forEach(u => {
      const dateKey = new Date(u.createdAt).toISOString().split('T')[0];
      if (dailyGrowth[dateKey]) dailyGrowth[dateKey].newUsers++;
    });

    activeUsers.forEach(u => {
      const dateKey = new Date(u.lastSeen).toISOString().split('T')[0];
      if (dailyGrowth[dateKey]) dailyGrowth[dateKey].activeUsers++;
    });

    const trend = Object.keys(dailyGrowth).sort().map(date => ({
      date,
      ...dailyGrowth[date]
    }));

    // Prognoz (oddiy o'rtacha o'sish)
    const avgNewPerDay = newUsers.length / 30;
    const currentTotal = await prisma.user.count();
    const forecast = {
      next7Days: Math.round(currentTotal + (avgNewPerDay * 7)),
      next30Days: Math.round(currentTotal + (avgNewPerDay * 30))
    };

    res.json({
      overview: {
        totalNew30d: newUsers.length,
        avgNewPerDay: Math.round(avgNewPerDay),
        active30d: activeUsers.length
      },
      trend,
      forecast
    });

  } catch (error) {
    console.error('getGrowthAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching growth analytics' });
  }
};
