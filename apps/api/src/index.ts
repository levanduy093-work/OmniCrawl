import express from 'express';
import cors from 'cors';
import { prisma } from '@omnicrawl/database';
import { queue } from '@omnicrawl/queue';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'omnicrawl-secret-key-12345';

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
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Email already exists' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, credits: 1000 }
    });
    
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, credits: user.credits } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
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

// --- CORE ROUTES ---

// List all actors for user
app.get('/api/actors', requireAuth, async (req: any, res) => {
  const actors = await prisma.actor.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' }
  });
  res.json(actors);
});

// Trigger a run
app.post('/api/actors/:id/run', requireAuth, async (req: any, res: any) => {
  const { id } = req.params;
  const input = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || user.credits < 10) {
      return res.status(403).json({ error: 'Insufficient credits. You need at least 10 credits to run.' });
    }

    const actor = await prisma.actor.findFirst({ where: { id, userId: req.user.id } });
    if (!actor) {
      return res.status(404).json({ error: 'Actor not found or unauthorized' });
    }

    // Deduct quota
    await prisma.user.update({
      where: { id: user.id },
      data: { credits: user.credits - 10 }
    });

    const run = await prisma.run.create({
      data: { actorId: actor.id, userId: user.id, status: 'PENDING' }
    });
    
    // Using simple DB create here since JobQueue logic originally created Run inside pushJob,
    // we need to update JobQueue to support manual push or let it poll.
    // For simplicity with our polling mechanism, just creating a PENDING run is enough,
    // since the worker polls for PENDING runs.
    
    res.json({ message: 'Run scheduled. Deducted 10 credits.', run });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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

// List schedules
app.get('/api/schedules', requireAuth, async (req: any, res) => {
  const schedules = await prisma.schedule.findMany({
    where: { userId: req.user.id },
    include: { actor: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(schedules);
});

// Create a schedule
app.post('/api/schedules', requireAuth, async (req: any, res: any) => {
  const { actorId, cron } = req.body;
  if (!actorId || !cron) {
    return res.status(400).json({ error: 'actorId and cron are required' });
  }

  // Verify actor exists and belongs to user or is public
  const actor = await prisma.actor.findUnique({ where: { id: actorId } });
  if (!actor) return res.status(404).json({ error: 'Actor not found' });
  
  if (actor.userId && actor.userId !== req.user.id) {
    return res.status(403).json({ error: 'Unauthorized to use this actor' });
  }

  const schedule = await prisma.schedule.create({
    data: {
      actorId,
      userId: req.user.id,
      cron,
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
  
  const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
  const actualTargetPath = path.join(workspaceRoot, 'actors', name);
  const templatePath = path.join(workspaceRoot, 'actors', template || 'template-ts');

  if (fs.existsSync(actualTargetPath)) {
    return res.status(400).json({ error: `Actor ${name} already exists.` });
  }

  try {
    fs.cpSync(templatePath, actualTargetPath, { recursive: true });
    
    const pkgPath = path.join(actualTargetPath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.name = name;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const actor = await prisma.actor.create({
      data: { name: name, description: `Scaffolded from ${template}`, userId: req.user.id }
    });
    
    exec(`cd ${workspaceRoot} && pnpm install && pnpm build`);

    res.json({ message: 'Scaffolded successfully', actor });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Core API Server running on http://localhost:${PORT}`);
});
