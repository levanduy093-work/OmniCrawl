import { ActorContext } from '@omnicrawl/sdk';

export async function main(context: ActorContext) {
  context.log.info('Template actor started', { input: context.input });
  
  // Example of using KeyValueStore
  await context.kv.setValue('lastRun', new Date().toISOString());

  // Example of pushing data
  await context.dataset.pushData({
    url: context.input.startUrl || 'https://example.com',
    title: 'Example Domain',
    crawledAt: new Date().toISOString()
  });

  context.log.info('Template actor finished successfully');
}
