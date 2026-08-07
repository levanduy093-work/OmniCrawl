const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const count = await prisma.actor.count();
  console.log('Total actors:', count);
  const actors = await prisma.actor.findMany({
    select: { name: true, userId: true }
  });
  console.log('Actors:', actors);
}
main().catch(console.error).finally(() => prisma.$disconnect());
