const router = require('express').Router();
const { getPublicStats } = require('../controllers/statsController');

// Ochiq (auth-siz) landing statistikasi. /api global rate-limiter ostida.
router.get('/public', getPublicStats);

module.exports = router;
