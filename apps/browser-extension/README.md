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
`Thu thập chi tiết từng sản phẩm` is enabled, it then opens each collected
product and captures description, rating, stock, shop, images, attributes,
variations and review content. `Số tác nhân lấy chi tiết cùng lúc` can start
up to six independent browser windows. A durable coordinator claims each
`itemId` for exactly one agent, records completion, and assigns the next
unclaimed product without making review crawlers wait for one another. Review
pagination is limited by `Số đánh giá tối đa mỗi sản phẩm`. A failure on one
product is recorded and the remaining products continue.

Each stored row also records its search keyword/rank, observation time, numeric
price range, discount, sales and stock signals, rating distribution, shop
metrics, variants, wholesale tiers, promotions, logistics and product media.
Repeated runs therefore form a time series linked by `itemId`.

After updating the source, click **Reload** on the extension page and then reload
the OmniCrawl dashboard tab. The dashboard only enables Shopee jobs when the
expected Browser Agent version is active.
