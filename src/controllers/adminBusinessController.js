const { prisma } = require('../config/database');

exports.getBusinessAnalytics = async (req, res) => {
  try {
    const totalUsers = await prisma.user.count();
    
    // So'nggi 30 kunlik xaridlar (MRR ni taxmin qilish uchun)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentPurchases = await prisma.premiumPurchase.findMany({
      where: {
        createdAt: { gte: thirtyDaysAgo }
      },
      select: { amountSom: true }
    });

    const mrr = recentPurchases.reduce((acc, p) => acc + p.amountSom, 0);
    const arr = mrr * 12;

    // LTV (Life Time Value) - Oddiy usul: Barcha davrdagi daromad / foydalanuvchilar soni
    const allPurchases = await prisma.premiumPurchase.findMany({
      select: { amountSom: true }
    });
    const totalRevenue = allPurchases.reduce((acc, p) => acc + p.amountSom, 0);
    const ltv = totalUsers > 0 ? Math.round(totalRevenue / totalUsers) : 0;

    // ARPPU (Faqat to'lov qilgan foydalanuvchilar o'rtacha qancha to'lagan)
    const payers = await prisma.premiumPurchase.groupBy({
      by: ['userId'],
    });
    const arppu = payers.length > 0 ? Math.round(totalRevenue / payers.length) : 0;

    // CAC (Customer Acquisition Cost) - marketing jadvali yo'qligi sababli mock
    const cac = 1500; // Taxminiy 1500 so'm / foydalanuvchi

    res.json({
      metrics: {
        mrr,
        arr,
        ltv,
        arppu,
        cac,
        ltvToCacRatio: cac > 0 ? (ltv / cac).toFixed(2) : 0
      },
      burnRate: 0, // Server/infratuzilma xarajatlarini bazaga kiritsak bu hisoblanadi
      runway: "N/A" 
    });

  } catch (error) {
    console.error('getBusinessAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching business analytics' });
  }
};
