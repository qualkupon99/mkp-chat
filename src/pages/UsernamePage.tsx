import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AtSign, CheckCircle2, XCircle, Loader } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

export default function UsernamePage() {
  const navigate = useNavigate();
  const { user, refreshProfile } = useAuth();
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const checkAvailability = useCallback(async (value: string) => {
    if (value.length < 3) { setStatus('invalid'); return; }
    if (!/^[a-zA-Z0-9_]+$/.test(value)) { setStatus('invalid'); return; }
    
    setStatus('checking');
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('username', value.toLowerCase())
      .maybeSingle();

    setStatus(data ? 'taken' : 'available');
  }, []);

  useEffect(() => {
    if (!username) { setStatus('idle'); return; }
    const timer = setTimeout(() => checkAvailability(username), 400);
    return () => clearTimeout(timer);
  }, [username, checkAvailability]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status !== 'available' || !user) return;

    setLoading(true);
    setError('');

    const { error: updateError } = await supabase
      .from('profiles')
      .update({ username: username.toLowerCase() })
      .eq('id', user.id);

    setLoading(false);

    if (updateError) { setError(updateError.message); return; }
    await refreshProfile();
    navigate('/');
  };

  const statusIcon = () => {
    if (status === 'checking') return <Loader size={16} className="spin" style={{ animation: 'spin 0.8s linear infinite' }} />;
    if (status === 'available') return <CheckCircle2 size={16} color="#22D3EE" />;
    if (status === 'taken' || status === 'invalid') return <XCircle size={16} color="#F87171" />;
    return null;
  };

  const statusMsg = () => {
    if (status === 'available') return <span style={{ color: '#22D3EE', fontSize: '0.8rem' }}>✓ Username is available</span>;
    if (status === 'taken') return <span style={{ color: '#F87171', fontSize: '0.8rem' }}>✗ This username is taken</span>;
    if (status === 'invalid') return <span style={{ color: '#F87171', fontSize: '0.8rem' }}>✗ 3-20 chars, letters/numbers/underscores only</span>;
    return null;
  };

  return (
    <div className="auth-page">
      <div className="auth-card animate-slide-up">
        <div className="auth-logo">
          <div className="auth-logo-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <span className="auth-logo-text">MKP Chat</span>
        </div>

        <h1 className="auth-title">Pick a username</h1>
        <p className="auth-subtitle">This is how others will find you on MKP Chat</p>

        {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="input-group">
            <label className="input-label">Username</label>
            <div className="input-wrapper">
              <input
                type="text"
                className="input"
                placeholder="e.g. john_doe"
                value={username}
                onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                maxLength={20}
                required
                style={{ paddingLeft: 44, paddingRight: 44 }}
              />
              <span className="input-icon" style={{ left: 12 }}><AtSign size={16} /></span>
              <span className="input-icon">{statusIcon()}</span>
            </div>
            <div style={{ minHeight: 20 }}>{statusMsg()}</div>
          </div>

          <button type="submit" className="btn btn-primary btn-full btn-lg"
            disabled={loading || status !== 'available'}>
            {loading ? <><span className="loader" style={{ width: 18, height: 18, borderWidth: 2 }} /> Saving...</> : 'Continue →'}
          </button>
        </form>
      </div>
    </div>
  );
}
