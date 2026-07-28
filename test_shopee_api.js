const https = require('https');

https.get('https://shopee.vn/api/v4/search/search_items?by=relevancy&keyword=m%C3%A1y%20in%203d&limit=10&newest=0&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('API Response code:', res.statusCode, 'Data:', data.slice(0, 100)));
}).on('error', err => console.log('Error:', err.message));
