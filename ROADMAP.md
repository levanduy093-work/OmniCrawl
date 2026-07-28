# Bản Kế Hoạch Phát Triển OmniCrawl Platform

Tài liệu này phác thảo lộ trình xây dựng OmniCrawl từ con số không, áp dụng mô hình "Actor" và tận dụng các công nghệ Open Source hiện đại để đảm bảo khả năng mở rộng (scalability) mà không cần dùng các nền tảng có sẵn như Crawlab.

## 1. Lựa Chọn Công Nghệ (Tech Stack)

Để đảm bảo xây dựng nhanh, ổn định và dễ mở rộng, hệ thống sẽ được chia thành các service độc lập:

| Thành phần | Công nghệ đề xuất | Lý do lựa chọn |
| :--- | :--- | :--- |
| **Backend Core (API & Worker)** | Node.js (NestJS) / TypeScript | Hỗ trợ DI (Dependency Injection), dễ viết Microservices, cộng đồng lớn. Dễ đồng nhất ngôn ngữ với các Actor SDK (Crawlee). |
| **Actor SDK (Base Crawler)** | Crawlee (Node.js/TS) | SDK tuyệt vời đã có sẵn logic RequestQueue, Dataset, Proxy, Anti-ban. |
| **Job Queue & Scheduler** | Redis + BullMQ | Nhẹ, dễ tích hợp với Node.js, hỗ trợ Cronjob, Retry, Delay, Rate Limit cực tốt. |
| **Database (Meta & State)** | PostgreSQL + Prisma ORM | Lưu trữ Schema, User, Actor config, Run logs với tính toàn vẹn dữ liệu cao. |
| **Actor Runtime (Execution)** | Docker Engine API | Chạy mỗi Crawler trong 1 container cô lập. Dễ dàng limit CPU/RAM. |
| **Storage (Dataset & K-V)** | MinIO (Object Storage) & Postgres | MinIO lưu trữ file, JSON lớn. Postgres lưu trữ Dataset có cấu trúc. |
| **Frontend (Dashboard)** | Next.js / Vue 3 + TailwindCSS | Phát triển giao diện quản lý nhanh, UI/UX hiện đại. |

---

## 2. Lộ Trình Phát Triển (Roadmap)

Dự án được chia thành 5 giai đoạn. Mỗi giai đoạn mang lại một giá trị cốt lõi và có thể sử dụng được ngay.

### Giai đoạn 1: Lõi Thực Thi (MVP & Local Execution)
**Mục tiêu:** Chạy được một Actor (đóng gói bằng Docker) thông qua CLI và lưu lại kết quả cơ bản.

- [ ] **Thiết kế chuẩn Actor:** Định nghĩa `actor.json` (chứa input schema, output schema, metadata).
- [ ] **OmniCrawl CLI:** Viết công cụ CLI (`omnicrawl init`, `omnicrawl run`) để lập trình viên tạo template và test crawler ở local.
- [ ] **Tích hợp Crawlee:** Tạo template cơ bản sử dụng Crawlee làm SDK lõi.
- [ ] **Docker Execution:** Viết module backend gọi Docker API để `build` và `run` Actor container. Truyền Input vào container qua biến môi trường (ENV) hoặc file JSON.
- [ ] **Local Storage:** Lưu kết quả (Dataset, Log) ra thư mục local dạng JSON/CSV.

> [!TIP]
> Giai đoạn này chưa cần Database hay Queue phức tạp. Tập trung vào việc **chuẩn hóa định dạng Input/Output** của một Actor.

### Giai đoạn 2: Nền Tảng Cơ Bản (Platform & API)
**Mục tiêu:** Đưa hệ thống lên Server, quản lý qua API & Dashboard, có Hàng đợi (Queue).

- [ ] **Backend API (NestJS):** Xây dựng REST API quản lý Actors, Runs, Users cơ bản.
- [ ] **Database (PostgreSQL):** Thiết kế schema cho `actors`, `actor_runs`, `actor_versions`.
- [ ] **Job Queue (BullMQ):**
  - Khi user gọi API chạy Actor, đẩy Job vào Queue.
  - Worker (thuộc Backend) sẽ lấy Job từ Queue và khởi động Docker container.
