export const en = {
  common: {
    close: 'Close',
    cancel: 'Cancel',
    confirm: 'Confirm',
    error: 'Error'
  },
  sidebar: {
    crawlers: 'Crawlers',
    runs: 'Job Runs',
    browser: 'Browser',
    settings: 'Settings',
    data: 'Job Data'
  },
  topbar: {
    searchPlaceholder: 'Search crawler or job...',
    shopee: 'Shopee'
  },
  crawlers: {
    desc: 'Crawl Shopee products by keyword using embedded browser.',
    shopeeNotOpen: 'Browser not opened',
    shopeeNotLoggedIn: 'Shopee: Not logged in',
    shopeeOpen: 'Shopee: Opened',
    loginBtn: 'Sign In',
    openShopeeBtn: 'Open Shopee',
    keywordLabel: 'Keyword',
    keywordPlaceholder: 'e.g. 3d printer, filament pla',
    maxItemsLabel: 'Max items',
    runBtn: 'Run',
    runningBtn: 'Starting job...',
    addPlaceholderTitle: 'Add new crawler',
    addPlaceholderDesc: 'TikTok, Shopee Shop and other platforms crawlers will appear here.'
  },
  runs: {
    emptyTitle: 'No job runs yet',
    emptyDesc: 'Run a crawler to start collecting data.',
    openCrawlers: 'Open Crawlers',
    table: {
      id: 'Job ID',
      crawler: 'Crawler',
      status: 'Status',
      items: 'Items',
      started: 'Started',
      duration: 'Duration',
      actions: 'Actions'
    },
    viewData: 'View Data',
    stop: 'Stop',
    statuses: {
      PENDING: 'Pending',
      RUNNING: 'Running',
      PAUSED: 'Action Needed',
      STOPPING: 'Stopping',
      STOPPED: 'Stopped',
      SUCCESS: 'Success',
      PARTIAL: 'Partial',
      FAILED: 'Failed'
    }
  },
  browser: {
    reload: '↻ Reload',
    loginChrome: 'Sign In with Chrome',
    loginChromeBusy: 'Opening Chrome...',
    importCookie: 'Import Cookie',
    stopJob: 'Stop Job',
    openShopee: 'Open Shopee',
    openingChrome: 'Opening Google Chrome... Please sign in on the opened Chrome window.',
    loginChromeSuccess: 'Signed in successfully! Extracted {count} cookies from Chrome into app.',
    connectChromeError: 'Error connecting to Chrome.',
    cookieImportSuccess: 'Successfully imported {count} cookies into Shopee profile!',
    cookieImportError: 'Unable to import cookies.'
  },
  data: {
    backLink: '← Back to Job Runs',
    selectJob: 'Select a job',
    summary: '{actor} · {status} · {count} items',
    exportCsv: 'Export CSV',
    exportJsonl: 'JSONL',
    emptyTitle: 'No data items',
    emptyDesc: 'Data items will appear here as the crawler collects them.'
  },
  settings: {
    localTitle: 'Local Storage',
    localDesc: 'Crawl data and login sessions are stored locally on this machine.',
    cloudTitle: 'Cloud Sync',
    cloudDesc: 'Disabled. Currently no data is sent to external servers.',
    cloudState: 'Disabled',
    crawlersTitle: 'Crawlers',
    crawlersDesc: 'Installed {count} crawlers. Shopee Search is the first desktop crawler.',
    languageTitle: 'Display Language',
    languageDesc: 'Choose interface language for Desktop app.'
  },
  cookieModal: {
    title: 'Import Shopee Cookie',
    desc: 'Paste cookie string (SPC_EC=...; SPC_U=...) or JSON array from Cookie-Editor extension:',
    placeholder: 'Paste cookie here...',
    cancel: 'Cancel',
    apply: 'Apply & Save Cookie'
  }
}
