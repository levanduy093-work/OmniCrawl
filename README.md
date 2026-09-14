# OmniCrawl

OmniCrawl là nền tảng thu thập dữ liệu thương mại điện tử theo mô hình actor,
ưu tiên chạy local và để người dùng kiểm soát phiên trình duyệt. Repository hiện
có hai runtime độc lập:

- **Web + Browser Agent:** Dashboard tạo và theo dõi run, API lưu dữ liệu trong
  PostgreSQL, còn Chrome/Edge Extension thu thập trong phiên đã đăng nhập.
- **Desktop:** ứng dụng Electron thử nghiệm chạy độc lập với API/PostgreSQL,
  dùng trình duyệt nhúng và SQLite local. Hiện desktop mới hỗ trợ Shopee Search.

> Build thành công chỉ xác nhận source có thể biên dịch. Crawl thực tế còn phụ
> thuộc phiên đăng nhập, giao diện/API nền tảng, quyền Incognito, proxy (nếu bật)
> và CAPTCHA hoặc traffic challenge.

## Tính năng

- Quản lý tài khoản với vai trò `USER`, `ADMIN` và `SUPER_ADMIN`.
- Tạo, dừng, xóa, theo dõi tiến độ và xem log từng run.
- Xem dataset theo trang, lọc và xuất kết quả.
- Browser Agent giữ cookie trong Chrome/Edge; cookie không được gửi về API.
- Quản lý proxy tùy chọn, mã hóa credential và kiểm tra trước khi giao job.
- Dashboard và desktop hỗ trợ tiếng Việt/tiếng Anh.
- Desktop lưu dữ liệu trong SQLite và xuất CSV/JSONL.

## Actor hiện có

| Actor | Runtime | Đầu vào chính | Kết quả |
| --- | --- | --- | --- |
| `shopee-scraper` | Browser Agent và Desktop | Từ khóa, bộ lọc, giới hạn item | Danh sách sản phẩm; Browser Agent có thể lấy chi tiết |
| `shopee-shop-scraper` | Browser Agent | URL shop Shopee | Sản phẩm hiển thị qua phân trang của shop |
| `tiktok-scraper` | Browser Agent | Từ khóa, chế độ video hoặc TikTok Shop | Video hoặc sản phẩm TikTok Shop |

Shopee Search và Shopee Shop là hai actor riêng, có input schema và vòng đời
riêng. Desktop hiện chỉ đăng ký `shopee-scraper`; không nên xem desktop là bản
thay thế hoàn chỉnh cho Browser Agent.

## Kiến trúc

Luồng Web + Browser Agent:

```text
Dashboard -> REST API -> PostgreSQL
    ^            ^            |
    |            |            v
    +------ Chrome/Edge Browser Agent
```

1. Dashboard gửi input của actor đến API.
2. API kiểm tra schema, ghi input bền vững rồi đưa run vào hàng đợi
   `BROWSER_PENDING`.
3. Extension nhận job và chạy actor trong tab của profile đã đăng nhập.
4. Extension gửi item, log và trạng thái về API; Dashboard hiển thị kết quả.
5. Nếu gặp CAPTCHA hoặc traffic challenge, run dừng để người dùng xử lý.

Luồng Desktop:

```text
React renderer -> IPC đã kiểm tra -> Electron main
                                   ├── Browser manager + profile riêng
                                   ├── Actor runtime
                                   └── SQLite + CSV/JSONL export
```

Xem thêm [docs/architecture.md](docs/architecture.md).

## Cấu trúc repository

```text
apps/
├── api/                 REST API, auth, run, dataset và proxy
├── browser-extension/   Chrome/Edge Browser Agent và actor runtime
├── dashboard/           React 19 + Vite dashboard
└── desktop/             Electron app, browser nhúng và SQLite local
packages/
├── database/            Prisma schema, PostgreSQL client và seed
└── sdk/                 Hợp đồng dữ liệu và storage dùng chung
docs/
└── architecture.md      Kiến trúc Web + Browser Agent
```

`node_modules/`, `dist/`, `coverage/`, cache TypeScript và `storage/` là dữ liệu
sinh ra, không thuộc source và đã được Git bỏ qua.

## Yêu cầu

- Node.js 20+
- pnpm 9+
- Docker (khuyến nghị cho PostgreSQL local)
- Chrome hoặc Edge nếu dùng Browser Agent
- PostgreSQL 15 với extension `vector` và `pg_trgm` nếu không dùng container mẫu

## Cài đặt Web + Browser Agent

### 1. Tạo cấu hình local

```bash
cp .env.example .env
```

Đổi `POSTGRES_PASSWORD` và mật khẩu trong `DATABASE_URL` về cùng một giá trị.

| Biến | Bắt buộc | Mô tả |
| --- | --- | --- |
| `DATABASE_URL` | Có | Chuỗi kết nối PostgreSQL cho Prisma/API |
| `POSTGRES_USER` | Khi dùng Compose | Tài khoản PostgreSQL |
| `POSTGRES_PASSWORD` | Khi dùng Compose | Mật khẩu PostgreSQL |
| `POSTGRES_DB` | Khi dùng Compose | Tên database |
| `HOST` | Không | Host API, mặc định `127.0.0.1` |
| `PORT` | Không | Cổng API, mặc định `3001` |
| `JWT_SECRET` | Không | Nếu trống, API tạo secret local trong `storage/` |
| `ADMIN_EMAIL` | Không | Email admin được tạo khi seed |
| `ADMIN_PASSWORD` | Khi chạy seed | Mật khẩu admin tối thiểu 12 ký tự; seed sẽ dừng nếu thiếu hoặc quá ngắn |

