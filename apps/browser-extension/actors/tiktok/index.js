(() => {
  const registry = globalThis.OmniCrawlActorTools ||= {};

  registry['tiktok-scraper'] = Object.freeze({
    name: 'tiktok-scraper',
    platform: 'tiktok',
    collectionMode: 'keyword',
    unlimitedItems: false,
    parseKeywords(job) {
      return String(job.keyword || job.query || '')
        .split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean);
    },
    buildCollectionUrl(job) {
      const keywords = Array.isArray(job.keywords) ? job.keywords : [];
      const keyword = keywords[job.keywordIndex || 0] || job.keyword || '';
      return (
        `https://www.tiktok.com/search?q=${encodeURIComponent(keyword)}` +
        `&omnicrawl_mode=${encodeURIComponent(job.mode || 'videos')}`
      );
    }
  });
})();
