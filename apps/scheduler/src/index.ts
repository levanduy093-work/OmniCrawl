import cron from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import { prisma } from '@omnicrawl/database';
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
        user: { include: { shopeeSession: true } }
      }
    });
    
    const now = new Date();
    const minuteStart = new Date(now);
    minuteStart.setSeconds(0, 0);
    
    for (const schedule of schedules) {
      if (!schedule.user) continue;
      if (schedule.updatedAt.getTime() >= minuteStart.getTime()) continue;
      if (
        schedule.actor.name === 'shopee-scraper' &&
        schedule.user.shopeeSession?.status !== 'CONNECTED'
      ) {
        console.log(`[Scheduler] Skipping Shopee schedule ${schedule.id}: account is not connected.`);
        continue;
      }

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
          const triggered = await prisma.$transaction(async (tx) => {
            const claim = await tx.schedule.updateMany({
              where: {
                id: schedule.id,
                enabled: true,
                updatedAt: schedule.updatedAt
              },
              data: { updatedAt: now }
            });
            if (claim.count !== 1) return false;

            const debit = await tx.user.updateMany({
              where: { id: schedule.userId!, credits: { gte: 10 } },
              data: { credits: { decrement: 10 } }
            });
            if (debit.count !== 1) {
              throw new Error('INSUFFICIENT_CREDITS');
            }

            await tx.run.create({
              data: {
                actorId: schedule.actorId,
                userId: schedule.userId!,
                status: 'PENDING'
              }
            });
            return true;
          });
          if (!triggered) continue;
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
