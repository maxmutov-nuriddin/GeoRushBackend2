const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: "postgresql://postgres.iigfuovsxfoqyriohzjn:2JzaeksE0NfrxSze@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true" } } });
async function check() {
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
  console.log("Admin exists:", !!admin);
  if (admin) console.log("Admin username:", admin.username);
}
check().finally(() => prisma.$disconnect());
