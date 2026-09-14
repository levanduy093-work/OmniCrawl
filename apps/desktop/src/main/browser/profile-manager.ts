import { session, type Session } from 'electron';

const PLATFORM_HOME: Record<string, string> = {
  shopee: 'https://shopee.vn/',
  tiktok: 'https://www.tiktok.com/'
};

export function getStandardChromeUserAgent(): string {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const osPlatform = isMac
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : isWin
    ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
  const chromeMajor = (process.versions.chrome || '134').split('.')[0];
  return `Mozilla/5.0 (${osPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

export function getPlatformName(): string {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

export class ProfileManager {
  private readonly configured = new WeakSet<Session>();
  private readonly chromeUserAgent = getStandardChromeUserAgent();
  private readonly platformName = getPlatformName();
  private readonly chromeMajor = (process.versions.chrome || '134').split('.')[0];

  getUserAgent() {
    return this.chromeUserAgent;
  }

  platformHome(platform: string) {
    const home = PLATFORM_HOME[platform];
    if (!home) throw new Error(`Unsupported browser platform: ${platform}`);
    return home;
  }

  persistent(platform: string, profileId = 'default') {
    return this.configure(session.fromPartition(`persist:omnicrawl-${platform}-${profileId}`));
  }

  temporary(platform: string, runId: string) {
    return this.configure(session.fromPartition(`omnicrawl-${platform}-private-${runId}`));
  }

  configureDefault() {
    return this.configure(session.defaultSession);
  }

  private configure(value: Session) {
    if (this.configured.has(value)) return value;
    this.configured.add(value);

    value.setUserAgent(this.chromeUserAgent);

    value.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      const url = details.url.toLowerCase();

      // Ensure User-Agent is standard Chrome across all requests
      requestHeaders['User-Agent'] = this.chromeUserAgent;

      // Provide matching Sec-CH-UA client hints for Google and OAuth endpoints
      if (url.includes('accounts.google.com') || url.includes('accounts.youtube.com')) {
        requestHeaders['User-Agent'] =
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';
        delete requestHeaders['Sec-CH-UA'];
        delete requestHeaders['sec-ch-ua'];
        delete requestHeaders['Sec-CH-UA-Mobile'];
        delete requestHeaders['sec-ch-ua-mobile'];
        delete requestHeaders['Sec-CH-UA-Platform'];
        delete requestHeaders['sec-ch-ua-platform'];
        delete requestHeaders['Sec-CH-UA-Full-Version-List'];
        delete requestHeaders['sec-ch-ua-full-version-list'];
      } else if (
        url.includes('google.com') ||
        url.includes('gstatic.com') ||
        url.includes('googleusercontent.com') ||
        url.includes('googleapis.com')
      ) {
        requestHeaders['Sec-CH-UA'] = `"Google Chrome";v="${this.chromeMajor}", "Chromium";v="${this.chromeMajor}", "Not-A.Brand";v="99"`;
        requestHeaders['Sec-CH-UA-Mobile'] = '?0';
        requestHeaders['Sec-CH-UA-Platform'] = `"${this.platformName}"`;
        requestHeaders['Sec-CH-UA-Full-Version-List'] = `"Google Chrome";v="${process.versions.chrome || '134.0.0.0'}", "Chromium";v="${process.versions.chrome || '134.0.0.0'}", "Not-A.Brand";v="99.0.0.0"`;
      }


      callback({ cancel: false, requestHeaders });
    });

    value.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    value.setPermissionCheckHandler(() => false);
    return value;
  }

  async importCookies(
    platform: string,
    rawCookies: string,
    profileId = 'default'
  ): Promise<{ count: number }> {
    const sessionInstance = this.persistent(platform, profileId);
    const defaultDomain = platform === 'shopee' ? '.shopee.vn' : '.tiktok.com';
    let parsedCookies: Array<{
      name: string;
      value: string;
      domain?: string;
      path?: string;
      secure?: boolean;
      httpOnly?: boolean;
      expirationDate?: number;
    }> = [];

    const trimmed = rawCookies.trim();
    if (!trimmed) throw new Error('Vui lòng nhập nội dung Cookie.');

    // Try parsing JSON format first (e.g. from Cookie-Editor / EditThisCookie)
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const json = JSON.parse(trimmed);
        if (Array.isArray(json)) {
          parsedCookies = json
            .map((item: any) => ({
              name: String(item.name || item.key || ''),
              value: String(item.value ?? ''),
              domain: item.domain ? String(item.domain) : defaultDomain,
              path: item.path ? String(item.path) : '/',
              secure: Boolean(item.secure ?? true),
              httpOnly: Boolean(item.httpOnly ?? false),
              expirationDate:
                typeof item.expirationDate === 'number'
                  ? item.expirationDate
                  : typeof item.expires === 'number'
                  ? item.expires
                  : undefined
            }))
            .filter((c) => c.name && c.value !== undefined);
        }
      } catch {
        // Fall back to standard header string parsing
      }
    }

    // Header string format: "key1=value1; key2=value2; ..."
    if (parsedCookies.length === 0) {
      const parts = trimmed
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx > 0) {
          const name = part.slice(0, eqIdx).trim();
          const value = part.slice(eqIdx + 1).trim();
          if (name) {
            parsedCookies.push({
              name,
              value,
              domain: defaultDomain,
              path: '/',
              secure: true,
              httpOnly: false
            });
          }
        }
      }
    }

    if (parsedCookies.length === 0) {
      throw new Error('Không thể phân tích chuỗi Cookie. Vui lòng kiểm tra lại định dạng.');
    }

    let count = 0;
    for (const c of parsedCookies) {
      try {
        const rawDomain = c.domain || defaultDomain;
        const domain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
        const protocol = c.secure !== false ? 'https://' : 'http://';
        const cookiePath = c.path && c.path.startsWith('/') ? c.path : '/';
        const url = `${protocol}${domain}${cookiePath}`;

        await sessionInstance.cookies.set({
          url,
          name: c.name,
          value: c.value,
          domain: rawDomain,
          path: cookiePath,
          secure: c.secure !== false,
          httpOnly: Boolean(c.httpOnly),
          expirationDate:
            c.expirationDate && c.expirationDate > 0
              ? c.expirationDate
              : Math.floor(Date.now() / 1000) + 86400 * 365,
          sameSite: 'no_restriction'
        });
        count += 1;
      } catch {
        // continue
      }
    }

    return { count };
  }
}



