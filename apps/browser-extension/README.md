# OmniCrawl Browser Agent

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `apps/browser-extension` directory.
5. Keep Chrome open and sign in to `https://shopee.vn`.
6. Open the OmniCrawl dashboard. The Shopee card will show that the Browser Agent is connected.

The extension never reads or exports browser cookies. It only captures structured
Shopee search responses and sends mapped product fields to the local OmniCrawl API.

After updating the source, click **Reload** on the extension page and then reload
the OmniCrawl dashboard tab. The dashboard only enables Shopee jobs when the
expected Browser Agent version is active.
