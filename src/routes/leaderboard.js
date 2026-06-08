const router = require('express').Router();
const { getPlayerLeaderboard, getTeamLeaderboard, getMyRank } = require('../controllers/leaderboardController');
const { authenticate } = require('../middleware/auth');

router.get('/players', authenticate, getPlayerLeaderboard);
router.get('/teams', authenticate, getTeamLeaderboard);
router.get('/my-rank', authenticate, getMyRank);

module.exports = router;
