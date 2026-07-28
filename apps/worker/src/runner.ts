import * as path from 'path';
import * as fs from 'fs';
import { ActorContext } from '@omnicrawl/sdk';

async function main() {
  const actorName = process.env.ACTOR_NAME;
  const runId = process.env.RUN_ID;
  const userId = process.env.USER_ID;

  if (!actorName || !runId) {
    console.error('Missing ACTOR_NAME or RUN_ID in env');
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const actorPath = path.resolve(projectRoot, 'actors', actorName);
  const mainFile = path.join(actorPath, 'dist', 'main.js');

  if (!fs.existsSync(mainFile)) {
    console.error(`Cannot find compiled main.js at ${mainFile}. Did you build the actor?`);
    process.exit(1);
  }

  let input = {};
  const kvPath = path.resolve(projectRoot, 'storage', 'key_value_stores', runId, 'INPUT.json');
  if (fs.existsSync(kvPath)) {
    input = JSON.parse(fs.readFileSync(kvPath, 'utf8'));
    if (typeof (input as any).cookie === 'string' && (input as any).cookie) {
      fs.writeFileSync(kvPath, JSON.stringify({ ...(input as any), cookie: '[REDACTED]' }));
    }
  }

  // Set Crawlee environment variables
  const storageDir = path.resolve(projectRoot, 'storage');
  process.env.OMNICRAWL_STORAGE_DIR = storageDir;
  process.env.CRAWLEE_STORAGE_DIR = storageDir;
  process.env.CRAWLEE_PURGE_ON_START = 'false';
  process.env.CRAWLEE_DEFAULT_DATASET_ID = runId;
  process.env.CRAWLEE_DEFAULT_REQUEST_QUEUE_ID = runId;
  process.env.CRAWLEE_DEFAULT_KEY_VALUE_STORE_ID = runId;

  const context = new ActorContext(runId, input, userId);

  try {
    const actorModule = require(mainFile);
    if (typeof actorModule.main !== 'function') {
      throw new Error("Actor does not export a 'main' function.");
    }
    
    await actorModule.main(context);
    process.exit(0);
  } catch (err: any) {
    console.error('Actor execution failed:', err);
    process.exit(1);
  }
}

main();
