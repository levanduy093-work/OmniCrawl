const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  await page.goto('https://shopee.vn/search?keyword=máy%20in%203d');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'storage/debug_shopee_headed.png' });
  await browser.close();
  console.log('Shopee Headed Screenshot taken');
})();
