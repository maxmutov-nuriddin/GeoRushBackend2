const { prisma } = require('../config/database');

exports.getRevenueAnalytics = async (req, res) => {
  try {
    // 1. Overview (Total Revenue, Total Stars, Total Purchases, ARPPU)
    const purchases = await prisma.premiumPurchase.findMany({
      select: {
        amountSom: true,
        amountStars: true,
        userId: true,
        method: true,
        createdAt: true,
        tier: true,
        period: true,
      }
    });

    let totalSom = 0;
    let totalStars = 0;
    const uniquePayers = new Set();
    const methodCounts = { stars: 0, card: 0, revenuecat: 0 };
    const tierCounts = { pro: 0, ultra: 0 };

    // Barcha xaridlarni aylanib chiqish
    purchases.forEach(p => {
      totalSom += p.amountSom;
      totalStars += p.amountStars;
      uniquePayers.add(p.userId);

      if (methodCounts[p.method] !== undefined) methodCounts[p.method]++;
      else methodCounts[p.method] = 1;

      if (tierCounts[p.tier] !== undefined) tierCounts[p.tier]++;
      else tierCounts[p.tier] = 1;
    });

    const totalPurchases = purchases.length;
    const arppu = uniquePayers.size > 0 ? Math.round(totalSom / uniquePayers.size) : 0;

    // 2. Vaqt boyicha (Last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentPurchases = purchases.filter(p => new Date(p.createdAt) >= thirtyDaysAgo);
    
    // Gruppalash kun bo'yicha
    const dailyRevenue = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      dailyRevenue[d.toISOString().split('T')[0]] = { som: 0, stars: 0, count: 0 };
    }

    recentPurchases.forEach(p => {
      const dateKey = new Date(p.createdAt).toISOString().split('T')[0];
      if (dailyRevenue[dateKey]) {
        dailyRevenue[dateKey].som += p.amountSom;
        dailyRevenue[dateKey].stars += p.amountStars;
        dailyRevenue[dateKey].count++;
      }
    });

    const trend = Object.keys(dailyRevenue).sort().map(date => ({
      date,
      ...dailyRevenue[date]
    }));

    // 3. So'nggi tranzaksiyalar (Recent transactions)
    const recentTransactions = await prisma.premiumPurchase.findMany({
      take: 20,
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      overview: {
        totalSom,
        totalStars,
        totalPurchases,
        payingUsers: uniquePayers.size,
        arppu
      },
      distribution: {
        byMethod: methodCounts,
        byTier: tierCounts
      },
      trend,
      recentTransactions
    });

  } catch (error) {
    console.error('getRevenueAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching revenue analytics' });
  }
};
