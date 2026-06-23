const { prisma } = require('../config/database');

exports.getExportData = async (req, res) => {
  try {
    // Count all available export datasets
    const [users, territories, teams, events, purchases, warnings, referrals, promoCodes, antiCheatLogs, friendships] = await Promise.all([
      prisma.user.count(),
      prisma.territory.count(),
      prisma.team.count(),
      prisma.gameEvent.count(),
      prisma.premiumPurchase.count(),
      prisma.warning.count(),
      prisma.referral.count(),
      prisma.promoCode.count(),
      prisma.antiCheatLog.count(),
      prisma.friendship.count()
    ]);

    const datasets = [
      { name: 'users', icon: '👤', count: users, description: 'All user accounts and profiles' },
      { name: 'territories', icon: '🗺️', count: territories, description: 'All captured territories' },
      { name: 'teams', icon: '👥', count: teams, description: 'All teams and members' },
      { name: 'events', icon: '🎮', count: events, description: 'Game events and activities' },
      { name: 'purchases', icon: '💰', count: purchases, description: 'Premium purchase transactions' },
      { name: 'warnings', icon: '⚠️', count: warnings, description: 'User warnings and bans' },
      { name: 'referrals', icon: '🔗', count: referrals, description: 'Referral records' },
      { name: 'promoCodes', icon: '🎟️', count: promoCodes, description: 'Promo codes' },
      { name: 'antiCheatLogs', icon: '🛡️', count: antiCheatLogs, description: 'Anti-cheat detection logs' },
      { name: 'friendships', icon: '🤝', count: friendships, description: 'User friendships' }
    ];

    const totalRecords = datasets.reduce((sum, d) => sum + d.count, 0);

    res.json({
      datasets,
      totalRecords,
      totalTables: datasets.length,
      lastExport: null,
      exportFormats: ['CSV', 'JSON', 'XLSX']
    });

  } catch (error) {
    console.error('getExportData error:', error);
    res.status(500).json({ error: 'Server error fetching export data' });
  }
};
