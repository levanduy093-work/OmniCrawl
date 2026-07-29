let config = null;
let activeJob = null;
let pollTimer = null;
let pageTimer = null;
let searchMessageQueue = Promise.resolve();
let reviewMessageQueue = Promise.resolve();
let detailMessageQueue = Promise.resolve();
let searchImageReadyTimer = null;
const detailWorkerTimers = new Map();

const SEARCH_TIMEOUT_MS = 30000;
const TIKTOK_SEARCH_TIMEOUT_MS = 45000;
const DETAIL_TIMEOUT_MS = 90000;
const MIN_SHOPEE_ITEMS_PER_PAGE = 20;
const FAST_SHOPEE_PAGE_ITEMS = 50;
const MAX_SHOPEE_PAGE_RETRIES = 2;
const MAX_SHOPEE_DOM_REVIEW_RETRIES = 3;
const MAX_SHOPEE_ZERO_REVIEW_RETRIES = 1;
const MAX_REVIEWS_PER_PRODUCT = 100000;
const MAX_DETAIL_CONCURRENCY = 6;
const SPARSE_DETAIL_RECHECK_MS = 1000;
const MAX_DETAIL_READY_PROBES = 12;
const DETAIL_DEADLINE_ALARM_PREFIX = 'omnicrawl-detail-deadline:';
const DETAIL_READY_ALARM_PREFIX = 'omnicrawl-detail-ready:';
const SHOPEE_IMAGE_READY_ALARM = 'omnicrawl-shopee-image-ready';
const MAX_SHOPEE_IMAGE_READY_ROUNDS = 15;

const stateReady = Promise.all([
  chrome.storage.session.get(['config', 'activeJob']),
  chrome.storage.local.get(['activeJobRecovery'])
]).then(([stored, durable]) => {
  config = stored.config || null;
  activeJob = stored.activeJob || durable.activeJobRecovery || null;
  if (activeJob) {
    activeJob.platform = activeJob.platform || 'shopee';
    activeJob.mode = activeJob.mode || 'products';
    activeJob.phase = activeJob.phase || 'SEARCH';
    activeJob.products = Array.isArray(activeJob.products) ? activeJob.products : [];
    activeJob.detailIndex = Number(activeJob.detailIndex || 0);
    activeJob.detailCompleted = Number(activeJob.detailCompleted || 0);
    activeJob.detailFailed = Number(activeJob.detailFailed || 0);
    const restoredMaxReviews = Number(activeJob.maxReviewsPerProduct ?? 20);
    activeJob.maxReviewsPerProduct = Number.isFinite(restoredMaxReviews)
      ? Math.min(
        MAX_REVIEWS_PER_PRODUCT,
        Math.max(0, Math.floor(restoredMaxReviews))
      )
      : 20;
    activeJob.pendingDetailData = activeJob.pendingDetailData || null;
    activeJob.reviewsApiError = activeJob.reviewsApiError || '';
    activeJob.reviewBuffer = Array.isArray(activeJob.reviewBuffer)
      ? activeJob.reviewBuffer
      : [];
    activeJob.reviewsCollected = Number(
      activeJob.reviewsCollected || activeJob.reviewBuffer.length || 0
    );
    activeJob.reviewRatingSum = Number(activeJob.reviewRatingSum || 0);
    activeJob.reviewsWithRating = Number(activeJob.reviewsWithRating || 0);
    activeJob.reviewSeen = Array.isArray(activeJob.reviewSeen)
      ? activeJob.reviewSeen
      : [];
    activeJob.reviewApiPending = Boolean(activeJob.reviewApiPending);
    activeJob.reviewDomFinal = Boolean(activeJob.reviewDomFinal);
    activeJob.reviewDomRetryRounds = Number(activeJob.reviewDomRetryRounds || 0);
    activeJob.reviewPageReloads = Number(activeJob.reviewPageReloads || 0);
    activeJob.windowId = activeJob.windowId == null ? null : Number(activeJob.windowId);
    activeJob.scheduledPage = activeJob.scheduledPage == null
      ? null
      : Number(activeJob.scheduledPage);
    activeJob.consecutiveNoNewPages = Number(activeJob.consecutiveNoNewPages || 0);
    activeJob.lastNoNewPage = activeJob.lastNoNewPage == null
      ? null
      : Number(activeJob.lastNoNewPage);
    activeJob.pageNewItemCounts = (
      activeJob.pageNewItemCounts &&
      typeof activeJob.pageNewItemCounts === 'object'
    ) ? activeJob.pageNewItemCounts : {};
    activeJob.pageRetryCounts = (
      activeJob.pageRetryCounts &&
      typeof activeJob.pageRetryCounts === 'object'
    ) ? activeJob.pageRetryCounts : {};
    activeJob.itemImages = (
      activeJob.itemImages &&
      typeof activeJob.itemImages === 'object'
    ) ? activeJob.itemImages : {};
    activeJob.searchImageReadyRounds = Number(activeJob.searchImageReadyRounds || 0);
    activeJob.searchImageReadyScheduled = Boolean(activeJob.searchImageReadyScheduled);
    activeJob.detailConcurrency = Math.min(
      MAX_DETAIL_CONCURRENCY,
      Math.max(1, Math.floor(Number(activeJob.detailConcurrency || 1)))
    );
    activeJob.detailNextIndex = Number(
      activeJob.detailNextIndex ?? activeJob.detailIndex ?? 0
    );
    activeJob.detailWorkers = Array.isArray(activeJob.detailWorkers)
      ? activeJob.detailWorkers
      : [];
    activeJob.detailAssignments = (
      activeJob.detailAssignments &&
      typeof activeJob.detailAssignments === 'object'
    ) ? activeJob.detailAssignments : {};
    activeJob.reviewOwnerTabId = activeJob.reviewOwnerTabId == null
      ? null
      : Number(activeJob.reviewOwnerTabId);
    activeJob.reviewApiFailureStreak = Number(activeJob.reviewApiFailureStreak || 0);
    activeJob.reviewApiDegraded = Boolean(activeJob.reviewApiDegraded);
  }
});

function activeJobRecoverySnapshot(job) {
  if (!job) return null;
  return {
    ...job,
    detailWorkers: (job.detailWorkers || []).map((worker) => ({
      ...worker,
      reviewSeen: []
    })),
    reviewSeen: []
  };
}

function persistActiveJob() {
  return Promise.all([
    chrome.storage.session.set({ activeJob }),
    chrome.storage.local.set({
      activeJobRecovery: activeJobRecoverySnapshot(activeJob)
    })
  ]);
}

function enqueueSearchMessage(handler, fallbackError) {
  const task = searchMessageQueue
    .catch(() => undefined)
    .then(handler);
  searchMessageQueue = task.catch(() => undefined);
  void task.catch((error) => {
    void finishJob(
      false,
      error instanceof Error ? error.message : fallbackError
    ).catch(() => undefined);
  });
}

function enqueueReviewMessage(handler, fallbackError) {
  const task = reviewMessageQueue
    .catch(() => undefined)
    .then(handler);
  reviewMessageQueue = task.catch(() => undefined);
  void task.catch((error) => {
    void failCurrentDetail(
      error instanceof Error ? error.message : fallbackError
    );
  });
}

function enqueueDetailMessage(handler, fallbackError) {
  const task = detailMessageQueue
    .catch(() => undefined)
    .then(handler);
  detailMessageQueue = task.catch(() => undefined);
  void task.catch((error) => {
    void logJob(
      error instanceof Error ? error.message : fallbackError
    ).catch(() => undefined);
  });
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

function searchTimeoutForJob(job = activeJob) {
  return job?.platform === 'tiktok' ? TIKTOK_SEARCH_TIMEOUT_MS : SEARCH_TIMEOUT_MS;
}

async function handlePageTimeout() {
  if (!activeJob || !activeJob.pageDeadline || Date.now() < activeJob.pageDeadline) return;
  if (activeJob.phase === 'DETAIL' && activeJob.currentProduct) {
    if (activeJob.pendingDetailData) {
      const reviewsCollected = Number(activeJob.reviewsCollected || 0);
      await completeCurrentDetail({
        ...activeJob.pendingDetailData,
        reviewsCollected,
        ...reviewRatingSummary(),
        reviewsStatus: reviewsCollected ? 'PARTIAL' : 'FAILED',
        reviewsError: activeJob.reviewsApiError ||
          `Không nhận được dữ liệu đánh giá từ ${platformLabel(activeJob)} sau 90 giây.`
      });
      return;
    }
    await failCurrentDetail(
      `Không nhận được dữ liệu chi tiết từ ${platformLabel(activeJob)} sau 90 giây.`
    );
    return;
  }
  if (activeJob.phase === 'SEARCH' && activeJob.seen.length > 0) {
    clearPageTimeout();
    await continueAfterNoNewSearchData(
      `${platformLabel(activeJob)} page ${activeJob.page} did not return new data within ` +
      `${Math.round(searchTimeoutForJob(activeJob) / 1000)} seconds; ` +
      'continuing with the products already collected.'
    );
    return;
  }
  const label = platformLabel(activeJob);
  await finishJob(
    false,
    `Không nhận được dữ liệu tìm kiếm từ ${label} sau ` +
    `${Math.round(searchTimeoutForJob(activeJob) / 1000)} giây.`
  );
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

function platformLabel(job = activeJob) {
  return job?.platform === 'tiktok' ? 'TikTok' : 'Shopee';
}

function searchUrlForJob(job, page) {
  if (job?.platform !== 'tiktok') return searchUrl(job.keyword, page);
  return (
    `https://www.tiktok.com/search?q=${encodeURIComponent(job.keyword)}` +
    `&omnicrawl_mode=${encodeURIComponent(job.mode || 'videos')}`
  );
}

function platformTabPatterns(job) {
  return job?.platform === 'tiktok'
    ? ['https://*.tiktok.com/*']
    : ['https://shopee.vn/*', 'https://*.shopee.vn/*'];
}

async function createCrawlerWindow(job) {
  const existingTabs = await chrome.tabs.query({
    url: platformTabPatterns(job)
  });
  const sourceTab = existingTabs
    .filter((tab) => (
      tab.id &&
      !tab.incognito &&
      !String(tab.url || '').includes('/login') &&
      !String(tab.url || '').includes('/verify')
    ))
    .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];

  let workerTab = null;
  let restoreTabId = null;
  if (sourceTab?.id) {
    const [activeSourceWindowTab] = await chrome.tabs.query({
      active: true,
      windowId: sourceTab.windowId
    });
    restoreTabId = activeSourceWindowTab?.id || null;
    workerTab = await chrome.tabs.duplicate(sourceTab.id);
  } else {
    workerTab = await chrome.tabs.create({
      url: 'about:blank',
      active: false
    });
  }
  if (!workerTab?.id) {
    throw new Error(`Không thể tạo tab ${platformLabel(job)} cho Browser Agent.`);
  }

  const crawlerWindow = await chrome.windows.create({
    tabId: workerTab.id,
    type: 'normal',
    focused: false,
    width: 1100,
    height: 820,
    left: 40,
    top: 40
  });
  if (restoreTabId && restoreTabId !== workerTab.id) {
    await chrome.tabs.update(restoreTabId, { active: true }).catch(() => undefined);
  }
  const tab = crawlerWindow.tabs?.[0] || await chrome.tabs.get(workerTab.id);
  if (!tab?.id || !crawlerWindow.id) {
    throw new Error('Không thể tạo cửa sổ Browser Agent riêng.');
  }
  job.tabId = tab.id;
  job.windowId = crawlerWindow.id;
  await persistActiveJob();
  await chrome.tabs.update(tab.id, {
    active: true,
    url: searchUrlForJob(job, 0)
  });
  return {
    tab,
    windowId: crawlerWindow.id,
    reusedSessionTab: Boolean(sourceTab?.id)
  };
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
  const isItemCandidate = (candidate) => (
    candidate &&
    typeof candidate === 'object' &&
    (
      candidate.itemid ||
      candidate.item_id ||
      candidate.name ||
      candidate.title ||
      candidate.item_name
    )
  );
  const directMatch = candidates.find(isItemCandidate);
  if (directMatch) return directMatch;

  const queue = [{ value: entry, depth: 0 }];
  const visited = new WeakSet();
  let inspected = 0;
  let richestMatch = null;
  let richestScore = -1;
  while (queue.length && inspected < 300) {
    const current = queue.shift();
    const value = current?.value;
    const depth = current?.depth ?? 0;
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    if (isItemCandidate(value)) {
      const score = [
        value.itemid || value.item_id,
        value.shopid || value.shop_id,
        value.name || value.title || value.item_name,
        value.image || value.images?.length,
        value.price || value.price_min || value.price_info
      ].filter(Boolean).length;
      if (score > richestScore) {
        richestMatch = value;
        richestScore = score;
      }
    }
    if (depth >= 6) continue;
    for (const [key, child] of Object.entries(value)) {
      if (
        child &&
        typeof child === 'object' &&
        (
          depth < 2 ||
          /(?:item|product|card|data|basic|display|asset|content)/i.test(key)
        )
      ) {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return richestMatch || {};
}

function findNestedField(root, fieldNames) {
  if (!root || typeof root !== 'object') return undefined;
  const wanted = new Set(fieldNames);
  const queue = [{ value: root, depth: 0 }];
  const visited = new WeakSet();
  let inspected = 0;
  while (queue.length && inspected < 300) {
    const current = queue.shift();
    const value = current?.value;
    const depth = current?.depth ?? 0;
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key) && child !== null && child !== undefined && child !== '') {
        return child;
      }
      if (
        depth < 6 &&
        child &&
        typeof child === 'object' &&
        (
          depth < 2 ||
          /(?:item|product|card|data|basic|display|asset|content|price|rating|review|comment|summary)/i.test(key)
        )
      ) {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return undefined;
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
    value.sale_price,
    value.salePrice,
    value.sale_price_decimal,
    value.price_decimal,
    value.price,
    value.value,
    value.amount,
    value.single_value,
    value.min_price,
    value.min_sale_price,
    value.price_min,
    value.range_min
  ];
  for (const candidate of candidates) {
    const numeric = extractPrice(candidate);
    if (numeric !== null) return numeric;
  }
  return null;
}

function normalizeShopeePrice(value) {
  const raw = extractPrice(value);
  if (raw === null) return null;
  return Math.round(raw > 100000000 ? raw / 100000 : raw);
}

function unixTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return new Date(numeric * (numeric < 10_000_000_000 ? 1000 : 1)).toISOString();
}

function imageUrl(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = imageUrl(candidate, depth + 1);
      if (resolved) return resolved;
    }
    return '';
  }
  if (typeof value === 'object') {
    const candidates = [
      value?.full_url,
      value?.display_url,
      value?.image_url,
      value?.url_list,
      value?.urlList,
      value?.urls,
      value?.display_image,
      value?.thumbnail,
      value?.cover_image,
      value?.cover,
      value?.image_id,
      value?.image,
      value?.url
    ];
    for (const candidate of candidates) {
      const resolved = imageUrl(candidate, depth + 1);
      if (resolved) return resolved;
    }
    for (const [key, candidate] of Object.entries(value)) {
      if (!/(?:image|thumbnail|cover|url[_-]?list|display[_-]?asset)/i.test(key)) continue;
      const resolved = imageUrl(candidate, depth + 1);
      if (resolved) return resolved;
    }
    return '';
  }
  const text = String(value).replace(/\\u002F/g, '/').trim();
  if (!text || text.startsWith('data:') || text === '[object Object]') return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  if (/\s/.test(text) || text.length < 8) return '';
  return `https://down-vn.img.susercontent.com/file/${text}`;
}

