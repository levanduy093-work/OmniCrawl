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
    if (requestKind(url) === 'search') {
      window.__OMNICRAWL_SHOPEE_API_CONTEXT__ = { url: String(url), options: args[1] };
    }
    const response = await originalFetch.apply(this, args);
    void capture(url || response.url, response);
    return response;
  };

  window.addEventListener('omnicrawl:execute-shopee-search', async (e) => {
    try {
      const { page, keyword } = e.detail;
      const context = window.__OMNICRAWL_SHOPEE_API_CONTEXT__;
      console.log('[Shopee Hook] Replaying API for page:', page, context);
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
