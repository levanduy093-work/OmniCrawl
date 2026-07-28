import { useState, useEffect } from 'react'
import { Play, Activity, Clock, Settings, Search, Bot, Package, Download, LogOut, Wallet, Menu } from 'lucide-react'
import Login from './Login'
import OmniCrawlLogo from './Logo'
import './App.css'

function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'))
  const [user, setUser] = useState<any>(null)
  
  // Tabs: actors, runs, schedules, marketplace
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('activeTab') || 'actors')

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);
  
  const [actors, setActors] = useState([])
  const [runs, setRuns] = useState([])
  const [schedules, setSchedules] = useState([])
  const [newActorName, setNewActorName] = useState('')
  const [newScheduleActorId, setNewScheduleActorId] = useState('')
  const [newScheduleCron, setNewScheduleCron] = useState('* * * * *')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [runInputs, setRunInputs] = useState<Record<string, any>>({})
  
  // Log Viewer State
  const [logModalOpen, setLogModalOpen] = useState(false)
  const [activeLogRunId, setActiveLogRunId] = useState<string | null>(null)
  const [logs, setLogs] = useState<string>('')

  useEffect(() => {
    if (token) {
      fetchData()
      fetchUser()
    }
  }, [token])

  // Poll data in background every 5 seconds to update statuses
  useEffect(() => {
    let interval: any;
    if (token) {
      interval = setInterval(() => {
        fetchData();
      }, 5000);
    }
    return () => clearInterval(interval);
  }, [token]);

  const fetchUser = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      if (res.ok) setUser(await res.json())
      else handleLogout()
    } catch {
      handleLogout()
    }
  }

  const fetchData = async () => {
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
    } catch (err) {
      console.error('Failed to fetch data', err)
    }
  }

  const triggerRun = async (id: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/actors/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(runInputs[id] || {})
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
        body: JSON.stringify({ actorId: newScheduleActorId, cron: newScheduleCron })
      });
      if (!res.ok) throw new Error(await res.text());
      setNewScheduleCron('* * * * *');
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
      await fetch(`http://localhost:3001/api/runs/${id}/stop`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
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

  const openLogViewer = (id: string) => {
    setActiveLogRunId(id);
    setLogModalOpen(true);
    fetchLogs(id);
  }

  const fetchLogs = async (id: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/runs/${id}/logs`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setLogs(data.logs || 'No logs available.');
    } catch (err) {
      setLogs('Error fetching logs.');
    }
  }

  // Poll logs if modal is open
  useEffect(() => {
    let interval: any;
    if (logModalOpen && activeLogRunId) {
      interval = setInterval(() => fetchLogs(activeLogRunId), 2000);
    }
    return () => clearInterval(interval);
  }, [logModalOpen, activeLogRunId]);

  const handleLogin = (newToken: string, newUser: any) => {
    localStorage.setItem('token', newToken)
    setToken(newToken)
    setUser(newUser)
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
  }

  if (!token) {
    return <Login onLogin={handleLogin} />
  }

  return (
    <div className="flex h-screen bg-[#F8F9FA] font-sans text-gray-800">
      
      {/* Sidebar - Material Design 3 Navigation Drawer style */}
      <aside className={`${isSidebarOpen ? 'w-64' : 'w-20'} transition-all duration-300 bg-[#F0F4F8] p-3 flex flex-col gap-1 rounded-r-[32px] my-2 overflow-hidden`}>
        <div className="px-4 py-5 flex items-center justify-between">
          {isSidebarOpen && <OmniCrawlLogo size="md" />}
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-gray-200 rounded-full text-gray-500 mx-auto">
            <Menu size={20} />
          </button>
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {actors.map((actor: any) => (
              <div key={actor.id} className="bg-white p-5 rounded-3xl shadow-sm border border-gray-50 hover:shadow-md transition-shadow group flex flex-col h-full">
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 mb-4 group-hover:scale-105 transition-transform">
                  <Bot size={24} />
                </div>
                <h3 className="text-lg font-medium text-gray-900 mb-1">{actor.name}</h3>
                <p className="text-sm text-gray-500 mb-6 flex-1">{actor.description || 'No description provided.'}</p>
                
                
                {actor.name === 'shopee-scraper' && (
                  <div className="mb-4 space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">Search Keyword</label>
                      <input 
                        type="text" 
                        value={runInputs[actor.id]?.keyword || ''} 
                        onChange={e => setRunInputs({...runInputs, [actor.id]: {...runInputs[actor.id], keyword: e.target.value}})}
                        placeholder="e.g. bàn phím cơ" 
                        className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </div>
                    <input 
                      type="number" 
                      placeholder="Max items (e.g. 60)" 
                      className="border rounded px-3 py-1 text-sm bg-white text-gray-700 w-36"
                      value={runInputs[actor.id]?.maxItems || ''}
                      onChange={(e) => setRunInputs(prev => ({
                        ...prev,
                        [actor.id]: { ...prev[actor.id], maxItems: e.target.value }
                      }))}
                    />
                    <input 
                      type="text" 
                      placeholder="Cookie (Optional)" 
                      className="border rounded px-3 py-1 text-sm bg-white text-gray-700 w-48"
                      value={runInputs[actor.id]?.cookie || ''}
                      onChange={(e) => setRunInputs(prev => ({
                        ...prev,
                        [actor.id]: { ...prev[actor.id], cookie: e.target.value }
                      }))}
                    />
                    <button 
                      onClick={() => triggerRun(actor.id)}
                      className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1 rounded text-sm font-medium transition-colors whitespace-nowrap"
                    >
                      Run
                    </button>
                  </div>
                )}

                <div className="flex gap-3 mt-auto">
                  <button 
                    onClick={() => triggerRun(actor.id)}
                    className="flex-1 flex items-center justify-center gap-2 bg-[#E8F0FE] text-blue-700 font-medium py-2.5 text-sm rounded-full hover:bg-blue-100 transition-colors"
                  >
                    <Play size={16} fill="currentColor" /> Run (10 Credits)
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'runs' && (
          <div className="bg-white rounded-3xl shadow-sm border border-gray-50 overflow-hidden">
            <table className="w-full text-left">
              <thead className="bg-[#F8F9FA] text-gray-500 font-medium text-sm">
                <tr>
                  <th className="px-6 py-4">ID</th>
                  <th className="px-6 py-4">Actor ID</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4">Created At</th>
                  <th className="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map((run: any) => (
                  <tr key={run.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-5 font-mono text-xs text-gray-400">{run.id}</td>
                    <td className="px-6 py-5 text-gray-900">{run.actor?.name || run.actorId}</td>
                    <td className="px-6 py-5">
                      <span className={`px-3 py-1 text-xs font-semibold rounded-full ${
                        run.status === 'SUCCESS' ? 'bg-green-100 text-green-700' :
                        run.status === 'FAILED' ? 'bg-red-100 text-red-700' :
                        (run.status === 'RUNNING' || run.status === 'STOPPING') ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-gray-500">{new Date(run.createdAt).toLocaleString()}</td>
                    <td className="px-6 py-5 text-right space-x-2">
                      <button onClick={() => openLogViewer(run.id)} className="px-3 py-1 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 text-xs font-medium">Logs</button>
                      {(run.status === 'RUNNING' || run.status === 'PENDING') && (
                        <button onClick={() => handleStopRun(run.id)} className="px-3 py-1 bg-yellow-100 text-yellow-700 rounded hover:bg-yellow-200 text-xs font-medium">Stop</button>
                      )}
                      <button onClick={() => handleDeleteRun(run.id)} className="px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200 text-xs font-medium">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'schedules' && (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-3xl shadow-sm border border-gray-50 flex gap-4 items-end">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Crawler</label>
                <select 
                  value={newScheduleActorId} 
                  onChange={e => setNewScheduleActorId(e.target.value)}
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

            <div className="bg-white rounded-3xl shadow-sm border border-gray-50 overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-[#F8F9FA] text-gray-500 font-medium text-sm">
                  <tr>
                    <th className="px-6 py-4">Crawler</th>
                    <th className="px-6 py-4">Cron Expression</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {schedules.map((schedule: any) => (
                    <tr key={schedule.id} className="hover:bg-gray-50 transition-colors">
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
            </div>
          </div>
        )}
      </main>

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
