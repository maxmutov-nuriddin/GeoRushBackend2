const { authenticate } = require('./auth');

function adminAuth(req, res, next) {
  authenticate(req, res, () => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin huquqi kerak' });
    }
    next();
  });
}

module.exports = { adminAuth };
