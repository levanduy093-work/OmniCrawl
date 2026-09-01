const DASHBOARD_ORIGIN = 'http://localhost:5173';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

async function reportStatus(connected) {
  let authStatus = { shopeeLoggedIn: false, tiktokLoggedIn: false };
  if (connected) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' });
      if (res?.statuses) authStatus = res.statuses;
    } catch {
      // Ignore errors
    }
  }

  window.postMessage({
    source: 'OMNICRAWL_EXTENSION',
    type: 'STATUS',
    connected,
    version: EXTENSION_VERSION,
    authStatus
  }, DASHBOARD_ORIGIN);
}

function sendToBackground(message) {
  try {
    return chrome.runtime.sendMessage(message).catch((error) => {
      void reportStatus(false);
      throw error;
    });
  } catch (error) {
    void reportStatus(false);
    return Promise.reject(error);
  }
}

function reportProxyConfiguration(result) {
  window.postMessage({
    source: 'OMNICRAWL_EXTENSION',
    type: 'PROXY_CONFIGURATION',
    ok: Boolean(result?.ok),
    message: typeof result?.message === 'string' ? result.message : ''
  }, DASHBOARD_ORIGIN);
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== DASHBOARD_ORIGIN) return;
  const message = event.data;
  if (!message || message.source !== 'OMNICRAWL_DASHBOARD') return;

  if (message.type === 'CONFIGURE') {
    sendToBackground({
      type: 'CONFIGURE',
      token: message.token,
      apiBase: 'http://localhost:3001'
    }).then((result) => {
      if (!result?.ok) {
        reportProxyConfiguration({
          ok: false,
          message: result?.message || 'Browser Agent từ chối cấu hình proxy.'
        });
        return reportStatus(false);
      }
      reportProxyConfiguration(result);
      return reportStatus(true);
    }).catch((error) => {
      reportProxyConfiguration({
        ok: false,
        message: error instanceof Error ? error.message : 'Không thể kết nối Browser Agent.'
      });
      return reportStatus(false);
    });
  }

  if (message.type === 'PING') {
    sendToBackground({ type: 'PING' })
      .then(() => reportStatus(true))
      .catch(() => reportStatus(false));
  }

  if (message.type === 'POLL_NOW') {
    sendToBackground({ type: 'POLL_NOW' }).catch(() => undefined);
  }

  if (message.type === 'STOP_JOB') {
    sendToBackground({
      type: 'STOP_JOB',
      runId: String(message.runId || '')
    }).catch(() => undefined);
  }

  if (message.type === 'OPEN_TAB') {
    sendToBackground({ type: 'OPEN_TAB', url: message.url }).catch(() => undefined);
  }
});

sendToBackground({ type: 'PING' })
  .then(() => reportStatus(true))
  .catch(() => reportStatus(false));
