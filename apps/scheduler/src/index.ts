import cron from 'node-cron';
import { prisma } from '@omnicrawl/database';

console.log('Scheduler is starting...');

// A simple loop to simulate schedule triggering.
// In a real app, you'd dynamically load cron patterns from DB.
cron.schedule('* * * * *', async () => {
  console.log('[Scheduler] Waking up to check schedules...');
  
  try {
    const schedules = await prisma.schedule.findMany({
      where: { enabled: true }
    });
    
    for (const schedule of schedules) {
      // Very naive check for simulation:
      console.log(`[Scheduler] Found schedule ${schedule.id} for actor ${schedule.actorId}. Triggering...`);
      
      await prisma.run.create({
        data: {
          actorId: schedule.actorId,
          status: 'PENDING'
        }
      });
    }
  } catch (error) {
    console.error('[Scheduler] Error checking schedules:', error);
  }
});
