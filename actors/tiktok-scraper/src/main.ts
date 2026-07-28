import { PlaywrightCrawler } from 'crawlee';

export async function main(context: any) {
  const keyword = context.input?.keyword || 'máy in 3d';
  const mode = context.input?.mode || 'products';
  const maxItems = context.input?.maxItems || 50;

  console.log(`[INFO] [TikTokScraper] Starting bot for keyword: ${keyword}, mode: ${mode}, maxItems: ${maxItems}`);

  const crawler = new PlaywrightCrawler({
    maxRequestsPerCrawl: 50,
    headless: true,
    async requestHandler({ page, log }: { page: any; log: any }) {
      log.info(`[TikTokScraper] Processing TikTok search for: ${keyword}`);
      const searchUrl = mode === 'products'
        ? `https://www.tiktok.com/search/product?q=${encodeURIComponent(keyword)}`
        : `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;

      await page.goto(searchUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);

      log.info('[TikTokScraper] Finished loading TikTok search page.');
    }
  });

  const targetUrl = mode === 'products'
    ? `https://www.tiktok.com/search/product?q=${encodeURIComponent(keyword)}`
    : `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}`;

  await crawler.run([targetUrl]);
  console.log(`[INFO] [TikTokScraper] TikTok Crawler finished.`);
}
