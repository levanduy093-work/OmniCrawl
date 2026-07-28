(() => {
  if (window.__OMNICRAWL_SHOPEE_HOOK__) return;
  window.__OMNICRAWL_SHOPEE_HOOK__ = true;

  const emit = (payload) => {
    window.dispatchEvent(new CustomEvent('omnicrawl:shopee-response', {
      detail: payload
    }));
  };

  const isProductSearchRequest = (url) => {
    const value = String(url);
    if (!value.includes('/api/v4/search/search_items')) return false;
    try {
      const parsed = new URL(value, location.origin);
      return parsed.searchParams.get('limit') !== '0';
    } catch {
      return true;
    }
  };

  const capture = async (url, response) => {
    if (!isProductSearchRequest(url)) return;
    try {
      emit({
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
      if (!isProductSearchRequest(this.__omnicrawlUrl)) return;
      try {
        emit({
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
})();
