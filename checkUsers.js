const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const users = await prisma.user.findMany({
    include: { territories: true }
  });

  for (const user of users) {
    console.log(`User ${user.username}: XP=${user.xp}, Level=${user.level}, Territories=${user.territories.length}`);
  }
}

run().finally(() => prisma.$disconnect());
