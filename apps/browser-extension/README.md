# OmniCrawl Browser Agent

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `apps/browser-extension` directory.
5. Keep Chrome open and sign in to `https://shopee.vn`.
6. Open the OmniCrawl dashboard. The Shopee card will show that the Browser Agent is connected.

The extension never reads or exports browser cookies. It captures structured
Shopee search responses inside the signed-in browser. When
`Thu thập chi tiết từng sản phẩm` is enabled, it then opens each collected
product in the same tab, captures description, rating, stock, shop, images,
attributes, variations and review content, and updates the matching database
row. Review pagination is limited by `Số đánh giá tối đa mỗi sản phẩm`. A
failure on one product is recorded and the remaining products continue.

Each stored row also records its search keyword/rank, observation time, numeric
price range, discount, sales and stock signals, rating distribution, shop
metrics, variants, wholesale tiers, promotions, logistics and product media.
Repeated runs therefore form a time series linked by `itemId`.

After updating the source, click **Reload** on the extension page and then reload
the OmniCrawl dashboard tab. The dashboard only enables Shopee jobs when the
expected Browser Agent version is active.
