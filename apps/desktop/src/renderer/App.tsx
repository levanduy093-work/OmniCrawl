import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import logoIcon from '../../../dashboard/src/assets/logo_icon.png';
import type { ActorSummary, AppStatus, DatasetItem, RunSummary } from '../shared/contracts';
import { useI18n } from './i18n';
import { LanguageSwitcher } from './components/LanguageSwitcher';

type Section = 'crawlers' | 'runs' | 'browser' | 'data' | 'settings';
type IconName = 'bot' | 'activity' | 'globe' | 'settings' | 'search' | 'play' | 'database' | 'stop' | 'download' | 'arrow';

const terminalStatuses = new Set(['STOPPED', 'SUCCESS', 'PARTIAL', 'FAILED']);

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    bot: <><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M9 4h6"/></>,
    activity: <><path d="M3 12h4l2.2-5 4.1 10 2.2-5H21"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    play: <><path d="m8 5 11 7-11 7Z"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    stop: <><rect x="6" y="6" width="12" height="12" rx="2"/></>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Logo() {
  return <div className="brand"><span className="brand-icon"><img src={logoIcon} alt="" /></span><span className="brand-name"><b>Omni</b><strong>Crawl</strong></span></div>;
}

function elapsed(run: RunSummary) {
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function App() {
  const { t, formatDate } = useI18n();
  const [section, setSection] = useState<Section>('crawlers');
  const [actors, setActors] = useState<ActorSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [items, setItems] = useState<DatasetItem[]>([]);
  const [keyword, setKeyword] = useState('máy in 3d');
  const [maxItems, setMaxItems] = useState(50);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [chromeAuthBusy, setChromeAuthBusy] = useState(false);
  const [cookieModalOpen, setCookieModalOpen] = useState(false);
  const [cookieInput, setCookieInput] = useState('');
  const [toastMessage, setToastMessage] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);
  const browserHostRef = useRef<HTMLDivElement>(null);

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId) ?? null, [runs, selectedRunId]);
  const filteredRuns = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term ? runs.filter((run) => `${run.id} ${run.actorName} ${String(run.input.keyword ?? '')}`.toLowerCase().includes(term)) : runs;
  }, [query, runs]);
  const browserUrl = status?.browser.url ?? '';
  const needsShopeeLogin = browserUrl.includes('is_logged_in=false') || browserUrl.includes('/buyer/login');
  const shopeeState = !status?.browser.platform
    ? t('crawlers.shopeeNotOpen')
    : needsShopeeLogin
      ? t('crawlers.shopeeNotLoggedIn')
      : t('crawlers.shopeeOpen');

  const refreshItems = useCallback(async (runId: string | null) => setItems(runId ? await window.omnicrawl.getRunItems(runId) : []), []);

  useEffect(() => {
    void Promise.all([window.omnicrawl.getStatus(), window.omnicrawl.listActors(), window.omnicrawl.listRuns()])
      .then(([nextStatus, nextActors, nextRuns]) => {
        setStatus(nextStatus); setActors(nextActors); setRuns(nextRuns);
        if (nextRuns[0]) setSelectedRunId(nextRuns[0].id);
      });
    const removeRun = window.omnicrawl.onRunChanged((changed) => {
      setRuns((current) => current.some((run) => run.id === changed.id)
        ? current.map((run) => run.id === changed.id ? changed : run)
        : [changed, ...current]);
      setSelectedRunId((current) => current ?? changed.id);
      void refreshItems(changed.id);
    });
    const removeBrowser = window.omnicrawl.onBrowserChanged((browser) => setStatus((current) => current ? { ...current, browser } : current));
    return () => { removeRun(); removeBrowser(); };
  }, [refreshItems]);

  useEffect(() => { void refreshItems(selectedRunId); }, [refreshItems, selectedRunId]);

  useEffect(() => {
    const visible = section === 'browser';
    void window.omnicrawl.setBrowserVisible(visible);
    if (!visible || !browserHostRef.current) return;
    const host = browserHostRef.current;
    const update = () => {
      const rect = host.getBoundingClientRect();
      void window.omnicrawl.setBrowserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(host); window.addEventListener('resize', update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [section]);

  async function openShopee() { setSection('browser'); await window.omnicrawl.openPlatform('shopee'); }
  async function startRun() {
    setBusy(true);
    try {
      const run = await window.omnicrawl.startRun('shopee-search', { keyword, maxItems });
      setSelectedRunId(run.id); setSection('browser');
    } finally { setBusy(false); }
  }
  function viewRun(run: RunSummary) { setSelectedRunId(run.id); setSection('data'); }

  async function handleLoginWithChrome() {
    setChromeAuthBusy(true);
    setToastMessage({
      type: 'info',
      text: t('browser.openingChrome')
    });
    try {
      const res = await window.omnicrawl.loginWithChrome('shopee');
      if (res.success) {
        setToastMessage({
          type: 'success',
          text: t('browser.loginChromeSuccess', { count: res.count ?? 0 })
        });
      } else if (res.error) {
        setToastMessage({ type: 'error', text: res.error });
      }
    } catch (err: any) {
      setToastMessage({ type: 'error', text: err.message || t('browser.connectChromeError') });
    } finally {
      setChromeAuthBusy(false);
    }
  }

  async function handleImportCookie() {
    if (!cookieInput.trim()) return;
    try {
      const res = await window.omnicrawl.importCookies('shopee', cookieInput);
      setToastMessage({
        type: 'success',
        text: t('browser.cookieImportSuccess', { count: res.count ?? 0 })
      });
      setCookieModalOpen(false);
      setCookieInput('');
    } catch (err: any) {
      alert(err.message || t('browser.cookieImportError'));
    }
  }

  const columns = useMemo(() => [...new Set(items.flatMap((item) => Object.keys(item.data)))].slice(0, 8), [items]);
  const pageTitle = section === 'crawlers' ? t('sidebar.crawlers') : section === 'runs' ? t('sidebar.runs') : section === 'browser' ? t('sidebar.browser') : section === 'settings' ? t('sidebar.settings') : t('sidebar.data');

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav className="nav-list">
          <button className={section === 'crawlers' ? 'active' : ''} onClick={() => setSection('crawlers')}><Icon name="bot" /><span>{t('sidebar.crawlers')}</span></button>
          <button className={section === 'runs' || section === 'data' ? 'active' : ''} onClick={() => setSection('runs')}><Icon name="activity" /><span>{t('sidebar.runs')}</span></button>
          <button className={section === 'browser' ? 'active' : ''} onClick={() => void openShopee()}><Icon name="globe" /><span>{t('sidebar.browser')}</span></button>
        </nav>
        <nav className="nav-list nav-bottom"><button className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')}><Icon name="settings" /><span>{t('sidebar.settings')}</span></button></nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <h1>{pageTitle}</h1>
          <div className="top-actions">
            {(section === 'crawlers' || section === 'runs') && <label className="search-box"><Icon name="search" size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('topbar.searchPlaceholder')} /></label>}
            <LanguageSwitcher />
            <button className="profile-button" onClick={() => void openShopee()}><span className={`connection-dot ${needsShopeeLogin ? 'warning' : status?.browser.platform ? 'online' : ''}`} />{t('topbar.shopee')}</button>
          </div>
        </header>

        {section === 'crawlers' && (
          <div className="content-page"><div className="actor-grid">
            <article className="actor-card">
              <div className="actor-title-row"><span className="actor-icon"><Icon name="bot" /></span><div><h2>shopee-scraper</h2><code>v{actors[0]?.version ?? '0.1.0'}</code></div></div>
              <p className="actor-description">{t('crawlers.desc')}</p>
              <div className="connection-panel"><span className={`connection-dot ${needsShopeeLogin ? 'warning' : status?.browser.platform ? 'online' : ''}`} /><span>{shopeeState}</span><button onClick={() => void openShopee()}>{needsShopeeLogin ? t('crawlers.loginBtn') : t('crawlers.openShopeeBtn')}</button></div>
              <div className="actor-form"><label>{t('crawlers.keywordLabel')}<input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={t('crawlers.keywordPlaceholder')} /></label><label>{t('crawlers.maxItemsLabel')}<input type="number" min={1} max={500} value={maxItems} onChange={(event) => setMaxItems(Number(event.target.value))} /></label></div>
              <button className="run-button" disabled={busy || !keyword.trim()} onClick={() => void startRun()}><Icon name="play" size={15} />{busy ? t('crawlers.runningBtn') : t('crawlers.runBtn')}</button>
            </article>
            <article className="actor-placeholder"><span className="actor-icon muted-icon"><Icon name="bot" /></span><h3>{t('crawlers.addPlaceholderTitle')}</h3><p>{t('crawlers.addPlaceholderDesc')}</p></article>
          </div></div>
        )}

        {section === 'runs' && (
          <div className="content-page"><section className="table-card">
            {filteredRuns.length === 0 ? <div className="empty-state"><span className="empty-icon"><Icon name="activity" size={22} /></span><h2>{t('runs.emptyTitle')}</h2><p>{t('runs.emptyDesc')}</p><button onClick={() => setSection('crawlers')}>{t('runs.openCrawlers')} <Icon name="arrow" size={15} /></button></div> :
              <div className="table-scroll"><table><thead><tr><th>{t('runs.table.id')}</th><th>{t('runs.table.crawler')}</th><th>{t('runs.table.status')}</th><th>{t('runs.table.items')}</th><th>{t('runs.table.started')}</th><th>{t('runs.table.duration')}</th><th>{t('runs.table.actions')}</th></tr></thead><tbody>{filteredRuns.map((run) => {
                const statusLabel = t(`runs.statuses.${run.status}`) !== `runs.statuses.${run.status}` ? t(`runs.statuses.${run.status}`) : run.status;
                return (
                  <tr key={run.id} onClick={() => viewRun(run)}>
                    <td><code>{run.id.slice(0, 8)}</code></td>
                    <td><strong>{run.actorName}</strong><small>{String(run.input.keyword ?? '')}</small></td>
                    <td><span className={`status-badge status-${run.status.toLowerCase()}`}>{statusLabel}</span></td>
                    <td>{run.itemCount}</td>
                    <td>{formatDate(run.startedAt ?? run.createdAt)}</td>
                    <td>{elapsed(run)}</td>
                    <td>
                      <div className="row-actions">
                        <button onClick={(event) => { event.stopPropagation(); viewRun(run); }}>{t('runs.viewData')}</button>
                        {!terminalStatuses.has(run.status) && <button className="stop-action" onClick={(event) => { event.stopPropagation(); void window.omnicrawl.stopRun(run.id); }}><Icon name="stop" size={13} /> {t('runs.stop')}</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}</tbody></table></div>}
          </section></div>
        )}

        {section === 'browser' && <div className={`browser-page ${status?.browser.notice || toastMessage ? 'has-notice' : ''}`}>
          {toastMessage && (
            <div className={`browser-toast toast-${toastMessage.type}`} role="status">
              <span>{toastMessage.type === 'success' ? '✓' : toastMessage.type === 'error' ? '!' : 'ℹ'}</span>
              <p>{toastMessage.text}</p>
              <button className="toast-dismiss" onClick={() => setToastMessage(null)}>✕</button>
            </div>
          )}
          {status?.browser.notice && <div className="browser-notice" role="status"><span>!</span><p>{status.browser.notice}</p></div>}
          <div className="browser-toolbar">
            <span className={`connection-dot ${needsShopeeLogin ? 'warning' : 'online'}`} />
            <span className="browser-url">{browserUrl || 'https://shopee.vn/'}</span>
            <div className="toolbar-actions">
              <button className="toolbar-action-btn" title={t('browser.reload')} onClick={() => void window.omnicrawl.reloadBrowser()}>
                {t('browser.reload')}
              </button>
              <button
                className="toolbar-action-btn chrome-btn"
                disabled={chromeAuthBusy}
                onClick={() => void handleLoginWithChrome()}
              >
                <Icon name="globe" size={13} />
                {chromeAuthBusy ? t('browser.loginChromeBusy') : t('browser.loginChrome')}
              </button>
              <button
                className="toolbar-action-btn"
                onClick={() => setCookieModalOpen(true)}
              >
                <Icon name="database" size={13} />
                {t('browser.importCookie')}
              </button>
            </div>
            {selectedRun && !terminalStatuses.has(selectedRun.status) && <button className="stop-browser" onClick={() => void window.omnicrawl.stopRun(selectedRun.id)}><Icon name="stop" size={13} /> {t('browser.stopJob')}</button>}
          </div>
          <div ref={browserHostRef} className="browser-host">{!status?.browser.platform && <button className="primary-button" onClick={() => void openShopee()}>{t('browser.openShopee')}</button>}</div>
        </div>}

        {section === 'data' && (
          <div className="content-page data-page">
            <button className="back-link" onClick={() => setSection('runs')}>{t('data.backLink')}</button>
            <div className="data-heading">
              <div>
                <h2>{selectedRun ? String(selectedRun.input.keyword ?? selectedRun.actorName) : t('data.selectJob')}</h2>
                <p>{selectedRun ? t('data.summary', {
                  actor: selectedRun.actorName,
                  status: t(`runs.statuses.${selectedRun.status}`) !== `runs.statuses.${selectedRun.status}` ? t(`runs.statuses.${selectedRun.status}`) : selectedRun.status,
                  count: selectedRun.itemCount
                }) : ''}</p>
                {selectedRun?.error && <div className="inline-alert">{selectedRun.error}</div>}
              </div>
              <div className="export-actions">
                <button disabled={!selectedRun || !items.length} onClick={() => selectedRun && void window.omnicrawl.exportRun(selectedRun.id, 'csv')}>
                  <Icon name="download" size={14} /> {t('data.exportCsv')}
                </button>
                <button disabled={!selectedRun || !items.length} onClick={() => selectedRun && void window.omnicrawl.exportRun(selectedRun.id, 'jsonl')}>
                  {t('data.exportJsonl')}
                </button>
              </div>
            </div>
            <section className="table-card data-table">
              {items.length === 0 ? (
                <div className="empty-state compact">
                  <span className="empty-icon"><Icon name="database" size={22} /></span>
                  <h2>{t('data.emptyTitle')}</h2>
                  <p>{t('data.emptyDesc')}</p>
                </div>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id}>
                          {columns.map((column) => (
                            <td key={column}>{typeof item.data[column] === 'object' ? JSON.stringify(item.data[column]) : String(item.data[column] ?? '')}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}

        {section === 'settings' && (
          <div className="content-page settings-page">
            <section className="settings-card">
              <span className="settings-icon"><Icon name="database" /></span>
              <div>
                <h2>{t('settings.localTitle')}</h2>
                <p>{t('settings.localDesc')}</p>
                <code>{status?.dataPath}</code>
              </div>
            </section>
            <section className="settings-card">
              <span className="settings-icon"><Icon name="globe" /></span>
              <div>
                <h2>{t('settings.cloudTitle')}</h2>
                <p>{t('settings.cloudDesc')}</p>
                <span className="setting-state">{t('settings.cloudState')}</span>
              </div>
            </section>
            <section className="settings-card">
              <span className="settings-icon"><Icon name="bot" /></span>
              <div>
                <h2>{t('settings.crawlersTitle')}</h2>
                <p>{t('settings.crawlersDesc', { count: actors.length })}</p>
              </div>
            </section>
            <section className="settings-card">
              <span className="settings-icon"><Icon name="settings" /></span>
              <div>
                <h2>{t('settings.languageTitle')}</h2>
                <p>{t('settings.languageDesc')}</p>
                <div style={{ marginTop: 10 }}>
                  <LanguageSwitcher />
                </div>
              </div>
            </section>
          </div>
        )}
      </section>

      {cookieModalOpen && (
        <div className="modal-overlay" onClick={() => setCookieModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('cookieModal.title')}</h3>
              <button className="modal-close" onClick={() => setCookieModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <p>{t('cookieModal.desc')}</p>
              <textarea
                value={cookieInput}
                onChange={(e) => setCookieInput(e.target.value)}
                placeholder={t('cookieModal.placeholder')}
                rows={6}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="modal-btn-cancel" onClick={() => setCookieModalOpen(false)}>{t('cookieModal.cancel')}</button>
              <button className="modal-btn-primary" disabled={!cookieInput.trim()} onClick={() => void handleImportCookie()}>
                {t('cookieModal.apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
