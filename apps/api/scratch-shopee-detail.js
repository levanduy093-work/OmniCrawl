const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('response', async (response) => {
    if (response.url().includes('get_item') || response.url().includes('get_item_card') || response.url().includes('search_items')) {
      console.log('Got response:', response.url());
      try {
        const json = await response.json();
        const fname = response.url().includes('search') ? 'search.json' : 'detail.json';
        fs.writeFileSync(fname, JSON.stringify(json, null, 2));
        console.log(`Saved to ${fname}`);
        
        // Find sold field
        const printSold = (obj, prefix='') => {
          if (!obj || typeof obj !== 'object') return;
          for (const key in obj) {
            if (key.includes('sold') || key.includes('tx_count') || key.includes('sales')) {
              console.log(`${prefix}${key}:`, obj[key]);
            }
            if (typeof obj[key] === 'object') printSold(obj[key], prefix + key + '.');
          }
        };
        printSold(json);
      } catch (e) { }
    }
  });

  await page.goto('https://shopee.vn/search?keyword=m%C3%A1y%20in%203d');
  await page.waitForTimeout(5000);
  await page.goto('https://shopee.vn/product/151928218/56651679936');
  await page.waitForTimeout(10000);
  await browser.close();
})();
