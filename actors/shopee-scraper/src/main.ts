import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mapApiItem } from './productMapper.js';

const SESSION_EXPIRED = 'SHOPEE_SESSION_EXPIRED';

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEdgeExecutable() {
  if (process.env.OMNICRAWL_EDGE_EXECUTABLE_PATH) {
    return process.env.OMNICRAWL_EDGE_EXECUTABLE_PATH;
  }
  if (process.platform === 'darwin') {
    return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  }
  return '/usr/bin/microsoft-edge';
}

async function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local browser control port.'));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function launchEdgeProfile(profileDir: string, proxyUrl?: string) {
  const edgeExecutable = getEdgeExecutable();
  if (!fs.existsSync(edgeExecutable)) {
    throw new Error(`Microsoft Edge was not found at ${edgeExecutable}.`);
  }

  const debugPort = await getAvailablePort();
  const edgeArgs = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ];
  if (proxyUrl) {
    const parsedProxy = new URL(proxyUrl);
    if (parsedProxy.username || parsedProxy.password) {
      throw new Error(
        'SHOPEE_PROXY_URL must use IP allowlisting and must not contain credentials.'
      );
    }
    edgeArgs.splice(edgeArgs.length - 1, 0, `--proxy-server=${parsedProxy.toString()}`);
  }
  const edgeProcess = spawn(edgeExecutable, edgeArgs, { stdio: 'ignore' });

  const endpoint = `http://127.0.0.1:${debugPort}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (edgeProcess.exitCode !== null) {
      throw new Error('Microsoft Edge exited before the crawler could connect.');
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) {
        const browser = await chromium.connectOverCDP(endpoint);
        const browserContext = browser.contexts()[0];
        if (!browserContext) throw new Error('Unable to access the Edge browser profile.');
        return { browser, browserContext, edgeProcess };
      }
    } catch {
      // Edge is still starting.
    }
    await sleep(250);
  }

  edgeProcess.kill('SIGTERM');
  throw new Error('Timed out while starting Microsoft Edge for the crawler.');
}

function parseCookieHeader(cookieHeader: string) {
  return cookieHeader.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: '.shopee.vn',
      path: '/'
    };
  }).filter(cookie => cookie.name && cookie.value);
}

async function detectBlockedPage(page: Page) {
  return page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    if (
      document.querySelector('.shopee-login-required-modal, .shopee-captcha') ||
      /Login Required|Cần đăng nhập|Đăng nhập/i.test(bodyText)
    ) {
      return 'LOGIN_REQUIRED';
    }
    if (/captcha|xác minh/i.test(bodyText)) return 'CAPTCHA';
    return '';
  });
}

export async function main(context: any) {
  const keyword = String(context.input?.keyword || 'máy in 3d').trim();
  const requestedMaxItems = Number(context.input?.maxItems ?? 30);
  const maxItems = Number.isFinite(requestedMaxItems)
    ? Math.min(500, Math.max(1, Math.floor(requestedMaxItems)))
    : 30;
  const cookieInput = String(context.input?.cookie || process.env.SHOPEE_COOKIE || '').trim();
  const proxyUrl = String(context.input?.proxyUrl || process.env.SHOPEE_PROXY_URL || '').trim();
  const storageRoot = process.env.OMNICRAWL_STORAGE_DIR || path.resolve(process.cwd(), 'storage');
  const profileDir = context.userId
    ? path.join(storageRoot, 'browser_profiles', 'shopee', context.userId)
    : '';

  if (!profileDir && !cookieInput) {
    throw new Error(`${SESSION_EXPIRED}: Connect your Shopee account before running this crawler.`);
  }

  context.log.info(
    `[ShopeeScraper] Starting authenticated crawl for "${keyword}", maxItems: ${maxItems}`
  );

  let browser: Browser | undefined;
  let browserContext: BrowserContext;
  let edgeProcess: ChildProcess | undefined;

  if (profileDir) {
    const launched = await launchEdgeProfile(profileDir, proxyUrl || undefined);
    browser = launched.browser;
    browserContext = launched.browserContext;
    edgeProcess = launched.edgeProcess;
  } else {
    browser = await chromium.launch({
      channel: process.env.OMNICRAWL_BROWSER_CHANNEL || 'msedge',
      headless: true
    });
    browserContext = await browser.newContext({ locale: 'vi-VN' });
    await browserContext.addCookies(parseCookieHeader(cookieInput));
  }

  const seen = new Set<string>();
  const page = browserContext.pages()[0] || await browserContext.newPage();

  try {
    for (let pageIndex = 0; seen.size < maxItems; pageIndex += 1) {
      const url = `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}&page=${pageIndex}`;
      context.log.info(`[ShopeeScraper] Loading page ${pageIndex}. Collected ${seen.size}/${maxItems}.`);

      const responsePromise = page.waitForResponse(
        response => response.url().includes('/api/v4/search/search_items'),
        { timeout: 45_000 }
      );

      let response;
      try {
        const [, searchResponse] = await Promise.all([
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
          responsePromise
        ]);
        response = searchResponse;
      } catch {
        const blockReason = await detectBlockedPage(page);
        const currentUrl = page.url();
        if (
          currentUrl.includes('/verify/') ||
          currentUrl.includes('/traffic/error') ||
          blockReason === 'CAPTCHA'
        ) {
          throw new Error(
            'Shopee traffic verification blocked this crawl. Wait before retrying or configure a residential SHOPEE_PROXY_URL.'
          );
        }
        if (blockReason) {
          throw new Error(`${SESSION_EXPIRED}: Shopee requires login or CAPTCHA (${blockReason}).`);
        }
        throw new Error('Shopee search API did not respond. Retry later or reconnect the account.');
      }

      if (response.status() === 401 || response.status() === 403) {
        throw new Error(`${SESSION_EXPIRED}: Shopee rejected the saved session (${response.status()}).`);
      }

      const payload: any = await response.json().catch(() => null);
      if (payload?.error === 90309999 || payload?.error_msg === 'Login Required') {
        throw new Error(`${SESSION_EXPIRED}: Shopee requires a fresh login.`);
      }

      const apiItems = payload?.data?.items || payload?.items;
      if (!Array.isArray(apiItems)) {
        const currentUrl = page.url();
        if (
          currentUrl.includes('/verify/') ||
          currentUrl.includes('/traffic/error') ||
          payload?.error
        ) {
          throw new Error(
            `Shopee traffic verification blocked this crawl (error ${String(payload?.error ?? 'unknown')}). ` +
            'Wait before retrying or configure a residential SHOPEE_PROXY_URL.'
          );
        }
        throw new Error(
          `Shopee returned an unsupported search response (keys: ${Object.keys(payload || {}).join(', ') || 'none'}).`
        );
      }

      const itemsToPush = [];
      for (const item of apiItems.map(mapApiItem)) {
        if (!item.title || !item.price) continue;
        const key = String(item.itemId || item.url || item.title);
        if (seen.has(key)) continue;
        seen.add(key);
        itemsToPush.push(item);
        if (seen.size >= maxItems) break;
      }
      if (itemsToPush.length > 0) {
        await context.dataset.pushData(itemsToPush);
      }

      context.log.info(`[ShopeeScraper] Captured ${itemsToPush.length} new products.`);
      if (apiItems.length === 0 || itemsToPush.length === 0) break;
      await page.waitForTimeout(3000 + Math.floor(Math.random() * 4000));
    }
  } finally {
    await browser?.close().catch(() => undefined);
    if (!browser) {
      await browserContext.close().catch(() => undefined);
    }
    if (edgeProcess && edgeProcess.exitCode === null) {
      edgeProcess.kill('SIGTERM');
    }
  }

  if (seen.size === 0 && context.input?.allowEmpty !== true) {
    throw new Error('Shopee crawl completed without extracting any products.');
  }

  context.log.info(`[ShopeeScraper] Finished with ${Math.min(seen.size, maxItems)} unique products.`);
}
