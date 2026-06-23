const { prisma } = require('../config/database');

exports.getPremiumAnalytics = async (req, res) => {
  try {
    const totalUsers = await prisma.user.count();
    
    // Premium bo'lganlar (hozirda faol)
    const activePremiumCount = await prisma.user.count({
      where: {
        isPremium: true,
        premiumUntil: { gt: new Date() }
      }
    });

    // Premium muddati tugaganlar
    const expiredPremiumCount = await prisma.user.count({
      where: {
        isPremium: true,
        premiumUntil: { lte: new Date() }
      }
    });

    // Tier bo'yicha taqsimot
    const proUsersCount = await prisma.user.count({
      where: {
        isPremium: true,
        premiumTier: 'pro',
        premiumUntil: { gt: new Date() }
      }
    });

    const ultraUsersCount = await prisma.user.count({
      where: {
        isPremium: true,
        premiumTier: 'ultra',
        premiumUntil: { gt: new Date() }
      }
    });

    // Oxirgi 30 kun ichida yangilangan yoki sotib olingan premiumlar
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const newPremiumPurchases = await prisma.premiumPurchase.count({
      where: {
        createdAt: { gte: thirtyDaysAgo }
      }
    });

    // Eng so'nggi Premium foydalanuvchilar ro'yxati (oxirgi 20 ta)
    const recentPremiumUsers = await prisma.user.findMany({
      where: {
        isPremium: true,
        premiumUntil: { gt: new Date() }
      },
      orderBy: { premiumUntil: 'desc' },
      take: 20,
      select: {
        id: true,
        username: true,
        avatarUrl: true,
        premiumTier: true,
        premiumUntil: true,
        premiumIsGift: true
      }
    });

    res.json({
      overview: {
        totalUsers,
        activePremium: activePremiumCount,
        expiredPremium: expiredPremiumCount,
        newPurchases30d: newPremiumPurchases,
        conversionRate: totalUsers > 0 ? ((activePremiumCount / totalUsers) * 100).toFixed(2) : 0
      },
      distribution: {
        pro: proUsersCount,
        ultra: ultraUsersCount
      },
      recentPremiumUsers
    });

  } catch (error) {
    console.error('getPremiumAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching premium analytics' });
  }
};
