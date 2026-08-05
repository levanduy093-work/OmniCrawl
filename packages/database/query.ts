import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const items = await prisma.datasetItem.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  for (const item of items) {
    console.log(item.data);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
