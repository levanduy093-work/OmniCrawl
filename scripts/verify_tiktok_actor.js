import { resolveProxyUrls, ProxyPool } from '../actors/tiktok-scraper/dist/proxyPool.js';
import { mapTikTokVideo } from '../actors/tiktok-scraper/dist/productMapper.js';

console.log('=== Verifying TikTok Server-Side Actor Modules ===');

// 1. Test Proxy Pool & Rotation
const testUrls = resolveProxyUrls({ TIKTOK_PROXY_URLS: 'http://user:pass@proxy1.com:8080, http://proxy2.com:8080' });
console.log('Resolved TikTok proxy URLs:', testUrls);
if (testUrls.length !== 2) {
  throw new Error(`Expected 2 TikTok proxies, got ${testUrls.length}`);
}

const pool = new ProxyPool(testUrls);
const p1 = pool.next();
const p2 = pool.next();
const p3 = pool.next();

console.log('TikTok Proxy rotation check:', { p1Index: p1?.index, p2Index: p2?.index, p3Index: p3?.index });
if (p1?.index !== 0 || p2?.index !== 1 || p3?.index !== 0) {
  throw new Error('TikTok Proxy rotation index mismatch!');
}

// 2. Test TikTok Video/Product Mapper
const mockVideoEntry = {
  item: {
    id: '7123456789012345678',
    desc: 'Review sản phẩm siêu hot trên TikTok Shop',
    author: {
      uniqueId: 'test_creator',
      nickname: 'Creator Test'
    },
    stats: {
      playCount: 150000,
      diggCount: 12000,
      commentCount: 450,
      shareCount: 890
    },
    video: {
      cover: { url_list: ['https://p16-sign.tiktokcdn.com/test_cover.jpg'] }
    }
  }
};

const mapped = mapTikTokVideo(mockVideoEntry, { keyword: 'test', round: 1, position: 1 });
console.log('Mapped TikTok Video item:', mapped);

if (mapped.itemId !== '7123456789012345678' || mapped.views !== 150000 || mapped.likes !== 12000) {
  throw new Error('TikTok video mapping validation failed!');
}

console.log('✅ TikTok Actor Verification Passed Successfully!');
