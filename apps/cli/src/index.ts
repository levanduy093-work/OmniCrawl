#!/usr/bin/env node

import { Command } from 'commander';
import { prisma } from '@omnicrawl/database';
import {
  ActorContext,
  migrateLegacyRunStorage,
  writeRunInput
} from '@omnicrawl/sdk';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });

const program = new Command();

program
  .name('omnicrawl')
  .description('CLI for OmniCrawl Platform')
  .version('0.0.1');

program
  .command('init')
  .description('Scaffold a new actor from template')
  .argument('<actorName>', 'Name of the new actor')
  .action(async (actorName: string) => {
    const targetPath = path.resolve(process.cwd(), 'actors', actorName);
    const templatePath = path.resolve(process.cwd(), 'actors', 'template-ts');
    
    if (fs.existsSync(targetPath)) {
      console.error(`Error: Directory ${targetPath} already exists.`);
      process.exit(1);
    }
    if (!fs.existsSync(templatePath)) {
      console.error(`Error: Template not found at ${templatePath}`);
      process.exit(1);
    }

    // Copy template directory
    fs.cpSync(templatePath, targetPath, { recursive: true });

    // Update package.json name
    const pkgPath = path.join(targetPath, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.name = actorName;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

    const manifestPath = path.join(targetPath, 'actor.json');
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : {};
    // Register in DB
    await prisma.actor.create({
      data: {
        name: actorName,
        description: manifest.description || 'Created from template',
        version: manifest.version || '1.0.0',
        inputSchema: manifest.inputSchema ? JSON.stringify(manifest.inputSchema) : null,
        outputSchema: manifest.outputSchema ? JSON.stringify(manifest.outputSchema) : null
      }
    });

    console.log(`Successfully created actor: ${actorName}`);
    console.log(`Run 'pnpm install && pnpm build' to prepare it.`);
  });

program
  .command('run')
  .description('Run an actor locally')
  .argument('<actorPath>', 'Path to the actor directory')
  .option('-i, --input <file>', 'JSON file containing the actor input payload')
  .action(async (actorPath: string, options: { input?: string }) => {
    console.log(`Starting run for actor at ${actorPath}`);
    
    // 1. Resolve path and check
    const absolutePath = path.resolve(process.cwd(), actorPath);
    const mainFile = path.join(absolutePath, 'dist', 'main.js');
    
    if (!fs.existsSync(mainFile)) {
      console.error(`Error: Cannot find compiled main.js at ${mainFile}. Did you build the actor?`);
      process.exit(1);
    }

    // 2. Create Run record in DB
    const actorName = path.basename(absolutePath);
    
    let dbActor = await prisma.actor.findUnique({ where: { name: actorName } });
    if (!dbActor) {
      dbActor = await prisma.actor.create({ data: { name: actorName, description: 'Created via CLI' } });
    }

    const run = await prisma.run.create({
      data: {
        actorId: dbActor.id,
        status: 'RUNNING',
        startedAt: new Date(),
      }
    });

    console.log(`[Job ${run.id}] Created and RUNNING.`);

    // 3. Prepare Context and Run
    const input = options.input
      ? JSON.parse(fs.readFileSync(path.resolve(process.cwd(), options.input), 'utf8'))
      : {};
    writeRunInput(
      run.id,
      { id: dbActor.id, name: dbActor.name, version: dbActor.version },
      input
    );
    const context = new ActorContext(run.id, input);
    
    try {
      // Dynamic import of the actor's main file
      const actorModule = require(mainFile);
      if (typeof actorModule.main !== 'function') {
        throw new Error("Actor does not export a 'main' function.");
      }

      await actorModule.main(context);
      await context.dataset.finalize('SUCCESS');
      
      // 4. Update status to success
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'SUCCESS', finishedAt: new Date() }
      });
      console.log(`[Job ${run.id}] SUCCESS.`);

    } catch (error: any) {
      await context.dataset.finalize('FAILED', error.message);
      context.log.error('Actor execution failed:', error.message);
      
      // Update status to failed
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date() }
      });
      console.log(`[Job ${run.id}] FAILED.`);
    }
  });

program
  .command('storage:migrate')
  .description('Consolidate legacy per-item datasets into the v1 run storage contract')
  .action(async () => {
    const storageRoot = path.resolve(__dirname, '..', '..', '..', 'storage');
    process.env.OMNICRAWL_STORAGE_DIR = storageRoot;
    const runIds = new Set<string>();
    const datasetsRoot = path.join(storageRoot, 'datasets');
    const keyValueRoot = path.join(storageRoot, 'key_value_stores');

    if (fs.existsSync(datasetsRoot)) {
      for (const name of fs.readdirSync(datasetsRoot)) {
        if (fs.statSync(path.join(datasetsRoot, name)).isDirectory()) runIds.add(name);
      }
    }
    if (fs.existsSync(keyValueRoot)) {
      for (const name of fs.readdirSync(keyValueRoot)) {
        const inputPath = path.join(keyValueRoot, name, 'INPUT.json');
        if (fs.existsSync(inputPath)) runIds.add(name);
      }
    }

    let migratedInputs = 0;
    let migratedOutputs = 0;
    let migratedItems = 0;
    for (const runId of runIds) {
      const run = await prisma.run.findUnique({
        where: { id: runId },
        include: { actor: true }
      });
      const result = await migrateLegacyRunStorage(
        runId,
        run
          ? { id: run.actor.id, name: run.actor.name, version: run.actor.version }
          : { name: 'unknown' },
        run?.status ?? 'UNKNOWN'
      );
      if (result.inputMigrated) migratedInputs += 1;
      if (result.outputMigrated) migratedOutputs += 1;
      migratedItems += result.itemCount;
    }

    console.log(JSON.stringify({
      runsScanned: runIds.size,
      inputsMigrated: migratedInputs,
      outputsMigrated: migratedOutputs,
      itemsConsolidated: migratedItems
    }, null, 2));
  });

program.parse();
