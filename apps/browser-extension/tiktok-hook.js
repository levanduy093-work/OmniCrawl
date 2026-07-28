(() => {
  if (window.__OMNICRAWL_TIKTOK_HOOK__) return;
  window.__OMNICRAWL_TIKTOK_HOOK__ = true;

  const emit = (payload) => {
    window.dispatchEvent(new CustomEvent('omnicrawl:tiktok-response', {
      detail: payload
    }));
  };

  const requestKind = (url) => {
    const value = String(url).toLowerCase();
    if (
      value.includes('/api/search/item/full/') ||
      value.includes('/api/search/general/full/') ||
      value.includes('/api/search/video/full/') ||
      value.includes('/api/search/item/')
    ) {
      return 'video-search';
    }
    if (
      value.includes('/api/v1/shop/product/search/') ||
      value.includes('/api/v1/shop/product/get_recommend/') ||
      value.includes('/api/v1/shop/product/get_products/') ||
      value.includes('/product/search') ||
      value.includes('/search/products')
    ) {
      return 'product-search';
    }
    if (
      value.includes('/api/v1/shop/product/get_detail/') ||
      value.includes('/api/item/detail/') ||
      value.includes('/product/detail')
    ) {
      return 'detail';
    }
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
      // Ignore non-JSON responses
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
        // Ignore parsing errors
      }
    });
    return originalOpen.call(this, method, url, ...rest);
  };
})();
