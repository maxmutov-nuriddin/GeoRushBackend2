const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const f = require('../controllers/familyCircleController');

// "Oila Doirasi" — doimiy oilaviy xavfsizlik. Hammasi authenticate ostida.
// Ruxsatlar controller ichida (parent/child roli, a'zolik) tekshiriladi.
router.post('/create',            authenticate, f.create);
router.post('/join',              authenticate, f.join);
router.get('/mine',               authenticate, f.mine);
router.post('/:id/zones',         authenticate, f.addZone);
router.delete('/:id/zones/:zoneId', authenticate, f.removeZone);
router.get('/:id/events',         authenticate, f.events);
router.post('/:id/leave',         authenticate, f.leave);
router.post('/:id/remove',        authenticate, f.removeMember);

module.exports = router;
