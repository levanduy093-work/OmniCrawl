import { queue } from '@omnicrawl/queue';
import * as path from 'path';
import * as fs from 'fs';
import { fork, ChildProcess } from 'child_process';
import { prisma } from '@omnicrawl/database';
import dotenv from 'dotenv';

const projectRoot = path.resolve(__dirname, '..', '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env'), quiet: true });

console.log('Worker Daemon is starting with Process Isolation...');

// Keep track of running processes to allow stopping
const runningProcesses = new Map<string, ChildProcess>();

// Periodic check for STOPPING jobs
setInterval(async () => {
  if (runningProcesses.size === 0) return;

  const stoppingRuns = await prisma.run.findMany({
    where: { 
      status: 'STOPPING',
      id: { in: Array.from(runningProcesses.keys()) }
    }
  });

  for (const run of stoppingRuns) {
    console.log(`[Worker] Kill signal received for Job ${run.id}. Terminating process...`);
    const proc = runningProcesses.get(run.id);
    if (proc) {
      // Persist STOPPED first so the close handler cannot turn an intentional
      // stop into FAILED or SUCCESS.
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'STOPPED', finishedAt: new Date() }
      });
      proc.kill('SIGTERM');
      runningProcesses.delete(run.id);
    }
  }
}, 3000); // Check every 3 seconds

queue.processJobs(async (runId: string, actorName: string, userId: string | null) => {
  console.log(`[Worker] Picked up Job ${runId} for Actor ${actorName}`);
  
  return new Promise<void>((resolve, reject) => {
    const isTypeScriptRuntime = path.extname(__filename) === '.ts';
    const runnerPath = path.join(__dirname, isTypeScriptRuntime ? 'runner.ts' : 'runner.js');
    
    // Ensure logs directory exists
    const logsDir = path.resolve(projectRoot, 'storage', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, `${runId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    let sessionExpired = false;
    const proc = fork(runnerPath, [], {
      execArgv: isTypeScriptRuntime ? ['-r', 'ts-node/register'] : [],
      env: {
        ...process.env,
        ACTOR_NAME: actorName,
        RUN_ID: runId,
        USER_ID: userId || ''
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    runningProcesses.set(runId, proc);

    proc.stdout?.on('data', (data) => {
      process.stdout.write(`[${runId}] ${data}`);
      logStream.write(data);
    });

    proc.stderr?.on('data', (data) => {
      if (String(data).includes('SHOPEE_SESSION_EXPIRED')) {
        sessionExpired = true;
      }
      process.stderr.write(`[${runId}] ERROR: ${data}`);
      logStream.write(`ERROR: ${data}`);
    });

    proc.on('close', async (code) => {
      logStream.end();
      runningProcesses.delete(runId);
      
      // If it was already marked STOPPED by the interval, do nothing
      const currentRun = await prisma.run.findUnique({ where: { id: runId } });
      if (currentRun?.status === 'STOPPED') {
        return resolve();
      }

      if (code === 0) {
        console.log(`[Worker] Job ${runId} finished successfully.`);
        resolve();
      } else {
        if (sessionExpired && userId) {
          await prisma.shopeeSession.upsert({
            where: { userId },
            create: {
              userId,
              status: 'EXPIRED',
              lastCheckedAt: new Date(),
              lastError: 'Shopee requested a new login or CAPTCHA.'
            },
            update: {
              status: 'EXPIRED',
              lastCheckedAt: new Date(),
              lastError: 'Shopee requested a new login or CAPTCHA.'
            }
          });
        }
        console.error(`[Worker] Job ${runId} exited with code ${code}.`);
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
});
