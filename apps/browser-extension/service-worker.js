let config = null;
let activeJob = null;
let pollTimer = null;
let pageTimer = null;
let searchMessageQueue = Promise.resolve();
let reviewMessageQueue = Promise.resolve();

const SEARCH_TIMEOUT_MS = 30000;
const TIKTOK_SEARCH_TIMEOUT_MS = 45000;
const DETAIL_TIMEOUT_MS = 90000;

const stateReady = chrome.storage.session.get(['config', 'activeJob']).then((stored) => {
  config = stored.config || null;
  activeJob = stored.activeJob || null;
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
      ? Math.min(100, Math.max(0, Math.floor(restoredMaxReviews)))
      : 20;
    activeJob.pendingDetailData = activeJob.pendingDetailData || null;
    activeJob.reviewsApiError = activeJob.reviewsApiError || '';
    activeJob.reviewBuffer = Array.isArray(activeJob.reviewBuffer)
      ? activeJob.reviewBuffer
      : [];
    activeJob.reviewSeen = Array.isArray(activeJob.reviewSeen)
      ? activeJob.reviewSeen
      : [];
    activeJob.reviewApiPending = Boolean(activeJob.reviewApiPending);
    activeJob.reviewDomFinal = Boolean(activeJob.reviewDomFinal);
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
  }
});

