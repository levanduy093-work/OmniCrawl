# Kiến trúc OmniCrawl

## Luồng chạy

```text
Dashboard -> API -> PostgreSQL
    ^          ^         |
    |          |         v
    +-- Chrome Browser Agent <- hàng đợi run
```

1. Dashboard tạo một run qua API.
2. API kiểm tra input theo schema actor và ghi run ở trạng thái
   `BROWSER_PENDING`.
3. Chrome Browser Agent nhận run, gọi runtime đúng actor và thu thập trong tab
   trình duyệt đã đăng nhập.
4. Agent đẩy items, log và trạng thái về API; Dashboard đọc kết quả từ API.

API không tự mở trình duyệt và không sở hữu cookie Shopee/TikTok.

## Ranh giới module

- `apps/dashboard`: chỉ chứa UI và gọi REST API.
- `apps/api`: sở hữu auth, run state, dataset, export và proxy configuration.
- `apps/browser-extension`: sở hữu browser automation và chống trùng dữ liệu.
- `packages/database`: sở hữu Prisma schema và actor seed.
- `packages/sdk`: sở hữu định dạng input/output và lưu trữ run dùng chung.

## Thêm actor mới

1. Tạo runtime riêng tại `apps/browser-extension/actors/<actor-name>/`.
2. Đăng ký runtime trong `apps/browser-extension/service-worker.js`.
3. Thêm input/output schema vào `packages/database/prisma/seed.ts`.
4. Thêm form/nhãn riêng trong `apps/dashboard/src/App.tsx` nếu schema mặc định
   chưa đủ.
5. Chạy `pnpm db:seed`, `pnpm build`, sau đó reload extension.

Không gộp runtime của hai actor chỉ vì chúng cùng nền tảng. Ví dụ Shopee tìm
theo từ khóa và Shopee crawl theo URL shop phải tiếp tục độc lập.
