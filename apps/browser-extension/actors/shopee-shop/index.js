(() => {
  const registry = globalThis.OmniCrawlActorTools ||= {};

  registry['shopee-shop-scraper'] = Object.freeze({
    name: 'shopee-shop-scraper',
    platform: 'shopee',
    collectionMode: 'shop',
    unlimitedItems: true,
    parseKeywords() {
      return [];
    },
    buildCollectionUrl(job, page) {
      const url = new URL(String(job.shopUrl));
      url.hash = '';
      url.searchParams.set('page', String(Math.max(0, Number(page) || 0)));
      url.searchParams.set('omnicrawl_source', 'shop');
      return url.toString();
    }
  });
})();
