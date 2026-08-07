import express from 'express';
import cors from 'cors';
import { prisma } from '@omnicrawl/database';
import {
  Dataset,
  RUN_OUTPUT_KIND,
  readRunInput,
  readRunInputDocument,
  readRunOutput,
  removeRunStorage,
  writeRunInput
} from '@omnicrawl/sdk';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { CronExpressionParser } from 'cron-parser';
import {
  disconnectShopeeSession,
  getShopeeSession,
  startShopeeConnection
} from './shopeeSessionManager';
import {
  startProxyServer,
  checkAllProxies,
  getProxyStats
} from './proxy-server';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'omnicrawl-secret-key-12345';
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const STORAGE_ROOT = path.join(WORKSPACE_ROOT, 'storage');
const BROWSER_ACTOR_NAMES = ['shopee-scraper', 'tiktok-scraper'];
const browserAgentHeartbeats = new Map<string, { version: string; seenAt: number }>();
const BROWSER_AGENT_HEARTBEAT_TTL_MS = 15_000;
const SHOPEE_UNUSED_OUTPUT_FIELDS = new Set([
  'author',
  'authorId',
  'authorUrl',
  'categoryId',
  'comments',
  'discountPercent',
  'duration',
  'hashtags',
  'likes',
  'logistics',
  'musicTitle',
  'promotions',
  'publishedAt',
  'reviewCount',
  'reviews',
  'reviewsCollected',
  'reviewsError',
  'reviewsRatingAverage',
  'reviewsStatus',
  'reviewsWithRating',
  'salesLast30Days',
  'saves',
  'shares',
  'shopDescription',
  'sourceType',
  'totalSold',
  'productUpdatedAt',
  'videos',
  'viewCount',
  'views'
]);

function appendRunLog(runId: string, message: string) {
  const logsDir = path.join(STORAGE_ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.appendFileSync(path.join(logsDir, `${runId}.log`), `${message}\n`);
}

function normalizeActorInput(schemaJson: string | null, rawInput: Record<string, unknown>) {
  if (!schemaJson) return rawInput;

  let schema: any;
  try {
    schema = JSON.parse(schemaJson);
  } catch {
    throw new Error('Actor input schema is invalid');
  }

  const input: Record<string, unknown> = { ...rawInput };
  const invalidInput = (message: string): never => {
    const error = new Error(message);
    error.name = 'ActorInputValidationError';
    throw error;
  };
  const properties = schema?.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};

  for (const [key, propertyValue] of Object.entries(properties)) {
    const property: any = propertyValue;
    if ((input[key] === undefined || input[key] === '') && property.default !== undefined) {
      input[key] = property.default;
    }
    if (
      (property.type === 'integer' || property.type === 'number') &&
      input[key] !== undefined &&
      input[key] !== ''
    ) {
      const numberValue = Number(input[key]);
      if (!Number.isFinite(numberValue)) invalidInput(`${key} must be a number`);
      input[key] = property.type === 'integer' ? Math.trunc(numberValue) : numberValue;
    }
  }

  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (input[key] === undefined || input[key] === null || input[key] === '') {
      invalidInput(`${key} is required`);
    }
  }

  for (const [key, value] of Object.entries(input)) {
    const property: any = properties[key];
    if (!property) continue;
    if (property.type === 'string' && typeof value !== 'string') {
      invalidInput(`${key} must be a string`);
    }
    if (property.type === 'boolean' && typeof value !== 'boolean') {
      invalidInput(`${key} must be a boolean`);
    }
    if (property.type === 'integer' && !Number.isInteger(value)) {
      invalidInput(`${key} must be an integer`);
    }
    if (
      typeof value === 'string' &&
      typeof property.minLength === 'number' &&
      value.trim().length < property.minLength
    ) {
      invalidInput(`${key} is too short`);
    }
    if (typeof value === 'number' && typeof property.minimum === 'number' && value < property.minimum) {
      invalidInput(`${key} must be at least ${property.minimum}`);
    }
    if (typeof value === 'number' && typeof property.maximum === 'number' && value > property.maximum) {
      invalidInput(`${key} must be at most ${property.maximum}`);
    }
  }

  return input;
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function outputSchemaColumns(schemaJson: string | null) {
  if (!schemaJson) return [];
  try {
    const schema = JSON.parse(schemaJson);
    return schema?.properties && typeof schema.properties === 'object'
      ? Object.keys(schema.properties)
      : [];
  } catch {
    return [];
  }
}

function compactActorRecord(actorName: string, value: unknown) {
  if (
    actorName !== 'shopee-scraper' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => (
      !SHOPEE_UNUSED_OUTPUT_FIELDS.has(field)
    ))
  );
}

function compactActorOutputSchema(actorName: string, schemaJson: string | null) {
  if (actorName !== 'shopee-scraper' || !schemaJson) return schemaJson;
  try {
    const schema = JSON.parse(schemaJson);
    if (!schema?.properties || typeof schema.properties !== 'object') return schemaJson;
    return JSON.stringify({
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).filter(([field]) => (
          !SHOPEE_UNUSED_OUTPUT_FIELDS.has(field)
        ))
      )
    });
  } catch {
    return schemaJson;
  }
}

function compactActorInputSchema(actorName: string, schemaJson: string | null) {
  if (actorName !== 'shopee-scraper' || !schemaJson) return schemaJson;
  try {
    const schema = JSON.parse(schemaJson);
    if (!schema?.properties || typeof schema.properties !== 'object') return schemaJson;
    const properties = { ...schema.properties };
    delete properties.maxReviewsPerProduct;
    delete properties.detailConcurrency;
    if (properties.includeDetails) {
      properties.includeDetails = {
        ...properties.includeDetails,
        description: 'Dùng một tab Shopee duy nhất để lấy chi tiết và điểm đánh giá trung bình; không lấy bình luận.'
      };
    }
    return JSON.stringify({ ...schema, properties });
  } catch {
    return schemaJson;
  }
}

