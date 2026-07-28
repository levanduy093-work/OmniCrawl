import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Start seeding...');
  
  // Create a default user if none exists
  const user = await prisma.user.upsert({
    where: { email: 'admin@omnicrawl.local' },
    update: {},
    create: {
      email: 'admin@omnicrawl.local',
      password: 'password123', // In a real app this would be hashed
      credits: 1000,
    },
  });

  console.log(`User created with id: ${user.id}`);

  // Create Shopee scraper actor
  const actor = await prisma.actor.upsert({
    where: { name: 'shopee-scraper' },
    update: {
      userId: user.id
    },
    create: {
      name: 'shopee-scraper',
      description: 'Advanced stealth scraper for Shopee VN search results using Crawlee.',
      userId: user.id
    }
  });

  console.log(`Actor seeded: ${actor.name}`);
  
  console.log('Seeding finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
