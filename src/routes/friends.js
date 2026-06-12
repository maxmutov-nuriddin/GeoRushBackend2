const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const {
  listFriends, listRequests, searchUsers,
  sendRequest, acceptRequest, deleteRequest, removeFriend,
} = require('../controllers/friendController');
const { authenticate } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rateLimiter');

// express-validator natijasini tekshiruvchi kichik middleware
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

router.get('/', authenticate, listFriends);
router.get('/requests', authenticate, listRequests);
router.get('/search', authenticate, searchUsers);
// So'rov yuborishga apiLimiter — spam oldini olish (mavjud limiter, yangi emas)
router.post(
  '/requests',
  authenticate,
  apiLimiter,
  [body('username').isString().trim().notEmpty().isLength({ max: 50 })],
  validate,
  sendRequest,
);
router.put('/requests/:id/accept', authenticate, acceptRequest);
router.delete('/requests/:id', authenticate, deleteRequest);
router.delete('/:friendId', authenticate, removeFriend);

module.exports = router;
