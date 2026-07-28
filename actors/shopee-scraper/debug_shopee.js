const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://shopee.vn/search?keyword=máy%20in%203d');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'storage/debug.png' });
  await browser.close();
  console.log('Screenshot taken');
})();
