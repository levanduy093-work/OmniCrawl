import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
dotenv.config({ quiet: true });

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export * from '@prisma/client';
