const { prisma } = require('../config/database');
const { tierOf } = require('../config/tiers');

const CACHE_TTL = 5 * 60 * 1000; // 5 daqiqa
const cache = {
  players: { data: null, at: 0 },
  teams:   { data: null, at: 0 },
};

async function getPlayerLeaderboard(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const reqScope = req.query.scope || 'global';

    let filter = { isAdmin: false };
    let scope = 'global';
    if (reqScope === 'friends') {
      // Do'stlar reytingi — barcha tierlar uchun ochiq. Faqat do'stlar + o'zim.
      // Global cache yo'liga tushmaydi (scope 'global' emas), shuning uchun
      // mavjud cache xulqi mutlaqo o'zgarmaydi.
      const { getFriendIds } = require('./friendController');
      const friendIds = await getFriendIds(req.user.id);
      filter.id = { in: [...friendIds, req.user.id] };
      scope = 'friends';
    } else if (reqScope === 'city' || reqScope === 'country') {
      const me = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { isPremium: true, premiumUntil: true, premiumTier: true, city: true, country: true }
      });
      const tier = tierOf(me);
      if (reqScope === 'city' && (tier === 'pro' || tier === 'ultra') && me?.city) {
        filter.city = { equals: me.city, mode: 'insensitive' }; scope = 'city';
      } else if (reqScope === 'country' && tier === 'ultra' && me?.country) {
        filter.country = { equals: me.country, mode: 'insensitive' }; scope = 'country';
      }
    }

    if (scope === 'global' && limit === 50 && cache.players.data && Date.now() - cache.players.at < CACHE_TTL) {
      return res.json({ leaderboard: cache.players.data, scope });
    }

    const players = await prisma.user.findMany({
      where: filter,
      // id tiebreaker — teng XP'da tartib aniq va getMyRank bilan mos bo'lishi uchun.
      orderBy: [{ xp: 'desc' }, { id: 'asc' }],
      take: limit,
      include: { team: { select: { name: true, color: true, tag: true } } },
    });

    const now = new Date();
    const leaderboard = players.map((p, i) => ({
      id: p.id,
      username: p.username,
      color: p.color,
      xp: p.xp,
      level: p.level,
      totalArea: p.totalArea,
      territoriesCaptured: p.territoriesCaptured,
      isOnline: p.isOnline,
      isPremium: !!(p.isPremium && p.premiumUntil && now < new Date(p.premiumUntil)),
      teamName: p.team?.name,
      teamColor: p.team?.color,
      teamTag: p.team?.tag,
      rank: i + 1,
    }));

    if (scope === 'global' && limit === 50) {
      cache.players = { data: leaderboard, at: Date.now() };
    }

    res.json({ leaderboard, scope });
  } catch (err) {
    next(err);
  }
}

async function getTeamLeaderboard(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);

    if (limit === 20 && cache.teams.data && Date.now() - cache.teams.at < CACHE_TTL) {
      return res.json({ leaderboard: cache.teams.data });
    }

    const teams = await prisma.team.findMany({
      orderBy: { totalArea: 'desc' },
      take: limit,
    });

    const leaderboard = teams.map((t, i) => ({ ...t, rank: i + 1 }));

    if (limit === 20) {
      cache.teams = { data: leaderboard, at: Date.now() };
    }

    res.json({ leaderboard });
  } catch (err) {
    next(err);
  }
}

async function getMyRank(req, res, next) {
  try {
    const myXp = req.user.xp;
    const myId = req.user.id;
    // Teng XP'da rank aniq bo'lishi uchun id bo'yicha tiebreaker — reyting ro'yxati bilan
    // bir xil tartib (orderBy: xp desc, id asc). Aks holda bir xil XP'li (masalan, 0)
    // barcha o'yinchilarga bir xil rank chiqardi (top-2 dan keyin hamma "3" ko'rinardi).
    const rank = await prisma.user.count({
      where: {
        isAdmin: false,
        OR: [
          { xp: { gt: myXp } },
          { xp: myXp, id: { lt: myId } },
        ],
      },
    });
    res.json({ rank: rank + 1 });
  } catch (err) {
    next(err);
  }
}

function invalidateLeaderboardCache() {
  cache.players.at = 0;
  cache.teams.at = 0;
}

const LEADERBOARD_EMIT_THROTTLE_MS = 15000;
let lastLeaderboardEmit = 0;

function emitLeaderboardUpdate(io) {
  if (!io) return;
  const now = Date.now();
  if (now - lastLeaderboardEmit < LEADERBOARD_EMIT_THROTTLE_MS) return;
  lastLeaderboardEmit = now;
  io.to('global').emit('leaderboard:update');
}

module.exports = { getPlayerLeaderboard, getTeamLeaderboard, getMyRank, invalidateLeaderboardCache, emitLeaderboardUpdate };
