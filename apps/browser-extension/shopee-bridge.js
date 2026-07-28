window.addEventListener('omnicrawl:shopee-response', (event) => {
  chrome.runtime.sendMessage({
    type: 'SHOPEE_RESPONSE',
    detail: event.detail
  }).catch(() => undefined);
});

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
