let config = null;
let activeJob = null;
let pollTimer = null;
let pageTimer = null;

const SEARCH_TIMEOUT_MS = 30000;
const DETAIL_TIMEOUT_MS = 90000;

const stateReady = chrome.storage.session.get(['config', 'activeJob']).then((stored) => {
  config = stored.config || null;
  activeJob = stored.activeJob || null;
  if (activeJob) {
    activeJob.phase = activeJob.phase || 'SEARCH';
    activeJob.products = Array.isArray(activeJob.products) ? activeJob.products : [];
    activeJob.detailIndex = Number(activeJob.detailIndex || 0);
    activeJob.detailCompleted = Number(activeJob.detailCompleted || 0);
    activeJob.detailFailed = Number(activeJob.detailFailed || 0);
    const restoredMaxReviews = Number(activeJob.maxReviewsPerProduct ?? 20);
    activeJob.maxReviewsPerProduct = Number.isFinite(restoredMaxReviews)
      ? Math.min(100, Math.max(0, Math.floor(restoredMaxReviews)))
      : 20;
    activeJob.pendingDetailData = activeJob.pendingDetailData || null;
  }
});

function persistActiveJob() {
  return chrome.storage.session.set({ activeJob });
}

function clearPageTimeout() {
  clearTimeout(pageTimer);
  if (activeJob) activeJob.pageDeadline = null;
}

function armPageTimeout(timeoutMs) {
  clearTimeout(pageTimer);
  if (!activeJob) return;
  activeJob.pageDeadline = Date.now() + timeoutMs;
  void persistActiveJob();
  pageTimer = setTimeout(() => {
    void handlePageTimeout();
  }, timeoutMs);
}

async function handlePageTimeout() {
  if (!activeJob || !activeJob.pageDeadline || Date.now() < activeJob.pageDeadline) return;
  if (activeJob.phase === 'DETAIL' && activeJob.currentProduct) {
    if (activeJob.pendingDetailData) {
      await completeCurrentDetail({
        ...activeJob.pendingDetailData,
        reviewsCollected: 0,
        reviews: [],
        reviewsStatus: 'FAILED',
        reviewsError: 'Không nhận được dữ liệu đánh giá từ Shopee sau 90 giây.'
      });
      return;
    }
    await failCurrentDetail('Không nhận được dữ liệu chi tiết từ Shopee sau 90 giây.');
    return;
  }
  await finishJob(false, 'Không nhận được dữ liệu tìm kiếm từ Shopee sau 30 giây.');
}

function authHeaders(json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'Authorization': `Bearer ${config.token}`
  };
}

async function api(path, options = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    ...options,
    headers: {
      ...authHeaders(Boolean(options.body)),
      ...(options.headers || {})
    }
  });
  if (!response.ok && response.status !== 204) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `OmniCrawl API returned ${response.status}`);
  }
  return response;
}

function searchUrl(keyword, page) {
  return `https://shopee.vn/search?keyword=${encodeURIComponent(keyword)}&page=${page}`;
}

function findItemObject(entry) {
  const candidates = [
    entry?.item_basic,
    entry?.item,
    entry?.item_card?.item_basic,
    entry?.item_card?.item,
    entry?.item_card,
    entry?.data?.item_basic,
    entry?.data?.item,
    entry
  ];
  return candidates.find((candidate) => (
    candidate &&
    typeof candidate === 'object' &&
    (
      candidate.itemid ||
      candidate.item_id ||
      candidate.name ||
      candidate.title ||
      candidate.item_name
    )
  )) || {};
}

function extractNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + (extractNumber(entry) || 0), 0);
  }
  if (typeof value === 'object') {
    for (const candidate of Object.values(value)) {
      const numeric = extractNumber(candidate);
      if (numeric !== null) return numeric;
    }
    return null;
  }
  const numeric = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function extractPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return extractNumber(value);
  if (typeof value !== 'object') return null;
  const candidates = [
    value.current_price,
    value.price,
    value.value,
    value.single_value,
    value.min_price,
    value.price_min,
    value.range_min
  ];
  for (const candidate of candidates) {
    const numeric = extractPrice(candidate);
    if (numeric !== null) return numeric;
  }
  return null;
}

