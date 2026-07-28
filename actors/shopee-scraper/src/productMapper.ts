export function mapApiItem(entry: any) {
  const item = entry?.item_basic || entry;
  const itemId = item?.itemid;
  const shopId = item?.shopid;
  const rawPrice = item?.price_min ?? item?.price;
  const numericPrice = Number(rawPrice);

  return {
    itemId,
    shopId,
    title: String(item?.name || '').trim(),
    price: Number.isFinite(numericPrice)
      ? `${Math.round(numericPrice / 100000).toLocaleString('vi-VN')}₫`
      : '',
    sold: item?.historical_sold ?? item?.sold ?? 0,
    url: itemId && shopId ? `https://shopee.vn/product/${shopId}/${itemId}` : '',
    image: item?.image
      ? `https://down-vn.img.susercontent.com/file/${item.image}`
      : ''
  };
}
