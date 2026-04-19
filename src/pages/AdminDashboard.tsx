import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserPlus, Shield, Check, AlertCircle, Loader2, ArrowLeft } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

const MASTER_ADMIN_EMAIL = 'dragonartserpent@gmail.com';

export default function AdminDashboard() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // FIX: Check both master email AND is_admin flag
  const isAuthorized = profile?.email === MASTER_ADMIN_EMAIL || profile?.is_admin;
  if (!isAuthorized) {
    return (
      <div className="empty-state">
        <Shield size={48} color="#ef4444" />
        <h2 className="empty-state-title">Access Denied</h2>
        <p className="empty-state-desc">You do not have administrative privileges.</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>Return Home</button>
      </div>
    );
  }

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      const payload = {
        email,
        password,
        full_name: fullName,
        username: username.toLowerCase().replace(/\s/g, ''),
        is_admin: false,
      };

      console.log('FRONTEND DEBUG - Sending admin-create-user request with payload:', payload);

      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-create-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify(payload),
      });

      console.log('FRONTEND DEBUG - Raw Response Status:', res.status);
      const result = await res.json();
      console.log('FRONTEND DEBUG - Result Body:', result);

      if (!res.ok || !result.success) throw new Error(result.error || `Failed with status ${res.status}`);

      setSuccess(true);
      setEmail('');
      setPassword('');
      setFullName('');
      setUsername('');
    } catch (err: any) {
      console.error('Admin creation error:', err);
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-dashboard animate-fade-in" style={{ padding: '2rem', maxWidth: '600px', margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/')}>
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Shield size={24} color="var(--color-primary)" />
            Admin Control Panel
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>Create pre-authorized special user accounts</p>
        </div>
      </header>

      <section className="card" style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', padding: '1.5rem' }}>
        <h2 style={{ fontSize: '1.125rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <UserPlus size={20} />
          Create New User Account
        </h2>

        <form onSubmit={handleCreateUser} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group">
            <label className="label">Full Name</label>
            <input 
              type="text" 
              className="input"
              style={{ width: '100%' }}
              placeholder="John Doe" 
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="label">Username</label>
            <input 
              type="text" 
              className="input"
              style={{ width: '100%' }}
              placeholder="johndoe" 
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="label">Email Address</label>
            <input 
              type="email" 
              className="input"
              style={{ width: '100%' }}
              placeholder="user@example.com" 
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label className="label">Login Password</label>
            <input 
              type="password" 
              className="input"
              style={{ width: '100%' }}
              placeholder="••••••••" 
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>

          {/* FIX: Replace Tailwind classes with inline styles */}
          {error && (
            <div style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', padding: '0.75rem', borderRadius: '0.375rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', border: '1px solid rgba(239,68,68,0.2)' }}>
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          {success && (
            <div style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e', padding: '0.75rem', borderRadius: '0.375rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', border: '1px solid rgba(34,197,94,0.2)' }}>
              <Check size={16} />
              User created successfully! They can now login with these credentials.
            </div>
          )}

          <button 
            type="submit" 
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '0.5rem', padding: '0.75rem' }}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                Creating Account...
              </>
            ) : (
              'Create Special User'
            )}
          </button>
        </form>
      </section>

      <footer style={{ marginTop: '2rem', padding: '1rem', background: 'var(--color-surface-2)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--color-border)' }}>
        <p style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', lineHeight: '1.4' }}>
          <strong>Note:</strong> Users created through this panel are automatically verified. No email confirmation is required. They will appear in the "New Chat" search immediately.
        </p>
      </footer>
    </div>
  );
}
