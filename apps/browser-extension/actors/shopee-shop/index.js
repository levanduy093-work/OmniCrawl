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
      url.searchParams.set('page', String(Math.max(0, Number(page) || 0)));
      if (!url.searchParams.has('sortBy')) {
        url.searchParams.set('sortBy', 'pop');
      }
      url.searchParams.set('omnicrawl_source', 'shop');
      // Shopee's shop landing page only renders a featured subset. The
      // #product_list route activates All Products while preserving `page`.
      url.hash = 'product_list';
      return url.toString();
    }
  });
})();
