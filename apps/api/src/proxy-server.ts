import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import { SocksClient } from 'socks';
import { prisma } from '@omnicrawl/database';
import { decryptProxySecret } from './proxy-credentials';

const PROXY_PORT = Number(process.env.PROXY_PORT || 8888);
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const PROXY_REQUEST_TIMEOUT_MS = 30_000;
const VERIFICATION_TTL_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILS = 3;
const MAX_REQUESTS_PER_STATIC_PROXY_PER_MINUTE = 300;
const EGRESS_CHECK_HOST = process.env.PROXY_EGRESS_CHECK_HOST || 'api.ipify.org';
const EGRESS_CHECK_PATH = process.env.PROXY_EGRESS_CHECK_PATH || '/';

type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5';

interface ProxyEntry {
  id: string;
  protocol: string;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  isRotating: boolean;
  lastLatencyMs: number | null;
  failCount: number;
  successCount: number;
}

export interface ProxyReadiness {
  ready: boolean;
  mode: 'direct' | 'proxy' | 'blocked';
  activeProxies: number;
  verifiedProxies: number;
  checkedAt: string;
  message: string;
}

const proxyRequestTimestamps = new Map<string, number[]>();
const verifiedProxyIds = new Map<string, number>();
let cachedProxies: ProxyEntry[] = [];
let lastCacheRefreshAt = 0;
let readinessInFlight: Promise<ProxyReadiness> | null = null;
let lastReadiness: ProxyReadiness | null = null;
const CACHE_TTL_MS = 30_000;

function normalizedProtocol(proxy: ProxyEntry): ProxyProtocol {
  const protocol = proxy.protocol.toLowerCase();
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
    throw new Error(`Unsupported upstream proxy protocol: ${protocol}`);
  }
  return protocol as ProxyProtocol;
}

async function refreshProxyCache(): Promise<ProxyEntry[]> {
  const now = Date.now();
  if (now - lastCacheRefreshAt < CACHE_TTL_MS) return cachedProxies;
  try {
    cachedProxies = await prisma.proxy.findMany({
      where: { enabled: true, status: { not: 'DEAD' }, group: { enabled: true } },
      select: {
        id: true,
        protocol: true,
        host: true,
        port: true,
        username: true,
        password: true,
        isRotating: true,
        lastLatencyMs: true,
        failCount: true,
        successCount: true
      }
    });
    lastCacheRefreshAt = now;
  } catch (error) {
    cachedProxies = [];
    lastCacheRefreshAt = 0;
    console.error('[ProxyServer] Failed to refresh proxy cache; fail-closed is active:', error);
  }
  return cachedProxies;
}

function isProxyRateLimited(proxy: ProxyEntry): boolean {
  if (proxy.isRotating) return false;
  const now = Date.now();
  const recent = (proxyRequestTimestamps.get(proxy.id) || [])
    .filter(timestamp => now - timestamp < 60_000);
  proxyRequestTimestamps.set(proxy.id, recent);
  return recent.length >= MAX_REQUESTS_PER_STATIC_PROXY_PER_MINUTE;
}

function recordProxyRequest(proxyId: string) {
  proxyRequestTimestamps.set(proxyId, [
    ...(proxyRequestTimestamps.get(proxyId) || []),
    Date.now()
  ]);
}

function selectProxy(proxies: ProxyEntry[]): ProxyEntry | null {
  const now = Date.now();
  const available = proxies.filter(proxy => {
    const verifiedAt = verifiedProxyIds.get(proxy.id) || 0;
    return now - verifiedAt < VERIFICATION_TTL_MS && !isProxyRateLimited(proxy);
  });
  if (!available.length) return null;

  const weights = available.map(proxy => {
    let weight = 10 - Math.min(5, proxy.failCount);
    if (proxy.lastLatencyMs !== null) {
      if (proxy.lastLatencyMs < 500) weight += 5;
      else if (proxy.lastLatencyMs < 1000) weight += 3;
      else if (proxy.lastLatencyMs > 2000) weight -= 2;
    }
    return Math.max(1, weight);
  });
  let random = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < available.length; index += 1) {
    random -= weights[index];
    if (random <= 0) return available[index];
  }
  return available[available.length - 1];
}

function proxyAuthorization(proxy: ProxyEntry): string | null {
  if (!proxy.username) return null;
  const password = decryptProxySecret(proxy.password) || '';
  return `Basic ${Buffer.from(`${proxy.username}:${password}`).toString('base64')}`;
}

