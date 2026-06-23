const { prisma } = require('../config/database');

exports.getMarketingAnalytics = async (req, res) => {
  try {
    // 1. PromoCode Stats
    const allPromos = await prisma.promoCode.findMany({
      select: { id: true, isActive: true, expiresAt: true, usesCount: true, maxUses: true, code: true, discountPct: true }
    });

    const now = new Date();
    const totalPromos = allPromos.length;
    const activePromos = allPromos.filter(p => p.isActive && (!p.expiresAt || new Date(p.expiresAt) > now)).length;
    const expiredPromos = allPromos.filter(p => p.expiresAt && new Date(p.expiresAt) <= now).length;
    const totalPromoUses = allPromos.reduce((sum, p) => sum + p.usesCount, 0);

    // 2. Referral Funnel
    const totalReferrals = await prisma.referral.count();
    const completedReferrals = await prisma.referral.count({ where: { status: 'completed' } });
    const pendingReferrals = await prisma.referral.count({ where: { status: 'pending' } });
    const referralConversionRate = totalReferrals > 0 ? Math.round((completedReferrals / totalReferrals) * 100) : 0;

    // 3. User Acquisition
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const newUsers7d = await prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } });
    const newUsers30d = await prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } });
    const newUsers90d = await prisma.user.count({ where: { createdAt: { gte: ninetyDaysAgo } } });

    // 4. Channel Performance (organic vs referral)
    const totalUsers = await prisma.user.count();
    const referredUsers = await prisma.referral.count({ where: { status: 'completed' } });
    const organicUsers = totalUsers - referredUsers;

    // 5. Campaign Effectiveness (top promo codes by usage)
    const topCampaigns = [...allPromos]
      .sort((a, b) => b.usesCount - a.usesCount)
      .slice(0, 10)
      .map(p => ({
        code: p.code,
        discountPct: p.discountPct,
        usesCount: p.usesCount,
        maxUses: p.maxUses,
        isActive: p.isActive
      }));

    // 6. Acquisition trend (daily new users last 30 days)
    const recentUsers = await prisma.user.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      select: { createdAt: true }
    });

    const dailyAcquisition = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      dailyAcquisition[d.toISOString().split('T')[0]] = 0;
    }
    recentUsers.forEach(u => {
      const dateKey = new Date(u.createdAt).toISOString().split('T')[0];
      if (dailyAcquisition[dateKey] !== undefined) dailyAcquisition[dateKey]++;
    });

    const acquisitionTrend = Object.keys(dailyAcquisition).sort().map(date => ({
      date,
      count: dailyAcquisition[date]
    }));

    res.json({
      promoStats: {
        totalPromos,
        activePromos,
        expiredPromos,
        totalPromoUses
      },
      referralFunnel: {
        totalReferrals,
        completedReferrals,
        pendingReferrals,
        conversionRate: referralConversionRate
      },
      userAcquisition: {
        newUsers7d,
        newUsers30d,
        newUsers90d
      },
      channelPerformance: {
        organic: organicUsers,
        referral: referredUsers,
        organicPct: totalUsers > 0 ? Math.round((organicUsers / totalUsers) * 100) : 0,
        referralPct: totalUsers > 0 ? Math.round((referredUsers / totalUsers) * 100) : 0
      },
      topCampaigns,
      acquisitionTrend
    });

  } catch (error) {
    console.error('getMarketingAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching marketing analytics' });
  }
};
