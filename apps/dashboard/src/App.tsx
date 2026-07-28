import { useState, useEffect } from 'react'
import { Play, Activity, Clock, Settings, Search, Bot, Package, Download, LogOut, Wallet } from 'lucide-react'
import Login from './Login'
import './App.css'

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'))
  const [user, setUser] = useState<any>(null)
  
  const [actors, setActors] = useState([])
  const [runs, setRuns] = useState([])
  const [activeTab, setActiveTab] = useState('actors') // 'actors' | 'runs' | 'marketplace'
  const [newActorName, setNewActorName] = useState('')

  useEffect(() => {
    if (token) {
      fetchData()
      fetchUser()
    }
  }, [token])

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
      const [actorsRes, runsRes] = await Promise.all([
        fetch('http://localhost:3001/api/actors', { headers }),
        fetch('http://localhost:3001/api/runs', { headers })
      ])
      if (actorsRes.status === 401 || runsRes.status === 401) {
        handleLogout()
        return
      }
      setActors(await actorsRes.json())
      setRuns(await runsRes.json())
    } catch (err) {
      console.error('Failed to fetch data', err)
    }
  }

  const triggerRun = async (id: string) => {
    try {
      const res = await fetch(`http://localhost:3001/api/actors/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({})
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
      <aside className="w-72 bg-[#F0F4F8] p-4 flex flex-col gap-2 rounded-r-[32px] my-2">
        <div className="flex items-center gap-3 px-4 py-6">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white">
            <Bot size={24} />
          </div>
          <span className="text-2xl font-semibold tracking-tight text-gray-900">OmniCrawl</span>
        </div>

        {user && (
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
          />
          <NavItem 
            icon={<Activity />} 
            label="Job Runs" 
            active={activeTab === 'runs'} 
            onClick={() => setActiveTab('runs')} 
          />
          <NavItem 
            icon={<Clock />} 
            label="Schedules" 
            active={false} 
            onClick={() => {}} 
          />
          <NavItem 
            icon={<Package />} 
            label="Marketplace" 
            active={activeTab === 'marketplace'} 
            onClick={() => setActiveTab('marketplace')} 
          />
        </nav>
        
        <div className="mt-auto pb-4 space-y-1">
          <NavItem icon={<Settings />} label="Settings" active={false} onClick={() => {}} />
          <NavItem icon={<LogOut />} label="Logout" active={false} onClick={handleLogout} />
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 p-8 overflow-y-auto">
        <header className="flex justify-between items-center mb-10">
          <h1 className="text-4xl font-medium text-gray-900 capitalize">{activeTab}</h1>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
            <input 
              type="text" 
              placeholder="Search anything..." 
              className="pl-12 pr-4 py-3 bg-white rounded-full w-80 shadow-sm border border-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-100 transition-shadow"
            />
          </div>
        </header>

        {activeTab === 'actors' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {actors.map((actor: any) => (
              <div key={actor.id} className="bg-white p-6 rounded-3xl shadow-sm border border-gray-50 hover:shadow-md transition-shadow group flex flex-col h-full">
                <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600 mb-6 group-hover:scale-105 transition-transform">
                  <Bot size={28} />
                </div>
                <h3 className="text-xl font-medium text-gray-900 mb-2">{actor.name}</h3>
                <p className="text-gray-500 mb-8 flex-1">{actor.description || 'No description provided.'}</p>
                
                <div className="flex gap-3">
                  <button 
                    onClick={() => triggerRun(actor.id)}
                    className="flex-1 flex items-center justify-center gap-2 bg-[#E8F0FE] text-blue-700 font-medium py-3 rounded-full hover:bg-blue-100 transition-colors"
                  >
                    <Play size={18} fill="currentColor" /> Run (10 Credits)
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
                  <th className="px-6 py-4">Started At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {runs.map((run: any) => (
                  <tr key={run.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-5 font-mono text-xs text-gray-400">{run.id}</td>
                    <td className="px-6 py-5 text-gray-900">{run.actorId}</td>
                    <td className="px-6 py-5">
                      <span className={`px-3 py-1 text-xs font-semibold rounded-full ${
                        run.status === 'SUCCESS' ? 'bg-green-100 text-green-700' :
                        run.status === 'FAILED' ? 'bg-red-100 text-red-700' :
                        run.status === 'RUNNING' ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-gray-500">{new Date(run.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
      </main>
    </div>
  )
}

function NavItem({ icon, label, active, onClick }: { icon: any, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-4 px-5 py-3.5 rounded-full font-medium transition-colors ${
        active ? 'bg-[#C2E7FF] text-[#001D35]' : 'text-gray-600 hover:bg-gray-200/50'
      }`}
    >
      <span className={active ? 'text-[#001D35]' : 'text-gray-500'}>{icon}</span>
      {label}
    </button>
  )
}

export default App
