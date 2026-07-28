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

            const debit = await tx.user.updateMany({
              where: { id: schedule.userId!, credits: { gte: 10 } },
              data: { credits: { decrement: 10 } }
            });
            if (debit.count !== 1) {
              throw new Error('INSUFFICIENT_CREDITS');
            }

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
                status: schedule.actor.name === 'shopee-scraper'
                  ? 'BROWSER_PENDING'
                  : 'PENDING'
              }
            });
          } catch (storageError) {
            await prisma.$transaction([
              prisma.run.update({
                where: { id: createdRun.id },
                data: { status: 'FAILED', finishedAt: new Date() }
              }),
              prisma.user.update({
                where: { id: schedule.userId! },
                data: { credits: { increment: 10 } }
              })
            ]);
            throw storageError;
          }
          console.log(`[Scheduler] Triggered run and deducted 10 credits.`);
        }
      } catch (err) {
        if (err instanceof Error && err.message === 'INSUFFICIENT_CREDITS') {
          console.log(`[Scheduler] Skipping schedule ${schedule.id}: insufficient credits (User: ${schedule.userId})`);
          continue;
        }
        console.error(`[Scheduler] Failed to trigger schedule ${schedule.id}`, err);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking schedules:', error);
  }
});
