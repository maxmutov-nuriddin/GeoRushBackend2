const jwt = require('jsonwebtoken');
const { prisma } = require('../config/database');

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true, username: true, phone: true, teamId: true, color: true, xp: true, level: true,
        totalArea: true, totalDistance: true, territoriesCaptured: true, territoriesLost: true,
        isOnline: true, expoPushToken: true, termsAccepted: true, isAdmin: true, isBanned: true,
        coins: true, ownedSkins: true, activeSkinColor: true, activeSkinMarker: true, activeSkinTrail: true,
        isPremium: true, premiumUntil: true, premiumTier: true
      }
    });

    if (!user) return res.status(401).json({ error: 'User not found' });
    if (user.isBanned) return res.status(403).json({ error: 'Akkaunt bloklangan', code: 'BANNED' });
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Authentication required'));

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}

module.exports = { authenticate, authenticateSocket };