- [ ] **Lưu trữ tập trung (MinIO/Postgres):** Chuyển việc lưu Dataset và Log từ local file lên Database/MinIO. Xây dựng API để tải kết quả.
- [ ] **Dashboard V1:** Giao diện web cơ bản để xem danh sách Actor, bấm nút Run, xem trạng thái (Running, Succeeded, Failed) và tải file kết quả.

### Giai đoạn 3: Phân Tán & Tự Động Hóa (Distributed & Automation)
**Mục tiêu:** Chạy trên nhiều máy chủ, tự động lập lịch và quản lý tài nguyên.

- [ ] **Distributed Workers:** Tách Worker ra khỏi Backend API. Cài đặt Worker Daemon trên các máy chủ (Node) khác nhau. Các Worker tự động kết nối về Redis Queue để nhận việc.
- [ ] **Scheduler (Cronjob):** Tích hợp tính năng lập lịch chạy Actor (VD: cào giá Shopee mỗi 6 giờ).
- [ ] **Resource Limits:** Cấu hình giới hạn CPU, RAM cho mỗi Docker Run. Ngăn chặn crawler làm sập máy chủ.
- [ ] **Proxy Manager:** Tích hợp tính năng xoay vòng Proxy, cung cấp Proxy HTTP Endpoint nội bộ cho các Actor sử dụng.
- [ ] **Webhooks:** Bắn HTTP request về hệ thống của khách hàng khi Crawler chạy xong.

> [!IMPORTANT]
> Đây là giai đoạn hệ thống bắt đầu phức tạp. Cần xử lý tốt các trường hợp lỗi như Worker bị sập đột ngột (Zombie Runs), Docker treo, cạn kiệt RAM.

### Giai đoạn 4: Hệ Sinh Thái (Actor Ecosystem)
**Mục tiêu:** Xây dựng chợ ứng dụng nội bộ, cho phép tái sử dụng.

- [ ] **Actor Registry:** Nơi lưu trữ mã nguồn và version của các Actor (giống Docker Hub nội bộ).
- [ ] **Input UI Auto-generation:** Tự động sinh ra Form nhập liệu trên Dashboard dựa vào `Input Schema` (JSON Schema) của Actor.
- [ ] **Plugin/Connector:** Viết các Actor chuyên làm nhiệm vụ đẩy dữ liệu (Ví dụ: Đẩy Dataset vào Google Sheets, Slack, MySQL).
- [ ] **Community Templates:** Cung cấp sẵn các mẫu Actor phổ biến (Tiktok Scraper, E-commerce Scraper).

### Giai đoạn 5: Enterprise Ready
**Mục tiêu:** Sẵn sàng cho doanh nghiệp, đa người dùng, bảo mật cao.

- [ ] **Multi-tenancy & IAM:** Quản lý User, Organization, Role (RBAC) chặt chẽ.
- [ ] **Secret Manager:** Cho phép user lưu API Key, Password an toàn mà không lộ trong code hay log.
- [ ] **Billing / Quota:** (Tùy chọn) Tính toán thời gian chạy (Compute Units) để thu phí hoặc giới hạn tài nguyên.
- [ ] **Kubernetes Native (Tùy chọn):** Nâng cấp từ việc gọi Docker API thô sơ lên việc tạo `K8s Jobs` để tận dụng sức mạnh autoscaling của Kubernetes.

---

## Kế Hoạch Hành Động 30 Ngày Đầu Tiên (Cho Giai đoạn 1)

1. **Tuần 1: Khởi tạo kiến trúc & Chuẩn hóa Actor**
   - Viết đặc tả kĩ thuật (Spec) cho `actor.json`, định dạng Input/Output.
   - Dựng khung dự án CLI bằng Node.js.
2. **Tuần 2: Tích hợp SDK (Crawlee) & Hello World**
   - Tạo bộ khung (Template) cơ bản cho Actor dùng Crawlee.
   - Viết thành công 1 crawler mẫu (VD: cào tin tức HackerNews).
3. **Tuần 3: Docker Engine API**
   - Viết script Node.js gọi Docker API để build image từ mã nguồn Actor.
   - Chạy container truyền Input qua ENV và nhận Output.
4. **Tuần 4: Hoàn thiện CLI & Demo**
   - Hoàn thiện lệnh `omnicrawl run`.
   - Bắt log từ container in ra màn hình console.
   - Đóng gói thành bản Alpha v0.1.0 để demo nội bộ.
