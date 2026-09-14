# Chính sách bảo mật

## Phiên bản được hỗ trợ

OmniCrawl đang ở giai đoạn phát triển ban đầu. Bản mới nhất trên nhánh `main` là
phiên bản duy nhất nhận bản vá bảo mật.

## Báo cáo lỗ hổng

Không tạo issue công khai cho lỗ hổng chưa được vá và không gửi secret, cookie,
proxy credential hoặc dữ liệu người dùng vào issue hay pull request.

Hãy dùng tính năng **Report a vulnerability** trong tab **Security** của GitHub
repository. Báo cáo nên gồm phạm vi ảnh hưởng, cách tái hiện tối thiểu và đề xuất
khắc phục nếu có. Nếu private vulnerability reporting chưa được bật, hãy liên hệ
chủ repository qua hồ sơ GitHub và chỉ gửi chi tiết sau khi có kênh riêng.

## Nếu credential bị lộ

1. Thu hồi hoặc rotate credential ngay tại nhà cung cấp.
2. Xóa credential khỏi source và lịch sử Git; chỉ xóa file ở commit mới là chưa
   đủ.
3. Kiểm tra log truy cập và phạm vi quyền của credential.
4. Thông báo cho người bị ảnh hưởng nếu có dữ liệu người dùng liên quan.

OmniCrawl không cần cookie trình duyệt trong API và không được commit `.env`,
database local, export dataset, log, HTML snapshot hoặc browser profile.
