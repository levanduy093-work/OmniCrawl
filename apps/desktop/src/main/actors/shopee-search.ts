import type { DesktopActor } from './contracts';
import { ManualInterventionError } from './contracts';

interface ShopeeSearchItem {
  itemId: string;
  shopId: string;
  title: string;
  url: string;
  image: string | null;
  price: string | null;
  searchKeyword: string;
  searchPage: number;
  searchRank: number;
  observedAt: string;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed)))
    : fallback;
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Run stopped'));
    }, { once: true });
  });
}

const PAGE_PROBE_SCRIPT = `(() => {
  const bodyText = (document.body?.innerText || '').toLowerCase();
  const pageSignal = location.href.toLowerCase() + ' ' + bodyText.slice(0, 5000);
  const blocked = pageSignal.includes('captcha') ||
    pageSignal.includes('verify/traffic') ||
    pageSignal.includes('unusual traffic') ||
    pageSignal.includes('hoạt động bất thường');
  const loginRequired = location.href.toLowerCase().includes('buyer/login');
  const rows = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href*="-i."]')) {
    const href = anchor.href || '';
    const marker = href.toLowerCase().indexOf('-i.');
    if (marker < 0) continue;
    const identity = href.slice(marker + 3).split('?')[0].split('#')[0].split('/')[0].split('.');
    const shopId = identity[0];
    const itemId = identity[1];
    if (!shopId || !itemId || seen.has(itemId)) continue;
    const text = (anchor.innerText || anchor.getAttribute('aria-label') || '').trim();
    if (!text) continue;
    seen.add(itemId);
    const image = anchor.querySelector('img');
    const priceMatch = text.match(/(?:₫|đ)[ ]*([0-9.,]+)|([0-9.,]+)[ ]*(?:₫|đ)/i);
    rows.push({
      itemId,
      shopId,
      title: text.split(String.fromCharCode(10)).map((part) => part.trim()).filter(Boolean)[0] || text,
      url: href.split('?')[0],
      image: image?.currentSrc || image?.src || null,
      price: priceMatch ? (priceMatch[1] || priceMatch[2] || null) : null
    });
  }
  return { blocked, loginRequired, rows };
})()`;

export const shopeeSearchActor: DesktopActor = {
  summary: {
    name: 'shopee-search',
    title: 'Shopee Search',
    description: 'Thu thập sản phẩm theo từ khóa bằng profile Shopee trong OmniCrawl.',
    platform: 'shopee',
    version: '0.1.0',
    capabilities: ['persistent-profile', 'local-dataset', 'checkpoint', 'csv', 'jsonl'],
    inputSchema: {
      type: 'object',
      required: ['keyword'],
      properties: {
        keyword: {
          type: 'string',
          title: 'Từ khóa',
          description: 'Có thể nhập nhiều từ khóa, cách nhau bằng dấu phẩy.'
        },
        maxItems: {
          type: 'integer',
          title: 'Số sản phẩm tối đa',
          minimum: 1,
          maximum: 500,
          default: 50
        }
      }
    }
  },

  validateInput(input) {
    const keywords = String(input.keyword ?? '')
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    if (!keywords.length) throw new Error('Vui lòng nhập ít nhất một từ khóa Shopee.');
    return {
      keyword: keywords.join(', '),
      maxItems: boundedInteger(input.maxItems, 50, 1, 500)
    };
  },

  async execute(context) {
    const keywords = String(context.input.keyword).split(',').map((value) => value.trim());
    const maxItems = Number(context.input.maxItems);
    const seen = new Set<string>();
    let rank = 0;

    await context.browser.openPlatform('shopee', 'default');
    context.log(`Đã mở profile Shopee. Bắt đầu ${keywords.length} từ khóa.`);

    for (const keyword of keywords) {
      const pageBudget = Math.min(20, Math.max(1, Math.ceil(maxItems / 30) + 2));
      for (let page = 0; page < pageBudget && seen.size < maxItems; page += 1) {
        if (context.signal.aborted) throw context.signal.reason;
        const url = `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}&page=${page}`;
        context.log(`Đang đọc “${keyword}” · trang ${page + 1}`);
        await context.browser.loadURL(url);
        await wait(2200, context.signal);

        const currentUrl = context.browser.getState().url?.toLowerCase() ?? '';
        if (currentUrl.includes('/verify/traffic/')) {
          const loginRequired = currentUrl.includes('is_logged_in=false');
          throw new ManualInterventionError(
            loginRequired
              ? 'Shopee yêu cầu đăng nhập. Hãy đăng nhập trong Browser workspace rồi chạy lại task.'
              : 'Shopee yêu cầu xác minh/CAPTCHA. Browser đã được giữ nguyên để bạn xử lý.'
          );
        }
        if (currentUrl.includes('/buyer/login')) {
          throw new ManualInterventionError(
            'Shopee yêu cầu đăng nhập. Hãy đăng nhập trong Browser workspace rồi chạy lại task.'
          );
        }

        for (let step = 0; step < 4; step += 1) {
          await context.browser.evaluate(`window.scrollBy({ top: Math.max(600, window.innerHeight * 0.85), behavior: 'smooth' }); true;`);
          await wait(650, context.signal);
        }

        const result = await context.browser.evaluate<{
          blocked: boolean;
          loginRequired: boolean;
          rows: Array<Omit<ShopeeSearchItem, 'searchKeyword' | 'searchPage' | 'searchRank' | 'observedAt'>>;
        }>(PAGE_PROBE_SCRIPT);

        if (result.blocked || result.loginRequired) {
          throw new ManualInterventionError(
            result.loginRequired
              ? 'Shopee yêu cầu đăng nhập. Hãy đăng nhập trong Browser workspace rồi chạy lại task.'
              : 'Shopee yêu cầu xác minh/CAPTCHA. Browser đã được giữ nguyên để bạn xử lý.'
          );
        }

        let addedOnPage = 0;
        for (const row of result.rows) {
          if (seen.has(row.itemId) || seen.size >= maxItems) continue;
          seen.add(row.itemId);
          rank += 1;
          const item: ShopeeSearchItem = {
            ...row,
            searchKeyword: keyword,
            searchPage: page + 1,
            searchRank: rank,
            observedAt: new Date().toISOString()
          };
          if (context.database.addItem(context.runId, row.itemId, item as unknown as Record<string, unknown>)) {
            addedOnPage += 1;
            context.emitProgress();
          }
        }
        context.log(`Trang ${page + 1}: thêm ${addedOnPage} sản phẩm, tổng ${seen.size}.`);
        if (addedOnPage === 0) break;
      }
    }

    if (seen.size === 0) {
      return { status: 'PARTIAL', error: 'Không tìm thấy sản phẩm từ nội dung trang Shopee.' };
    }
    return { status: 'SUCCESS' };
  }
};
