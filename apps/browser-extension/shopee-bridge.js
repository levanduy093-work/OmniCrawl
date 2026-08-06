window.addEventListener('omnicrawl:shopee-response', (event) => {
  const detail = event.detail;
  chrome.runtime.sendMessage({
    type: 'SHOPEE_RESPONSE',
    detail
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'REQUEST_SHOPEE_SEARCH_RESCAN') {
    void rescanRenderedShopeeProducts(Number(message.round || 0))
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({
        ok: false,
        error: error?.message || String(error)
      }));
    return true;
  }
  if (message.type === 'REQUEST_SHOPEE_DETAIL_RECHECK') {
    const detail = scrapeRenderedProductDetail();
    if (detail) {
      chrome.runtime.sendMessage({
        type: 'SHOPEE_DOM_DETAIL',
        detail,
        recheck: true
      }).catch(() => undefined);
    }
    sendResponse({ ok: true, detail });
    return;
  }
  if (message.type === 'REQUEST_SHOPEE_FETCH_PAGE') {
    window.dispatchEvent(new CustomEvent('omnicrawl:execute-shopee-search', {
      detail: {
        page: message.page,
        keyword: message.keyword,
        sortBy: message.sortBy,
        order: message.order
      }
    }));
    sendResponse({ ok: true });
    
    // Simulate DOM re-scan completion quickly for virtual pages
    // since we are bypassing the DOM.
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'SHOPEE_DOM_ITEMS',
        items: [] // Empty DOM items, allowing API data to be the primary source
      }).catch(() => undefined);
    }, 500);

    return true;
  }
  return undefined;
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
      .map((url) => url.replace(/_tn(?=\.\w+$|$|[?#])/i, ''))
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

function isEnabledPaginationControl(control) {
  return Boolean(
    control &&
    !control.disabled &&
    control.getAttribute('aria-disabled') !== 'true' &&
    !control.classList.contains('shopee-icon-button--disabled') &&
    !control.className.includes('disabled')
  );
}

function findShopeeNextReviewButton() {
  const pageControllers = document.querySelectorAll(
    '.shopee-page-controller, [class*="page-controller"], [class*="pagination"]'
  );
  for (const controller of pageControllers) {
    const buttons = [...controller.querySelectorAll('button')];
    if (!buttons.length) continue;

    const numericButtons = buttons.filter((b) => /^\d+$/.test((b.textContent || '').trim()));
    const activeButton = numericButtons.find((button) => (
      button.classList.contains('shopee-button-solid--primary') ||
      button.classList.contains('shopee-button-no-outline--active') ||
      button.className.includes('active') ||
      button.className.includes('primary') ||
      button.getAttribute('aria-current') === 'page'
    ));
    if (activeButton) {
      const currentPage = Number((activeButton.textContent || '').trim());
      const nextPage = numericButtons.find((button) => (
        Number((button.textContent || '').trim()) === currentPage + 1
      ));
      if (isEnabledPaginationControl(nextPage)) return nextPage;
    }

    const nextArrowBtn = controller.querySelector([
      '.shopee-icon-button--right',
      '[class*="icon-button--right"]',
      'button[aria-label*="next" i]',
      'button[aria-label*="tiếp" i]',
      'button[class*="right"]',
      'button[class*="next"]'
    ].join(','));

    if (isEnabledPaginationControl(nextArrowBtn)) {
      return nextArrowBtn;
    }
  }
  return null;
}

function compactReviewCount(value) {
  const normalized = String(value || '').replace(/\s+/g, '').replace(',', '.');
  const match = normalized.match(/(\d+(?:\.\d+)?)(k|nghìn)?/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return Math.round(number * (/k|nghìn/i.test(match[2] || '') ? 1000 : 1));
}

function scrapeRenderedRatingSummary() {
  const surface = renderedReviewSurface();
  const root = surface.overview || surface.heading?.parentElement || document.body;
  const text = (root?.innerText || root?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
  const scoreElement = root?.querySelector([
    '.product-rating-overview__rating-score',
    '[class*="rating-score"]',
    '[class*="rating-average"]'
  ].join(','));
  const scoreText = (scoreElement?.textContent || text).replace(',', '.');
  const ratingMatch = scoreText.match(
    /(\d(?:\.\d+)?)\s*(?:trên\s*5|out\s*of\s*5|\/\s*5)/i
  ) || scoreText.match(/^(\d(?:\.\d+)?)$/);
  const candidates = [...(root?.querySelectorAll('button, [role="button"], span, div') || [])]
    .map((element) => (element.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((entry) => entry && entry.length < 100);
  const allLabel = candidates.find((entry) => /^(?:tất cả|all)\b/i.test(entry));
  const totalMatch = allLabel?.match(
    /(?:tất cả|all)\s*(?:\(|:)?\s*([\d.,]+\s*(?:k|nghìn)?)/i
  ) || text.match(/([\d.,]+\s*(?:k|nghìn)?)\s*(?:đánh giá|ratings?)/i);
  const rating = ratingMatch ? Number(ratingMatch[1]) : null;
  const ratingCount = totalMatch ? compactReviewCount(totalMatch[1]) : null;
  return {
    ...(Number.isFinite(rating) ? { rating } : {}),
    ...(ratingCount !== null ? { ratingCount } : {})
  };
}

function sendShopeeDomReviews(reviews, isFinal, itemId) {
  chrome.runtime.sendMessage({
    type: 'SHOPEE_DOM_REVIEWS',
    reviews,
    isFinal,
    itemId,
    ratingSummary: scrapeRenderedRatingSummary()
  }).catch(() => undefined);
}

function renderedReviewSignature() {
  return scrapeRenderedShopeeReviews()
    .map((review) => review.reviewId)
    .join(',');
}

async function waitForRenderedReviewChange(previousSignature) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const signature = renderedReviewSignature();
    if (signature && signature !== previousSignature) return true;
  }
  return false;
}

function renderedReviewSurface() {
  const reviewCard = document.querySelector([
    '.shopee-product-rating',
    '[class*="product-rating__main"]',
    '[class*="ProductRating"]',
    '[data-sqe*="review-item"]'
  ].join(','));
  const pagination = document.querySelector(
    '.shopee-page-controller, [class*="page-controller"], [class*="pagination"]'
  );
  const overview = document.querySelector([
    '.product-rating-overview',
    '[class*="product-rating-overview"]',
    '[class*="ProductRatingOverview"]',
    '[class*="product-ratings"]'
  ].join(','));
  const heading = [...document.querySelectorAll('h2, h3, div, span')]
    .find((element) => (
      element.children.length < 8 &&
      /(?:đánh giá sản phẩm|product ratings?|customer reviews?)/i.test(
        (element.textContent || '').replace(/\s+/g, ' ').trim()
      )
    ));
  return { reviewCard, pagination, overview, heading };
}

function waitForReviewSurfaceMutation(waitMs = 1000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      const surface = renderedReviewSurface();
      if (surface.reviewCard || surface.pagination) finish();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(finish, waitMs);
  });
}

async function waitForRenderedReviewSurface(expectedItemId = '') {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentIds = parseProductIds(location.href);
    if (
      expectedItemId &&
      currentIds?.itemId &&
      String(currentIds.itemId) !== String(expectedItemId)
    ) return false;

    const surface = renderedReviewSurface();
    if (surface.reviewCard || surface.pagination) return true;
    const target = surface.overview || surface.heading;
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
      const allFilter = [...document.querySelectorAll('button, [role="button"]')]
        .find((element) => /^(?:tất cả|all)\b/i.test(
          (element.textContent || '').replace(/\s+/g, ' ').trim()
        ));
      if (isEnabledPaginationControl(allFilter)) allFilter.click();
    } else {
      const pageHeight = Math.max(document.body.scrollHeight, 4000);
      const targetY = Math.min(
        pageHeight - window.innerHeight,
        1800 + attempt * 700
      );
      window.scrollTo({ top: Math.max(0, targetY), behavior: 'auto' });
    }
    await waitForReviewSurfaceMutation(1000);
  }
  const surface = renderedReviewSurface();
  return Boolean(surface.reviewCard || surface.pagination);
}

async function collectRenderedShopeeReviews(limit, expectedItemId = '') {
  const maxReviews = Math.min(100000, Math.max(0, Math.floor(limit || 20)));

  const surfaceReady = await waitForRenderedReviewSurface(expectedItemId);
  if (!surfaceReady) {
    sendShopeeDomReviews([], true, expectedItemId);
    return [];
  }

  const accumulated = new Map();
  let noGrowthRounds = 0;
  const maximumAttempts = Math.min(2000, Math.max(25, Math.ceil(maxReviews / 6) + 12));
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const before = accumulated.size;
    const freshReviews = [];
    for (const review of scrapeRenderedShopeeReviews()) {
      if (!accumulated.has(review.reviewId)) freshReviews.push(review);
      accumulated.set(review.reviewId, review);
      if (accumulated.size >= maxReviews) break;
    }
    noGrowthRounds = accumulated.size > before ? 0 : noGrowthRounds + 1;

    if (accumulated.size > before && accumulated.size < maxReviews) {
      sendShopeeDomReviews(
        freshReviews,
        false,
        expectedItemId
      );
    }

    if (accumulated.size >= maxReviews) break;

    const reviewCards = document.querySelectorAll(
      '.shopee-product-rating, [class*="ProductRating"]'
    );
    if (reviewCards.length) {
      reviewCards[reviewCards.length - 1]?.scrollIntoView({
        block: 'end',
        behavior: 'smooth'
      });
    }

    let nextButton = findShopeeNextReviewButton();
    if (!nextButton && noGrowthRounds < 3) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await new Promise((resolve) => setTimeout(resolve, 300));
      nextButton = findShopeeNextReviewButton();
    }

    if (nextButton) {
      const previousSignature = renderedReviewSignature();
      nextButton.scrollIntoView({ block: 'center', behavior: 'auto' });
      nextButton.click();
      const changed = await waitForRenderedReviewChange(previousSignature);
      if (!changed) noGrowthRounds += 1;
      continue;
    }
    if (noGrowthRounds >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const reviews = [...accumulated.values()].slice(0, maxReviews);
  sendShopeeDomReviews([], true, expectedItemId);
  return reviews;
}

function parseProductIds(url) {
  const productMatch = url.match(/\/product\/(\d+)\/(\d+)/);
  if (productMatch) return { shopId: productMatch[1], itemId: productMatch[2] };
  const slugMatch = url.match(/-i\.(\d+)\.(\d+)/);
  if (slugMatch) return { shopId: slugMatch[1], itemId: slugMatch[2] };
  return null;
}

function renderedSoldValue(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ');
  const valueAfterLabel = normalized.match(
    /(?:đã bán|sold|lượt mua)\s*:?\s*(\d+(?:[.,]\d+)?\s*(?:k|nghìn|tr|triệu)?)/i
  );
  const valueBeforeLabel = normalized.match(
    /(\d+(?:[.,]\d+)?\s*(?:k|nghìn|tr|triệu)?)\+?\s*(?:đã bán|sold|lượt mua|bán)/i
  );
  return (valueAfterLabel?.[1] || valueBeforeLabel?.[1] || '')
    .replace(/\s+/g, '')
    .trim();
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
        !/(?:₫|\d[\d.,]*\s*đ\b|đã bán|\bsold\b|giảm\s*\d+%|^\d(?:[.,]\d)?$|lượt mua)/i.test(line) &&
        !/^(?:yêu thích|voucher|cheap on shopee|add-on deal)$/i.test(line)
      ))
      .sort((left, right) => right.length - left.length)[0];
    if (!title) continue;

    const sold = renderedSoldValue(text);

    let imageUrl = '';
    const imgTags = anchor.querySelectorAll('img');
    for (const img of imgTags) {
      const srcset = (
        img.getAttribute('srcset') ||
        img.getAttribute('data-srcset') ||
        ''
      ).split(',')[0]?.trim().split(/\s+/)[0] || '';
      const src = (
        img.currentSrc ||
        img.getAttribute('src') ||
        img.getAttribute('data-src') ||
        img.getAttribute('data-lazy-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-cfsrc') ||
        srcset
      );
      if (src && !src.startsWith('data:image')) {
        imageUrl = new URL(src, location.origin).href;
        break;
      }
    }
    if (!imageUrl) {
      for (const el of [anchor, ...anchor.querySelectorAll('[style]')]) {
        const background = (
          el.style?.backgroundImage ||
          getComputedStyle(el).backgroundImage ||
          el.getAttribute('style') ||
          ''
        );
        const match = background.match(/url\(['"]?(.*?)['"]?\)/);
        if (match && match[1] && !match[1].startsWith('data:image')) {
          imageUrl = new URL(match[1], location.origin).href;
          break;
        }
      }
    }
    if (!imageUrl) {
      const source = anchor.querySelector('picture source[srcset], source[data-srcset]');
      const sourceUrl = (
        source?.getAttribute('srcset') ||
        source?.getAttribute('data-srcset') ||
        ''
      ).split(',')[0]?.trim().split(/\s+/)[0];
      if (sourceUrl) imageUrl = new URL(sourceUrl, location.origin).href;
    }
    if (!imageUrl && imgTags.length > 0) {
      imageUrl = imgTags[0].currentSrc || imgTags[0].src || '';
    }

    seen.add(ids.itemId);
    products.push({
      ...ids,
      title,
      price: `${priceMatch[1]}₫`,
      sold: sold || 0,
      url,
      image: imageUrl
    });
  }
  return products.slice(0, 100);
}

let lastDomSignature = '';
let domAttempts = 0;

function renderedProductSignature(items) {
  return items
    .map((item) => `${item.itemId}:${item.image || ''}:${item.sold || ''}`)
    .join(',');
}

function currentShopeeSearchPage() {
  const page = Number(new URLSearchParams(location.search).get('page') || 0);
  return Number.isInteger(page) && page >= 0 ? page : 0;
}

function sendShopeeDomItems(items, page, isFinal = false) {
  chrome.runtime.sendMessage({
    type: 'SHOPEE_DOM_ITEMS',
    items,
    page,
    pageUrl: location.href,
    isFinal
  }).catch(() => undefined);
}

function waitForRenderedScroll(minimumMs = 350, maximumMs = 650) {
  const delay = minimumMs + Math.floor(
    Math.random() * (maximumMs - minimumMs + 1)
  );
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function rescanRenderedShopeeProducts(round = 0) {
  if (!location.pathname.includes('/search')) return 0;
  const height = Math.max(document.body.scrollHeight, 4000);
  const positions = [0.15, 0.35, 0.55, 0.75, 0.95, 0.5];
  const ratio = positions[Math.abs(Math.floor(round)) % positions.length];
  window.scrollTo({
    top: Math.max(0, Math.floor(height * ratio) - Math.floor(innerHeight / 2)),
    behavior: 'smooth'
  });
  await waitForRenderedScroll(450, 750);
  const items = scrapeRenderedProducts();
  const signature = renderedProductSignature(items);
  if (items.length && signature !== lastDomSignature) {
    lastDomSignature = signature;
    sendShopeeDomItems(items, currentShopeeSearchPage());
  }
  return items.length;
}

async function autoScrollShopeeSearchPage() {
  if (!location.pathname.includes('/search')) return;
  const page = currentShopeeSearchPage();
  const minimumStableItems = 20;
  let stableRounds = 0;
  let previousSignature = '';
  let currentY = Math.max(0, window.scrollY);

  const waitForProductChange = (signature, waitMs = 1000) => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(() => {
      const current = renderedProductSignature(scrapeRenderedProducts());
      if (current && current !== signature) finish();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(finish, waitMs);
  });

  for (let i = 0; i < 25; i += 1) {
    const totalHeight = Math.max(document.body.scrollHeight, 4000);
    const maximumY = Math.max(0, totalHeight - window.innerHeight);
    const step = Math.max(
      320,
      Math.floor(window.innerHeight * (0.55 + Math.random() * 0.25))
    );
    currentY = Math.min(maximumY, currentY + step);
    window.scrollTo({ top: currentY, behavior: 'smooth' });
    await waitForRenderedScroll();
    await waitForProductChange(previousSignature, 800);

    const items = scrapeRenderedProducts();
    const signature = renderedProductSignature(items);
    stableRounds = signature && signature === previousSignature
      ? stableRounds + 1
      : 0;
    previousSignature = signature;
    if (items.length && signature !== lastDomSignature) {
      lastDomSignature = signature;
      sendShopeeDomItems(items, page);
    }
    const reachedDeepScroll = maximumY === 0 || currentY >= maximumY * 0.85;
    if (
      reachedDeepScroll &&
      items.length >= minimumStableItems &&
      stableRounds >= 2
    ) break;
    if (
      reachedDeepScroll &&
      items.length < minimumStableItems &&
      stableRounds >= 5
    ) break;
  }
  sendShopeeDomItems([], page, true);
}

if (location.pathname.includes('/search')) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void autoScrollShopeeSearchPage();
    }, { once: true });
  } else {
    void autoScrollShopeeSearchPage();
  }
}

