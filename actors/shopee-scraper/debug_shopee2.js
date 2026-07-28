const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  await page.goto('https://shopee.vn/search?keyword=máy%20in%203d');
  await page.waitForTimeout(5000);
  
  const html = await page.content();
  const match = html.match(/.{0,50}Login Required.{0,50}/i);
  console.log(match ? match[0] : 'Not found');
  
  await browser.close();
})();
