(() => {
  if (window.__OMNICRAWL_SHOPEE_HOOK__) return;
  window.__OMNICRAWL_SHOPEE_HOOK__ = true;

  const emit = (payload) => {
    window.dispatchEvent(new CustomEvent('omnicrawl:shopee-response', {
      detail: payload
    }));
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
      emit({
        kind,
        url: String(url),
        status: response.status,
        payload: await response.clone().json()
      });
    } catch {
      // A later search response can still complete the job.
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
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
        emit({
          kind,
          url: this.__omnicrawlUrl,
          status: this.status,
          payload: JSON.parse(this.responseText)
        });
      } catch {
        // Ignore non-JSON responses.
      }
    }, { once: true });
    return originalOpen.call(this, method, url, ...rest);
  };

  window.addEventListener('omnicrawl:request-reviews', async (event) => {
    const itemId = String(event.detail?.itemId || '');
    const shopId = String(event.detail?.shopId || '');
    const requestedLimit = Number(event.detail?.limit || 0);
    const maxReviews = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(0, Math.floor(requestedLimit)))
      : 20;
    if (!itemId || !shopId) {
      emit({
        kind: 'reviews',
        status: 400,
        payload: { ratings: [], error: 'Missing Shopee product identifiers' }
      });
      return;
    }
    if (maxReviews === 0) {
      emit({ kind: 'reviews', status: 200, payload: { ratings: [], total: 0 } });
      return;
    }

    const ratings = [];
    const seen = new Set();
    let offset = 0;
    let total = null;
    try {
      while (ratings.length < maxReviews) {
        const pageLimit = Math.min(6, Math.max(1, maxReviews - ratings.length));
        const params = new URLSearchParams({
          exclude_filter: '1',
          filter: '0',
          filter_size: '0',
          flag: '1',
          itemid: itemId,
          limit: String(pageLimit),
          offset: String(offset),
          shopid: shopId,
          type: '0'
        });
        let url = `/api/v2/item/get_ratings?${params.toString()}`;
        let response = await originalFetch.call(window, url, {
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'X-Api-Source': 'pc',
            'X-Requested-With': 'XMLHttpRequest'
          }
        }).catch(() => null);

        if (!response || !response.ok) {
          url = `/api/v4/item/get_ratings?${params.toString()}`;
          response = await originalFetch.call(window, url, {
            credentials: 'include',
            headers: {
              Accept: 'application/json',
              'X-Api-Source': 'pc',
              'X-Requested-With': 'XMLHttpRequest'
            }
          }).catch(() => null);
        }

        if (!response || !response.ok) break;
        const payload = await response.json().catch(() => null);
        if (!payload || (payload.error && payload.error !== 0)) break;
        const pageRatings = payload?.data?.ratings || payload?.ratings || [];
        total = Number(payload?.data?.item_rating_summary?.rating_total ?? total);
        if (!Array.isArray(pageRatings) || pageRatings.length === 0) break;
        for (const rating of pageRatings) {
          const key = String(
            rating?.cmtid ??
            rating?.comment_id ??
            `${rating?.userid || rating?.author_username || ''}:${rating?.ctime || ''}`
          );
          if (seen.has(key)) continue;
          seen.add(key);
          ratings.push(rating);
          if (ratings.length >= maxReviews) break;
        }
        offset += pageRatings.length;
        if (pageRatings.length < pageLimit || (total !== null && offset >= total)) break;
        await new Promise((resolve) => {
          setTimeout(resolve, 150 + Math.floor(Math.random() * 200));
        });
      }
      emit({
        kind: 'reviews',
        status: 200,
        payload: { ratings, total }
      });
    } catch (error) {
      emit({
        kind: 'reviews',
        status: 502,
        payload: {
          ratings,
          total,
          error: error instanceof Error ? error.message : 'Unable to collect Shopee reviews'
        }
      });
    }
  });
})();
