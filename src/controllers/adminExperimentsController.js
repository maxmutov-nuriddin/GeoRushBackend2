const { prisma } = require('../config/database');

exports.getExperimentsData = async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // 1. Active A/B Tests (no experiment system yet)
    const abTests = [];

    // 2. Feature Flags
    const featureFlags = [
      { key: 'isPremiumEnabled', name: 'Premium System', enabled: true, description: 'Premium subscription system' },
      { key: 'isReferralEnabled', name: 'Referral Program', enabled: true, description: 'User referral program' },
      { key: 'isPromoEnabled', name: 'Promo Codes', enabled: true, description: 'Promotional code system' },
      { key: 'isTeamsEnabled', name: 'Teams', enabled: true, description: 'Team creation and management' },
      { key: 'isAntiCheatEnabled', name: 'Anti-Cheat', enabled: true, description: 'Anti-cheat detection system' },
      { key: 'isBroadcastEnabled', name: 'Broadcast', enabled: true, description: 'Push notification broadcasts' },
      { key: 'isSupportChatEnabled', name: 'Support Chat', enabled: true, description: 'In-app support chat' },
      { key: 'isLeaderboardEnabled', name: 'Leaderboards', enabled: true, description: 'Global and regional leaderboards' }
    ];

    // 3. User Segments
    const totalUsers = await prisma.user.count();
    const premiumCount = await prisma.user.count({ where: { isPremium: true } });
    const freeCount = totalUsers - premiumCount;
    const bannedCount = await prisma.user.count({ where: { isBanned: true } });
    const activeCount = await prisma.user.count({ where: { lastSeen: { gte: sevenDaysAgo } } });
    const dormantCount = await prisma.user.count({ where: { lastSeen: { lt: thirtyDaysAgo } } });
    const newCount = await prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } });

    const segments = [
      { name: 'Premium', key: 'premium', count: premiumCount, color: '#00e5ff' },
      { name: 'Free', key: 'free', count: freeCount, color: '#4e5569' },
      { name: 'Banned', key: 'banned', count: bannedCount, color: '#ff4c4c' },
      { name: 'Active (7d)', key: 'active', count: activeCount, color: '#00f57a' },
      { name: 'Dormant (30d+)', key: 'dormant', count: dormantCount, color: '#f59e0b' },
      { name: 'New (7d)', key: 'new', count: newCount, color: '#ff0055' }
    ];

    res.json({
      abTests,
      featureFlags,
      segments,
      summary: {
        totalFlags: featureFlags.length,
        enabledFlags: featureFlags.filter(f => f.enabled).length,
        totalSegments: segments.length,
        totalExperiments: abTests.length
      }
    });

  } catch (error) {
    console.error('getExperimentsData error:', error);
    res.status(500).json({ error: 'Server error fetching experiments data' });
  }
};
