let config = null;
let activeJob = null;
let pollTimer = null;
let pageTimer = null;
const stateReady = chrome.storage.session.get(['config', 'activeJob']).then((stored) => {
  config = stored.config || null;
  activeJob = stored.activeJob || null;
});

function persistActiveJob() {
  return chrome.storage.session.set({ activeJob });
}

function armPageTimeout() {
  clearTimeout(pageTimer);
  if (!activeJob) return;
  activeJob.pageDeadline = Date.now() + 30000;
  void persistActiveJob();
  pageTimer = setTimeout(() => {
    if (activeJob && Date.now() >= activeJob.pageDeadline) {
      void finishJob(false, 'Không nhận được dữ liệu tìm kiếm từ Shopee sau 30 giây.');
    }
  }, 30000);
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

function extractPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const numeric = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }
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
    itemId,
    shopId,
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
    image: typeof imageId === 'string' && imageId
      ? `https://down-vn.img.susercontent.com/file/${imageId}`
      : ''
  };
}

async function storeItems(items) {
  if (!activeJob) return 0;
  const seenSet = new Set(activeJob.seen);
  const freshItems = [];
  for (const item of items) {
    const key = String(item.itemId || item.url || item.title);
    if (!item.title || !item.price || seenSet.has(key)) continue;
    seenSet.add(key);
    activeJob.seen.push(key);
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
  if (!activeJob || activeJob.navigationScheduled) return;
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
    if (!activeJob || activeJob.runId !== runId) return;
    activeJob.navigationScheduled = false;
    void persistActiveJob();
    armPageTimeout();
    chrome.tabs.update(activeJob.tabId, { url: nextUrl });
  }, delay);
}

async function logJob(message) {
  if (!activeJob) return;
  await api(`/api/browser-agent/jobs/${activeJob.runId}/log`, {
    method: 'POST',
    body: JSON.stringify({ message })
  }).catch(() => undefined);
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
      body: JSON.stringify(success ? { count: job.seen.length } : { error })
    });
  } catch {
    // The dashboard can still stop or delete a run if the local API disappears.
  } finally {
    if (success && job.tabId) chrome.tabs.remove(job.tabId).catch(() => undefined);
    schedulePoll(1000);
  }
}

async function processSearchResponse(detail, sender) {
  if (!activeJob || sender.tab?.id !== activeJob.tabId) return;
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
    await finishJob(true);
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

async function processDomItems(items, sender) {
  if (!activeJob || sender.tab?.id !== activeJob.tabId || !Array.isArray(items)) return;
  const storedCount = await storeItems(items);
  if (!storedCount) return;
  await logJob(`Captured ${storedCount} products from rendered Shopee cards.`);
  if (activeJob.seen.length >= activeJob.maxItems) {
    await finishJob(true);
    return;
  }
  await scheduleNextPage();
}

async function poll() {
  if (!config?.token || activeJob) return;
  try {
    const response = await api('/api/browser-agent/jobs/next');
    if (response.status === 204) return;
    const job = await response.json();
    activeJob = {
      ...job,
      page: 0,
      seen: [],
      tabId: null,
      unexpectedResponses: 0,
      navigationScheduled: false,
      pageDeadline: Date.now() + 30000
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
    armPageTimeout();
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
      void processSearchResponse(message.detail, sender).catch((error) => {
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
  if (activeJob && activeJob.pageDeadline && Date.now() >= activeJob.pageDeadline) {
    void finishJob(false, 'Không nhận được dữ liệu tìm kiếm từ Shopee sau 30 giây.')
      .catch(() => undefined);
    return;
  }
  void poll();
});

stateReady.then(() => {
  if (activeJob) {
    armPageTimeout();
  }
  if (config) {
    schedulePoll(0);
  }
});
