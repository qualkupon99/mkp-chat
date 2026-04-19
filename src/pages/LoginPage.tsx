import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, HelpCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';

export default function LoginPage() {
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState(''); // Email or Username
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    let loginEmail = identifier;

    // Check if the identifier is a username (no '@' symbol)
    if (!identifier.includes('@')) {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('email')
        .eq('username', identifier.toLowerCase())
        .single();

      if (!profileError && profile) {
        loginEmail = profile.email;
      }
    }

    const { error: authError } = await supabase.auth.signInWithPassword({ 
      email: loginEmail, 
      password 
    });
    
    setLoading(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    // Check if suspended AND profile completeness
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_suspended, full_name, username')
        .eq('id', user.id)
        .single();

      if (profile?.is_suspended) {
        await supabase.auth.signOut();
        setError('Your account has been suspended. Contact support for assistance.');
        return;
      }

      // Redirect to onboarding if profile is incomplete
      if (!profile?.full_name || !profile?.username) {
        navigate('/onboarding');
        return;
      }
    }

    navigate('/');
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

        <h1 className="auth-title">Welcome back</h1>
        <p className="auth-subtitle">Sign in to continue chatting</p>

        {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="input-group">
            <label htmlFor="login-identifier" className="input-label">Email or Username</label>
            <div className="input-wrapper">
              <input
                id="login-identifier"
                type="text"
                className="input"
                placeholder="you@example.com or admin"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                required
                style={{ paddingLeft: 44 }}
              />
              <span className="input-icon" style={{ left: 12 }}><Mail size={16} /></span>
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="login-password" className="input-label">Password</label>
            <div className="input-wrapper">
              <input
                id="login-password"
                type={showPass ? 'text' : 'password'}
                className="input"
                placeholder="Your password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                style={{ paddingLeft: 44 }}
              />
              <span className="input-icon" style={{ left: 12 }}><Lock size={16} /></span>
              <button type="button" className="input-icon" onClick={() => setShowPass(v => !v)} style={{ cursor: 'pointer', background: 'none', border: 'none', pointerEvents: 'auto' }}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading}>
            {loading ? <><span className="loader" style={{ width: 18, height: 18, borderWidth: 2 }} /> Signing in...</> : 'Sign In'}
          </button>
        </form>

        <div className="auth-footer">
          Don't have an account? <Link to="/register">Create one</Link>
        </div>

        {/* Help button */}
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Link to="/help" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.8125rem', color: 'var(--color-text-muted)', textDecoration: 'none', padding: '6px 12px', borderRadius: 20, border: '1px solid var(--color-border)', transition: 'all 0.2s' }}
            onMouseEnter={e => { (e.currentTarget as any).style.color = 'var(--color-primary)'; (e.currentTarget as any).style.borderColor = 'var(--color-primary)'; }}
            onMouseLeave={e => { (e.currentTarget as any).style.color = 'var(--color-text-muted)'; (e.currentTarget as any).style.borderColor = 'var(--color-border)'; }}>
            <HelpCircle size={14} /> Need help?
          </Link>
        </div>
      </div>
    </div>
  );
}
