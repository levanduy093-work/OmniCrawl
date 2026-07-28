const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://tiki.vn/search?q=máy%20in%203d');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'storage/debug_tiki.png' });
  await browser.close();
  console.log('Tiki Screenshot taken');
})();