function sanitizeDetailPatch(value: any) {
  const text = (input: unknown, limit = 5000) => String(input ?? '').slice(0, limit);
  const number = (input: unknown) => {
    if (input === null || input === undefined || input === '') return null;
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const soldValue = (input: unknown): string | number | null => {
    if (input === null || input === undefined || input === '') return null;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'object') {
      const candidate = (
        (input as any)?.value ??
        (input as any)?.count ??
        (input as any)?.total ??
        (input as any)?.text ??
        (input as any)?.display_text ??
        (input as any)?.label
      );
      return candidate === input ? null : soldValue(candidate);
    }
    const normalized = text(input, 100).replace(/\s+/g, ' ').trim();
    const match = normalized.match(
      /(\d+(?:[.,]\d+)?\s*(?:k|nghìn|tr|triệu)?\+?)(?:\s*(?:đã bán|sold))?/i
    );
    return match ? match[1].replace(/\s+/g, '') : null;
  };
  const stringArray = (input: unknown, limit = 30) => (
    Array.isArray(input)
      ? input.slice(0, limit).map((entry) => text(entry, 2000)).filter(Boolean)
      : []
  );
  const objectArray = (input: unknown, limit = 50) => (
    Array.isArray(input)
      ? input.slice(0, limit).map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { value: text(entry, 1000) };
        return Object.fromEntries(
          Object.entries(entry)
            .slice(0, 20)
            .map(([key, fieldValue]) => [
              text(key, 100),
              typeof fieldValue === 'number' || typeof fieldValue === 'boolean'
                ? fieldValue
                : Array.isArray(fieldValue)
                  ? fieldValue.slice(0, 50).map((nestedValue) => text(nestedValue, 500))
                  : fieldValue && typeof fieldValue === 'object'
                    ? text(JSON.stringify(fieldValue), 2000)
                    : text(fieldValue, 2000)
            ])
        );
      })
      : []
  );

  const status = value?.detailStatus === 'FAILED' ? 'FAILED' : 'COMPLETED';
  if (status === 'FAILED') {
    return {
      itemId: text(value?.itemId, 200),
      shopId: text(value?.shopId, 200),
      title: text(value?.title, 2000),
      url: text(value?.url, 4000),
      image: text(value?.image, 4000),
      price: text(value?.price, 200),
      rating: number(value?.rating),
      ratingCount: number(value?.ratingCount),
      sold: soldValue(value?.sold),
      shopName: text(value?.shopName, 1000),
      detailStatus: status,
      detailError: text(value?.detailError, 1000),
      detailCrawledAt: new Date().toISOString()
    } as Record<string, unknown>;
  }
  const detail: Record<string, unknown> = {
    description: text(value?.description, 50_000),
    category: text(value?.category, 1000),
    brand: text(value?.brand, 500),
    priceValue: number(value?.priceValue),
    priceMin: number(value?.priceMin),
    priceMax: number(value?.priceMax),
    originalPrice: number(value?.originalPrice),
    discountPercent: number(value?.discountPercent),
    currency: text(value?.currency, 20),
    rating: number(value?.rating),
    ratingCount: number(value?.ratingCount),
    ratingBreakdown: objectArray(value?.ratingBreakdown, 10),
    reviewsCollected: number(value?.reviewsCollected),
    reviewsRatingAverage: number(value?.reviewsRatingAverage),
    reviewsWithRating: number(value?.reviewsWithRating),
    reviewsStatus: ['COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED'].includes(value?.reviewsStatus)
      ? value.reviewsStatus
      : 'SKIPPED',
    reviewsError: text(value?.reviewsError, 1000),
    sold: soldValue(value?.sold ?? value?.totalSold),
    totalSold: number(value?.totalSold),
    salesLast30Days: number(value?.salesLast30Days),
    stock: number(value?.stock),
    likedCount: number(value?.likedCount),
    viewCount: number(value?.viewCount),
    condition: text(value?.condition, 200),
    productCreatedAt: text(value?.productCreatedAt, 100),
    productUpdatedAt: text(value?.productUpdatedAt, 100),
    shopName: text(value?.shopName, 1000),
    shopUsername: text(value?.shopUsername, 1000),
    shopDescription: text(value?.shopDescription, 5000),
    shopLocation: text(value?.shopLocation, 1000),
    shopRating: number(value?.shopRating),
    shopFollowerCount: number(value?.shopFollowerCount),
    shopResponseRate: number(value?.shopResponseRate),
    shopResponseTime: number(value?.shopResponseTime),
    shopJoinedAt: text(value?.shopJoinedAt, 100),
    shopLastActiveAt: text(value?.shopLastActiveAt, 100),
    shopProductCount: number(value?.shopProductCount),
    shopOnVacation: Boolean(value?.shopOnVacation),
    shopIsMall: Boolean(value?.shopIsMall),
    shopIsPreferred: Boolean(value?.shopIsPreferred),
    shopIsVerified: Boolean(value?.shopIsVerified),
    images: stringArray(value?.images, 30),
    attributes: objectArray(value?.attributes, 100),
    variations: objectArray(value?.variations, 50),
    models: objectArray(value?.models, 100),
    wholesaleTiers: objectArray(value?.wholesaleTiers, 50),
    promotions: objectArray(value?.promotions, 30),
    logistics: objectArray(value?.logistics, 30),
    videos: objectArray(value?.videos, 20),
    observedAt: text(value?.observedAt, 100) || new Date().toISOString(),
    detailStatus: status,
    detailError: '',
    detailCrawledAt: new Date().toISOString()
  };
  if (Object.prototype.hasOwnProperty.call(value || {}, 'reviews')) {
    detail.reviews = objectArray(value?.reviews, 100_000);
  }
  const detailImages = detail.images as string[];
  if (detailImages.length) {
    detail.image = text(value?.image || detailImages[0], 2000);
  }
  return Object.fromEntries(
    Object.entries(detail).filter(([key, fieldValue]) => (
      fieldValue !== null &&
      fieldValue !== undefined &&
      (
        typeof fieldValue !== 'string' ||
        fieldValue !== '' ||
        ['detailError', 'reviewsError'].includes(key)
      )
    ))
  );
}

function sanitizeReviews(value: unknown) {
  if (!Array.isArray(value)) return [];
  const text = (input: unknown, limit = 5000) => String(input ?? '').slice(0, limit);
  const number = (input: unknown) => {
    if (input === null || input === undefined || input === '') return null;
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return value.slice(0, 100).map((review: any) => ({
    reviewId: text(review?.reviewId, 200),
    author: text(review?.author, 1000),
    authorId: text(review?.authorId, 200),
    rating: number(review?.rating),
    comment: text(review?.comment, 20_000),
    createdAt: text(review?.createdAt, 100),
    variation: text(review?.variation, 1000),
    likes: number(review?.likes),
    images: Array.isArray(review?.images)
      ? review.images.slice(0, 20).map((entry: unknown) => text(entry, 2000)).filter(Boolean)
      : [],
    videos: Array.isArray(review?.videos)
      ? review.videos.slice(0, 10).map((entry: unknown) => text(entry, 2000)).filter(Boolean)
      : [],
    shopReply: text(review?.shopReply, 20_000)
  })).filter((review) => review.reviewId || review.comment);
}

// Auth Middleware
const requireAuth = async (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    const user = await prisma.user.findUnique({
      where: { id: String(decoded.id || '') },
      select: { id: true, email: true, role: true, tier: true, status: true, credits: true }
    });
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    if (user.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Account is suspended' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const requireAdmin = (req: any, res: any, next: any) => {
  if (!['ADMIN', 'SUPER_ADMIN'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Administrator role required' });
  }
  next();
};

// --- AUTH ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedEmail || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'A valid email and password of at least 8 characters are required' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(400).json({ error: 'Email already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email: normalizedEmail, password: hashedPassword, credits: 1000 }
    });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tier: user.tier,
        status: user.status,
        credits: user.credits
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedEmail || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid credentials' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'Account is suspended' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tier: user.tier,
        status: user.status,
        credits: user.credits
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req: any, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    id: user.id,
    email: user.email,
    role: user.role,
    tier: user.tier,
    status: user.status,
    credits: user.credits
  });
});

// --- USER ADMINISTRATION ---

