const router = require('express').Router();
const { getMyReferralStats } = require('../controllers/referralController');
const { authenticate } = require('../middleware/auth');

router.get('/me', authenticate, getMyReferralStats);

module.exports = router;