function imageUrl(value) {
  const image = typeof value === 'object'
    ? value?.image_id || value?.image || value?.url
    : value;
  if (!image) return '';
  const text = String(image);
  if (/^https?:\/\//i.test(text)) return text;
  return `https://down-vn.img.susercontent.com/file/${text}`;
}

function mapItem(entry) {
  const item = findItemObject(entry);
  const rawPrice = extractPrice(
    item?.price_min ??
    item?.price ??
    item?.price_info ??
    item?.item_price ??
    entry?.price_info ??
    entry?.display_price ??
    entry?.item_card_display_price
  );
  const itemId = item?.itemid ?? item?.item_id;
  const shopId = item?.shopid ?? item?.shop_id;
  const imageId = (
    item?.image?.image_id ??
    item?.image ??
    item?.images?.[0]?.image_id ??
    item?.images?.[0]
  );
  return {
    itemId: itemId === undefined || itemId === null ? '' : String(itemId),
    shopId: shopId === undefined || shopId === null ? '' : String(shopId),
    title: String(
      item?.name ||
      item?.title ||
      item?.item_name ||
      entry?.display_name ||
      ''
    ).trim(),
    price: rawPrice !== null
      ? `${Math.round(rawPrice > 100000000 ? rawPrice / 100000 : rawPrice).toLocaleString('vi-VN')}₫`
      : '',
    sold: item?.historical_sold ?? item?.sold ?? item?.sold_count ?? 0,
    url: itemId && shopId ? `https://shopee.vn/product/${shopId}/${itemId}` : '',
    image: imageUrl(imageId)
  };
}

function readableAttributeValue(attribute) {
  const value = (
    attribute?.value ??
    attribute?.display_value ??
    attribute?.values ??
    attribute?.value_list
  );
  if (Array.isArray(value)) {
    return value
      .map((entry) => (
        typeof entry === 'object'
          ? entry?.display_value || entry?.value || entry?.name
          : entry
      ))
      .filter(Boolean)
      .join(', ');
  }
  return value === null || value === undefined ? '' : String(value);
}

function extendedDescription(item) {
  if (typeof item?.description === 'string') return item.description;
  const fields = item?.description_info?.extended_description?.field_list;
  if (!Array.isArray(fields)) return '';
  return fields
    .map((field) => field?.text || field?.value || '')
    .filter(Boolean)
    .join('\n');
}

function mapDetailPayload(payload, expectedProduct) {
  const root = payload?.data ?? payload ?? {};
  const item = root?.item ?? root?.item_basic ?? root?.product ?? root;
  const shop = root?.shop_detailed ?? root?.shop ?? item?.shop_detailed ?? {};
  const categories = item?.categories ?? root?.categories ?? [];
  const attributes = Array.isArray(item?.attributes)
    ? item.attributes.map((attribute) => ({
      name: String(attribute?.name || attribute?.display_name || ''),
      value: readableAttributeValue(attribute)
    })).filter((attribute) => attribute.name || attribute.value)
    : [];
  const brandAttribute = attributes.find((attribute) => /brand|thương hiệu/i.test(attribute.name));
  const rating = item?.item_rating ?? item?.rating ?? {};
  const ratingCount = extractNumber(
    rating?.rating_count ??
    rating?.count ??
    item?.rating_count ??
    item?.cmt_count
  );
  const images = [
    ...(Array.isArray(item?.images) ? item.images : []),
    ...(Array.isArray(root?.images) ? root.images : [])
  ].map(imageUrl).filter(Boolean);
  const variations = Array.isArray(item?.tier_variations)
    ? item.tier_variations.map((variation) => ({
      name: String(variation?.name || ''),
      options: Array.isArray(variation?.options)
        ? variation.options.map((option) => String(option))
        : []
    }))
    : [];
  const models = Array.isArray(item?.models)
    ? item.models.map((model) => ({
      modelId: String(model?.modelid ?? model?.model_id ?? ''),
      name: String(model?.name || ''),
      sku: String(model?.sku || model?.model_sku || ''),
      price: extractPrice(model?.price),
      stock: extractNumber(model?.stock)
    }))
    : [];
  const itemId = String(
    item?.itemid ??
    item?.item_id ??
    expectedProduct?.itemId ??
    ''
  );
  const detail = {
    itemId,
    description: extendedDescription(item),
    category: Array.isArray(categories)
      ? categories
        .map((category) => category?.display_name || category?.name || category)
        .filter(Boolean)
        .join(' > ')
      : String(categories || ''),
    brand: String(item?.brand || item?.brand_name || brandAttribute?.value || ''),
    rating: extractNumber(rating?.rating_star ?? rating?.rating ?? item?.rating_star),
    ratingCount,
    stock: extractNumber(item?.stock ?? root?.stock),
    likedCount: extractNumber(item?.liked_count ?? item?.likedCount),
    shopName: String(shop?.name || shop?.shop_name || item?.shop_name || ''),
    shopLocation: String(
      item?.shop_location ||
      shop?.shop_location ||
      shop?.place ||
      ''
    ),
    images: [...new Set(images)].slice(0, 30),
    attributes,
    variations,
    models,
    detailStatus: 'COMPLETED'
  };
  const usefulFields = [
    detail.description,
    detail.category,
    detail.rating,
    detail.stock,
    detail.images.length,
    detail.attributes.length,
    detail.models.length
  ].filter((value) => value !== '' && value !== null && value !== 0);
  return usefulFields.length ? detail : null;
}

function mapReview(rating) {
  const createdAtValue = Number(rating?.ctime ?? rating?.created_at);
  const createdAt = Number.isFinite(createdAtValue) && createdAtValue > 0
    ? new Date(createdAtValue * (createdAtValue < 10_000_000_000 ? 1000 : 1)).toISOString()
    : '';
  const images = Array.isArray(rating?.images)
    ? rating.images.map(imageUrl).filter(Boolean)
    : [];
  const videos = Array.isArray(rating?.videos)
    ? rating.videos
      .map((video) => video?.url || video?.video_url || video)
      .filter(Boolean)
      .map(String)
    : [];
  const productItem = Array.isArray(rating?.product_items)
    ? rating.product_items[0]
    : rating?.product_item;
  const rawShopReply = rating?.seller_reply || rating?.shop_reply || rating?.reply;
  return {
    reviewId: String(rating?.cmtid ?? rating?.comment_id ?? ''),
    author: String(rating?.author_username || rating?.username || ''),
    authorId: String(rating?.userid ?? rating?.user_id ?? ''),
    rating: extractNumber(rating?.rating_star ?? rating?.rating),
    comment: String(rating?.comment || rating?.content || ''),
    createdAt,
    variation: String(
      productItem?.model_name ||
      rating?.product_variation ||
      rating?.model_name ||
      ''
    ),
    likes: extractNumber(rating?.like_count ?? rating?.likes),
    images,
    videos,
    shopReply: typeof rawShopReply === 'object'
      ? String(rawShopReply?.comment || rawShopReply?.content || rawShopReply?.reply || '')
      : String(rawShopReply || '')
  };
}

function mapReviewsPayload(payload) {
  const rawRatings = payload?.ratings ?? payload?.data?.ratings ?? [];
  return Array.isArray(rawRatings) ? rawRatings.map(mapReview) : [];
}

async function storeItems(items) {
  if (!activeJob || activeJob.phase !== 'SEARCH') return 0;
  const seenSet = new Set(activeJob.seen);
  const freshItems = [];
  for (const original of items) {
    const item = {
      ...original,
      itemId: String(original.itemId || ''),
      shopId: String(original.shopId || ''),
      detailStatus: activeJob.includeDetails ? 'PENDING' : 'SKIPPED'
    };
    const key = String(item.itemId || item.url || item.title);
    if (!item.title || !item.price || seenSet.has(key)) continue;
    seenSet.add(key);
    activeJob.seen.push(key);
    if (activeJob.includeDetails && item.itemId && item.url) {
      activeJob.products.push({
        itemId: item.itemId,
        shopId: item.shopId,
        url: item.url,
        title: item.title
      });
    }
    freshItems.push(item);
    if (activeJob.seen.length >= activeJob.maxItems) break;
  }
  if (!freshItems.length) return 0;
  await persistActiveJob();
  await api(`/api/browser-agent/jobs/${activeJob.runId}/items`, {
    method: 'POST',
    body: JSON.stringify({ items: freshItems })
  });
  return freshItems.length;
}

async function scheduleNextPage() {
  if (!activeJob || activeJob.phase !== 'SEARCH' || activeJob.navigationScheduled) return;
  clearPageTimeout();
  activeJob.navigationScheduled = true;
  activeJob.page += 1;
  const runId = activeJob.runId;
  const nextUrl = searchUrl(activeJob.keyword, activeJob.page);
  const delay = 9000 + Math.floor(Math.random() * 6000);
  await persistActiveJob();
  await logJob(
    `Waiting ${Math.ceil(delay / 1000)} seconds before loading Shopee page ${activeJob.page}.`
  );
  setTimeout(() => {
    if (!activeJob || activeJob.runId !== runId || activeJob.phase !== 'SEARCH') return;
    activeJob.navigationScheduled = false;
    void persistActiveJob();
    armPageTimeout(SEARCH_TIMEOUT_MS);
    chrome.tabs.update(activeJob.tabId, { url: nextUrl }).catch((error) => {
      void finishJob(false, error?.message || 'Không thể mở trang tìm kiếm Shopee.');
    });
  }, delay);
}

async function logJob(message) {
  if (!activeJob) return;
  await api(`/api/browser-agent/jobs/${activeJob.runId}/log`, {
    method: 'POST',
    body: JSON.stringify({ message })
  }).catch(() => undefined);
}

function detailProgress(job = activeJob) {
  return {
    enabled: Boolean(job?.includeDetails),
    completed: Number(job?.detailCompleted || 0),
    failed: Number(job?.detailFailed || 0),
    total: Array.isArray(job?.products) ? job.products.length : 0
  };
}

async function finishJob(success, error) {
  if (!activeJob) return;
  const job = activeJob;
  activeJob = null;
  clearTimeout(pageTimer);
  await persistActiveJob();
  try {
    await api(`/api/browser-agent/jobs/${job.runId}/${success ? 'complete' : 'fail'}`, {
      method: 'POST',
      body: JSON.stringify(success
        ? { count: job.seen.length, details: detailProgress(job) }
        : { error })
    });
  } catch {
    // The dashboard can still stop or delete a run if the local API disappears.
  } finally {
    if (success && job.tabId) chrome.tabs.remove(job.tabId).catch(() => undefined);
    schedulePoll(1000);
  }
}

async function beginDetailPhase() {
  if (!activeJob || activeJob.phase === 'DETAIL') return;
  if (!activeJob.includeDetails || !activeJob.products.length) {
    await finishJob(true);
    return;
  }
  clearPageTimeout();
  activeJob.phase = 'DETAIL';
  activeJob.navigationScheduled = false;
  activeJob.detailIndex = 0;
  activeJob.detailCompleted = 0;
  activeJob.detailFailed = 0;
  activeJob.currentProduct = null;
  activeJob.detailHandledFor = null;
  activeJob.pendingDetailData = null;
  activeJob.reviewRequestedFor = null;
  await persistActiveJob();
  await logJob(`Starting product detail crawl for ${activeJob.products.length} products.`);
  await navigateNextDetail();
}

async function navigateNextDetail() {
  if (!activeJob || activeJob.phase !== 'DETAIL' || activeJob.navigationScheduled) return;
  if (activeJob.detailIndex >= activeJob.products.length) {
    await finishJob(true);
    return;
  }

  clearPageTimeout();
  const product = activeJob.products[activeJob.detailIndex];
  activeJob.currentProduct = product;
  activeJob.detailHandledFor = null;
  activeJob.pendingDetailData = null;
  activeJob.reviewRequestedFor = null;
  activeJob.navigationScheduled = true;
  const runId = activeJob.runId;
  const productIndex = activeJob.detailIndex;
  const delay = 3000 + Math.floor(Math.random() * 3000);
  await persistActiveJob();
  await logJob(
    `Waiting ${Math.ceil(delay / 1000)} seconds before product detail ` +
    `${productIndex + 1}/${activeJob.products.length}.`
  );
  setTimeout(() => {
    if (
      !activeJob ||
      activeJob.runId !== runId ||
      activeJob.phase !== 'DETAIL' ||
      activeJob.detailIndex !== productIndex
    ) return;
    activeJob.navigationScheduled = false;
    void persistActiveJob();
    chrome.tabs.update(activeJob.tabId, { url: product.url }).then(() => {
      armPageTimeout(DETAIL_TIMEOUT_MS);
    }).catch((error) => {
      void failCurrentDetail(error?.message || 'Không thể mở trang sản phẩm.');
    });
  }, delay);
}

async function patchCurrentDetail(detail) {
  if (!activeJob?.currentProduct) return;
  const projected = {
    completed: activeJob.detailCompleted + (detail.detailStatus === 'FAILED' ? 0 : 1),
    failed: activeJob.detailFailed + (detail.detailStatus === 'FAILED' ? 1 : 0),
    total: activeJob.products.length
  };
  await api(
    `/api/browser-agent/jobs/${activeJob.runId}/items/` +
    `${encodeURIComponent(activeJob.currentProduct.itemId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ detail, progress: projected })
    }
  );
  activeJob.detailCompleted = projected.completed;
  activeJob.detailFailed = projected.failed;
  activeJob.detailIndex += 1;
  activeJob.currentProduct = null;
  activeJob.pendingDetailData = null;
  activeJob.reviewRequestedFor = null;
  await persistActiveJob();
  await navigateNextDetail();
}

async function completeCurrentDetail(detail) {
  if (!activeJob?.currentProduct || activeJob.phase !== 'DETAIL') return;
  const key = String(activeJob.currentProduct.itemId);
  if (activeJob.detailHandledFor === key) return;
  activeJob.detailHandledFor = key;
  clearPageTimeout();
  await persistActiveJob();
  await patchCurrentDetail({ ...detail, detailStatus: 'COMPLETED' });
}

async function failCurrentDetail(error) {
  if (!activeJob?.currentProduct || activeJob.phase !== 'DETAIL') return;
  const key = String(activeJob.currentProduct.itemId);
  if (activeJob.detailHandledFor === key) return;
  activeJob.detailHandledFor = key;
  clearPageTimeout();
  await persistActiveJob();
  await patchCurrentDetail({
    detailStatus: 'FAILED',
    detailError: String(error || 'Không lấy được chi tiết sản phẩm.')
  });
}

async function requestReviewsForCurrent(detail) {
  if (!activeJob?.currentProduct || activeJob.phase !== 'DETAIL') return;
  const key = String(activeJob.currentProduct.itemId);
  if (activeJob.reviewRequestedFor === key) return;
  activeJob.pendingDetailData = detail;
  activeJob.reviewRequestedFor = key;
  await persistActiveJob();

  const limit = Math.min(
    100,
    Math.max(0, Math.floor(Number(activeJob.maxReviewsPerProduct ?? 20)))
  );
  if (limit === 0) {
    await completeCurrentDetail({
      ...detail,
      reviewsCollected: 0,
      reviews: [],
      reviewsStatus: 'SKIPPED',
      reviewsError: ''
    });
    return;
  }

  try {
    await chrome.tabs.sendMessage(activeJob.tabId, {
      type: 'REQUEST_SHOPEE_REVIEWS',
      itemId: activeJob.currentProduct.itemId,
      shopId: activeJob.currentProduct.shopId,
      limit
    });
  } catch (error) {
    await completeCurrentDetail({
      ...detail,
      reviewsCollected: 0,
      reviews: [],
      reviewsStatus: 'FAILED',
      reviewsError: error?.message || 'Không thể yêu cầu dữ liệu đánh giá từ tab Shopee.'
    });
  }
}

async function processSearchResponse(detail, sender) {
  if (
    !activeJob ||
    activeJob.phase !== 'SEARCH' ||
    sender.tab?.id !== activeJob.tabId
  ) return;
  const payload = detail?.payload;
  if (
    detail?.status === 401 ||
    detail?.status === 403 ||
    payload?.error === 90309999 ||
    payload?.error_msg === 'Login Required'
  ) {
    await finishJob(false, 'Shopee yêu cầu đăng nhập lại trong Chrome.');
    return;
  }

  const rawItems = payload?.data?.items || payload?.items;
  if (!Array.isArray(rawItems)) {
    activeJob.unexpectedResponses = (activeJob.unexpectedResponses || 0) + 1;
    await persistActiveJob();
    if (activeJob.unexpectedResponses <= 3) {
      const payloadKeys = payload && typeof payload === 'object'
        ? Object.keys(payload).slice(0, 12).join(',')
        : typeof payload;
      await logJob(
        `Ignored search response without items: HTTP ${String(detail?.status)}, ` +
        `error=${String(payload?.error ?? 'none')}, keys=${payloadKeys || 'none'}.`
      );
    }
    return;
  }

  const mappedItems = rawItems.map(mapItem);
  const storedCount = await storeItems(mappedItems);

  if (!rawItems.length && activeJob.seen.length === 0) {
    await logJob('Received an empty initial item list; waiting for the populated search response.');
    return;
  }

  if (!storedCount && activeJob.seen.length === 0) {
    const firstEntry = rawItems[0];
    const entryKeys = firstEntry && typeof firstEntry === 'object'
      ? Object.keys(firstEntry).slice(0, 15).join(',')
      : typeof firstEntry;
    const basicKeys = firstEntry?.item_basic && typeof firstEntry.item_basic === 'object'
      ? Object.keys(firstEntry.item_basic).slice(0, 20).join(',')
      : 'none';
    await logJob(
      `Received ${rawItems.length} entries but mapped 0 products; ` +
      `first entry keys=${entryKeys || 'none'}; item_basic keys=${basicKeys}. ` +
      'Waiting for rendered product cards.'
    );
    return;
  }

  if (activeJob.seen.length >= activeJob.maxItems) {
    await beginDetailPhase();
    return;
  }

  if (!rawItems.length || !storedCount) {
    if (activeJob.seen.length > 0 && !activeJob.navigationScheduled) {
      await logJob('No new API-mapped products; waiting for rendered cards instead of ending early.');
    }
    return;
  }

  await scheduleNextPage();
}

async function processDetailResponse(detail, sender) {
  if (
    !activeJob ||
    activeJob.phase !== 'DETAIL' ||
    sender.tab?.id !== activeJob.tabId ||
    detail?.kind !== 'detail'
  ) return;
  const payload = detail?.payload;
  if (
    detail?.status === 401 ||
    detail?.status === 403 ||
    payload?.error === 90309999 ||
    payload?.error_msg === 'Login Required'
  ) {
    await finishJob(false, 'Shopee yêu cầu đăng nhập lại trong Chrome.');
    return;
  }
  if (detail?.status >= 400 || (payload?.error && payload.error !== 0)) {
    await failCurrentDetail(
      `Shopee detail API returned ${String(payload?.error || detail?.status)}.`
    );
    return;
  }
  const mapped = mapDetailPayload(payload, activeJob.currentProduct);
  if (!mapped) return;
  if (
    mapped.itemId &&
    String(mapped.itemId) !== String(activeJob.currentProduct?.itemId || '')
  ) return;
  await requestReviewsForCurrent(mapped);
}

async function processReviewsResponse(detail, sender) {
  if (
    !activeJob ||
    activeJob.phase !== 'DETAIL' ||
    sender.tab?.id !== activeJob.tabId ||
    detail?.kind !== 'reviews' ||
    !activeJob.pendingDetailData
  ) return;
  const reviews = mapReviewsPayload(detail?.payload);
  const error = String(detail?.payload?.error || '');
  const reviewsStatus = error
    ? (reviews.length ? 'PARTIAL' : 'FAILED')
    : 'COMPLETED';
  await logJob(
    `Captured ${reviews.length} reviews for product ` +
    `${activeJob.detailIndex + 1}/${activeJob.products.length}.`
  );
  await completeCurrentDetail({
    ...activeJob.pendingDetailData,
    reviewsCollected: reviews.length,
    reviews,
    reviewsStatus,
    reviewsError: error
  });
}

async function processDomItems(items, sender) {
  if (
    !activeJob ||
    activeJob.phase !== 'SEARCH' ||
    sender.tab?.id !== activeJob.tabId ||
    !Array.isArray(items)
  ) return;
  const storedCount = await storeItems(items);
  if (!storedCount) return;
  await logJob(`Captured ${storedCount} products from rendered Shopee cards.`);
  if (activeJob.seen.length >= activeJob.maxItems) {
    await beginDetailPhase();
    return;
  }
  await scheduleNextPage();
}

async function processDomDetail(detail, sender) {
  if (
    !activeJob ||
    activeJob.phase !== 'DETAIL' ||
    sender.tab?.id !== activeJob.tabId ||
    !detail
  ) return;
  const currentId = String(activeJob.currentProduct?.itemId || '');
  if (detail.itemId && String(detail.itemId) !== currentId) return;
  await requestReviewsForCurrent({
    ...detail,
    itemId: currentId,
    detailStatus: 'COMPLETED'
  });
}

async function poll() {
  if (!config?.token || activeJob) return;
  try {
    const response = await api('/api/browser-agent/jobs/next');
    if (response.status === 204) return;
    const job = await response.json();
    activeJob = {
      ...job,
      phase: 'SEARCH',
      page: 0,
      seen: [],
      products: [],
      detailIndex: 0,
      detailCompleted: 0,
      detailFailed: 0,
      currentProduct: null,
      detailHandledFor: null,
      pendingDetailData: null,
      reviewRequestedFor: null,
      tabId: null,
      unexpectedResponses: 0,
      navigationScheduled: false,
      pageDeadline: Date.now() + SEARCH_TIMEOUT_MS
    };
    await persistActiveJob();
    const tab = await chrome.tabs.create({
      url: 'about:blank',
      active: true
    });
    activeJob.tabId = tab.id;
    await persistActiveJob();
    await chrome.tabs.update(tab.id, {
      url: searchUrl(job.keyword, 0)
    });
    armPageTimeout(SEARCH_TIMEOUT_MS);
  } catch (error) {
    if (activeJob) {
      await finishJob(false, error instanceof Error ? error.message : 'Không thể mở tab Shopee.');
    }
    // Dashboard polling will retry when the API becomes available again.
  }
}

function schedulePoll(delay = 3000) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await poll();
    schedulePoll(3000);
  }, delay);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    await stateReady;
    if (message.type === 'CONFIGURE') {
      config = { token: message.token, apiBase: message.apiBase };
      await chrome.storage.session.set({ config });
      schedulePoll(0);
    } else if (message.type === 'POLL_NOW') {
      void poll();
    } else if (message.type === 'SHOPEE_RESPONSE') {
      const handler = message.detail?.kind === 'detail'
        ? processDetailResponse
        : message.detail?.kind === 'reviews'
          ? processReviewsResponse
          : processSearchResponse;
      void handler(message.detail, sender).catch((error) => {
        void finishJob(
          false,
          error instanceof Error ? error.message : 'Không thể xử lý dữ liệu Shopee.'
        ).catch(() => undefined);
      });
    } else if (message.type === 'SHOPEE_DOM_ITEMS') {
      void processDomItems(message.items, sender).catch((error) => {
        void finishJob(
          false,
          error instanceof Error ? error.message : 'Không thể xử lý card sản phẩm Shopee.'
        ).catch(() => undefined);
      });
    } else if (message.type === 'SHOPEE_DOM_DETAIL') {
      void processDomDetail(message.detail, sender).catch((error) => {
        void finishJob(
          false,
          error instanceof Error ? error.message : 'Không thể lưu chi tiết sản phẩm Shopee.'
        ).catch(() => undefined);
      });
    } else if (
      message.type === 'SHOPEE_BLOCKED' &&
      activeJob &&
      sender.tab?.id === activeJob.tabId
    ) {
      void finishJob(
        false,
        'Shopee yêu cầu CAPTCHA hoặc đăng nhập trong Chrome.'
      ).catch(() => undefined);
    }
    sendResponse({ ok: true });
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeJob?.tabId === tabId) {
    void finishJob(false, 'Tab Shopee của Browser Agent đã bị đóng.')
      .catch(() => undefined);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('omnicrawl-poll', { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'omnicrawl-poll') return;
  if (activeJob?.pageDeadline && Date.now() >= activeJob.pageDeadline) {
    void handlePageTimeout().catch(() => undefined);
    return;
  }
  void poll();
});

stateReady.then(async () => {
  if (activeJob) {
    if (activeJob.navigationScheduled) {
      activeJob.navigationScheduled = false;
      if (activeJob.phase === 'SEARCH') activeJob.page = Math.max(0, activeJob.page - 1);
      await persistActiveJob();
      if (activeJob.phase === 'DETAIL') await navigateNextDetail();
      else await scheduleNextPage();
    } else if (activeJob.pageDeadline) {
      const remaining = Math.max(1, activeJob.pageDeadline - Date.now());
      pageTimer = setTimeout(() => void handlePageTimeout(), remaining);
    } else if (activeJob.phase === 'DETAIL') {
      await navigateNextDetail();
    }
  }
  if (config) schedulePoll(0);
});
