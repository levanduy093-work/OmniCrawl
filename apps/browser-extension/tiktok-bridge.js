window.addEventListener('omnicrawl:tiktok-response', (event) => {
  chrome.runtime.sendMessage({
    type: 'TIKTOK_RESPONSE',
    detail: event.detail
  }).catch(() => undefined);
});

function scrapeRenderedTikTokItems() {
  const items = [];
  const seen = new Set();
  
  // Scrape TikTok Video items or TikTok Shop items from DOM fallback
  const cards = document.querySelectorAll('div[data-e2e="search_top-item"], div[data-e2e="search-card"], a[href*="/video/"]');
  cards.forEach((card) => {
    const linkEl = card.tagName === 'A' ? card : card.querySelector('a[href*="/video/"]');
    if (!linkEl) return;
    const url = linkEl.href;
    const idMatch = url.match(/\/video\/(\d+)/);
    const itemId = idMatch ? idMatch[1] : url;
    if (seen.has(itemId)) return;
    seen.add(itemId);

    const titleEl = card.querySelector('div[data-e2e="search-card-video-caption"], span.title, h3') || card;
    const title = titleEl.textContent?.trim() || '';
    const authorEl = card.querySelector('span[data-e2e="search-card-user-unique-id"], p.author-unique-id');
    const author = authorEl?.textContent?.trim() || '';
    const imgEl = card.querySelector('img');

    if (title && title.length > 3) {
      items.push({
        itemId,
        title,
        author,
        url,
        image: imgEl?.src || ''
      });
    }
  });

  return items.slice(0, 100);
}

let lastDomSignature = '';
let domAttempts = 0;
const domCaptureTimer = setInterval(() => {
  domAttempts += 1;
  const items = scrapeRenderedTikTokItems();
  const signature = items.map((item) => item.itemId).join(',');
  if (items.length && signature !== lastDomSignature) {
    lastDomSignature = signature;
    chrome.runtime.sendMessage({
      type: 'TIKTOK_DOM_ITEMS',
      items
    }).catch(() => undefined);
  }
  if (domAttempts >= 15) clearInterval(domCaptureTimer);
}, 2000);