function persistActiveJob() {
  return chrome.storage.session.set({ activeJob });
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
      const bufferedReviews = Array.isArray(activeJob.reviewBuffer)
        ? activeJob.reviewBuffer
        : [];
      await completeCurrentDetail({
        ...activeJob.pendingDetailData,
        reviewsCollected: bufferedReviews.length,
        reviews: bufferedReviews,
        reviewsStatus: bufferedReviews.length ? 'PARTIAL' : 'FAILED',
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

function imageUrl(value) {
  const image = typeof value === 'object'
    ? (
      value?.full_url ||
      value?.display_url ||
      value?.image_url ||
      value?.display_image ||
      value?.image_id ||
      value?.image ||
      value?.url
    )
    : value;
  if (!image) return '';
  if (image !== value && typeof image === 'object') return imageUrl(image);
  const text = String(image);
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  return `https://down-vn.img.susercontent.com/file/${text}`;
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
    entry?.item_card_display_price
  );
  const itemId = item?.itemid ?? item?.item_id;
  const shopId = item?.shopid ?? item?.shop_id;
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
    price: priceValue !== null
      ? `${priceValue.toLocaleString('vi-VN')}₫`
      : '',
    priceValue,
    originalPrice,
    discountPercent: extractNumber(item?.discount ?? item?.discount_percentage),
    sold: item?.historical_sold ?? item?.sold ?? item?.sold_count ?? 0,
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
    image: imageUrl(imageId),
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
  const ratingCount = extractNumber(
    rating?.rating_count ??
    rating?.count ??
    item?.rating_count ??
    item?.cmt_count
  );
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
    totalSold: extractNumber(item?.historical_sold ?? item?.total_sold),
    salesLast30Days: extractNumber(item?.sold ?? item?.monthly_sold),
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
    100,
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
  if (!activeJob || !Array.isArray(reviews)) return [];
  const seen = new Set(activeJob.reviewSeen || []);
  const buffer = Array.isArray(activeJob.reviewBuffer) ? activeJob.reviewBuffer : [];
  for (const review of reviews) {
    const key = String(
      review?.reviewId ||
      `${review?.author || ''}:${review?.createdAt || ''}:${review?.comment || ''}`
    );
    if (!key || seen.has(key)) continue;
    seen.add(key);
    buffer.push(review);
    if (buffer.length >= maxReviewsForJob(activeJob)) break;
  }
  activeJob.reviewSeen = [...seen];
  activeJob.reviewBuffer = buffer;
  await persistActiveJob();
  return buffer;
}

async function storeItems(items) {
  if (!activeJob || activeJob.phase !== 'SEARCH') return 0;
  const seenSet = new Set(activeJob.seen);
  const freshItems = [];
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
    if (!item.title || (requiresPrice && !item.price) || seenSet.has(key)) continue;
    seenSet.add(key);
    activeJob.seen.push(key);
    if (activeJob.includeDetails && item.itemId && item.url) {
      activeJob.products.push({
        itemId: item.itemId,
        shopId: item.shopId,
        url: item.url,
        title: item.title,
        image: item.image,
        sourceType: item.sourceType || (activeJob.platform === 'tiktok' ? activeJob.mode : 'product'),
        description: item.description || '',
        rating: item.rating ?? null,
        ratingCount: item.ratingCount ?? item.reviewCount ?? null,
        comments: item.comments ?? null
      });
    }
    freshItems.push(item);
    if (activeJob.seen.length >= activeJob.maxItems) break;
  }
  if (!freshItems.length) return 0;
  activeJob.consecutiveNoNewPages = 0;
  activeJob.lastNoNewPage = null;
  await persistActiveJob();
  await api(`/api/browser-agent/jobs/${activeJob.runId}/items`, {
    method: 'POST',
    body: JSON.stringify({ items: freshItems })
  });
  return freshItems.length;
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
  const delay = 2000 + Math.floor(Math.random() * 800);
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
    if (job.windowId) {
      chrome.windows.remove(job.windowId).catch(() => undefined);
    } else if (job.tabId) {
      chrome.tabs.remove(job.tabId).catch(() => undefined);
    }
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
  activeJob.reviewsApiError = '';
  activeJob.reviewBuffer = [];
  activeJob.reviewSeen = [];
  activeJob.reviewApiPending = false;
  activeJob.reviewDomFinal = false;
  await persistActiveJob();
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
  activeJob.reviewApiPending = false;
  activeJob.reviewDomFinal = false;
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
  activeJob.reviewApiPending = false;
  activeJob.reviewDomFinal = false;
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
  activeJob.reviewApiPending = activeJob.platform === 'shopee';
  activeJob.reviewDomFinal = false;
  await persistActiveJob();

  const limit = maxReviewsForJob(activeJob);
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
        reviews: [],
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
      reviews: [],
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

  if (activeJob.seen.length >= activeJob.maxItems) {
    await beginDetailPhase();
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
  if (activeJob.seen.length >= activeJob.maxItems) {
    await beginDetailPhase();
    return;
  }
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
  if (isRequestedFinal) {
    activeJob.reviewApiPending = false;
    await persistActiveJob();
  }
  const reviews = mapReviewsPayload(payload);
  const error = String(payload?.error || '');
  const bufferedReviews = await mergeReviewBuffer(reviews);
  if (error && reviews.length === 0) {
    activeJob.reviewsApiError = error;
    await persistActiveJob();
    await logJob(
      `Shopee review API was unavailable (${error}); waiting for rendered reviews.`
    );
    if (isRequestedFinal && activeJob.reviewDomFinal) {
      await completeCurrentDetail({
        ...activeJob.pendingDetailData,
        reviewsCollected: bufferedReviews.length,
        reviews: bufferedReviews,
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
        reviews: bufferedReviews,
        reviewsStatus: 'PARTIAL',
        reviewsError: activeJob.reviewsApiError || ''
      });
    }
    return;
  }
  const reviewsStatus = error
    ? (reviews.length ? 'PARTIAL' : 'FAILED')
    : 'COMPLETED';
  await logJob(
    `Captured ${bufferedReviews.length}/${target} reviews for product ` +
    `${activeJob.detailIndex + 1}/${activeJob.products.length}.`
  );
  await completeCurrentDetail({
    ...activeJob.pendingDetailData,
    reviewsCollected: bufferedReviews.length,
    reviews: bufferedReviews,
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
    reviews: bufferedReviews,
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
  if (!mapped.length && !(activeJob.reviewBuffer || []).length) {
    if (
      platform === 'shopee' &&
      isFinal &&
      activeJob.reviewApiPending
    ) {
      await logJob('Rendered reviews finished; waiting for Shopee API pagination.');
      return;
    }
    if (platform === 'shopee' && isFinal) {
      const expected = expectedReviewTarget(
        activeJob.pendingDetailData?.ratingCount,
        activeJob
      );
      await completeCurrentDetail({
        ...activeJob.pendingDetailData,
        reviewsCollected: 0,
        reviews: [],
        reviewsStatus: expected === 0 ? 'COMPLETED' : 'FAILED',
        reviewsError: activeJob.reviewsApiError || (
          expected === 0 ? '' : 'Shopee returned no reviews for this product.'
        )
      });
    }
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
    reviews: bufferedReviews,
    reviewsStatus: reachedRequestedCount && !activeJob.reviewsApiError
      ? 'COMPLETED'
      : 'PARTIAL',
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
  if (activeJob.seen.length >= activeJob.maxItems) {
    await beginDetailPhase();
    return;
  }
  if (activeJob.platform !== 'shopee' || !message?.isFinal) {
    if (activeJob.platform !== 'shopee' && storedCount) await scheduleNextPage();
    return;
  }
  const pageNewCount = Number(
    activeJob.pageNewItemCounts?.[String(messagePage)] || 0
  );
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
  await persistActiveJob();
  if (job.windowId) {
    await chrome.windows.remove(job.windowId).catch(() => undefined);
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
      reviewApiPending: false,
      reviewDomFinal: false,
      tabId: null,
      windowId: null,
      unexpectedResponses: 0,
      navigationScheduled: false,
      scheduledPage: null,
      consecutiveNoNewPages: 0,
      lastNoNewPage: null,
      pageNewItemCounts: {},
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
      enqueueReviewMessage(
        () => processDomReviews(message, sender, 'shopee'),
        'Không thể lưu đánh giá Shopee.'
      );
    } else if (message.type === 'TIKTOK_DOM_REVIEWS') {
      void processDomReviews(message, sender, 'tiktok').catch((error) => {
        void failCurrentDetail(
          error instanceof Error ? error.message : 'Không thể lưu bình luận TikTok.'
        );
      });
    } else if (message.type === 'SHOPEE_DOM_DETAIL') {
      void processDomDetail(message.detail, sender).catch((error) => {
        void finishJob(
          false,
          error instanceof Error ? error.message : 'Không thể lưu chi tiết sản phẩm Shopee.'
        ).catch(() => undefined);
      });
    } else if (
      (message.type === 'SHOPEE_BLOCKED' || message.type === 'TIKTOK_BLOCKED') &&
      activeJob &&
      sender.tab?.id === activeJob.tabId
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
  if (activeJob?.tabId === tabId) {
    void finishJob(false, `Tab ${platformLabel(activeJob)} của Browser Agent đã bị đóng.`)
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
  if (config) schedulePoll(0);
});
