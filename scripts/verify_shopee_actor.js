import { resolveProxyUrls, ProxyPool } from '../actors/shopee-scraper/dist/proxyPool.js';
import { mapApiItem } from '../actors/shopee-scraper/dist/productMapper.js';

console.log('=== Verifying Shopee Server-Side Actor Modules ===');

// 1. Test Proxy Pool & Rotation
const testUrls = resolveProxyUrls('http://user:pass@proxy1.com:8080, http://proxy2.com:8080');
console.log('Resolved proxy URLs:', testUrls);
if (testUrls.length !== 2) {
  throw new Error(`Expected 2 proxies, got ${testUrls.length}`);
}

const pool = new ProxyPool(testUrls);
const p1 = pool.next();
const p2 = pool.next();
const p3 = pool.next();

console.log('Proxy rotation check:', { p1Index: p1?.index, p2Index: p2?.index, p3Index: p3?.index });
if (p1?.index !== 0 || p2?.index !== 1 || p3?.index !== 0) {
  throw new Error('Proxy rotation index mismatch!');
}

// 2. Test Product Mapping (Guest Mode API response payload mapping)
const mockApiItem = {
  itemid: 123456,
  shopid: 7890,
  name: 'Sản phẩm Test Shopee Server-Side',
  price: 15000000000,
  price_min: 14000000000,
  price_max: 16000000000,
  historical_sold: 50,
  item_rating: { rating_star: 4.8 },
  image: 'test_image_hash',
  location: 'TP. Hồ Chí Minh'
};

const mapped = mapApiItem(mockApiItem);
console.log('Mapped search product item:', mapped);

if (String(mapped.itemId) !== '123456' || String(mapped.shopId) !== '7890' || mapped.priceValue !== 140000) {
  throw new Error('Product mapping validation failed!');
}

console.log('✅ Shopee Actor Verification Passed Successfully!');