function connectToUpstream(proxy: ProxyEntry): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const protocol = normalizedProtocol(proxy);
    const socket: net.Socket = protocol === 'https'
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
      : net.connect(proxy.port, proxy.host);
    const readyEvent = protocol === 'https' ? 'secureConnect' : 'connect';
    const onError = (error: Error) => reject(error);
    socket.setTimeout(PROXY_REQUEST_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('Upstream proxy connection timed out'));
    });
    socket.once('error', onError);
    socket.once(readyEvent, () => {
      socket.off('error', onError);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

async function openHttpProxyTunnel(proxy: ProxyEntry, targetHost: string, targetPort: number) {
  const socket = await connectToUpstream(proxy);
  return new Promise<net.Socket>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', fail);
      socket.setTimeout(0);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const statusLine = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n')[0];
      const statusCode = Number(statusLine.split(' ')[1]);
      if (statusCode !== 200) {
        fail(new Error(`Upstream proxy refused CONNECT with status ${statusCode || 'unknown'}`));
        return;
      }
      const remaining = buffer.subarray(headerEnd + 4);
      cleanup();
      if (remaining.length) socket.unshift(remaining);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', fail);
    socket.setTimeout(PROXY_REQUEST_TIMEOUT_MS, () => fail(new Error('Upstream CONNECT timed out')));
    const auth = proxyAuthorization(proxy);
    socket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      (auth ? `Proxy-Authorization: ${auth}\r\n` : '') +
      'Proxy-Connection: Keep-Alive\r\n\r\n'
    );
  });
}

async function openProxyTunnel(proxy: ProxyEntry, targetHost: string, targetPort: number) {
  const protocol = normalizedProtocol(proxy);
  if (protocol === 'socks4' || protocol === 'socks5') {
    const connection = await SocksClient.createConnection({
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: protocol === 'socks4' ? 4 : 5,
        userId: proxy.username || undefined,
        password: decryptProxySecret(proxy.password) || undefined
      },
      timeout: PROXY_REQUEST_TIMEOUT_MS
    });
    return connection.socket;
  }
  return openHttpProxyTunnel(proxy, targetHost, targetPort);
}

async function recordProxyResult(proxyId: string, success: boolean, latencyMs?: number) {
  try {
    if (success) {
      await prisma.proxy.update({
        where: { id: proxyId },
        data: {
          successCount: { increment: 1 },
          failCount: 0,
          status: latencyMs !== undefined && latencyMs > 5000 ? 'SLOW' : 'ALIVE',
          lastCheckedAt: new Date(),
          ...(latencyMs !== undefined ? { lastLatencyMs: latencyMs } : {})
        }
      });
    } else {
      verifiedProxyIds.delete(proxyId);
      const updated = await prisma.proxy.update({
        where: { id: proxyId },
        data: { failCount: { increment: 1 }, lastCheckedAt: new Date() }
      });
      if (updated.failCount >= MAX_CONSECUTIVE_FAILS) {
        await prisma.proxy.update({
          where: { id: proxyId },
          data: { status: 'DEAD', enabled: false }
        });
      }
    }
    lastCacheRefreshAt = 0;
  } catch {
    // Telemetry failure must never enable a direct fallback.
  }
}

