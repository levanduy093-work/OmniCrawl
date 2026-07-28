import { prisma } from '@omnicrawl/database';

export class JobQueue {
  async pushJob(actorId: string, inputData: any = {}) {
    const run = await prisma.run.create({
      data: {
        actorId,
        status: 'PENDING',
      }
    });
    return run;
  }

  // Polling mechanism to mimic a real queue for Phase 3 local execution
  async processJobs(handler: (runId: string, actorName: string) => Promise<void>) {
    console.log('[Queue] Worker started listening for jobs...');
    
    setInterval(async () => {
      // Find one pending job
      const job = await prisma.run.findFirst({
        where: { status: 'PENDING' },
        include: { actor: true },
        orderBy: { createdAt: 'asc' }
      });

      if (job) {
        // Lock the job by changing status to RUNNING
        await prisma.run.update({
          where: { id: job.id },
          data: { status: 'RUNNING', startedAt: new Date() }
        });
        
        try {
          await handler(job.id, job.actor.name);
          await prisma.run.update({
            where: { id: job.id },
            data: { status: 'SUCCESS', finishedAt: new Date() }
          });
        } catch (err) {
          console.error(`[Queue] Job ${job.id} failed`, err);
          await prisma.run.update({
            where: { id: job.id },
            data: { status: 'FAILED', finishedAt: new Date() }
          });
        }
      }
    }, 2000); // Poll every 2 seconds
  }
}

export const queue = new JobQueue();
