const { prisma } = require('../config/database');

exports.getReferralAnalytics = async (req, res) => {
  try {
    const totalReferrals = await prisma.referral.count();
    const completedReferrals = await prisma.referral.count({ where: { status: 'completed' } });
    const pendingReferrals = await prisma.referral.count({ where: { status: 'pending' } });

    // K-Factor (Har bir foydalanuvchi o'rtacha nechta odam taklif qilgani)
    const totalUsers = await prisma.user.count();
    const kFactor = totalUsers > 0 ? (totalReferrals / totalUsers).toFixed(3) : 0;

    // Eng ko'p odam taklif qilganlar (Top 20)
    const topReferrersRaw = await prisma.referral.groupBy({
      by: ['referrerId'],
      _count: { referrerId: true },
      orderBy: { _count: { referrerId: 'desc' } },
      take: 20
    });

    const referrerIds = topReferrersRaw.map(r => r.referrerId);
    const users = await prisma.user.findMany({
      where: { id: { in: referrerIds } },
      select: { id: true, username: true, avatarUrl: true }
    });

    const topReferrers = topReferrersRaw.map(r => {
      const user = users.find(u => u.id === r.referrerId);
      return {
        ...user,
        count: r._count.referrerId
      };
    });

    // Oxirgi 30 kun trend
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentReferrals = await prisma.referral.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true, status: true }
    });

    const dailyTrend = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      dailyTrend[d.toISOString().split('T')[0]] = { pending: 0, completed: 0 };
    }

    recentReferrals.forEach(r => {
      const dateKey = new Date(r.createdAt).toISOString().split('T')[0];
      if (dailyTrend[dateKey]) {
        dailyTrend[dateKey][r.status]++;
      }
    });

    const trend = Object.keys(dailyTrend).sort().map(date => ({
      date,
      ...dailyTrend[date]
    }));

    res.json({
      overview: {
        totalReferrals,
        completedReferrals,
        pendingReferrals,
        kFactor,
        conversionRate: totalReferrals > 0 ? Math.round((completedReferrals / totalReferrals) * 100) : 0
      },
      topReferrers,
      trend
    });

  } catch (error) {
    console.error('getReferralAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching referral analytics' });
  }
};
