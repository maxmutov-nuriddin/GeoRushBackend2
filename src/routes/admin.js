const router = require('express').Router();
const { adminAuth } = require('../middleware/adminAuth');
const c = require('../controllers/adminController');
const ins = require('../controllers/adminInsightsController');
const { sendBroadcast } = require('../controllers/adminBroadcastController');
const { getAuditLog } = require('../services/auditLog');

router.use(adminAuth);

// ─── Insights (read-only analitika — yangi) ─────────────────────────────────────
router.get('/insights/geo',            ins.getGeoDistribution);
router.get('/insights/revenue',        ins.getRevenueBreakdown);
router.get('/insights/referrals',      ins.getReferralFunnel);
router.get('/insights/retention',      ins.getRetentionCohorts);
router.get('/insights/repeat-cheaters',ins.getRepeatCheaters);
router.get('/insights/support',        ins.getSupportMetrics);
router.get('/insights/promo-stats',    ins.getPromoStats);

// ─── Broadcast push (action — yangi) ────────────────────────────────────────────
router.post('/broadcast',              sendBroadcast);

// ─── Audit log (kim qaysi admin amalini qildi — yangi) ──────────────────────────
router.get('/audit',                   getAuditLog);

// ─── Own profile ───────────────────────────────────────────────────────────────
router.get('/me',                          c.getMe);
router.patch('/me',                        c.updateMe);
router.post('/me/verify-password',         c.verifyPassword);
router.patch('/me/password',               c.changePassword);

// ─── Stats & Live ──────────────────────────────────────────────────────────────
router.get('/stats',                       c.getStats);
router.get('/online',                      c.getOnline);
router.get('/live-map',                    c.getLiveMap);

// ─── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics',                   c.getAnalytics);

// ─── Economy ──────────────────────────────────────────────────────────────────
router.get('/economy',                     c.getEconomy);
router.post('/economy/season-reset',       c.seasonReset);

// ─── Anti-Cheat ───────────────────────────────────────────────────────────────
router.get('/anticheat',                   c.getAntiCheatLogs);
router.delete('/anticheat',                c.clearAntiCheatLogs);
router.get('/anticheat/user/:id',          c.getUserAntiCheat);

// ─── Users ────────────────────────────────────────────────────────────────────
router.get('/users',                       c.getUsers);
router.get('/users/:id',                   c.getUser);
router.patch('/users/:id',                 c.updateUser);
router.patch('/users/:id/ban',             c.banUser);
router.patch('/users/:id/role',            c.toggleAdmin);
router.post('/users/:id/coins',            c.giveCoins);
router.post('/users/:id/premium',          c.givePremium);
router.delete('/users/:id/premium',        c.removePremium);
router.delete('/users/:id',               c.deleteUser);
router.get('/users/:id/warnings',          c.getUserWarnings);
router.post('/users/:id/warnings',         c.addWarning);
router.delete('/users/:id/warnings/:wid',  c.deleteWarning);
router.get('/users/:id/activity',          c.getUserActivity);
router.get('/users/:id/anticheat',         c.getUserAntiCheat);

// ─── Territories ──────────────────────────────────────────────────────────────
router.get('/territories',                 c.getTerritories);
router.post('/territories/merge',          c.mergeTerritories); // ?apply=true → birlashtiradi
router.delete('/territories/:id',          c.deleteTerritory);
router.get('/territories/:id/history',     c.getTerritoryHistory);

// ─── Teams ────────────────────────────────────────────────────────────────────
router.get('/teams',                       c.getTeams);
router.delete('/teams/:id',               c.deleteTeam);

// ─── Events ───────────────────────────────────────────────────────────────────
router.get('/events',                      c.getEvents);

// ─── Promo Codes ──────────────────────────────────────────────────────────────
const p = require('../controllers/promoController');
router.post('/promocodes',                 p.createPromoCode);
router.get('/promocodes',                  p.getPromoCodes);
router.patch('/promocodes/:id',            p.togglePromoCode);
router.delete('/promocodes/:id',           p.deletePromoCode);

// ─── Support Chat ──────────────────────────────────────────────────────────────
const supportRoutes = require('./adminSupport');
router.use('/support', supportRoutes);

module.exports = router;
