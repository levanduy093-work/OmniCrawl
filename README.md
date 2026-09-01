# OmniCrawl

OmniCrawl là dashboard web local-first để chạy các crawler qua Chrome Browser
Agent. Trình duyệt đang đăng nhập Shopee/TikTok thực hiện thu thập; API quản lý
run, dữ liệu và proxy.

## Các actor hiện có

| Actor | Đầu vào | Phạm vi |
| --- | --- | --- |
| `shopee-scraper` | Từ khóa | Có giới hạn `maxItems` theo mỗi run |
| `shopee-shop-scraper` | URL shop Shopee | Lấy toàn bộ sản phẩm shop, không có `maxItems` |
| `tiktok-scraper` | Từ khóa và chế độ tìm kiếm | Video TikTok hoặc sản phẩm TikTok Shop |

Shopee keyword và Shopee shop là hai actor độc lập, có schema và runtime riêng.

## Cấu trúc dự án

```text
apps/
├── api/                 REST API, xác thực, runs, datasets và proxy
├── browser-extension/   Chrome Browser Agent và runtime từng actor
│   └── actors/
│       ├── shopee-search/
│       ├── shopee-shop/
│       └── tiktok/
└── dashboard/           Giao diện web React/Vite
packages/
├── database/            Prisma schema, client và seed dữ liệu nền
└── sdk/                 Hợp đồng dữ liệu/run dùng chung
docs/
└── architecture.md      Luồng chạy và nguyên tắc mở rộng
```

Thư mục `storage/` là dữ liệu runtime do API tự tạo và đã được git bỏ qua.

`.env` chỉ cần cấu hình PostgreSQL như trong `.env.example`. API tự dùng địa chỉ
local và các cổng mặc định; khóa JWT cùng khóa mã hóa mật khẩu proxy được tạo
tự động trong `storage/` với quyền chỉ tài khoản hệ điều hành hiện tại được đọc.
Các biến nâng cao vẫn có thể được đặt khi triển khai đặc biệt, nhưng không cần
cho cách chạy local thông thường.

## Chạy local

Yêu cầu Node.js 20+, pnpm 9+ và PostgreSQL có extension `vector`, `pg_trgm`.

```bash
cp .env.example .env
docker compose -f docker-compose.example.yml up -d db
pnpm install
pnpm db:push
pnpm db:seed
pnpm dev
```

- Dashboard: `http://localhost:5173`
- API: `http://localhost:3001`
- Browser Agent: load unpacked thư mục `apps/browser-extension` tại
  `chrome://extensions`.

## Lệnh chính

```bash
pnpm dev       # API + dashboard
pnpm build     # Build toàn bộ source đang dùng
pnpm lint      # Kiểm tra dashboard
pnpm db:push   # Đồng bộ Prisma schema
pnpm db:seed   # Tạo/cập nhật actor mặc định
```

Chi tiết cách Browser Agent hoạt động nằm tại
[`apps/browser-extension/README.md`](apps/browser-extension/README.md).
