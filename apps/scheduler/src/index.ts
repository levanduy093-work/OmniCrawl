import cron from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { prisma } from '@omnicrawl/database';
import { writeRunInput } from '@omnicrawl/sdk';
import dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });

console.log('Scheduler is starting...');

cron.schedule('* * * * *', async () => {
  console.log(`[Scheduler] Waking up at ${new Date().toISOString()} to check schedules...`);
  
  try {
    const schedules = await prisma.schedule.findMany({
      where: { enabled: true },
      include: {
        actor: true,
        user: true
      }
    });
    
    const now = new Date();
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);
    
    for (const schedule of schedules) {
      if (!schedule.user) continue;
      if (schedule.updatedAt.getTime() >= minuteStart.getTime()) continue;

      let nextDate: Date;
      try {
        const interval = CronExpressionParser.parse(schedule.cron, {
          currentDate: new Date(now.getTime() - 60000)
        });
        nextDate = interval.next().toDate();
      } catch {
        console.error(`[Scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cron}`);
        continue;
      }

      try {
        // If the next execution time falls into this current minute
        if (nextDate.getTime() <= now.getTime()) {
          console.log(`[Scheduler] Triggering schedule ${schedule.id} for actor ${schedule.actorId}`);

          // Claim this schedule snapshot before charging and creating the run.
          // A second scheduler instance will lose the compare-and-set claim.
          const createdRun = await prisma.$transaction(async (tx) => {
            const claim = await tx.schedule.updateMany({
              where: {
                id: schedule.id,
                enabled: true,
                updatedAt: schedule.updatedAt
              },
              data: { updatedAt: now }
            });
            if (claim.count !== 1) return null;

            return tx.run.create({
              data: {
                actorId: schedule.actorId,
                userId: schedule.userId!,
                status: 'CREATING'
              }
            });
          });
          if (!createdRun) continue;
          try {
            await writeRunInput(
              createdRun.id,
              {
                id: schedule.actor.id,
                name: schedule.actor.name,
                version: schedule.actor.version
              },
              schedule.input ?? {}
            );
            await prisma.run.update({
              where: { id: createdRun.id },
              data: {
                status: ['shopee-scraper', 'tiktok-scraper'].includes(schedule.actor.name)
                  ? 'BROWSER_PENDING'
                  : 'PENDING'
              }
            });
          } catch (storageError) {
            await prisma.run.update({
              where: { id: createdRun.id },
              data: { status: 'FAILED', finishedAt: new Date() }
            });
            throw storageError;
          }
          console.log(`[Scheduler] Triggered run for schedule ${schedule.id}.`);
        }
      } catch (err) {

        console.error(`[Scheduler] Failed to trigger schedule ${schedule.id}`, err);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking schedules:', error);
  }
});
