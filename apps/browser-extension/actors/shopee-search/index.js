(() => {
  const registry = globalThis.OmniCrawlActorTools ||= {};

  registry['shopee-scraper'] = Object.freeze({
    name: 'shopee-scraper',
    platform: 'shopee',
    collectionMode: 'keyword',
    unlimitedItems: false,
    parseKeywords(job) {
      return String(job.keyword || job.query || '')
        .split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean);
    },
    buildCollectionUrl(job, page) {
      const keywords = Array.isArray(job.keywords) ? job.keywords : [];
      const keyword = keywords[job.keywordIndex || 0] || job.keyword || '';
      const url = new URL('https://shopee.vn/search');
      url.searchParams.set('keyword', keyword);
      if (page > 0) url.searchParams.set('page', String(page));
      return url.toString();
    }
  });
})();
