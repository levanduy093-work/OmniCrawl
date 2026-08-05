const { PrismaClient } = require('./packages/database/node_modules/@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const items = await prisma.datasetItem.findMany({
    take: 1,
    orderBy: { createdAt: 'desc' },
  });
  console.log(JSON.stringify(items, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
