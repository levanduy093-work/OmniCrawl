export const en = {
  common: {
    loading: 'Loading...',
    close: 'Close',
    cancel: 'Cancel',
    save: 'Save',
    confirm: 'Confirm',
    refresh: 'Refresh',
    error: 'An error occurred',
    yes: 'Yes',
    no: 'No',
    search: 'Search...',
    openInNewTab: 'Open in new tab',
    actions: 'Actions'
  },
  auth: {
    welcomeTitle: 'Welcome to OmniCrawl',
    registerTitle: 'Create an Account',
    welcomeSubtitle: 'Please sign in to continue.',
    registerSubtitle: 'Sign up to build your data ecosystem.',
    emailPlaceholder: 'Email address',
    passwordPlaceholder: 'Password',
    signInButton: 'Sign In',
    signUpButton: 'Sign Up',
    alreadyHaveAccount: 'Already have an account?',
    dontHaveAccount: "Don't have an account?",
    switchSignIn: 'Sign In',
    switchSignUp: 'Sign Up'
  },
  sidebar: {
    brand: 'OmniCrawl',
    crawlers: 'Crawlers',
    runs: 'Job Runs',
    proxies: 'Proxies',
    settings: 'Settings',
    support: 'Support on Ko-fi',
    logout: 'Logout',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar'
  },
  header: {
    searchPlaceholder: 'Search anything...',
    proxyManager: 'Proxy Manager'
  },
  alerts: {
    proxyInactiveTitle: 'Proxy Pool Inactive',
    proxyInactiveDefault: 'No active proxy available to run crawlers.',
    proxyManageBtn: 'Manage Proxies',
    agentConnected: 'Agent v{version}',
    agentReloadNeeded: 'Reload Extension Required',
    agentNotConnected: 'Extension Not Connected',
    shopeeLoggedIn: 'Shopee: Logged In',
    shopeeNotLoggedIn: 'Shopee: Not Logged In',
    tiktokLoggedIn: 'TikTok: Logged In',
    tiktokNotLoggedIn: 'TikTok: Not Logged In',
    openLogin: 'Open Login',
    tiktokBetaBadge: 'Unstable',
    tiktokBetaTitle: 'Status: Unstable (Beta)',
    tiktokBetaDesc: 'TikTok Scraper may experience interruptions or missing data due to TikTok anti-bot mechanisms. Upgrade in progress.',
    safetyWarningTitle: 'Safety Warning:',
    safetyWarningDesc: 'Scraping over 200 items on personal WiFi risks IP blocking or frequent CAPTCHA challenges by eCommerce platforms. Consider batching or using proxies.'
  },
  actors: {
    run: 'Run',
    running: 'Running...',
    noDescription: 'No description provided.',
    maxItemsLimit: '(Max {max})',
    triggerSuccess: 'Crawler run triggered successfully!',
    triggerFailed: 'Failed to trigger run: {error}',
    proxyUnavailable: 'Proxy is configured but currently unavailable.'
  },
  runs: {
    table: {
      id: 'ID',
      crawler: 'Crawler',
      status: 'Status',
      items: 'Items',
      createdAt: 'Created At',
      finishedAt: 'Finished At',
      duration: 'Duration',
      actions: 'Actions'
    },
    status: {
      SUCCESS: 'Success',
      PARTIAL: 'Partial',
      FAILED: 'Failed',
      RUNNING: 'Running',
      BROWSER_RUNNING: 'Running (Browser)',
      STOPPING: 'Stopping',
      STOPPED: 'Stopped',
      PENDING: 'Pending',
      BROWSER_PENDING: 'Pending (Browser)'
    },
    actions: {
      view: 'View',
      logs: 'Logs',
      stop: 'Stop',
      delete: 'Delete'
    },
    confirmDelete: 'Are you sure you want to delete this run?',
    deleteError: 'Delete error: {error}',
    stopError: 'Unable to stop run: {error}'
  },
  proxies: {
    pool: {
      title: 'Proxy Pool',
      notInUse: 'Not in use',
      ready: 'Ready',
      notReady: 'Not ready',
      total: 'Total',
      alive: 'Alive',
      latency: 'Latency'
    },
    add: {
      title: 'Add Proxies',
      formatHint: 'host:port:user:pass or http:// URL',
      textareaLabel: 'Proxy list',
      textareaPlaceholder: 'proxy.example.com:8080:user:password\nhttp://user:password@proxy.example.com:8080',
      advancedOptions: 'Advanced Options',
      country: 'Country',
      autoRotate: 'Provider auto-rotates IP',
      submit: 'Add & Test Proxies',
      submitting: 'Adding and testing…',
      recheck: 'Recheck',
      refresh: 'Refresh'
    },
    results: {
      imported: 'Added {imported}, skipped {skipped} duplicates{failedInfo}.',
      failedPart: ', {failed} invalid lines',
      checkDone: 'Check finished: {alive} alive, {dead} inactive.',
      apiError: 'Could not connect to proxy API.',
      addError: 'Unable to add proxies.'
    },
    groups: {
      proxiesCount: '{count} proxies',
      default: 'Default',
      enabled: 'Enabled',
      disabled: 'Disabled',
      deleteTitle: 'Delete Group',
      confirmDelete: 'Delete this proxy group and all proxies within?',
      empty: 'No proxies in this group yet. Use Add Proxies to get started.'
    },
    table: {
      status: 'Status',
      host: 'Host',
      port: 'Port',
      protocol: 'Protocol',
      user: 'User',
      country: 'Country',
      latency: 'Latency',
      success: 'Success',
      fails: 'Fails',
      actions: 'Actions'
    },
    statusLabel: {
      ALIVE: 'Alive',
      DEAD: 'Dead',
      SLOW: 'Slow',
      UNKNOWN: 'Unknown'
    },
    actions: {
      enable: 'Enable',
      disable: 'Disable',
      reset: 'Reset status',
      delete: 'Delete proxy'
    }
  },
  settings: {
    title: 'Account Settings',
    emailLabel: 'Email Address',
    emailHint: 'Email cannot be changed.',
    languageLabel: 'Display Language',
    languageDesc: 'Choose your preferred language for the OmniCrawl interface.'
  },
  logModal: {
    title: 'Live Logs:',
    noLogs: 'No logs available.',
    errorLogs: 'Error fetching logs.'
  },
  runDetail: {
    title: 'Run Data',
    downloadJsonl: 'Download JSON Lines',
    allProducts: 'All Items',
    failedProducts: 'Failed Items',
    loading: 'Loading data…',
    loadError: 'Failed to load data: {error}',
    empty: 'This run has no data items.',
    unableToLoad: 'Unable to load run data.',
    pagination: 'Page {page} of {totalPages} · {total} items',
    prevPage: 'Previous',
    nextPage: 'Next',
    shopInfo: {
      avatarAlt: '{name} avatar',
      preferred: 'Preferred',
      mall: 'Mall',
      verified: 'Verified',
      activeText: 'Active {time}',
      openShop: 'Open shop',
      itemsCrawled: 'Crawled Items',
      followers: 'Followers',
      rating: 'Rating',
      chatResponse: 'Chat Response',
      location: 'Location:',
      joined: 'Joined:',
      following: 'Following:',
      cancellationRate: 'Cancellation rate:',
      business: 'Business:',
      pagesCrawled: 'Pages crawled:'
    },
    summary: {
      crawler: 'Crawler',
      input: 'Input parameters',
      productDetails: 'Product details',
      detailedCount: '{completed} succeeded{failedText}',
      failedText: ' · {failed} failed',
      noDetailCrawl: 'Detailed crawl disabled',
      result: 'Result',
      itemsStored: 'items stored in database'
    },
    table: {
      index: '#',
      detailedDataTitle: 'Detailed information collected from inside product',
      itemNo: 'Item #{position}',
      noDetailedData: 'No advanced detailed data for this item.',
      viewReviews: 'View {count} reviews',
      noReviews: 'No reviews',
      noRating: 'No rating',
      anonymousUser: 'User',
      noComment: 'Buyer left no comment.',
      reviewPhotoTitle: 'Click to view review photos',
      reviewPhotoAlt: 'Review photo {index}',
      video: 'Video {index}',
      noData: 'No data',
      viewItems: 'View {count} items',
      productPhotosTitle: 'Click to view all product photos',
      viewAllPhotos: 'View all photos'
    },
    gallery: {
      title: 'Gallery ({index} / {total})',
      closeEsc: 'Close (Esc)',
      prevPhoto: 'Previous (Left Arrow)',
      nextPhoto: 'Next (Right Arrow)',
      viewEnlarged: 'Click to view enlarged image'
    },
    fields: {
      id: 'ID',
      itemId: 'Item ID',
      shopId: 'Shop ID',
      title: 'Product Title',
      name: 'Name',
      price: 'Price',
      sold: 'Sold',
      url: 'URL',
      image: 'Image',
      images: 'Images',
      createdAt: 'Created At',
      updatedAt: 'Updated At',
      rating: 'Rating',
      ratingCount: 'Review Count',
      shopName: 'Shop Name'
    }
  }
}
