import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto('https://www.tiktok.com/');
  
  // Try fetching the API endpoint
  const apiRes = await page.evaluate(async () => {
    try {
      const res = await fetch('https://www.tiktok.com/passport/web/account/info/');
      return await res.json();
    } catch(e) {
      return e.message;
    }
  });
  
  console.log("API Response:", apiRes);
  await browser.close();
})();
