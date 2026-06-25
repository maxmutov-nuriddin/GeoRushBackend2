const { validationResult } = require('express-validator');
const { prisma } = require('../config/database');
const { getIo } = require('../socket/ioInstance');
const { setPlayerTeam } = require('../socket');
const { tierOf, entitlements, effectiveTeamMax } = require('../config/tiers');

async function createTeam(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { teamId: true, isPremium: true, premiumUntil: true, premiumTier: true, purchasedTeamCreate: true }
    });
    if (user.teamId) return res.status(400).json({ error: 'Leave your current team first' });

    // Pro/Ultra — tier orqali; Free — coin bilan sotib olgan bo'lsa (purchasedTeamCreate) ruxsat.
    if (!entitlements(tierOf(user)).teamCreate && !user.purchasedTeamCreate) {
      return res.status(403).json({ error: 'Jamoa yaratish uchun Pro/Ultra yoki do\'kondan sotib oling', code: 'TEAM_LOCKED' });
    }

    const { name, tag, color = '#ff6600', description = '', isPublic = true } = req.body;

    const team = await prisma.team.create({
      data: {
        name,
        tag: tag.toUpperCase(),
        color,
        description,
        isPublic,
        ownerId: req.user.id,
        memberCount: 1,
      }
    });

    await prisma.user.update({
      where: { id: req.user.id },
      data: { teamId: team.id }
    });

    const io = getIo();
    if (io) setPlayerTeam(io, req.user.id, team.id);

    res.status(201).json({ team });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Team name or tag already taken' });
    next(err);
  }
}

async function getTeam(req, res, next) {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: {
        owner: { select: { username: true } },
        markerAdmins: { select: { id: true } }
      }
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const now = new Date();
    const members = await prisma.user.findMany({
      where: { teamId: team.id },
      select: { id: true, username: true, color: true, xp: true, level: true, totalArea: true, isPremium: true, premiumUntil: true, premiumTier: true },
      orderBy: { xp: 'desc' }
    });

    const membersWithPremium = members.map(m => ({
      ...m,
      isPremium: !!(m.isPremium && m.premiumUntil && now < new Date(m.premiumUntil)),
      tier: tierOf(m)
    }));

    res.json({
      team: {
        ...team,
        ownerUsername: team.owner?.username,
        markerAdmins: team.markerAdmins.map(m => m.id),
      },
      members: membersWithPremium,
    });
  } catch (err) {
    next(err);
  }
}

async function listTeams(req, res, next) {
  try {
    // Chegaralangan pagination — `?limit=999999` kabi so'rov katta javob/DoS yaratmasin.
    // page >= 1, limit 1..100 (default 20). Noto'g'ri/manfiy/NaN qiymatlar default'ga tushadi.
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const teams = await prisma.team.findMany({
      orderBy: { totalArea: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    res.json({ teams });
  } catch (err) {
    next(err);
  }
}

async function joinTeam(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { teamId: true }
    });
    if (user.teamId) return res.status(400).json({ error: 'Leave your current team first' });

    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (!team.isPublic) return res.status(403).json({ error: 'Team is private', code: 'PRIVATE_TEAM' });

    const owner = await prisma.user.findUnique({
      where: { id: team.ownerId },
      select: { isPremium: true, premiumUntil: true, premiumTier: true, purchasedTeamCreate: true }
    });

    // Atomik a'zolik: maxMembers cheklovi bo'lsa, faqat bo'sh slot qolganda memberCount oshadi.
    // Avval `team.memberCount >= max` ALOHIDA o'qilardi → ikki parallel join bir xil qiymatni
    // o'qib jamoa limitdan oshib ketishi mumkin edi. updateMany WHERE memberCount < max atomik —
    // parallel join'da faqat bo'sh slotlar soni qadar muvaffaqiyat bo'ladi (mantiq o'zgarmaydi:
    // ketma-ket join'da xulq aynan eski — bitta join, bitta slot).
    const maxMembers = owner ? effectiveTeamMax(owner) : Infinity;
    if (Number.isFinite(maxMembers)) {
      const bumped = await prisma.team.updateMany({
        where: { id: team.id, memberCount: { lt: maxMembers } },
        data: { memberCount: { increment: 1 } }
      });
      if (bumped.count === 0) {
        return res.status(403).json({ error: `Jamoa to'lgan (maksimal ${maxMembers} a'zo)`, code: 'TEAM_FULL' });
      }
    } else {
      await prisma.team.update({
        where: { id: team.id },
        data: { memberCount: { increment: 1 } }
      });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { teamId: team.id }
    });

    const io = getIo();
    if (io) setPlayerTeam(io, req.user.id, team.id);

    res.json({ message: 'Joined team successfully' });
  } catch (err) {
    next(err);
  }
}

