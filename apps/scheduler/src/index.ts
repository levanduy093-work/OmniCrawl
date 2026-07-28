import cron from 'node-cron';
import parser from 'cron-parser';
import { prisma } from '@omnicrawl/database';

console.log('Scheduler is starting...');

cron.schedule('* * * * *', async () => {
  console.log(`[Scheduler] Waking up at ${new Date().toISOString()} to check schedules...`);
  
  try {
    const schedules = await prisma.schedule.findMany({
      where: { enabled: true },
      include: { user: true }
    });
    
    const now = new Date();
    
    for (const schedule of schedules) {
      if (!schedule.user) continue;

      try {
        const interval = parser.parseExpression(schedule.cron, { currentDate: new Date(now.getTime() - 60000) });
        const nextDate = interval.next().toDate();
        
        // If the next execution time falls into this current minute
        if (nextDate.getTime() <= now.getTime()) {
          console.log(`[Scheduler] Triggering schedule ${schedule.id} for actor ${schedule.actorId}`);
          
          if (schedule.user.credits < 10) {
            console.log(`[Scheduler] Skipping schedule ${schedule.id}: insufficient credits (User: ${schedule.userId})`);
            continue;
          }

          // Deduct credits and create run
          await prisma.$transaction([
            prisma.user.update({
              where: { id: schedule.userId! },
              data: { credits: { decrement: 10 } }
            }),
            prisma.run.create({
              data: {
                actorId: schedule.actorId,
                userId: schedule.userId!,
                status: 'PENDING'
              }
            })
          ]);
          console.log(`[Scheduler] Triggered run and deducted 10 credits.`);
        }
      } catch (err) {
        console.error(`[Scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.cron}`);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error checking schedules:', error);
  }
});
