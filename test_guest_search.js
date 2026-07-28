const { chromium } = require('playwright');
const { fetchGuestCookies } = require('./dist/cookieManager.js');

(async () => {
  const cookies = await fetchGuestCookies();
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  await context.addCookies(cookies);
  const page = await context.newPage();
  
  await page.goto('https://shopee.vn/search?keyword=máy%20in%203d');
  await page.waitForTimeout(5000);
  
  const html = await page.content();
  const hasProducts = html.includes('data-sqe="item"');
  console.log('Search page has products:', hasProducts);
  
  await browser.close();
})();
