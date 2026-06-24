const { prisma } = require('../config/database');
const { sendExpoPush } = require('../services/captureEffects');
const logger = require('../utils/logger');
const { tierOf } = require('../config/tiers');

// Boshqa foydalanuvchiga ko'rinadigan PUBLIC maydonlar (profil privacy bilan bir xil siyosat)
const PUBLIC_USER_SELECT = {
  id: true, username: true, color: true, level: true, xp: true,
  totalArea: true, isOnline: true, isPremium: true, premiumUntil: true, premiumTier: true,
};

function mapPublicUser(u) {
  if (!u) return u;
  const now = new Date();
  return {
    ...u,
    isPremium: !!(u.isPremium && u.premiumUntil && now < new Date(u.premiumUntil)),
    tier: tierOf(u),
  };
}

// Ikki user orasidagi yozuvni (yo'nalishidan qat'i nazar) topish
function pairWhere(a, b) {
  return {
    OR: [
      { requesterId: a, addresseeId: b },
      { requesterId: b, addresseeId: a },
    ],
  };
}

// Qabul qilingan do'stliklardagi "qarshi tomon" id'lari — leaderboard ham ishlatadi.
// Set — nazariy race'da (ikkala yo'nalishda parallel so'rov) juft qator bo'lib
// qolsa ham natijada duplikat chiqmasligi uchun.
async function getFriendIds(userId) {
  const rows = await prisma.friendship.findMany({
    where: { status: 'accepted', OR: [{ requesterId: userId }, { addresseeId: userId }] },
    select: { requesterId: true, addresseeId: true },
  });
  return [...new Set(rows.map((r) => (r.requesterId === userId ? r.addresseeId : r.requesterId)))];
}

// GET /api/friends — do'stlar ro'yxati
async function listFriends(req, res, next) {
  try {
    const me = req.user.id;
    const rows = await prisma.friendship.findMany({
      where: { status: 'accepted', OR: [{ requesterId: me }, { addresseeId: me }] },
      include: {
        requester: { select: PUBLIC_USER_SELECT },
        addressee: { select: PUBLIC_USER_SELECT },
      },
      orderBy: { updatedAt: 'desc' },
    });
    // Dedupe — nazariy race'da juft (ikkala yo'nalishli) qator bo'lsa ham
    // bitta do'st faqat bir marta chiqadi.
    const seen = new Set();
    const friends = [];
    for (const r of rows) {
      const other = r.requesterId === me ? r.addressee : r.requester;
      if (seen.has(other.id)) continue;
      seen.add(other.id);
      friends.push({ friendshipId: r.id, since: r.updatedAt, ...mapPublicUser(other) });
    }
    res.json({ friends });
  } catch (err) { next(err); }
}

