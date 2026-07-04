const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getSafeRoute, recordArrival } = require('../controllers/safeRouteController');

// "Xavfsiz marshrut" — piyoda yo'nalish + TrafficCell gavjumlik bahosi (read-only).
router.post('/', authenticate, getSafeRoute);
// Navigatsiya tugaganda: "manzilga yetib keldingizmi?" javobi DB'ga yoziladi.
router.post('/arrived', authenticate, recordArrival);

module.exports = router;
