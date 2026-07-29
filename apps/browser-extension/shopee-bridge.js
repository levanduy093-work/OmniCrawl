window.addEventListener('omnicrawl:shopee-response', (event) => {
  chrome.runtime.sendMessage({
    type: 'SHOPEE_RESPONSE',
    detail: event.detail
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'REQUEST_SHOPEE_REVIEWS') return;
  window.dispatchEvent(new CustomEvent('omnicrawl:request-reviews', {
    detail: {
      itemId: String(message.itemId || ''),
      shopId: String(message.shopId || ''),
      limit: Number(message.limit || 0)
    }
  }));
  void collectRenderedShopeeReviews(Number(message.limit || 20))
    .then((reviews) => sendResponse({ ok: true, renderedCount: reviews.length }))
    .catch((error) => sendResponse({
      ok: false,
      error: error?.message || String(error)
    }));
  return true;
});

function scrapeRenderedShopeeReviews() {
  const candidates = document.querySelectorAll([
    '.shopee-product-rating',
    '[class*="product-rating__main"]',
    '[class*="ProductRating"]',
    '[data-sqe*="review-item"]'
  ].join(','));
  const reviews = [];
  const seen = new Set();
  for (const [index, element] of [...candidates].entries()) {
    const fullText = (element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!fullText || fullText.length < 2) continue;
    const authorElement = element.querySelector(
      'a[href*="/shop/"], a[href*="/user/"], [class*="author"], [class*="username"]'
    );
    const commentElement = element.querySelector(
      '[class*="comment"], [class*="content"], [class*="review"]'
    );
    const author = (authorElement?.textContent || '').replace(/\s+/g, ' ').trim();
    const comment = (commentElement?.textContent || fullText).replace(/\s+/g, ' ').trim();
    if (!comment) continue;
    const reviewId = String(
      element.getAttribute('data-review-id') ||
      element.getAttribute('data-comment-id') ||
      element.id ||
      `${author}:${comment.slice(0, 120)}:${index}`
    );
    if (seen.has(reviewId)) continue;
    seen.add(reviewId);
    const ratingMatch = fullText.match(/([1-5](?:[.,]\d)?)\s*(?:\/\s*5|stars?|sao)/i);
    const filledStars = element.querySelectorAll(
      'svg[fill="#ee4d2d"], svg[fill*="ee4d2d"], [class*="star--active"]'
    ).length;
    const images = [...element.querySelectorAll('img')]
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean)
      .filter((url, imageIndex, all) => all.indexOf(url) === imageIndex)
      .slice(0, 20);
    reviews.push({
      reviewId,
      author,
      rating: ratingMatch
        ? Number(ratingMatch[1].replace(',', '.'))
        : (filledStars || null),
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

async function collectRenderedShopeeReviews(limit) {
  const maxReviews = Math.min(100, Math.max(0, Math.floor(limit || 20)));
  const reviewHeading = [...document.querySelectorAll('h2, h3, div, span')]
    .find((element) => (
      element.children.length < 5 &&
      /^(đánh giá sản phẩm|product ratings?|reviews?)$/i.test(
        (element.textContent || '').replace(/\s+/g, ' ').trim()
      )
  ));
  reviewHeading?.scrollIntoView({ block: 'start', behavior: 'auto' });
  await new Promise((resolve) => setTimeout(resolve, 1400));

  const accumulated = new Map();
  let noGrowthRounds = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const before = accumulated.size;
    for (const review of scrapeRenderedShopeeReviews()) {
      accumulated.set(review.reviewId, review);
      if (accumulated.size >= maxReviews) break;
    }
    noGrowthRounds = accumulated.size > before ? 0 : noGrowthRounds + 1;
    if (accumulated.size >= maxReviews) break;

    const reviewCards = document.querySelectorAll(
      '.shopee-product-rating, [class*="ProductRating"]'
    );
    reviewCards[reviewCards.length - 1]?.scrollIntoView({
      block: 'end',
      behavior: 'auto'
    });
    const nextButton = document.querySelector([
      '.shopee-page-controller .shopee-icon-button--right',
      '.shopee-product-rating__page-controller .shopee-icon-button--right',
      'button[aria-label*="next" i]',
      'button[aria-label*="tiếp" i]',
      '[class*="Review"] button[class*="right"]'
    ].join(','));
    const disabled = (
      !nextButton ||
      nextButton.disabled ||
      nextButton.getAttribute('aria-disabled') === 'true' ||
      nextButton.classList.contains('shopee-icon-button--disabled')
    );
    if (!disabled) {
      nextButton.click();
      await new Promise((resolve) => setTimeout(resolve, 1700));
      continue;
    }
    if (noGrowthRounds >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  const reviews = [...accumulated.values()].slice(0, maxReviews);
  if (reviews.length) {
    chrome.runtime.sendMessage({
      type: 'SHOPEE_DOM_REVIEWS',
      reviews
    }).catch(() => undefined);
  }
  return reviews;
}

function parseProductIds(url) {
  const productMatch = url.match(/\/product\/(\d+)\/(\d+)/);
  if (productMatch) return { shopId: productMatch[1], itemId: productMatch[2] };
  const slugMatch = url.match(/-i\.(\d+)\.(\d+)/);
  if (slugMatch) return { shopId: slugMatch[1], itemId: slugMatch[2] };
  return null;
}

function scrapeRenderedProducts() {
  const products = [];
  const seen = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    const url = anchor.href;
    const ids = parseProductIds(url);
    if (!ids || seen.has(ids.itemId)) continue;

    const text = anchor.innerText || '';
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const priceMatch = text.match(/(?:₫\s*)?(\d{1,3}(?:[.,]\d{3})+|\d+)(?:\s*₫|\s*đ)/i);
    if (!priceMatch) continue;

    const nameNode = anchor.querySelector('[data-sqe="name"]');
    const title = nameNode?.textContent?.trim() || lines
      .filter((line) => (
        line.length > 5 &&
        !/(?:₫|\d[\d.,]*\s*đ\b|đã bán|\bsold\b|giảm\s*\d+%|^\d(?:[.,]\d)?$)/i.test(line) &&
        !/^(?:yêu thích|voucher|cheap on shopee|add-on deal)$/i.test(line)
      ))
      .sort((left, right) => right.length - left.length)[0];
    if (!title) continue;

    const soldMatch = text.match(/(\d+(?:[.,]\d+)?k?)\+?\s*(?:đã bán|sold)/i);
    const image = anchor.querySelector('img');
    seen.add(ids.itemId);
    products.push({
      ...ids,
      title,
      price: `${priceMatch[1]}₫`,
      sold: soldMatch?.[1] || 0,
      url,
      image: image?.currentSrc || image?.src || ''
    });
  }
  return products.slice(0, 100);
}

let lastDomSignature = '';
let domAttempts = 0;
const domCaptureTimer = setInterval(() => {
  domAttempts += 1;
  const items = scrapeRenderedProducts();
  const signature = items.map((item) => item.itemId).join(',');
  if (items.length && signature !== lastDomSignature) {
    lastDomSignature = signature;
    chrome.runtime.sendMessage({
      type: 'SHOPEE_DOM_ITEMS',
      items
    }).catch(() => undefined);
  }
  if (domAttempts >= 15) clearInterval(domCaptureTimer);
}, 2000);

function scrapeRenderedProductDetail() {
  const ids = parseProductIds(location.href);
  if (!ids) return null;

  const title = document.querySelector('h1')?.textContent?.trim() || '';
  const bodyText = document.body?.innerText || '';
  const descriptionHeading = [...document.querySelectorAll('div, section')]
    .find((element) => (
      element.children.length < 12 &&
      /^(mô tả sản phẩm|product description)$/i.test(element.firstElementChild?.textContent?.trim() || '')
    ));
  const description = descriptionHeading?.innerText
    ?.replace(/^(mô tả sản phẩm|product description)\s*/i, '')
    .trim()
    .slice(0, 50000) || '';
  const ratingMatch = bodyText.slice(0, 12000).match(/(\d(?:[.,]\d)?)\s*(?:\/\s*5|đánh giá|rating)/i);
  const soldMatch = bodyText.slice(0, 12000).match(/(\d+(?:[.,]\d+)?k?)\+?\s*(?:đã bán|sold)/i);
  const images = [...document.querySelectorAll('img')]
    .map((image) => image.currentSrc || image.src)
    .filter((url) => /(?:shopee|susercontent)\.(?:com|vn)|susercontent\.com/i.test(url))
    .filter((url, index, all) => url && all.indexOf(url) === index)
    .slice(0, 30);

  if (!title || (!description && !images.length)) return null;
  return {
    ...ids,
    title,
    description,
    rating: ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null,
    sold: soldMatch?.[1] || 0,
    images
  };
}

if (parseProductIds(location.href)) {
  setTimeout(() => {
    const detail = scrapeRenderedProductDetail();
    if (!detail) return;
    chrome.runtime.sendMessage({
      type: 'SHOPEE_DOM_DETAIL',
      detail
    }).catch(() => undefined);
  }, 8000);
}

function reportBlockedPage() {
  if (
    location.pathname.includes('/verify/') ||
    location.pathname.includes('/buyer/login')
  ) {
    chrome.runtime.sendMessage({
      type: 'SHOPEE_BLOCKED',
      url: location.href
    }).catch(() => undefined);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', reportBlockedPage, { once: true });
} else {
  reportBlockedPage();
}