// GET /api/friends/requests — kelgan (incoming) va ketgan (outgoing) pending so'rovlar
async function listRequests(req, res, next) {
  try {
    const me = req.user.id;
    const [incomingRows, outgoingRows] = await Promise.all([
      prisma.friendship.findMany({
        where: { addresseeId: me, status: 'pending' },
        include: { requester: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.friendship.findMany({
        where: { requesterId: me, status: 'pending' },
        include: { addressee: { select: PUBLIC_USER_SELECT } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    res.json({
      incoming: incomingRows.map((r) => ({ requestId: r.id, createdAt: r.createdAt, ...mapPublicUser(r.requester) })),
      outgoing: outgoingRows.map((r) => ({ requestId: r.id, createdAt: r.createdAt, ...mapPublicUser(r.addressee) })),
    });
  } catch (err) { next(err); }
}

// GET /api/friends/search?q= — username bo'yicha qidiruv (har natijaga friendStatus qo'shiladi)
async function searchUsers(req, res, next) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json({ users: [] });

    const me = req.user.id;
    const users = await prisma.user.findMany({
      where: {
        username: { contains: q.trim(), mode: 'insensitive' },
        id: { not: me },
        isAdmin: false,
        isBanned: false,
      },
      select: PUBLIC_USER_SELECT,
      take: 10,
    });
    if (users.length === 0) return res.json({ users: [] });

    // Natijadagi userlar bilan mavjud aloqalarni bitta so'rovda olamiz
    const ids = users.map((u) => u.id);
    const links = await prisma.friendship.findMany({
      where: {
        OR: [
          { requesterId: me, addresseeId: { in: ids } },
          { addresseeId: me, requesterId: { in: ids } },
        ],
      },
      select: { requesterId: true, addresseeId: true, status: true },
    });
    const statusOf = new Map();
    for (const l of links) {
      const other = l.requesterId === me ? l.addresseeId : l.requesterId;
      if (l.status === 'accepted') statusOf.set(other, 'friends');
      else statusOf.set(other, l.requesterId === me ? 'pending_out' : 'pending_in');
    }

    res.json({
      users: users.map((u) => ({ ...mapPublicUser(u), friendStatus: statusOf.get(u.id) || 'none' })),
    });
  } catch (err) { next(err); }
}

// POST /api/friends/requests { username } — do'stlik so'rovi yuborish
async function sendRequest(req, res, next) {
  try {
    const me = req.user.id;
    const { username } = req.body;

    // isAdmin: false — qidiruv bilan bir xil siyosat (adminlarga so'rov yuborilmaydi)
    const target = await prisma.user.findFirst({
      where: { username: { equals: String(username).trim(), mode: 'insensitive' }, isBanned: false, isAdmin: false },
      select: { id: true, username: true, expoPushToken: true },
    });
    if (!target) return res.status(404).json({ error: 'Foydalanuvchi topilmadi' });
    if (target.id === me) return res.status(400).json({ error: 'O\'zingizga so\'rov yubora olmaysiz' });

    const existing = await prisma.friendship.findFirst({ where: pairWhere(me, target.id) });
    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(409).json({ error: 'Siz allaqachon do\'stsiz', code: 'ALREADY_FRIENDS' });
      }
      if (existing.requesterId === me) {
        return res.status(409).json({ error: 'So\'rov allaqachon yuborilgan', code: 'ALREADY_SENT' });
      }
      // U menga avval yuborgan ekan — bu o'zaro xohish: avtomatik qabul qilamiz
      const accepted = await prisma.friendship.update({
        where: { id: existing.id },
        data: { status: 'accepted' },
      });
      // Race'da qolib ketgan teskari pending qatorni tozalaymiz (acceptRequest bilan bir xil)
      await prisma.friendship.deleteMany({
        where: { id: { not: existing.id }, status: 'pending', ...pairWhere(me, target.id) },
      }).catch(() => {});
      return res.json({ friendship: accepted, autoAccepted: true });
    }

    let created;
    try {
      created = await prisma.friendship.create({
        data: { requesterId: me, addresseeId: target.id },
      });
    } catch (err) {
      // Parallel ikkita bir xil so'rov — unique constraint (P2002): dublikat sifatida qaytaramiz
      if (err.code === 'P2002') {
        return res.status(409).json({ error: 'So\'rov allaqachon yuborilgan', code: 'ALREADY_SENT' });
      }
      throw err;
    }

    // Push — best-effort, xato so'rov natijasiga ta'sir qilmaydi
    if (target.expoPushToken) {
      sendExpoPush(
        target.expoPushToken,
        'GeoRush — Do\'stlik so\'rovi 👋',
        `${req.user.username} sizga do'stlik so'rovi yubordi`,
      ).catch((err) => logger.warn('Friend request push failed', { err: err.message }));
    }

    res.status(201).json({ friendship: created, autoAccepted: false });
  } catch (err) { next(err); }
}

// PUT /api/friends/requests/:id/accept — kelgan so'rovni qabul qilish
async function acceptRequest(req, res, next) {
  try {
    const row = await prisma.friendship.findUnique({ where: { id: req.params.id } });
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'So\'rov topilmadi' });
    if (row.addresseeId !== req.user.id) return res.status(403).json({ error: 'Bu so\'rov sizga emas' });

    const accepted = await prisma.friendship.update({
      where: { id: row.id },
      data: { status: 'accepted' },
    });

    // O'z-o'zini davolash: nazariy race'da (ikkala tomon bir paytda yuborgan)
    // teskari yo'nalishdagi ortiqcha pending qator qolib ketgan bo'lsa — o'chiramiz,
    // aks holda "allaqachon do'st" bo'lsa ham incoming so'rov ko'rinib turadi.
    await prisma.friendship.deleteMany({
      where: {
        id: { not: row.id },
        status: 'pending',
        ...pairWhere(row.requesterId, row.addresseeId),
      },
    }).catch(() => {});

    res.json({ friendship: accepted });
  } catch (err) { next(err); }
}

// DELETE /api/friends/requests/:id — kelganini rad etish YOKI o'zim yuborganini bekor qilish
async function deleteRequest(req, res, next) {
  try {
    const row = await prisma.friendship.findUnique({ where: { id: req.params.id } });
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'So\'rov topilmadi' });
    if (row.addresseeId !== req.user.id && row.requesterId !== req.user.id) {
      return res.status(403).json({ error: 'Bu so\'rov sizga tegishli emas' });
    }
    await prisma.friendship.delete({ where: { id: row.id } });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

// DELETE /api/friends/:friendId — do'stlikdan chiqarish (friendId = user id)
async function removeFriend(req, res, next) {
  try {
    const me = req.user.id;
    const removed = await prisma.friendship.deleteMany({
      where: { status: 'accepted', ...pairWhere(me, req.params.friendId) },
    });
    if (removed.count === 0) return res.status(404).json({ error: 'Do\'stlik topilmadi' });
    res.json({ ok: true });
  } catch (err) { next(err); }
}

module.exports = {
  listFriends, listRequests, searchUsers,
  sendRequest, acceptRequest, deleteRequest, removeFriend,
  getFriendIds,
};
