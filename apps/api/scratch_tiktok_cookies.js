import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  await page.goto('https://www.tiktok.com/');
  await page.waitForTimeout(3000); // Wait for page to load
  
  const cookies = await context.cookies();
  console.log("TikTok Guest Cookies:");
  cookies.forEach(c => console.log(`${c.name}: ${c.value}`));
  
  await browser.close();
})();
