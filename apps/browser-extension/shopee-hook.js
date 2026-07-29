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

})();
