const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const {
  getShopItems, getMyShop, buyItem, equipItem, unequipItem, dailyClaim,
  buyTerritorySlot, buyExpansions, buyTeamCreate,
} = require('../controllers/shopController');

const p = require('../controllers/promoController');
const { getConsumables, buyConsumable } = require('../controllers/consumableController');

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
}

router.use(authenticate);

router.get('/items',    getShopItems);
router.get('/me',       getMyShop);
router.post('/buy',     [body('itemId').trim().notEmpty()], buyItem);
router.post('/equip',   [body('itemId').trim().notEmpty()], equipItem);
router.post('/unequip', unequipItem);
router.post('/daily',   dailyClaim);
router.post('/buy-territory-slot', buyTerritorySlot);
router.post('/buy-expansions',     buyExpansions);
router.post('/buy-team-create',    buyTeamCreate);

// Iste'mol buyumlari (shield / revive / XP boost / stealth) — skinlardan alohida
router.get('/consumables', getConsumables);
router.post('/buy-consumable', [
  body('itemId').trim().notEmpty().isLength({ max: 40 }),
  body('territoryId').optional({ checkFalsy: true }).isString().trim().isLength({ max: 64 }),
  body('useShieldToken').optional().isBoolean(),
], validate, buyConsumable);
router.post('/promocode/check', [body('code').trim().notEmpty()], p.checkPromoCode);

module.exports = router;