app.get('/api/admin/users', requireAuth, requireAdmin, async (_req: any, res: any) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      tier: true,
      credits: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { runs: true, actors: true, schedules: true } }
    }
  });
  res.json(users);
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req: any, res: any) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const requestedRole = String(req.body?.role || 'USER');
  if (!['USER', 'ADMIN', 'SUPER_ADMIN'].includes(requestedRole)) {
    return res.status(400).json({ error: 'Role must be USER, ADMIN or SUPER_ADMIN' });
  }
  if (requestedRole === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only a super administrator can grant SUPER_ADMIN' });
  }
  const role = requestedRole;
  const credits = Number.isInteger(Number(req.body?.credits))
    ? Math.max(0, Math.min(1_000_000, Number(req.body.credits)))
    : 1000;
  if (!email || password.length < 8) {
    return res.status(400).json({ error: 'Valid email and password of at least 8 characters are required' });
  }
  const requestedTier = String(req.body?.tier || 'FREE');
  if (!['FREE', 'BASIC', 'PRO', 'ENTERPRISE'].includes(requestedTier)) {
    return res.status(400).json({ error: 'Tier must be FREE, BASIC, PRO or ENTERPRISE' });
  }
  const tier = requestedTier;
  try {
    const created = await prisma.user.create({
      data: {
        email,
        password: await bcrypt.hash(password, 10),
        role,
        tier,
        status: 'ACTIVE',
        credits
      },
      select: { id: true, email: true, role: true, tier: true, status: true, credits: true, createdAt: true }
    });
    res.status(201).json(created);
  } catch (error: any) {
    if (error?.code === 'P2002') return res.status(409).json({ error: 'Email already exists' });
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req: any, res: any) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: 'User not found' });

  const role = req.body?.role;
  const status = req.body?.status;
  const tier = req.body?.tier;
  const credits = req.body?.credits;
  if (role !== undefined && !['SUPER_ADMIN', 'ADMIN', 'USER'].includes(role)) {
    return res.status(400).json({ error: 'Role must be SUPER_ADMIN, ADMIN or USER' });
  }
  if (status !== undefined && !['ACTIVE', 'SUSPENDED'].includes(status)) {
    return res.status(400).json({ error: 'Status must be ACTIVE or SUSPENDED' });
  }
  if (tier !== undefined && !['FREE', 'BASIC', 'PRO', 'ENTERPRISE'].includes(tier)) {
    return res.status(400).json({ error: 'Tier must be FREE, BASIC, PRO or ENTERPRISE' });
  }
  if (credits !== undefined && (!Number.isInteger(Number(credits)) || Number(credits) < 0 || Number(credits) > 1_000_000)) {
    return res.status(400).json({ error: 'Credits must be an integer from 0 to 1000000' });
  }
  if (target.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only a super administrator can modify a SUPER_ADMIN account' });
  }
  if (role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only a super administrator can grant SUPER_ADMIN' });
  }
  if (target.id === req.user.id && ((role !== undefined && role !== target.role) || status === 'SUSPENDED')) {
    return res.status(409).json({ error: 'You cannot change your own role or suspend your own account' });
  }

  if (
    ['ADMIN', 'SUPER_ADMIN'].includes(target.role) &&
    target.status === 'ACTIVE' &&
    (role === 'USER' || status === 'SUSPENDED')
  ) {
    const activeAdmins = await prisma.user.count({
      where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' }
    });
    if (activeAdmins <= 1) {
      return res.status(409).json({ error: 'At least one active administrator is required' });
    }
  }
  if (
    target.role === 'SUPER_ADMIN' &&
    target.status === 'ACTIVE' &&
    (role !== undefined && role !== 'SUPER_ADMIN' || status === 'SUSPENDED')
  ) {
    const activeSuperAdmins = await prisma.user.count({
      where: { role: 'SUPER_ADMIN', status: 'ACTIVE' }
    });
    if (activeSuperAdmins <= 1) {
      return res.status(409).json({ error: 'At least one active super administrator is required' });
    }
  }

  const updated = await prisma.user.update({
    where: { id: target.id },
    data: {
      ...(role !== undefined ? { role } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(tier !== undefined ? { tier } : {}),
      ...(credits !== undefined ? { credits: Number(credits) } : {})
    },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      tier: true,
      credits: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { runs: true, actors: true, schedules: true } }
    }
  });
  res.json(updated);
});

// --- SHOPEE SESSION ROUTES ---

