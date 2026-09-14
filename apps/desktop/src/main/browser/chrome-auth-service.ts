import { app, type Session } from 'electron';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

interface CookieData {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: 'Strict' | 'Lax' | 'None' | 'no_restriction' | 'unspecified';
}

export class ChromeAuthService {
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private activeTempDir: string | null = null;
  private activeServer: http.Server | null = null;

  findChromeExecutable(): string | null {
    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium'
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    } else if (process.platform === 'win32') {
      const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe')
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    } else {
      const candidates = [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium'
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }

  async authenticate(
    platform: string,
    targetSession: Session,
    loginUrl = 'https://shopee.vn/buyer/login'
  ): Promise<{ success: boolean; count: number; error?: string }> {
    this.cancel();

    const chromePath = this.findChromeExecutable();
    if (!chromePath) {
      return {
        success: false,
        count: 0,
        error: 'Không tìm thấy trình duyệt Google Chrome hoặc Edge trên máy tính.'
      };
    }

    const baseTemp = fs.mkdtempSync(path.join(app.getPath('temp'), 'omnicrawl-login-'));
    this.activeTempDir = baseTemp;

    const extDir = path.join(baseTemp, 'extension');
    const profileDir = path.join(baseTemp, 'profile');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });

    return new Promise((resolve) => {
      let resolved = false;

      const finish = (result: { success: boolean; count: number; error?: string }) => {
        if (resolved) return;
        resolved = true;
        this.cancel();
        resolve(result);
      };

      // 1. Start temporary local HTTP server to receive cookies from extension
      const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.method === 'POST' && req.url === '/cookies') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const data = JSON.parse(body) as { cookies?: CookieData[] };
              const cookies = data.cookies || [];
              let importedCount = 0;

              for (const cookie of cookies) {
                try {
                  const defaultDomain = platform === 'shopee' ? '.shopee.vn' : '.tiktok.com';
                  const rawDomain = cookie.domain || defaultDomain;
                  const domain = rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
                  const protocol = cookie.secure !== false ? 'https://' : 'http://';
                  const cookiePath = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/';
                  const url = `${protocol}${domain}${cookiePath}`;

                  let sameSite: 'strict' | 'lax' | 'no_restriction' | 'unspecified' = 'no_restriction';
                  if (cookie.sameSite === 'Strict') sameSite = 'strict';
                  else if (cookie.sameSite === 'Lax') sameSite = 'lax';

                  await targetSession.cookies.set({
                    url,
                    name: cookie.name,
                    value: cookie.value,
                    domain: rawDomain,
                    path: cookiePath,
                    secure: Boolean(cookie.secure),
                    httpOnly: Boolean(cookie.httpOnly),
                    expirationDate:
                      cookie.expirationDate && cookie.expirationDate > 0
                        ? cookie.expirationDate
                        : Math.floor(Date.now() / 1000) + 86400 * 365,
                    sameSite
                  });
                  importedCount += 1;
                } catch {
                  // ignore individual format issues
                }
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, count: importedCount }));

              if (importedCount > 0) {
                finish({ success: true, count: importedCount });
              }
            } catch (err: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.activeServer = server;

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        if (!port) {
          finish({ success: false, count: 0, error: 'Không thể khởi tạo cổng lắng nghe cục bộ.' });
          return;
        }

        // 2. Generate lightweight background extension
        const manifestContent = JSON.stringify(
          {
            manifest_version: 3,
            name: 'OmniCrawl Login Sync',
            version: '1.0',
            permissions: ['cookies', 'tabs'],
            host_permissions: ['<all_urls>'],
            background: {
              service_worker: 'background.js'
            }
          },
          null,
          2
        );

        const backgroundContent = `
const CALLBACK_PORT = ${port};
const PLATFORM = ${JSON.stringify(platform)};

async function checkAndSend() {
  try {
    const allCookies = await chrome.cookies.getAll({});
    const cookies = allCookies.filter(c => 
      c.domain && (c.domain.includes('shopee.vn') || c.domain.includes('tiktok.com'))
    );
    const hasLogin = cookies.some(c => 
      (PLATFORM === 'shopee' && ((c.name === 'SPC_EC' && c.value && c.value.length > 5) || (c.name === 'shopee_token' && c.value && c.value.length > 5) || (c.name === 'SPC_U' && c.value && c.value !== '-'))) ||
      (PLATFORM === 'tiktok' && (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value && c.value.length > 5)
    );
    if (hasLogin && cookies.length > 0) {
      await fetch(\`http://127.0.0.1:\${CALLBACK_PORT}/cookies\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies })
      });
    }
  } catch (err) {
    console.error(err);
  }
}

chrome.cookies.onChanged.addListener(() => {
  checkAndSend();
});
setInterval(checkAndSend, 1000);
checkAndSend();
`;

        fs.writeFileSync(path.join(extDir, 'manifest.json'), manifestContent, 'utf8');
        fs.writeFileSync(path.join(extDir, 'background.js'), backgroundContent, 'utf8');


        // 3. Launch Google Chrome WITHOUT --remote-debugging-port (pure native browser)
        const args = [
          `--load-extension=${extDir}`,
          `--disable-extensions-except=${extDir}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
          loginUrl
        ];

        const child = spawn(chromePath, args, {
          detached: false,
          stdio: 'ignore'
        });
        this.activeProcess = child;

        child.on('exit', () => {
          if (this.activeProcess === child) {
            this.activeProcess = null;
          }
          // If closed before cookies received, timeout or finish with message
          setTimeout(() => {
            finish({
              success: false,
              count: 0,
              error: 'Cửa sổ Chrome đã được đóng trước khi hoàn tất đăng nhập.'
            });
          }, 800);
        });

        // 4. Timeout after 4 minutes
        setTimeout(() => {
          finish({
            success: false,
            count: 0,
            error: 'Hết thời gian chờ đăng nhập (4 phút).'
          });
        }, 240000);
      });
    });
  }

  cancel() {
    if (this.activeProcess) {
      try {
        this.activeProcess.kill('SIGKILL');
      } catch {
        // ignore
      }
      this.activeProcess = null;
    }
    if (this.activeServer) {
      try {
        this.activeServer.close();
      } catch {
        // ignore
      }
      this.activeServer = null;
    }
    if (this.activeTempDir) {
      try {
        fs.rmSync(this.activeTempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this.activeTempDir = null;
    }
  }
}
