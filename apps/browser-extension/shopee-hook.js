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

  const shopeeDetailCandidates = (itemId, shopId) => {
    const query = new URLSearchParams({
      item_id: String(itemId),
      shop_id: String(shopId)
    });
    const legacyQuery = new URLSearchParams({
      itemid: String(itemId),
      shopid: String(shopId)
    });
    return [
      `/api/v4/pdp/get_pc?${query.toString()}`,
      `/api/v4/pdp/get_rw?${query.toString()}`,
      `/api/v4/item/get?${legacyQuery.toString()}`
    ];
  };

  window.addEventListener('omnicrawl:execute-shopee-detail', async (event) => {
    const itemId = String(event.detail?.itemId || '');
    const shopId = String(event.detail?.shopId || '');
    const requestId = String(event.detail?.requestId || '');
    if (!itemId || !shopId) {
      emit({
        kind: 'detail-request',
        requestId,
        status: 0,
        payload: { error: 'MISSING_PRODUCT_IDS' }
      });
      return;
    }

    let lastError = '';
    for (const candidate of shopeeDetailCandidates(itemId, shopId)) {
      try {
        const url = new URL(candidate, location.origin).toString();
        const response = await originalFetch.call(window, url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            accept: 'application/json',
            'x-api-source': 'pc'
          }
        });
        const payload = await response.clone().json();
        emit({
          kind: 'detail',
          url,
          status: response.status,
          payload,
          requestedByOmniCrawl: true,
          requestId
        });
        if (response.ok && (!payload?.error || payload.error === 0)) return;
        lastError = String(payload?.error_msg || payload?.message || payload?.error || response.status);
        if (
          response.status === 401 ||
          payload?.error === 90309999 ||
          /login required|please login|đăng nhập/i.test(lastError)
        ) return;
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }

    emit({
      kind: 'detail-request',
      requestId,
      status: 0,
      payload: { error: lastError || 'DETAIL_ENDPOINTS_UNAVAILABLE' }
    });
  });

  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (requestKind(url) === 'search') {
      window.__OMNICRAWL_SHOPEE_API_CONTEXT__ = { url: String(url), options: args[1] };
    }
    const response = await originalFetch.apply(this, args);
    void capture(url || response.url, response);
    return response;
  };

  window.addEventListener('omnicrawl:execute-shopee-search', async (e) => {
    try {
      const { page, keyword, sortBy, order } = e.detail;
      const context = window.__OMNICRAWL_SHOPEE_API_CONTEXT__;
      console.log('[Shopee Hook] Replaying API for page:', page, 'sortBy:', sortBy, 'order:', order, context);
      if (!context || !context.url) {
        console.error('[Shopee Hook] No API context found!');
        return;
      }

      const parsed = new URL(context.url, location.origin);
      const limit = Number(parsed.searchParams.get('limit')) || 60;
      parsed.searchParams.set('newest', String(page * limit));
      if (keyword) {
        parsed.searchParams.set('keyword', keyword);
      }

      // Apply filter rotation params: update or remove sortBy/order
      if (sortBy) {
        parsed.searchParams.set('sortBy', sortBy);
      } else {
        parsed.searchParams.delete('sortBy');
      }
      if (order) {
        parsed.searchParams.set('order', order);
      } else {
        parsed.searchParams.delete('order');
      }

      // We explicitly call originalFetch here so that it bypasses the hook above 
      // (avoiding infinite loops if any), but we manually call capture() to emit response.
      const response = await originalFetch.call(this, parsed.toString(), context.options);
      void capture(parsed.toString(), response);
    } catch {
      // Ignore
    }
  });

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__omnicrawlUrl = String(url);
    this.__omnicrawlMethod = method;
    this.addEventListener('load', () => {
      const kind = requestKind(this.__omnicrawlUrl);
      if (!kind) return;
      try {
        const payload = JSON.parse(this.responseText);
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

  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
    this.__omnicrawlHeaders = this.__omnicrawlHeaders || {};
    this.__omnicrawlHeaders[header] = value;
    return originalSetRequestHeader.apply(this, arguments);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(body) {
    if (requestKind(this.__omnicrawlUrl) === 'search') {
      window.__OMNICRAWL_SHOPEE_API_CONTEXT__ = {
        url: this.__omnicrawlUrl,
        options: {
          method: this.__omnicrawlMethod || 'GET',
          headers: this.__omnicrawlHeaders || {},
          ...(body ? { body } : {})
        }
      };
      console.log('[Shopee Hook] Captured XHR Context:', window.__OMNICRAWL_SHOPEE_API_CONTEXT__);
    }
    return originalSend.apply(this, arguments);
  };

})();
