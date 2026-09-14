import { BrowserWindow, WebContentsView } from 'electron';
import type { BrowserBounds } from '../../shared/contracts';
import { ChromeAuthService } from './chrome-auth-service';
import { ProfileManager } from './profile-manager';

export interface BrowserState {
  visible: boolean;
  platform: string | null;
  profileId: string | null;
  url: string | null;
  notice: string | null;
}

const ALLOWED_HOSTS: Record<string, (hostname: string) => boolean> = {
  shopee: (hostname) => hostname === 'shopee.vn' || hostname.endsWith('.shopee.vn'),
  tiktok: (hostname) => hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')
};

const AUTH_HOST_SUFFIXES = [
  'google.com',
  'gstatic.com',
  'googleusercontent.com',
  'googleapis.com',
  'youtube.com',
  'facebook.com',
  'facebook.net',
  'fbcdn.net',
  'apple.com',
  'appleid.apple.com'
];

function isAuthHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return AUTH_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith('.' + suffix));
}

export class BrowserManager {
  private readonly chromeAuth = new ChromeAuthService();
  private view: WebContentsView | null = null;
  private bounds: BrowserBounds = { x: 280, y: 80, width: 900, height: 650 };
  private state: BrowserState = {
    visible: false,
    platform: null,
    profileId: null,
    url: null,
    notice: null
  };

  constructor(
    private readonly window: BrowserWindow,
    private readonly profiles: ProfileManager,
    private readonly onChanged: (state: BrowserState) => void
  ) {}

  getState() {
    return { ...this.state };
  }

  async loginWithChrome(
    platform = 'shopee',
    profileId = 'default'
  ): Promise<{ success: boolean; count: number; error?: string }> {
    if (!ALLOWED_HOSTS[platform]) throw new Error(`Unsupported platform: ${platform}`);
    const sessionInstance = this.profiles.persistent(platform, profileId);
    const loginUrl =
      platform === 'shopee'
        ? 'https://shopee.vn/buyer/login'
        : 'https://www.tiktok.com/login';

    const result = await this.chromeAuth.authenticate(platform, sessionInstance, loginUrl);
    if (result.success && result.count > 0) {
      if (this.view && this.state.platform === platform) {
        await this.loadURL(this.profiles.platformHome(platform));
      }
    }
    return result;
  }

  async importCookies(
    platform: string,
    rawCookies: string,
    profileId = 'default'
  ): Promise<{ count: number }> {
    if (!ALLOWED_HOSTS[platform]) throw new Error(`Unsupported platform: ${platform}`);
    const result = await this.profiles.importCookies(platform, rawCookies, profileId);
    if (result.count > 0 && this.view && this.state.platform === platform) {
      await this.loadURL(this.profiles.platformHome(platform));
    }
    return result;
  }

  async reload() {
    if (!this.view) return;
    this.view.webContents.reload();
  }


  async openPlatform(platform: string, profileId = 'default', url?: string) {
    if (!ALLOWED_HOSTS[platform]) throw new Error(`Unsupported platform: ${platform}`);
    const needsNewView = !this.view || this.state.platform !== platform || this.state.profileId !== profileId;
    if (needsNewView) this.replaceView(platform, profileId);
    this.setVisible(true);
    await this.loadURL(url ?? this.profiles.platformHome(platform));
  }

  private replaceView(platform: string, profileId: string) {
    if (this.view) {
      this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
    const sessionInstance = this.profiles.persistent(platform, profileId);
    const userAgent = this.profiles.getUserAgent();
    const view = new WebContentsView({
      webPreferences: {
        session: sessionInstance,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: false
      }
    });
    view.webContents.setUserAgent(userAgent);
    view.setBounds(this.bounds);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url === 'about:blank' || this.isAllowed(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: this.window,
            modal: false,
            width: 520,
            height: 680,
            minWidth: 400,
            minHeight: 500,
            autoHideMenuBar: true,
            title: 'Đăng nhập',
            webPreferences: {
              session: sessionInstance,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              devTools: false
            }
          }
        };
      }
      return { action: 'deny' };
    });
    view.webContents.on('did-create-window', (childWindow) => {
      childWindow.webContents.setUserAgent(userAgent);
      childWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url === 'about:blank' || this.isAllowed(url)) {
          return { action: 'allow' };
        }
        return { action: 'deny' };
      });
      childWindow.webContents.on('will-navigate', (event, url) => {
        if (!this.isAllowed(url)) {
          event.preventDefault();
        }
        if (url.includes('accounts.google.com') || url.includes('accounts.youtube.com')) {
          childWindow.webContents.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15'
          );
        } else {
          childWindow.webContents.setUserAgent(userAgent);
        }
      });
    });


    view.webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowed(url)) event.preventDefault();
    });
    view.webContents.on('did-navigate', (_event, url) => {
      this.updateNavigation(url);
    });
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      this.updateNavigation(url);
    });
    this.view = view;
    this.window.contentView.addChildView(view);
    this.state = { visible: true, platform, profileId, url: null, notice: null };
    this.emit();
  }

  async loadURL(url: string) {
    if (!this.view) throw new Error('Browser is not open');
    if (!this.isAllowed(url)) throw new Error(`Navigation is not allowed: ${url}`);
    await this.view.webContents.loadURL(url);
    this.state.url = this.view.webContents.getURL();
    this.emit();
  }

  async evaluate<T>(script: string) {
    if (!this.view) throw new Error('Browser is not open');
    return this.view.webContents.executeJavaScript(script, true) as Promise<T>;
  }

  setBounds(bounds: BrowserBounds) {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(320, Math.round(bounds.width)),
      height: Math.max(240, Math.round(bounds.height))
    };
    this.view?.setBounds(this.bounds);
  }

  setVisible(visible: boolean) {
    this.state.visible = visible;
    this.view?.setVisible(visible);
    this.emit();
  }

  destroy() {
    if (!this.view) return;
    this.window.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
  }

  private isAllowed(rawUrl: string) {
    if (rawUrl === 'about:blank') return true;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      const hostname = url.hostname.toLowerCase();
      const allowed = this.state.platform ? ALLOWED_HOSTS[this.state.platform] : null;
      if (allowed?.(hostname)) return true;
      if (isAuthHost(hostname)) return true;
      return false;
    } catch {
      return false;
    }
  }

  private updateNavigation(url: string) {
    this.state.url = url;
    this.state.notice = null;
    this.emit();
  }

  private emit() {
    this.onChanged(this.getState());
  }
}

