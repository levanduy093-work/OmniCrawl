import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });

const prisma = new PrismaClient();

async function main() {
  console.log('Start seeding...');
  
  // Create a default user if none exists
  const existingUser = await prisma.user.findUnique({
    where: { email: 'admin@omnicrawl.local' }
  });
  const hashedPassword = await bcrypt.hash('password123', 10);
  const passwordUpgrade = existingUser && !existingUser.password.startsWith('$2')
    ? { password: await bcrypt.hash(existingUser.password, 10) }
    : {};

  const user = await prisma.user.upsert({
    where: { email: 'admin@omnicrawl.local' },
    update: {
      ...passwordUpgrade,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    create: {
      email: 'admin@omnicrawl.local',
      password: hashedPassword,
      role: 'ADMIN',
      status: 'ACTIVE',
      credits: 1000,
    },
  });

  console.log(`User created with id: ${user.id}`);

  const shopeeInputSchema = JSON.stringify({
    type: 'object',
    required: ['keyword'],
    properties: {
      keyword: {
        type: 'string',
        title: 'Từ khóa tìm kiếm',
        minLength: 1
      },
      maxItems: {
        type: 'integer',
        title: 'Số sản phẩm tối đa',
        minimum: 1,
        maximum: 500,
        default: 50
      },
      allowEmpty: {
        type: 'boolean',
        title: 'Cho phép kết quả rỗng',
        default: false
      }
    }
  });
  const shopeeOutputSchema = JSON.stringify({
    type: 'object',
    required: ['itemId', 'shopId', 'title', 'price', 'url'],
    properties: {
      itemId: { type: 'string', title: 'Mã sản phẩm' },
      shopId: { type: 'string', title: 'Mã cửa hàng' },
      title: { type: 'string', title: 'Tên sản phẩm' },
      price: { type: 'string', title: 'Giá bán' },
      sold: { type: ['string', 'number'], title: 'Đã bán' },
      url: { type: 'string', format: 'uri', title: 'Liên kết sản phẩm' },
      image: { type: 'string', format: 'uri', title: 'Hình ảnh' }
    }
  });

  // Create Shopee scraper actor
  const actor = await prisma.actor.upsert({
    where: { name: 'shopee-scraper' },
    update: {
      userId: null,
      inputSchema: shopeeInputSchema,
      outputSchema: shopeeOutputSchema
    },
    create: {
      name: 'shopee-scraper',
      description: 'Advanced stealth scraper for Shopee VN search results using Crawlee.',
      userId: null,
      inputSchema: shopeeInputSchema,
      outputSchema: shopeeOutputSchema
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
