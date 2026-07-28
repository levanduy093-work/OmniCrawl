#!/usr/bin/env node

import { Command } from 'commander';
import { prisma } from '@omnicrawl/database';
import { ActorContext } from '@omnicrawl/sdk';
import * as path from 'path';
import * as fs from 'fs';

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

    // Register in DB
    await prisma.actor.create({
      data: { name: actorName, description: 'Created from template' }
    });

    console.log(`Successfully created actor: ${actorName}`);
    console.log(`Run 'pnpm install && pnpm build' to prepare it.`);
  });

program
  .command('run')
  .description('Run an actor locally')
  .argument('<actorPath>', 'Path to the actor directory')
  .action(async (actorPath: string) => {
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
    const context = new ActorContext(run.id, { startUrls: [] });
    
    try {
      // Dynamic import of the actor's main file
      const actorModule = require(mainFile);
      if (typeof actorModule.main !== 'function') {
        throw new Error("Actor does not export a 'main' function.");
      }

      await actorModule.main(context);
      
      // 4. Update status to success
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'SUCCESS', finishedAt: new Date() }
      });
      console.log(`[Job ${run.id}] SUCCESS.`);

    } catch (error: any) {
      context.log.error('Actor execution failed:', error.message);
      
      // Update status to failed
      await prisma.run.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date() }
      });
      console.log(`[Job ${run.id}] FAILED.`);
    }
  });

program.parse();
