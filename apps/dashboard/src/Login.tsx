import { useState } from 'react';
import { Mail, Lock, ArrowRight } from 'lucide-react';
import OmniCrawlLogo from './Logo';

export default function Login({ onLogin }: { onLogin: (token: string, user: any) => void }) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    setError('');
    const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
    
    try {
      const res = await fetch(`http://localhost:3001${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      onLogin(data.token, data.user);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="flex h-screen bg-[#F8F9FA] items-center justify-center font-sans">
      <div className="w-full max-w-md bg-white p-10 rounded-3xl shadow-sm border border-gray-100 text-center">
        <div className="flex justify-center mb-6">
          <OmniCrawlLogo size="lg" showText={true} />
        </div>
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          {isRegister ? 'Create an Account' : 'Welcome to OmniCrawl'}
        </h1>
        <p className="text-gray-500 mb-8">
          {isRegister ? 'Sign up to build your ecosystem.' : 'Please sign in to continue.'}
        </p>

        {error && <div className="mb-6 p-3 bg-red-50 text-red-600 rounded-xl text-sm">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
            <input 
              type="email" 
              placeholder="Email address" 
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full pl-12 pr-4 py-4 bg-[#F8F9FA] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <div className="relative">
            <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
            <input 
              type="password" 
              placeholder="Password" 
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full pl-12 pr-4 py-4 bg-[#F8F9FA] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <button 
            type="submit" 
            className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium py-4 rounded-xl hover:bg-blue-700 transition-colors mt-4"
          >
            {isRegister ? 'Sign Up' : 'Sign In'} <ArrowRight size={18} />
          </button>
        </form>

        <p className="mt-8 text-sm text-gray-500">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button onClick={() => setIsRegister(!isRegister)} className="text-blue-600 font-medium hover:underline">
            {isRegister ? 'Sign In' : 'Sign Up'}
          </button>
        </p>
      </div>
    </div>
  );
}
