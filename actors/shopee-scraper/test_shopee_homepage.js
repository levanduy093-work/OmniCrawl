const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  // Go to homepage to get guest cookies
  console.log('Visiting homepage...');
  await page.goto('https://shopee.vn/');
  await page.waitForTimeout(5000);
  
  // Go to search page
  console.log('Visiting search page...');
  await page.goto('https://shopee.vn/search?keyword=máy%20in%203d');
  await page.waitForTimeout(5000);
  
  await page.screenshot({ path: 'storage/debug_shopee_homepage.png' });
  await browser.close();
  console.log('Screenshot taken');
})();
