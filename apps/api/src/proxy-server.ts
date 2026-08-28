import * as http from 'http';
import * as net from 'net';
import * as url from 'url';
import { prisma } from '@omnicrawl/database';

const PROXY_PORT = Number(process.env.PROXY_PORT || 8888);
const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_FAILS = 3;
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const PROXY_REQUEST_TIMEOUT_MS = 30_000;

// Per-proxy rate limiting
const proxyRequestTimestamps = new Map<string, number[]>();
const MAX_REQUESTS_PER_STATIC_PROXY_PER_MINUTE = 300;

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

// Cached list refreshed periodically
let cachedProxies: ProxyEntry[] = [];
let lastCacheRefreshAt = 0;
const CACHE_TTL_MS = 30_000; // 30 seconds

async function refreshProxyCache(): Promise<ProxyEntry[]> {
  const now = Date.now();
  if (cachedProxies.length > 0 && now - lastCacheRefreshAt < CACHE_TTL_MS) {
    return cachedProxies;
  }
  try {
    cachedProxies = await prisma.proxy.findMany({
      where: {
        enabled: true,
        status: { not: 'DEAD' },
        group: { enabled: true }
      },
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
    console.error('[ProxyServer] Failed to refresh proxy cache:', error);
  }
  return cachedProxies;
}

function isProxyRateLimited(proxy: ProxyEntry): boolean {
  if (proxy.isRotating) return false;
  const now = Date.now();
  const timestamps = proxyRequestTimestamps.get(proxy.id) || [];
  const recentTimestamps = timestamps.filter(t => now - t < 60_000);
  proxyRequestTimestamps.set(proxy.id, recentTimestamps);
  return recentTimestamps.length >= MAX_REQUESTS_PER_STATIC_PROXY_PER_MINUTE;
}

function recordProxyRequest(proxyId: string) {
  const timestamps = proxyRequestTimestamps.get(proxyId) || [];
  timestamps.push(Date.now());
  proxyRequestTimestamps.set(proxyId, timestamps);
}

function selectProxy(proxies: ProxyEntry[]): ProxyEntry | null {
  // Filter out rate-limited proxies
  const available = proxies.filter(p => !isProxyRateLimited(p));
  if (available.length === 0) return null;

  // Weighted random: prefer low-latency, high-success proxies
  const weights = available.map(p => {
    let weight = 10;
    // Prefer lower latency
    if (p.lastLatencyMs !== null) {
      if (p.lastLatencyMs < 500) weight += 5;
      else if (p.lastLatencyMs < 1000) weight += 3;
      else if (p.lastLatencyMs < 2000) weight += 1;
      else weight -= 2;
    }
    // Penalize proxies with recent failures
    weight -= Math.min(5, p.failCount);
    // Rotating gateways get slight preference (they handle rotation themselves)
    if (p.isRotating) weight += 3;
    return Math.max(1, weight);
  });

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let random = Math.random() * totalWeight;
  for (let i = 0; i < available.length; i++) {
    random -= weights[i];
    if (random <= 0) return available[i];
  }
  return available[available.length - 1];
}

function proxyAuthHeader(proxy: ProxyEntry): string | null {
  if (!proxy.username) return null;
  const credentials = proxy.password
    ? `${proxy.username}:${proxy.password}`
    : proxy.username;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

async function recordProxyResult(proxyId: string, success: boolean, latencyMs?: number) {
  try {
    if (success) {
      await prisma.proxy.update({
        where: { id: proxyId },
        data: {
          successCount: { increment: 1 },
          failCount: 0,
          status: 'ALIVE',
          lastCheckedAt: new Date(),
          ...(latencyMs !== undefined ? { lastLatencyMs: latencyMs } : {})
        }
      });
    } else {
      const proxy = await prisma.proxy.update({
        where: { id: proxyId },
        data: {
          failCount: { increment: 1 },
          lastCheckedAt: new Date()
        }
      });
      if (proxy.failCount >= MAX_CONSECUTIVE_FAILS) {
        await prisma.proxy.update({
          where: { id: proxyId },
          data: { status: 'DEAD', enabled: false }
        });
        console.log(`[ProxyServer] Proxy ${proxy.host}:${proxy.port} disabled after ${MAX_CONSECUTIVE_FAILS} consecutive failures`);
      }
    }
    // Invalidate cache after DB update
    lastCacheRefreshAt = 0;
  } catch (error) {
    // Non-critical: don't crash the proxy for a DB update failure
  }
}

// --- HTTPS CONNECT Tunnel (for HTTPS requests through upstream proxy) ---
function handleConnect(
  clientReq: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer
) {
  const targetHost = clientReq.url || '';
  const [hostname, portStr] = targetHost.split(':');
  const port = parseInt(portStr, 10) || 443;

  (async () => {
    const proxies = await refreshProxyCache();
    if (proxies.length === 0) {
      // No proxies available: connect directly
      console.log(`[ProxyServer] CONNECT ${targetHost} → DIRECT (no configured proxies)`);
      const upstream = net.connect(port, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => {
        clientSocket.destroy();
      });
      return;
    }

    const proxy = selectProxy(proxies);
    if (!proxy) {
      // DO NOT fall back to DIRECT when proxies are configured to prevent leaking the real IP!
      console.warn(`[ProxyServer] CONNECT ${targetHost} → 503 (all ${proxies.length} proxies are rate-limited or busy)`);
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nAll configured proxies are currently busy or rate-limited.');
      clientSocket.destroy();
      return;
    }

    recordProxyRequest(proxy.id);
    const startTime = Date.now();
    console.log(`[ProxyServer] CONNECT ${targetHost} → ${proxy.host}:${proxy.port}`);

    // Send CONNECT to upstream proxy
    const upstreamSocket = net.connect(proxy.port, proxy.host, () => {
      let connectReq = `CONNECT ${targetHost} HTTP/1.1\r\nHost: ${targetHost}\r\n`;
      const auth = proxyAuthHeader(proxy);
      if (auth) {
        connectReq += `Proxy-Authorization: ${auth}\r\n`;
      }
      connectReq += '\r\n';
      upstreamSocket.write(connectReq);
    });

    upstreamSocket.setTimeout(PROXY_REQUEST_TIMEOUT_MS);

    let buffer = Buffer.alloc(0);
    let established = false;

    const onUpstreamData = (chunk: Buffer) => {
      if (established) return;
      buffer = Buffer.concat([buffer, chunk]);
      const headerEndIndex = buffer.indexOf('\r\n\r\n');
      if (headerEndIndex === -1) return;

      established = true;
      // Remove temporary data listener so pipe() does not duplicate packets!
      upstreamSocket.off('data', onUpstreamData);

      const headerStr = buffer.subarray(0, headerEndIndex).toString('latin1');
      const statusCode = parseInt(headerStr.split(' ')[1], 10);

      if (statusCode === 200) {
        const latency = Date.now() - startTime;
        void recordProxyResult(proxy.id, true, latency);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        // Forward any binary payload that arrived after the HTTP 200 header
        const remaining = buffer.subarray(headerEndIndex + 4);
        if (remaining.length > 0) {
          clientSocket.write(remaining);
        }

        // Forward initial head data if provided
        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }

        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      } else {
        void recordProxyResult(proxy.id, false);
        console.error(`[ProxyServer] Upstream proxy returned ${statusCode} for CONNECT ${targetHost}`);
        clientSocket.write(`HTTP/1.1 ${statusCode} Proxy Error\r\n\r\n`);
        clientSocket.destroy();
        upstreamSocket.destroy();
      }
    };

    upstreamSocket.on('data', onUpstreamData);

    upstreamSocket.on('error', (err) => {
      void recordProxyResult(proxy.id, false);
      console.error(`[ProxyServer] Upstream proxy error: ${err.message}`);
      if (!established) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      clientSocket.destroy();
    });

    upstreamSocket.on('timeout', () => {
      void recordProxyResult(proxy.id, false);
      console.error(`[ProxyServer] Upstream proxy timeout for ${targetHost}`);
      if (!established) {
        clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      }
      upstreamSocket.destroy();
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      upstreamSocket.destroy();
    });

    clientSocket.on('close', () => {
      upstreamSocket.destroy();
    });
  })().catch((error) => {
    console.error('[ProxyServer] CONNECT handler error:', error);
    clientSocket.destroy();
  });
}

// --- HTTP forwarding (for plain HTTP requests through upstream proxy) ---
function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse
) {
  (async () => {
    const targetUrl = clientReq.url || '';
    const proxies = await refreshProxyCache();

    if (proxies.length === 0) {
      // No proxies: forward directly
      const parsed = url.parse(targetUrl);
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parseInt(parsed.port || '80', 10),
        path: parsed.path,
        method: clientReq.method,
        headers: { ...clientReq.headers } as Record<string, string | string[] | undefined>
      };
      delete (options.headers as any)['proxy-connection'];
      
      const upstream = http.request(options, (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      });
      upstream.on('error', () => {
        clientRes.writeHead(502);
        clientRes.end('Bad Gateway');
      });
      clientReq.pipe(upstream);
      return;
    }

    const proxy = selectProxy(proxies);
    if (!proxy) {
      clientRes.writeHead(503);
      clientRes.end('All proxies rate-limited');
      return;
    }

    recordProxyRequest(proxy.id);
    const startTime = Date.now();
    console.log(`[ProxyServer] HTTP ${clientReq.method} ${targetUrl} → ${proxy.host}:${proxy.port}`);

    const options: http.RequestOptions = {
      hostname: proxy.host,
      port: proxy.port,
      path: targetUrl,
      method: clientReq.method,
      headers: { ...clientReq.headers } as Record<string, string | string[] | undefined>
    };
    delete (options.headers as any)['proxy-connection'];

    const auth = proxyAuthHeader(proxy);
    if (auth) {
      (options.headers as any)['Proxy-Authorization'] = auth;
    }

    const upstream = http.request(options, (upstreamRes) => {
      const latency = Date.now() - startTime;
      void recordProxyResult(proxy.id, true, latency);
      clientRes.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });

    upstream.setTimeout(PROXY_REQUEST_TIMEOUT_MS);

    upstream.on('error', (err) => {
      void recordProxyResult(proxy.id, false);
      console.error(`[ProxyServer] HTTP proxy error: ${err.message}`);
      clientRes.writeHead(502);
      clientRes.end('Bad Gateway');
    });

    upstream.on('timeout', () => {
      void recordProxyResult(proxy.id, false);
      upstream.destroy();
      clientRes.writeHead(504);
      clientRes.end('Gateway Timeout');
    });

    clientReq.pipe(upstream);
  })().catch((error) => {
    console.error('[ProxyServer] Request handler error:', error);
    clientRes.writeHead(500);
    clientRes.end('Internal Server Error');
  });
}

