import { queue } from '@omnicrawl/queue';
import { ActorContext } from '@omnicrawl/sdk';
import * as path from 'path';
import * as fs from 'fs';

console.log('Worker Daemon is starting...');

queue.processJobs(async (runId: string, actorName: string) => {
  console.log(`[Worker] Picked up Job ${runId} for Actor ${actorName}`);
  
  // Resolve actor path dynamically
  const actorPath = path.resolve(process.cwd(), 'actors', actorName);
  const mainFile = path.join(actorPath, 'dist', 'main.js');
  
  if (!fs.existsSync(mainFile)) {
    throw new Error(`Cannot find compiled main.js at ${mainFile}. Did you build the actor?`);
  }

  const context = new ActorContext(runId, { startUrls: [] });
  
  const actorModule = require(mainFile);
  if (typeof actorModule.main !== 'function') {
    throw new Error("Actor does not export a 'main' function.");
  }

  console.log(`[Worker] Executing Actor ${actorName}...`);
  await actorModule.main(context);
  console.log(`[Worker] Job ${runId} finished successfully.`);
});
