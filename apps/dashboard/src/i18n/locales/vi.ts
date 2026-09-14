export const vi = {
  common: {
    loading: 'Đang tải...',
    close: 'Đóng',
    cancel: 'Hủy',
    save: 'Lưu',
    confirm: 'Xác nhận',
    refresh: 'Làm mới',
    error: 'Đã có lỗi xảy ra',
    yes: 'Có',
    no: 'Không',
    search: 'Tìm kiếm...',
    openInNewTab: 'Mở tab mới',
    actions: 'Thao tác'
  },
  auth: {
    welcomeTitle: 'Chào mừng đến với OmniCrawl',
    registerTitle: 'Tạo tài khoản mới',
    welcomeSubtitle: 'Vui lòng đăng nhập để tiếp tục.',
    registerSubtitle: 'Đăng ký tài khoản để bắt đầu thu thập dữ liệu.',
    emailPlaceholder: 'Địa chỉ email',
    passwordPlaceholder: 'Mật khẩu',
    signInButton: 'Đăng nhập',
    signUpButton: 'Đăng ký',
    alreadyHaveAccount: 'Đã có tài khoản?',
    dontHaveAccount: 'Chưa có tài khoản?',
    switchSignIn: 'Đăng nhập',
    switchSignUp: 'Đăng ký ngay'
  },
  sidebar: {
    brand: 'OmniCrawl',
    crawlers: 'Trình thu thập',
    runs: 'Lịch sử chạy',
    proxies: 'Quản lý Proxy',
    settings: 'Cài đặt',
    support: 'Ủng hộ dự án',
    logout: 'Đăng xuất',
    collapse: 'Thu gọn thanh bên',
    expand: 'Mở rộng thanh bên'
  },
  header: {
    searchPlaceholder: 'Tìm kiếm tác vụ, crawler, ID...',
    proxyManager: 'Quản lý Proxy'
  },
  alerts: {
    proxyInactiveTitle: 'Proxy không hoạt động',
    proxyInactiveDefault: 'Không có proxy khả dụng để chạy crawler.',
    proxyManageBtn: 'Quản lý proxy',
    agentConnected: 'Agent v{version}',
    agentReloadNeeded: 'Cần Reload Extension',
    agentNotConnected: 'Chưa kết nối Extension',
    shopeeLoggedIn: 'Shopee: Đã đăng nhập',
    shopeeNotLoggedIn: 'Shopee: Chưa đăng nhập',
    tiktokLoggedIn: 'TikTok: Đã đăng nhập',
    tiktokNotLoggedIn: 'TikTok: Chưa đăng nhập',
    openLogin: 'Mở Đăng Nhập',
    tiktokBetaBadge: 'Chưa hoạt động tốt',
    tiktokBetaTitle: 'Trạng thái: Chưa hoạt động ổn định (Beta)',
    tiktokBetaDesc: 'TikTok Scraper hiện có thể gặp gián đoạn hoặc thiếu dữ liệu do cơ chế chống crawl của TikTok. Đang được nâng cấp.',
    safetyWarningTitle: 'Cảnh báo an toàn:',
    safetyWarningDesc: 'Kéo trên 200 sản phẩm bằng mạng WiFi cá nhân có nguy cơ bị sàn thương mại điện tử chặn IP hoặc yêu cầu xác minh CAPTCHA liên tục. Hãy đảm bảo bạn chia nhỏ số lượng hoặc sử dụng mạng Proxy nếu muốn tiếp tục.'
  },
  actors: {
    run: 'Chạy crawler',
    running: 'Đang chạy...',
    noDescription: 'Chưa có mô tả cho crawler này.',
    maxItemsLimit: '(Tối đa {max})',
    triggerSuccess: 'Khởi động crawler thành công!',
    triggerFailed: 'Khởi động crawler thất bại: {error}',
    proxyUnavailable: 'Proxy đã cấu hình nhưng hiện không hoạt động.'
  },
  runs: {
    table: {
      id: 'Mã',
      crawler: 'Crawler',
      status: 'Trạng thái',
      items: 'Số dòng',
      createdAt: 'Thời gian tạo',
      finishedAt: 'Kết thúc',
      duration: 'Thời lượng',
      actions: 'Thao tác'
    },
    status: {
      SUCCESS: 'Hoàn tất',
      PARTIAL: 'Một phần',
      FAILED: 'Thất bại',
      RUNNING: 'Đang chạy',
      BROWSER_RUNNING: 'Đang chạy (Browser)',
      STOPPING: 'Đang dừng',
      STOPPED: 'Đã dừng',
      PENDING: 'Đang chờ',
      BROWSER_PENDING: 'Đang chờ (Browser)'
    },
    actions: {
      view: 'Xem',
      logs: 'Nhật ký',
      stop: 'Dừng',
      delete: 'Xóa'
    },
    confirmDelete: 'Bạn có chắc chắn muốn xóa lượt chạy này?',
    deleteError: 'Lỗi khi xóa: {error}',
    stopError: 'Không thể dừng tiến trình: {error}'
  },
  proxies: {
    pool: {
      title: 'Proxy pool',
      notInUse: 'Không sử dụng',
      ready: 'Sẵn sàng',
      notReady: 'Không sẵn sàng',
      total: 'Tổng số',
      alive: 'Dùng được',
      latency: 'Độ trễ'
    },
    add: {
      title: 'Thêm proxy',
      formatHint: 'host:port:user:pass hoặc URL http://',
      textareaLabel: 'Danh sách proxy',
      textareaPlaceholder: 'proxy.example.com:8080:user:password\nhttp://user:password@proxy.example.com:8080',
      advancedOptions: 'Tùy chọn nâng cao',
      country: 'Quốc gia',
      autoRotate: 'Nhà cung cấp tự xoay IP',
      submit: 'Thêm proxy và kiểm tra',
      submitting: 'Đang thêm và kiểm tra…',
      recheck: 'Kiểm tra lại',
      refresh: 'Làm mới'
    },
    results: {
      imported: 'Đã thêm {imported}, bỏ qua {skipped} proxy trùng{failedInfo}.',
      failedPart: ', {failed} dòng không hợp lệ',
      checkDone: 'Kiểm tra xong: {alive} dùng được, {dead} không hoạt động.',
      apiError: 'Không kết nối được API proxy.',
      addError: 'Không thể thêm proxy.'
    },
    groups: {
      proxiesCount: '{count} proxy',
      default: 'Mặc định',
      enabled: 'Đang bật',
      disabled: 'Đã tắt',
      deleteTitle: 'Xóa nhóm',
      confirmDelete: 'Xóa nhóm proxy này và tất cả proxy bên trong?',
      empty: 'Chưa có proxy nào trong nhóm này. Dùng nút Thêm proxy để bắt đầu.'
    },
    table: {
      status: 'Trạng thái',
      host: 'Host',
      port: 'Port',
      protocol: 'Giao thức',
      user: 'Tài khoản',
      country: 'Quốc gia',
      latency: 'Độ trễ',
      success: 'Thành công',
      fails: 'Thất bại',
      actions: 'Thao tác'
    },
    statusLabel: {
      ALIVE: 'Hoạt động',
      DEAD: 'Chết',
      SLOW: 'Chậm',
      UNKNOWN: 'Chưa rõ'
    },
    actions: {
      enable: 'Kích hoạt',
      disable: 'Vô hiệu hóa',
      reset: 'Làm mới trạng thái',
      delete: 'Xóa proxy'
    }
  },
  settings: {
    title: 'Cài đặt tài khoản',
    emailLabel: 'Địa chỉ Email',
    emailHint: 'Email không thể thay đổi.',
    languageLabel: 'Ngôn ngữ hiển thị',
    languageDesc: 'Chọn ngôn ngữ bạn muốn sử dụng trên giao diện OmniCrawl.'
  },
  logModal: {
    title: 'Nhật ký trực tiếp:',
    noLogs: 'Không có nhật ký khả dụng.',
    errorLogs: 'Lỗi khi tải nhật ký.'
  },
  runDetail: {
    title: 'Dữ liệu thu thập',
    downloadJsonl: 'Tải JSON Lines',
    allProducts: 'Tất cả sản phẩm',
    failedProducts: 'Sản phẩm lỗi',
    loading: 'Đang tải dữ liệu…',
    loadError: 'Không thể tải dữ liệu: {error}',
    empty: 'Lượt chạy này chưa có bản ghi dữ liệu nào.',
    unableToLoad: 'Không thể tải dữ liệu lượt chạy.',
    pagination: 'Trang {page} / {totalPages} · Tổng {total} sản phẩm',
    prevPage: 'Trang trước',
    nextPage: 'Trang sau',
    shopInfo: {
      avatarAlt: 'Ảnh đại diện {name}',
      preferred: 'Yêu thích',
      mall: 'Chính hãng',
      verified: 'Đã xác minh',
      activeText: 'Hoạt động {time}',
      openShop: 'Mở shop',
      itemsCrawled: 'Sản phẩm đã lấy',
      followers: 'Người theo dõi',
      rating: 'Đánh giá',
      chatResponse: 'Phản hồi chat',
      location: 'Địa chỉ:',
      joined: 'Tham gia:',
      following: 'Đang theo:',
      cancellationRate: 'Hủy đơn:',
      business: 'Doanh nghiệp:',
      pagesCrawled: 'Trang đã crawl:'
    },
    summary: {
      crawler: 'Crawler',
      input: 'Tham số đầu vào',
      productDetails: 'Chi tiết sản phẩm',
      detailedCount: '{completed} thành công{failedText}',
      failedText: ' · {failed} lỗi',
      noDetailCrawl: 'Không thu thập dữ liệu chi tiết',
      result: 'Kết quả',
      itemsStored: 'sản phẩm đã lưu vào cơ sở dữ liệu'
    },
    table: {
      index: 'STT',
      detailedDataTitle: 'Thông tin chi tiết thu thập bên trong sản phẩm',
      itemNo: 'Mục #{position}',
      noDetailedData: 'Không có dữ liệu chi tiết nâng cao cho sản phẩm này.',
      viewReviews: 'Xem {count} đánh giá',
      noReviews: 'Chưa có đánh giá',
      noRating: 'Chưa chấm sao',
      anonymousUser: 'Người dùng',
      noComment: 'Người mua không để lại nội dung.',
      reviewPhotoTitle: 'Bấm để xem bộ ảnh đánh giá',
      reviewPhotoAlt: 'Ảnh đánh giá {index}',
      video: 'Video {index}',
      noData: 'Không có dữ liệu',
      viewItems: 'Xem {count} mục',
      productPhotosTitle: 'Bấm để xem tất cả ảnh sản phẩm',
      viewAllPhotos: 'Xem tất cả bộ ảnh'
    },
    gallery: {
      title: 'Bộ ảnh ({index} / {total})',
      closeEsc: 'Đóng (Esc)',
      prevPhoto: 'Ảnh trước (Mũi tên trái)',
      nextPhoto: 'Ảnh tiếp theo (Mũi tên phải)',
      viewEnlarged: 'Bấm để xem ảnh phóng to trực tiếp'
    },
    fields: {
      id: 'Mã',
      itemId: 'Mã sản phẩm',
      shopId: 'Mã cửa hàng',
      title: 'Tên sản phẩm',
      name: 'Tên',
      price: 'Giá bán',
      sold: 'Đã bán',
      url: 'Liên kết',
      image: 'Hình ảnh',
      images: 'Bộ ảnh',
      createdAt: 'Ngày tạo',
      updatedAt: 'Ngày cập nhật',
      rating: 'Điểm đánh giá',
      ratingCount: 'Lượt đánh giá',
      shopName: 'Cửa hàng'
    }
  }
}
