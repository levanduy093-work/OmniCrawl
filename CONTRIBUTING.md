# Đóng góp cho OmniCrawl

Cảm ơn bạn muốn đóng góp. Trước khi bắt đầu thay đổi lớn hoặc thêm actor mới,
hãy mở issue mô tả nhu cầu, phạm vi dữ liệu và cách kiểm thử dự kiến.

## Thiết lập

1. Cài Node.js 20+ và pnpm 9+.
2. Chạy `cp .env.example .env`, điền cấu hình local và không commit file này.
3. Chạy `pnpm install`.
4. Làm theo phần cài đặt database trong `README.md` nếu thay đổi Web/API.

## Trước khi gửi pull request

```bash
pnpm check
pnpm desktop:build
gitleaks detect --source . --redact
```

- Giữ pull request tập trung vào một mục tiêu.
- Không đưa cookie, token, proxy credential, `.env`, dữ liệu crawl, HTML snapshot,
  log runtime hoặc browser profile vào commit.
- Thêm hoặc cập nhật test cho logic bảo mật và biến đổi dữ liệu.
- Mô tả rõ phần đã kiểm tra bằng code/build và phần đã xác nhận bằng live run.
- Không dùng automation để né CAPTCHA, rate limit hoặc cơ chế kiểm soát truy cập
  của nền tảng.

## Thêm actor

Giữ input/output schema ổn định, định danh item có thể lặp lại, ghi kết quả tăng
dần và dừng minh bạch khi cần người dùng xử lý. Không tải và thực thi actor code
tùy ý từ nguồn bên ngoài.
