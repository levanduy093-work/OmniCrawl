import * as path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ActorContext } from '@omnicrawl/sdk';

/**
 * Utility helper to parse standard Cookie header string into Playwright Cookie format
 */
function parseCookieHeader(cookieHeader: string, defaultDomain = '.example.com') {
  return cookieHeader
    .split(';')
    .map(pair => {
      const [name, ...rest] = pair.trim().split('=');
      return {
        name: name.trim(),
        value: rest.join('=').trim(),
        domain: defaultDomain,
        path: '/'
      };
    })
    .filter(cookie => cookie.name && cookie.value);
}

/**
 * Main execution function called by OmniCrawl Runner/Worker
 */
export async function main(context: ActorContext) {
  const keyword = String(context.input?.keyword || '').trim();
  const startUrl = String(context.input?.startUrl || '').trim();
  const maxItems = Math.min(500, Math.max(1, Number(context.input?.maxItems || 30)));
  const cookieInput = String(context.input?.cookie || '').trim();
  const proxyUrl = String(context.input?.proxyUrl || '').trim();

  context.log.info(`[OmniCrawl Template] Starting crawler...`, {
    keyword,
    startUrl,
    maxItems,
    hasCookie: Boolean(cookieInput),
    hasProxy: Boolean(proxyUrl)
  });

  // Save last run metadata into KeyValueStore
  await context.kv.setValue('lastRun', {
    timestamp: new Date().toISOString(),
    keyword,
    startUrl
  });

  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    // Launch Playwright browser with proxy option if specified
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: true
    };

    if (proxyUrl) {
      launchOptions.proxy = { server: proxyUrl };
    }

    browser = await chromium.launch(launchOptions);
    const browserContext: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });

    // Inject cookies if provided in input
    if (cookieInput) {
      const targetDomain = startUrl ? new URL(startUrl).hostname : '.example.com';
      await browserContext.addCookies(parseCookieHeader(cookieInput, targetDomain));
    }

    page = await browserContext.newPage();

    const targetUrl = startUrl || `https://example.com/search?q=${encodeURIComponent(keyword || 'search')}`;
    context.log.info(`[OmniCrawl Template] Navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Extraction logic template
    const items: Array<{
      itemId: string;
      title: string;
      price: number;
      url: string;
      imageUrl?: string;
      crawledAt: string;
    }> = [];

    // Push sample item to dataset to demonstrate contract
    const pageTitle = await page.title().catch(() => '');
    items.push({
      itemId: `sample-${Date.now()}`,
      title: pageTitle || (keyword || 'Sample Item'),
      price: 100000,
      url: page.url(),
      crawledAt: new Date().toISOString()
    });

    if (items.length > 0) {
      await context.dataset.pushData(items);
      context.log.info(`[OmniCrawl Template] Successfully extracted & saved ${items.length} item(s).`);
    }
  } catch (error: any) {
    context.log.error(`[OmniCrawl Template] Crawl failed: ${error?.message || String(error)}`);
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    context.log.info('[OmniCrawl Template] Cleanup complete. Actor finished.');
  }
}
