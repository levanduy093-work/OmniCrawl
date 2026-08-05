const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('response', async (response) => {
    if (response.url().includes('get_item') || response.url().includes('get_item_card')) {
      console.log('Got detail response:', response.url());
      try {
        const json = await response.json();
        fs.writeFileSync('shopee-detail-response.json', JSON.stringify(json, null, 2));
        console.log('Saved to shopee-detail-response.json');
        
        // Let's print fields that might contain sold count
        const item = json.data || json.item;
        if (item) {
          console.log('Keys:', Object.keys(item));
          console.log('historical_sold:', item.historical_sold);
          console.log('sold:', item.sold);
          console.log('tx_count:', item.tx_count);
          console.log('global_sold:', item.global_sold);
          console.log('global_sold_count:', item.global_sold_count);
          console.log('item_status:', item.item_status);
        }
      } catch (e) {
        console.log('Error parsing:', e);
      }
    }
  });

  // Navigate to the product page (the one from DB)
  await page.goto('https://shopee.vn/product/151928218/56651679936');
  await page.waitForTimeout(10000); // Wait for the page and APIs to load
  await browser.close();
})();
