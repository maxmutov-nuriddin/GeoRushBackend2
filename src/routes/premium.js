const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getStatus, sendInvoice } = require('../controllers/premiumController');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

router.use(authenticate);
router.get('/status',       getStatus);

// Faqat ruxsat etilgan tarif/davr/promokod qabul qilinadi (oq ro'yxat).
// Avval har qanday matn ham jim o'tib ketardi — endi noto'g'ri qiymat aniq xato bilan rad etiladi.
router.post('/send-invoice', [
  body('tier').optional().isIn(['pro', 'ultra']),
  body('period').optional().isIn(['monthly', 'yearly']),
  body('promoCode').optional().isString().trim().isLength({ max: 40 }),
], validate, sendInvoice);

module.exports = router;
