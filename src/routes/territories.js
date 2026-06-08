const router = require('express').Router();
const { getTerritories, getMyTerritories, removeTerritory, updateTerritoryName, getMyStats, captureFromRest, getTerritoryHistory } = require('../controllers/territoryController');
const { authenticate } = require('../middleware/auth');

router.get('/',          authenticate, getTerritories);
router.get('/mine',      authenticate, getMyTerritories);
router.get('/stats',     authenticate, getMyStats);
router.get('/history',   authenticate, getTerritoryHistory);
router.post('/capture',  authenticate, captureFromRest);
router.patch('/:id/name',authenticate, updateTerritoryName);
router.delete('/:id',    authenticate, removeTerritory);

module.exports = router;
