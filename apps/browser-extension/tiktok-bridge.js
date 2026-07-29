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
  const resultSelector = isProductSearchPage()
    ? 'a[href*="/view/product/"], a[href*="/product/"], a[href*="product_id="]'
    : 'a[href*="/video/"]';
  const scroller = document.scrollingElement || document.documentElement;
  const countResults = () => document.querySelectorAll(resultSelector).length;
  const startHeight = scroller.scrollHeight;
  const startCount = countResults();
  let previousHeight = startHeight;
  let previousCount = startCount;
  let stableRounds = 0;
  let attempts = 0;

  for (let step = 0; step < 10; step += 1) {
    attempts = step + 1;
    const results = document.querySelectorAll(resultSelector);
    results[results.length - 1]?.scrollIntoView({
      block: 'end',
      inline: 'nearest',
      behavior: 'auto'
    });
    scroller.scrollTop = scroller.scrollHeight;
    window.scrollTo(0, scroller.scrollHeight);
    captureRenderedItems();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const currentHeight = scroller.scrollHeight;
    const currentCount = countResults();
    const grew = currentHeight > previousHeight || currentCount > previousCount;
    stableRounds = grew ? 0 : stableRounds + 1;
    previousHeight = currentHeight;
    previousCount = currentCount;

    if (currentCount > startCount && stableRounds >= 2) break;

    if (stableRounds >= 2) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - 900);
      window.scrollTo(0, Math.max(0, scroller.scrollHeight - 900));
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  captureRenderedItems();
  startDomCapture();
  return {
    startHeight,
    endHeight: scroller.scrollHeight,
    startCount,
    endCount: countResults(),
    attempts,
    scrollTop: scroller.scrollTop
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'TIKTOK_LOAD_MORE') {
    void loadMoreTikTokResults()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === 'REQUEST_TIKTOK_REVIEWS') {
    void collectRenderedTikTokReviews(Number(message.limit || 20))
      .then((reviews) => sendResponse({ ok: true, count: reviews.length }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});

function scrapeTikTokReviews() {
  const candidates = document.querySelectorAll([
    '[data-e2e="comment-level-1"]',
    '[data-e2e="comment-item"]',
    '[class*="DivCommentItemContainer"]',
    '[class*="CommentItem"]',
    '[class*="ReviewItem"]',
    '[data-e2e*="review-item"]'
  ].join(','));
  const reviews = [];
  const seen = new Set();
  for (const [index, element] of [...candidates].entries()) {
    const fullText = compactText(element.innerText || element.textContent);
    if (!fullText || fullText.length < 2) continue;
    const authorElement = element.querySelector(
      'a[href^="/@"], [data-e2e*="comment-username"], [class*="Author"], [class*="Username"]'
    );
    const commentElement = element.querySelector(
      '[data-e2e="comment-text"], [data-e2e*="review-content"], ' +
      '[class*="CommentText"], [class*="ReviewContent"], p'
    );
    const author = compactText(authorElement?.textContent).replace(/^@/, '');
    const comment = compactText(commentElement?.textContent || fullText);
    if (!comment) continue;
    const reviewId = String(
      element.getAttribute('data-comment-id') ||
      element.getAttribute('data-review-id') ||
      element.id ||
      `${author}:${comment.slice(0, 120)}:${index}`
    );
    if (seen.has(reviewId)) continue;
    seen.add(reviewId);
    const ratingMatch = fullText.match(/([1-5](?:[.,]\d)?)\s*(?:\/\s*5|stars?|sao)/i);
    const images = [...element.querySelectorAll('img')]
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean)
      .filter((url, imageIndex, all) => all.indexOf(url) === imageIndex)
      .slice(0, 20);
    reviews.push({
      reviewId,
      author,
      rating: ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null,
      comment,
      createdAt: '',
      likes: null,
      images,
      videos: [],
      variation: '',
      shopReply: ''
    });
  }
  return reviews;
}

async function collectRenderedTikTokReviews(limit) {
  const maxReviews = Math.min(100, Math.max(0, Math.floor(limit || 20)));
  document.querySelector(
    '[data-e2e="comment-icon"], [data-e2e*="review-tab"], [class*="CommentIcon"]'
  )?.click();

  const accumulated = new Map();
  let noGrowthRounds = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = accumulated.size;
    for (const review of scrapeTikTokReviews()) {
      accumulated.set(review.reviewId, review);
      if (accumulated.size >= maxReviews) break;
    }
    noGrowthRounds = accumulated.size > before ? 0 : noGrowthRounds + 1;
    if (accumulated.size >= maxReviews) break;
    const container = document.querySelector(
      '[data-e2e="comment-list"], [class*="DivCommentListContainer"], ' +
      '[class*="CommentList"], [class*="ReviewList"]'
    );
    if (container) {
      container.scrollTop = container.scrollHeight;
      container.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'auto' });
    } else {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
    if (noGrowthRounds >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 1400));
  }
  const reviews = [...accumulated.values()].slice(0, maxReviews);
  if (reviews.length) {
    chrome.runtime.sendMessage({
      type: 'TIKTOK_DOM_REVIEWS',
      reviews
    }).catch(() => undefined);
  }
  return reviews;
}

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
  const parsedPage = parseTikTokUrl(location.href);
  let shopTabFound = false;
  if (!parsedPage && isProductSearchPage()) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const shopTab = findShopTab();
    shopTabFound = Boolean(shopTab);
    shopTab?.click();
    if (shopTab) await new Promise((resolve) => setTimeout(resolve, 800));
  }
  chrome.runtime.sendMessage({
    type: 'TIKTOK_PAGE_STATUS',
    mode: isProductSearchPage() ? 'products' : 'videos',
    pageType: parsedPage?.sourceType || 'search',
    itemId: parsedPage?.itemId || '',
    shopTabFound,
    url: location.href,
    title: document.title
  }).catch(() => undefined);
  startDomCapture();
  setTimeout(sendHydrationPayloads, 800);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeTikTokCapture, { once: true });
} else {
  initializeTikTokCapture();
}
