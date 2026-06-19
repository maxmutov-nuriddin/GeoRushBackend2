const router = require('express').Router();
const { query, validationResult } = require('express-validator');
const { getPlayerLeaderboard, getTeamLeaderboard, getMyRank } = require('../controllers/leaderboardController');
const { authenticate } = require('../middleware/auth');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

// `limit` musbat butun son bo'lishi shart — aks holda parseInt(NaN)/manfiy Prisma `take`'ga
// o'tib xato berishi mumkin edi. MAX QO'YILMAYDI: controller allaqachon Math.min bilan
// cheklaydi, shuning uchun katta limit yuboradigan eski mijoz AYNAN avvalgidek ishlaydi
// (200/100 ga cheklanadi, rad etilmaydi) — xulq o'zgarmaydi, faqat NaN/manfiy to'siladi.
// `scope` — controllerdagi yagona mavjud to'rtta qiymat (boshqasi avval ham 'global'ga tushardi).
router.get('/players', authenticate, [
  query('limit').optional().isInt({ min: 1 }),
  query('scope').optional().isIn(['global', 'friends', 'city', 'country']),
], validate, getPlayerLeaderboard);

router.get('/teams', authenticate, [
  query('limit').optional().isInt({ min: 1 }),
], validate, getTeamLeaderboard);

router.get('/my-rank', authenticate, getMyRank);

module.exports = router;
