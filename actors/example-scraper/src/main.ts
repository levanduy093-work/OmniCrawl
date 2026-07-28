import { ActorContext } from '@omnicrawl/sdk';

export async function main(context: ActorContext) {
  context.log.info('Hello from Example Scraper!');
  context.log.info('This is where your scraping logic goes.');
  
  // Simulate some scraping work
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const scrapedData = [
    { title: 'Product 1', price: 100, url: 'https://example.com/p1' },
    { title: 'Product 2', price: 200, url: 'https://example.com/p2' }
  ];
  
  context.log.info(`Scraped ${scrapedData.length} items. Saving to dataset...`);
  
  // Save to dataset
  await context.dataset.pushData(scrapedData);
  
  context.log.info('Done!');
}