function findNestedImage(root) {
  if (!root || typeof root !== 'object') return '';
  const queue = [{ value: root, depth: 0 }];
  const visited = new WeakSet();
  let inspected = 0;
  while (queue.length && inspected < 500) {
    const current = queue.shift();
    const value = current?.value;
    const depth = current?.depth ?? 0;
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    inspected += 1;
    for (const [key, child] of Object.entries(value)) {
      if (/(?:^|_)(?:image|images|image_id|image_info|image_list|thumbnail|cover_image|display_image|display_asset)(?:$|_)/i.test(key)) {
        const resolved = imageUrl(child);
        if (resolved) return resolved;
      }
      if (depth < 6 && child && typeof child === 'object') {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return '';
}

function normalizeSoldValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'object') {
    const candidates = [
      value.value,
      value.count,
      value.total,
      value.historical_sold,
      value.total_sold,
      value.sold_count,
      value.text,
      value.display_text,
      value.label
    ];
    for (const candidate of candidates) {
      const normalized = normalizeSoldValue(candidate);
      if (normalized !== 0 && normalized !== '') return normalized;
    }
    return 0;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return 0;
  const match = text.match(
    /(\d+(?:[.,]\d+)?\s*(?:k|nghìn|tr|triệu)?\+?)(?:\s*(?:đã bán|sold))?/i
  );
  return match ? match[1].replace(/\s+/g, '') : 0;
}

function firstTikTokImage(...values) {
  for (const value of values.flat(Infinity)) {
    if (!value) continue;
    const candidate = typeof value === 'object'
      ? value.url_list?.[0] || value.urlList?.[0] || value.url || value.uri
      : value;
    if (candidate) return String(candidate);
  }
  return '';
}

function tikTokTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return new Date(numeric * (numeric < 10_000_000_000 ? 1000 : 1)).toISOString();
}

function formatTikTokPrice(value, currency = 'VND') {
  const numeric = extractPrice(value);
  if (numeric === null) return { price: '', priceValue: null };
  const normalized = Math.round(numeric);
  return {
    price: currency === 'VND'
      ? `${normalized.toLocaleString('vi-VN')}₫`
      : `${normalized.toLocaleString()} ${currency}`,
    priceValue: normalized
  };
}

function mapTikTokVideo(entry, context = {}) {
  const item = (
    entry?.item ??
    entry?.itemStruct ??
    entry?.item_struct ??
    entry?.aweme_info ??
    entry?.awemeInfo ??
    entry
  );
  const itemId = item?.id ?? item?.itemId ?? item?.item_id ?? item?.aweme_id;
  const description = String(
    item?.desc ?? item?.description ?? item?.title ?? entry?.desc ?? ''
  ).trim();
  const author = item?.author ?? item?.authorInfo ?? item?.author_info ?? {};
  const authorName = String(
    author?.uniqueId ?? author?.unique_id ?? author?.nickname ?? item?.author_name ?? ''
  ).replace(/^@/, '');
  const stats = item?.stats ?? item?.statistics ?? item?.statsV2 ?? {};
  const video = item?.video ?? item?.videoInfo ?? {};
  const music = item?.music ?? {};
  const challenges = item?.challenges ?? item?.textExtra ?? item?.text_extra ?? [];
  if (!itemId || !description) return null;
  return {
    itemId: String(itemId),
    sourceType: 'video',
    title: description,
    description,
    author: String(author?.nickname ?? authorName),
    authorId: String(author?.id ?? author?.uid ?? author?.secUid ?? ''),
    authorUrl: authorName ? `https://www.tiktok.com/@${authorName}` : '',
    url: String(
      item?.shareUrl ??
      item?.share_url ??
      (authorName ? `https://www.tiktok.com/@${authorName}/video/${itemId}` : '')
    ),
    image: firstTikTokImage(
      video?.cover,
      video?.originCover,
      video?.dynamicCover,
      item?.cover
    ),
    views: extractNumber(stats?.playCount ?? stats?.play_count ?? stats?.viewCount),
    likes: extractNumber(stats?.diggCount ?? stats?.digg_count ?? stats?.likeCount),
    comments: extractNumber(stats?.commentCount ?? stats?.comment_count),
    shares: extractNumber(stats?.shareCount ?? stats?.share_count),
    saves: extractNumber(stats?.collectCount ?? stats?.collect_count),
    duration: extractNumber(video?.duration ?? item?.duration),
    musicTitle: String(music?.title ?? music?.musicName ?? ''),
    hashtags: Array.isArray(challenges)
      ? challenges
        .map((challenge) => (
          challenge?.title ??
          challenge?.hashtagName ??
          challenge?.hashtag_name ??
          challenge?.hashtagId
        ))
        .filter(Boolean)
        .map(String)
      : [],
    publishedAt: tikTokTimestamp(item?.createTime ?? item?.create_time),
    searchKeyword: String(context.keyword || ''),
    searchPage: Number(context.page || 0),
    searchPosition: Number(context.position || 0),
    searchRank: Number(context.page || 0) * 100 + Number(context.position || 0),
    observedAt: new Date().toISOString(),
    detailStatus: 'COMPLETED'
  };
}

function mapTikTokProduct(entry, context = {}) {
  const product = (
    entry?.product ??
    entry?.productInfo ??
    entry?.product_info ??
    entry?.product_data ??
    entry?.productData ??
    entry
  );
  const itemId = (
    product?.product_id ??
    product?.productId ??
    product?.id ??
    product?.item_id
  );
  const title = String(
    product?.title ??
    product?.name ??
    product?.product_name ??
    product?.productName ??
    ''
  ).trim();
  if (!itemId || !title) return null;
  const priceInfo = (
    product?.price ??
    product?.sale_price ??
    product?.salePrice ??
    product?.price_info ??
    product?.priceInfo
  );
  const currency = String(
    priceInfo?.currency ??
    priceInfo?.currency_code ??
    product?.currency ??
    'VND'
  ).toUpperCase();
  const formatted = formatTikTokPrice(priceInfo, currency);
  const shop = product?.shop ?? product?.seller ?? product?.shop_info ?? {};
  const rating = product?.rating ?? product?.review_info ?? {};
  const productUrl = String(
    product?.product_url ??
    product?.productUrl ??
    product?.share_url ??
    product?.url ??
    `https://shop.tiktok.com/view/product/${itemId}?region=VN`
  );
  return {
    itemId: String(itemId),
    sourceType: 'product',
    shopId: String(shop?.shop_id ?? shop?.shopId ?? shop?.id ?? ''),
    title,
    description: String(product?.description ?? product?.desc ?? ''),
    price: formatted.price,
    priceValue: formatted.priceValue,
    originalPrice: extractPrice(
      product?.original_price ?? product?.originalPrice ?? product?.market_price
    ),
    currency,
    sold: product?.sold_count ?? product?.soldCount ?? product?.sales ?? 0,
    rating: extractNumber(rating?.rating ?? rating?.score ?? product?.rating),
    reviewCount: extractNumber(
      rating?.review_count ?? rating?.reviewCount ?? product?.review_count
    ),
    author: String(shop?.name ?? shop?.shop_name ?? shop?.seller_name ?? ''),
    shopName: String(shop?.name ?? shop?.shop_name ?? shop?.seller_name ?? ''),
    url: productUrl,
    image: firstTikTokImage(
      product?.main_image,
      product?.mainImage,
      product?.images,
      product?.image
    ),
    searchKeyword: String(context.keyword || ''),
    searchPage: Number(context.page || 0),
    searchPosition: Number(context.position || 0),
    searchRank: Number(context.page || 0) * 100 + Number(context.position || 0),
    observedAt: new Date().toISOString(),
    detailStatus: 'COMPLETED'
  };
}

function collectTikTokItems(payload, kind, context = {}) {
  const mapper = kind === 'product-search' ? mapTikTokProduct : mapTikTokVideo;
  const output = [];
  const seenIds = new Set();
  const visited = new WeakSet();

  const visit = (value, depth = 0) => {
    if (!value || depth > 6 || output.length >= 500) return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const mapped = mapper(entry, {
          ...context,
          position: output.length + 1
        });
        if (mapped?.itemId && !seenIds.has(mapped.itemId)) {
          seenIds.add(mapped.itemId);
          output.push(mapped);
        }
        visit(entry, depth + 1);
      }
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (
        depth < 2 ||
        /(?:item|product|aweme|search|data|list|result)/i.test(key)
      ) visit(child, depth + 1);
    }
  };

  visit(payload);
  return output;
}

