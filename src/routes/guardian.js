const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const g = require('../controllers/guardianController');

// "Hamroh" — yolg'iz yuruvchini ishonchli do'st jonli kuzatishi.
// Hammasi authenticate ostida; hamroh faqat accepted do'st bo'la oladi (controller tekshiradi).
router.post('/invite',      authenticate, g.invite);
router.post('/:id/accept',  authenticate, g.accept);
router.post('/:id/decline', authenticate, g.decline);
router.post('/:id/end',     authenticate, g.end);
router.post('/:id/sos',     authenticate, g.sos);
router.get('/active',       authenticate, g.activeSessions);

module.exports = router;
