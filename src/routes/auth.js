const router = require('express').Router();
const { body } = require('express-validator');
const {
  login, getMe, refreshToken,
  requestOtp, verifyOtp, registerWithPhone, resetPasswordWithPhone,
} = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { loginLimiter, registerLimiter, otpVerifyLimiter, forgotPasswordLimiter } = require('../middleware/rateLimiter');
const { ipBlockMiddleware } = require('../middleware/ipBlocker');

router.post('/login', ipBlockMiddleware, loginLimiter, [
  body('phone').notEmpty().trim(),
  body('password').notEmpty(),
], login);

router.get('/me', authenticate, getMe);
router.post('/refresh', authenticate, refreshToken);

router.post('/request-otp', ipBlockMiddleware, registerLimiter, [
  body('phone').notEmpty().trim(),
  body('purpose').optional().isIn(['register', 'reset']),
], requestOtp);

router.post('/verify-otp', ipBlockMiddleware, otpVerifyLimiter, [
  body('token').notEmpty(),
  body('otp').isLength({ min: 6, max: 6 }),
], verifyOtp);

router.post('/register-phone', ipBlockMiddleware, forgotPasswordLimiter, [
  body('username').trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('phone').notEmpty().trim(),
  body('password').isLength({ min: 6 }),
  body('otpToken').notEmpty(),
  body('color').optional().matches(/^#[0-9A-Fa-f]{6}$/),
], registerWithPhone);

router.post('/reset-password-phone', ipBlockMiddleware, [
  body('otpToken').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], resetPasswordWithPhone);

module.exports = router;