Không commit `.env`. Khóa runtime và log trong `storage/` cũng chỉ dành cho máy
local.

### 2. Khởi động database và cài dependency

```bash
docker compose -f docker-compose.example.yml up -d db
pnpm install
pnpm db:push
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD='replace-with-a-strong-password' pnpm db:seed
```

`db:push` đồng bộ Prisma schema. `db:seed` tạo/cập nhật actor mặc định và tài
khoản quản trị ban đầu.

### 3. Chạy API và Dashboard

```bash
pnpm dev
```

- Dashboard: <http://localhost:5173>
- API: <http://localhost:3001>

Dashboard hiện gọi API local ở cổng `3001`. Nếu đổi `PORT`, cần cập nhật URL API
trong dashboard và Browser Agent.

### 4. Cài Browser Agent

1. Mở `chrome://extensions` hoặc `edge://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ đến `apps/browser-extension`.
4. Trong chi tiết extension, bật **Allow in Incognito** nếu dùng luồng chi tiết
   sản phẩm Shopee.
5. Dùng browser profile riêng cho OmniCrawl, đăng nhập Shopee/TikTok rồi mở
   Dashboard.

Proxy Chrome áp dụng cho toàn bộ profile khi run hoạt động. Nếu đã cấu hình
proxy, Browser Agent chỉ chạy khi proxy đạt kiểm tra sẵn sàng và không âm thầm
fallback về IP máy. Xem [hướng dẫn Browser Agent](apps/browser-extension/README.md).

## Chạy Desktop

Desktop không cần PostgreSQL, API hay Browser Agent:

```bash
pnpm install
pnpm --filter @omnicrawl/desktop rebuild:native
pnpm desktop:build
pnpm desktop:start
```

Chế độ phát triển:

```bash
pnpm desktop:dev
```

Dữ liệu nằm trong `userData/runtime` của **OmniCrawl Desktop** trên hệ điều hành.
Profile trình duyệt desktop tách biệt với Chrome thông thường. Xem
[hướng dẫn Desktop](apps/desktop/README.md).

## Lệnh phát triển

| Lệnh | Công dụng |
| --- | --- |
| `pnpm dev` | Build package dùng chung rồi chạy API và Dashboard |
| `pnpm build` | Build database, SDK, API và Dashboard |
| `pnpm lint` | Chạy Oxlint cho Dashboard |
| `pnpm db:push` | Đồng bộ Prisma schema với PostgreSQL |
| `pnpm db:seed` | Seed tài khoản quản trị và actor mặc định |
| `pnpm desktop:dev` | Chạy Electron + Vite ở chế độ phát triển |
| `pnpm desktop:build` | Build Electron main process và renderer |
| `pnpm desktop:start` | Chạy desktop từ output đã build |
| `pnpm check` | Chạy lint, build, desktop typecheck và test bảo mật proxy |

Kiểm tra trước khi commit:

```bash
pnpm lint
pnpm build
pnpm --filter @omnicrawl/desktop typecheck
pnpm desktop:build
pnpm --filter @omnicrawl/api test:proxy-security
```

Sau khi sửa Browser Agent, bấm **Reload** ở trang extension rồi reload Dashboard;
extension không có bước compile.

## Dữ liệu, bảo mật và giới hạn

- Không commit `.env`, database local, log, cookie, browser profile hoặc proxy
  credential.
- Proxy credential lưu trong database ở dạng mã hóa bằng khóa runtime local.
- Remote page trong desktop chạy với `nodeIntegration: false`, context isolation
  và sandbox; renderer chỉ gọi main process qua IPC đã giới hạn.
- Dùng tốc độ thu thập hợp lý, tuân thủ điều khoản nền tảng và dừng để xử lý khi
  gặp CAPTCHA/traffic control.
- Selector và endpoint Shopee/TikTok có thể thay đổi. Luôn xác nhận bằng một run
  được phép trước khi coi actor là hoạt động đầy đủ.

## Khắc phục nhanh

- **Dashboard không gọi được API:** kiểm tra API ở `127.0.0.1:3001` và cổng không
  bị ứng dụng khác chiếm.
- **Không thấy actor:** chạy `pnpm db:seed`, sau đó đăng nhập lại Dashboard.
- **Browser Agent offline:** reload extension, reload Dashboard và kiểm tra quyền
  truy cập `localhost:3001`.
- **Không chạy được chi tiết Shopee:** bật quyền Incognito cho extension.
- **Desktop lỗi `better-sqlite3` ABI:** chạy
  `pnpm --filter @omnicrawl/desktop rebuild:native`.
- **Proxy đã bật nhưng run bị chặn:** kiểm tra lại proxy trong Proxy Manager; hệ
  thống cố ý không fallback về kết nối trực tiếp.

## Giấy phép

Phát hành theo giấy phép MIT. Xem [LICENSE](LICENSE).

Để đóng góp, xem [CONTRIBUTING.md](CONTRIBUTING.md). Vấn đề bảo mật cần được báo
theo [SECURITY.md](SECURITY.md), không đăng credential hoặc dữ liệu nhạy cảm vào
issue công khai.
