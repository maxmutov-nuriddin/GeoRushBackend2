const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getSafeRoute } = require('../controllers/safeRouteController');

// "Xavfsiz marshrut" — piyoda yo'nalish + TrafficCell gavjumlik bahosi (read-only).
router.post('/', authenticate, getSafeRoute);

module.exports = router;
