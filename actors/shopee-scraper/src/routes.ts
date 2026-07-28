import { createPlaywrightRouter, Dataset } from 'crawlee';
import { sharedState } from './sharedState.js';
import { fetchGuestCookies } from './cookieManager.js';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log, crawler }) => {
  const { keyword, maxItems, totalExtracted, page: pageNum } = request.userData;

  log.info(`Processing page ${pageNum} for keyword: ${keyword}. Extracted so far: ${totalExtracted}/${maxItems}`);

  // Check for login block
  const isBlocked = await page.evaluate(() => {
    return !!document.querySelector('.shopee-login-required-modal, .shopee-captcha');
  });

  if (isBlocked) {
    log.warning(`[ShopeeScraper] Blocked on page ${pageNum}! Attempting to fetch new Guest Cookie and retrying...`);
    // Fetch new cookies and update global state
    sharedState.activeCookies = await fetchGuestCookies();
    // Throw error so Crawlee retries this request automatically
    throw new Error('Shopee Blocked - Forcing Retry with new Cookie');
  }

  // Wait for product wrappers to load
  await page.waitForSelector('li.shopee-search-item-result__item, div[data-sqe="item"]', { timeout: 15000 }).catch(() => {
    log.warning("Product selector not found quickly. Maybe captcha or no results.");
  });

  // Auto-scroll logic to trigger lazy loading
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let currentHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        currentHeight += distance;

        if (currentHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });

  // Extract products
  const rawItems = await page.evaluate(() => {
    const results: any[] = [];
    const productCards = document.querySelectorAll('li.shopee-search-item-result__item, div[data-sqe="item"]');
    
    productCards.forEach((card) => {
      const titleEl = card.querySelector('div[data-sqe="name"] > div.whitespace-normal, div.x5yl5c');
      const priceEl = card.querySelector('span.ZEgDH9, div.vY6SlO, span.k9kG9V');
      const soldEl = card.querySelector('div.r6HknA, div.OckBHh');
      const linkEl = card.querySelector('a[data-sqe="link"]') as HTMLAnchorElement;

      const title = titleEl ? titleEl.textContent?.trim() : '';
      const price = priceEl ? priceEl.textContent?.trim() : '';
      const sold = soldEl ? soldEl.textContent?.trim() : '';
      const url = linkEl ? linkEl.href : '';

      if (title && price) {
        results.push({ title, price, sold, url });
      }
    });
    return results;
  });

  // Deduplication
  const newUniqueItems = [];
  for (const item of rawItems) {
    // Generate a unique key for the item (url is best, but sometimes it has tracking params, so title is also good)
    // We'll use title as the unique key to prevent sponsored duplicates
    if (!sharedState.seenUrls.has(item.title)) {
      sharedState.seenUrls.add(item.title);
      newUniqueItems.push(item);
    }
  }

  log.info(`Found ${rawItems.length} items. ${newUniqueItems.length} are unique.`);

  // Calculate how many items we actually need to push to reach maxItems
  const itemsNeeded = maxItems - totalExtracted;
  const itemsToPush = newUniqueItems.slice(0, itemsNeeded);

  log.info(`Extracted ${newUniqueItems.length} unique items from page ${pageNum}. Pushing ${itemsToPush.length} items to dataset.`);

  // Push to default dataset
  if (itemsToPush.length > 0) {
    await Dataset.pushData(itemsToPush);
  }

  const newTotal = totalExtracted + itemsToPush.length;

  // Pagination Logic
  if (newTotal < maxItems && rawItems.length > 0) {
    const nextPageIndex = pageNum + 1;
    const nextUrl = `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}&page=${nextPageIndex}`;
    
    log.info(`Goal of ${maxItems} not reached (${newTotal} scraped). Enqueueing next page: ${nextPageIndex}`);
    
    await crawler.addRequests([{
      url: nextUrl,
      userData: {
        keyword,
        maxItems,
        totalExtracted: newTotal,
        page: nextPageIndex
      }
    }]);
  } else {
    log.info(`Reached goal of ${maxItems} items. Stopping pagination.`);
  }
});
