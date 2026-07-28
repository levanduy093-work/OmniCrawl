import { queue } from '@omnicrawl/queue';
import * as path from 'path';
import * as fs from 'fs';
import { fork, ChildProcess } from 'child_process';
import { prisma } from '@omnicrawl/database';

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
      proc.kill('SIGTERM'); // Send termination signal
      runningProcesses.delete(run.id);
      
      // Update DB to STOPPED
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'STOPPED', finishedAt: new Date() }
      });
    }
  }
}, 3000); // Check every 3 seconds

queue.processJobs(async (runId: string, actorName: string) => {
  console.log(`[Worker] Picked up Job ${runId} for Actor ${actorName}`);
  
  return new Promise<void>((resolve, reject) => {
    const runnerPath = path.join(__dirname, 'runner.ts');
    
    // Ensure logs directory exists
    const projectRoot = path.resolve(process.cwd(), '..', '..');
    const logsDir = path.resolve(projectRoot, 'storage', 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, `${runId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    // Use ts-node/register to run TypeScript runner file directly in dev
    const proc = fork(runnerPath, [], {
      execArgv: ['-r', 'ts-node/register'],
      env: {
        ...process.env,
        ACTOR_NAME: actorName,
        RUN_ID: runId
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    runningProcesses.set(runId, proc);

    proc.stdout?.on('data', (data) => {
      process.stdout.write(`[${runId}] ${data}`);
      logStream.write(data);
    });

    proc.stderr?.on('data', (data) => {
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
        console.error(`[Worker] Job ${runId} exited with code ${code}.`);
        reject(new Error(`Process exited with code ${code}`));
      }
    });
  });
});