async function leaveTeam(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { teamId: true }
    });
    if (!user.teamId) return res.status(400).json({ error: 'You are not in a team' });

    const team = await prisma.team.findUnique({ where: { id: user.teamId } });
    if (!team) return res.status(400).json({ error: 'Team not found' });

    const isOwner = team.ownerId === req.user.id;

    if (isOwner) {
      const otherMembersCount = await prisma.user.count({
        where: { teamId: team.id, id: { not: req.user.id } }
      });

      if (otherMembersCount > 0) {
        return res.status(400).json({ error: 'Transfer ownership first', code: 'MUST_TRANSFER' });
      }
      
      await prisma.user.update({
        where: { id: req.user.id },
        data: { teamId: null }
      });
      await prisma.teamRequest.deleteMany({ where: { teamId: team.id } });
      await prisma.team.delete({ where: { id: team.id } });
      
      const io0 = getIo();
      if (io0) setPlayerTeam(io0, req.user.id, null);
      return res.json({ message: 'Left and team deleted', deleted: true });
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data: { teamId: null }
    });
    
    await prisma.team.update({
      where: { id: team.id },
      data: { memberCount: { decrement: 1 } }
    });

    const io1 = getIo();
    if (io1) setPlayerTeam(io1, req.user.id, null);

    res.json({ message: 'Left team successfully' });
  } catch (err) {
    next(err);
  }
}

async function deleteTeam(req, res, next) {
  try {
    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only the team owner can delete the team' });
    }

    const members = await prisma.user.findMany({
      where: { teamId: team.id },
      select: { id: true }
    });
    
    await prisma.user.updateMany({
      where: { teamId: team.id },
      data: { teamId: null }
    });
    await prisma.teamRequest.deleteMany({ where: { teamId: team.id } });
    await prisma.teamMarker.deleteMany({ where: { teamId: team.id } });
    await prisma.team.delete({ where: { id: team.id } });

    const io = getIo();
    if (io) {
      for (const m of members) setPlayerTeam(io, m.id, null);
    }
    res.json({ message: 'Team deleted' });
  } catch (err) {
    next(err);
  }
}

async function updateTeamSettings(req, res, next) {
  try {
    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only the team owner can update settings' });
    }
    
    const data = {};
    if (req.body.isPublic !== undefined) data.isPublic = req.body.isPublic;
    if (req.body.description !== undefined) data.description = req.body.description;
    
    const updatedTeam = await prisma.team.update({
      where: { id: team.id },
      data
    });
    res.json({ team: updatedTeam });
  } catch (err) {
    next(err);
  }
}

async function transferOwnership(req, res, next) {
  try {
    const { newOwnerId } = req.body;
    if (!newOwnerId) return res.status(400).json({ error: 'newOwnerId required' });

    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only the team owner can transfer ownership' });
    }
    if (newOwnerId === req.user.id) {
      return res.status(400).json({ error: 'Already the owner' });
    }

    const newOwner = await prisma.user.findFirst({
      where: { id: newOwnerId, teamId: team.id },
      select: { id: true }
    });
    if (!newOwner) return res.status(400).json({ error: 'User is not a team member' });

    await prisma.team.update({
      where: { id: team.id },
      data: { ownerId: newOwnerId }
    });
    res.json({ message: 'Ownership transferred' });
  } catch (err) {
    next(err);
  }
}

