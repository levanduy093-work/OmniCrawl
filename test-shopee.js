const https = require('https');

const url = 'https://shopee.vn/api/v4/search/search_items?by=relevance&keyword=m%C3%A1y%20in%203d&limit=10&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2';

https.get(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://shopee.vn/search?keyword=m%C3%A1y%20in%203d'
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Error:', json.error);
      const items = json.items || [];
      if (items.length > 0) {
        const item = items[0].item_basic;
        console.log('Item basic keys:', Object.keys(item));
        console.log('historical_sold:', item.historical_sold);
        console.log('sold:', item.sold);
        console.log('show_free_shipping:', item.show_free_shipping);
        console.log('tier_variations:', item.tier_variations);
        // let's print all values that look like they could be the sold count or text
        for (const key in item) {
          if (typeof item[key] === 'string' && (item[key].includes('bán') || item[key].includes('k'))) {
            console.log('Possible sold text in:', key, '=', item[key]);
          }
        }
      } else {
        console.log('No items returned');
        console.log(data);
      }
    } catch (e) {
      console.log('Parse error:', e.message);
      console.log('Raw data:', data.slice(0, 500));
    }
  });
}).on('error', err => console.log('Network error:', err.message));