function mapItem(entry, context = {}) {
  const item = findItemObject(entry);
  const priceValue = normalizeShopeePrice(
    item?.price_min ??
    item?.price ??
    item?.price_info ??
    item?.item_price ??
    entry?.price_info ??
    entry?.display_price ??
    entry?.item_card_display_price ??
    findNestedField(entry, [
      'price_min',
      'price',
      'price_info',
      'item_price',
      'display_price',
      'item_card_display_price'
    ])
  );
  const itemId = item?.itemid ?? item?.item_id ??
    findNestedField(entry, ['itemid', 'item_id']);
  const shopId = item?.shopid ?? item?.shop_id ??
    findNestedField(entry, ['shopid', 'shop_id']);
  const searchPosition = Number(context.position || 0);
  const adId = entry?.adsid ?? entry?.item_card?.adsid ?? item?.adsid;
  const campaignId = entry?.campaignid ?? entry?.item_card?.campaignid;
  const hasIdentifier = (identifier) => (
    identifier !== null &&
    identifier !== undefined &&
    identifier !== '' &&
    String(identifier) !== '0'
  );
  const originalPrice = normalizeShopeePrice(
    item?.price_before_discount ??
    item?.price_min_before_discount ??
    item?.original_price ??
    entry?.price_before_discount
  );
  const imageId = (
    item?.image?.image_id ??
    item?.image ??
    item?.images?.[0]?.image_id ??
    item?.images?.[0] ??
    entry?.image ??
    entry?.images?.[0] ??
    entry?.item_card?.image ??
    entry?.item_card?.images?.[0] ??
    findNestedField(entry, [
      'image_url',
      'imageUrl',
      'display_image',
      'displayImage',
      'thumbnail',
      'cover_image',
      'coverImage',
      'image_id'
    ]) ??
    findNestedImage(entry)
  );
  const resolvedImage = imageUrl(imageId) || findNestedImage(entry);
  const sold = normalizeSoldValue(
    item?.historical_sold ??
    item?.total_sold ??
    item?.sold ??
    item?.sold_count ??
    item?.soldCount ??
    findNestedField(entry, [
      'historical_sold',
      'total_sold',
      'sold',
      'sold_count',
      'soldCount'
    ]) ??
    0
  );
  return {
    itemId: itemId === undefined || itemId === null ? '' : String(itemId),
    shopId: shopId === undefined || shopId === null ? '' : String(shopId),
    title: String(
      item?.name ||
      item?.title ||
      item?.item_name ||
      entry?.display_name ||
      findNestedField(entry, ['name', 'title', 'item_name', 'display_name']) ||
      ''
    ).trim(),
    price: priceValue !== null
      ? `${priceValue.toLocaleString('vi-VN')}₫`
      : '',
    priceValue,
    originalPrice,
    discountPercent: extractNumber(item?.discount ?? item?.discount_percentage),
    sold,
    searchKeyword: String(context.keyword || ''),
    searchPage: Number(context.page || 0),
    searchPosition,
    searchRank: Number(context.page || 0) * 60 + searchPosition,
    isSponsored: hasIdentifier(adId) || hasIdentifier(campaignId),
    campaignId: hasIdentifier(campaignId) ? String(campaignId) : '',
    categoryId: String(item?.catid ?? item?.category_id ?? ''),
    shopName: String(item?.shop_name ?? entry?.shop_name ?? ''),
    isMall: Boolean(item?.is_official_shop || item?.is_mall),
    isPreferred: Boolean(
      item?.is_preferred ||
      item?.is_preferred_plus_seller ||
      item?.is_preferred_plus
    ),
    url: itemId && shopId ? `https://shopee.vn/product/${shopId}/${itemId}` : '',
    image: resolvedImage,
    observedAt: new Date().toISOString()
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
  const shop = (
    root?.shop_detailed ??
    root?.shop ??
    root?.seller ??
    root?.shop_data ??
    item?.shop_detailed ??
    item?.shop ??
    {}
  );
  const categories = item?.categories ?? root?.categories ?? [];
  const attributes = Array.isArray(item?.attributes)
    ? item.attributes.map((attribute) => ({
      name: String(attribute?.name || attribute?.display_name || ''),
      value: readableAttributeValue(attribute)
    })).filter((attribute) => attribute.name || attribute.value)
    : [];
  const brandAttribute = attributes.find((attribute) => /brand|thương hiệu/i.test(attribute.name));
  const rating = item?.item_rating ?? item?.rating ?? {};
  const rawRatingCount = (
    rating?.rating_count ??
    rating?.count ??
    item?.rating_count ??
    item?.cmt_count ??
    findNestedField(root, [
      'rating_total',
      'rating_count',
      'review_count',
      'cmt_count'
    ])
  );
  const ratingCount = extractNumber(
    Array.isArray(rawRatingCount) ? rawRatingCount[0] : rawRatingCount
  );
  const rawTotalSold = (
    item?.historical_sold ??
    item?.total_sold ??
    root?.historical_sold ??
    root?.total_sold ??
    findNestedField(root, ['historical_sold', 'total_sold'])
  );
  const rawRecentSold = (
    item?.sold ??
    item?.monthly_sold ??
    root?.sold ??
    root?.monthly_sold ??
    findNestedField(root, ['sold', 'monthly_sold', 'sold_count'])
  );
  const sold = normalizeSoldValue(
    rawTotalSold ?? rawRecentSold ?? expectedProduct?.sold ?? null
  ) || null;
  const ratingBreakdown = Array.isArray(rating?.rating_count)
    ? rating.rating_count.map((count, index) => ({
      star: index === 0 ? 'all' : index,
      count: extractNumber(count)
    }))
    : [];
  const images = [
    item?.image,
    item?.cover,
    expectedProduct?.image,
    ...(Array.isArray(item?.images) ? item.images : []),
    ...(Array.isArray(item?.image_info?.image_list) ? item.image_info.image_list : []),
    ...(Array.isArray(item?.image_info?.images) ? item.image_info.images : []),
    ...(Array.isArray(root?.images) ? root.images : []),
    ...(Array.isArray(root?.image_info?.image_list) ? root.image_info.image_list : []),
    ...(Array.isArray(root?.product_images) ? root.product_images : [])
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
      price: normalizeShopeePrice(model?.price),
      originalPrice: normalizeShopeePrice(
        model?.price_before_discount ?? model?.original_price
      ),
      stock: extractNumber(model?.stock),
      sold: extractNumber(model?.sold ?? model?.historical_sold),
      promotionId: String(model?.promotionid ?? model?.promotion_id ?? '')
    }))
    : [];
  const promotionCandidates = [
    ...(Array.isArray(root?.vouchers) ? root.vouchers : []),
    ...(Array.isArray(root?.voucher_list) ? root.voucher_list : []),
    ...(Array.isArray(item?.vouchers) ? item.vouchers : []),
    root?.voucher,
    item?.voucher_info,
    item?.promotion_info,
    root?.add_on_deal_info,
    root?.flash_sale
  ].filter(Boolean);
  const promotions = promotionCandidates.slice(0, 30).map((promotion) => ({
    promotionId: String(promotion?.promotionid ?? promotion?.promotion_id ?? promotion?.id ?? ''),
    code: String(promotion?.voucher_code ?? promotion?.code ?? ''),
    label: String(
      promotion?.label ??
      promotion?.title ??
      promotion?.name ??
      promotion?.discount_text ??
      ''
    ),
    discountValue: extractNumber(
      promotion?.discount_value ?? promotion?.discount_amount ?? promotion?.discount
    ),
    discountPercentage: extractNumber(
      promotion?.discount_percentage ?? promotion?.percentage
    ),
    minimumSpend: normalizeShopeePrice(
      promotion?.min_spend ?? promotion?.minimum_spend
    ),
    startAt: unixTimestamp(promotion?.start_time ?? promotion?.start_at),
    endAt: unixTimestamp(promotion?.end_time ?? promotion?.end_at)
  }));
  const logisticCandidates = (
    root?.logistics?.logistic_channels ??
    root?.shipping_info?.logistic_channels ??
    item?.logistic_info ??
    item?.logistics ??
    []
  );
  const logistics = (Array.isArray(logisticCandidates) ? logisticCandidates : [])
    .slice(0, 30)
    .map((channel) => ({
      channelId: String(channel?.channelid ?? channel?.channel_id ?? ''),
      name: String(channel?.name || channel?.channel_name || ''),
      fee: normalizeShopeePrice(channel?.shipping_fee ?? channel?.fee),
      feeMin: normalizeShopeePrice(channel?.shipping_fee_min ?? channel?.fee_min),
      feeMax: normalizeShopeePrice(channel?.shipping_fee_max ?? channel?.fee_max),
      deliveryMinDays: extractNumber(
        channel?.min_delivery_days ?? channel?.estimated_delivery_time_min
      ),
      deliveryMaxDays: extractNumber(
        channel?.max_delivery_days ?? channel?.estimated_delivery_time_max
      ),
      freeShipping: Boolean(
        channel?.free_shipping ||
        channel?.is_free_shipping ||
        Number(channel?.shipping_fee ?? channel?.fee) === 0
      )
    }));
  const videos = [
    ...(Array.isArray(item?.video_info_list) ? item.video_info_list : []),
    ...(Array.isArray(root?.videos) ? root.videos : [])
  ].slice(0, 20).map((video) => ({
    videoId: String(video?.video_id ?? video?.id ?? ''),
    url: String(video?.video_url || video?.url || ''),
    thumbnail: imageUrl(video?.thumbnail || video?.cover_image)
  }));
  const wholesaleTiers = Array.isArray(item?.wholesale_tier_list)
    ? item.wholesale_tier_list.slice(0, 50).map((tier) => ({
      minimumOrder: extractNumber(tier?.min_count ?? tier?.minimum_order),
      maximumOrder: extractNumber(tier?.max_count ?? tier?.maximum_order),
      unitPrice: normalizeShopeePrice(tier?.unit_price ?? tier?.price)
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
    priceValue: normalizeShopeePrice(item?.price ?? item?.price_min),
    priceMin: normalizeShopeePrice(item?.price_min ?? item?.price),
    priceMax: normalizeShopeePrice(item?.price_max ?? item?.price),
    originalPrice: normalizeShopeePrice(
      item?.price_before_discount ?? item?.price_min_before_discount
    ),
    discountPercent: extractNumber(item?.discount ?? item?.discount_percentage),
    currency: String(item?.currency || root?.currency || 'VND'),
    rating: extractNumber(rating?.rating_star ?? rating?.rating ?? item?.rating_star),
    ratingCount,
    ratingBreakdown,
    sold,
    totalSold: extractNumber(rawTotalSold),
    salesLast30Days: extractNumber(rawRecentSold),
    stock: extractNumber(item?.stock ?? root?.stock),
    likedCount: extractNumber(item?.liked_count ?? item?.likedCount),
    viewCount: extractNumber(item?.view_count ?? item?.views),
    condition: String(item?.condition || item?.item_condition || ''),
    productCreatedAt: unixTimestamp(item?.ctime ?? item?.created_at),
    productUpdatedAt: unixTimestamp(item?.mtime ?? item?.updated_at),
    shopName: String(
      shop?.name ||
      shop?.shop_name ||
      shop?.username ||
      shop?.account?.username ||
      item?.shop_name ||
      ''
    ),
    shopLocation: String(
      item?.shop_location ||
      shop?.shop_location ||
      shop?.place ||
      ''
    ),
    shopUsername: String(shop?.username || shop?.account?.username || ''),
    shopDescription: String(shop?.description || shop?.shop_description || ''),
    shopRating: extractNumber(shop?.rating_star ?? shop?.rating),
    shopFollowerCount: extractNumber(
      shop?.follower_count ?? shop?.followers ?? shop?.follower
    ),
    shopResponseRate: extractNumber(shop?.response_rate),
    shopResponseTime: extractNumber(shop?.response_time),
    shopJoinedAt: unixTimestamp(shop?.ctime ?? shop?.created_at),
    shopLastActiveAt: unixTimestamp(shop?.last_active_time ?? shop?.last_active_at),
    shopProductCount: extractNumber(shop?.item_count ?? shop?.product_count),
    shopOnVacation: Boolean(shop?.vacation || shop?.is_on_vacation),
    shopIsMall: Boolean(
      shop?.is_official_shop ||
      shop?.is_mall ||
      item?.is_official_shop
    ),
    shopIsPreferred: Boolean(
      shop?.is_preferred_plus_seller ||
      shop?.is_preferred ||
      item?.is_preferred_plus_seller
    ),
    shopIsVerified: Boolean(
      shop?.is_shopee_verified ||
      shop?.is_verified ||
      shop?.account?.is_verified
    ),
    images: [...new Set(images)].slice(0, 30),
    attributes,
    variations,
    models,
    wholesaleTiers,
    promotions,
    logistics,
    videos,
    observedAt: new Date().toISOString(),
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
    ? rating.images.map(imageUrl).filter(Boolean).map((value) => value.slice(0, 2000))
    : [];
  const videos = Array.isArray(rating?.videos)
    ? rating.videos
      .map((video) => video?.url || video?.video_url || video)
      .filter(Boolean)
      .map((value) => String(value).slice(0, 2000))
    : [];
  const productItem = Array.isArray(rating?.product_items)
    ? rating.product_items[0]
    : rating?.product_item;
  const rawShopReply = rating?.seller_reply || rating?.shop_reply || rating?.reply;
  return {
    reviewId: String(rating?.cmtid ?? rating?.comment_id ?? '').slice(0, 200),
    author: String(rating?.author_username || rating?.username || '').slice(0, 1000),
    authorId: String(rating?.userid ?? rating?.user_id ?? '').slice(0, 200),
    rating: extractNumber(rating?.rating_star ?? rating?.rating),
    comment: String(rating?.comment || rating?.content || '').slice(0, 20_000),
    createdAt,
    variation: String(
      productItem?.model_name ||
      rating?.product_variation ||
      rating?.model_name ||
      ''
    ),
    likes: extractNumber(rating?.like_count ?? rating?.likes),
    images: images.slice(0, 20),
    videos: videos.slice(0, 10),
    shopReply: (typeof rawShopReply === 'object'
      ? String(rawShopReply?.comment || rawShopReply?.content || rawShopReply?.reply || '')
      : String(rawShopReply || '')).slice(0, 20_000)
  };
}

function mapReviewsPayload(payload) {
  const rawRatings = payload?.ratings ?? payload?.data?.ratings ?? [];
  return Array.isArray(rawRatings) ? rawRatings.map(mapReview) : [];
}

function mapTikTokComment(comment) {
  const createdAtValue = Number(
    comment?.create_time ?? comment?.createTime ?? comment?.created_at
  );
  const author = comment?.user ?? comment?.author ?? {};
  const images = [
    ...(Array.isArray(comment?.image_list) ? comment.image_list : []),
    ...(Array.isArray(comment?.images) ? comment.images : [])
  ].map(firstTikTokImage).filter(Boolean);
  return {
    reviewId: String(comment?.cid ?? comment?.comment_id ?? comment?.id ?? ''),
    author: String(
      author?.nickname ?? author?.unique_id ?? author?.uniqueId ??
      comment?.user_name ?? comment?.username ?? ''
    ),
    authorId: String(author?.uid ?? author?.id ?? author?.sec_uid ?? ''),
    rating: extractNumber(comment?.rating ?? comment?.score),
    comment: String(comment?.text ?? comment?.content ?? comment?.comment ?? ''),
    createdAt: Number.isFinite(createdAtValue) && createdAtValue > 0
      ? new Date(createdAtValue * (createdAtValue < 10_000_000_000 ? 1000 : 1)).toISOString()
      : '',
    likes: extractNumber(comment?.digg_count ?? comment?.like_count ?? comment?.likes),
    images,
    videos: [],
    variation: '',
    shopReply: ''
  };
}

function mapTikTokCommentsPayload(payload) {
  const candidates = [
    payload?.comments,
    payload?.comment_list,
    payload?.data?.comments,
    payload?.data?.comment_list,
    payload?.data?.reviews,
    payload?.reviews
  ];
  const rawComments = candidates.find(Array.isArray) || [];
  return rawComments
    .map(mapTikTokComment)
    .filter((comment) => comment.reviewId || comment.comment);
}

function maxReviewsForJob(job = activeJob) {
  return Math.min(
    MAX_REVIEWS_PER_PRODUCT,
    Math.max(0, Math.floor(Number(job?.maxReviewsPerProduct ?? 20)))
  );
}

function expectedReviewTarget(value, job = activeJob) {
  if (value === null || value === undefined || value === '') {
    return maxReviewsForJob(job);
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.min(maxReviewsForJob(job), numeric)
    : maxReviewsForJob(job);
}

async function mergeReviewBuffer(reviews) {
  if (!activeJob || !Array.isArray(reviews)) return { length: 0 };
  const seen = new Set(activeJob.reviewSeen || []);
  const fresh = [];
  for (const review of reviews) {
    const key = String(
      review?.reviewId ||
      `${review?.author || ''}:${review?.createdAt || ''}:${review?.comment || ''}`
    );
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(review);
    if (
      Number(activeJob.reviewsCollected || 0) + fresh.length >=
      maxReviewsForJob(activeJob)
    ) break;
  }
  if (fresh.length) {
    const chunks = [];
    let chunk = [];
    let chunkBytes = 0;
    for (const review of fresh) {
      const reviewBytes = new TextEncoder().encode(JSON.stringify(review)).length;
      if (chunk.length && (chunk.length >= 50 || chunkBytes + reviewBytes > 70_000)) {
        chunks.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(review);
      chunkBytes += reviewBytes;
    }
    if (chunk.length) chunks.push(chunk);

    for (const reviewsChunk of chunks) {
      const response = await api(
        `/api/browser-agent/jobs/${activeJob.runId}/items/` +
        `${encodeURIComponent(activeJob.currentProduct?.itemId || '')}/reviews`,
        {
          method: 'POST',
          body: JSON.stringify({
            reviews: reviewsChunk,
            summary: {
              rating: activeJob.pendingDetailData?.rating,
              ratingCount: activeJob.pendingDetailData?.ratingCount
            }
          })
        }
      );
      const result = await response.json();
      const acceptedTotal = Number(result?.total);
      activeJob.reviewsCollected = Number.isFinite(acceptedTotal)
        ? acceptedTotal
        : Number(activeJob.reviewsCollected || 0) + reviewsChunk.length;
    }
    for (const review of fresh) {
      const rating = Number(review?.rating);
      if (Number.isFinite(rating) && rating > 0) {
        activeJob.reviewRatingSum = Number(activeJob.reviewRatingSum || 0) + rating;
        activeJob.reviewsWithRating = Number(activeJob.reviewsWithRating || 0) + 1;
      }
    }
  }
  activeJob.reviewSeen = [...seen];
  activeJob.reviewBuffer = [];
  await persistActiveJob();
  return { length: Number(activeJob.reviewsCollected || 0) };
}

function reviewRatingSummary(job = activeJob) {
  const reviewsWithRating = Number(job?.reviewsWithRating || 0);
  const ratingSum = Number(job?.reviewRatingSum || 0);
  return {
    reviewsWithRating,
    reviewsRatingAverage: reviewsWithRating > 0
      ? Number((ratingSum / reviewsWithRating).toFixed(4))
      : null
  };
}

async function storeItems(items) {
  if (!activeJob || activeJob.phase !== 'SEARCH') return 0;
  const seenSet = new Set(activeJob.seen);
  const freshItems = [];
  const itemEnrichments = [];
  activeJob.itemImages = activeJob.itemImages || {};
  for (const [itemIndex, original] of items.entries()) {
    const fallbackPosition = itemIndex + 1;
    const item = {
      ...original,
      itemId: String(original.itemId || ''),
      shopId: String(original.shopId || ''),
      searchKeyword: String(original.searchKeyword || activeJob.keyword || ''),
      searchPage: Number(original.searchPage ?? activeJob.page ?? 0),
      searchPosition: Number(original.searchPosition || fallbackPosition),
      searchRank: Number(
        original.searchRank ||
        Number(original.searchPage ?? activeJob.page ?? 0) * 60 + fallbackPosition
      ),
      observedAt: String(original.observedAt || new Date().toISOString()),
      detailStatus: activeJob.includeDetails ? 'PENDING' : 'SKIPPED'
    };
    const key = String(item.itemId || item.url || item.title);
    const requiresPrice = activeJob.platform !== 'tiktok';
    if (!item.title || (requiresPrice && !item.price)) continue;
    if (seenSet.has(key)) {
      const existingProduct = activeJob.products.find(
        (product) => String(product.itemId || '') === String(item.itemId || '')
      );
      const enrichment = { itemId: item.itemId };
      if (item.itemId && item.image && !activeJob.itemImages[key]) {
        activeJob.itemImages[key] = item.image;
        enrichment.image = item.image;
        if (existingProduct) existingProduct.image = item.image;
      }
      if (
        item.itemId &&
        item.sold !== null &&
        item.sold !== undefined &&
        item.sold !== '' &&
        String(item.sold) !== '0'
      ) {
        enrichment.sold = item.sold;
        if (existingProduct) existingProduct.sold = item.sold;
      }
      if (Object.keys(enrichment).length > 1) {
        itemEnrichments.push(enrichment);
      }
      continue;
    }
    seenSet.add(key);
    activeJob.seen.push(key);
    activeJob.itemImages[key] = String(item.image || '');
    if (activeJob.includeDetails && item.itemId && item.url) {
      activeJob.products.push({
        itemId: item.itemId,
        shopId: item.shopId,
        url: item.url,
        title: item.title,
        image: item.image,
        sourceType: item.sourceType || (activeJob.platform === 'tiktok' ? activeJob.mode : 'product'),
        description: item.description || '',
        sold: item.sold ?? null,
        rating: item.rating ?? null,
        ratingCount: item.ratingCount ?? item.reviewCount ?? null,
        comments: item.comments ?? null
      });
    }
    freshItems.push(item);
    if (activeJob.seen.length >= activeJob.maxItems) break;
  }
  if (freshItems.length) {
    activeJob.consecutiveNoNewPages = 0;
    activeJob.lastNoNewPage = null;
  }
  await persistActiveJob();
  if (freshItems.length) {
    await api(`/api/browser-agent/jobs/${activeJob.runId}/items`, {
      method: 'POST',
      body: JSON.stringify({ items: freshItems })
    });
  }
  if (itemEnrichments.length) {
    await api(`/api/browser-agent/jobs/${activeJob.runId}/items/enrich`, {
      method: 'POST',
      body: JSON.stringify({ items: itemEnrichments })
    });
  }
  return freshItems.length;
}

async function enrichStoredProductFromDetail(product, detail) {
  if (!activeJob || !product?.itemId || !detail) return;
  const image = imageUrl(detail?.image) || imageUrl(detail?.images);
  const sold = normalizeSoldValue(detail?.sold ?? detail?.totalSold);
  const rating = extractNumber(detail?.rating);
  const ratingCount = extractNumber(detail?.ratingCount);
  if (!image && !sold && rating === null && ratingCount === null) return;
  await api(`/api/browser-agent/jobs/${activeJob.runId}/items/enrich`, {
    method: 'POST',
    body: JSON.stringify({
      items: [{
        itemId: product.itemId,
        ...(image ? { image } : {}),
        ...(sold ? { sold } : {}),
        ...(rating === null ? {} : { rating }),
        ...(ratingCount === null ? {} : { ratingCount })
      }]
    })
  }).catch(() => undefined);
}

async function recordPageItems(page, count) {
  if (!activeJob || !count) return;
  const key = String(page);
  activeJob.pageNewItemCounts = activeJob.pageNewItemCounts || {};
  activeJob.pageNewItemCounts[key] =
    Number(activeJob.pageNewItemCounts[key] || 0) + Number(count);
  await persistActiveJob();
}

function shopeeSearchPageFromUrl(value, fallbackPage) {
  try {
    const url = new URL(String(value || ''), 'https://shopee.vn');
    const explicitPageValue = url.searchParams.get('page');
    const explicitPage = Number(explicitPageValue);
    if (
      explicitPageValue !== null &&
      explicitPageValue !== '' &&
      Number.isInteger(explicitPage) &&
      explicitPage >= 0
    ) return explicitPage;
    const newest = Number(url.searchParams.get('newest'));
    const limit = Number(url.searchParams.get('limit'));
    if (
      Number.isFinite(newest) &&
      newest >= 0 &&
      Number.isFinite(limit) &&
      limit > 0
    ) return Math.floor(newest / limit);
  } catch {
    // Fall back to the active page for legacy Shopee response URLs.
  }
  return Number(fallbackPage || 0);
}

async function activateAndScrollTikTok(runId, tabId, page, fallbackUrl) {
  let returnTabId = null;
  try {
    const jobTab = await chrome.tabs.get(tabId);
    const [currentTab] = await chrome.tabs.query({
      active: true,
      windowId: jobTab.windowId
    });
    if (currentTab?.id && currentTab.id !== tabId) {
      returnTabId = currentTab.id;
    }

    await chrome.tabs.update(tabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'TIKTOK_LOAD_MORE',
      page
    });
    if (!result?.ok) {
      throw new Error(result?.error || 'TikTok content script did not complete scrolling.');
    }

    if (activeJob?.runId === runId) {
      await logJob(
        `TikTok auto-scroll page ${page}: results ${result.startCount ?? '?'} -> ` +
        `${result.endCount ?? '?'}, height ${result.startHeight ?? '?'} -> ` +
        `${result.endHeight ?? '?'}, ${result.attempts ?? '?'} attempts.`
      );
    }
  } catch (error) {
    if (activeJob?.runId === runId) {
      await logJob(
        `TikTok auto-scroll failed (${error?.message || String(error)}); reloading the search page.`
      );
      await chrome.tabs.update(tabId, { url: fallbackUrl }).catch((updateError) => {
        void finishJob(
          false,
          updateError?.message || 'Không thể tải thêm kết quả tìm kiếm TikTok.'
        );
      });
    }
  } finally {
    if (returnTabId) {
      await chrome.tabs.update(returnTabId, { active: true }).catch(() => undefined);
    }
    if (activeJob?.runId === runId && activeJob.phase === 'SEARCH') {
      armPageTimeout(searchTimeoutForJob(activeJob));
    }
  }
}

async function scheduleNextPage() {
  if (!activeJob || activeJob.phase !== 'SEARCH' || activeJob.navigationScheduled) return;
  clearPageTimeout();
  activeJob.navigationScheduled = true;
  activeJob.scheduledPage = activeJob.page + 1;
  const runId = activeJob.runId;
  const nextPage = activeJob.scheduledPage;
  const nextUrl = searchUrlForJob(activeJob, nextPage);
  const delay = activeJob.platform === 'shopee'
    ? 1000 + Math.floor(Math.random() * 1000)
    : 1200 + Math.floor(Math.random() * 500);
  await persistActiveJob();
  await logJob(
    `Waiting ${(delay / 1000).toFixed(1)} seconds before loading ` +
    `${platformLabel(activeJob)} page ${nextPage}.`
  );
  setTimeout(() => {
    if (!activeJob || activeJob.runId !== runId || activeJob.phase !== 'SEARCH') return;
    activeJob.navigationScheduled = false;
    activeJob.page = nextPage;
    activeJob.scheduledPage = null;
    void persistActiveJob();
    if (activeJob.platform === 'tiktok') {
      void activateAndScrollTikTok(runId, activeJob.tabId, nextPage, nextUrl);
      return;
    }
    armPageTimeout(searchTimeoutForJob(activeJob));
    chrome.tabs.update(activeJob.tabId, { url: nextUrl }).catch((error) => {
      void finishJob(false, error?.message || 'Không thể mở trang tìm kiếm Shopee.');
    });
  }, delay);
}

async function retryCurrentShopeePage(page, itemCount) {
  if (
    !activeJob ||
    activeJob.platform !== 'shopee' ||
    activeJob.phase !== 'SEARCH' ||
    activeJob.navigationScheduled
  ) return false;
  const key = String(page);
  const retries = Number(activeJob.pageRetryCounts?.[key] || 0);
  if (retries >= MAX_SHOPEE_PAGE_RETRIES) return false;

  clearPageTimeout();
  activeJob.pageRetryCounts = activeJob.pageRetryCounts || {};
  activeJob.pageRetryCounts[key] = retries + 1;
  activeJob.navigationScheduled = true;
  const runId = activeJob.runId;
  const delay = 1000;
  await persistActiveJob();
  await logJob(
    `Shopee page ${page} returned only ${itemCount} products; ` +
    `retrying the same page (${retries + 1}/${MAX_SHOPEE_PAGE_RETRIES}).`
  );
  setTimeout(() => {
    if (
      !activeJob ||
      activeJob.runId !== runId ||
      activeJob.phase !== 'SEARCH' ||
      activeJob.page !== page
    ) return;
    activeJob.navigationScheduled = false;
    void persistActiveJob();
    armPageTimeout(searchTimeoutForJob(activeJob));
    chrome.tabs.update(activeJob.tabId, {
      url: searchUrlForJob(activeJob, page)
    }).catch((error) => {
      void finishJob(false, error?.message || 'Không thể tải lại trang tìm kiếm Shopee.');
    });
  }, delay);
  return true;
}

async function continueAfterNoNewSearchData(message) {
  if (!activeJob || activeJob.phase !== 'SEARCH' || activeJob.navigationScheduled) return;

  if (activeJob.lastNoNewPage !== activeJob.page) {
    activeJob.lastNoNewPage = activeJob.page;
    activeJob.consecutiveNoNewPages = Number(activeJob.consecutiveNoNewPages || 0) + 1;
    await persistActiveJob();
  }

  if (activeJob.consecutiveNoNewPages >= 3) {
    await logJob(
      `No new items on ${activeJob.consecutiveNoNewPages} consecutive ` +
      `${platformLabel(activeJob)} pages. Continuing with ` +
      `${activeJob.seen.length} collected items.`
    );
    await beginDetailPhase();
    return;
  }

  await logJob(message);
  await scheduleNextPage();
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
  clearTimeout(searchImageReadyTimer);
  searchImageReadyTimer = null;
  chrome.alarms.clear(SHOPEE_IMAGE_READY_ALARM).catch(() => undefined);
  for (const timer of detailWorkerTimers.values()) clearTimeout(timer);
  detailWorkerTimers.clear();
  for (const worker of job.detailWorkers || []) {
    chrome.alarms.clear(
      `${DETAIL_DEADLINE_ALARM_PREFIX}${worker.tabId}`
    ).catch(() => undefined);
    chrome.alarms.clear(
      `${DETAIL_READY_ALARM_PREFIX}${worker.tabId}`
    ).catch(() => undefined);
  }
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
    const crawlerWindowIds = new Set(
      [job.windowId, ...(job.detailWorkers || []).map((worker) => worker.windowId)]
        .filter((windowId) => windowId !== null && windowId !== undefined)
        .map(Number)
        .filter((windowId) => Number.isInteger(windowId) && windowId > 0)
    );
    if (crawlerWindowIds.size) {
      await Promise.all(
        [...crawlerWindowIds].map((windowId) => (
          chrome.windows.remove(windowId).catch(() => undefined)
        ))
      );
    } else if (job.tabId) {
      chrome.tabs.remove(job.tabId).catch(() => undefined);
    }
    schedulePoll(1000);
  }
}

function shopeeDetailWorker(tabId) {
  if (!activeJob || activeJob.platform !== 'shopee') return null;
  return activeJob.detailWorkers?.find((worker) => worker.tabId === tabId) || null;
}

function emptyDetailWorker(tabId, slot, windowId = null) {
  return {
    tabId,
    slot,
    windowId,
    productIndex: null,
    currentProduct: null,
    detailHandledFor: null,
    pendingDetailData: null,
    sparseDetailData: null,
    sparseRechecks: 0,
    readyProbeCount: 0,
    readyReloads: 0,
    reviewRequestedFor: null,
    reviewsApiError: '',
    reviewSeen: [],
    reviewsCollected: 0,
    reviewRatingSum: 0,
    reviewsWithRating: 0,
    reviewApiPending: false,
    reviewDomFinal: false,
    reviewDomRetryRounds: 0,
    reviewPageReloads: 0,
    waitingForReview: false,
    deadline: null,
    busy: false
  };
}

async function createShopeeAgentWindow(slot) {
  const crawlerWindow = await chrome.windows.create({
    url: 'about:blank',
    type: 'normal',
    focused: false,
    width: 1100,
    height: 820,
    left: 40 + Number(slot || 0) * 24,
    top: 40 + Number(slot || 0) * 24
  });
  const tab = crawlerWindow.tabs?.[0];
  if (!crawlerWindow.id || !tab?.id) {
    throw new Error(`Không thể tạo cửa sổ cho Shopee agent ${Number(slot || 0) + 1}.`);
  }
  return { tabId: tab.id, windowId: crawlerWindow.id };
}

async function restartShopeeAgentWindow(worker, reason) {
  if (!activeJob || !worker?.currentProduct) return;
  const product = worker.currentProduct;
  const productIndex = worker.productIndex;
  const replacement = await createShopeeAgentWindow(worker.slot);
  Object.assign(
    worker,
    emptyDetailWorker(replacement.tabId, worker.slot, replacement.windowId),
    {
      productIndex,
      currentProduct: product,
      busy: true
    }
  );
  if (Number(worker.slot || 0) === 0) {
    activeJob.tabId = replacement.tabId;
    activeJob.windowId = replacement.windowId;
  }
  await persistActiveJob();
  await logJob(
    `Shopee agent ${worker.slot + 1} recreated its browser window` +
    `${reason ? ` after ${reason}` : ''}; resuming the same product.`
  );
  await chrome.tabs.update(worker.tabId, { url: product.url, active: true });
  armDetailWorkerDeadline(worker);
  scheduleShopeeWorkerReadyProbe(worker);
}

function clearDetailWorkerTimer(worker) {
  const timer = detailWorkerTimers.get(worker.tabId);
  if (timer) clearTimeout(timer);
  detailWorkerTimers.delete(worker.tabId);
  chrome.alarms.clear(
    `${DETAIL_DEADLINE_ALARM_PREFIX}${worker.tabId}`
  ).catch(() => undefined);
  chrome.alarms.clear(
    `${DETAIL_READY_ALARM_PREFIX}${worker.tabId}`
  ).catch(() => undefined);
  worker.deadline = null;
}

function armDetailWorkerDeadline(worker, timeoutMs = DETAIL_TIMEOUT_MS) {
  clearDetailWorkerTimer(worker);
  const runId = activeJob?.runId;
  const itemId = String(worker.currentProduct?.itemId || '');
  worker.deadline = Date.now() + timeoutMs;
  chrome.alarms.create(
    `${DETAIL_DEADLINE_ALARM_PREFIX}${worker.tabId}`,
    { when: worker.deadline }
  );
  void persistActiveJob();
  const timer = setTimeout(() => {
    if (
      !activeJob ||
      activeJob.runId !== runId ||
      String(worker.currentProduct?.itemId || '') !== itemId
    ) return;
    enqueueDetailMessage(
      () => failShopeeDetailWorker(worker, 'Không nhận đủ dữ liệu chi tiết sau 90 giây.'),
      'Không thể xử lý thời hạn chi tiết Shopee.'
    );
  }, timeoutMs);
  detailWorkerTimers.set(worker.tabId, timer);
}

function scheduleShopeeWorkerReadyProbe(worker, delayMs = SPARSE_DETAIL_RECHECK_MS) {
  if (!worker?.busy || worker.reviewRequestedFor || worker.waitingForReview) return;
  chrome.alarms.create(
    `${DETAIL_READY_ALARM_PREFIX}${worker.tabId}`,
    { when: Date.now() + Math.max(100, delayMs) }
  );
}

async function probeShopeeWorkerDetail(worker) {
  if (
    !activeJob ||
    activeJob.phase !== 'DETAIL' ||
    !worker?.busy ||
    !worker.currentProduct ||
    worker.reviewRequestedFor ||
    worker.waitingForReview
  ) return;
  const itemId = String(worker.currentProduct.itemId);
  worker.readyProbeCount = Number(worker.readyProbeCount || 0) + 1;
  await persistActiveJob();
  try {
    const response = await chrome.tabs.sendMessage(worker.tabId, {
      type: 'REQUEST_SHOPEE_DETAIL_RECHECK',
      itemId
    });
    if (response?.detail) {
      await processShopeeWorkerDomDetail(response.detail, {
        tab: { id: worker.tabId }
      });
      return;
    }
  } catch {
    // The content script may not be attached until the navigation completes.
  }
  if (
    activeJob &&
    worker.busy &&
    !worker.reviewRequestedFor &&
    !worker.waitingForReview &&
    worker.readyProbeCount < MAX_DETAIL_READY_PROBES
  ) {
    if (worker.readyProbeCount === 3) {
      await logJob(
        `Shopee detail worker ${worker.slot + 1} has not received rendered data; ` +
        'continuing readiness checks.'
      );
    }
    scheduleShopeeWorkerReadyProbe(worker);
    return;
  }
  if (
    activeJob &&
    worker.busy &&
    !worker.reviewRequestedFor &&
    worker.readyReloads < 1
  ) {
    worker.readyReloads += 1;
    worker.readyProbeCount = 0;
    await persistActiveJob();
    await logJob(
      `Shopee detail worker ${worker.slot + 1} received no detail signal; ` +
      'reloading its product tab once.'
    );
    await chrome.tabs.reload(worker.tabId, { bypassCache: true });
    scheduleShopeeWorkerReadyProbe(worker);
    return;
  }
  if (activeJob && worker.busy && !worker.reviewRequestedFor) {
    await failShopeeDetailWorker(
      worker,
      'Trang sản phẩm đã tải lại nhưng không cung cấp dữ liệu chi tiết.'
    );
  }
}

function detailFieldScore(detail) {
  if (!detail) return 0;
  return [
    Boolean(detail.title),
    Boolean(detail.description),
    Array.isArray(detail.images) && detail.images.length > 0,
    Array.isArray(detail.models) && detail.models.length > 0,
    Array.isArray(detail.variations) && detail.variations.length > 0,
    detail.price !== null && detail.price !== undefined && detail.price !== '',
    detail.rating !== null && detail.rating !== undefined,
    detail.ratingCount !== null && detail.ratingCount !== undefined,
    Boolean(detail.shopName || detail.shopId),
    Array.isArray(detail.attributes) && detail.attributes.length > 0
  ].filter(Boolean).length;
}

function richerDetailValue(current, incoming) {
  if (incoming === null || incoming === undefined || incoming === '') return current;
  if (current === null || current === undefined || current === '') return incoming;
  if (Array.isArray(incoming)) {
    return incoming.length > (Array.isArray(current) ? current.length : 0)
      ? incoming
      : current;
  }
  if (typeof incoming === 'number' && typeof current === 'number') {
    if (incoming === 0 && current !== 0) return current;
    if (current === 0 && incoming !== 0) return incoming;
  }
  if (typeof incoming === 'string' && typeof current === 'string') {
    return incoming.length > current.length ? incoming : current;
  }
  return incoming;
}

function mergeDetailData(current, incoming) {
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    merged[key] = richerDetailValue(merged[key], value);
  }
  return merged;
}

async function assignNextShopeeProduct(worker) {
  if (!activeJob || activeJob.phase !== 'DETAIL' || activeJob.platform !== 'shopee') return;
  clearDetailWorkerTimer(worker);
  activeJob.detailAssignments = activeJob.detailAssignments || {};
  let productIndex = Number(activeJob.detailNextIndex || 0);
  while (productIndex < activeJob.products.length) {
    const candidate = activeJob.products[productIndex];
    const assignment = activeJob.detailAssignments[String(candidate.itemId)];
    if (!assignment || assignment.status === 'PENDING') break;
    productIndex += 1;
  }
  activeJob.detailNextIndex = productIndex;
  if (productIndex >= activeJob.products.length) {
    worker.busy = false;
    worker.currentProduct = null;
    worker.productIndex = null;
    await persistActiveJob();
    const allIdle = activeJob.detailWorkers.every((candidate) => !candidate.busy);
    if (allIdle) await finishJob(true);
    return;
  }

  const product = activeJob.products[productIndex];
  activeJob.detailNextIndex = productIndex + 1;
  activeJob.detailIndex = activeJob.detailNextIndex;
  activeJob.detailAssignments[String(product.itemId)] = {
    status: 'CLAIMED',
    workerSlot: worker.slot,
    productIndex,
    claimedAt: Date.now()
  };
  Object.assign(
    worker,
    emptyDetailWorker(worker.tabId, worker.slot, worker.windowId),
    {
      productIndex,
      currentProduct: product,
      busy: true
    }
  );
  await persistActiveJob();
  await logJob(
    `Shopee agent ${worker.slot + 1}/${activeJob.detailWorkers.length} claimed ` +
    `product ${productIndex + 1}/${activeJob.products.length}.`
  );
  try {
    await chrome.tabs.update(worker.tabId, { url: product.url, active: true });
    armDetailWorkerDeadline(worker);
    scheduleShopeeWorkerReadyProbe(worker);
  } catch (error) {
    await failShopeeDetailWorker(
      worker,
      error?.message || 'Không thể mở trang sản phẩm Shopee.'
    );
  }
}

async function patchShopeeDetailWorker(worker, detail) {
  if (!activeJob || !worker.currentProduct) return;
  worker.waitingForReview = false;
  const itemId = String(worker.currentProduct.itemId);
  const failed = detail.detailStatus === 'FAILED';
  const projected = {
    completed: activeJob.detailCompleted + (failed ? 0 : 1),
    failed: activeJob.detailFailed + (failed ? 1 : 0),
    total: activeJob.products.length
  };
  await api(
    `/api/browser-agent/jobs/${activeJob.runId}/items/` +
    `${encodeURIComponent(worker.currentProduct.itemId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ detail, progress: projected })
    }
  );
  activeJob.detailAssignments[itemId] = {
    ...(activeJob.detailAssignments[itemId] || {}),
    status: failed ? 'FAILED' : 'COMPLETED',
    workerSlot: worker.slot,
    productIndex: worker.productIndex,
    completedAt: Date.now()
  };
  activeJob.detailCompleted = projected.completed;
  activeJob.detailFailed = projected.failed;
  await assignNextShopeeProduct(worker);
}

async function completeShopeeDetailWorker(worker, detail) {
  if (!activeJob || !worker.currentProduct || !worker.busy) return;
  const key = String(worker.currentProduct.itemId);
  if (worker.detailHandledFor === key) return;
  worker.detailHandledFor = key;
  clearDetailWorkerTimer(worker);
  await persistActiveJob();
  await patchShopeeDetailWorker(worker, { ...detail, detailStatus: 'COMPLETED' });
}

async function failShopeeDetailWorker(worker, error) {
  if (!activeJob || !worker.currentProduct || !worker.busy) return;
  const key = String(worker.currentProduct.itemId);
  if (worker.detailHandledFor === key) return;
  worker.detailHandledFor = key;
  clearDetailWorkerTimer(worker);
  await persistActiveJob();
  await patchShopeeDetailWorker(worker, {
    detailStatus: 'FAILED',
    detailError: String(error || 'Không lấy được chi tiết sản phẩm.')
  });
}

async function mergeShopeeWorkerReviews(worker, reviews) {
  if (!activeJob || !worker.currentProduct || !Array.isArray(reviews)) {
    return { length: 0 };
  }
  const seen = new Set(worker.reviewSeen || []);
  const fresh = [];
  for (const review of reviews) {
    const key = String(
      review?.reviewId ||
      `${review?.author || ''}:${review?.createdAt || ''}:${review?.comment || ''}`
    );
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(review);
    if (Number(worker.reviewsCollected || 0) + fresh.length >= maxReviewsForJob()) break;
  }
  for (let offset = 0; offset < fresh.length; offset += 50) {
    const reviewsChunk = fresh.slice(offset, offset + 50);
    const response = await api(
      `/api/browser-agent/jobs/${activeJob.runId}/items/` +
      `${encodeURIComponent(worker.currentProduct.itemId)}/reviews`,
      {
        method: 'POST',
        body: JSON.stringify({
          reviews: reviewsChunk,
          summary: {
            rating: worker.pendingDetailData?.rating,
            ratingCount: worker.pendingDetailData?.ratingCount
          }
        })
      }
    );
    const result = await response.json();
    const acceptedTotal = Number(result?.total);
    worker.reviewsCollected = Number.isFinite(acceptedTotal)
      ? acceptedTotal
      : Number(worker.reviewsCollected || 0) + reviewsChunk.length;
  }
  for (const review of fresh) {
    const rating = Number(review?.rating);
    if (Number.isFinite(rating) && rating > 0) {
      worker.reviewRatingSum += rating;
      worker.reviewsWithRating += 1;
    }
  }
  worker.reviewSeen = [...seen];
  await persistActiveJob();
  return { length: Number(worker.reviewsCollected || 0) };
}

async function requestShopeeWorkerReviews(worker, detail) {
  if (!activeJob || !worker.currentProduct || !worker.busy) return;
  const key = String(worker.currentProduct.itemId);
  if (worker.reviewRequestedFor === key) return;
  await enrichStoredProductFromDetail(worker.currentProduct, detail);
  worker.pendingDetailData = mergeDetailData(worker.pendingDetailData, detail);
  activeJob.reviewOwnerTabId = null;
  worker.waitingForReview = false;
  armDetailWorkerDeadline(worker);
  worker.reviewRequestedFor = key;
  worker.reviewApiPending = true;
  worker.reviewDomFinal = false;
  worker.reviewDomRetryRounds = 0;
  await persistActiveJob();
  const limit = maxReviewsForJob();
  if (limit === 0) {
    await completeShopeeDetailWorker(worker, {
      ...detail,
      reviewsCollected: 0,
      reviewsStatus: 'SKIPPED',
      reviewsError: ''
    });
    return;
  }
  let response;
  try {
    await new Promise((resolve) => {
      setTimeout(resolve, 250 + Number(worker.slot || 0) * 350);
    });
    response = await chrome.tabs.sendMessage(worker.tabId, {
      type: 'REQUEST_SHOPEE_REVIEWS',
      itemId: worker.currentProduct.itemId,
      shopId: worker.currentProduct.shopId,
      limit
    });
    if (response?.ok === false) {
      throw new Error(response.error || 'Không thể đọc vùng đánh giá trên trang.');
    }
  } catch (error) {
    await completeShopeeDetailWorker(worker, {
      ...detail,
      reviewsCollected: 0,
      reviewsStatus: 'FAILED',
      reviewsError: error?.message || 'Không thể yêu cầu dữ liệu đánh giá Shopee.'
    });
    return;
  }
  if (
    Number(response?.renderedCount ?? 0) === 0 &&
    Number(detail.ratingCount) === 0
  ) {
    await completeShopeeDetailWorker(worker, {
      ...detail,
      reviewsCollected: 0,
      reviewsStatus: 'COMPLETED',
      reviewsError: ''
    });
  }
}

async function acceptOrRecheckShopeeDetail(worker, detail) {
  if (!activeJob || !worker.currentProduct || !worker.busy) return;
  worker.sparseDetailData = mergeDetailData(worker.sparseDetailData, detail);
  const score = detailFieldScore(worker.sparseDetailData);
  if (score >= 5 || worker.sparseRechecks >= 1) {
    await requestShopeeWorkerReviews(worker, {
      ...worker.sparseDetailData,
      itemId: String(worker.currentProduct.itemId),
      detailStatus: 'COMPLETED'
    });
    return;
  }
  worker.sparseRechecks += 1;
  const runId = activeJob.runId;
  const itemId = String(worker.currentProduct.itemId);
  await persistActiveJob();
  await logJob(
    `Shopee product ${worker.productIndex + 1} has sparse detail data; ` +
    'checking the rendered page again in 1 second.'
  );
  setTimeout(() => {
    if (
      !activeJob ||
      activeJob.runId !== runId ||
      String(worker.currentProduct?.itemId || '') !== itemId ||
      worker.reviewRequestedFor
    ) return;
    chrome.tabs.sendMessage(worker.tabId, {
      type: 'REQUEST_SHOPEE_DETAIL_RECHECK',
      itemId
    }).then((response) => {
      if (!response?.detail) {
        enqueueDetailMessage(
          () => acceptOrRecheckShopeeDetail(worker, worker.sparseDetailData),
          'Không thể xác nhận dữ liệu chi tiết Shopee.'
        );
      }
    }).catch(() => {
      enqueueDetailMessage(
        () => acceptOrRecheckShopeeDetail(worker, worker.sparseDetailData),
        'Không thể xác nhận dữ liệu chi tiết Shopee.'
      );
    });
  }, SPARSE_DETAIL_RECHECK_MS);
}

async function beginShopeeDetailWorkers() {
  const requested = Math.min(
    MAX_DETAIL_CONCURRENCY,
    Math.max(1, Math.floor(Number(activeJob.detailConcurrency || 1))),
    activeJob.products.length
  );
  activeJob.detailNextIndex = 0;
  activeJob.detailAssignments = {};
  activeJob.reviewOwnerTabId = null;
  activeJob.detailWorkers = [
    emptyDetailWorker(activeJob.tabId, 0, activeJob.windowId)
  ];
  for (let slot = 1; slot < requested; slot += 1) {
    const crawlerWindow = await createShopeeAgentWindow(slot);
    activeJob.detailWorkers.push(
      emptyDetailWorker(crawlerWindow.tabId, slot, crawlerWindow.windowId)
    );
  }
  await persistActiveJob();
  await logJob(
    `Starting distributed Shopee detail crawl with ` +
    `${activeJob.detailWorkers.length} independent browser windows for ` +
    `${activeJob.products.length} products.`
  );
  for (const worker of activeJob.detailWorkers) {
    await assignNextShopeeProduct(worker);
  }
}

function shopeeImageCoverage(job = activeJob) {
  if (!job) return { total: 0, withImage: 0 };
  const total = Math.min(
    Number(job.maxItems || 0),
    Array.isArray(job.seen) ? job.seen.length : 0
  );
  const withImage = (job.seen || [])
    .slice(0, total)
    .filter((key) => Boolean(String(job.itemImages?.[key] || '').trim()))
    .length;
  return { total, withImage };
}

async function maybeBeginDetailAfterShopeeImages() {
  if (
    !activeJob ||
    activeJob.phase !== 'SEARCH' ||
    activeJob.seen.length < activeJob.maxItems
  ) return false;

  if (activeJob.platform !== 'shopee') {
    await beginDetailPhase();
    return true;
  }

  clearPageTimeout();
  const { total, withImage } = shopeeImageCoverage();
  const rounds = Number(activeJob.searchImageReadyRounds || 0);
  if (total > 0 && withImage >= total) {
    activeJob.searchImageReadyScheduled = false;
    await chrome.alarms.clear(SHOPEE_IMAGE_READY_ALARM).catch(() => undefined);
    await logJob(`Shopee product images are ready for ${withImage}/${total} items.`);
    await beginDetailPhase();
    return true;
  }

  if (rounds >= MAX_SHOPEE_IMAGE_READY_ROUNDS) {
    activeJob.searchImageReadyScheduled = false;
    await chrome.alarms.clear(SHOPEE_IMAGE_READY_ALARM).catch(() => undefined);
    await logJob(
      `Shopee product image coverage stopped at ${withImage}/${total} after ` +
      `${MAX_SHOPEE_IMAGE_READY_ROUNDS} readiness checks; continuing detail crawl.`
    );
    await beginDetailPhase();
    return true;
  }

  if (!activeJob.searchImageReadyScheduled) {
    activeJob.searchImageReadyRounds = rounds + 1;
    activeJob.searchImageReadyScheduled = true;
    await persistActiveJob();
    if (rounds === 0 || rounds === 4) {
      await logJob(
        `Shopee product images are ${withImage}/${total}; waiting for rendered cards ` +
        `(${rounds + 1}/${MAX_SHOPEE_IMAGE_READY_ROUNDS}).`
      );
    }
    chrome.tabs.sendMessage(activeJob.tabId, {
      type: 'REQUEST_SHOPEE_SEARCH_RESCAN',
      round: rounds
    }).catch(() => undefined);
    chrome.alarms.create(SHOPEE_IMAGE_READY_ALARM, {
      when: Date.now() + 1000
    });
    clearTimeout(searchImageReadyTimer);
    searchImageReadyTimer = setTimeout(() => {
      searchImageReadyTimer = null;
      chrome.alarms.clear(SHOPEE_IMAGE_READY_ALARM).catch(() => undefined);
      if (activeJob) activeJob.searchImageReadyScheduled = false;
      enqueueSearchMessage(
        () => maybeBeginDetailAfterShopeeImages(),
        'Không thể kiểm tra độ phủ ảnh sản phẩm Shopee.'
      );
    }, 1000);
  }
  return true;
}

async function beginDetailPhase() {
  if (!activeJob || activeJob.phase === 'DETAIL') return;
  if (!activeJob.includeDetails || !activeJob.products.length) {
    await finishJob(true);
    return;
  }
  clearPageTimeout();
  clearTimeout(searchImageReadyTimer);
  searchImageReadyTimer = null;
  await chrome.alarms.clear(SHOPEE_IMAGE_READY_ALARM).catch(() => undefined);
  activeJob.phase = 'DETAIL';
  activeJob.navigationScheduled = false;
  activeJob.searchImageReadyScheduled = false;
  activeJob.detailIndex = 0;
  activeJob.detailCompleted = 0;
  activeJob.detailFailed = 0;
  activeJob.currentProduct = null;
  activeJob.detailHandledFor = null;
  activeJob.pendingDetailData = null;
  activeJob.reviewRequestedFor = null;
  activeJob.reviewsApiError = '';
  activeJob.reviewBuffer = [];
  activeJob.reviewSeen = [];
  activeJob.reviewsCollected = 0;
  activeJob.reviewRatingSum = 0;
  activeJob.reviewsWithRating = 0;
  activeJob.reviewApiPending = false;
  activeJob.reviewDomFinal = false;
  activeJob.reviewDomRetryRounds = 0;
  activeJob.reviewPageReloads = 0;
  await persistActiveJob();
  if (
    activeJob.platform === 'shopee' &&
    Number(activeJob.detailConcurrency || 1) > 1
  ) {
    await beginShopeeDetailWorkers();
    return;
  }
  await logJob(
    `Starting ${platformLabel(activeJob)} detail and review crawl for ` +
    `${activeJob.products.length} items.`
  );
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
  activeJob.reviewsApiError = '';
  activeJob.reviewBuffer = [];
  activeJob.reviewSeen = [];
  activeJob.reviewsCollected = 0;
  activeJob.reviewRatingSum = 0;
  activeJob.reviewsWithRating = 0;
  activeJob.reviewApiPending = false;
  activeJob.reviewDomFinal = false;
  activeJob.reviewDomRetryRounds = 0;
  activeJob.reviewPageReloads = 0;
  activeJob.navigationScheduled = true;
  const runId = activeJob.runId;
  const productIndex = activeJob.detailIndex;
  const delay = 400 + Math.floor(Math.random() * 400);
  await persistActiveJob();
  await logJob(
    `Waiting ${(delay / 1000).toFixed(1)} seconds before ${platformLabel(activeJob)} detail ` +
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
  activeJob.reviewsApiError = '';
  activeJob.reviewBuffer = [];
  activeJob.reviewSeen = [];
  activeJob.reviewsCollected = 0;
  activeJob.reviewRatingSum = 0;
  activeJob.reviewsWithRating = 0;
  activeJob.reviewApiPending = false;
  activeJob.reviewDomFinal = false;
  activeJob.reviewDomRetryRounds = 0;
  activeJob.reviewPageReloads = 0;
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
  await enrichStoredProductFromDetail(activeJob.currentProduct, detail);
  activeJob.pendingDetailData = mergeDetailData(activeJob.pendingDetailData, detail);
  activeJob.reviewRequestedFor = key;
  activeJob.reviewApiPending = activeJob.platform === 'shopee';
  activeJob.reviewDomFinal = false;
  activeJob.reviewDomRetryRounds = 0;
  await persistActiveJob();

  const limit = maxReviewsForJob(activeJob);
  if (limit === 0) {
    await completeCurrentDetail({
      ...detail,
      reviewsCollected: 0,
      reviewsStatus: 'SKIPPED',
      reviewsError: ''
    });
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeJob.tabId, {
      type: activeJob.platform === 'tiktok'
        ? 'REQUEST_TIKTOK_REVIEWS'
        : 'REQUEST_SHOPEE_REVIEWS',
      itemId: activeJob.currentProduct.itemId,
      shopId: activeJob.currentProduct.shopId,
      limit,
      sourceType: activeJob.currentProduct.sourceType
    });
    if (
      response?.ok === false &&
      activeJob?.phase === 'DETAIL' &&
      String(activeJob.currentProduct?.itemId || '') === key
    ) {
      throw new Error(response.error || 'Không thể đọc vùng đánh giá trên trang.');
    }
    const renderedCount = Number(response?.renderedCount ?? response?.count ?? 0);
    const expectedCount = activeJob?.platform === 'tiktok'
      ? activeJob.currentProduct?.comments ?? activeJob.currentProduct?.ratingCount
      : detail.ratingCount;
    if (
      renderedCount === 0 &&
      expectedCount === 0 &&
      activeJob?.phase === 'DETAIL' &&
      String(activeJob.currentProduct?.itemId || '') === key
    ) {
      await completeCurrentDetail({
        ...detail,
        reviewsCollected: 0,
        reviewsStatus: 'COMPLETED',
        reviewsError: ''
      });
    }
  } catch (error) {
    if (
      !activeJob ||
      activeJob.phase !== 'DETAIL' ||
      String(activeJob.currentProduct?.itemId || '') !== key
    ) return;
    await completeCurrentDetail({
      ...detail,
      reviewsCollected: 0,
      reviewsStatus: 'FAILED',
      reviewsError: error?.message ||
        `Không thể yêu cầu dữ liệu đánh giá từ tab ${platformLabel(activeJob)}.`
    });
  }
}

async function processSearchResponse(detail, sender) {
  if (
    !activeJob ||
    activeJob.phase !== 'SEARCH' ||
    sender.tab?.id !== activeJob.tabId
  ) return;
  const responsePage = shopeeSearchPageFromUrl(detail?.url, activeJob.page);
  if (responsePage !== activeJob.page) return;
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

  const mappedItems = rawItems.map((entry, index) => mapItem(entry, {
    keyword: activeJob.keyword,
    page: responsePage,
    position: index + 1
  }));
  const storedCount = await storeItems(mappedItems);
  await recordPageItems(responsePage, storedCount);

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

  if (await maybeBeginDetailAfterShopeeImages()) return;

  const pageNewCount = Number(
    activeJob.pageNewItemCounts?.[String(responsePage)] || 0
  );
  if (pageNewCount >= FAST_SHOPEE_PAGE_ITEMS) {
    await logJob(
      `Shopee page ${responsePage} already yielded ${pageNewCount} products; ` +
      'loading the next page immediately.'
    );
    await scheduleNextPage();
    return;
  }

  if (!rawItems.length || !storedCount) {
    if (activeJob.seen.length > 0) {
      await logJob(
        'No new API-mapped products; waiting for rendered cards before changing pages.'
      );
    }
    return;
  }

  await logJob(
    `Captured ${storedCount} products from the Shopee API on page ${responsePage}; ` +
    'waiting for the rendered-page scan to finish.'
  );
}

async function processTikTokSearchResponse(detail, sender) {
  if (
    !activeJob ||
    activeJob.platform !== 'tiktok' ||
    activeJob.phase !== 'SEARCH' ||
    sender.tab?.id !== activeJob.tabId
  ) return;

  const payload = detail?.payload;
  if (
    detail?.status === 401 ||
    detail?.status === 403 ||
    payload?.status_code === 10216 ||
    payload?.statusCode === 10216
  ) {
    await finishJob(false, 'TikTok yêu cầu đăng nhập lại trong Chrome.');
    return;
  }

  const expectedKind = activeJob.mode === 'products' ? 'product-search' : 'video-search';
  if (detail?.kind !== expectedKind) return;
  const mappedItems = collectTikTokItems(payload, detail.kind, {
    keyword: activeJob.keyword,
    page: activeJob.page
  }).slice(0, activeJob.maxItems);

  if (!mappedItems.length) {
    activeJob.unexpectedResponses = Number(activeJob.unexpectedResponses || 0) + 1;
    await persistActiveJob();
    if (activeJob.unexpectedResponses <= 3) {
      const payloadKeys = payload && typeof payload === 'object'
        ? Object.keys(payload).slice(0, 20).join(',')
        : typeof payload;
      await logJob(
        `TikTok ${detail.kind} response contained no mappable items: ` +
        `HTTP ${String(detail?.status)}, keys=${payloadKeys || 'none'}. ` +
        'Waiting for rendered cards.'
      );
    }
    return;
  }

  const storedCount = await storeItems(mappedItems);
  if (await maybeBeginDetailAfterShopeeImages()) return;
  if (!storedCount) {
    if (activeJob.seen.length > 0) {
      await continueAfterNoNewSearchData(
        'TikTok returned no new items; loading more rendered results.'
      );
    }
    return;
  }
  await logJob(`Captured ${storedCount} items from TikTok ${activeJob.mode} response.`);
  await scheduleNextPage();
}

async function processShopeeWorkerDetailResponse(detail, sender) {
  const worker = shopeeDetailWorker(sender.tab?.id);
  if (
    !worker ||
    !worker.currentProduct ||
    !worker.busy ||
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
  if (detail?.status >= 400 || (payload?.error && payload.error !== 0)) return;
  const mapped = mapDetailPayload(payload, worker.currentProduct);
  if (!mapped) return;
  if (
    mapped.itemId &&
    String(mapped.itemId) !== String(worker.currentProduct.itemId)
  ) return;
  armDetailWorkerDeadline(worker);
  await acceptOrRecheckShopeeDetail(worker, mapped);
}

async function processShopeeWorkerReviewsResponse(detail, sender) {
  const worker = shopeeDetailWorker(sender.tab?.id);
  if (
    !worker ||
    !worker.currentProduct ||
    !worker.pendingDetailData ||
    detail?.kind !== 'reviews'
  ) return;
  const payload = detail?.payload;
  let responseItemId = String(payload?.omnicrawlItemId || '');
  if (!responseItemId) {
    try {
      responseItemId = String(
        new URL(String(detail?.url || ''), 'https://shopee.vn')
          .searchParams.get('itemid') || ''
      );
    } catch {
      responseItemId = '';
    }
  }
  if (
    responseItemId &&
    responseItemId !== String(worker.currentProduct.itemId)
  ) return;

  const isFinal = Boolean(payload?.omnicrawlFinal);
  if (!isFinal) armDetailWorkerDeadline(worker);
  if (isFinal) worker.reviewApiPending = false;
  const error = String(payload?.error || '');
  if (isFinal && error) worker.reviewsApiError = error;
  const buffered = await mergeShopeeWorkerReviews(worker, mapReviewsPayload(payload));
  if (isFinal) {
    const apiCollected = Number(payload?.omnicrawlCollected || buffered.length || 0);
    if (error && apiCollected === 0) {
      activeJob.reviewApiFailureStreak =
        Number(activeJob.reviewApiFailureStreak || 0) + 1;
      if (
        Number(activeJob.detailConcurrency || 1) > 1 &&
        activeJob.reviewApiFailureStreak >= 2 &&
        !activeJob.reviewApiDegraded
      ) {
        activeJob.reviewApiDegraded = true;
        await logJob(
          'Shopee review API failed on consecutive products; independent agents ' +
          'will continue with rendered-review fallback without waiting for each other.'
        );
      }
    } else if (apiCollected > 0 && !error) {
      activeJob.reviewApiFailureStreak = 0;
    }
    await logJob(
      `Shopee review API collected ${apiCollected}/${maxReviewsForJob()} ` +
      `for item ${worker.productIndex + 1}/${activeJob.products.length}` +
      `${error ? `; ${error}` : '.'}`
    );
  }

  const ratingSummary = payload?.itemRatingSummary ?? payload?.data?.item_rating_summary;
  const totalValue = Number(
    payload?.total ?? payload?.data?.item_rating_summary?.rating_total
  );
  const total = Number.isFinite(totalValue) && totalValue >= 0 ? totalValue : null;
  if (ratingSummary && typeof ratingSummary === 'object') {
    const average = extractNumber(
      ratingSummary.rating_star ??
      ratingSummary.rating_average ??
      ratingSummary.average
    );
    const counts = ratingSummary.rating_count;
    worker.pendingDetailData = {
      ...worker.pendingDetailData,
      ...(total === null ? {} : { ratingCount: total }),
      ...(average === null ? {} : { rating: average }),
      ...(Array.isArray(counts) ? {
        ratingBreakdown: counts.map((count, index) => ({
          star: index === 0 ? 'all' : index,
          count: extractNumber(count)
        }))
      } : {})
    };
  } else if (total !== null) {
    worker.pendingDetailData = {
      ...worker.pendingDetailData,
      ratingCount: total
    };
  }
  await persistActiveJob();

  const target = total === null
    ? maxReviewsForJob()
    : Math.min(maxReviewsForJob(), total);
  if (buffered.length < target) {
    if (isFinal && worker.reviewDomFinal) {
      await completeShopeeDetailWorker(worker, {
        ...worker.pendingDetailData,
        reviewsCollected: buffered.length,
        ...reviewRatingSummary(worker),
        reviewsStatus: buffered.length ? 'PARTIAL' : 'FAILED',
        reviewsError: error || worker.reviewsApiError
      });
    }
    return;
  }
  await completeShopeeDetailWorker(worker, {
    ...worker.pendingDetailData,
    reviewsCollected: buffered.length,
    ...reviewRatingSummary(worker),
    reviewsStatus: error ? 'PARTIAL' : 'COMPLETED',
    reviewsError: error
  });
}

async function processShopeeWorkerDomReviews(message, sender) {
  const worker = shopeeDetailWorker(sender.tab?.id);
  if (
    !worker ||
    !worker.currentProduct ||
    !worker.pendingDetailData ||
    !Array.isArray(message?.reviews)
  ) return;
  if (
    message.itemId &&
    String(message.itemId) !== String(worker.currentProduct.itemId)
  ) return;
  const renderedSummary = message?.ratingSummary;
  if (renderedSummary && typeof renderedSummary === 'object') {
    worker.pendingDetailData = mergeDetailData(worker.pendingDetailData, {
      rating: extractNumber(renderedSummary.rating),
      ratingCount: extractNumber(renderedSummary.ratingCount)
    });
    await enrichStoredProductFromDetail(
      worker.currentProduct,
      worker.pendingDetailData
    );
  }
  const isFinal = Boolean(message.isFinal);
  if (isFinal) worker.reviewDomFinal = true;
  const mapped = message.reviews
    .slice(0, maxReviewsForJob())
    .map((review) => ({
      reviewId: String(review?.reviewId || ''),
      author: String(review?.author || ''),
      authorId: String(review?.authorId || ''),
      rating: extractNumber(review?.rating),
      comment: String(review?.comment || ''),
      createdAt: String(review?.createdAt || ''),
      likes: extractNumber(review?.likes),
      images: Array.isArray(review?.images) ? review.images.slice(0, 20).map(String) : [],
      videos: Array.isArray(review?.videos) ? review.videos.slice(0, 10).map(String) : [],
      variation: String(review?.variation || ''),
      shopReply: String(review?.shopReply || '')
    }))
    .filter((review) => review.reviewId || review.comment);
  const buffered = await mergeShopeeWorkerReviews(worker, mapped);
  const expected = expectedReviewTarget(worker.pendingDetailData.ratingCount);
  const reached = buffered.length >= expected;
  const zeroWithKnownRatings = (
    buffered.length === 0 &&
    Number(worker.pendingDetailData.ratingCount || 0) > 0
  );
  const retryLimit = zeroWithKnownRatings
    ? (worker.reviewPageReloads ? MAX_SHOPEE_ZERO_REVIEW_RETRIES : 1)
    : MAX_SHOPEE_DOM_REVIEW_RETRIES;

  if (
    isFinal &&
    !reached &&
    !worker.reviewApiPending &&
    worker.reviewDomRetryRounds < retryLimit
  ) {
    worker.reviewDomFinal = false;
    worker.reviewDomRetryRounds += 1;
    await persistActiveJob();
    armDetailWorkerDeadline(worker);
    await chrome.tabs.sendMessage(worker.tabId, {
      type: 'REQUEST_SHOPEE_RENDERED_REVIEWS',
      itemId: String(worker.currentProduct.itemId),
      limit: maxReviewsForJob()
    }).catch((error) => {
      enqueueDetailMessage(
        () => failShopeeDetailWorker(
          worker,
          error?.message || 'Không thể tiếp tục phân trang đánh giá Shopee.'
        ),
        'Không thể tiếp tục phân trang đánh giá Shopee.'
      );
    });
    return;
  }
  if (
    isFinal &&
    zeroWithKnownRatings &&
    !worker.reviewApiPending &&
    Number(worker.reviewPageReloads || 0) < 1
  ) {
    worker.reviewPageReloads = Number(worker.reviewPageReloads || 0) + 1;
    worker.reviewDomFinal = false;
    worker.reviewDomRetryRounds = 0;
    worker.reviewRequestedFor = null;
    await persistActiveJob();
    armDetailWorkerDeadline(worker);
    await logJob(
      `Shopee reports ${worker.pendingDetailData.ratingCount} ratings but rendered 0 reviews; ` +
      'reloading the product page once before retrying.'
    );
    await chrome.tabs.reload(worker.tabId).catch((error) => {
      enqueueDetailMessage(
        () => failShopeeDetailWorker(
          worker,
          error?.message || 'Không thể tải lại trang đánh giá Shopee.'
        ),
        'Không thể tải lại trang đánh giá Shopee.'
      );
    });
    return;
  }
  if (!reached && (!isFinal || worker.reviewApiPending)) return;
  await completeShopeeDetailWorker(worker, {
    ...worker.pendingDetailData,
    reviewsCollected: buffered.length,
    ...reviewRatingSummary(worker),
    reviewsStatus: reached && !worker.reviewsApiError
      ? 'COMPLETED'
      : buffered.length
        ? 'PARTIAL'
        : 'FAILED',
    reviewsError: worker.reviewsApiError || ''
  });
}

async function processShopeeWorkerDomDetail(detail, sender) {
  const worker = shopeeDetailWorker(sender.tab?.id);
  if (!worker || !worker.currentProduct || !detail) return;
  if (
    detail.itemId &&
    String(detail.itemId) !== String(worker.currentProduct.itemId)
  ) return;
  armDetailWorkerDeadline(worker);
  await acceptOrRecheckShopeeDetail(worker, {
    ...detail,
    itemId: String(worker.currentProduct.itemId)
  });
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
  const payload = detail?.payload;
  let responseItemId = String(payload?.omnicrawlItemId || '');
  if (!responseItemId) {
    try {
      responseItemId = String(
        new URL(String(detail?.url || ''), 'https://shopee.vn')
          .searchParams.get('itemid') || ''
      );
    } catch {
      responseItemId = '';
    }
  }
  const currentItemId = String(activeJob.currentProduct?.itemId || '');
  if (responseItemId && responseItemId !== currentItemId) return;
  const isRequestedFinal = Boolean(payload?.omnicrawlFinal);
  if (!isRequestedFinal) {
    armPageTimeout(DETAIL_TIMEOUT_MS);
  }
  if (isRequestedFinal) {
    activeJob.reviewApiPending = false;
    await persistActiveJob();
  }
  const reviews = mapReviewsPayload(payload);
  const error = String(payload?.error || '');
  const bufferedReviews = await mergeReviewBuffer(reviews);
  if (isRequestedFinal && error) {
    activeJob.reviewsApiError = error;
    await persistActiveJob();
  }
  if (error && reviews.length === 0) {
    await logJob(
      `Shopee review API was unavailable (${error}); waiting for rendered reviews.`
    );
    if (isRequestedFinal && activeJob.reviewDomFinal) {
      await completeCurrentDetail({
        ...activeJob.pendingDetailData,
        reviewsCollected: bufferedReviews.length,
        ...reviewRatingSummary(),
        reviewsStatus: bufferedReviews.length ? 'PARTIAL' : 'FAILED',
        reviewsError: error
      });
    }
    return;
  }
  const totalValue = Number(
    payload?.total ??
    payload?.data?.item_rating_summary?.rating_total
  );
  const total = Number.isFinite(totalValue) && totalValue >= 0 ? totalValue : null;
  const ratingSummary = (
    payload?.itemRatingSummary ??
    payload?.data?.item_rating_summary
  );
  if (ratingSummary && typeof ratingSummary === 'object') {
    const average = extractNumber(
      ratingSummary?.rating_star ??
      ratingSummary?.rating_average ??
      ratingSummary?.average
    );
    const counts = ratingSummary?.rating_count;
    activeJob.pendingDetailData = {
      ...activeJob.pendingDetailData,
      ...(total === null ? {} : { ratingCount: total }),
      ...(average === null ? {} : { rating: average }),
      ...(Array.isArray(counts) ? {
        ratingBreakdown: counts.map((count, index) => ({
          star: index === 0 ? 'all' : index,
          count: extractNumber(count)
        }))
      } : {})
    };
    await persistActiveJob();
  } else if (total !== null) {
    activeJob.pendingDetailData = {
      ...activeJob.pendingDetailData,
      ratingCount: total
    };
    await persistActiveJob();
  }
  const target = total === null
    ? maxReviewsForJob(activeJob)
    : Math.min(maxReviewsForJob(activeJob), total);
  if (bufferedReviews.length < target) {
    await logJob(
      `Captured ${bufferedReviews.length}/${target} Shopee reviews; ` +
      'continuing review pagination.'
    );
    if (isRequestedFinal && activeJob.reviewDomFinal) {
      await completeCurrentDetail({
        ...activeJob.pendingDetailData,
        reviewsCollected: bufferedReviews.length,
        ...reviewRatingSummary(),
        reviewsStatus: 'PARTIAL',
        reviewsError: activeJob.reviewsApiError || ''
      });
    }
    return;
  }
  const reviewsStatus = error
    ? (bufferedReviews.length ? 'PARTIAL' : 'FAILED')
    : 'COMPLETED';
  await logJob(
    `Captured ${bufferedReviews.length}/${target} reviews for product ` +
    `${activeJob.detailIndex + 1}/${activeJob.products.length}.`
  );
  await completeCurrentDetail({
    ...activeJob.pendingDetailData,
    reviewsCollected: bufferedReviews.length,
    ...reviewRatingSummary(),
    reviewsStatus,
    reviewsError: error
  });
}

async function processTikTokDetailReady(message, sender) {
  if (
    !activeJob ||
    activeJob.platform !== 'tiktok' ||
    activeJob.phase !== 'DETAIL' ||
    sender.tab?.id !== activeJob.tabId ||
    !activeJob.currentProduct
  ) return;
  const expectedId = String(activeJob.currentProduct.itemId || '');
  if (message.itemId && String(message.itemId) !== expectedId) return;
  await requestReviewsForCurrent({
    description: activeJob.currentProduct.description || '',
    rating: activeJob.currentProduct.rating ?? null,
    ratingCount: activeJob.currentProduct.ratingCount ?? null,
    observedAt: new Date().toISOString()
  });
}

async function processTikTokReviewsResponse(detail, sender) {
  if (
    !activeJob ||
    activeJob.platform !== 'tiktok' ||
    activeJob.phase !== 'DETAIL' ||
    sender.tab?.id !== activeJob.tabId ||
    detail?.kind !== 'reviews' ||
    !activeJob.pendingDetailData
  ) return;
  const reviews = mapTikTokCommentsPayload(detail?.payload)
    .slice(0, activeJob.maxReviewsPerProduct);
  const error = String(detail?.payload?.error || '');
  const bufferedReviews = await mergeReviewBuffer(reviews);
  if (error && reviews.length === 0) {
    activeJob.reviewsApiError = error;
    await persistActiveJob();
    await logJob(
      `TikTok comments API was unavailable (${error}); waiting for rendered comments.`
    );
    return;
  }
  const expectedValue = (
    activeJob.currentProduct?.comments ?? activeJob.currentProduct?.ratingCount
  );
  const expected = expectedReviewTarget(expectedValue, activeJob);
  if (bufferedReviews.length < expected) {
    await logJob(
      `Captured ${bufferedReviews.length}/${expected} TikTok comments; loading more.`
    );
    return;
  }
  await logJob(
    `Captured ${bufferedReviews.length}/${expected} TikTok comments/reviews for item ` +
    `${activeJob.detailIndex + 1}/${activeJob.products.length}.`
  );
  await completeCurrentDetail({
    ...activeJob.pendingDetailData,
    reviewsCollected: bufferedReviews.length,
    ...reviewRatingSummary(),
    reviewsStatus: error ? 'PARTIAL' : 'COMPLETED',
    reviewsError: error
  });
}

async function processDomReviews(message, sender, platform) {
  const reviews = message?.reviews;
  const isFinal = Boolean(message?.isFinal);
  if (
    !activeJob ||
    activeJob.platform !== platform ||
    activeJob.phase !== 'DETAIL' ||
    sender.tab?.id !== activeJob.tabId ||
    !activeJob.pendingDetailData ||
    !Array.isArray(reviews)
  ) return;
  if (
    platform === 'shopee' &&
    message?.itemId &&
    String(message.itemId) !== String(activeJob.currentProduct?.itemId || '')
  ) return;
  if (
    platform === 'shopee' &&
    message?.ratingSummary &&
    typeof message.ratingSummary === 'object'
  ) {
    activeJob.pendingDetailData = mergeDetailData(activeJob.pendingDetailData, {
      rating: extractNumber(message.ratingSummary.rating),
      ratingCount: extractNumber(message.ratingSummary.ratingCount)
    });
    await enrichStoredProductFromDetail(
      activeJob.currentProduct,
      activeJob.pendingDetailData
    );
  }
  if (platform === 'shopee' && isFinal) {
    activeJob.reviewDomFinal = true;
    await persistActiveJob();
  }
  const mapped = reviews
    .slice(0, activeJob.maxReviewsPerProduct)
    .map((review) => ({
      reviewId: String(review?.reviewId || ''),
      author: String(review?.author || ''),
      authorId: String(review?.authorId || ''),
      rating: extractNumber(review?.rating),
      comment: String(review?.comment || ''),
      createdAt: String(review?.createdAt || ''),
      likes: extractNumber(review?.likes),
      images: Array.isArray(review?.images) ? review.images.slice(0, 20).map(String) : [],
      videos: Array.isArray(review?.videos) ? review.videos.slice(0, 10).map(String) : [],
      variation: String(review?.variation || ''),
      shopReply: String(review?.shopReply || '')
    }))
    .filter((review) => review.reviewId || review.comment);
  if (
    !mapped.length &&
    platform === 'shopee' &&
    isFinal &&
    activeJob.reviewApiPending
  ) {
    await logJob('Rendered reviews finished; waiting for Shopee API pagination.');
    return;
  }
  const bufferedReviews = await mergeReviewBuffer(mapped);
  const expectedValue = (
    platform === 'tiktok'
      ? activeJob.currentProduct?.comments ?? activeJob.currentProduct?.ratingCount
      : activeJob.pendingDetailData?.ratingCount
  );
  const expected = expectedReviewTarget(expectedValue, activeJob);
  const reachedRequestedCount = bufferedReviews.length >= expected;
  const zeroWithKnownRatings = (
    platform === 'shopee' &&
    bufferedReviews.length === 0 &&
    Number(activeJob.pendingDetailData?.ratingCount || 0) > 0
  );
  const retryLimit = zeroWithKnownRatings
    ? (Number(activeJob.reviewPageReloads || 0)
      ? MAX_SHOPEE_ZERO_REVIEW_RETRIES
      : 1)
    : MAX_SHOPEE_DOM_REVIEW_RETRIES;

  if (
    platform === 'shopee' &&
    isFinal &&
    !reachedRequestedCount &&
    !activeJob.reviewApiPending &&
    Number(activeJob.reviewDomRetryRounds || 0) < retryLimit
  ) {
    activeJob.reviewDomFinal = false;
    activeJob.reviewDomRetryRounds = Number(activeJob.reviewDomRetryRounds || 0) + 1;
    await persistActiveJob();
    armPageTimeout(DETAIL_TIMEOUT_MS);
    await logJob(
      `Rendered Shopee reviews stopped at ${bufferedReviews.length}/${expected}; ` +
      `retrying pagination from the current review page ` +
      `(${activeJob.reviewDomRetryRounds}/${retryLimit}).`
    );
    const itemId = String(activeJob.currentProduct?.itemId || '');
    setTimeout(() => {
      if (
        !activeJob ||
        activeJob.phase !== 'DETAIL' ||
        String(activeJob.currentProduct?.itemId || '') !== itemId
      ) return;
      chrome.tabs.sendMessage(activeJob.tabId, {
        type: 'REQUEST_SHOPEE_RENDERED_REVIEWS',
        itemId,
        limit: maxReviewsForJob(activeJob)
      }).catch((error) => {
        void failCurrentDetail(
          error?.message || 'Không thể tiếp tục phân trang đánh giá Shopee.'
        );
      });
    }, 300);
    return;
  }
  if (
    platform === 'shopee' &&
    isFinal &&
    zeroWithKnownRatings &&
    !activeJob.reviewApiPending &&
    Number(activeJob.reviewPageReloads || 0) < 1
  ) {
    const itemId = String(activeJob.currentProduct?.itemId || '');
    activeJob.reviewPageReloads = Number(activeJob.reviewPageReloads || 0) + 1;
    activeJob.reviewDomFinal = false;
    activeJob.reviewDomRetryRounds = 0;
    activeJob.reviewRequestedFor = null;
    await persistActiveJob();
    armPageTimeout(DETAIL_TIMEOUT_MS);
    await logJob(
      `Shopee reports ${activeJob.pendingDetailData?.ratingCount} ratings but rendered 0 reviews; ` +
      'reloading the product page once before retrying.'
    );
    await chrome.tabs.reload(activeJob.tabId).catch((error) => {
      void failCurrentDetail(
        error?.message || `Không thể tải lại trang đánh giá Shopee cho item ${itemId}.`
      );
    });
    return;
  }

  if (
    !reachedRequestedCount &&
    (
      !isFinal ||
      (platform === 'shopee' && activeJob.reviewApiPending)
    )
  ) {
    await logJob(
      `Captured ${bufferedReviews.length}/${expected} rendered ${platformLabel(activeJob)} ` +
      `${platform === 'tiktok' ? 'comments/reviews' : 'reviews'}; ` +
      (
        platform === 'shopee' && isFinal
          ? 'waiting for Shopee API pagination.'
          : 'continuing review pagination.'
      )
    );
    return;
  }

  await logJob(
    `Captured ${bufferedReviews.length}/${expected} ${platformLabel(activeJob)} ` +
    `${platform === 'tiktok' ? 'comments/reviews' : 'reviews'} for item ` +
    `${activeJob.detailIndex + 1}/${activeJob.products.length}.`
  );
  await completeCurrentDetail({
    ...activeJob.pendingDetailData,
    reviewsCollected: bufferedReviews.length,
    ...reviewRatingSummary(),
    reviewsStatus: reachedRequestedCount && !activeJob.reviewsApiError
      ? 'COMPLETED'
      : bufferedReviews.length
        ? 'PARTIAL'
        : 'FAILED',
    reviewsError: activeJob.reviewsApiError || ''
  });
}

async function processDomItems(message, sender) {
  const items = message?.items;
  if (
    !activeJob ||
    activeJob.phase !== 'SEARCH' ||
    sender.tab?.id !== activeJob.tabId ||
    !Array.isArray(items)
  ) return;
  const messagePage = Number(message?.page ?? activeJob.page);
  if (
    activeJob.platform === 'shopee' &&
    (!Number.isInteger(messagePage) || messagePage !== activeJob.page)
  ) return;
  const storedCount = await storeItems(items);
  await recordPageItems(messagePage, storedCount);
  if (storedCount) {
    await logJob(
      `Captured ${storedCount} items from rendered ${platformLabel(activeJob)} cards.`
    );
  }
  if (await maybeBeginDetailAfterShopeeImages()) return;
  if (activeJob.platform !== 'shopee' || !message?.isFinal) {
    if (activeJob.platform !== 'shopee' && storedCount) await scheduleNextPage();
    return;
  }
  const pageNewCount = Number(
    activeJob.pageNewItemCounts?.[String(messagePage)] || 0
  );
  if (
    pageNewCount < MIN_SHOPEE_ITEMS_PER_PAGE &&
    activeJob.seen.length < activeJob.maxItems &&
    await retryCurrentShopeePage(messagePage, pageNewCount)
  ) return;
  if (pageNewCount > 0) {
    await logJob(
      `Finished Shopee page ${messagePage} with ${pageNewCount} new products.`
    );
    await scheduleNextPage();
    return;
  }
  if (activeJob.seen.length > 0) {
    await continueAfterNoNewSearchData(
      `Finished Shopee page ${messagePage} without new products; continuing with ` +
      `${activeJob.seen.length} products already collected.`
    );
  }
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

async function closeActiveBrowserJob(runId) {
  if (!activeJob || String(activeJob.runId) !== String(runId || '')) return false;
  const job = activeJob;
  activeJob = null;
  clearTimeout(pageTimer);
  clearTimeout(searchImageReadyTimer);
  searchImageReadyTimer = null;
  chrome.alarms.clear(SHOPEE_IMAGE_READY_ALARM).catch(() => undefined);
  for (const timer of detailWorkerTimers.values()) clearTimeout(timer);
  detailWorkerTimers.clear();
  for (const worker of job.detailWorkers || []) {
    chrome.alarms.clear(
      `${DETAIL_DEADLINE_ALARM_PREFIX}${worker.tabId}`
    ).catch(() => undefined);
    chrome.alarms.clear(
      `${DETAIL_READY_ALARM_PREFIX}${worker.tabId}`
    ).catch(() => undefined);
  }
  await persistActiveJob();
  const crawlerWindowIds = new Set(
    [job.windowId, ...(job.detailWorkers || []).map((worker) => worker.windowId)]
      .filter((windowId) => windowId !== null && windowId !== undefined)
      .map(Number)
      .filter((windowId) => Number.isInteger(windowId) && windowId > 0)
  );
  if (crawlerWindowIds.size) {
    await Promise.all(
      [...crawlerWindowIds].map((windowId) => (
        chrome.windows.remove(windowId).catch(() => undefined)
      ))
    );
  } else if (job.tabId) {
    await chrome.tabs.remove(job.tabId).catch(() => undefined);
  }
  schedulePoll(1000);
  return true;
}

async function syncActiveBrowserJobStatus() {
  if (!activeJob) return;
  const runId = activeJob.runId;
  const response = await api(`/api/runs/${encodeURIComponent(runId)}`);
  const run = await response.json();
  if (['STOPPED', 'SUCCESS', 'FAILED'].includes(String(run?.status || ''))) {
    await closeActiveBrowserJob(runId);
  }
}

async function poll() {
  if (!config?.token) return;
  if (activeJob) {
    await syncActiveBrowserJobStatus().catch(() => undefined);
    return;
  }
  try {
    const response = await api('/api/browser-agent/jobs/next');
    if (response.status === 204) return;
    const job = await response.json();
    activeJob = {
      ...job,
      platform: job.platform || 'shopee',
      mode: job.mode || 'products',
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
      reviewsApiError: '',
      reviewBuffer: [],
      reviewSeen: [],
      reviewsCollected: 0,
      reviewRatingSum: 0,
      reviewsWithRating: 0,
      reviewApiPending: false,
      reviewDomFinal: false,
      reviewDomRetryRounds: 0,
      reviewPageReloads: 0,
      detailConcurrency: Math.min(
        MAX_DETAIL_CONCURRENCY,
        Math.max(1, Math.floor(Number(job.detailConcurrency || 1)))
      ),
      detailNextIndex: 0,
      detailWorkers: [],
      detailAssignments: {},
      reviewOwnerTabId: null,
      reviewApiFailureStreak: 0,
      reviewApiDegraded: false,
      tabId: null,
      windowId: null,
      unexpectedResponses: 0,
      navigationScheduled: false,
      scheduledPage: null,
      consecutiveNoNewPages: 0,
      lastNoNewPage: null,
      pageNewItemCounts: {},
      pageRetryCounts: {},
      itemImages: {},
      searchImageReadyRounds: 0,
      searchImageReadyScheduled: false,
      pageDeadline: Date.now() + searchTimeoutForJob(job)
    };
    await persistActiveJob();
    const {
      tab,
      windowId,
      reusedSessionTab
    } = await createCrawlerWindow(activeJob);
    activeJob.tabId = tab.id;
    activeJob.windowId = windowId;
    await persistActiveJob();
    await logJob(
      reusedSessionTab
        ? `Reused the authenticated ${platformLabel(activeJob)} tab session in a separate window.`
        : `No existing ${platformLabel(activeJob)} tab was available; opened a new profile window.`
    );
    armPageTimeout(searchTimeoutForJob(activeJob));
  } catch (error) {
    if (activeJob) {
      await finishJob(
        false,
        error instanceof Error
          ? error.message
          : `Không thể mở tab ${platformLabel(activeJob)}.`
      );
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
      if (activeJob) await resumePersistedActiveJob();
      schedulePoll(0);
    } else if (message.type === 'POLL_NOW') {
      void poll();
    } else if (message.type === 'STOP_JOB') {
      await closeActiveBrowserJob(String(message.runId || ''));
    } else if (message.type === 'TIKTOK_RESPONSE') {
      const handler = message.detail?.kind === 'reviews'
        ? processTikTokReviewsResponse
        : processTikTokSearchResponse;
      void handler(message.detail, sender).catch((error) => {
        void finishJob(
          false,
          error instanceof Error ? error.message : 'Không thể xử lý dữ liệu TikTok.'
        ).catch(() => undefined);
      });
    } else if (
      message.type === 'TIKTOK_PAGE_STATUS' &&
      activeJob?.platform === 'tiktok' &&
      sender.tab?.id === activeJob.tabId
    ) {
      if (activeJob.phase === 'DETAIL') {
        void processTikTokDetailReady(message, sender).catch((error) => {
          void failCurrentDetail(
            error instanceof Error ? error.message : 'Không thể mở chi tiết TikTok.'
          );
        });
      } else {
        void logJob(
          `TikTok page ready: mode=${String(message.mode || activeJob.mode)}, ` +
          `shopTab=${message.shopTabFound ? 'found' : 'not-found'}, ` +
          `url=${String(message.url || '').slice(0, 500)}.`
        );
      }
    } else if (message.type === 'SHOPEE_RESPONSE') {
      if (
        activeJob?.platform === 'shopee' &&
        activeJob.phase === 'DETAIL' &&
        shopeeDetailWorker(sender.tab?.id)
      ) {
        const workerHandler = message.detail?.kind === 'detail'
          ? processShopeeWorkerDetailResponse
          : message.detail?.kind === 'reviews'
            ? processShopeeWorkerReviewsResponse
            : null;
        if (workerHandler) {
          enqueueDetailMessage(
            () => workerHandler(message.detail, sender),
            'Không thể xử lý dữ liệu chi tiết Shopee.'
          );
        }
        sendResponse({ ok: true });
        return;
      }
      const handler = message.detail?.kind === 'detail'
        ? processDetailResponse
        : message.detail?.kind === 'reviews'
          ? processReviewsResponse
          : processSearchResponse;
      if (handler === processSearchResponse) {
        enqueueSearchMessage(
          () => handler(message.detail, sender),
          'Không thể xử lý dữ liệu tìm kiếm Shopee.'
        );
      } else if (handler === processReviewsResponse) {
        enqueueReviewMessage(
          () => handler(message.detail, sender),
          'Không thể xử lý dữ liệu đánh giá Shopee.'
        );
      } else {
        void handler(message.detail, sender).catch((error) => {
          void finishJob(
            false,
            error instanceof Error ? error.message : 'Không thể xử lý dữ liệu.'
          ).catch(() => undefined);
        });
      }
    } else if (message.type === 'SHOPEE_DOM_ITEMS' || message.type === 'TIKTOK_DOM_ITEMS') {
      enqueueSearchMessage(
        () => processDomItems(message, sender),
        'Không thể xử lý card sản phẩm.'
      );
    } else if (message.type === 'SHOPEE_DOM_REVIEWS') {
      if (shopeeDetailWorker(sender.tab?.id)) {
        enqueueDetailMessage(
          () => processShopeeWorkerDomReviews(message, sender),
          'Không thể lưu đánh giá Shopee.'
        );
      } else {
        enqueueReviewMessage(
          () => processDomReviews(message, sender, 'shopee'),
          'Không thể lưu đánh giá Shopee.'
        );
      }
    } else if (message.type === 'TIKTOK_DOM_REVIEWS') {
      void processDomReviews(message, sender, 'tiktok').catch((error) => {
        void failCurrentDetail(
          error instanceof Error ? error.message : 'Không thể lưu bình luận TikTok.'
        );
      });
    } else if (message.type === 'SHOPEE_DOM_DETAIL') {
      if (shopeeDetailWorker(sender.tab?.id)) {
        enqueueDetailMessage(
          () => processShopeeWorkerDomDetail(message.detail, sender),
          'Không thể lưu chi tiết sản phẩm Shopee.'
        );
      } else {
        void processDomDetail(message.detail, sender).catch((error) => {
          void finishJob(
            false,
            error instanceof Error ? error.message : 'Không thể lưu chi tiết sản phẩm Shopee.'
          ).catch(() => undefined);
        });
      }
    } else if (
      (message.type === 'SHOPEE_BLOCKED' || message.type === 'TIKTOK_BLOCKED') &&
      activeJob &&
      (
        sender.tab?.id === activeJob.tabId ||
        Boolean(shopeeDetailWorker(sender.tab?.id))
      )
    ) {
      const label = message.type === 'TIKTOK_BLOCKED' ? 'TikTok' : 'Shopee';
      void finishJob(
        false,
        `${label} yêu cầu CAPTCHA hoặc đăng nhập trong Chrome.`
      ).catch(() => undefined);
    } else if (message.type === 'GET_AUTH_STATUS') {
      const statuses = await checkAuthStatuses();
      sendResponse({ ok: true, statuses });
      return;
    } else if (message.type === 'OPEN_TAB' && message.url) {
      chrome.tabs.create({ url: message.url }).catch(() => undefined);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

async function checkAuthStatuses() {
  try {
    const [shopeeDomainCookies, shopeeUrlCookies, tiktokDomainCookies, tiktokUrlCookies] = await Promise.all([
      chrome.cookies.getAll({ domain: 'shopee.vn' }).catch(() => []),
      chrome.cookies.getAll({ url: 'https://shopee.vn' }).catch(() => []),
      chrome.cookies.getAll({ domain: 'tiktok.com' }).catch(() => []),
      chrome.cookies.getAll({ url: 'https://www.tiktok.com' }).catch(() => [])
    ]);

    const allShopee = [...shopeeDomainCookies, ...shopeeUrlCookies];
    const allTikTok = [...tiktokDomainCookies, ...tiktokUrlCookies];

    const isShopeeLoggedIn = allShopee.some((c) => (
      ['SPC_U', 'SPC_EC', 'SPC_ST', 'shopee_token', 'shopee_user_id', 'SPC_SI'].includes(c.name) &&
      Boolean(c.value) && c.value !== '-' && c.value !== '0'
    ));

    const isTikTokLoggedIn = allTikTok.some((c) => (
      ['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt'].includes(c.name) &&
      Boolean(c.value) && c.value !== '-' && c.value !== '0'
    ));

    return {
      shopeeLoggedIn: isShopeeLoggedIn,
      tiktokLoggedIn: isTikTokLoggedIn
    };
  } catch {
    return { shopeeLoggedIn: false, tiktokLoggedIn: false };
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const worker = shopeeDetailWorker(tabId);
  if (worker && activeJob?.phase === 'DETAIL') {
    enqueueDetailMessage(
      async () => {
        const oldTimer = detailWorkerTimers.get(tabId);
        if (oldTimer) clearTimeout(oldTimer);
        detailWorkerTimers.delete(tabId);
        await chrome.alarms.clear(
          `${DETAIL_DEADLINE_ALARM_PREFIX}${tabId}`
        ).catch(() => undefined);
        await chrome.alarms.clear(
          `${DETAIL_READY_ALARM_PREFIX}${tabId}`
        ).catch(() => undefined);
        await restartShopeeAgentWindow(worker, 'its tab was closed');
      },
      'Không thể xử lý tab lấy chi tiết Shopee bị đóng.'
    );
    return;
  }
  if (activeJob?.tabId === tabId) {
    void finishJob(false, `Tab ${platformLabel(activeJob)} của Browser Agent đã bị đóng.`)
      .catch(() => undefined);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const worker = shopeeDetailWorker(tabId);
  if (!worker?.busy || worker.reviewRequestedFor || worker.waitingForReview) return;
  enqueueDetailMessage(
    () => probeShopeeWorkerDetail(worker),
    'Không thể kiểm tra trạng thái tải trang chi tiết Shopee.'
  );
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('omnicrawl-poll', { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SHOPEE_IMAGE_READY_ALARM) {
    clearTimeout(searchImageReadyTimer);
    searchImageReadyTimer = null;
    if (activeJob) activeJob.searchImageReadyScheduled = false;
    enqueueSearchMessage(
      () => maybeBeginDetailAfterShopeeImages(),
      'Không thể kiểm tra độ phủ ảnh sản phẩm Shopee.'
    );
    return;
  }
  if (alarm.name.startsWith(DETAIL_READY_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(DETAIL_READY_ALARM_PREFIX.length));
    const worker = shopeeDetailWorker(tabId);
    if (worker) {
      enqueueDetailMessage(
        () => probeShopeeWorkerDetail(worker),
        'Không thể kiểm tra dữ liệu chi tiết Shopee.'
      );
    }
    return;
  }
  if (alarm.name.startsWith(DETAIL_DEADLINE_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(DETAIL_DEADLINE_ALARM_PREFIX.length));
    const worker = shopeeDetailWorker(tabId);
    if (worker?.busy) {
      enqueueDetailMessage(
        () => failShopeeDetailWorker(
          worker,
          'Không nhận đủ dữ liệu chi tiết sau 90 giây.'
        ),
        'Không thể xử lý thời hạn chi tiết Shopee.'
      );
    }
    return;
  }
  if (alarm.name !== 'omnicrawl-poll') return;
  if (activeJob?.pageDeadline && Date.now() >= activeJob.pageDeadline) {
    void handlePageTimeout().catch(() => undefined);
    return;
  }
  const expiredWorker = activeJob?.detailWorkers?.find(
    (worker) => worker.busy && worker.deadline && Date.now() >= worker.deadline
  );
  if (expiredWorker) {
    enqueueDetailMessage(
      () => failShopeeDetailWorker(
        expiredWorker,
        'Không nhận đủ dữ liệu chi tiết sau 90 giây.'
      ),
      'Không thể xử lý thời hạn chi tiết Shopee.'
    );
    return;
  }
  void poll();
});

async function resumePersistedActiveJob() {
  if (!activeJob || !config) return;
  chrome.alarms.create('omnicrawl-poll', { periodInMinutes: 0.5 });
  if (
    activeJob.platform === 'shopee' &&
    activeJob.phase === 'SEARCH' &&
    activeJob.seen?.length >= activeJob.maxItems
  ) {
    activeJob.searchImageReadyScheduled = false;
    await persistActiveJob();
    await maybeBeginDetailAfterShopeeImages();
    return;
  }
  if (
    activeJob.platform === 'shopee' &&
    activeJob.phase === 'DETAIL' &&
    activeJob.detailWorkers?.length
  ) {
    for (const worker of activeJob.detailWorkers) {
      if (!worker.busy) continue;
      const existingTab = await chrome.tabs.get(worker.tabId).catch(() => null);
      if (!existingTab) {
        await restartShopeeAgentWindow(worker, 'Browser Agent recovery');
        continue;
      }
      worker.windowId = existingTab.windowId;
      const storedRemaining = Number(
        worker.deadline || Date.now() + DETAIL_TIMEOUT_MS
      ) - Date.now();
      const recoveringExpiredWorker = storedRemaining <= 0;
      if (recoveringExpiredWorker) {
        worker.readyProbeCount = 0;
        worker.readyReloads = 0;
      }
      const remaining = recoveringExpiredWorker
        ? DETAIL_TIMEOUT_MS
        : Math.max(1, storedRemaining);
      armDetailWorkerDeadline(worker, remaining);
      scheduleShopeeWorkerReadyProbe(
        worker,
        recoveringExpiredWorker ? 100 : SPARSE_DETAIL_RECHECK_MS
      );
    }
    await persistActiveJob();
  } else if (activeJob.navigationScheduled) {
    activeJob.navigationScheduled = false;
    activeJob.scheduledPage = null;
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

stateReady.then(async () => {
  if (activeJob && config) await resumePersistedActiveJob();
  if (config) schedulePoll(0);
});