async function sendJoinRequest(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { teamId: true, username: true }
    });
    if (user.teamId) return res.status(400).json({ error: 'Leave your current team first' });

    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.isPublic) return res.status(400).json({ error: 'Team is public, join directly' });

    const existing = await prisma.teamRequest.findFirst({
      where: { teamId: team.id, userId: req.user.id, type: 'request', status: 'pending' }
    });
    if (existing) return res.status(409).json({ error: 'Request already sent' });

    const request = await prisma.teamRequest.create({
      data: { teamId: team.id, userId: req.user.id, type: 'request' }
    });

    await prisma.notification.create({
      data: {
        userId: team.ownerId,
        title: 'Yangi zayavka',
        body: `${user.username} jamoangizga qo'shilish uchun zayavka yubordi.`
      }
    });

    res.json({ request });
  } catch (err) {
    next(err);
  }
}

async function getJoinRequests(req, res, next) {
  try {
    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only team owner can view requests' });
    }

    const requests = await prisma.teamRequest.findMany({
      where: { teamId: team.id, type: 'request', status: 'pending' },
      include: {
        user: { select: { username: true, color: true, level: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ requests });
  } catch (err) {
    next(err);
  }
}

async function respondToJoinRequest(req, res, next) {
  try {
    const { action } = req.body; 
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'action must be accept or decline' });
    }

    const request = await prisma.teamRequest.findUnique({ where: { id: req.params.requestId } });
    if (!request || request.type !== 'request') return res.status(404).json({ error: 'Request not found' });

    const team = await prisma.team.findUnique({ where: { id: request.teamId } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only team owner can respond' });
    }

    if (action === 'accept') {
      const targetUser = await prisma.user.findUnique({
        where: { id: request.userId },
        select: { teamId: true }
      });
      if (targetUser?.teamId) {
        await prisma.teamRequest.update({
          where: { id: request.id },
          data: { status: 'declined' }
        });
        return res.status(400).json({ error: 'User is already in a team' });
      }
      
      const owner = await prisma.user.findUnique({
        where: { id: team.ownerId },
        select: { isPremium: true, premiumUntil: true, premiumTier: true, purchasedTeamCreate: true }
      });

      // Atomik a'zolik (joinTeam bilan bir xil himoya) — parallel accept'da limit oshmaydi.
      const maxMembers = owner ? effectiveTeamMax(owner) : Infinity;
      if (Number.isFinite(maxMembers)) {
        const bumped = await prisma.team.updateMany({
          where: { id: team.id, memberCount: { lt: maxMembers } },
          data: { memberCount: { increment: 1 } }
        });
        if (bumped.count === 0) {
          return res.status(403).json({ error: `Jamoa to'lgan (maksimal ${maxMembers} a'zo)`, code: 'TEAM_FULL' });
        }
      } else {
        await prisma.team.update({
          where: { id: team.id },
          data: { memberCount: { increment: 1 } }
        });
      }

      await prisma.user.update({
        where: { id: request.userId },
        data: { teamId: team.id }
      });

      await prisma.teamRequest.updateMany({
        where: { userId: request.userId, status: 'pending', id: { not: request.id } },
        data: { status: 'declined' }
      });
      
      await prisma.teamRequest.update({
        where: { id: request.id },
        data: { status: 'accepted' }
      });
      
      const io = getIo();
      if (io) setPlayerTeam(io, request.userId, team.id);
    } else {
      await prisma.teamRequest.update({
        where: { id: request.id },
        data: { status: 'declined' }
      });
    }
    
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function inviteUser(req, res, next) {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });

    const team = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only team owner can invite' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { username },
      select: { id: true, teamId: true, username: true }
    });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });
    if (targetUser.teamId) return res.status(400).json({ error: 'User is already in a team' });

    const existing = await prisma.teamRequest.findFirst({
      where: { teamId: team.id, userId: targetUser.id, type: 'invite', status: 'pending' }
    });
    
    if (existing) return res.json({ request: existing, username: targetUser.username, alreadySent: true });

    const request = await prisma.teamRequest.create({
      data: { teamId: team.id, userId: targetUser.id, type: 'invite' }
    });

    await prisma.notification.create({
      data: {
        userId: targetUser.id,
        title: 'Jamoaga taklif',
        body: `Sizni "${team.name}" jamoasiga taklif qilishdi.`
      }
    });

    res.json({ request, username: targetUser.username });
  } catch (err) {
    next(err);
  }
}