// --- Health Check ---
export async function checkAllProxies() {
  try {
    const proxies = await prisma.proxy.findMany({
      where: { enabled: true },
      select: { id: true, protocol: true, host: true, port: true, username: true, password: true, isRotating: true, lastLatencyMs: true, failCount: true, successCount: true }
    });

    console.log(`[ProxyServer] Health checking ${proxies.length} proxies...`);
    const results = { alive: 0, dead: 0, slow: 0 };

    for (const proxy of proxies) {
      try {
        const startTime = Date.now();
        const isAlive = await checkSingleProxy(proxy);
        const latency = Date.now() - startTime;

        if (isAlive) {
          const status = latency > 5000 ? 'SLOW' : 'ALIVE';
          if (status === 'SLOW') results.slow++;
          else results.alive++;
          await prisma.proxy.update({
            where: { id: proxy.id },
            data: {
              status,
              lastCheckedAt: new Date(),
              lastLatencyMs: latency,
              failCount: 0
            }
          });
        } else {
          results.dead++;
          await prisma.proxy.update({
            where: { id: proxy.id },
            data: {
              status: 'DEAD',
              lastCheckedAt: new Date(),
              failCount: { increment: 1 }
            }
          });
        }
      } catch {
        results.dead++;
      }
    }

    lastCacheRefreshAt = 0; // Invalidate cache
    console.log(`[ProxyServer] Health check done: ${results.alive} alive, ${results.slow} slow, ${results.dead} dead`);
    return results;
  } catch (error) {
    console.error('[ProxyServer] Error during proxy health checks:', error);
    return { alive: 0, dead: 0, slow: 0 };
  }
}

