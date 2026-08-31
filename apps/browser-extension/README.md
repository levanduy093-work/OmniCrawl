# OmniCrawl Browser Agent

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `apps/browser-extension` directory.
5. Keep Chrome open and sign in to `https://shopee.vn` and/or `https://www.tiktok.com` in the regular profile.
6. Open the OmniCrawl dashboard. Each crawler card reports whether its website session is ready.

The Browser Agent loads three independent actor tools from `actors/`:

- `actors/shopee-search`: keyword search with a run-level item limit.
- `actors/shopee-shop`: every product exposed by a Shopee shop URL, without a
  `maxItems` limit.
- `actors/tiktok`: TikTok video or TikTok Shop search.

The Shopee shop actor follows pages until consecutive pages contain no new
product IDs. Duplicate products are removed by product ID, and optional
product-detail collection runs only after the shop listing is exhausted.

The extension never reads or exports browser cookies. It captures structured
Shopee and TikTok search responses inside the signed-in browser. TikTok search
uses API interception, embedded hydration data and rendered-card fallback, then
scrolls the result page to collect more items without exporting browser cookies.
Video search is the default. TikTok Shop product search additionally requires
TikTok to expose a Shop/Products tab in the signed-in browser session; the
run log records whether that tab was found.
When the Shopee option
`Thu thập chi tiết từng sản phẩm` is enabled, one crawler tab opens each
collected product in sequence and captures description, rating, stock, shop,
images, attributes, and variations. It stores the product's average rating and
total rating count, but never requests, paginates, or stores customer comments.
Shopee uses the signed-in regular profile only for the product-list phase. When
the list is complete, the agent closes that window, waits three seconds and
opens a dedicated Incognito window for product detail. Detail links are opened
sequentially in that Incognito window; after every 40 processed products, the
window is closed and replaced with a fresh Incognito window.
For every product, the agent actively requests the structured PDP endpoints and
retries with a bounded budget. It marks an item `COMPLETED` only when the
structured payload contains usable price and catalogue fields; rendered-page
data is supplemental and remains `PARTIAL` if those endpoints stay unavailable.
If list collection requires authentication, the queue pauses and opens a login
popup in the regular profile. If an Incognito detail redirects to
`/verify/traffic/error` with `Login Required`, the agent closes that Incognito
window, opens a fresh one and retries the unfinished product with a bounded
retry budget. A genuine traffic-control or CAPTCHA page remains paused until
the user resolves it manually in the visible browser tab.
Product galleries are accepted only from image lists scoped to the current
Shopee `itemId`. The rendered-page fallback stays inside the product header and
rejects links to other product IDs, so recommendation images are not mixed in.
A failure on one product is recorded and the remaining products continue.
Shopee search-page and product-page navigations use a single action coordinator.
External navigations are separated by a 3–6 second gap and capped at 30
requests per minute. Search pages scroll downward in small viewport-sized steps
so lazy-loaded cards and images can stabilize before the crawler advances.
Shopee login challenges and `/verify/traffic/error` are handled separately.
A traffic-control response pauses without retrying and preserves the unfinished
queue. After the user resolves the Shopee page manually, the same queue resumes
through the global coordinator. Detail navigation is guarded so a restored or
stale job cannot continue inside a regular-profile window.

If a product page displays `The product doesn't exist` (or its Vietnamese
equivalent), the agent treats it as a permanent `NOT_FOUND` result. It stores
`productExists: false` and the unavailable URL, skips retries, and immediately
continues with the next product.

Each stored row also records its search keyword/rank, observation time, numeric
price range, discount, sales and stock signals, rating distribution, shop
metrics, variants, wholesale tiers, promotions, logistics and product media.
Repeated runs therefore form a time series linked by `itemId`.

After updating the source, click **Reload** on the extension page and then reload
the OmniCrawl dashboard tab. The dashboard only enables Shopee jobs when the
expected Browser Agent version is active.
