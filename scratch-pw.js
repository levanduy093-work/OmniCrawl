const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('response', async (response) => {
    if (response.url().includes('/api/v4/search/search_items')) {
      console.log('Got search_items response');
      try {
        const json = await response.json();
        fs.writeFileSync('shopee-search-response.json', JSON.stringify(json, null, 2));
        console.log('Saved to shopee-search-response.json');
      } catch (e) {
        console.log('Error parsing response:', e);
      }
    }
  });

  await page.goto('https://shopee.vn/search?keyword=m%C3%A1y%20in%203d');
  await page.waitForTimeout(5000); // wait for 5s to ensure response is captured
  await browser.close();
})();
