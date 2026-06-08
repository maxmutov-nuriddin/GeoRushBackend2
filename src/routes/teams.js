const router = require('express').Router();
const { body } = require('express-validator');
const {
  createTeam, getTeam, listTeams, joinTeam, leaveTeam, deleteTeam,
  updateTeamSettings, transferOwnership,
  sendJoinRequest, getJoinRequests, respondToJoinRequest,
  inviteUser, getMyInvites, respondToInvite,
  searchUsers,
  getTeamMarkers, addTeamMarker, deleteTeamMarker,
  grantMarkerAdmin, revokeMarkerAdmin,
} = require('../controllers/teamController');
const { authenticate } = require('../middleware/auth');

router.get('/', authenticate, listTeams);
router.get('/my-invites', authenticate, getMyInvites);
router.get('/search-users', authenticate, searchUsers);
router.get('/:id/markers', authenticate, getTeamMarkers);
router.get('/:id', authenticate, getTeam);
router.get('/:id/requests', authenticate, getJoinRequests);

router.post('/', authenticate, [
  body('name').trim().isLength({ min: 2, max: 100 }),
  body('tag').trim().isLength({ min: 2, max: 10 }).matches(/^[A-Za-z0-9]+$/),
  body('color').optional().matches(/^#[0-9A-Fa-f]{6}$/),
  body('description').optional().isLength({ max: 500 }),
  body('isPublic').optional().isBoolean(),
], createTeam);

router.post('/leave', authenticate, leaveTeam);
router.post('/:id/join', authenticate, joinTeam);
router.post('/:id/join-request', authenticate, sendJoinRequest);
router.post('/:id/invite', authenticate, [
  body('username').trim().notEmpty(),
], inviteUser);
router.post('/:id/transfer-owner', authenticate, [
  body('newOwnerId').notEmpty(),
], transferOwnership);
router.post('/requests/:requestId/respond', authenticate, [
  body('action').isIn(['accept', 'decline']),
], respondToJoinRequest);
router.post('/invites/:requestId/respond', authenticate, [
  body('action').isIn(['accept', 'decline']),
], respondToInvite);

router.put('/:id/settings', authenticate, [
  body('isPublic').optional().isBoolean(),
  body('description').optional().isLength({ max: 500 }),
], updateTeamSettings);

// ── Jamoa metkalari (team markers) ──
router.post('/:id/markers', authenticate, [
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
  body('label').optional().isLength({ max: 80 }),
], addTeamMarker);
router.delete('/markers/:markerId', authenticate, deleteTeamMarker);

// ── Marker-admin (Telegram-uslubidagi adminlik) ──
router.post('/:id/marker-admins', authenticate, [
  body('userId').notEmpty(),
], grantMarkerAdmin);
router.delete('/:id/marker-admins/:userId', authenticate, revokeMarkerAdmin);

router.delete('/:id', authenticate, deleteTeam);

module.exports = router;
