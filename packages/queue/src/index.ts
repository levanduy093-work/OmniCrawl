import { prisma } from '@omnicrawl/database';
import type { Run } from '@omnicrawl/database';

export class JobQueue {
  async pushJob(actorId: string, inputData: any = {}): Promise<Run> {
    const run = await prisma.run.create({
      data: {
        actorId,
        input: inputData,
        status: 'PENDING',
      }
    });
    return run;
  }

  // Polling mechanism to mimic a real queue for Phase 3 local execution
  async processJobs(handler: (runId: string, actorName: string, userId: string | null) => Promise<void>) {
    console.log('[Queue] Worker started listening for jobs...');
    
    setInterval(async () => {
      try {
        // Select a candidate, then claim it with a compare-and-set update.
        // This prevents two workers from executing the same run.
        const job = await prisma.run.findFirst({
          where: { status: 'PENDING' },
          include: { actor: true },
          orderBy: { createdAt: 'asc' }
        });

        if (!job) return;

        const claim = await prisma.run.updateMany({
          where: { id: job.id, status: 'PENDING' },
          data: { status: 'RUNNING', startedAt: new Date() }
        });

        if (claim.count !== 1) return;

        try {
          await handler(job.id, job.actor.name, job.userId);
          // Preserve STOPPED/STOPPING if a stop request raced with completion.
          await prisma.run.updateMany({
            where: { id: job.id, status: 'RUNNING' },
            data: { status: 'SUCCESS', finishedAt: new Date() }
          });
        } catch (err) {
          console.error(`[Queue] Job ${job.id} failed`, err);
          await prisma.run.updateMany({
            where: { id: job.id, status: 'RUNNING' },
            data: { status: 'FAILED', finishedAt: new Date() }
          });
        }
      } catch (err) {
        console.error('[Queue] Failed to poll or claim a job', err);
      }
    }, 2000); // Poll every 2 seconds
  }
}

export const queue = new JobQueue();
