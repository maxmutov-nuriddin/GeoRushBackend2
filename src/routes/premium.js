const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getStatus, sendInvoice } = require('../controllers/premiumController');

router.use(authenticate);
router.get('/status',       getStatus);
router.post('/send-invoice', sendInvoice);

module.exports = router;
