window.addEventListener('omnicrawl:tiktok-response', (event) => {
  chrome.runtime.sendMessage({
    type: 'TIKTOK_RESPONSE',
    detail: event.detail
  }).catch(() => undefined);
});

function isProductSearchPage() {
  return (
    location.pathname.includes('/search/product') ||
    new URLSearchParams(location.search).get('omnicrawl_mode') === 'products'
  );
}

function parseTikTokUrl(url) {
  const videoMatch = url.match(/\/video\/(\d+)/);
  if (videoMatch) return { itemId: videoMatch[1], sourceType: 'video' };

  try {
    const parsed = new URL(url);
    const queryId = parsed.searchParams.get('product_id') || parsed.searchParams.get('id');
    const productMatch = parsed.pathname.match(/\/(?:view\/)?product\/(\d+)/);
    const itemId = queryId || productMatch?.[1];
    if (itemId) return { itemId, sourceType: 'product' };
  } catch {
    // Ignore malformed href values.
  }
  return null;
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function numericText(value) {
  const match = compactText(value).match(/(\d+(?:[.,]\d+)?\s*[KMB]?)/i);
  return match?.[1]?.replace(/\s+/g, '') || '';
}

function metricNumber(value) {
  const compact = numericText(value).toUpperCase().replace(',', '.');
  const match = compact.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) return null;
  const multiplier = match[2] === 'K'
    ? 1_000
    : match[2] === 'M'
      ? 1_000_000
      : match[2] === 'B'
        ? 1_000_000_000
        : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function scrapeRenderedTikTokItems() {
  const items = [];
  const seen = new Set();
  const anchors = document.querySelectorAll([
    'a[href*="/video/"]',
    'a[href*="/view/product/"]',
    'a[href*="/product/"]',
    'a[href*="product_id="]'
  ].join(','));

  for (const anchor of anchors) {
    const parsed = parseTikTokUrl(anchor.href);
    if (!parsed || seen.has(parsed.itemId)) continue;
    if (isProductSearchPage() && parsed.sourceType !== 'product') continue;
    if (!isProductSearchPage() && parsed.sourceType !== 'video') continue;

    const card = (
      anchor.closest(
        '[data-e2e="search_top-item"], [data-e2e="search-card"], ' +
        '[data-e2e*="product-card"], article, li'
      ) ||
      anchor.parentElement?.parentElement ||
      anchor
    );
    const text = compactText(card.innerText || anchor.innerText);
    const image = card.querySelector('img') || anchor.querySelector('img');
    let title = compactText(
      card.querySelector(
        '[data-e2e="search-card-video-caption"], [data-e2e*="product-title"], ' +
        '[data-e2e*="product-name"], h1, h2, h3'
      )?.textContent
    );
    if (!title) {
      title = compactText(image?.alt || anchor.getAttribute('aria-label'));
    }
    if (!title && parsed.sourceType === 'video') {
      title = text.slice(0, 1000);
    }
    if (!title || title.length < 2) continue;

    const authorElement = card.querySelector(
      '[data-e2e="search-card-user-unique-id"], [data-e2e*="creator"], ' +
      '[data-e2e*="shop-name"], [class*="author"], [class*="shop-name"]'
    );
    const priceMatch = text.match(
      /(?:₫\s*|đ\s*)(\d[\d.,]*)|(\d[\d.,]*)\s*(?:₫|đ)\b/i
    );
    const viewsMatch = text.match(
      /(\d+(?:[.,]\d+)?\s*[KMB]?)\s*(?:views?|lượt xem)/i
    );
    const soldMatch = text.match(
      /(\d+(?:[.,]\d+)?\s*[KMB]?)\+?\s*(?:sold|đã bán)/i
    );
    const priceValue = priceMatch
      ? Number(String(priceMatch[1] || priceMatch[2]).replace(/[^\d]/g, ''))
      : null;
    const hashtags = [...title.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((match) => match[1]);

    seen.add(parsed.itemId);
    items.push({
      ...parsed,
      title: title.slice(0, 1000),
      description: parsed.sourceType === 'video' ? title.slice(0, 50000) : '',
      author: compactText(authorElement?.textContent).replace(/^@/, ''),
      price: priceMatch ? `${priceMatch[1] || priceMatch[2]}₫` : '',
      priceValue,
      sold: soldMatch ? metricNumber(soldMatch[1]) : 0,
      views: viewsMatch ? metricNumber(viewsMatch[1]) : null,
      url: anchor.href,
      image: image?.currentSrc || image?.src || '',
      hashtags,
      observedAt: new Date().toISOString(),
      detailStatus: 'PARTIAL'
    });
  }

  return items.slice(0, 200);
}

let lastDomSignature = '';
let domAttempts = 0;
let domCaptureTimer = null;

function captureRenderedItems() {
  domAttempts += 1;
  const items = scrapeRenderedTikTokItems();
  const signature = items.map((item) => item.itemId).join(',');
  if (items.length && signature !== lastDomSignature) {
    lastDomSignature = signature;
    chrome.runtime.sendMessage({
      type: 'TIKTOK_DOM_ITEMS',
      items
    }).catch(() => undefined);
  }
}

function startDomCapture() {
  clearInterval(domCaptureTimer);
  domAttempts = 0;
  captureRenderedItems();
  domCaptureTimer = setInterval(() => {
    captureRenderedItems();
    if (domAttempts >= 20) clearInterval(domCaptureTimer);
  }, 2000);
}

async function loadMoreTikTokResults() {
  const startHeight = document.documentElement.scrollHeight;
  for (let step = 0; step < 5; step += 1) {
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'smooth'
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  startDomCapture();
  return {
    startHeight,
    endHeight: document.documentElement.scrollHeight
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'TIKTOK_LOAD_MORE') return;
  void loadMoreTikTokResults()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

function sendHydrationPayloads() {
  const scripts = [
    document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__'),
    document.querySelector('#SIGI_STATE'),
    document.querySelector('script[id*="REHYDRATION"]'),
    document.querySelector('script[id*="SIGI"]')
  ].filter(Boolean);
  const kind = isProductSearchPage() ? 'product-search' : 'video-search';
  for (const script of scripts) {
    try {
      const payload = JSON.parse(script.textContent || '');
      chrome.runtime.sendMessage({
        type: 'TIKTOK_RESPONSE',
        detail: {
          kind,
          url: location.href,
          status: 200,
          payload
        }
      }).catch(() => undefined);
    } catch {
      // TikTok may change or omit its embedded state; DOM capture remains available.
    }
  }
}

function reportBlockedPage() {
  if (
    location.pathname.includes('/login') ||
    location.pathname.includes('/captcha') ||
    location.pathname.includes('/verify')
  ) {
    chrome.runtime.sendMessage({
      type: 'TIKTOK_BLOCKED',
      url: location.href
    }).catch(() => undefined);
  }
}

function findShopTab() {
  const candidates = document.querySelectorAll('a, button, [role="tab"]');
  return [...candidates].find((element) => {
    const label = compactText(
      element.textContent || element.getAttribute('aria-label')
    ).toLowerCase();
    return /^(shop|products?|sản phẩm|cửa hàng|mua sắm)$/.test(label);
  }) || null;
}

async function initializeTikTokCapture() {
  reportBlockedPage();
  let shopTabFound = false;
  if (isProductSearchPage()) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const shopTab = findShopTab();
    shopTabFound = Boolean(shopTab);
    shopTab?.click();
    if (shopTab) await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  chrome.runtime.sendMessage({
    type: 'TIKTOK_PAGE_STATUS',
    mode: isProductSearchPage() ? 'products' : 'videos',
    shopTabFound,
    url: location.href,
    title: document.title
  }).catch(() => undefined);
  startDomCapture();
  setTimeout(sendHydrationPayloads, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeTikTokCapture, { once: true });
} else {
  initializeTikTokCapture();
}
