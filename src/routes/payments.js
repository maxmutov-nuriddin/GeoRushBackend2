const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getPacks, checkout, getOrder } = require('../controllers/paymentController');
const { handlePayme } = require('../controllers/paymeController');
const { handlePrepare, handleComplete } = require('../controllers/clickController');
const { COIN_PACKS } = require('../config/tiers');
const { PROVIDERS } = require('../services/paymentOrderService');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// ── Provayder callback'lari (JWT YO'Q — Payme Basic auth, Click md5 imzo bilan tekshiriladi) ──
router.post('/payme', handlePayme);
router.post('/click/prepare', handlePrepare);
router.post('/click/complete', handleComplete);

// ── O'yinchi tomoni ──
router.get('/packs', authenticate, getPacks);
router.post('/checkout', authenticate, [
  body('packId').isString().isIn(Object.keys(COIN_PACKS)),
  body('provider').isString().isIn(PROVIDERS),
], validate, checkout);
router.get('/orders/:id', authenticate, [param('id').isUUID()], validate, getOrder);

module.exports = router;
