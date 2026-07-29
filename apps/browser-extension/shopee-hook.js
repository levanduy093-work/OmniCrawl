(() => {
  if (window.__OMNICRAWL_SHOPEE_HOOK__) return;
  window.__OMNICRAWL_SHOPEE_HOOK__ = true;

  const emit = (payload) => {
    window.dispatchEvent(new CustomEvent('omnicrawl:shopee-response', {
      detail: payload
    }));
  };

  const nativeReviewPages = new Map();

  const reviewRequestInfo = (url) => {
    try {
      const parsed = new URL(String(url), location.origin);
      if (!parsed.pathname.includes('/item/get_ratings')) return null;
      const itemId = String(parsed.searchParams.get('itemid') || '');
      const offset = Number(parsed.searchParams.get('offset') || 0);
      if (!itemId || !Number.isFinite(offset) || offset < 0) return null;
      return { itemId, offset };
    } catch {
      return null;
    }
  };

  const rememberNativeReviewPage = (url, status, payload) => {
    const request = reviewRequestInfo(url);
    if (!request || status < 200 || status >= 300) return;
    if (payload?.error && payload.error !== 0) return;
    const ratings = payload?.data?.ratings || payload?.ratings;
    if (!Array.isArray(ratings)) return;
    const now = Date.now();
    nativeReviewPages.set(`${request.itemId}:${request.offset}`, {
      payload,
      ratings,
      capturedAt: now
    });
    for (const [key, cached] of nativeReviewPages) {
      if (now - Number(cached.capturedAt || 0) > 120000) {
        nativeReviewPages.delete(key);
      }
    }
  };

  const requestKind = (url) => {
    const value = String(url);
    if (value.includes('/api/v4/search/search_items')) {
      try {
        const parsed = new URL(value, location.origin);
        return parsed.searchParams.get('limit') !== '0' ? 'search' : null;
      } catch {
        return 'search';
      }
    }
    if (
      value.includes('/api/v2/item/get_ratings') ||
      value.includes('/api/v4/item/get_ratings')
    ) return 'reviews';
    if (
      value.includes('/api/v4/pdp/get_pc') ||
      value.includes('/api/v4/pdp/get_rw') ||
      value.includes('/api/v4/item/get')
    ) return 'detail';
    return null;
  };

  const capture = async (url, response) => {
    const kind = requestKind(url);
    if (!kind) return;
    try {
      const payload = await response.clone().json();
      if (kind === 'reviews') {
        rememberNativeReviewPage(url, response.status, payload);
      }
      emit({
        kind,
        url: String(url),
        status: response.status,
        payload
      });
    } catch {
      // A later search response can still complete the job.
    }
  };

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const response = await originalFetch.apply(this, args);
    void capture(url || response.url, response);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__omnicrawlUrl = String(url);
    this.addEventListener('load', () => {
      const kind = requestKind(this.__omnicrawlUrl);
      if (!kind) return;
      try {
        const payload = JSON.parse(this.responseText);
        if (kind === 'reviews') {
          rememberNativeReviewPage(this.__omnicrawlUrl, this.status, payload);
        }
        emit({
          kind,
          url: this.__omnicrawlUrl,
          status: this.status,
          payload
        });
      } catch {
        // Ignore non-JSON responses.
      }
    }, { once: true });
    return originalOpen.call(this, method, url, ...rest);
  };

  const wait = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

  const scalarReviewTotal = (payload) => {
    const candidates = [
      payload?.data?.item_rating_summary?.rating_total,
      payload?.data?.total,
      payload?.data?.total_count,
      payload?.total,
      payload?.total_count
    ];
    for (const candidate of candidates) {
      if (
        candidate === null ||
        candidate === undefined ||
        candidate === '' ||
        typeof candidate === 'object'
      ) continue;
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return null;
  };

  window.addEventListener('omnicrawl:request-reviews', async (event) => {
    const itemId = String(event.detail?.itemId || '');
    const shopId = String(event.detail?.shopId || '');
    const requestedLimit = Number(event.detail?.limit || 0);
    const maxReviews = Number.isFinite(requestedLimit)
      ? Math.min(100000, Math.max(0, Math.floor(requestedLimit)))
      : 20;
    if (!itemId || !shopId) {
      emit({
        kind: 'reviews',
        status: 400,
        payload: {
          ratings: [],
          error: 'Missing Shopee product identifiers',
          omnicrawlItemId: itemId,
          omnicrawlFinal: true
        }
      });
      return;
    }
    if (maxReviews === 0) {
      emit({
        kind: 'reviews',
        status: 200,
        payload: {
          ratings: [],
          total: 0,
          omnicrawlItemId: itemId,
          omnicrawlFinal: true
        }
      });
      return;
    }

    const seen = new Set();
    let collectedCount = 0;
    let offset = 0;
    let total = null;
    let ratingSummary = null;
    let paginationError = '';
    const pageSize = 20;

    const consumedNativePages = new Set();

    const requestPage = async (pageLimit) => {
      const cacheKey = `${itemId}:${offset}`;
      const cached = nativeReviewPages.get(cacheKey);
      if (
        cached &&
        Date.now() - Number(cached.capturedAt || 0) <= 120000 &&
        !consumedNativePages.has(cacheKey)
      ) {
        consumedNativePages.add(cacheKey);
        return {
          page: {
            payload: cached.payload,
            ratings: cached.ratings,
            fromNativePage: true
          },
          error: ''
        };
      }

      let lastError = `Shopee ratings API failed at offset ${offset}.`;
      const maximumAttempts = offset === 0 ? 3 : 2;
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const params = new URLSearchParams({
          exclude_filter: '1',
          filter: '0',
          filter_size: '0',
          flag: '1',
          fold_filter: '0',
          itemid: itemId,
          limit: String(pageLimit),
          offset: String(offset),
          relevant_reviews: 'false',
          request_source: '2',
          shopid: shopId,
          tag_filter: '',
          type: '0',
          variation_filters: ''
        });
        const url = `/api/v2/item/get_ratings?${params.toString()}`;
        const response = await originalFetch.call(window, url, {
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'X-Api-Source': 'pc',
            'X-Requested-With': 'XMLHttpRequest'
          }
        }).catch((error) => {
          lastError = `Network error at offset ${offset}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          return null;
        });
        const payload = response
          ? await response.json().catch(() => null)
          : null;
        const ratings = payload?.data?.ratings || payload?.ratings;
        if (
          response?.ok &&
          payload &&
          (!payload.error || payload.error === 0) &&
          Array.isArray(ratings)
        ) {
          return {
            page: { payload, ratings, fromNativePage: false },
            error: ''
          };
        }

        if (response) {
          const shopeeCode = payload?.error;
          const shopeeMessage = payload?.error_msg || payload?.message;
          lastError = [
            `Shopee ratings API HTTP ${response.status} at offset ${offset}`,
            shopeeCode !== undefined ? `code ${shopeeCode}` : '',
            shopeeMessage ? String(shopeeMessage) : ''
          ].filter(Boolean).join('; ');
        }
        if (attempt < maximumAttempts) {
          const rateLimited = response?.status === 403 || response?.status === 429;
          const retryDelay = rateLimited
            ? 1200 * attempt + Math.floor(Math.random() * 800)
            : 500 * attempt + Math.floor(Math.random() * 500);
          await wait(retryDelay);
        }
      }
      return { page: null, error: lastError };
    };

    try {
      while (collectedCount < maxReviews) {
        const pageLimit = Math.min(pageSize, maxReviews - collectedCount);
        const result = await requestPage(pageLimit);
        const page = result.page;
        if (!page) {
          paginationError = result.error;
          break;
        }

        const pageTotal = scalarReviewTotal(page.payload);
        if (pageTotal !== null) total = pageTotal;
        if (page.payload?.data?.item_rating_summary) {
          ratingSummary = page.payload.data.item_rating_summary;
        }
        if (!page.ratings.length) break;

        const freshRatings = [];
        for (const rating of page.ratings) {
          const key = String(
            rating?.cmtid ??
            rating?.comment_id ??
            `${rating?.userid || rating?.author_username || ''}:${rating?.ctime || ''}`
          );
          if (!key || seen.has(key)) continue;
          seen.add(key);
          freshRatings.push(rating);
          collectedCount += 1;
          if (collectedCount >= maxReviews) break;
        }
        if (freshRatings.length) {
          emit({
            kind: 'reviews',
            status: 200,
            payload: {
              ratings: freshRatings,
              total,
              itemRatingSummary: ratingSummary,
              omnicrawlItemId: itemId,
              omnicrawlFinal: false
            }
          });
        }

        offset += page.ratings.length;
        if (
          (!page.fromNativePage && page.ratings.length < pageLimit) ||
          !freshRatings.length ||
          (total !== null && offset >= total)
        ) break;
        await wait(800 + Math.floor(Math.random() * 700));
      }
    } catch (error) {
      paginationError = error instanceof Error
        ? error.message
        : 'Unable to collect Shopee reviews';
    }

    const target = total === null ? maxReviews : Math.min(maxReviews, total);
    const incomplete = collectedCount < target;
    emit({
      kind: 'reviews',
      status: incomplete ? 503 : 200,
      payload: {
        ratings: [],
        total,
        itemRatingSummary: ratingSummary,
        error: incomplete ? paginationError : '',
        omnicrawlItemId: itemId,
        omnicrawlOffset: offset,
        omnicrawlCollected: collectedCount,
        omnicrawlRequested: maxReviews,
        omnicrawlIncomplete: incomplete,
        omnicrawlFinal: true
      }
    });
  });
})();
