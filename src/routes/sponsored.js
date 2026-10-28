const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getZones, getMyClaims } = require('../controllers/sponsoredController');

// B2B aksiya zonalari (o'yinchi tomoni). Yaratish/boshqarish — /api/admin/sponsored-zones.
router.use(authenticate);
router.get('/zones', getZones);
router.get('/my-claims', getMyClaims);

module.exports = router;
