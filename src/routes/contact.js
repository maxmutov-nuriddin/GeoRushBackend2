const router = require('express').Router();
const { body } = require('express-validator');
const { validationResult } = require('express-validator');
const { sendContact } = require('../controllers/contactController');
const { contactLimiter } = require('../middleware/rateLimiter');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// POST /api/contact — landing "Bog'lanish" formasi (auth shart emas, IP-limit ostida)
router.post('/', contactLimiter, [
  body('message').trim().isLength({ min: 1, max: 4000 }),
  body('name').optional().trim().isLength({ max: 100 }),
  body('phone').optional().trim().isLength({ max: 30 }),
  body('telegram').optional().trim().isLength({ max: 64 }),
], validate, sendContact);

module.exports = router;
