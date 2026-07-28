import { PlaywrightCrawler } from 'crawlee';
import { router } from './routes.js';
import * as path from 'path';
import * as fs from 'fs';
import { fetchGuestCookies } from './cookieManager.js';
import { sharedState } from './sharedState.js';

export async function main(context: any) {
  const keyword = context.input?.keyword || 'máy in 3d';
  const maxItems = context.input?.maxItems || 30;
  const cookieInput = context.input?.cookie || '';

  console.log(`[INFO] [ShopeeScraper] Starting Crawlee bot for keyword: ${keyword}, maxItems: ${maxItems}`);

  // Initialize shared state
  sharedState.seenUrls.clear();

  // Initialize cookies
  if (cookieInput) {
    if (cookieInput.includes('=')) {
      sharedState.activeCookies = cookieInput.split(';').map((pair: string) => {
        const [name, ...rest] = pair.trim().split('=');
        return {
          name: name.trim(),
          value: rest.join('=').trim(),
          domain: '.shopee.vn',
          path: '/',
        };
      }).filter((c: any) => c.name && c.value);
      console.log(`[INFO] [ShopeeScraper] Parsed ${sharedState.activeCookies.length} cookies from input.`);
    } else {
      sharedState.activeCookies = [{
        name: 'SPC_EC',
        value: cookieInput,
        domain: '.shopee.vn',
        path: '/',
      }];
      console.log(`[INFO] [ShopeeScraper] Parsed single SPC_EC cookie from input.`);
    }
  } else {
    console.log(`[INFO] [ShopeeScraper] No cookie provided. Attempting to auto-fetch guest cookies...`);
    sharedState.activeCookies = await fetchGuestCookies();
  }

  const crawler = new PlaywrightCrawler({
    requestHandler: router,
    maxRequestsPerCrawl: 50,
    headless: true, // Run headless in background
    preNavigationHooks: [
      async ({ page }) => {
        if (sharedState.activeCookies.length > 0) {
          await page.context().clearCookies();
          await page.context().addCookies(sharedState.activeCookies);
        }
      },
    ],
  });

  const startUrl = `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}`;

  await crawler.run([
    {
      url: startUrl,
      userData: {
        keyword,
        maxItems,
        totalExtracted: 0,
        page: 0, // Shopee starts at page 0
      }
    }
  ]);

  console.log(`[INFO] [ShopeeScraper] Crawlee bot finished. Total unique items found: ${sharedState.seenUrls.size}`);
}

