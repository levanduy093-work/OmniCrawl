import * as path from 'path';
import * as fs from 'fs';
import { ActorContext } from '@omnicrawl/sdk';

async function main() {
  const actorName = process.env.ACTOR_NAME;
  const runId = process.env.RUN_ID;

  if (!actorName || !runId) {
    console.error('Missing ACTOR_NAME or RUN_ID in env');
    process.exit(1);
  }

  const projectRoot = path.resolve(process.cwd(), '..', '..');
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
  }

  // Set Crawlee environment variables
  process.env.CRAWLEE_STORAGE_DIR = path.resolve(projectRoot, 'storage');
  process.env.CRAWLEE_PURGE_ON_START = 'false';
  process.env.CRAWLEE_DEFAULT_DATASET_ID = runId;

  const context = new ActorContext(runId, input);

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
