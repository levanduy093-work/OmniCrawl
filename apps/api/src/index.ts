import express from 'express';
import cors from 'cors';
import { prisma } from '@omnicrawl/database';
import { queue } from '@omnicrawl/queue';
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

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'omnicrawl-secret-key-12345';
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const STORAGE_ROOT = path.join(WORKSPACE_ROOT, 'storage');

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

function sanitizeDetailPatch(value: any) {
  const text = (input: unknown, limit = 5000) => String(input ?? '').slice(0, limit);
  const number = (input: unknown) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
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
      detailStatus: status,
      detailError: text(value?.detailError, 1000),
      detailCrawledAt: new Date().toISOString()
    };
  }
  return {
    description: text(value?.description, 50_000),
    category: text(value?.category, 1000),
    brand: text(value?.brand, 500),
    rating: number(value?.rating),
    ratingCount: number(value?.ratingCount),
    stock: number(value?.stock),
    likedCount: number(value?.likedCount),
    shopName: text(value?.shopName, 1000),
    shopLocation: text(value?.shopLocation, 1000),
    images: stringArray(value?.images, 30),
    attributes: objectArray(value?.attributes, 100),
    variations: objectArray(value?.variations, 50),
    models: objectArray(value?.models, 100),
    detailStatus: status,
    detailError: '',
    detailCrawledAt: new Date().toISOString()
  };
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
      select: { id: true, email: true, role: true, status: true, credits: true }
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
  try {
    const created = await prisma.user.create({
      data: {
        email,
        password: await bcrypt.hash(password, 10),
        role,
        status: 'ACTIVE',
        credits
      },
      select: { id: true, email: true, role: true, status: true, credits: true, createdAt: true }
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
  const credits = req.body?.credits;
  if (role !== undefined && !['SUPER_ADMIN', 'ADMIN', 'USER'].includes(role)) {
    return res.status(400).json({ error: 'Role must be SUPER_ADMIN, ADMIN or USER' });
  }
  if (status !== undefined && !['ACTIVE', 'SUSPENDED'].includes(status)) {
    return res.status(400).json({ error: 'Status must be ACTIVE or SUSPENDED' });
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
      ...(credits !== undefined ? { credits: Number(credits) } : {})
    },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
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

// List all actors
app.get('/api/actors', requireAuth, async (req: any, res) => {
  const actors = await prisma.actor.findMany({
    where: {
      OR: [{ userId: req.user.id }, { userId: null }]
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json(actors);
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
    const input = normalizeActorInput(actor.inputSchema, rawInput);
    if (
      actor.name === 'shopee-scraper' &&
      (typeof input.keyword !== 'string' || !input.keyword.trim())
    ) {
      return res.status(400).json({ error: 'Shopee keyword is required' });
    }
    const run = await prisma.$transaction(async (tx) => {
      const debit = await tx.user.updateMany({
        where: { id: req.user.id, credits: { gte: 10 } },
        data: { credits: { decrement: 10 } }
      });
      if (debit.count !== 1) {
        throw new Error('INSUFFICIENT_CREDITS');
      }
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
      await prisma.$transaction([
        prisma.run.update({
          where: { id: run.id },
          data: { status: 'FAILED', finishedAt: new Date() }
        }),
        prisma.user.update({
          where: { id: req.user.id },
          data: { credits: { increment: 10 } }
        })
      ]);
      throw storageError;
    }

    const queuedRun = await prisma.run.update({
      where: { id: run.id },
      data: {
        status: actor.name === 'shopee-scraper' ? 'BROWSER_PENDING' : 'PENDING'
      }
    });

    res.json({ message: 'Run scheduled. Deducted 10 credits.', run: queuedRun });
  } catch (err: any) {
    if (err.name === 'ActorInputValidationError') {
      return res.status(400).json({ error: err.message });
    }
    if (err.message === 'INSUFFICIENT_CREDITS') {
      return res.status(403).json({ error: 'Insufficient credits. You need at least 10 credits to run.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// --- BROWSER AGENT ROUTES ---

app.get('/api/browser-agent/jobs/next', requireAuth, async (req: any, res: any) => {
  try {
    const candidate = await prisma.run.findFirst({
      where: {
        userId: req.user.id,
        status: 'BROWSER_PENDING',
        actor: { name: 'shopee-scraper' }
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
    appendRunLog(
      candidate.id,
      `[INFO] [BrowserAgent] Claimed Shopee job for keyword "${String(input.keyword || 'máy in 3d')}".`
    );
    const keyword = String(input.keyword || 'máy in 3d').trim() || 'máy in 3d';
    const includeDetails = input.includeDetails !== false;
    await new Dataset(candidate.id).setMetadata({
      source: 'shopee.vn',
      query: { keyword, maxItems, includeDetails },
      detailProgress: {
        enabled: includeDetails,
        completed: 0,
        failed: 0,
        total: 0
      }
    });
    res.json({
      runId: candidate.id,
      keyword,
      maxItems,
      includeDetails
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
        actor: { name: 'shopee-scraper' }
      },
      select: { id: true }
    });
    if (!run) return res.status(404).json({ error: 'Active browser job not found' });

    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
    const safeItems = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      safeItems.push({
        itemId: item.itemId,
        shopId: item.shopId,
        title: String(item.title || '').slice(0, 1000),
        price: String(item.price || '').slice(0, 100),
        sold: item.sold ?? 0,
        url: String(item.url || '').slice(0, 2000),
        image: String(item.image || '').slice(0, 2000),
        detailStatus: item.detailStatus === 'PENDING' ? 'PENDING' : 'SKIPPED'
      });
    }
    await new Dataset(run.id).pushData(safeItems);
    const storedCount = safeItems.length;
    appendRunLog(run.id, `[INFO] [BrowserAgent] Stored ${storedCount} products.`);
    res.json({ accepted: storedCount });
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
        actor: { name: 'shopee-scraper' }
      },
      select: { id: true }
    });
    if (!run) return res.status(404).json({ error: 'Active browser job not found' });

    const dataset = new Dataset(run.id);
    const detail = sanitizeDetailPatch(req.body?.detail);
    const updated = await dataset.updateData(String(req.params.itemId), detail);
    if (!updated) return res.status(404).json({ error: 'Product was not found in this run' });

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
      `[INFO] [BrowserAgent] Product details ${completed + failed}/${total}: ` +
      `${detail.detailStatus === 'FAILED' ? 'failed' : 'stored'} for item ${String(req.params.itemId).slice(0, 100)}.`
    );
    res.json({ success: true, detailStatus: detail.detailStatus });
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
      actor: { name: 'shopee-scraper' }
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
      '[ERROR] [BrowserAgent] Shopee crawl ended without storing any products.'
    );
    await dataset.finalize('FAILED', 'Shopee crawl produced no products');
    return res.status(422).json({ error: 'Shopee crawl produced no products' });
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

  const completed = await prisma.run.updateMany({
    where: {
      id: req.params.id,
      userId: req.user.id,
      status: 'BROWSER_RUNNING'
    },
    data: { status: 'SUCCESS', finishedAt: new Date() }
  });
  if (completed.count !== 1) return res.status(409).json({ error: 'Browser job is no longer active' });
  await dataset.finalize('SUCCESS');
  appendRunLog(
    req.params.id,
    `[INFO] [BrowserAgent] Completed with ${storedCount} products` +
    (req.body?.details
      ? `; details: ${detailCompleted} completed, ${detailFailed} failed.`
      : '.')
  );
  res.json({ success: true });
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
    select: { id: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const output = await readRunOutput(run.id);
  if (!output) return res.status(404).json({ error: 'Run output not found' });
  res.json(output);
});

app.get('/api/runs/:id/items', requireAuth, async (req: any, res: any) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(String(req.query.pageSize || '25'), 10) || 25)
  );
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { actor: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const items = await prisma.datasetItem.findMany({
    where: { runId: run.id },
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
        outputSchema: run.actor.outputSchema
      }
    },
    pagination: {
      page,
      pageSize,
      total: run.itemCount,
      totalPages: Math.max(1, Math.ceil(run.itemCount / pageSize))
    },
    items: items.map((item) => ({
      id: item.id,
      position: item.position,
      createdAt: item.createdAt,
      data: item.data
    }))
  });
});

app.get('/api/runs/:id/export', requireAuth, async (req: any, res: any) => {
  const format = String(req.query.format || 'json').toLowerCase();
  if (!['json', 'csv'].includes(format)) {
    return res.status(400).json({ error: 'Format must be json or csv' });
  }
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    include: { actor: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const filename = `omnicrawl-${run.actor.name}-${run.id}.${format}`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (format === 'json') {
    res.type('application/json');
    const envelope = {
      schemaVersion: '2.0',
      kind: RUN_OUTPUT_KIND,
      runId: run.id,
      actor: { id: run.actor.id, name: run.actor.name, version: run.actor.version },
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.finishedAt,
      stats: { itemCount: run.itemCount },
      metadata: run.outputMetadata ?? {},
      error: run.outputError
    };
    const prefix = JSON.stringify(envelope, null, 2).replace(/\n}$/, ',\n  "items": [\n');
    res.write(prefix);
    let cursor = -1;
    let first = true;
    while (true) {
      const batch = await prisma.datasetItem.findMany({
        where: { runId: run.id, position: { gt: cursor } },
        orderBy: { position: 'asc' },
        take: 1000,
        select: { position: true, data: true }
      });
      if (!batch.length) break;
      for (const item of batch) {
        res.write(`${first ? '' : ',\n'}    ${JSON.stringify(item.data)}`);
        first = false;
        cursor = item.position;
      }
    }
    return res.end('\n  ]\n}');
  }

  const schemaColumns = outputSchemaColumns(run.actor.outputSchema);
  const sample = schemaColumns.length === 0
    ? await prisma.datasetItem.findMany({
      where: { runId: run.id },
      orderBy: { position: 'asc' },
      take: 100,
      select: { data: true }
    })
    : [];
  const records = sample.map((item) => (
    item.data && typeof item.data === 'object' && !Array.isArray(item.data)
      ? item.data as Record<string, unknown>
      : { value: item.data }
  ));
  const columns = Array.from(new Set([
    ...schemaColumns,
    ...records.flatMap((record) => Object.keys(record))
  ]));
  res.type('text/csv; charset=utf-8');
  res.write(`\uFEFF${columns.map(csvCell).join(',')}\r\n`);
  let cursor = -1;
  while (true) {
    const batch = await prisma.datasetItem.findMany({
      where: { runId: run.id, position: { gt: cursor } },
      orderBy: { position: 'asc' },
      take: 1000,
      select: { position: true, data: true }
    });
    if (!batch.length) break;
    for (const item of batch) {
      const record = item.data && typeof item.data === 'object' && !Array.isArray(item.data)
        ? item.data as Record<string, unknown>
        : { value: item.data };
      res.write(`${columns.map((column) => csvCell(record[column])).join(',')}\r\n`);
      cursor = item.position;
    }
  }
  return res.end();
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

app.listen(PORT, () => {
  console.log(`Core API Server running on http://localhost:${PORT}`);
});
