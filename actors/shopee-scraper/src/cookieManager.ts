import { chromium } from 'playwright';

export async function fetchGuestCookies(): Promise<any[]> {
  console.log('[INFO] [ShopeeScraper] Fetching fresh Guest Cookies from shopee.vn...');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    
    await page.goto('https://shopee.vn/', { timeout: 30000 });
    // Wait for the page to settle and cookies to be set
    await page.waitForTimeout(5000);
    
    const cookies = await context.cookies();
    console.log(`[INFO] [ShopeeScraper] Successfully fetched ${cookies.length} guest cookies.`);
    return cookies;
  } catch (error: any) {
    console.error(`[ERROR] [ShopeeScraper] Failed to fetch guest cookies: ${error.message}`);
    return [];
  } finally {
    await browser.close();
  }
}
