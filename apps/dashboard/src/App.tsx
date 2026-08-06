import { useState, useEffect, useCallback, Fragment } from 'react'
import {
  Play,
  Activity,
  Clock,
  Settings,
  Search,
  Bot,
  LogOut,
  Eye,
  FileJson,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  AlertTriangle
} from 'lucide-react'
import Login from './Login'
import OmniCrawlLogo from './Logo'
import './App.css'

const REQUIRED_BROWSER_AGENT_VERSION = '0.11.10'

function isVersionAtLeast(current: string | null, required: string) {
  if (!current) return false
  const currentParts = current.split('.').map(Number)
  const requiredParts = required.split('.').map(Number)
  if (
    currentParts.some((part) => !Number.isInteger(part) || part < 0) ||
    requiredParts.some((part) => !Number.isInteger(part) || part < 0)
  ) return false

  const length = Math.max(currentParts.length, requiredParts.length)
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] || 0
    const requiredPart = requiredParts[index] || 0
    if (currentPart > requiredPart) return true
    if (currentPart < requiredPart) return false
  }
  return true
}

function displaySoldValue(value: unknown) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') {
    if (value === 0) return '0'
    return value.toLocaleString('vi-VN')
  }
  const candidate = typeof value === 'object' && !Array.isArray(value)
    ? (
      (value as Record<string, unknown>).value ??
      (value as Record<string, unknown>).count ??
      (value as Record<string, unknown>).text ??
      (value as Record<string, unknown>).display_text
    )
    : value
  const text = String(candidate ?? '').trim()
  if (!text) return '—'
  if (/^\d+$/.test(text)) {
    return Number(text).toLocaleString('vi-VN')
  }
  const match = text.match(
    /(\d+(?:[.,]\d+)?\s*(?:k|nghìn|tr|triệu)?\+?)(?:\s*(?:đã bán|sold))?/i
  )
  return match ? match[1].replace(/\s+/g, '') : text
}

type JsonSchemaProperty = {
  type?: 'string' | 'integer' | 'number' | 'boolean'
  title?: string
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  placeholder?: string
  enum?: string[]
  enumNames?: string[]
}

