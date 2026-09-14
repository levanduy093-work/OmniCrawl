export const vi = {
  common: {
    close: 'Đóng',
    cancel: 'Hủy',
    confirm: 'Xác nhận',
    error: 'Lỗi'
  },
  sidebar: {
    crawlers: 'Crawlers',
    runs: 'Job Runs',
    browser: 'Trình duyệt',
    settings: 'Cài đặt',
    data: 'Dữ liệu job'
  },
  topbar: {
    searchPlaceholder: 'Tìm crawler hoặc job...',
    shopee: 'Shopee'
  },
  crawlers: {
    desc: 'Thu thập sản phẩm Shopee theo từ khóa bằng trình duyệt tích hợp.',
    shopeeNotOpen: 'Chưa mở trình duyệt',
    shopeeNotLoggedIn: 'Shopee: Chưa đăng nhập',
    shopeeOpen: 'Shopee: Đã mở',
    loginBtn: 'Đăng nhập',
    openShopeeBtn: 'Mở Shopee',
    keywordLabel: 'Từ khóa',
    keywordPlaceholder: 'Ví dụ: máy in 3d, filament pla',
    maxItemsLabel: 'Số sản phẩm tối đa',
    runBtn: 'Run',
    runningBtn: 'Đang tạo job...',
    addPlaceholderTitle: 'Thêm crawler mới',
    addPlaceholderDesc: 'Các crawler TikTok, Shopee Shop và nền tảng khác sẽ xuất hiện tại đây.'
  },
  runs: {
    emptyTitle: 'Chưa có job nào',
    emptyDesc: 'Chạy một crawler để bắt đầu thu thập dữ liệu.',
    openCrawlers: 'Mở Crawlers',
    table: {
      id: 'Mã job',
      crawler: 'Crawler',
      status: 'Trạng thái',
      items: 'Số dòng',
      started: 'Bắt đầu',
      duration: 'Thời lượng',
      actions: 'Thao tác'
    },
    viewData: 'Xem dữ liệu',
    stop: 'Dừng',
    statuses: {
      PENDING: 'Đang chờ',
      RUNNING: 'Đang chạy',
      PAUSED: 'Cần xử lý',
      STOPPING: 'Đang dừng',
      STOPPED: 'Đã dừng',
      SUCCESS: 'Hoàn tất',
      PARTIAL: 'Một phần',
      FAILED: 'Thất bại'
    }
  },
  browser: {
    reload: '↻ Tải lại',
    loginChrome: 'Đăng nhập qua Chrome',
    loginChromeBusy: 'Đang mở Chrome...',
    importCookie: 'Nhập Cookie',
    stopJob: 'Dừng job',
    openShopee: 'Mở Shopee',
    openingChrome: 'Đang mở Google Chrome... Bạn hãy đăng nhập tài khoản trên cửa sổ Chrome vừa mở.',
    loginChromeSuccess: 'Đăng nhập thành công! Đã trích xuất {count} cookie từ Chrome vào app.',
    connectChromeError: 'Lỗi khi kết nối Chrome.',
    cookieImportSuccess: 'Đã nạp thành công {count} cookie vào profile Shopee!',
    cookieImportError: 'Không thể nạp cookie.'
  },
  data: {
    backLink: '← Quay lại Job Runs',
    selectJob: 'Chọn một job',
    summary: '{actor} · {status} · {count} dòng',
    exportCsv: 'Xuất CSV',
    exportJsonl: 'JSONL',
    emptyTitle: 'Chưa có dữ liệu',
    emptyDesc: 'Dữ liệu sẽ xuất hiện ở đây khi crawler bắt đầu thu thập.'
  },
  settings: {
    localTitle: 'Lưu trữ trên máy',
    localDesc: 'Dữ liệu crawl và phiên đăng nhập được lưu riêng trên máy này.',
    cloudTitle: 'Đồng bộ đám mây',
    cloudDesc: 'Chưa bật. Hiện tại không có dữ liệu nào được gửi lên server.',
    cloudState: 'Đang tắt',
    crawlersTitle: 'Crawlers',
    crawlersDesc: 'Đã cài {count} crawler. Shopee Search là crawler đầu tiên trên desktop.',
    languageTitle: 'Ngôn ngữ hiển thị',
    languageDesc: 'Chọn ngôn ngữ cho ứng dụng Desktop.'
  },
  cookieModal: {
    title: 'Nhập Cookie Shopee',
    desc: 'Dán chuỗi cookie (SPC_EC=...; SPC_U=...) hoặc mảng JSON từ Extension (Cookie-Editor):',
    placeholder: 'Dán Cookie vào đây...',
    cancel: 'Hủy',
    apply: 'Áp dụng & Lưu Cookie'
  }
}