async function getMyInvites(req, res, next) {
  try {
    const invites = await prisma.teamRequest.findMany({
      where: { userId: req.user.id, type: 'invite', status: 'pending' },
      include: {
        team: { select: { id: true, name: true, tag: true, color: true, isPublic: true, memberCount: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const joinRequests = await prisma.teamRequest.findMany({
      where: { userId: req.user.id, type: 'request', status: 'pending' },
      include: {
        team: { select: { id: true, name: true, tag: true, color: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({ 
      invites: invites.map(i => ({ ...i, teamId: i.team })), 
      joinRequests: joinRequests.map(j => ({ ...j, teamId: j.team })) 
    });
  } catch (err) {
    next(err);
  }
}

async function respondToInvite(req, res, next) {
  try {
    const { action } = req.body;
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'action must be accept or decline' });
    }

    const request = await prisma.teamRequest.findUnique({ where: { id: req.params.requestId } });
    if (!request || request.type !== 'invite') return res.status(404).json({ error: 'Invite not found' });
    if (request.userId !== req.user.id) {
      return res.status(403).json({ error: 'Not your invite' });
    }

    if (action === 'accept') {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { teamId: true }
      });
      if (user.teamId) return res.status(400).json({ error: 'Leave your current team first' });

      const team = await prisma.team.findUnique({ where: { id: request.teamId } });
      if (!team) return res.status(404).json({ error: 'Team not found' });

      await prisma.user.update({
        where: { id: req.user.id },
        data: { teamId: team.id }
      });
      await prisma.team.update({
        where: { id: team.id },
        data: { memberCount: { increment: 1 } }
      });

      await prisma.teamRequest.updateMany({
        where: { userId: req.user.id, status: 'pending', id: { not: request.id } },
        data: { status: 'declined' }
      });
      
      await prisma.teamRequest.update({
        where: { id: request.id },
        data: { status: 'accepted' }
      });
      
      const io = getIo();
      if (io) setPlayerTeam(io, req.user.id, team.id);
    } else {
      await prisma.teamRequest.update({
        where: { id: request.id },
        data: { status: 'declined' }
      });
    }
    
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function searchUsers(req, res, next) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 1) return res.json({ users: [] });

    const users = await prisma.user.findMany({
      where: {
        username: { contains: q.trim(), mode: 'insensitive' },
        teamId: null,
        id: { not: req.user.id },
        isAdmin: false,
        isBanned: false,
      },
      select: { id: true, username: true, color: true, level: true, isPremium: true, premiumUntil: true, premiumTier: true },
      take: 10,
    });

    const now = new Date();
    res.json({ 
      users: users.map(u => ({ 
        ...u, 
        _id: u.id,
        isPremium: !!(u.isPremium && u.premiumUntil && now < new Date(u.premiumUntil)),
        tier: tierOf(u)
      })) 
    });
  } catch (err) {
    next(err);
  }
}

// ─── Jamoa metkalari (team markers) ──────────────────────────────────────────

function canManageMarkers(team, userId) {
  if (team.ownerId === userId) return true;
  return (team.markerAdmins || []).some(admin => admin.id === userId);
}

async function broadcastMarkers(teamId) {
  const io = getIo();
  if (!io) return;
  const markers = await prisma.teamMarker.findMany({
    where: { teamId },
    orderBy: { order: 'asc' }
  });
  io.to(`team:${teamId}`).emit('team:markers', { markers });
}

async function getTeamMarkers(req, res, next) {
  try {
    if (!req.user.teamId || req.user.teamId !== req.params.id) {
      return res.status(403).json({ error: 'Not your team' });
    }
    const markers = await prisma.teamMarker.findMany({
      where: { teamId: req.params.id },
      orderBy: { order: 'asc' }
    });
    res.json({ markers });
  } catch (err) {
    next(err);
  }
}

async function addTeamMarker(req, res, next) {
  try {
    const { lat, lng, label } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat/lng required' });
    }
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: { markerAdmins: { select: { id: true } } }
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (!canManageMarkers(team, req.user.id)) {
      return res.status(403).json({ error: 'No permission to add team markers' });
    }
    
    const count = await prisma.teamMarker.count({ where: { teamId: team.id } });
    if (count >= 50) return res.status(400).json({ error: 'Marker limit reached (50)' });

    const marker = await prisma.teamMarker.create({
      data: {
        teamId: team.id,
        lat,
        lng,
        label: String(label || '').slice(0, 80),
        order: count + 1,
        createdById: req.user.id,
      }
    });
    await broadcastMarkers(team.id);
    res.json({ marker });
  } catch (err) {
    next(err);
  }
}

async function deleteTeamMarker(req, res, next) {
  try {
    const marker = await prisma.teamMarker.findUnique({ where: { id: req.params.markerId } });
    if (!marker) return res.status(404).json({ error: 'Marker not found' });
    
    const team = await prisma.team.findUnique({
      where: { id: marker.teamId },
      include: { markerAdmins: { select: { id: true } } }
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    
    if (!canManageMarkers(team, req.user.id)) {
      return res.status(403).json({ error: 'No permission to delete team markers' });
    }
    
    await prisma.teamMarker.delete({ where: { id: marker.id } });
    
    const rest = await prisma.teamMarker.findMany({
      where: { teamId: team.id },
      orderBy: { order: 'asc' }
    });
    
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].order !== i + 1) {
        await prisma.teamMarker.update({
          where: { id: rest[i].id },
          data: { order: i + 1 }
        });
      }
    }
    
    await broadcastMarkers(team.id);
    res.json({ message: 'Marker deleted' });
  } catch (err) {
    next(err);
  }
}

async function grantMarkerAdmin(req, res, next) {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: { markerAdmins: { select: { id: true } } }
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only the team owner can grant marker admin' });
    }
    if (userId === team.ownerId) {
      return res.status(400).json({ error: 'Owner is always an admin' });
    }
    
    const member = await prisma.user.findFirst({
      where: { id: userId, teamId: team.id },
      select: { id: true }
    });
    if (!member) return res.status(400).json({ error: 'User is not a team member' });

    await prisma.team.update({
      where: { id: team.id },
      data: {
        markerAdmins: {
          connect: { id: userId }
        }
      }
    });
    
    const updatedTeam = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: { markerAdmins: { select: { id: true } } }
    });
    
    const markerAdmins = updatedTeam.markerAdmins.map(admin => admin.id);
    const io = getIo();
    if (io) io.to(`team:${team.id}`).emit('team:markerAdmins', { markerAdmins });
    res.json({ markerAdmins });
  } catch (err) {
    next(err);
  }
}

async function revokeMarkerAdmin(req, res, next) {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id }
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (team.ownerId !== req.user.id) {
      return res.status(403).json({ error: 'Only the team owner can revoke marker admin' });
    }
    
    await prisma.team.update({
      where: { id: team.id },
      data: {
        markerAdmins: {
          disconnect: { id: req.params.userId }
        }
      }
    });
    
    const updatedTeam = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: { markerAdmins: { select: { id: true } } }
    });
    
    const markerAdmins = updatedTeam.markerAdmins.map(admin => admin.id);
    const io = getIo();
    if (io) io.to(`team:${team.id}`).emit('team:markerAdmins', { markerAdmins });
    res.json({ markerAdmins });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createTeam, getTeam, listTeams, joinTeam, leaveTeam, deleteTeam,
  updateTeamSettings, transferOwnership,
  sendJoinRequest, getJoinRequests, respondToJoinRequest,
  inviteUser, getMyInvites, respondToInvite,
  searchUsers,
  getTeamMarkers, addTeamMarker, deleteTeamMarker,
  grantMarkerAdmin, revokeMarkerAdmin,
};
