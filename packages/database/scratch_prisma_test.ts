import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const count = await prisma.datasetItem.count({
    where: {
      data: {
        path: ['detailStatus'],
        equals: 'FAILED'
      }
    }
  })
  console.log("FAILED count:", count)
}
main().catch(console.error).finally(() => prisma.$disconnect())
