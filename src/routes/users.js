const router = require('express').Router();
const { body } = require('express-validator');
const { getProfile, updateProfile, changePassword, getOnlinePlayers, clearMyData, deleteAccount, savePushToken, acceptTerms, setLocationMeta, getActivity, sendSupport, sendPublicSupport } = require('../controllers/userController');
const { authenticate } = require('../middleware/auth');

router.get('/online', authenticate, getOnlinePlayers);
router.get('/me/activity', authenticate, getActivity);
router.get('/:id', authenticate, getProfile);
router.put('/me', authenticate, [
  body('username').optional().trim().isLength({ min: 3, max: 50 }).matches(/^[a-zA-Z0-9_]+$/),
  body('color').optional().matches(/^#[0-9A-Fa-f]{6}$/),
], updateProfile);
router.put('/me/password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }),
], changePassword);
router.post('/me/accept-terms', authenticate, acceptTerms);
router.post('/me/support', authenticate, [
  body('message').trim().notEmpty().isLength({ max: 2000 }),
  body('telegramUsername').optional().trim().isLength({ max: 50 }),
], sendSupport);
router.post('/me/push-token', authenticate, savePushToken);
router.post('/me/location-meta', authenticate, setLocationMeta);
router.post('/me/clear-data', authenticate, clearMyData);
router.delete('/me', authenticate, [
  body('password').notEmpty(),
], deleteAccount);

// Auth shart emas
router.post('/support', [
  body('message').trim().notEmpty().isLength({ max: 2000 }),
  body('phone').optional().trim(),
  body('telegramUsername').optional().trim().isLength({ max: 50 }),
], sendPublicSupport);

module.exports = router;