async function directPublicIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: EGRESS_CHECK_HOST,
      path: EGRESS_CHECK_PATH,
      timeout: HEALTH_CHECK_TIMEOUT_MS,
      headers: { Accept: 'text/plain', 'User-Agent': 'OmniCrawl-Proxy-Check/1.0' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        const value = body.trim();
        if (response.statusCode === 200 && value) resolve(value);
        else reject(new Error(`Direct egress check returned ${response.statusCode}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('Direct egress check timed out')));
    request.on('error', reject);
  });
}

async function proxiedPublicIp(proxy: ProxyEntry): Promise<string> {
  const tunnel = await openProxyTunnel(proxy, EGRESS_CHECK_HOST, 443);
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: EGRESS_CHECK_HOST,
      path: EGRESS_CHECK_PATH,
      method: 'GET',
      agent: false,
      headers: { Accept: 'text/plain', 'User-Agent': 'OmniCrawl-Proxy-Check/1.0' },
      createConnection: () => tls.connect({ socket: tunnel, servername: EGRESS_CHECK_HOST })
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        const value = body.trim();
        if (response.statusCode === 200 && value) resolve(value);
        else reject(new Error(`Proxy egress check returned ${response.statusCode}`));
      });
    });
    request.setTimeout(HEALTH_CHECK_TIMEOUT_MS, () => request.destroy(new Error('Proxy egress check timed out')));
    request.once('error', reject);
    request.end();
  });
}

async function computeProxyReadiness(): Promise<ProxyReadiness> {
  const checkedAt = new Date().toISOString();
  const [proxies, configuredProxies] = await Promise.all([
    refreshProxyCache(),
    prisma.proxy.count({ where: { enabled: true, group: { enabled: true } } })
  ]);
  if (configuredProxies === 0) {
    return {
      ready: true,
      mode: 'direct',
      activeProxies: 0,
      verifiedProxies: 0,
      checkedAt,
      message: 'Không sử dụng proxy; crawler chạy trực tiếp bằng kết nối của máy.'
    };
  }
  if (!proxies.length) {
    return {
      ready: false,
      mode: 'blocked',
      activeProxies: 0,
      verifiedProxies: 0,
      checkedAt,
      message: 'Proxy đã được cấu hình nhưng không có địa chỉ nào hoạt động.'
    };
  }

  let machineIp: string;
  try {
    machineIp = await directPublicIp();
  } catch {
    return {
      ready: false,
      mode: 'blocked',
      activeProxies: proxies.length,
      verifiedProxies: 0,
      checkedAt,
      message: 'Không xác minh được IP máy; crawler bị khóa theo cơ chế fail-closed.'
    };
  }

  let verified = 0;
  for (let offset = 0; offset < proxies.length; offset += 5) {
    const batch = proxies.slice(offset, offset + 5);
    await Promise.all(batch.map(async proxy => {
      const startedAt = Date.now();
      try {
        const exitIp = await proxiedPublicIp(proxy);
        if (exitIp === machineIp) throw new Error('Proxy exit IP matches machine IP');
        verifiedProxyIds.set(proxy.id, Date.now());
        verified += 1;
        await recordProxyResult(proxy.id, true, Date.now() - startedAt);
      } catch {
        verifiedProxyIds.delete(proxy.id);
        await recordProxyResult(proxy.id, false);
      }
    }));
  }

  return {
    ready: verified > 0,
    mode: verified > 0 ? 'proxy' : 'blocked',
    activeProxies: proxies.length,
    verifiedProxies: verified,
    checkedAt,
    message: verified > 0
      ? `${verified}/${proxies.length} proxy đã xác minh IP egress khác IP máy.`
      : 'Không proxy nào vượt qua kiểm tra IP egress; crawler bị khóa để tránh lộ IP thật.'
  };
}

export async function getProxyReadiness(options: { force?: boolean } = {}) {
  const now = Date.now();
  if (
    !options.force &&
    lastReadiness &&
    now - Date.parse(lastReadiness.checkedAt) < CACHE_TTL_MS
  ) return lastReadiness;
  const freshVerified = [...verifiedProxyIds.values()]
    .filter(timestamp => now - timestamp < VERIFICATION_TTL_MS).length;
  const proxies = await refreshProxyCache();
  if (!options.force && freshVerified > 0) {
    return {
      ready: true,
      mode: 'proxy',
      activeProxies: proxies.length,
      verifiedProxies: freshVerified,
      checkedAt: new Date().toISOString(),
      message: `${freshVerified}/${proxies.length} proxy có xác minh egress còn hiệu lực.`
    } satisfies ProxyReadiness;
  }
  if (!readinessInFlight) {
    readinessInFlight = computeProxyReadiness()
      .then(readiness => {
        lastReadiness = readiness;
        return readiness;
      })
      .finally(() => { readinessInFlight = null; });
  }
  return readinessInFlight;
}

async function usableProxies() {
  const readiness = await getProxyReadiness();
  if (!readiness.ready) return [];
  return refreshProxyCache();
}

function rejectConnect(clientSocket: net.Socket, status: number, message: string) {
  clientSocket.end(`HTTP/1.1 ${status} Service Unavailable\r\nConnection: close\r\n\r\n${message}`);
}

function handleConnect(clientReq: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) {
  void (async () => {
    const authority = clientReq.url || '';
    const separator = authority.lastIndexOf(':');
    const hostname = separator > 0 ? authority.slice(0, separator).replace(/^\[|\]$/g, '') : authority;
    const port = separator > 0 ? Number(authority.slice(separator + 1)) : 443;
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      rejectConnect(clientSocket, 400, 'Invalid CONNECT target');
      return;
    }
    const proxies = await usableProxies();
    const proxy = selectProxy(proxies);
    if (!proxy) {
      rejectConnect(clientSocket, 503, 'No verified upstream proxy is available; direct access is disabled.');
      return;
    }
    recordProxyRequest(proxy.id);
    const startedAt = Date.now();
    try {
      const upstream = await openProxyTunnel(proxy, hostname, port);
      await recordProxyResult(proxy.id, true, Date.now() - startedAt);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
      upstream.once('error', () => clientSocket.destroy());
      clientSocket.once('error', () => upstream.destroy());
      clientSocket.once('close', () => upstream.destroy());
    } catch (error) {
      await recordProxyResult(proxy.id, false);
      console.error(`[ProxyServer] CONNECT ${authority} failed through proxy ${proxy.id}:`, error instanceof Error ? error.message : error);
      rejectConnect(clientSocket, 502, 'Verified upstream proxy connection failed; direct access is disabled.');
    }
  })().catch(() => rejectConnect(clientSocket, 503, 'Proxy readiness check failed; direct access is disabled.'));
}

function handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse) {
  void (async () => {
    let target: URL;
    try {
      target = new URL(clientReq.url || '');
    } catch {
      clientRes.writeHead(400).end('Absolute HTTP URL required');
      return;
    }
    if (target.protocol !== 'http:') {
      clientRes.writeHead(400).end('Use CONNECT for HTTPS targets');
      return;
    }
    const proxies = await usableProxies();
    const proxy = selectProxy(proxies);
    if (!proxy) {
      clientRes.writeHead(503).end('No verified upstream proxy is available; direct access is disabled.');
      return;
    }
    recordProxyRequest(proxy.id);
    const startedAt = Date.now();
    try {
      const tunnel = await openProxyTunnel(proxy, target.hostname, Number(target.port || 80));
      const headers = { ...clientReq.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = http.request({
        hostname: target.hostname,
        port: Number(target.port || 80),
        path: `${target.pathname}${target.search}`,
        method: clientReq.method,
        headers,
        agent: false,
        createConnection: () => tunnel
      }, upstreamRes => {
        void recordProxyResult(proxy.id, true, Date.now() - startedAt);
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      });
      upstream.setTimeout(PROXY_REQUEST_TIMEOUT_MS, () => upstream.destroy(new Error('Proxy request timed out')));
      upstream.once('error', error => {
        void recordProxyResult(proxy.id, false);
        if (!clientRes.headersSent) clientRes.writeHead(502);
        clientRes.end('Verified upstream proxy request failed; direct access is disabled.');
        console.error(`[ProxyServer] HTTP ${target.hostname} failed through proxy ${proxy.id}:`, error.message);
      });
      clientReq.pipe(upstream);
    } catch {
      await recordProxyResult(proxy.id, false);
      clientRes.writeHead(502).end('Verified upstream proxy connection failed; direct access is disabled.');
    }
  })().catch(() => clientRes.writeHead(503).end('Proxy readiness check failed; direct access is disabled.'));
}

export async function checkAllProxies() {
  const readiness = await getProxyReadiness({ force: true });
  return {
    alive: readiness.verifiedProxies,
    dead: Math.max(0, readiness.activeProxies - readiness.verifiedProxies),
    slow: 0,
    readiness
  };
}

export function startProxyServer() {
  const server = http.createServer(handleRequest);
  server.on('connect', handleConnect);
  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[ProxyServer] Fail-closed local proxy listening on http://127.0.0.1:${PROXY_PORT}`);
  });
  const healthCheckTimer = setInterval(() => void getProxyReadiness({ force: true }), HEALTH_CHECK_INTERVAL_MS);
  healthCheckTimer.unref();
  return server;
}

export async function getProxyStats() {
  const [total, alive, dead, slow, unknown, disabled] = await Promise.all([
    prisma.proxy.count(),
    prisma.proxy.count({ where: { status: 'ALIVE', enabled: true } }),
    prisma.proxy.count({ where: { status: 'DEAD' } }),
    prisma.proxy.count({ where: { status: 'SLOW', enabled: true } }),
    prisma.proxy.count({ where: { status: 'UNKNOWN', enabled: true } }),
    prisma.proxy.count({ where: { enabled: false } })
  ]);
  const avgLatency = await prisma.proxy.aggregate({
    where: { status: 'ALIVE', enabled: true, lastLatencyMs: { not: null } },
    _avg: { lastLatencyMs: true }
  });
  const readiness = await getProxyReadiness();
  return {
    total,
    alive,
    dead,
    slow,
    unknown,
    disabled,
    avgLatencyMs: Math.round(avgLatency._avg.lastLatencyMs || 0),
    readiness
  };
}
