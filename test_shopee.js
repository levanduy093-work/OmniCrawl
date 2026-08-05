const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/v4/search/search_items')) {
      try {
        const json = await response.json();
        const items = json.items || json.data?.items;
        if (items && items.length > 0) {
          console.log('--- search_items item[0] keys ---');
          const item = items[0].item_basic || items[0];
          console.log(Object.keys(item));
          console.log('sold fields:', {
            sold: item.sold,
            historical_sold: item.historical_sold,
            global_sold: item.global_sold_count,
            sold_count: item.sold_count,
            total_sold: item.total_sold,
            historical_sold_count: item.historical_sold_count
          });
        }
      } catch (e) {}
    }
  });

  await page.goto('https://shopee.vn/search?keyword=gi%C3%A0y');
  await page.waitForTimeout(5000);
  await browser.close();
})();