const domCaptureTimer = setInterval(() => {
  domAttempts += 1;
  const items = scrapeRenderedProducts();
  const signature = renderedProductSignature(items);
  if (items.length && signature !== lastDomSignature) {
    lastDomSignature = signature;
    sendShopeeDomItems(items, currentShopeeSearchPage());
  }
  if (domAttempts >= 15) clearInterval(domCaptureTimer);
}, 1500);

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
  const ratingMatch = bodyText.slice(0, 12000).match(/([1-5](?:[.,]\d)?)\s*(?:\/\s*5|stars?|sao)/i);
  const headerText = bodyText.slice(0, 12000);
  const ratingCountMatch = (
    headerText.match(/(\d+(?:[.,]\d+)?\s*(?:k|nghìn)?)\s*(?:ratings?|đánh giá|lượt đánh giá)/i) ||
    headerText.match(/(?:ratings?|đánh giá|lượt đánh giá)\s*[:(]?\s*(\d+(?:[.,]\d+)?\s*(?:k|nghìn)?)/i)
  );
  const ratingCount = ratingCountMatch
    ? compactReviewCount(ratingCountMatch[1])
    : null;
  const sold = renderedSoldValue(bodyText.slice(0, 12000));
  const metaImage = document.querySelector('meta[property="og:image"]')?.content ||
                    document.querySelector('meta[name="twitter:image"]')?.content;

  const galleryNodeUrls = (root) => [
    ...root.querySelectorAll(
      'img, source[srcset], source[data-srcset], [style*="background-image"]'
    )
  ].filter((element) => {
    const productAnchor = element.closest('a[href]');
    if (!productAnchor) return true;
    const linkedProduct = parseProductIds(productAnchor.href);
    return !linkedProduct || String(linkedProduct.itemId) === String(ids.itemId);
  }).flatMap((element) => {
    if (element.tagName.toLowerCase() === 'img') {
      const image = element;
      const source = (
        image.currentSrc ||
        image.getAttribute('src') ||
        image.getAttribute('data-src') ||
        image.getAttribute('data-lazy-src') ||
        ''
      );
      const srcset = (
        image.getAttribute('srcset') ||
        image.getAttribute('data-srcset') ||
        ''
      ).split(',').map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean);
      return [source, ...srcset];
    }
    if (element.tagName.toLowerCase() === 'source') {
      return (
        element.getAttribute('srcset') ||
        element.getAttribute('data-srcset') ||
        ''
      ).split(',').map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean);
    }
    const background = (
      element.style?.backgroundImage ||
      element.getAttribute('style') ||
      ''
    );
    const match = background.match(/url\(['"]?(.*?)['"]?\)/);
    return match?.[1] ? [match[1]] : [];
  });

  const titleNode = document.querySelector('h1');
  let galleryRoot = null;
  let ancestor = titleNode?.parentElement || null;
  for (let depth = 0; ancestor && depth < 10; depth += 1) {
    const urls = galleryNodeUrls(ancestor).filter(Boolean);
    if (urls.length >= 2) {
      galleryRoot = ancestor;
      break;
    }
    if (ancestor === document.body || ancestor.tagName === 'MAIN') break;
    ancestor = ancestor.parentElement;
  }

  const galleryUrls = galleryRoot ? galleryNodeUrls(galleryRoot) : [];
  const images = [metaImage, ...galleryUrls]
    .filter((url) => url && /(?:shopee|susercontent)\.(?:com|vn)|susercontent\.com\/file\//i.test(url))
    .filter((url) => !/(?:badge|icon|avatar|logo)/i.test(url))
    .map((url) => url.replace(/_tn(?=\.\w+$|$|[?#])/i, ''))
    .filter((url, index, all) => url && all.indexOf(url) === index)
    .slice(0, 30);

  if (!title || (!description && !images.length)) return null;
  return {
    ...ids,
    title,
    description,
    rating: ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null,
    ratingCount,
    sold: sold || null,
    images,
    _galleryComplete: false
  };
}

if (parseProductIds(location.href)) {
  let lastDetailSignature = '';
  let detailStableRounds = 0;
  let detailObserver = null;
  const captureDetailWhenReady = () => {
    const detail = scrapeRenderedProductDetail();
    if (!detail) return false;
    const signature = JSON.stringify([
      detail.itemId,
      detail.title,
      detail.description?.length || 0,
      detail.images?.length || 0,
      detail.rating
    ]);
    if (signature === lastDetailSignature) {
      detailStableRounds += 1;
    } else {
      lastDetailSignature = signature;
      detailStableRounds = 0;
      chrome.runtime.sendMessage({
        type: 'SHOPEE_DOM_DETAIL',
        detail
      }).catch(() => undefined);
    }
    return detailStableRounds >= 1;
  };
  const startDetailObserver = () => {
    if (captureDetailWhenReady()) return;
    detailObserver = new MutationObserver(() => {
      if (!captureDetailWhenReady()) return;
      detailObserver?.disconnect();
    });
    detailObserver.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      detailObserver?.disconnect();
      captureDetailWhenReady();
    }, 10000);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDetailObserver, { once: true });
  } else {
    startDetailObserver();
  }
}

function reportBlockedPage() {
  if (
    location.pathname.includes('/verify/') ||
    location.pathname.includes('/buyer/login')
  ) {
    // `/verify/traffic/error` can be a traffic-control page or a normal
    // "Login Required" page.  Tell the worker which user-facing recovery is
    // appropriate; it must never attempt to work around either one.
    const pageText = String(document.body?.innerText || '').slice(0, 4000);
    const blockedKind = /login required|log\s*in\s*to\s*continue|not logged in|đăng nhập/i.test(pageText)
      ? 'LOGIN_REQUIRED'
      : 'TRAFFIC_CONTROL';
    chrome.runtime.sendMessage({
      type: 'SHOPEE_BLOCKED',
      url: location.href,
      blockedKind
    }).catch(() => undefined);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', reportBlockedPage, { once: true });
} else {
  reportBlockedPage();
}

async function simulateHumanInteraction() {
  if (
    location.pathname.includes('/verify/') ||
    location.pathname.includes('/buyer/login')
  ) {
    return;
  }
  const steps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < steps; i++) {
    const yOffset = (Math.random() - 0.5) * 600;
    window.scrollBy({ top: yOffset, behavior: 'smooth' });
    const event = new MouseEvent('mousemove', {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: Math.floor(Math.random() * window.innerWidth),
      clientY: Math.floor(Math.random() * window.innerHeight)
    });
    document.dispatchEvent(event);
    await new Promise(r => setTimeout(r, 400 + Math.random() * 800));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', simulateHumanInteraction, { once: true });
} else {
  simulateHumanInteraction();
}