app.get('/api/integrations/shopee/session', requireAuth, async (req: any, res: any) => {
  try {
    const session = await getShopeeSession(req.user.id);
    res.json({
      status: session.status,
      lastConnectedAt: session.lastConnectedAt,
      lastCheckedAt: session.lastCheckedAt,
      lastError: session.lastError
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/integrations/shopee/connect', requireAuth, async (req: any, res: any) => {
  try {
    const session = await startShopeeConnection(req.user.id);
    res.status(202).json({
      status: session.status,
      message: 'A dedicated Edge window was opened. Log in to Shopee and complete any CAPTCHA.'
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/integrations/shopee/session', requireAuth, async (req: any, res: any) => {
  try {
    const session = await disconnectShopeeSession(req.user.id);
    res.json({ status: session.status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- CORE ROUTES ---

function applyTierLimits(schemaString: string | null, tier: string, role?: string): string | null {
  if (!schemaString) return null;
  try {
    const schema = JSON.parse(schemaString);
    if (!schema.properties) return schemaString;

    if (role === 'SUPER_ADMIN') {
      if (schema.properties.maxItems) delete schema.properties.maxItems.maximum;
      if (schema.properties.maxReviewsPerProduct) delete schema.properties.maxReviewsPerProduct.maximum;
      return JSON.stringify(schema);
    }

    const limits: Record<string, { maxItems: number, maxReviews: number }> = {
      'FREE': { maxItems: 10, maxReviews: 10 },
      'BASIC': { maxItems: 100, maxReviews: 100 },
      'PRO': { maxItems: 1000, maxReviews: 1000 },
      'ENTERPRISE': { maxItems: 100000, maxReviews: 100000 }
    };
    const tierLimits = limits[tier] || limits['FREE'];

    if (schema.properties.maxItems) {
      schema.properties.maxItems.maximum = Math.min(
        schema.properties.maxItems.maximum ?? 100000,
        tierLimits.maxItems
      );
    }
    if (schema.properties.maxReviewsPerProduct) {
      schema.properties.maxReviewsPerProduct.maximum = Math.min(
        schema.properties.maxReviewsPerProduct.maximum ?? 100000,
        tierLimits.maxReviews
      );
    }
    return JSON.stringify(schema);
  } catch {
    return schemaString;
  }
}

// List all actors
app.get('/api/actors', requireAuth, async (req: any, res) => {
  const actors = await prisma.actor.findMany({
    where: {
      OR: [{ userId: req.user.id }, { userId: null }]
    },
    orderBy: { createdAt: 'desc' }
  });
  const adjustedActors = actors.map(actor => ({
    ...actor,
    inputSchema: compactActorInputSchema(
      actor.name,
      applyTierLimits(actor.inputSchema, req.user.tier || 'FREE', req.user.role)
    ),
    outputSchema: compactActorOutputSchema(actor.name, actor.outputSchema)
  }));
  res.json(adjustedActors);
});

// Trigger a run
app.post('/api/actors/:id/run', requireAuth, async (req: any, res: any) => {
  const { id } = req.params;
  const rawInput = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

  try {
    const actor = await prisma.actor.findFirst({
      where: {
        id,
        OR: [{ userId: req.user.id }, { userId: null }]
      }
    });
    if (!actor) {
      return res.status(404).json({ error: 'Actor not found' });
    }
    const input = normalizeActorInput(
      compactActorInputSchema(
        actor.name,
        applyTierLimits(actor.inputSchema, req.user.tier || 'FREE', req.user.role)
      ),
      rawInput
    );
    if (actor.name === 'shopee-scraper') delete input.maxReviewsPerProduct;
    if (
      BROWSER_ACTOR_NAMES.includes(actor.name) &&
      (typeof input.keyword !== 'string' || !input.keyword.trim())
    ) {
      return res.status(400).json({ error: 'Search keyword is required' });
    }
    const run = await prisma.$transaction(async (tx) => {
      return tx.run.create({
        // Keep the run invisible to workers until its input is durable.
        data: { actorId: actor.id, userId: req.user.id, status: 'CREATING' }
      });
    });

    try {
      await writeRunInput(
        run.id,
        { id: actor.id, name: actor.name, version: actor.version },
        input
      );
    } catch (storageError) {
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date() }
      });
      throw storageError;
    }

    const queuedRun = await prisma.run.update({
      where: { id: run.id },
      data: {
        status: BROWSER_ACTOR_NAMES.includes(actor.name) ? 'BROWSER_PENDING' : 'PENDING'
      }
    });

    res.json({ message: 'Run scheduled.', run: queuedRun });
  } catch (err: any) {
    if (err.name === 'ActorInputValidationError') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- BROWSER AGENT ROUTES ---

app.get('/api/browser-agent/bootstrap', async (req: any, res) => {
  const user = await prisma.user.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true }
  });
  if (!user) return res.status(503).json({ error: 'No active local OmniCrawl user is available' });
  const token = jwt.sign({ id: user.id, agent: true }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ apiBase: 'http://localhost:3001', token });
});

app.post('/api/browser-agent/status', requireAuth, (req: any, res) => {
  const version = typeof req.body?.version === 'string' ? req.body.version.slice(0, 40) : 'unknown';
  browserAgentHeartbeats.set(req.user.id, { version, seenAt: Date.now() });
  res.status(204).send();
});

app.get('/api/browser-agent/status', requireAuth, (req: any, res) => {
  const heartbeat = browserAgentHeartbeats.get(req.user.id);
  const connected = Boolean(heartbeat && Date.now() - heartbeat.seenAt < BROWSER_AGENT_HEARTBEAT_TTL_MS);
  res.json({
    connected,
    version: connected ? heartbeat?.version ?? null : null
  });
});

app.get('/api/browser-agent/jobs/next', requireAuth, async (req: any, res: any) => {
  try {
    const candidate = await prisma.run.findFirst({
      where: {
        userId: req.user.id,
        status: 'BROWSER_PENDING',
        actor: { name: { in: BROWSER_ACTOR_NAMES } }
      },
      orderBy: { createdAt: 'asc' },
      include: { actor: true }
    });
    if (!candidate) return res.status(204).send();

    const claim = await prisma.run.updateMany({
      where: {
        id: candidate.id,
        userId: req.user.id,
        status: 'BROWSER_PENDING'
      },
      data: { status: 'BROWSER_RUNNING', startedAt: new Date() }
    });
    if (claim.count !== 1) return res.status(204).send();

    const input: any = await readRunInput(candidate.id);
    const maxItemsValue = Number(input.maxItems ?? 30);
    const maxItems = Number.isFinite(maxItemsValue)
      ? Math.min(500, Math.max(1, Math.floor(maxItemsValue)))
      : 30;
    const platform = candidate.actor.name === 'tiktok-scraper' ? 'tiktok' : 'shopee';
    const platformLabel = platform === 'tiktok' ? 'TikTok' : 'Shopee';
    const keyword = String(input.keyword || 'máy in 3d').trim() || 'máy in 3d';
    const mode = platform === 'tiktok' && input.mode === 'videos' ? 'videos' : 'products';
    appendRunLog(
      candidate.id,
      `[INFO] [BrowserAgent] Claimed ${platformLabel} ${mode} job for keyword "${keyword}".`
    );
    const includeDetails = input.includeDetails !== false;
    const maxReviewsValue = Number(input.maxReviewsPerProduct ?? 20);
    const maxReviewsPerProduct = platform === 'shopee'
      ? 0
      : includeDetails && Number.isFinite(maxReviewsValue)
        ? Math.min(100000, Math.max(0, Math.floor(maxReviewsValue)))
        : 0;
    const detailConcurrency = 1;
    await new Dataset(candidate.id).setMetadata({
      source: platform === 'tiktok' ? 'tiktok.com' : 'shopee.vn',
      platform,
      mode,
      query: {
        keyword,
        mode,
        maxItems,
        includeDetails,
        ...(platform === 'shopee' ? {} : { maxReviewsPerProduct }),
        detailConcurrency
      },
      detailProgress: {
        enabled: includeDetails,
        completed: 0,
        failed: 0,
        total: 0
      }
    });
    res.json({
      runId: candidate.id,
      actorName: candidate.actor.name,
      platform,
      mode,
      keyword,
      maxItems,
      includeDetails,
      maxReviewsPerProduct,
      detailConcurrency
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-agent/jobs/:id/items', requireAuth, async (req: any, res: any) => {
  try {
    const run = await prisma.run.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: 'BROWSER_RUNNING',
        actor: { name: { in: BROWSER_ACTOR_NAMES } }
      },
      select: { id: true, actor: { select: { name: true } } }
    });
    if (!run) return res.status(404).json({ error: 'Active browser job not found' });

    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    const safeItems = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const numeric = (value: unknown) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const safeItem = {
        itemId: String(item.itemId || '').slice(0, 200),
        sourceType: String(item.sourceType || '').slice(0, 50),
        shopId: String(item.shopId || '').slice(0, 200),
        title: String(item.title || '').slice(0, 1000),
        description: String(item.description || '').slice(0, 50_000),
        price: String(item.price || '').slice(0, 100),
        priceValue: numeric(item.priceValue),
        originalPrice: numeric(item.originalPrice),
        discountPercent: numeric(item.discountPercent),
        sold: item.sold ?? 0,
        views: numeric(item.views),
        likes: numeric(item.likes),
        comments: numeric(item.comments),
        shares: numeric(item.shares),
        saves: numeric(item.saves),
        duration: numeric(item.duration),
        rating: numeric(item.rating),
        reviewCount: numeric(item.reviewCount),
        author: String(item.author || '').slice(0, 1000),
        authorId: String(item.authorId || '').slice(0, 200),
        authorUrl: String(item.authorUrl || '').slice(0, 2000),
        musicTitle: String(item.musicTitle || '').slice(0, 1000),
        hashtags: Array.isArray(item.hashtags)
          ? item.hashtags.slice(0, 100).map((value: unknown) => String(value).slice(0, 200))
          : [],
        currency: String(item.currency || '').slice(0, 20),
        publishedAt: String(item.publishedAt || '').slice(0, 100),
        searchKeyword: String(item.searchKeyword || '').slice(0, 500),
        searchPage: numeric(item.searchPage),
        searchPosition: numeric(item.searchPosition),
        searchRank: numeric(item.searchRank),
        isSponsored: Boolean(item.isSponsored),
        campaignId: String(item.campaignId || '').slice(0, 200),
        categoryId: String(item.categoryId || '').slice(0, 200),
        shopName: String(item.shopName || '').slice(0, 1000),
        isMall: Boolean(item.isMall),
        isPreferred: Boolean(item.isPreferred),
        url: String(item.url || '').slice(0, 2000),
        image: String(item.image || '').slice(0, 2000),
        observedAt: String(item.observedAt || new Date().toISOString()).slice(0, 100),
        detailStatus: ['PENDING', 'COMPLETED', 'PARTIAL'].includes(item.detailStatus)
          ? item.detailStatus
          : 'SKIPPED'
      };
      safeItems.push(compactActorRecord(run.actor.name, safeItem));
    }
    await new Dataset(run.id).pushData(safeItems);
    const storedCount = safeItems.length;
    const itemLabel = run.actor.name === 'tiktok-scraper' ? 'TikTok items' : 'products';
    appendRunLog(run.id, `[INFO] [BrowserAgent] Stored ${storedCount} ${itemLabel}.`);
    res.json({ accepted: storedCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-agent/jobs/:id/items/enrich', requireAuth, async (req: any, res: any) => {
  try {
    const run = await prisma.run.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: 'BROWSER_RUNNING',
        actor: { name: { in: BROWSER_ACTOR_NAMES } }
      },
      select: { id: true, actor: { select: { name: true } } }
    });
    if (!run) return res.status(404).json({ error: 'Active browser job not found' });

    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    const dataset = new Dataset(run.id);
    let updated = 0;
    for (const item of items) {
      const itemId = String(item?.itemId || '').slice(0, 200);
      const image = String(item?.image || '').slice(0, 2000);
      const rawSold = item?.sold;
      const numeric = (value: unknown) => {
        if (value === null || value === undefined || value === '') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      };
      const sold = (() => {
        if (typeof rawSold === 'number') {
          return Number.isFinite(rawSold) && rawSold > 0 ? rawSold : null;
        }
        const candidate = rawSold && typeof rawSold === 'object'
          ? rawSold.value ?? rawSold.count ?? rawSold.text ?? rawSold.display_text
          : rawSold;
        const match = String(candidate ?? '').match(
          /(\d+(?:[.,]\d+)?\s*(?:k|nghìn|tr|triệu)?\+?)(?:\s*(?:đã bán|sold))?/i
        );
        return match ? match[1].replace(/\s+/g, '') : null;
      })();
      if (!itemId) continue;
      const patch: Record<string, unknown> = {};
      if (/^https?:\/\//i.test(image)) patch.image = image;
      if (sold !== null && sold !== '' && sold !== '0') patch.sold = sold;
      const rating = numeric(item?.rating);
      const ratingCount = numeric(item?.ratingCount);
      if (rating !== null) patch.rating = rating;
      if (ratingCount !== null) patch.ratingCount = ratingCount;
      if (!Object.keys(patch).length) continue;
      if (await dataset.updateData(itemId, patch)) updated += 1;
    }
    res.json({ updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/browser-agent/jobs/:id/items/:itemId', requireAuth, async (req: any, res: any) => {
  try {
    const run = await prisma.run.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: 'BROWSER_RUNNING',
        actor: { name: { in: BROWSER_ACTOR_NAMES } }
      },
      select: { id: true, actor: { select: { name: true } } }
    });
    if (!run) return res.status(404).json({ error: 'Active browser job not found' });

    const dataset = new Dataset(run.id);
    const detail = compactActorRecord(
      run.actor.name,
      sanitizeDetailPatch(req.body?.detail)
    ) as Record<string, unknown>;
    let updated = true;
    if (detail.detailStatus === 'FAILED') {
      updated = await dataset.moveDataToFailedProducts(
        String(req.params.itemId),
        detail
      );
    } else {
      updated = await dataset.updateData(String(req.params.itemId), detail);
      if (!updated) return res.status(404).json({ error: 'Product was not found in this run' });
    }

    const completed = Math.max(0, Math.floor(Number(req.body?.progress?.completed) || 0));
    const failed = Math.max(0, Math.floor(Number(req.body?.progress?.failed) || 0));
    const total = Math.max(
      completed + failed,
      Math.floor(Number(req.body?.progress?.total) || 0)
    );
    await dataset.setMetadata({
      detailProgress: {
        enabled: true,
        completed,
        failed,
        total
      }
    });
    appendRunLog(
      run.id,
      `[INFO] [BrowserAgent] ${run.actor.name === 'tiktok-scraper' ? 'TikTok' : 'Shopee'} ` +
      `details ${completed + failed}/${total}: ` +
      `${detail.detailStatus === 'FAILED' ? 'failed' : 'stored'} for item ${String(req.params.itemId).slice(0, 100)}.`
    );
    res.json({ success: true, detailStatus: detail.detailStatus });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-agent/jobs/:id/items/:itemId/reviews', requireAuth, async (req: any, res: any) => {
  try {
    const run = await prisma.run.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: 'BROWSER_RUNNING',
        actor: { name: { in: BROWSER_ACTOR_NAMES } }
      },
      select: { id: true, actor: { select: { name: true } } }
    });
    if (!run) return res.status(404).json({ error: 'Active browser job not found' });
    if (run.actor.name === 'shopee-scraper') {
      return res.json({ accepted: 0, total: 0, disabled: true });
    }

    const reviews = sanitizeReviews(req.body?.reviews);
    if (!reviews.length) return res.json({ accepted: 0, total: 0 });
    const dataset = new Dataset(run.id);
    const total = await dataset.appendReviews(
      String(req.params.itemId),
      reviews,
      100_000
    );
    if (total === null) {
      return res.status(404).json({ error: 'Product was not found in this run' });
    }
    const summary = req.body?.summary;
    const numeric = (value: unknown) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const rating = numeric(summary?.rating);
    const ratingCount = numeric(summary?.ratingCount);
    await dataset.updateData(String(req.params.itemId), {
      reviewsCollected: total,
      ...(rating === null ? {} : { rating }),
      ...(ratingCount === null ? {} : { ratingCount })
    });
    res.json({ accepted: reviews.length, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/browser-agent/jobs/:id/log', requireAuth, async (req: any, res: any) => {
  const run = await prisma.run.findFirst({
    where: {
      id: req.params.id,
      userId: req.user.id,
      status: 'BROWSER_RUNNING',
      actor: { name: { in: BROWSER_ACTOR_NAMES } }
    },
    select: { id: true }
  });
  if (!run) return res.status(404).json({ error: 'Active browser job not found' });

  const message = String(req.body?.message || '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 1000);
  if (message) appendRunLog(run.id, `[INFO] [BrowserAgent] ${message}`);
  res.json({ success: true });
});

app.post('/api/browser-agent/jobs/:id/complete', requireAuth, async (req: any, res: any) => {
  const run = await prisma.run.findFirst({
    where: {
      id: req.params.id,
      userId: req.user.id,
      status: 'BROWSER_RUNNING',
      actor: { name: { in: BROWSER_ACTOR_NAMES } }
    },
    include: { actor: true }
  });
  if (!run) return res.status(409).json({ error: 'Browser job is no longer active' });
  const platformLabel = run.actor.name === 'tiktok-scraper' ? 'TikTok' : 'Shopee';
  const dataset = new Dataset(req.params.id);
  const storedCount = (await dataset.getData()).stats.itemCount;
  if (storedCount === 0) {
    const failed = await prisma.run.updateMany({
      where: {
        id: req.params.id,
        userId: req.user.id,
        status: 'BROWSER_RUNNING'
      },
      data: { status: 'FAILED', finishedAt: new Date() }
    });
    if (failed.count !== 1) {
      return res.status(409).json({ error: 'Browser job is no longer active' });
    }
    appendRunLog(
      req.params.id,
      `[ERROR] [BrowserAgent] ${platformLabel} crawl ended without storing any items.`
    );
    await dataset.finalize('FAILED', `${platformLabel} crawl produced no items`);
    return res.status(422).json({ error: `${platformLabel} crawl produced no items` });
  }

  const detailCompleted = Math.max(0, Math.floor(Number(req.body?.details?.completed) || 0));
  const detailFailed = Math.max(0, Math.floor(Number(req.body?.details?.failed) || 0));
  const detailTotal = Math.max(
    detailCompleted + detailFailed,
    Math.floor(Number(req.body?.details?.total) || 0)
  );
  if (req.body?.details) {
    await dataset.setMetadata({
      detailProgress: {
        enabled: Boolean(req.body.details.enabled),
        completed: detailCompleted,
        failed: detailFailed,
        total: detailTotal
      }
    });
  }

  const finalStatus = detailFailed > 0 ? 'PARTIAL' : 'SUCCESS';
  const completed = await prisma.run.updateMany({
    where: {
      id: req.params.id,
      userId: req.user.id,
      status: 'BROWSER_RUNNING'
    },
    data: { status: finalStatus, finishedAt: new Date() }
  });
  if (completed.count !== 1) return res.status(409).json({ error: 'Browser job is no longer active' });
  await dataset.finalize(finalStatus);
  appendRunLog(
    req.params.id,
    `[INFO] [BrowserAgent] Completed with ${storedCount} ${platformLabel} items` +
    (req.body?.details
      ? `; details: ${detailCompleted} completed, ${detailFailed} failed.`
      : '.')
  );
  res.json({ success: finalStatus === 'SUCCESS', status: finalStatus });
});

app.post('/api/browser-agent/jobs/:id/fail', requireAuth, async (req: any, res: any) => {
  const message = String(req.body?.error || 'Browser Agent failed').slice(0, 1000);
  const failed = await prisma.run.updateMany({
    where: {
      id: req.params.id,
      userId: req.user.id,
      status: 'BROWSER_RUNNING'
    },
    data: { status: 'FAILED', finishedAt: new Date() }
  });
  if (failed.count !== 1) return res.status(409).json({ error: 'Browser job is no longer active' });
  await new Dataset(req.params.id).finalize('FAILED', message);
  appendRunLog(req.params.id, `[ERROR] [BrowserAgent] ${message}`);
  res.json({ success: true });
});

// List runs
app.get('/api/runs', requireAuth, async (req: any, res) => {
  const runs = await prisma.run.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: { actor: true }
  });
  res.json(runs);
});

// View run logs
app.get('/api/runs/:id/logs', requireAuth, async (req: any, res) => {
  const { id } = req.params;
  const run = await prisma.run.findFirst({
    where: { id, userId: req.user.id },
    select: { id: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const logFile = path.join(STORAGE_ROOT, 'logs', `${id}.log`);

  if (fs.existsSync(logFile)) {
    const logs = fs.readFileSync(logFile, 'utf8');
    res.json({ logs });
  } else {
    res.json({ logs: 'No logs available yet.' });
  }
});

app.get('/api/runs/:id/input', requireAuth, async (req: any, res: any) => {
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    select: { id: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const input = await readRunInputDocument(run.id);
  if (!input) return res.status(404).json({ error: 'Run input not found' });
  res.json(input);
});

app.get('/api/runs/:id/output', requireAuth, async (req: any, res: any) => {
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    select: { id: true, actor: { select: { name: true } } }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const output = await readRunOutput(run.id);
  if (!output) return res.status(404).json({ error: 'Run output not found' });
  res.json({
    ...output,
    items: output.items.map((item) => compactActorRecord(run.actor.name, item))
  });
});

app.get('/api/runs/:id/items', requireAuth, async (req: any, res: any) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(String(req.query.pageSize || '25'), 10) || 25)
  );
  const filterStatus = req.query.status ? String(req.query.status) : undefined;
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { actor: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const whereClause: any = { runId: run.id };
  if (filterStatus && filterStatus !== 'FAILED') {
    whereClause.data = { path: ['detailStatus'], equals: filterStatus };
  }

  const failedProducts = Array.isArray((run.outputMetadata as any)?.failedProducts)
    ? (run.outputMetadata as any).failedProducts
      .filter((entry: any) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .sort((left: any, right: any) => Number(left.position || 0) - Number(right.position || 0))
    : [];
  const totalCount = filterStatus === 'FAILED'
    ? failedProducts.length
    : filterStatus
      ? await prisma.datasetItem.count({ where: whereClause })
      : run.itemCount;

  const items = filterStatus === 'FAILED'
    ? failedProducts
      .slice((page - 1) * pageSize, page * pageSize)
      .map((failed: any, index: number) => ({
        id: `failed:${String(failed.externalKey || index)}`,
        position: Number(failed.position || index),
        createdAt: failed.failedAt || run.finishedAt || run.createdAt,
        data: compactActorRecord(run.actor.name, {
          ...(failed.data && typeof failed.data === 'object' ? failed.data : {}),
          detailStatus: 'FAILED',
          detailError: String(
            failed?.data?.detailError || failed.detailError || 'Không lấy được chi tiết sản phẩm.'
          )
        })
      }))
    : await prisma.datasetItem.findMany({
      where: whereClause,
      orderBy: { position: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, position: true, data: true, createdAt: true }
    });
  res.json({
    run: {
      id: run.id,
      status: run.status,
      input: run.input ?? {},
      outputMetadata: run.outputMetadata ?? {},
      outputError: run.outputError,
      itemCount: run.itemCount,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      createdAt: run.createdAt,
      actor: {
        id: run.actor.id,
        name: run.actor.name,
        version: run.actor.version,
        outputSchema: compactActorOutputSchema(
          run.actor.name,
          run.actor.outputSchema
        )
      }
    },
    pagination: {
      page,
      pageSize,
      total: totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize))
    },
    items: items.map((item: any) => ({
      id: item.id,
      position: item.position,
      createdAt: item.createdAt,
      data: compactActorRecord(run.actor.name, item.data)
    }))
  });
});

app.get('/api/runs/:id/export', requireAuth, async (req: any, res: any) => {
  const format = String(req.query.format || 'jsonl').toLowerCase();
  if (format !== 'jsonl') {
    return res.status(400).json({ error: 'Format must be jsonl' });
  }
  const filterStatus = req.query.status ? String(req.query.status) : undefined;
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { actor: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const filename = `omnicrawl-${run.actor.name}-${run.id}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  if (format === 'jsonl') {
    res.type('application/x-ndjson');
    let cursor = -1;
    const { failedProducts: _failedProducts, ...exportMetadata } = (
      run.outputMetadata && typeof run.outputMetadata === 'object' && !Array.isArray(run.outputMetadata)
        ? run.outputMetadata as Record<string, unknown>
        : {}
    );
    const lineage = {
      _runId: run.id,
      _actor: run.actor.name,
      _createdAt: run.createdAt,
      ...(Object.keys(exportMetadata).length ? { _metadata: exportMetadata } : {})
    };
    
    while (true) {
      const batch = await prisma.datasetItem.findMany({
        where: { runId: run.id, position: { gt: cursor } },
        orderBy: { position: 'asc' },
        take: 1000,
        select: { position: true, data: true }
      });
      if (!batch.length) break;
      for (const item of batch) {
        const compacted = compactActorRecord(run.actor.name, item.data);
        const record = compacted && typeof compacted === 'object' && !Array.isArray(compacted)
          ? compacted as Record<string, unknown>
          : { value: compacted };
          
        if (filterStatus && record.detailStatus !== filterStatus && record.status !== filterStatus) {
          cursor = item.position;
          continue;
        }

        const finalRecord = { ...record, ...lineage };
        res.write(JSON.stringify(finalRecord) + '\n');
        cursor = item.position;
      }
    }
    return res.end();
  }
});

// Stop a run
app.post('/api/runs/:id/stop', requireAuth, async (req: any, res) => {
  const { id } = req.params;
  try {
    const run = await prisma.run.findFirst({
      where: { id, userId: req.user.id }
    });
    if (!run) return res.status(404).json({ error: 'Run not found' });

    if (run.status === 'PENDING' || run.status === 'BROWSER_PENDING') {
      const stopped = await prisma.run.updateMany({
        where: { id, userId: req.user.id, status: run.status },
        data: { status: 'STOPPED', finishedAt: new Date() }
      });
      if (stopped.count !== 1) {
        return res.status(409).json({ error: 'Run status changed; refresh and try again' });
      }
      await new Dataset(id).finalize('STOPPED');
      return res.json({ message: 'Pending run stopped.' });
    }

    if (run.status === 'BROWSER_RUNNING') {
      const stopped = await prisma.run.updateMany({
        where: { id, userId: req.user.id, status: 'BROWSER_RUNNING' },
        data: { status: 'STOPPED', finishedAt: new Date() }
      });
      if (stopped.count !== 1) {
        return res.status(409).json({ error: 'Run status changed; refresh and try again' });
      }
      await new Dataset(id).finalize('STOPPED');
      return res.json({ message: 'Browser run stopped.' });
    }

    if (run.status !== 'RUNNING') {
      return res.status(409).json({ error: `Run cannot be stopped from status ${run.status}` });
    }

    const stopping = await prisma.run.updateMany({
      where: { id, userId: req.user.id, status: 'RUNNING' },
      data: { status: 'STOPPING' }
    });
    if (stopping.count !== 1) {
      return res.status(409).json({ error: 'Run status changed; refresh and try again' });
    }
    res.json({ message: 'Stop signal sent.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a run
app.delete('/api/runs/:id', requireAuth, async (req: any, res) => {
  const { id } = req.params;
  try {
    const run = await prisma.run.findFirst({
      where: { id, userId: req.user.id }
    });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status === 'RUNNING' || run.status === 'STOPPING' || run.status === 'BROWSER_RUNNING') {
      return res.status(409).json({ error: 'Stop the run before deleting it' });
    }

    await prisma.run.delete({ where: { id } });
    removeRunStorage(id);
    res.json({ message: 'Run deleted.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List schedules
app.get('/api/schedules', requireAuth, async (req: any, res) => {
  const schedules = await prisma.schedule.findMany({
    where: { userId: req.user.id },
    include: { actor: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(schedules);
});

// Create schedule
app.post('/api/schedules', requireAuth, async (req: any, res: any) => {
  const { actorId, cron } = req.body;
  const rawInput = req.body?.input && typeof req.body.input === 'object' && !Array.isArray(req.body.input)
    ? req.body.input
    : {};
  if (!actorId || !cron) {
    return res.status(400).json({ error: 'actorId and cron are required' });
  }
  try {
    CronExpressionParser.parse(cron);
  } catch {
    return res.status(400).json({ error: 'Invalid cron expression' });
  }

  // Verify actor exists and belongs to user or is public
  const actor = await prisma.actor.findUnique({ where: { id: actorId } });
  if (!actor) return res.status(404).json({ error: 'Actor not found' });

  if (actor.userId && actor.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized to use this actor' });
  }

  let input: Record<string, unknown>;
  try {
    input = normalizeActorInput(actor.inputSchema, rawInput);
  } catch (err: any) {
    if (err.name === 'ActorInputValidationError') {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const schedule = await prisma.schedule.create({
    data: {
      actorId,
      userId: req.user.id,
      cron,
      input: input as any,
      enabled: true
    }
  });
  res.json(schedule);
});

// Delete a schedule
app.delete('/api/schedules/:id', requireAuth, async (req: any, res: any) => {
  const schedule = await prisma.schedule.findUnique({ where: { id: req.params.id } });
  if (!schedule) return res.status(404).json({ error: 'Not found' });
  if (schedule.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

  await prisma.schedule.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Toggle a schedule
app.patch('/api/schedules/:id', requireAuth, async (req: any, res: any) => {
  const schedule = await prisma.schedule.findUnique({ where: { id: req.params.id } });
  if (!schedule) return res.status(404).json({ error: 'Not found' });
  if (schedule.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

  const updated = await prisma.schedule.update({
    where: { id: req.params.id },
    data: { enabled: !schedule.enabled }
  });
  res.json(updated);
});

// Get run details
app.get('/api/runs/:id', requireAuth, async (req: any, res: any) => {
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { actor: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// Scaffold new actor from template
app.post('/api/templates/scaffold', requireAuth, async (req: any, res: any) => {
  const { name, template } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-_]{1,62}$/.test(name)) {
    return res.status(400).json({
      error: 'Name must be 2-63 lowercase letters, numbers, hyphens or underscores'
    });
  }

  const templateName = template || 'template-ts';
  if (templateName !== 'template-ts') {
    return res.status(400).json({ error: 'Unsupported template' });
  }

  const actualTargetPath = path.join(WORKSPACE_ROOT, 'actors', name);
  const templatePath = path.join(WORKSPACE_ROOT, 'actors', templateName);

  if (fs.existsSync(actualTargetPath)) {
    return res.status(400).json({ error: `Actor ${name} already exists.` });
  }

  try {
    fs.cpSync(templatePath, actualTargetPath, { recursive: true });

    const pkgPath = path.join(actualTargetPath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.name = name;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const manifestPath = path.join(actualTargetPath, 'actor.json');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : {};
    const actor = await prisma.actor.create({
      data: {
        name,
        description: manifest.description || `Scaffolded from ${templateName}`,
        version: manifest.version || '1.0.0',
        inputSchema: manifest.inputSchema ? JSON.stringify(manifest.inputSchema) : null,
        outputSchema: manifest.outputSchema ? JSON.stringify(manifest.outputSchema) : null,
        userId: req.user.id
      }
    });

    exec(`cd ${WORKSPACE_ROOT} && pnpm install && pnpm build`);

    res.json({ message: 'Scaffolded successfully', actor });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- PROXY MANAGEMENT ROUTES ---

function parseProxyString(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  // Format: protocol://user:pass@host:port
  const urlMatch = trimmed.match(
    /^(https?|socks5):\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/i
  );
  if (urlMatch) {
    return {
      protocol: urlMatch[1].toLowerCase(),
      username: urlMatch[2] || null,
      password: urlMatch[3] || null,
      host: urlMatch[4],
      port: parseInt(urlMatch[5], 10)
    };
  }

  // Format: host:port:user:pass
  const colonParts = trimmed.split(':');
  if (colonParts.length === 4) {
    return {
      protocol: 'http',
      host: colonParts[0],
      port: parseInt(colonParts[1], 10),
      username: colonParts[2] || null,
      password: colonParts[3] || null
    };
  }

  // Format: host:port
  if (colonParts.length === 2) {
    return {
      protocol: 'http',
      host: colonParts[0],
      port: parseInt(colonParts[1], 10),
      username: null,
      password: null
    };
  }

  // Format: user:pass@host:port
  const atMatch = trimmed.match(/^([^:@]+):([^@]+)@([^:]+):(\d+)$/);
  if (atMatch) {
    return {
      protocol: 'http',
      username: atMatch[1],
      password: atMatch[2],
      host: atMatch[3],
      port: parseInt(atMatch[4], 10)
    };
  }

  return null;
}

// List all proxy groups with proxies
app.get('/api/proxies', requireAuth, requireAdmin, async (_req: any, res: any) => {
  const groups = await prisma.proxyGroup.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      proxies: {
        orderBy: { createdAt: 'desc' }
      },
      _count: { select: { proxies: true } }
    }
  });
  res.json(groups);
});

// Create proxy group
app.post('/api/proxies/groups', requireAuth, requireAdmin, async (req: any, res: any) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const isDefault = Boolean(req.body?.isDefault);

  if (isDefault) {
    await prisma.proxyGroup.updateMany({
      where: { isDefault: true },
      data: { isDefault: false }
    });
  }

  const group = await prisma.proxyGroup.create({
    data: { name, isDefault },
    include: { proxies: true, _count: { select: { proxies: true } } }
  });
  res.status(201).json(group);
});

// Update proxy group
app.patch('/api/proxies/groups/:id', requireAuth, requireAdmin, async (req: any, res: any) => {
  const group = await prisma.proxyGroup.findUnique({ where: { id: req.params.id } });
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const data: any = {};
  if (req.body?.name !== undefined) data.name = String(req.body.name).trim();
  if (req.body?.enabled !== undefined) data.enabled = Boolean(req.body.enabled);
  if (req.body?.isDefault === true) {
    await prisma.proxyGroup.updateMany({
      where: { isDefault: true },
      data: { isDefault: false }
    });
    data.isDefault = true;
  }

  const updated = await prisma.proxyGroup.update({
    where: { id: req.params.id },
    data,
    include: { proxies: true, _count: { select: { proxies: true } } }
  });
  res.json(updated);
});

// Delete proxy group
app.delete('/api/proxies/groups/:id', requireAuth, requireAdmin, async (req: any, res: any) => {
  const group = await prisma.proxyGroup.findUnique({ where: { id: req.params.id } });
  if (!group) return res.status(404).json({ error: 'Group not found' });
  await prisma.proxyGroup.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Add single proxy
app.post('/api/proxies', requireAuth, requireAdmin, async (req: any, res: any) => {
  const groupId = String(req.body?.groupId || '');
  const group = await prisma.proxyGroup.findUnique({ where: { id: groupId } });
  if (!group) return res.status(400).json({ error: 'Invalid group' });

  const protocol = String(req.body?.protocol || 'http').toLowerCase();
  const host = String(req.body?.host || '').trim();
  const port = parseInt(String(req.body?.port || ''), 10);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: 'Valid host and port are required' });
  }

  try {
    const proxy = await prisma.proxy.create({
      data: {
        groupId,
        protocol,
        host,
        port,
        username: req.body?.username || null,
        password: req.body?.password || null,
        country: req.body?.country || null,
        isRotating: Boolean(req.body?.isRotating)
      }
    });
    res.status(201).json(proxy);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return res.status(409).json({ error: 'Proxy with this host:port:username already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Bulk import proxies
app.post('/api/proxies/import', requireAuth, requireAdmin, async (req: any, res: any) => {
  const groupId = String(req.body?.groupId || '');
  const group = await prisma.proxyGroup.findUnique({ where: { id: groupId } });
  if (!group) return res.status(400).json({ error: 'Invalid group' });

  const text = String(req.body?.text || '');
  const lines = text.split(/[\r\n]+/).filter(Boolean);
  const country = req.body?.country || null;
  const isRotating = Boolean(req.body?.isRotating);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const line of lines) {
    const parsed = parseProxyString(line);
    if (!parsed || !parsed.host || !Number.isInteger(parsed.port)) {
      failed++;
      continue;
    }
    try {
      await prisma.proxy.create({
        data: {
          groupId,
          protocol: parsed.protocol,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username,
          password: parsed.password,
          country,
          isRotating
        }
      });
      imported++;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        skipped++; // Duplicate
      } else {
        failed++;
      }
    }
  }

  res.json({ imported, skipped, failed, total: lines.length });
});

// Delete proxy
app.delete('/api/proxies/:id', requireAuth, requireAdmin, async (req: any, res: any) => {
  const proxy = await prisma.proxy.findUnique({ where: { id: req.params.id } });
  if (!proxy) return res.status(404).json({ error: 'Proxy not found' });
  await prisma.proxy.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Toggle proxy enable/disable or reset status
app.patch('/api/proxies/:id', requireAuth, requireAdmin, async (req: any, res: any) => {
  const proxy = await prisma.proxy.findUnique({ where: { id: req.params.id } });
  if (!proxy) return res.status(404).json({ error: 'Proxy not found' });

  const data: any = {};
  if (req.body?.enabled !== undefined) data.enabled = Boolean(req.body.enabled);
  if (req.body?.resetStatus) {
    data.status = 'UNKNOWN';
    data.failCount = 0;
    data.enabled = true;
  }

  const updated = await prisma.proxy.update({
    where: { id: req.params.id },
    data
  });
  res.json(updated);
});

// Bulk delete proxies
app.post('/api/proxies/bulk-delete', requireAuth, requireAdmin, async (req: any, res: any) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return res.status(400).json({ error: 'No proxy IDs provided' });
  const result = await prisma.proxy.deleteMany({ where: { id: { in: ids } } });
  res.json({ deleted: result.count });
});

// Bulk enable/disable proxies
app.post('/api/proxies/bulk-toggle', requireAuth, requireAdmin, async (req: any, res: any) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const enabled = Boolean(req.body?.enabled);
  if (!ids.length) return res.status(400).json({ error: 'No proxy IDs provided' });
  const result = await prisma.proxy.updateMany({
    where: { id: { in: ids } },
    data: { enabled }
  });
  res.json({ updated: result.count });
});

// Health check all proxies
app.post('/api/proxies/check', requireAuth, requireAdmin, async (_req: any, res: any) => {
  try {
    const results = await checkAllProxies();
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get proxy stats
app.get('/api/proxies/stats', requireAuth, requireAdmin, async (_req: any, res: any) => {
  try {
    const stats = await getProxyStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- START SERVERS ---

app.listen(PORT, () => {
  console.log(`Core API Server running on http://localhost:${PORT}`);
  // Start the local proxy server alongside the API
  startProxyServer();
});
