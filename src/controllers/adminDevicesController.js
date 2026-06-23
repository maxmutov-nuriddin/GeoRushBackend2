const { prisma } = require('../config/database');

exports.getDevicesAnalytics = async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 1. Total devices with push tokens
    const totalDevices = await prisma.user.count({
      where: { expoPushToken: { not: null } }
    });

    // 2. Active devices (token + lastSeen in 7d)
    const activeDevices = await prisma.user.count({
      where: {
        expoPushToken: { not: null },
        lastSeen: { gte: sevenDaysAgo }
      }
    });

    // 3. Inactive devices (token + lastSeen > 30d)
    const inactiveDevices = await prisma.user.count({
      where: {
        expoPushToken: { not: null },
        lastSeen: { lt: thirtyDaysAgo }
      }
    });

    // 4. Devices by country
    const devicesByCountryRaw = await prisma.user.groupBy({
      by: ['country'],
      where: { expoPushToken: { not: null } },
      _count: { country: true },
      orderBy: { _count: { country: 'desc' } },
      take: 20
    });

    const devicesByCountry = devicesByCountryRaw.map(d => ({
      country: d.country || 'Unknown',
      count: d._count.country
    }));

    // 5. Devices by city (top 15)
    const devicesByCityRaw = await prisma.user.groupBy({
      by: ['city'],
      where: { expoPushToken: { not: null } },
      _count: { city: true },
      orderBy: { _count: { city: 'desc' } },
      take: 15
    });

    const devicesByCity = devicesByCityRaw.map(d => ({
      city: d.city || 'Unknown',
      count: d._count.city
    }));

    // 6. Token registration trend (last 30 days from user createdAt who have tokens)
    const recentDeviceUsers = await prisma.user.findMany({
      where: {
        expoPushToken: { not: null },
        createdAt: { gte: thirtyDaysAgo }
      },
      select: { createdAt: true }
    });

    const dailyRegistration = {};
    for (let i = 0; i <= 30; i++) {
      const d = new Date(thirtyDaysAgo);
      d.setDate(d.getDate() + i);
      dailyRegistration[d.toISOString().split('T')[0]] = 0;
    }
    recentDeviceUsers.forEach(u => {
      const dateKey = new Date(u.createdAt).toISOString().split('T')[0];
      if (dailyRegistration[dateKey] !== undefined) dailyRegistration[dateKey]++;
    });

    const registrationTrend = Object.keys(dailyRegistration).sort().map(date => ({
      date,
      count: dailyRegistration[date]
    }));

    // 7. Online devices right now
    const onlineDevices = await prisma.user.count({
      where: {
        expoPushToken: { not: null },
        isOnline: true
      }
    });

    const totalUsers = await prisma.user.count();

    res.json({
      overview: {
        totalDevices,
        activeDevices,
        inactiveDevices,
        onlineDevices,
        totalUsers,
        deviceCoverage: totalUsers > 0 ? Math.round((totalDevices / totalUsers) * 100) : 0
      },
      devicesByCountry,
      devicesByCity,
      registrationTrend
    });

  } catch (error) {
    console.error('getDevicesAnalytics error:', error);
    res.status(500).json({ error: 'Server error fetching devices analytics' });
  }
};
