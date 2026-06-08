const router = require('express').Router();
const { body } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const {
  getShopItems, getMyShop, buyItem, equipItem, unequipItem, dailyClaim,
} = require('../controllers/shopController');

router.use(authenticate);

router.get('/items',    getShopItems);
router.get('/me',       getMyShop);
router.post('/buy',     [body('itemId').trim().notEmpty()], buyItem);
router.post('/equip',   [body('itemId').trim().notEmpty()], equipItem);
router.post('/unequip', unequipItem);
router.post('/daily',   dailyClaim);

module.exports = router;
