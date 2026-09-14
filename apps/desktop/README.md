# OmniCrawl Desktop

OmniCrawl Desktop là runtime local-first độc lập với API, Dashboard và Chrome
Extension hiện tại. Desktop shell, browser profiles, SQLite, scheduler, export
và sync outbox đều nằm trong package này.

Shopee Search là vertical slice đầu tiên. Actor runtime được đăng ký qua
`src/main/actors/registry.ts`; không đưa logic theo nền tảng vào Electron shell
hoặc database layer.

## Chạy local

```bash
pnpm install
pnpm --filter @omnicrawl/desktop rebuild:native
pnpm desktop:build
pnpm desktop:start
```

Trong development, `better-sqlite3` phải được rebuild theo Electron ABI sau
khi đổi Electron hoặc Node dependency. Dữ liệu runtime được lưu tại thư mục
`userData/runtime` của `OmniCrawl Desktop`, không dùng PostgreSQL hoặc `storage/`
của API hiện tại.

## Ranh giới an toàn

- Remote pages chạy với `nodeIntegration: false`, context isolation và sandbox.
- Navigation chỉ cho hostname được khai báo trong Browser Manager.
- Shopee dùng profile `persist:omnicrawl-shopee-default` riêng của desktop app.
- Cookie, localStorage và browser profile không được ghi vào sync outbox.
- Cloud sync mặc định tắt; outbox chỉ được lưu local.
- API, Dashboard và Browser Extension hiện tại không được import vào runtime mới.

## Thêm actor

1. Implement `DesktopActor` trong `src/main/actors/`.
2. Khai báo input schema, capability và platform trong actor summary.
3. Dùng `ActorExecutionContext` cho browser, dataset, log, stop signal và progress.
4. Đăng ký actor trong bootstrap hiện tại; bước sau sẽ chuyển bootstrap sang
   manifest discovery khi có từ hai platform trở lên.

Không tải hoặc thực thi actor code tùy ý từ cloud. Actor phát hành cùng desktop
artifact và phải qua build/test của ứng dụng.
