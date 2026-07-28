import { createPlaywrightRouter, NonRetryableError } from 'crawlee';
import { Dataset } from '@omnicrawl/sdk';
import { sharedState } from './sharedState.js';
import { mapApiItem } from './productMapper.js';

export const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ request, page, log, crawler }) => {
  const { keyword, maxItems, totalExtracted, page: pageNum } = request.userData;

  log.info(`Processing page ${pageNum} for keyword: ${keyword}. Extracted so far: ${totalExtracted}/${maxItems}`);

  await page.waitForTimeout(1000);

  const blockReason = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    if (
      document.querySelector('.shopee-login-required-modal, .shopee-captcha') ||
      /Login Required|Cần đăng nhập/i.test(bodyText)
    ) {
      return 'LOGIN_REQUIRED';
    }
    if (/captcha|xác minh/i.test(bodyText)) return 'CAPTCHA';
    return '';
  });

  if (blockReason === 'LOGIN_REQUIRED') {
    throw new NonRetryableError(
      'Shopee session is not authenticated or has expired. Provide a fresh full Cookie header.'
    );
  }
  if (blockReason === 'CAPTCHA') {
    throw new NonRetryableError(
      'Shopee requested CAPTCHA verification for this session. Refresh the authorized session before retrying.'
    );
  }

  if (sharedState.apiItems.length === 0) {
    await page.waitForSelector('li.shopee-search-item-result__item, div[data-sqe="item"]', { timeout: 15000 }).catch(() => {
      log.warning('No product API response or product cards were found.');
    });
  }

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
  const domItems = await page.evaluate(() => {
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
  const apiItems = sharedState.apiItems
    .map(mapApiItem)
    .filter((item) => item.title && item.price);
  const rawItems = apiItems.length > 0 ? apiItems : domItems;

  log.info(
    apiItems.length > 0
      ? `Using ${apiItems.length} products captured from Shopee search API.`
      : `Using ${domItems.length} products extracted from the DOM.`
  );

  // Deduplication
  const newUniqueItems = [];
  for (const item of rawItems) {
    const uniqueKey = String(item.itemId || item.url || item.title);
    if (!sharedState.seenUrls.has(uniqueKey)) {
      sharedState.seenUrls.add(uniqueKey);
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
    await new Dataset(process.env.RUN_ID || 'default').pushData(itemsToPush);
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
