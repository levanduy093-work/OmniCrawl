import { useState, useEffect, useCallback, Fragment } from 'react'
import {
  Play,
  Activity,
  Clock,
  Settings,
  Search,
  Bot,
  Package,
  Download,
  LogOut,
  Wallet,
  Eye,
  Users,
  FileJson,
  FileSpreadsheet,
  ChevronLeft,
  ChevronRight,
  ExternalLink
} from 'lucide-react'
import Login from './Login'
import OmniCrawlLogo from './Logo'
import './App.css'

const REQUIRED_BROWSER_AGENT_VERSION = '0.7.3'

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
  const [newActorName, setNewActorName] = useState('')
  const [newScheduleActorId, setNewScheduleActorId] = useState('')
  const [newScheduleCron, setNewScheduleCron] = useState('* * * * *')
  const [newScheduleInput, setNewScheduleInput] = useState<Record<string, unknown>>({})
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [runInputs, setRunInputs] = useState<Record<string, any>>({})
  const [browserAgentConnected, setBrowserAgentConnected] = useState(false)
  const [browserAgentDetected, setBrowserAgentDetected] = useState(false)
  const [browserAgentVersion, setBrowserAgentVersion] = useState<string | null>(null)
  const [browserAuthStatus, setBrowserAuthStatus] = useState<{ shopeeLoggedIn: boolean; tiktokLoggedIn: boolean }>({ shopeeLoggedIn: false, tiktokLoggedIn: false })

  // Log Viewer State
  const [logModalOpen, setLogModalOpen] = useState(false)
  const [activeLogRunId, setActiveLogRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<string>('')
  const [runDetailOpen, setRunDetailOpen] = useState(false)
  const [runDetail, setRunDetail] = useState<any>(null)
  const [runDetailPage, setRunDetailPage] = useState(1)
  const [runDetailLoading, setRunDetailLoading] = useState(false)
  const [users, setUsers] = useState<any[]>([])
  const [newUser, setNewUser] = useState({ email: '', password: '', role: 'USER', tier: 'FREE', credits: 1000 })

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
          Boolean(event.data.connected) && version === REQUIRED_BROWSER_AGENT_VERSION
        )
        if (event.data.authStatus) {
          setBrowserAuthStatus(event.data.authStatus)
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

  const handleOpenLoginTab = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    window.postMessage({
      source: 'OMNICRAWL_DASHBOARD',
      type: 'OPEN_TAB',
      url
    }, window.location.origin)
    window.postMessage({
      source: 'OMNICRAWL_DASHBOARD',
      type: 'POLL_NOW'
    }, window.location.origin)
  }, [])

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

  const handleScaffold = async (templateName: string) => {
    if (!newActorName) {
      alert('Please enter a name for your new crawler first.');
      return;
    }
    
    try {
      const res = await fetch('http://localhost:3001/api/templates/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: newActorName, template: templateName })
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to scaffold');
      }
      alert(`Crawler ${newActorName} created successfully from template ${templateName}!`);
      setNewActorName('');
      setActiveTab('actors');
      fetchData();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
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

  const fetchRunDetail = useCallback(async (id: string, page = 1) => {
    setRunDetailLoading(true)
    try {
      const res = await fetch(`http://localhost:3001/api/runs/${id}/items?page=${page}&pageSize=25`, {
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
    fetchRunDetail(id, 1)
  }

  const downloadRunOutput = async (id: string, format: 'json' | 'csv') => {
    try {
      const res = await fetch(`http://localhost:3001/api/runs/${id}/export?format=${format}`, {
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

  const fetchUsers = useCallback(async () => {
    if (!isAdminRole(user?.role)) return
    const res = await fetch('http://localhost:3001/api/admin/users', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    if (res.ok) setUsers(await res.json())
  }, [token, user?.role])

  useEffect(() => {
    if (activeTab === 'users' && isAdminRole(user?.role)) fetchUsers()
  }, [activeTab, fetchUsers, user?.role])

  const createUser = async () => {
    const res = await fetch('http://localhost:3001/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(newUser)
    })
    const data = await res.json()
    if (!res.ok) return alert(data.error || 'Không thể tạo user')
    setNewUser({ email: '', password: '', role: 'USER', tier: 'FREE', credits: 1000 })
    fetchUsers()
  }

  const updateUser = async (id: string, changes: Record<string, unknown>) => {
    const res = await fetch(`http://localhost:3001/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(changes)
    })
    const data = await res.json()
    if (!res.ok) return alert(data.error || 'Không thể cập nhật user')
    setUsers((current) => current.map((entry) => entry.id === id ? data : entry))
    if (id === user?.id) fetchUser()
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

        {user && isSidebarOpen && (
          <div className="px-5 mb-4 py-3 bg-[#E8F0FE] rounded-2xl flex items-center justify-between text-blue-800">
            <div className="flex items-center gap-2 font-medium">
              <Wallet size={18} />
              <span>{user.credits}</span>
            </div>
            <span className="text-xs font-semibold uppercase tracking-wider">Credits</span>
          </div>
        )}

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
          <NavItem 
            icon={<Package />} 
            label="Marketplace" 
            active={activeTab === 'marketplace'} 
            onClick={() => setActiveTab('marketplace')} 
            collapsed={!isSidebarOpen}
          />
          {isAdminRole(user?.role) && (
            <NavItem
              icon={<Users />}
              label="Users"
              active={activeTab === 'users'}
              onClick={() => setActiveTab('users')}
              collapsed={!isSidebarOpen}
            />
          )}
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
                    <div className="mb-3">
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

                        <div className="flex items-center">
                          {actor.name === 'shopee-scraper' ? (
                            browserAgentConnected && browserAuthStatus.shopeeLoggedIn ? (
                              <a
                                href="https://shopee.vn"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-1 font-semibold text-emerald-700 bg-emerald-100/90 hover:bg-emerald-200/90 px-2.5 py-1 rounded-full text-[10px] leading-none transition-colors cursor-pointer min-h-[22px]"
                                title="Đã kết nối - Click để mở trang Shopee"
                              >
                                Shopee: Logged In
                                <ExternalLink size={10} />
                              </a>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleOpenLoginTab('https://shopee.vn/buyer/login')}
                                className="inline-flex items-center justify-center gap-1 font-medium text-amber-800 bg-amber-100/90 hover:bg-amber-200/90 border border-amber-300/60 px-2.5 py-1 rounded-full text-[10px] leading-none transition-all cursor-pointer shadow-xs active:scale-95 min-h-[22px]"
                                title="Click để mở tab đăng nhập Shopee trên Chrome"
                              >
                                Shopee: Guest Mode
                                <span className="font-semibold text-blue-600 underline inline-flex items-center gap-0.5 ml-0.5">
                                  (Mở Tab Login <ExternalLink size={10} />)
                                </span>
                              </button>
                            )
                          ) : (
                            browserAgentConnected && browserAuthStatus.tiktokLoggedIn ? (
                              <a
                                href="https://www.tiktok.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center justify-center gap-1 font-semibold text-emerald-700 bg-emerald-100/90 hover:bg-emerald-200/90 px-2.5 py-1 rounded-full text-[10px] leading-none transition-colors cursor-pointer min-h-[22px]"
                                title="Đã kết nối - Click để mở trang TikTok"
                              >
                                TikTok: Logged In
                                <ExternalLink size={10} />
                              </a>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleOpenLoginTab('https://www.tiktok.com/login')}
                                className="inline-flex items-center justify-center gap-1 font-medium text-amber-800 bg-amber-100/90 hover:bg-amber-200/90 border border-amber-300/60 px-2.5 py-1 rounded-full text-[10px] leading-none transition-all cursor-pointer shadow-xs active:scale-95 min-h-[22px]"
                                title="Click để mở tab đăng nhập TikTok trên Chrome"
                              >
                                TikTok: Guest Mode
                                <span className="font-semibold text-blue-600 underline inline-flex items-center gap-0.5 ml-0.5">
                                  (Mở Tab Login <ExternalLink size={10} />)
                                </span>
                              </button>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <ActorInputFields
                    schema={actor.inputSchema}
                    input={runInputs[actor.id] || {}}
                    onChange={(input) => setRunInputs((previous) => ({
                      ...previous,
                      [actor.id]: input
                    }))}
                  />
                </div>

                <div className="pt-3 mt-4 border-t border-gray-100">
                  <button 
                    onClick={() => triggerRun(actor.id)}
                    disabled={(actor.name === 'shopee-scraper' || actor.name === 'tiktok-scraper') && !browserAgentConnected}
                    className="w-full flex items-center justify-center gap-2 bg-[#E8F0FE] text-blue-700 font-semibold py-2.5 text-xs rounded-xl hover:bg-blue-100 transition-colors disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed"
                  >
                    <Play size={14} fill="currentColor" /> Run (10 Credits)
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

        {activeTab === 'marketplace' && (
          <div>
            <div className="mb-8 flex items-center gap-4">
              <input
                type="text"
                value={newActorName}
                onChange={(e) => setNewActorName(e.target.value)}
                placeholder="Enter new crawler name (e.g. my-ecommerce-scraper)"
                className="flex-1 max-w-md px-4 py-3 bg-white rounded-xl shadow-sm border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-50 flex flex-col h-full">
                <div className="w-14 h-14 bg-green-50 rounded-2xl flex items-center justify-center text-green-600 mb-6">
                  <Package size={28} />
                </div>
                <h3 className="text-xl font-medium text-gray-900 mb-2">TypeScript Blank Template</h3>
                <p className="text-gray-500 mb-8 flex-1">A basic template with TypeScript setup, using standard Node.js libraries. Perfect for simple HTTP scraping.</p>
                <button 
                  onClick={() => handleScaffold('template-ts')}
                  className="w-full flex items-center justify-center gap-2 bg-[#E8F0FE] text-blue-700 font-medium py-3 rounded-full hover:bg-blue-100 transition-colors"
                >
                  <Download size={18} /> Create from Template
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'users' && isAdminRole(user?.role) && (
          <div className="space-y-6">
            <div className="bg-white rounded-3xl shadow-sm border border-gray-50 p-6">
              <h2 className="text-lg font-medium text-gray-900 mb-4">Create user</h2>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(event) => setNewUser({ ...newUser, email: event.target.value })}
                  placeholder="Email"
                  className="px-4 py-3 bg-gray-50 rounded-xl border border-gray-200"
                />
                <input
                  type="password"
                  value={newUser.password}
                  onChange={(event) => setNewUser({ ...newUser, password: event.target.value })}
                  placeholder="Password (8+ characters)"
                  className="px-4 py-3 bg-gray-50 rounded-xl border border-gray-200"
                />
                <select
                  value={newUser.role}
                  onChange={(event) => setNewUser({ ...newUser, role: event.target.value })}
                  className="px-4 py-3 bg-gray-50 rounded-xl border border-gray-200"
                >
                  <option value="USER">USER</option>
                  <option value="ADMIN">ADMIN</option>
                  {user?.role === 'SUPER_ADMIN' && <option value="SUPER_ADMIN">SUPER_ADMIN</option>}
                </select>
                <select
                  value={(newUser as any).tier || 'FREE'}
                  onChange={(event) => setNewUser({ ...newUser, tier: event.target.value })}
                  className="px-4 py-3 bg-gray-50 rounded-xl border border-gray-200"
                >
                  <option value="FREE">FREE</option>
                  <option value="BASIC">BASIC</option>
                  <option value="PRO">PRO</option>
                  <option value="ENTERPRISE">ENTERPRISE</option>
                </select>
                <button onClick={createUser} className="px-5 py-3 bg-blue-600 text-white rounded-xl font-medium">
                  Create
                </button>
              </div>
            </div>

            <div className="bg-white rounded-3xl shadow-sm border border-gray-50 overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-[#F1F3F5] text-gray-800 font-semibold text-sm border-b border-gray-200">
                  <tr>
                    <th className="px-5 py-4">User</th>
                    <th className="px-5 py-4">Role</th>
                    <th className="px-5 py-4">Tier</th>
                    <th className="px-5 py-4">Status</th>
                    <th className="px-5 py-4">Credits</th>
                    <th className="px-5 py-4">Usage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {users.map((entry) => (
                    <tr key={entry.id} className="hover:bg-blue-50/25 transition-colors group">
                      <td className="px-5 py-4">
                        <div className="font-medium text-gray-900">{entry.email}</div>
                        <div className="text-xs text-gray-400">{entry.id}</div>
                      </td>
                      <td className="px-5 py-4">
                        <select
                          value={entry.role}
                          disabled={entry.id === user.id || (entry.role === 'SUPER_ADMIN' && user.role !== 'SUPER_ADMIN')}
                          onChange={(event) => updateUser(entry.id, { role: event.target.value })}
                          className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 disabled:opacity-50"
                        >
                          <option value="USER">USER</option>
                          <option value="ADMIN">ADMIN</option>
                          {user?.role === 'SUPER_ADMIN' && <option value="SUPER_ADMIN">SUPER_ADMIN</option>}
                        </select>
                      </td>
                      <td className="px-5 py-4">
                        <select
                          value={entry.tier || 'FREE'}
                          disabled={entry.role === 'SUPER_ADMIN' && user.role !== 'SUPER_ADMIN'}
                          onChange={(event) => updateUser(entry.id, { tier: event.target.value })}
                          className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 disabled:opacity-50"
                        >
                          <option value="FREE">FREE</option>
                          <option value="BASIC">BASIC</option>
                          <option value="PRO">PRO</option>
                          <option value="ENTERPRISE">ENTERPRISE</option>
                        </select>
                      </td>
                      <td className="px-5 py-4">
                        <select
                          value={entry.status}
                          disabled={entry.id === user.id || (entry.role === 'SUPER_ADMIN' && user.role !== 'SUPER_ADMIN')}
                          onChange={(event) => updateUser(entry.id, { status: event.target.value })}
                          className="px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 disabled:opacity-50"
                        >
                          <option value="ACTIVE">ACTIVE</option>
                          <option value="SUSPENDED">SUSPENDED</option>
                        </select>
                      </td>
                      <td className="px-5 py-4">
                        <input
                          type="number"
                          min={0}
                          max={1000000}
                          defaultValue={entry.credits}
                          onBlur={(event) => {
                            const value = Number(event.target.value)
                            if (value !== entry.credits) updateUser(entry.id, { credits: value })
                          }}
                          className="w-28 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50"
                        />
                      </td>
                      <td className="px-5 py-4 text-sm text-gray-500">
                        {entry._count?.runs ?? 0} runs · {entry._count?.actors ?? 0} crawlers
                      </td>
                    </tr>
                  ))}
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
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Available Credits</label>
                <div className="flex items-center gap-3 bg-[#E8F0FE] text-blue-800 px-4 py-3 rounded-xl w-max font-medium">
                  <Wallet size={20} />
                  {user?.credits} Credits
                </div>
                <button className="mt-3 text-sm text-blue-600 font-medium hover:underline">Buy more credits</button>
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
          onPageChange={(page) => runDetail?.run?.id && fetchRunDetail(runDetail.run.id, page)}
          onDownload={(format) => runDetail?.run?.id && downloadRunOutput(runDetail.run.id, format)}
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
  onPageChange: (page: number) => void
  onDownload: (format: 'json' | 'csv') => void
  onClose: () => void
}) {
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const [expandedItemIds, setExpandedItemIds] = useState<Record<string, boolean>>({})
  const records = (detail?.items || []).map((item: any) => item.data || {})
  const detailProgress = detail?.run?.outputMetadata?.detailProgress
  let schemaColumns: string[] = []
  let schemaLabels: Record<string, string> = {}
  try {
    const schema = JSON.parse(detail?.run?.actor?.outputSchema || '{}')
    schemaColumns = Object.keys(schema?.properties || {})
    schemaLabels = Object.fromEntries(
      Object.entries(schema?.properties || {}).map(([key, property]: [string, any]) => [
        key,
        typeof property?.title === 'string' ? property.title : humanizeFieldName(key)
      ])
    )
  } catch {
    schemaColumns = []
    schemaLabels = {}
  }
  const columns = Array.from(new Set([
    ...schemaColumns,
    ...records.flatMap((record: Record<string, unknown>) => Object.keys(record))
  ]))

  const preferredSummaryColumns = ['title', 'price', 'sold', 'url', 'image', 'shopName', 'images']
  let summaryColumns = preferredSummaryColumns.filter((column) => columns.includes(column))
  if (summaryColumns.length === 0) {
    summaryColumns = columns.slice(0, 5)
  }
  const detailColumns = columns.filter(c => !summaryColumns.includes(c))

  const renderValue = (value: unknown, column: string) => {
    if (value === null || value === undefined || value === '') {
      return <span className="text-gray-300">—</span>
    }
    if (column === 'reviews' && Array.isArray(value)) {
      if (!value.length) return <span className="text-gray-400">Chưa có đánh giá</span>
      return (
        <details className="w-80">
          <summary className="cursor-pointer text-blue-600 font-medium">
            Xem {value.length} đánh giá
          </summary>
          <div className="mt-2 space-y-2 max-h-72 overflow-auto pr-2">
            {value.map((review: any, index: number) => (
              <div key={review.reviewId || index} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-gray-700">{review.author || 'Người dùng'}</span>
                  <span className="text-amber-600">{review.rating ? `${review.rating} ★` : 'Chưa chấm sao'}</span>
                </div>
                {review.variation && <div className="mt-1 text-xs text-gray-400">{review.variation}</div>}
                <div className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">
                  {review.comment || 'Người mua không để lại nội dung.'}
                </div>
                {review.createdAt && (
                  <div className="mt-1 text-[11px] text-gray-400">
                    {new Date(review.createdAt).toLocaleString('vi-VN')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      )
    }
    if (column === 'images' && Array.isArray(value)) {
      if (!value.length) return <span className="text-gray-400">Chưa có ảnh</span>
      return (
        <div className="flex items-center gap-1.5 min-w-48">
          {value.slice(0, 4).map((imageUrl: unknown, index: number) => (
            <button
              key={`${String(imageUrl)}-${index}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setPreviewImage(String(imageUrl))
              }}
              title="Bấm để xem ảnh phóng to"
            >
              <img
                src={String(imageUrl)}
                alt=""
                className="w-11 h-11 rounded-lg object-cover bg-gray-100 border border-gray-200 hover:opacity-80"
              />
            </button>
          ))}
          {value.length > 4 && (
            <span className="text-xs text-gray-500">+{value.length - 4}</span>
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
            onClick={(e) => { e.stopPropagation(); setPreviewImage(text); }}
            title="Bấm để xem ảnh phóng to trực tiếp" 
            className="inline-block relative group text-left cursor-pointer"
          >
            <img 
              src={text} 
              alt="" 
              className="w-14 h-14 rounded-xl object-cover bg-gray-100 border border-gray-200 shadow-sm group-hover:opacity-85 group-hover:scale-105 transition-all" 
            />
          </button>
        )
      }
      return (
        <a href={text} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline block max-w-xs truncate">
          {text}
        </a>
      )
    }
    return <span className="block max-w-xs whitespace-normal break-words">{text}</span>
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white w-full max-w-[94vw] h-[90vh] rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        <div className="flex justify-between items-start gap-4 p-6 border-b border-gray-100">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-semibold text-gray-900">Run data</h2>
              {detail?.run?.status && (
                <span className="px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-semibold">
                  {detail.run.status}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs font-mono text-gray-400">{detail?.run?.id}</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => onDownload('json')} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-50 text-blue-700 text-sm font-medium">
              <FileJson size={16} /> JSON
            </button>
            <button onClick={() => onDownload('csv')} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 text-emerald-700 text-sm font-medium">
              <FileSpreadsheet size={16} /> CSV
            </button>
            <button onClick={onClose} className="ml-2 text-gray-400 hover:text-gray-800 text-2xl">×</button>
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
                <table className="min-w-full text-left text-sm">
                  <thead className="sticky top-0 bg-white border-b border-gray-200 text-gray-700 font-semibold">
                    <tr>
                      <th className="w-10 px-3 py-3"></th>
                      <th className="px-4 py-3">STT</th>
                      {summaryColumns.map((column) => (
                        <th key={column} className="px-4 py-3 whitespace-nowrap">
                          {schemaLabels[column] || humanizeFieldName(column)}
                        </th>
                      ))}
                      {detailColumns.length > 0 && <th className="px-4 py-3 text-right">Chi tiết</th>}
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
                            <td className="w-10 px-3 py-3 text-gray-400">
                              <button type="button" className="p-1 rounded hover:bg-gray-100 transition-transform">
                                <ChevronRight size={16} className={`transition-transform duration-200 ${isExpanded ? 'rotate-90 text-blue-600' : ''}`} />
                              </button>
                            </td>
                            <td className="px-4 py-3 text-gray-400 font-medium">{item.position + 1}</td>
                            {summaryColumns.map((column) => (
                              <td key={column} className="px-4 py-3 text-gray-700">{renderValue(item.data?.[column], column)}</td>
                            ))}
                            {detailColumns.length > 0 && (
                              <td className="px-4 py-3 text-right">
                                <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium transition-colors ${
                                  isExpanded ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}>
                                  {isExpanded ? 'Thu gọn' : 'Xem chi tiết'}
                                </span>
                              </td>
                            )}
                          </tr>

                          {isExpanded && (
                            <tr key={`${item.id}-detail`} className="bg-slate-50/80 border-b border-gray-200">
                              <td colSpan={summaryColumns.length + 3} className="p-4">
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
                                              {renderValue(val, col)}
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

      {previewImage && (
        <div 
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[70] flex items-center justify-center p-4"
          onClick={() => setPreviewImage(null)}
        >
          <div 
            className="relative max-w-5xl max-h-[90vh] flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img 
              src={previewImage} 
              alt="Preview" 
              className="max-w-full max-h-[82vh] object-contain rounded-2xl shadow-2xl border border-white/10" 
            />
            <div className="mt-4 flex items-center gap-4 bg-white/10 backdrop-blur-md px-5 py-2.5 rounded-full border border-white/20 text-white text-xs font-medium">
              <a 
                href={previewImage} 
                target="_blank" 
                rel="noreferrer"
                className="hover:underline flex items-center gap-1.5 text-white"
              >
                Mở tab mới <ExternalLink size={13} />
              </a>
              <span className="text-white/40">•</span>
              <button 
                onClick={() => setPreviewImage(null)}
                className="hover:underline text-white/80 hover:text-white"
              >
                Đóng
              </button>
            </div>
            <button 
              onClick={() => setPreviewImage(null)}
              className="absolute -top-10 -right-2 text-white/80 hover:text-white text-3xl font-light p-2"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ActorInputFields({
  schema,
  input,
  onChange
}: {
  schema?: string | null
  input: Record<string, unknown>
  onChange: (input: Record<string, unknown>) => void
}) {
  const parsed = parseInputSchema(schema)
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
