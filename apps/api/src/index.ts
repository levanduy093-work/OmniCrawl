import express from 'express';
import cors from 'cors';
import { prisma } from '@omnicrawl/database';
import { queue } from '@omnicrawl/queue';
import {
  Dataset,
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

// Auth Middleware
const requireAuth = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
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
    res.json({ token, user: { id: user.id, email: user.email, credits: user.credits } });
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
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, credits: user.credits } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req: any, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, email: user.email, credits: user.credits });
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
      writeRunInput(
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

    const input: any = readRunInput(candidate.id);
    const maxItemsValue = Number(input.maxItems ?? 30);
    const maxItems = Number.isFinite(maxItemsValue)
      ? Math.min(500, Math.max(1, Math.floor(maxItemsValue)))
      : 30;
    appendRunLog(
      candidate.id,
      `[INFO] [BrowserAgent] Claimed Shopee job for keyword "${String(input.keyword || 'máy in 3d')}".`
    );
    const keyword = String(input.keyword || 'máy in 3d').trim() || 'máy in 3d';
    await new Dataset(candidate.id).setMetadata({
      source: 'shopee.vn',
      query: { keyword, maxItems }
    });
    res.json({
      runId: candidate.id,
      keyword,
      maxItems
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
        image: String(item.image || '').slice(0, 2000)
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
  appendRunLog(req.params.id, `[INFO] [BrowserAgent] Completed with ${storedCount} products.`);
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
  const input = readRunInputDocument(run.id);
  if (!input) return res.status(404).json({ error: 'Run input not found' });
  res.json(input);
});

app.get('/api/runs/:id/output', requireAuth, async (req: any, res: any) => {
  const run = await prisma.run.findFirst({
    where: { id: req.params.id, userId: req.user.id },
    select: { id: true }
  });
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const output = readRunOutput(run.id);
  if (!output) return res.status(404).json({ error: 'Run output not found' });
  res.json(output);
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
      input: JSON.stringify(input),
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