type JsonInputSchema = {
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

function parseInputSchema(schema?: string | null): JsonInputSchema | null {
  if (!schema) return null
  try {
    const parsed = JSON.parse(schema)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function applyInputDefaults(schema: string | null | undefined, values: Record<string, unknown>) {
  const parsed = parseInputSchema(schema)
  const result: Record<string, unknown> = { ...values }

  for (const [key, property] of Object.entries(parsed?.properties || {})) {
    if ((result[key] === undefined || result[key] === '') && property.default !== undefined) {
      result[key] = property.default
    }
    if ((property.type === 'integer' || property.type === 'number') && result[key] !== undefined && result[key] !== '') {
      const numberValue = Number(result[key])
      if (Number.isFinite(numberValue)) {
        result[key] = property.type === 'integer' ? Math.trunc(numberValue) : numberValue
      }
    }
  }

  return result
}

function isAdminRole(role?: string) {
  return role === 'ADMIN' || role === 'SUPER_ADMIN'
}

function humanizeFieldName(field: string) {
  const knownLabels: Record<string, string> = {
    id: 'Mã',
    itemId: 'Mã sản phẩm',
    shopId: 'Mã cửa hàng',
    title: 'Tên sản phẩm',
    name: 'Tên',
    price: 'Giá bán',
    sold: 'Đã bán',
    url: 'Liên kết',
    image: 'Hình ảnh',
    createdAt: 'Ngày tạo',
    updatedAt: 'Ngày cập nhật'
  }
  if (knownLabels[field]) return knownLabels[field]
  const words = field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : field
}

function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'))
  const [user, setUser] = useState<any>(null)
  
  // Tabs: actors, runs, schedules, marketplace
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') || 'actors')

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'users' && user && !isAdminRole(user.role)) {
      setActiveTab('actors')
    }
  }, [activeTab, user])
  
  const [actors, setActors] = useState([])
  const [runs, setRuns] = useState([])
  const [schedules, setSchedules] = useState([])
  const [newScheduleActorId, setNewScheduleActorId] = useState('')
  const [newScheduleCron, setNewScheduleCron] = useState('* * * * *')
  const [newScheduleInput, setNewScheduleInput] = useState<Record<string, unknown>>({})
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [runInputs, setRunInputs] = useState<Record<string, any>>({})
  const [browserAgentConnected, setBrowserAgentConnected] = useState(false)
  const [browserAgentDetected, setBrowserAgentDetected] = useState(false)
  const [browserAgentVersion, setBrowserAgentVersion] = useState<string | null>(null)
  const [authStatus, setAuthStatus] = useState({ shopeeLoggedIn: false, tiktokLoggedIn: false, debugTikTokCookies: '' })

  // Log Viewer State
  const [logModalOpen, setLogModalOpen] = useState(false)
  const [activeLogRunId, setActiveLogRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<string>('')
  const [runDetailOpen, setRunDetailOpen] = useState(false)
  const [runDetail, setRunDetail] = useState<any>(null)
  const [runDetailPage, setRunDetailPage] = useState(1)
  const [runDetailLoading, setRunDetailLoading] = useState(false)
  const [runDetailStatus, setRunDetailStatus] = useState<string | undefined>(undefined)

  const handleLogout = useCallback(() => {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
  }, [])

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch('http://localhost:3001/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (res.ok) setUser(await res.json())
      else handleLogout()
    } catch {
      handleLogout()
    }
  }, [handleLogout, token])

  const fetchData = useCallback(async () => {
    try {
      const headers = { 'Authorization': `Bearer ${token}` }
      const [actorsRes, runsRes, schedulesRes] = await Promise.all([
        fetch('http://localhost:3001/api/actors', { headers }),
        fetch('http://localhost:3001/api/runs', { headers }),
        fetch('http://localhost:3001/api/schedules', { headers })
      ])
      if (actorsRes.status === 401 || runsRes.status === 401) {
        handleLogout()
        return
      }
      setActors(await actorsRes.json())
      setRuns(await runsRes.json())
      if (schedulesRes.ok) setSchedules(await schedulesRes.json())
      window.postMessage({
        source: 'OMNICRAWL_DASHBOARD',
        type: 'POLL_NOW'
      }, window.location.origin)
    } catch (err) {
      console.error('Failed to fetch data', err)
    }
  }, [handleLogout, token])

  useEffect(() => {
    if (token) {
      fetchData()
      fetchUser()
    }
  }, [fetchData, fetchUser, token])

  // Poll data in background every 5 seconds to update statuses
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (token) {
      interval = setInterval(fetchData, 5000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [fetchData, token]);

  useEffect(() => {
    if (!token) {
      setBrowserAgentConnected(false)
      setBrowserAgentDetected(false)
      setBrowserAgentVersion(null)
      return
    }
    const handleAgentMessage = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.data?.source === 'OMNICRAWL_EXTENSION' &&
        event.data?.type === 'STATUS'
      ) {
        const version = typeof event.data.version === 'string' ? event.data.version : null
        setBrowserAgentDetected(true)
        setBrowserAgentVersion(version)
        setBrowserAgentConnected(
          Boolean(event.data.connected) &&
          isVersionAtLeast(version, REQUIRED_BROWSER_AGENT_VERSION)
        )
        if (event.data.authStatus) {
          setAuthStatus(event.data.authStatus)
        }
      }
    }
    window.addEventListener('message', handleAgentMessage)
    const configure = () => window.postMessage({
      source: 'OMNICRAWL_DASHBOARD',
      type: 'CONFIGURE',
      token
    }, window.location.origin)
    configure()
    const interval = setInterval(configure, 3000)
    return () => {
      window.removeEventListener('message', handleAgentMessage)
      clearInterval(interval)
    }
  }, [token])

  const triggerRun = async (id: string) => {
    try {
      const actor: any = actors.find((candidate: any) => candidate.id === id)
      const input = applyInputDefaults(actor?.inputSchema, runInputs[id] || {})
      const res = await fetch(`http://localhost:3001/api/actors/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(input)
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      alert(data.message)
      fetchData()
      fetchUser()
    } catch(err: any) {
      alert(`Failed to trigger run: ${err.message}`)
    }
  }

  const handleCreateSchedule = async () => {
    if (!newScheduleActorId || !newScheduleCron) {
      alert('Please select an actor and enter a cron expression.');
      return;
    }
    
    try {
      const res = await fetch('http://localhost:3001/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          actorId: newScheduleActorId,
          cron: newScheduleCron,
          input: applyInputDefaults(
            (actors.find((actor: any) => actor.id === newScheduleActorId) as any)?.inputSchema,
            newScheduleInput
          )
        })
      });
      if (!res.ok) throw new Error(await res.text());
      setNewScheduleCron('* * * * *');
      setNewScheduleInput({});
      fetchData();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  }

  const handleToggleSchedule = async (id: string) => {
    try {
      await fetch(`http://localhost:3001/api/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      fetchData();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  }

  const handleDeleteSchedule = async (id: string) => {
    try {
      await fetch(`http://localhost:3001/api/schedules/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      fetchData();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  }

  const handleStopRun = async (id: string) => {
    try {
      const response = await fetch(`http://localhost:3001/api/runs/${id}/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Unable to stop run (${response.status})`);
      }
      window.postMessage({
        source: 'OMNICRAWL_DASHBOARD',
        type: 'STOP_JOB',
        runId: id
      }, window.location.origin);
      fetchData();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  }

  const handleDeleteRun = async (id: string) => {
    if (!confirm('Are you sure you want to delete this run?')) return;
    try {
      await fetch(`http://localhost:3001/api/runs/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      fetchData();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  }

  const fetchLogs = useCallback(async (id: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/runs/${id}/logs`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setLogs(data.logs || 'No logs available.');
    } catch {
      setLogs('Error fetching logs.');
    }
  }, [token])

  const openLogViewer = (id: string) => {
    setActiveLogRunId(id);
    setLogModalOpen(true);
    fetchLogs(id);
  }

  const fetchRunDetail = useCallback(async (id: string, page = 1, status?: string) => {
    setRunDetailLoading(true)
    try {
      const qs = status ? `&status=${status}` : '';
      const res = await fetch(`http://localhost:3001/api/runs/${id}/items?page=${page}&pageSize=25${qs}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Run data is not available')
      setRunDetail(data)
      setRunDetailPage(page)
    } catch (err: any) {
      alert(`Không thể đọc dữ liệu: ${err.message}`)
    } finally {
      setRunDetailLoading(false)
    }
  }, [token])

  const openRunDetail = (id: string) => {
    setRunDetailOpen(true)
    setRunDetail(null)
    setRunDetailPage(1)
    setRunDetailStatus(undefined)
    fetchRunDetail(id, 1)
  }

  const downloadRunOutput = async (id: string, format: 'json' | 'jsonl', status?: 'COMPLETED' | 'FAILED') => {
    try {
      const qs = status ? `&status=${status}` : '';
      const res = await fetch(`http://localhost:3001/api/runs/${id}/export?format=${format}${qs}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Output is not available')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const disposition = res.headers.get('content-disposition') || ''
      link.download = disposition.match(/filename="([^"]+)"/)?.[1] || `omnicrawl-${id}.${format}`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(`Không thể tải output: ${err.message}`)
    }
  }

  // Poll logs if modal is open
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    if (logModalOpen && activeLogRunId) {
      interval = setInterval(() => fetchLogs(activeLogRunId), 2000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [logModalOpen, activeLogRunId, fetchLogs]);

  const handleLogin = (newToken: string, newUser: any) => {
    localStorage.setItem('token', newToken)
    setToken(newToken)
    setUser(newUser)
  }

  if (!token) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="flex h-screen bg-[#F8F9FA] font-sans text-gray-800">
      
      {/* Sidebar - Material Design 3 Navigation Drawer style */}
      <aside className={`${isSidebarOpen ? 'w-64' : 'w-20'} transition-all duration-300 bg-[#F0F4F8] p-3 flex flex-col gap-1 rounded-r-[32px] my-2 overflow-hidden shrink-0`}>
        {/* Sidebar Header */}
        <div className={`py-2.5 mb-2 flex items-center justify-between border-b border-gray-200/60 ${isSidebarOpen ? 'px-2' : 'flex-col gap-2 px-0'}`}>
          {isSidebarOpen ? (
            <>
              <OmniCrawlLogo size="sm" />
              <button 
                onClick={() => setIsSidebarOpen(false)}
                className="p-1.5 hover:bg-gray-200/80 rounded-lg text-gray-500 hover:text-gray-800 transition-colors shrink-0"
                title="Thu gọn thanh bên"
              >
                <ChevronLeft size={18} strokeWidth={2} />
              </button>
            </>
          ) : (
            <>
              <OmniCrawlLogo size="sm" showText={false} />
              <button 
                onClick={() => setIsSidebarOpen(true)}
                className="p-1.5 hover:bg-gray-200/80 rounded-lg text-gray-500 hover:text-gray-800 transition-colors"
                title="Mở rộng thanh bên"
              >
                <ChevronRight size={18} strokeWidth={2} />
              </button>
            </>
          )}
        </div>

        <nav className="flex-1 space-y-1">
          <NavItem 
            icon={<Bot />} 
            label="Crawlers" 
            active={activeTab === 'actors'} 
            onClick={() => setActiveTab('actors')} 
            collapsed={!isSidebarOpen}
          />
          <NavItem 
            icon={<Activity />} 
            label="Job Runs" 
            active={activeTab === 'runs'} 
            onClick={() => setActiveTab('runs')} 
            collapsed={!isSidebarOpen}
          />
          <NavItem 
            icon={<Clock />} 
            label="Schedules" 
            active={activeTab === 'schedules'} 
            onClick={() => setActiveTab('schedules')} 
            collapsed={!isSidebarOpen}
          />
        </nav>
        
        <div className="mt-auto pb-4 space-y-1">
          <NavItem icon={<Settings />} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} collapsed={!isSidebarOpen} />
          <NavItem icon={<LogOut />} label="Logout" active={false} onClick={handleLogout} collapsed={!isSidebarOpen} />
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 p-6 overflow-y-auto">
        <header className="flex justify-between items-center mb-8">
          <h1 className="text-2xl font-semibold text-gray-900 capitalize">{activeTab}</h1>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input 
              type="text" 
              placeholder="Search anything..." 
              className="pl-10 pr-4 py-2 text-sm bg-white rounded-full w-72 shadow-sm border border-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-100 transition-shadow"
            />
          </div>
        </header>

        {activeTab === 'actors' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 items-stretch max-w-[1280px]">
            {actors.map((actor: any) => (
              <div key={actor.id} className="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 hover:shadow-md transition-all group flex flex-col h-full justify-between">
                <div>
                  <div className="flex items-center gap-2.5 mb-2">
                    <div className="w-9 h-9 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 group-hover:scale-105 transition-transform">
                      <Bot size={18} />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-gray-900">{actor.name}</h3>
                      <span className="text-[11px] text-gray-400 font-mono">v1.0.0</span>
                    </div>
                  </div>
                  
                  <p className="text-xs text-gray-500 mb-3 min-h-[32px] line-clamp-2 leading-relaxed">
                    {actor.description || 'No description provided.'}
                  </p>
                  
                  {(actor.name === 'shopee-scraper' || actor.name === 'tiktok-scraper') && (
                    <div className="mb-3 flex flex-col gap-2">
                      <div className="rounded-xl border border-gray-200/80 bg-slate-50/70 px-3 py-2 flex items-center justify-between gap-2 min-h-[38px]">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
                          <span className="relative flex h-2 w-2 shrink-0">
                            <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                              browserAgentConnected ? 'bg-emerald-400' : 'bg-amber-400'
                            }`} />
                            <span className={`relative inline-flex rounded-full h-2 w-2 ${
                              browserAgentConnected ? 'bg-emerald-500' : 'bg-amber-500'
                            }`} />
                          </span>
                          <span className="text-[11px] leading-none flex items-center">
                            {browserAgentConnected
                              ? `Agent v${browserAgentVersion}`
                              : browserAgentDetected
                                ? 'Cần Reload Extension'
                                : 'Chưa kết nối Extension'}
                          </span>
                        </div>
                      </div>
                      
                      {browserAgentConnected && actor.name === 'shopee-scraper' && (
                        <div className="rounded-xl border border-gray-200/80 bg-slate-50/70 px-3 py-2 flex items-center justify-between gap-2 min-h-[38px]">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
                            <span className="relative flex h-2 w-2 shrink-0">
                              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                                authStatus.shopeeLoggedIn ? 'bg-emerald-400' : 'bg-red-400'
                              }`} />
                              <span className={`relative inline-flex rounded-full h-2 w-2 ${
                                authStatus.shopeeLoggedIn ? 'bg-emerald-500' : 'bg-red-500'
                              }`} />
                            </span>
                            <span className="text-[11px] leading-none flex items-center">
                              {authStatus.shopeeLoggedIn ? 'Shopee: Đã đăng nhập' : 'Shopee: Chưa đăng nhập'}
                            </span>
                          </div>
                          {!authStatus.shopeeLoggedIn && (
                            <a href="https://shopee.vn" target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 font-semibold hover:underline bg-blue-50 px-2 py-1 rounded">Mở Đăng Nhập</a>
                          )}
                        </div>
                      )}
                      
                      {browserAgentConnected && actor.name === 'tiktok-scraper' && (
                        <div className="rounded-xl border border-gray-200/80 bg-slate-50/70 px-3 py-2 flex items-center justify-between gap-2 min-h-[38px]">
                          <div className="flex items-center gap-1.5 text-xs font-medium text-gray-800">
                            <span className="relative flex h-2 w-2 shrink-0">
                              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                                authStatus.tiktokLoggedIn ? 'bg-emerald-400' : 'bg-red-400'
                              }`} />
                              <span className={`relative inline-flex rounded-full h-2 w-2 ${
                                authStatus.tiktokLoggedIn ? 'bg-emerald-500' : 'bg-red-500'
                              }`} />
                            </span>
                            <span className="text-[11px] leading-none flex items-center">
                              {authStatus.tiktokLoggedIn ? 'TikTok: Đã đăng nhập' : 'TikTok: Chưa đăng nhập'}
                            </span>
                          </div>
                          {!authStatus.tiktokLoggedIn && (
                            <a href="https://www.tiktok.com/login" target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 font-semibold hover:underline bg-blue-50 px-2 py-1 rounded">Mở Đăng Nhập</a>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  <ActorInputFields
                    schema={actor.inputSchema}
                    input={runInputs[actor.id] || {}}
                    actorName={actor.name}
                    onChange={(input) => setRunInputs((previous) => ({
                      ...previous,
                      [actor.id]: input
                    }))}
                  />

                  {((runInputs[actor.id]?.maxItems as number) > 200 || (runInputs[actor.id]?.maxItems === undefined && 200 < 0 /* fallback logic if needed */)) && (
                    <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2 text-amber-800 text-xs shadow-sm">
                      <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                      <div>
                        <strong>Cảnh báo an toàn:</strong> Kéo trên 200 sản phẩm bằng mạng WiFi cá nhân có nguy cơ bị sàn thương mại điện tử chặn IP hoặc yêu cầu xác minh CAPTCHA liên tục. Hãy đảm bảo bạn chia nhỏ số lượng hoặc sử dụng mạng Proxy nếu muốn tiếp tục.
                      </div>
                    </div>
                  )}
                </div>

                <div className="pt-3 mt-4 border-t border-gray-100">
                  <button 
                    onClick={() => triggerRun(actor.id)}
                    disabled={(actor.name === 'shopee-scraper' || actor.name === 'tiktok-scraper') && !browserAgentConnected}
                    className="w-full flex items-center justify-center gap-2 bg-[#E8F0FE] text-blue-700 font-semibold py-2.5 text-xs rounded-xl hover:bg-blue-100 transition-colors disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                  >
                    <Play size={14} fill="currentColor" /> Run
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'runs' && (
          <div className="bg-white rounded-3xl shadow-sm border border-gray-50 overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-[#F1F3F5] text-gray-800 font-semibold text-sm border-b border-gray-200">
                <tr>
                  <th className="px-6 py-4">ID</th>
                  <th className="px-6 py-4">Crawler</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Items</th>
                  <th className="px-6 py-4">Created At</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map((run: any) => (
                  <tr 
                    key={run.id} 
                    onClick={() => openRunDetail(run.id)}
                    className="hover:bg-blue-50/25 transition-colors group cursor-pointer"
                  >
                    <td className="px-6 py-5 font-mono text-xs text-gray-400">{run.id}</td>
                    <td className="px-6 py-5 text-gray-900 font-medium">{run.actor?.name || run.actorId}</td>
                    <td className="px-6 py-5">
                      <span className={`px-3 py-1 text-xs font-semibold rounded-full ${
                        run.status === 'SUCCESS' ? 'bg-green-100 text-green-700' :
                        run.status === 'PARTIAL' ? 'bg-amber-100 text-amber-700' :
                        run.status === 'FAILED' ? 'bg-red-100 text-red-700' :
                        (run.status === 'RUNNING' || run.status === 'BROWSER_RUNNING' || run.status === 'STOPPING') ? 'bg-blue-100 text-blue-700' :
                        (run.status === 'PENDING' || run.status === 'BROWSER_PENDING') ? 'bg-amber-100 text-amber-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-gray-700">{run.itemCount ?? 0}</td>
                    <td className="px-6 py-5 text-gray-500">{new Date(run.createdAt).toLocaleString()}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => openRunDetail(run.id)} className="inline-flex items-center justify-center gap-1.5 h-8 px-3 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 text-xs font-medium transition-colors">
                          <Eye size={14} /> View
                        </button>
                        <button onClick={() => openLogViewer(run.id)} className="inline-flex items-center justify-center gap-1.5 h-8 px-3 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-xs font-medium transition-colors">
                          Logs
                        </button>
                        {(
                          run.status === 'RUNNING' ||
                          run.status === 'PENDING' ||
                          run.status === 'BROWSER_RUNNING' ||
                          run.status === 'BROWSER_PENDING'
                        ) && (
                          <button onClick={() => handleStopRun(run.id)} className="inline-flex items-center justify-center gap-1.5 h-8 px-3 bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100 text-xs font-medium transition-colors">
                            Stop
                          </button>
                        )}
                        <button onClick={() => handleDeleteRun(run.id)} className="inline-flex items-center justify-center gap-1.5 h-8 px-3 bg-red-50 text-red-700 rounded-lg hover:bg-red-100 text-xs font-medium transition-colors">
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'schedules' && (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-50 space-y-4">
              <div className="flex gap-4 items-end">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Select Crawler</label>
                  <select
                    value={newScheduleActorId}
                    onChange={e => {
                      setNewScheduleActorId(e.target.value)
                      setNewScheduleInput({})
                    }}
                    className="w-full px-4 py-3 bg-gray-50 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="">-- Select a crawler --</option>
                    {actors.map((actor: any) => (
                      <option key={actor.id} value={actor.id}>{actor.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Schedule Interval</label>
                  <select
                    value={newScheduleCron}
                    onChange={e => setNewScheduleCron(e.target.value)}
                    className="w-full px-4 py-3 bg-gray-50 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="* * * * *">Every minute</option>
                    <option value="0 * * * *">Every hour</option>
                    <option value="0 0 * * *">Every day at midnight</option>
                    <option value="0 0 * * 0">Every Sunday</option>
                  </select>
                </div>
                <button
                  onClick={handleCreateSchedule}
                  className="bg-blue-600 text-white font-medium px-6 py-3 rounded-xl hover:bg-blue-700 transition-colors h-[50px]"
                >
                  Create Schedule
                </button>
              </div>
              {newScheduleActorId && (
                <ActorInputFields
                  schema={(actors.find((actor: any) => actor.id === newScheduleActorId) as any)?.inputSchema}
                  input={newScheduleInput}
                  onChange={setNewScheduleInput}
                />
              )}
            </div>

            <div className="bg-white rounded-3xl shadow-sm border border-gray-50 overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-[#F1F3F5] text-gray-800 font-semibold text-sm border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-4">Crawler</th>
                    <th className="px-6 py-4">Cron Expression</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {schedules.map((schedule: any) => (
                    <tr key={schedule.id} className="hover:bg-blue-50/25 transition-colors group">
                      <td className="px-6 py-5 text-gray-900 font-medium">{schedule.actor?.name || schedule.actorId}</td>
                      <td className="px-6 py-5 font-mono text-sm text-gray-600 bg-gray-100 rounded my-4 inline-block ml-6 px-2">{schedule.cron}</td>
                      <td className="px-6 py-5">
                        <button 
                          onClick={() => handleToggleSchedule(schedule.id)}
                          className={`px-3 py-1 text-xs font-semibold rounded-full transition-colors ${
                          schedule.enabled ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                        }`}>
                          {schedule.enabled ? 'ACTIVE' : 'DISABLED'}
                        </button>
                      </td>
                      <td className="px-6 py-5 text-right">
                        <button 
                          onClick={() => handleDeleteSchedule(schedule.id)}
                          className="px-3 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-700 hover:bg-red-200 transition-colors"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                  {schedules.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-6 py-10 text-center text-gray-500">No schedules created yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="bg-white rounded-3xl shadow-sm border border-gray-50 p-8 max-w-2xl">
            <h2 className="text-xl font-medium text-gray-900 mb-6">Account Settings</h2>
            
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email Address</label>
                <input type="email" disabled value={user?.email || ''} className="w-full px-4 py-3 bg-gray-100 text-gray-500 rounded-xl border border-gray-200 cursor-not-allowed" />
                <p className="text-xs text-gray-400 mt-2">Email cannot be changed.</p>
              </div>
              
              <div className="flex gap-3">
                <span className="px-3 py-1 rounded-full bg-violet-100 text-violet-700 text-xs font-semibold">{user?.role}</span>
                <span className="px-3 py-1 rounded-full bg-emerald-100 text-emerald-700 text-xs font-semibold">{user?.status}</span>
              </div>
            </div>
          </div>
        )}
      </main>

      {runDetailOpen && (
        <RunDetailModal
          detail={runDetail}
          loading={runDetailLoading}
          page={runDetailPage}
          status={runDetailStatus}
          onStatusChange={(status) => {
             setRunDetailStatus(status)
             if (runDetail?.run?.id) {
               setRunDetailPage(1)
               fetchRunDetail(runDetail.run.id, 1, status)
             }
          }}
          onPageChange={(page) => runDetail?.run?.id && fetchRunDetail(runDetail.run.id, page, runDetailStatus)}
          onDownload={(format, status) => runDetail?.run?.id && downloadRunOutput(runDetail.run.id, format, status)}
          onClose={() => setRunDetailOpen(false)}
        />
      )}

      {/* Log Modal */}
      {logModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-[#1E1E1E] w-full max-w-4xl h-[80vh] rounded-xl shadow-2xl flex flex-col overflow-hidden border border-gray-800">
            <div className="flex justify-between items-center p-4 bg-[#2D2D2D] border-b border-gray-700">
              <h3 className="text-white font-medium flex items-center gap-2">
                <Activity size={18} className="text-blue-400" /> 
                Live Logs: <span className="font-mono text-xs text-gray-400 ml-1">{activeLogRunId}</span>
              </h3>
              <button onClick={() => setLogModalOpen(false)} className="text-gray-400 hover:text-white">
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4 font-mono text-sm">
              <pre className="text-green-400 whitespace-pre-wrap leading-relaxed">{logs}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function RunDetailModal({
  detail,
  loading,
  page,
  onPageChange,
  onDownload,
  onClose
}: {
  detail: any
  loading: boolean
  page: number
  status?: string
  onStatusChange: (status?: string) => void
  onPageChange: (page: number) => void
  onDownload: (format: 'json' | 'jsonl', status?: 'COMPLETED' | 'FAILED') => void
  onClose: () => void
}) {
  const [galleryState, setGalleryState] = useState<{ images: string[]; index: number } | null>(null)

  useEffect(() => {
    if (!galleryState) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setGalleryState(null)
      if (event.key === 'ArrowLeft') {
        setGalleryState((prev) => prev ? ({ ...prev, index: (prev.index - 1 + prev.images.length) % prev.images.length }) : null)
      }
      if (event.key === 'ArrowRight') {
        setGalleryState((prev) => prev ? ({ ...prev, index: (prev.index + 1) % prev.images.length }) : null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [galleryState])
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({})
  const [reviewPages, setReviewPages] = useState<Record<string, number>>({})
  const records = (detail?.items || []).map((item: any) => item.data || {})
  const detailProgress = detail?.run?.outputMetadata?.detailProgress
  let schemaColumns: string[] = []
  let schemaLabels: Record<string, string> = {}
  try {
    const schema = JSON.parse(detail?.run?.actor?.outputSchema || '{}')
    schemaColumns = Object.keys(schema?.properties || {})

    const shortLabels: Record<string, string> = {
      'Điểm đánh giá trung bình của sản phẩm': 'Điểm đánh giá',
      'Tổng số lượt đánh giá sản phẩm': 'Lượt đánh giá',
      'Liên kết sản phẩm': 'Liên kết',
      'Tên cửa hàng': 'Cửa hàng',
      'Bộ ảnh sản phẩm': 'Bộ ảnh'
    }

    schemaLabels = Object.fromEntries(
      Object.entries(schema?.properties || {}).map(([key, property]: [string, any]) => {
        const title = typeof property?.title === 'string' ? property.title : humanizeFieldName(key)
        return [key, shortLabels[title] || title]
      })
    )
  } catch {
    schemaColumns = []
    schemaLabels = {}
  }
  const columns = Array.from(new Set([
    ...schemaColumns,
    ...records.flatMap((record: Record<string, unknown>) => Object.keys(record))
  ]))

  const preferredSummaryColumns = [
    'title',
    'price',
    'rating',
    'ratingCount',
    'sold',
    'url',
    'image',
    'shopName',
    'images'
  ]
  let summaryColumns = preferredSummaryColumns.filter((column) => columns.includes(column))
  if (summaryColumns.length === 0) {
    summaryColumns = columns.slice(0, 5)
  }
  const detailColumns = columns.filter(c => !summaryColumns.includes(c))

  const renderValue = (value: unknown, column: string, recordKey = '') => {
    if (value === null || value === undefined || value === '') {
      return <span className="text-gray-300">—</span>
    }
    if (column === 'rating' && typeof value === 'number') {
      return <span>{value.toFixed(1)}</span>
    }
    if (column === 'sold') {
      return <span>{displaySoldValue(value)}</span>
    }
    if (column === 'reviews' && Array.isArray(value)) {
      if (!value.length) return <span className="text-gray-400">Chưa có đánh giá</span>
      const reviewPageSize = 20
      const reviewPageKey = recordKey || 'reviews'
      const reviewPageCount = Math.max(1, Math.ceil(value.length / reviewPageSize))
      const reviewPage = Math.min(reviewPageCount, Math.max(1, reviewPages[reviewPageKey] || 1))
      const visibleReviews = value.slice(
        (reviewPage - 1) * reviewPageSize,
        reviewPage * reviewPageSize
      )
      return (
        <details className="w-80">
          <summary className="cursor-pointer text-blue-600 font-medium">
            Xem {value.length} đánh giá
          </summary>
          <div className="mt-2 space-y-2 max-h-72 overflow-auto pr-2">
            {visibleReviews.map((review: any, index: number) => (
              <div key={review.reviewId || index} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-gray-700">{review.author || 'Người dùng'}</span>
                  <span className="text-amber-600">{review.rating ? `${review.rating} ★` : 'Chưa chấm sao'}</span>
                </div>
                {review.variation && <div className="mt-1 text-xs text-gray-400">{review.variation}</div>}
                <div className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">
                  {review.comment || 'Người mua không để lại nội dung.'}
                </div>
                {Array.isArray(review.images) && review.images.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {review.images.slice(0, 6).map((imageUrl: unknown, imageIndex: number) => (
                      <button
                        key={`${review.reviewId || index}-image-${imageIndex}`}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          const stringImages = review.images.map((img: any) => String(img)).filter(Boolean)
                          setGalleryState({ images: stringImages, index: imageIndex })
                        }}
                        title="Bấm để xem bộ ảnh đánh giá"
                        className="cursor-pointer"
                      >
                        <img
                          src={String(imageUrl)}
                          alt={`Ảnh đánh giá ${imageIndex + 1}`}
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          className="h-14 w-14 rounded-lg border border-gray-200 bg-white object-cover hover:opacity-80"
                        />
                      </button>
                    ))}
                    {review.images.length > 6 && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          const stringImages = review.images.map((img: any) => String(img)).filter(Boolean)
                          setGalleryState({ images: stringImages, index: 6 })
                        }}
                        className="flex h-14 min-w-14 items-center justify-center rounded-lg border border-gray-200 bg-white px-2 text-xs font-semibold text-gray-700 hover:bg-gray-100 cursor-pointer"
                      >
                        +{review.images.length - 6}
                      </button>
                    )}
                  </div>
                )}
                {Array.isArray(review.videos) && review.videos.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {review.videos.slice(0, 3).map((videoUrl: unknown, videoIndex: number) => (
                      <a
                        key={`${review.reviewId || index}-video-${videoIndex}`}
                        href={String(videoUrl)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-blue-600 hover:bg-blue-50"
                      >
                        Video {videoIndex + 1}
                        <ExternalLink size={11} />
                      </a>
                    ))}
                  </div>
                )}
                {review.createdAt && (
                  <div className="mt-1 text-[11px] text-gray-400">
                    {new Date(review.createdAt).toLocaleString('vi-VN')}
                  </div>
                )}
              </div>
            ))}
          </div>
          {reviewPageCount > 1 && (
            <div className="mt-2 flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                disabled={reviewPage <= 1}
                onClick={() => setReviewPages((current) => ({
                  ...current,
                  [reviewPageKey]: Math.max(1, reviewPage - 1)
                }))}
                className="rounded-lg border border-gray-200 px-2 py-1 disabled:opacity-40"
              >
                Trang trước
              </button>
              <span>{reviewPage}/{reviewPageCount}</span>
              <button
                type="button"
                disabled={reviewPage >= reviewPageCount}
                onClick={() => setReviewPages((current) => ({
                  ...current,
                  [reviewPageKey]: Math.min(reviewPageCount, reviewPage + 1)
                }))}
                className="rounded-lg border border-gray-200 px-2 py-1 disabled:opacity-40"
              >
                Trang sau
              </button>
            </div>
          )}
        </details>
      )
    }
    if (column === 'images' && Array.isArray(value)) {
      if (!value.length) return <span className="text-gray-400">Chưa có ảnh</span>
      const stringImages = value.map((img) => String(img)).filter(Boolean)
      return (
        <div className="flex items-center gap-1.5 min-w-[16rem]">
          {stringImages.slice(0, 4).map((imageUrl: string, index: number) => (
            <button
              key={`${imageUrl}-${index}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setGalleryState({ images: stringImages, index })
              }}
              title="Bấm để xem tất cả ảnh sản phẩm"
              className="cursor-pointer group"
            >
              <img
                src={imageUrl}
                alt=""
                referrerPolicy="no-referrer"
                loading="lazy"
                className="w-14 h-14 rounded-lg object-cover bg-gray-100 border border-gray-200 group-hover:opacity-80 transition-opacity"
              />
            </button>
          ))}
          {stringImages.length > 4 && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setGalleryState({ images: stringImages, index: 4 })
              }}
              title="Xem tất cả bộ ảnh"
              className="flex h-14 min-w-14 items-center justify-center rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 px-2 text-xs font-bold text-blue-700 transition-colors cursor-pointer"
            >
              +{stringImages.length - 4}
            </button>
          )}
        </div>
      )
    }
    if (Array.isArray(value)) {
      if (!value.length) return <span className="text-gray-400">Không có dữ liệu</span>
      return (
        <details className="max-w-md">
          <summary className="cursor-pointer text-blue-600 font-medium">
            Xem {value.length} mục
          </summary>
          <div className="mt-2 space-y-2 max-h-72 overflow-auto">
            {value.map((entry: any, index: number) => (
              <div key={index} className="rounded-lg border border-gray-200 bg-white p-2.5">
                {entry && typeof entry === 'object' ? (
                  Object.entries(entry).map(([key, entryValue]) => (
                    <div key={key} className="grid grid-cols-[7rem_1fr] gap-2 text-xs py-0.5">
                      <span className="text-gray-400">{humanizeFieldName(key)}</span>
                      <span className="text-gray-700 break-words">
                        {typeof entryValue === 'object' ? JSON.stringify(entryValue) : String(entryValue ?? '—')}
                      </span>
                    </div>
                  ))
                ) : String(entry)}
              </div>
            ))}
          </div>
        </details>
      )
    }
    if (typeof value === 'boolean') {
      return value
        ? <span className="text-emerald-700 font-medium">Có</span>
        : <span className="text-gray-400">Không</span>
    }
    if (
      typeof value === 'number' &&
      /price|gia|minimumspend|fee/i.test(column)
    ) {
      return <span>{value.toLocaleString('vi-VN')}₫</span>
    }
    if (typeof value === 'number' && /discountpercent|percentage/i.test(column)) {
      return <span>{value}%</span>
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (/^https?:\/\//.test(text)) {
      const isImage = /image|thumbnail|avatar|photo|picture|img|hinh/i.test(column) || /\.(jpg|jpeg|png|webp|gif|svg)(\?.*)?$/i.test(text)
      if (isImage) {
        return (
          <button 
            type="button"
            onClick={(e) => { e.stopPropagation(); setGalleryState({ images: [text], index: 0 }); }}
            title="Bấm để xem ảnh phóng to trực tiếp" 
            className="inline-block relative group text-left cursor-pointer"
          >
            <img 
              src={text} 
              alt="" 
              referrerPolicy="no-referrer"
              loading="lazy"
              className="w-14 h-14 rounded-xl object-cover bg-gray-100 border border-gray-200 shadow-sm group-hover:opacity-85 group-hover:scale-105 transition-all" 
            />
          </button>
        )
      }
      return (
        <a href={text} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline block max-w-[14rem] truncate text-left">
          {text}
        </a>
      )
    }
    return <span className="block max-w-xs whitespace-normal break-words">{text}</span>
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white w-full max-w-[94vw] h-[90vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex flex-col border-b border-gray-100">
          <div className="flex justify-between items-start gap-4 p-6 pb-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-semibold text-gray-900">Run data</h2>
                {detail?.run?.status && (
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    detail.run.status === 'SUCCESS'
                      ? 'bg-green-100 text-green-700'
                      : detail.run.status === 'PARTIAL'
                        ? 'bg-amber-100 text-amber-700'
                        : detail.run.status === 'FAILED'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-700'
                  }`}>
                    {detail.run.status}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs font-mono text-gray-400">{detail?.run?.id}</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => onDownload('jsonl')} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-50 text-purple-700 text-sm font-medium" title="Tải JSON Lines">
                <FileJson size={16} /> JSONL
              </button>
              <button onClick={onClose} className="ml-2 text-gray-400 hover:text-gray-800 text-2xl">×</button>
            </div>
          </div>
          <div className="flex items-center gap-6 px-6">
            <button 
              onClick={() => onStatusChange(undefined)} 
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${!status ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              Tất cả sản phẩm
            </button>
            <button 
              onClick={() => onStatusChange('FAILED')} 
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${status === 'FAILED' ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              Sản phẩm lỗi
            </button>
          </div>
        </div>

        {loading && !detail ? (
          <div className="flex-1 flex items-center justify-center text-gray-500">Loading data…</div>
        ) : detail ? (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 p-5 bg-gray-50 border-b border-gray-100">
              <div className="bg-white rounded-2xl p-4">
                <div className="text-xs uppercase tracking-wide text-gray-400">Crawler</div>
                <div className="mt-1 font-medium">{detail.run.actor?.name}</div>
                <div className="text-sm text-gray-500">v{detail.run.actor?.version}</div>
              </div>
              <div className="bg-white rounded-2xl p-4">
                <div className="text-xs uppercase tracking-wide text-gray-400">Input</div>
                <pre className="mt-2 text-xs text-gray-700 whitespace-pre-wrap max-h-24 overflow-auto">{JSON.stringify(detail.run.input, null, 2)}</pre>
              </div>
              <div className="bg-white rounded-2xl p-4">
                <div className="text-xs uppercase tracking-wide text-gray-400">Chi tiết sản phẩm</div>
                {detailProgress?.enabled ? (
                  <>
                    <div className="mt-1 text-2xl font-semibold">
                      {(detailProgress.completed || 0) + (detailProgress.failed || 0)}
                      <span className="text-base font-normal text-gray-400">/{detailProgress.total || 0}</span>
                    </div>
                    <div className="text-sm text-gray-500">
                      {detailProgress.completed || 0} thành công
                      {detailProgress.failed ? ` · ${detailProgress.failed} lỗi` : ''}
                    </div>
                  </>
                ) : (
                  <div className="mt-2 text-sm text-gray-500">Không thu thập dữ liệu chi tiết</div>
                )}
              </div>
              <div className="bg-white rounded-2xl p-4">
                <div className="text-xs uppercase tracking-wide text-gray-400">Result</div>
                <div className="mt-1 text-2xl font-semibold">{detail.run.itemCount}</div>
                <div className="text-sm text-gray-500">items stored in database</div>
                {detail.run.outputError && <div className="mt-2 text-xs text-red-600">{detail.run.outputError}</div>}
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {records.length > 0 ? (
                <table className="min-w-full text-center text-sm">
                  <thead className="sticky top-0 bg-white border-b border-gray-200 text-gray-700 font-semibold">
                    <tr>
                      <th className="w-10 px-2 py-2.5"></th>
                      <th className="px-3 py-2.5">STT</th>
                      {summaryColumns.map((column) => (
                        <th key={column} className={`px-3 py-2.5 whitespace-nowrap ${column === 'title' ? 'text-left' : ''}`}>
                          {schemaLabels[column] || humanizeFieldName(column)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {detail.items.map((item: any) => {
                      const isExpanded = Boolean(expandedItemIds[item.id])
                      return (
                        <Fragment key={item.id}>
                          <tr 
                            onClick={() => setExpandedItemIds(prev => ({ ...prev, [item.id]: !prev[item.id] }))}
                            className={`hover:bg-blue-50/40 align-middle cursor-pointer transition-colors ${
                              isExpanded ? 'bg-blue-50/30 font-medium' : ''
                            }`}
                          >
                            <td className="w-10 px-2 py-2 text-gray-400">
                              <button type="button" className="p-1 rounded hover:bg-gray-100 transition-transform">
                                <ChevronRight size={16} className={`transition-transform duration-200 ${isExpanded ? 'rotate-90 text-blue-600' : ''}`} />
                              </button>
                            </td>
                            <td className="px-3 py-2 text-gray-400 font-medium">{item.position + 1}</td>
                            {summaryColumns.map((column) => (
                              <td key={column} className={`px-3 py-2 text-gray-700 ${column === 'title' ? 'text-left' : ''}`}>
                                {renderValue(item.data?.[column], column, String(item.data?.itemId || item.id))}
                              </td>
                            ))}
                          </tr>

                          {isExpanded && (
                            <tr key={`${item.id}-detail`} className="bg-slate-50/80 border-b border-gray-200">
                              <td colSpan={summaryColumns.length + 2} className="p-4">
                                <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-200/80 space-y-4">
                                  <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                                    <h4 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                                      <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
                                      Thông tin chi tiết thu thập bên trong sản phẩm
                                    </h4>
                                    <span className="text-xs text-gray-400 font-mono">Item #{item.position + 1}</span>
                                  </div>

                                  {detailColumns.length > 0 ? (
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                                      {detailColumns.map((col) => {
                                        const val = item.data?.[col];
                                        return (
                                          <div key={col} className="bg-gray-50/80 p-3.5 rounded-xl border border-gray-100 flex flex-col gap-1">
                                            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                              {schemaLabels[col] || humanizeFieldName(col)}
                                            </span>
                                            <div className="text-xs text-gray-800 font-normal whitespace-pre-wrap break-words">
                                              {renderValue(val, col, String(item.data?.itemId || item.id))}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-gray-400 py-2">Không có dữ liệu chi tiết nâng cao cho sản phẩm này.</div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="h-full flex items-center justify-center text-gray-400">This run has no data items.</div>
              )}
            </div>

            <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 bg-white">
              <span className="text-sm text-gray-500">
                Page {detail.pagination.page} of {detail.pagination.totalPages} · {detail.pagination.total} items
              </span>
              <div className="flex gap-2">
                <button
                  disabled={page <= 1 || loading}
                  onClick={() => onPageChange(page - 1)}
                  className="p-2 rounded-lg bg-gray-100 disabled:opacity-40"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  disabled={page >= detail.pagination.totalPages || loading}
                  onClick={() => onPageChange(page + 1)}
                  className="p-2 rounded-lg bg-gray-100 disabled:opacity-40"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-red-500">Unable to load run data.</div>
        )}
      </div>

      {galleryState && (
        <div 
          className="fixed inset-0 bg-black/85 backdrop-blur-md z-[70] flex flex-col items-center justify-center p-4 select-none"
          onClick={() => setGalleryState(null)}
        >
          <div 
            className="relative w-full max-w-5xl max-h-[92vh] flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header with counter & close button */}
            <div className="mb-3 flex items-center justify-between w-full text-white/90 text-xs px-2">
              <span className="font-semibold bg-white/10 px-3.5 py-1.5 rounded-full border border-white/15 text-white shadow-xs">
                Bộ ảnh ({galleryState.index + 1} / {galleryState.images.length})
              </span>
              <button 
                onClick={() => setGalleryState(null)}
                className="hover:bg-white/15 p-2 rounded-full text-white/80 hover:text-white transition-colors cursor-pointer"
                title="Đóng (Esc)"
              >
                ✕
              </button>
            </div>

            {/* Main Image Container with Prev & Next Arrows */}
            <div className="relative flex items-center justify-center w-full min-h-[350px]">
              {galleryState.images.length > 1 && (
                <button
                  type="button"
                  onClick={() => setGalleryState((prev) => prev ? ({
                    ...prev,
                    index: (prev.index - 1 + prev.images.length) % prev.images.length
                  }) : null)}
                  className="absolute left-1 md:left-3 z-10 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white border border-white/20 transition-all cursor-pointer shadow-lg active:scale-95"
                  title="Ảnh trước (Mũi tên trái)"
                >
                  <ChevronLeft size={22} />
                </button>
              )}

              <img 
                src={galleryState.images[galleryState.index]} 
                alt={`Ảnh ${galleryState.index + 1}`} 
                referrerPolicy="no-referrer"
                className="max-w-full max-h-[62vh] object-contain rounded-2xl shadow-2xl border border-white/10 transition-all duration-150" 
              />

              {galleryState.images.length > 1 && (
                <button
                  type="button"
                  onClick={() => setGalleryState((prev) => prev ? ({
                    ...prev,
                    index: (prev.index + 1) % prev.images.length
                  }) : null)}
                  className="absolute right-1 md:right-3 z-10 p-3 rounded-full bg-black/60 hover:bg-black/90 text-white border border-white/20 transition-all cursor-pointer shadow-lg active:scale-95"
                  title="Ảnh tiếp theo (Mũi tên phải)"
                >
                  <ChevronRight size={22} />
                </button>
              )}
            </div>

            {/* Thumbnail Strip */}
            {galleryState.images.length > 1 && (
              <div className="mt-4 flex items-center gap-2 max-w-full overflow-x-auto p-2.5 bg-black/40 backdrop-blur-md rounded-2xl border border-white/15 max-h-24">
                {galleryState.images.map((imgUrl, idx) => (
                  <button
                    key={`${imgUrl}-${idx}`}
                    type="button"
                    onClick={() => setGalleryState((prev) => prev ? ({ ...prev, index: idx }) : null)}
                    className={`relative rounded-xl overflow-hidden shrink-0 border-2 transition-all cursor-pointer ${
                      idx === galleryState.index ? 'border-blue-500 scale-105 shadow-lg opacity-100' : 'border-transparent opacity-50 hover:opacity-100'
                    }`}
                  >
                    <img
                      src={imgUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="w-12 h-12 object-cover"
                    />
                  </button>
                ))}
              </div>
            )}

            {/* Bottom Actions Bar */}
            <div className="mt-3 flex items-center gap-4 bg-white/10 backdrop-blur-md px-5 py-2 rounded-full border border-white/20 text-white text-xs font-medium">
              <a 
                href={galleryState.images[galleryState.index]} 
                target="_blank" 
                rel="noreferrer"
                className="hover:underline flex items-center gap-1.5 text-white"
              >
                Mở tab mới <ExternalLink size={13} />
              </a>
              <span className="text-white/40">•</span>
              <button 
                onClick={() => setGalleryState(null)}
                className="hover:underline text-white/80 hover:text-white cursor-pointer"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ActorInputFields({
  schema,
  input,
  onChange,
  actorName
}: {
  schema?: string | null
  input: Record<string, unknown>
  onChange: (input: Record<string, unknown>) => void
  actorName?: string
}) {
  const parsed = parseInputSchema(schema)
  
  if (actorName === 'shopee-scraper' || actorName === 'tiktok-scraper') {
    if (parsed?.properties?.maxItems) {
      parsed.properties.maxItems.maximum = 200
      parsed.properties.maxItems.description = (parsed.properties.maxItems.description || '') + ' (Tối đa 200)'
    }
  }

  const properties = Object.entries(parsed?.properties || {})
  if (properties.length === 0) return null

  const required = new Set(parsed?.required || [])

  return (
    <div className="mb-4 space-y-3">
      {properties.map(([key, property]) => {
        const label = property.title || key
        const currentValue = input[key] ?? property.default ?? ''

        if (property.type === 'boolean') {
          return (
            <label key={key} className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={Boolean(currentValue)}
                onChange={(event) => onChange({ ...input, [key]: event.target.checked })}
                className="mt-0.5"
              />
              <span>
                {label}
                {property.description && (
                  <span className="block text-xs font-normal text-gray-500">{property.description}</span>
                )}
              </span>
            </label>
          )
        }

        if (Array.isArray(property.enum) && property.enum.length > 0) {
          const enumNames = Array.isArray(property.enumNames) ? property.enumNames : []
          return (
            <div key={key}>
              <label className="mb-1 block text-xs font-medium text-gray-700">
                {label}{required.has(key) ? ' *' : ''}
              </label>
              <select
                value={String(currentValue)}
                onChange={(event) => onChange({ ...input, [key]: event.target.value })}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 font-medium text-gray-800"
              >
                {property.enum.map((optVal: string, idx: number) => (
                  <option key={optVal} value={optVal}>
                    {enumNames[idx] || optVal}
                  </option>
                ))}
              </select>
              {property.description && (
                <p className="mt-1 text-xs text-gray-500">{property.description}</p>
              )}
            </div>
          )
        }

        const numeric = property.type === 'integer' || property.type === 'number'
        return (
          <div key={key}>
            <label className="mb-1 block text-xs font-medium text-gray-700">
              {label}{required.has(key) ? ' *' : ''}
            </label>
            <input
              type={numeric ? 'number' : 'text'}
              value={String(currentValue)}
              min={property.minimum}
              max={property.maximum}
              step={property.type === 'integer' ? 1 : undefined}
              required={required.has(key)}
              placeholder={property.placeholder || property.description}
              onChange={(event) => onChange({ ...input, [key]: event.target.value })}
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {property.description && !property.placeholder && (
              <p className="mt-1 text-xs text-gray-500">{property.description}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function NavItem({ icon, label, active, onClick, collapsed }: { icon: any, label: string, active: boolean, onClick: () => void, collapsed?: boolean }) {
  return (
    <button 
      onClick={onClick}
      title={collapsed ? label : undefined}
      className={`w-full flex items-center ${collapsed ? 'justify-center px-0' : 'gap-3 px-4'} py-2.5 rounded-full font-medium text-sm transition-colors ${
        active ? 'bg-[#C2E7FF] text-[#001D35]' : 'text-gray-600 hover:bg-gray-200/50'
      }`}
    >
      <span className={`${active ? 'text-[#001D35]' : 'text-gray-500'} scale-90`}>{icon}</span>
      {!collapsed && <span>{label}</span>}
    </button>
  )
}

export default App
