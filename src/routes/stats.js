const router = require('express').Router();
const { getPublicStats, getGlobePoints } = require('../controllers/statsController');

// Ochiq (auth-siz) landing statistikasi. /api global rate-limiter ostida.
router.get('/public', getPublicStats);
// Jonli globus — anonim hudud nuqtalari (username/ID yo'q, 5 daqiqa cache).
router.get('/globe', getGlobePoints);

module.exports = router;