function checkSingleProxy(proxy: ProxyEntry): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(false);
    }, HEALTH_CHECK_TIMEOUT_MS);

    // Try a CONNECT to shopee.vn:443 through the proxy
    const socket = net.connect(proxy.port, proxy.host, () => {
      let connectReq = `CONNECT shopee.vn:443 HTTP/1.1\r\nHost: shopee.vn:443\r\n`;
      const auth = proxyAuthHeader(proxy);
      if (auth) {
        connectReq += `Proxy-Authorization: ${auth}\r\n`;
      }
      connectReq += '\r\n';
      socket.write(connectReq);
    });

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEndIndex = buffer.indexOf('\r\n\r\n');
      if (headerEndIndex !== -1) {
        const statusLine = buffer.subarray(0, headerEndIndex).toString('latin1').split('\r\n')[0];
        const statusCode = parseInt(statusLine.split(' ')[1], 10);
        finish(statusCode === 200);
      }
    });

    socket.on('error', () => {
      finish(false);
    });

    socket.on('timeout', () => {
      finish(false);
    });

    socket.setTimeout(HEALTH_CHECK_TIMEOUT_MS);
  });
}

// --- Server Startup ---
export function startProxyServer() {
  const server = http.createServer(handleRequest);
  server.on('connect', handleConnect);

  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`[ProxyServer] Local proxy server running on http://127.0.0.1:${PROXY_PORT}`);
    console.log(`[ProxyServer] Configure your browser to use this proxy for shopee.vn traffic`);
  });

  // Periodic health check (unref so timer does not block graceful shutdown)
  const healthCheckTimer = setInterval(() => {
    void checkAllProxies();
  }, HEALTH_CHECK_INTERVAL_MS);
  healthCheckTimer.unref();

  // Initial proxy cache load
  void refreshProxyCache().then((proxies) => {
    console.log(`[ProxyServer] Loaded ${proxies.length} active proxies`);
  });

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

  return {
    total,
    alive,
    dead,
    slow,
    unknown,
    disabled,
    avgLatencyMs: Math.round(avgLatency._avg.lastLatencyMs || 0)
  };
}
