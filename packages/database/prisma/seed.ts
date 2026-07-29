import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });

const prisma = new PrismaClient();

async function main() {
  console.log('Start seeding...');
  
  // Create a default user if none exists
  const existingUser = await prisma.user.findUnique({
    where: { email: 'admin@omnicrawl.local' }
  });
  const hashedPassword = await bcrypt.hash('password123', 10);
  const passwordUpgrade = existingUser && !existingUser.password.startsWith('$2')
    ? { password: await bcrypt.hash(existingUser.password, 10) }
    : {};

  const user = await prisma.user.upsert({
    where: { email: 'admin@omnicrawl.local' },
    update: {
      ...passwordUpgrade,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    create: {
      email: 'admin@omnicrawl.local',
      password: hashedPassword,
      role: 'ADMIN',
      status: 'ACTIVE',
      credits: 1000,
    },
  });

  console.log(`User created with id: ${user.id}`);

  const shopeeInputSchema = JSON.stringify({
    type: 'object',
    required: ['keyword'],
    properties: {
      keyword: {
        type: 'string',
        title: 'Từ khóa tìm kiếm',
        minLength: 1
      },
      maxItems: {
        type: 'integer',
        title: 'Số sản phẩm tối đa',
        minimum: 1,
        maximum: 500,
        default: 50
      },
      includeDetails: {
        type: 'boolean',
        title: 'Thu thập chi tiết từng sản phẩm',
        description: 'Mở các tab độc lập để lấy mô tả, đánh giá, tồn kho và phân loại.',
        default: true
      },
      maxReviewsPerProduct: {
        type: 'integer',
        title: 'Số đánh giá tối đa mỗi sản phẩm',
        description: 'Đặt bằng 0 nếu không cần lưu nội dung đánh giá.',
        minimum: 0,
        maximum: 100000,
        default: 20
      },
      detailConcurrency: {
        type: 'integer',
        title: 'Số tác nhân lấy chi tiết cùng lúc',
        description: 'Mỗi tác nhân dùng một cửa sổ riêng, nhận sản phẩm không trùng và tự lấy chi tiết cùng đánh giá. Có thể chạy tối đa 6 tác nhân.',
        minimum: 1,
        maximum: 6,
        default: 1
      },
      allowEmpty: {
        type: 'boolean',
        title: 'Cho phép kết quả rỗng',
        default: false
      }
    }
  });
  const shopeeOutputSchema = JSON.stringify({
    type: 'object',
    required: ['itemId', 'shopId', 'title', 'price', 'url'],
    properties: {
      itemId: { type: 'string', title: 'Mã sản phẩm' },
      shopId: { type: 'string', title: 'Mã cửa hàng' },
      title: { type: 'string', title: 'Tên sản phẩm' },
      price: { type: 'string', title: 'Giá bán' },
      priceValue: { type: 'number', title: 'Giá bán dạng số' },
      priceMin: { type: 'number', title: 'Giá thấp nhất' },
      priceMax: { type: 'number', title: 'Giá cao nhất' },
      originalPrice: { type: 'number', title: 'Giá trước giảm' },
      discountPercent: { type: 'number', title: 'Phần trăm giảm giá' },
      currency: { type: 'string', title: 'Đơn vị tiền tệ' },
      sold: { type: ['string', 'number'], title: 'Đã bán' },
      searchKeyword: { type: 'string', title: 'Từ khóa tìm kiếm' },
      searchPage: { type: 'number', title: 'Trang kết quả' },
      searchPosition: { type: 'number', title: 'Vị trí trong trang' },
      searchRank: { type: 'number', title: 'Thứ hạng tìm kiếm' },
      isSponsored: { type: 'boolean', title: 'Sản phẩm quảng cáo' },
      campaignId: { type: 'string', title: 'Mã chiến dịch quảng cáo' },
      categoryId: { type: 'string', title: 'Mã danh mục' },
      isMall: { type: 'boolean', title: 'Shopee Mall' },
      isPreferred: { type: 'boolean', title: 'Shop yêu thích' },
      url: { type: 'string', format: 'uri', title: 'Liên kết sản phẩm' },
      image: { type: 'string', format: 'uri', title: 'Hình ảnh' },
      description: { type: 'string', title: 'Mô tả sản phẩm' },
      category: { type: 'string', title: 'Danh mục' },
      brand: { type: 'string', title: 'Thương hiệu' },
      rating: { type: 'number', title: 'Điểm đánh giá trung bình của sản phẩm' },
      ratingCount: { type: 'number', title: 'Tổng số lượt đánh giá sản phẩm' },
      ratingBreakdown: { type: 'array', title: 'Phân bố số sao' },
      reviewsCollected: { type: 'number', title: 'Số đánh giá đã thu thập' },
      reviewsRatingAverage: { type: 'number', title: 'Điểm trung bình của các đánh giá đã thu thập' },
      reviewsWithRating: { type: 'number', title: 'Số đánh giá thu thập có số sao' },
      reviews: { type: 'array', title: 'Nội dung đánh giá' },
      reviewsStatus: { type: 'string', title: 'Trạng thái lấy đánh giá' },
      reviewsError: { type: 'string', title: 'Lỗi khi lấy đánh giá' },
      totalSold: { type: 'number', title: 'Tổng lượt đã bán' },
      salesLast30Days: { type: 'number', title: 'Đã bán gần đây' },
      stock: { type: 'number', title: 'Tồn kho' },
      likedCount: { type: 'number', title: 'Lượt thích' },
      viewCount: { type: 'number', title: 'Lượt xem' },
      condition: { type: 'string', title: 'Tình trạng sản phẩm' },
      productCreatedAt: { type: 'string', format: 'date-time', title: 'Ngày đăng sản phẩm' },
      productUpdatedAt: { type: 'string', format: 'date-time', title: 'Ngày cập nhật sản phẩm' },
      shopName: { type: 'string', title: 'Tên cửa hàng' },
      shopUsername: { type: 'string', title: 'Tên đăng nhập cửa hàng' },
      shopDescription: { type: 'string', title: 'Giới thiệu cửa hàng' },
      shopLocation: { type: 'string', title: 'Nơi bán' },
      shopRating: { type: 'number', title: 'Điểm cửa hàng' },
      shopFollowerCount: { type: 'number', title: 'Người theo dõi cửa hàng' },
      shopResponseRate: { type: 'number', title: 'Tỷ lệ phản hồi của shop' },
      shopResponseTime: { type: 'number', title: 'Thời gian phản hồi của shop' },
      shopJoinedAt: { type: 'string', format: 'date-time', title: 'Ngày shop tham gia' },
      shopLastActiveAt: { type: 'string', format: 'date-time', title: 'Lần hoạt động gần nhất của shop' },
      shopProductCount: { type: 'number', title: 'Số sản phẩm của shop' },
      shopOnVacation: { type: 'boolean', title: 'Shop đang tạm nghỉ' },
      shopIsMall: { type: 'boolean', title: 'Cửa hàng Mall' },
      shopIsPreferred: { type: 'boolean', title: 'Cửa hàng yêu thích' },
      shopIsVerified: { type: 'boolean', title: 'Cửa hàng đã xác minh' },
      images: { type: 'array', title: 'Bộ ảnh sản phẩm' },
      attributes: { type: 'array', title: 'Thuộc tính' },
      variations: { type: 'array', title: 'Phân loại' },
      models: { type: 'array', title: 'Các phiên bản' },
      wholesaleTiers: { type: 'array', title: 'Giá bán sỉ' },
      promotions: { type: 'array', title: 'Khuyến mãi và voucher' },
      logistics: { type: 'array', title: 'Vận chuyển' },
      videos: { type: 'array', title: 'Video sản phẩm' },
      observedAt: { type: 'string', format: 'date-time', title: 'Thời điểm quan sát' },
      detailStatus: { type: 'string', title: 'Trạng thái chi tiết' },
      detailError: { type: 'string', title: 'Lỗi khi lấy chi tiết' },
      detailCrawledAt: { type: 'string', format: 'date-time', title: 'Thời gian lấy chi tiết' }
    }
  });

  // Create Shopee scraper actor
  const actor = await prisma.actor.upsert({
    where: { name: 'shopee-scraper' },
    update: {
      userId: null,
      inputSchema: shopeeInputSchema,
      outputSchema: shopeeOutputSchema
    },
    create: {
      name: 'shopee-scraper',
      description: 'Advanced stealth scraper for Shopee VN search results using Crawlee.',
      userId: null,
      inputSchema: shopeeInputSchema,
      outputSchema: shopeeOutputSchema
    }
  });

  console.log(`Actor seeded: ${actor.name}`);

  const tiktokInputSchema = JSON.stringify({
    type: 'object',
    required: ['keyword'],
    properties: {
      keyword: {
        type: 'string',
        title: 'Từ khóa tìm kiếm trên TikTok',
        minLength: 1
      },
      mode: {
        type: 'string',
        title: 'Chế độ tìm kiếm',
        default: 'videos',
        enum: ['videos', 'products'],
        enumNames: [
          'Video TikTok',
          'Sản phẩm TikTok Shop (cần tab Shop trên web)'
        ]
      },
      maxItems: {
        type: 'integer',
        title: 'Số lượng tối đa',
        minimum: 1,
        maximum: 500,
        default: 50
      },
      includeDetails: {
        type: 'boolean',
        title: 'Thu thập dữ liệu phân tích',
        description: 'Lấy mô tả, tác giả hoặc cửa hàng, tương tác, âm thanh, hashtag, giá và doanh số khi TikTok cung cấp.',
        default: true
      },
      maxReviewsPerProduct: {
        type: 'integer',
        title: 'Số bình luận / đánh giá tối đa mỗi mục',
        description: 'Với video sẽ thu thập bình luận; với sản phẩm TikTok Shop sẽ thu thập đánh giá hiển thị.',
        minimum: 0,
        maximum: 100000,
        default: 20
      },
      detailConcurrency: {
        type: 'integer',
        title: 'Số tab lấy chi tiết cùng lúc',
        description: 'TikTok hiện xử lý tuần tự; tùy chọn này được dành cho luồng nhiều tab.',
        minimum: 1,
        maximum: 6,
        default: 1
      }
    }
  });

  const tiktokOutputSchema = JSON.stringify({
    type: 'object',
    required: ['itemId', 'title', 'url'],
    properties: {
      itemId: { type: 'string', title: 'Mã sản phẩm / Video ID' },
      sourceType: { type: 'string', title: 'Loại dữ liệu' },
      title: { type: 'string', title: 'Tên sản phẩm / Tiêu đề Video' },
      description: { type: 'string', title: 'Mô tả' },
      price: { type: 'string', title: 'Giá bán' },
      priceValue: { type: 'number', title: 'Giá trị giá bán' },
      originalPrice: { type: 'number', title: 'Giá gốc' },
      currency: { type: 'string', title: 'Tiền tệ' },
      sold: { type: ['string', 'number'], title: 'Đã bán / Lượt xem' },
      views: { type: 'number', title: 'Lượt xem' },
      url: { type: 'string', format: 'uri', title: 'Liên kết TikTok' },
      image: { type: 'string', format: 'uri', title: 'Hình ảnh / Cover' },
      author: { type: 'string', title: 'Creator / Tên Shop' },
      authorId: { type: 'string', title: 'Mã Creator' },
      authorUrl: { type: 'string', format: 'uri', title: 'Trang Creator' },
      shopName: { type: 'string', title: 'Tên cửa hàng' },
      likes: { type: 'number', title: 'Lượt thích' },
      comments: { type: 'number', title: 'Lượt bình luận' },
      shares: { type: 'number', title: 'Lượt chia sẻ' },
      saves: { type: 'number', title: 'Lượt lưu' },
      duration: { type: 'number', title: 'Thời lượng video (giây)' },
      musicTitle: { type: 'string', title: 'Âm thanh' },
      hashtags: { type: 'array', title: 'Hashtag' },
      rating: { type: 'number', title: 'Điểm đánh giá' },
      reviewCount: { type: 'number', title: 'Số lượt đánh giá' },
      reviewsCollected: { type: 'number', title: 'Số bình luận / đánh giá đã thu thập' },
      reviews: { type: 'array', title: 'Nội dung bình luận / đánh giá' },
      reviewsStatus: { type: 'string', title: 'Trạng thái lấy bình luận / đánh giá' },
      reviewsError: { type: 'string', title: 'Lỗi lấy bình luận / đánh giá' },
      publishedAt: { type: 'string', format: 'date-time', title: 'Thời gian đăng' },
      searchKeyword: { type: 'string', title: 'Từ khóa tìm kiếm' },
      searchPage: { type: 'number', title: 'Lần tải kết quả' },
      searchPosition: { type: 'number', title: 'Vị trí trong kết quả' },
      searchRank: { type: 'number', title: 'Thứ hạng tìm kiếm' },
      observedAt: { type: 'string', format: 'date-time', title: 'Thời điểm quan sát' },
      detailStatus: { type: 'string', title: 'Mức độ đầy đủ dữ liệu' }
    }
  });

  const tiktokActor = await prisma.actor.upsert({
    where: { name: 'tiktok-scraper' },
    update: {
      userId: null,
      version: '1.2.0',
      inputSchema: tiktokInputSchema,
      outputSchema: tiktokOutputSchema
    },
    create: {
      name: 'tiktok-scraper',
      description: 'Browser Agent crawler for TikTok videos and available TikTok Shop web results.',
      version: '1.2.0',
      userId: null,
      inputSchema: tiktokInputSchema,
      outputSchema: tiktokOutputSchema
    }
  });

  console.log(`Actor seeded: ${tiktokActor.name}`);
  
  console.log('Seeding finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
