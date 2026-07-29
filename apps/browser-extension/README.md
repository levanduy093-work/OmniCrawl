# OmniCrawl Browser Agent

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `apps/browser-extension` directory.
5. Keep Chrome open and sign in to `https://shopee.vn` and/or `https://www.tiktok.com`.
6. Open the OmniCrawl dashboard. Each crawler card reports whether its website session is ready.

The extension never reads or exports browser cookies. It captures structured
Shopee and TikTok search responses inside the signed-in browser. TikTok search
uses API interception, embedded hydration data and rendered-card fallback, then
scrolls the result page to collect more items without exporting browser cookies.
Video search is the default. TikTok Shop product search additionally requires
TikTok to expose a Shop/Products tab in the signed-in desktop web session; the
run log records whether that tab was found.
When the Shopee option
`Thu thập chi tiết từng sản phẩm` is enabled, one crawler tab opens each
collected product in sequence and captures description, rating, stock, shop,
images, attributes, and variations. It stores the product's average rating and
total rating count, but never requests, paginates, or stores customer comments.
A failure on one product is recorded and the remaining products continue.
If Shopee expires the authenticated session, the run pauses without discarding
its queue, opens a focused login popup, and resumes the same tabs after login.
Shopee search-page and product-page navigations use a single action scheduler.
Only one Shopee tab is used, and external navigations are separated by a random
1.5–2.5 second delay without a long cooldown. Search pages scroll downward in
small viewport-sized steps so lazy-loaded cards and images can stabilize before
the crawler advances.
Shopee login challenges and `/verify/traffic/error` are handled separately.
A traffic-control response pauses without retrying and preserves the unfinished
queue. After the user resolves the Shopee page or changes network and opens the
Shopee home page, the same queue resumes through the global scheduler.

Each stored row also records its search keyword/rank, observation time, numeric
price range, discount, sales and stock signals, rating distribution, shop
metrics, variants, wholesale tiers, promotions, logistics and product media.
Repeated runs therefore form a time series linked by `itemId`.

After updating the source, click **Reload** on the extension page and then reload
the OmniCrawl dashboard tab. The dashboard only enables Shopee jobs when the
expected Browser Agent version is active.
