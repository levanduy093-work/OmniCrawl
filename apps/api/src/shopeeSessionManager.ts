import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import {
  chromium,
  type Browser,
  type BrowserContext
} from 'playwright';
import { prisma } from '@omnicrawl/database';

const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
const profilesRoot = path.join(workspaceRoot, 'storage', 'browser_profiles', 'shopee');
const loginTimeoutMs = 10 * 60 * 1000;

type ActiveConnection = {
  browser?: Browser;
  context?: BrowserContext;
  process?: ChildProcess;
  cancelled: boolean;
  startedAt: number;
};

const activeConnections = new Map<string, ActiveConnection>();

function isConnectionAlive(active: ActiveConnection) {
  if (active.cancelled) return false;
  if (!active.process) return Date.now() - active.startedAt < 20_000;
  if (active.process.exitCode !== null || active.process.killed) return false;
  if (active.browser && !active.browser.isConnected()) return false;
  return true;
}

function getProfileDir(userId: string) {
  return path.join(profilesRoot, userId);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEdgeExecutable() {
  if (process.env.OMNICRAWL_EDGE_EXECUTABLE_PATH) {
    return process.env.OMNICRAWL_EDGE_EXECUTABLE_PATH;
  }
  if (process.platform === 'darwin') {
    return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  }
  if (process.platform === 'win32') {
    return 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  }
  return '/usr/bin/microsoft-edge';
}

async function getAvailablePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a local browser control port.'));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function connectToEdge(port: number) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return chromium.connectOverCDP(endpoint);
    } catch {
      // Edge is still starting.
    }
    await sleep(250);
  }
  throw new Error('Microsoft Edge started but its local control endpoint did not become ready.');
}

async function updateStatus(
  userId: string,
  status: string,
  data: { lastError?: string | null; connected?: boolean } = {}
) {
  return prisma.shopeeSession.upsert({
    where: { userId },
    create: {
      userId,
      status,
      lastError: data.lastError,
      lastCheckedAt: new Date(),
      lastConnectedAt: data.connected ? new Date() : undefined
    },
    update: {
      status,
      lastError: data.lastError,
      lastCheckedAt: new Date(),
      ...(data.connected ? { lastConnectedAt: new Date() } : {})
    }
  });
}

async function hasAuthenticatedCookies(context: BrowserContext) {
  const cookies = await context.cookies('https://shopee.vn');
  const hasAuthenticatedUser = cookies.some(cookie =>
    cookie.name === 'SPC_U' && cookie.value && cookie.value !== '0'
  );
  const hasSessionToken = cookies.some(cookie =>
    cookie.name === 'SPC_ST' && Boolean(cookie.value)
  );
  return hasAuthenticatedUser && hasSessionToken;
}

async function runConnectionFlow(userId: string) {
  const profileDir = getProfileDir(userId);
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const active: ActiveConnection = { cancelled: false, startedAt: Date.now() };
  activeConnections.set(userId, active);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const edgeExecutable = getEdgeExecutable();
    if (!fs.existsSync(edgeExecutable)) {
      throw new Error(`Microsoft Edge was not found at ${edgeExecutable}.`);
    }

    const debugPort = await getAvailablePort();
    active.process = spawn(edgeExecutable, [
      `--remote-debugging-port=${debugPort}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
      'https://shopee.vn/buyer/login'
    ], {
      stdio: 'ignore'
    });
    active.process.once('exit', () => {
      if (!active.cancelled && activeConnections.get(userId) === active) {
        active.cancelled = true;
        void updateStatus(userId, 'ERROR', {
          lastError: 'The Shopee login window was closed before the session was connected.'
        });
      }
    });

    browser = await connectToEdge(debugPort);
    active.browser = browser;
    browser.once('disconnected', () => {
      if (!active.cancelled && activeConnections.get(userId) === active) {
        active.cancelled = true;
        void updateStatus(userId, 'ERROR', {
          lastError: 'The Shopee login window was disconnected before login finished.'
        });
      }
    });
    context = browser.contexts()[0];
    if (!context) {
      throw new Error('Unable to access the dedicated Edge browser profile.');
    }
    active.context = context;
    if (active.cancelled) return;

    const deadline = Date.now() + loginTimeoutMs;
    while (Date.now() < deadline && !active.cancelled) {
      try {
        // A successful Shopee login writes both account and session cookies.
        // Do not trigger a search here: doing so can force a CAPTCHA before
        // the user has finished the connection flow.
        if (await hasAuthenticatedCookies(context)) {
          await updateStatus(userId, 'CONNECTED', {
            connected: true,
            lastError: null
          });
          await sleep(1500);
          return;
        }
      } catch {
        // Login may still be in progress or Shopee may be waiting for CAPTCHA.
      }
      await sleep(2000);
    }

    if (!active.cancelled) {
      await updateStatus(userId, 'EXPIRED', {
        lastError: 'Login timed out. Connect again and finish Shopee login or CAPTCHA.'
      });
    }
  } catch (error: any) {
    if (!active.cancelled) {
      await updateStatus(userId, 'ERROR', {
        lastError: error?.message || 'Unable to open the Shopee login browser.'
      });
    }
  } finally {
    if (activeConnections.get(userId) === active) {
      activeConnections.delete(userId);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    if (active.process && active.process.exitCode === null) {
      active.process.kill('SIGTERM');
    }
  }
}

export async function getShopeeSession(userId: string) {
  const session = await prisma.shopeeSession.findUnique({ where: { userId } });
  if (!session) {
    return {
      status: 'DISCONNECTED',
      lastConnectedAt: null,
      lastCheckedAt: null,
      lastError: null
    };
  }

  const active = activeConnections.get(userId);
  if (session.status === 'CONNECTING' && (!active || !isConnectionAlive(active))) {
    if (active) {
      active.cancelled = true;
      await active.browser?.close().catch(() => undefined);
      if (active.process && active.process.exitCode === null) {
        active.process.kill('SIGTERM');
      }
      activeConnections.delete(userId);
    }
    return updateStatus(userId, 'ERROR', {
      lastError: 'The Shopee login window is no longer open. Please connect again.'
    });
  }

  return session;
}

export async function startShopeeConnection(userId: string) {
  if (activeConnections.has(userId)) {
    return getShopeeSession(userId);
  }

  const session = await updateStatus(userId, 'CONNECTING', { lastError: null });
  void runConnectionFlow(userId);
  return session;
}

export async function disconnectShopeeSession(userId: string) {
  const active = activeConnections.get(userId);
  if (active) {
    active.cancelled = true;
    await active.browser?.close().catch(() => undefined);
    if (active.process && active.process.exitCode === null) {
      active.process.kill('SIGTERM');
    }
    activeConnections.delete(userId);
  }

  const profileDir = getProfileDir(userId);
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  return updateStatus(userId, 'DISCONNECTED', { lastError: null });
}
