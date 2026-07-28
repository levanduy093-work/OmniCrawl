const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  console.log('Visiting shopee.vn to get guest cookies...');
  await page.goto('https://shopee.vn/');
  await page.waitForTimeout(5000);
  
  const cookies = await context.cookies();
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  console.log('==================== GUEST COOKIE STRING ====================');
  console.log(cookieString);
  console.log('=============================================================');
  
  await browser.close();
})();
