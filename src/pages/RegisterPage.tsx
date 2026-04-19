import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Mail, Lock, User, Calendar, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { differenceInYears } from 'date-fns';

type FormData = {
  fullName: string;
  email: string;
  dob: string;
  gender: string;
  password: string;
  confirmPassword: string;
};

export default function RegisterPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormData>({ fullName: '', email: '', dob: '', gender: '', password: '', confirmPassword: '' });
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [emailSent, setEmailSent] = useState(false);

  const validate = () => {
    if (form.fullName.length < 2 || form.fullName.length > 60) return 'Full name must be 2–60 characters';
    if (!form.dob) return 'Date of birth is required';
    const age = differenceInYears(new Date(), new Date(form.dob));
    if (age < 13) return 'You must be at least 13 years old';
    if (!form.gender) return 'Please select your gender';
    if (form.password.length < 8) return 'Password must be at least 8 characters';
    if (!/[A-Z]/.test(form.password)) return 'Password must contain at least one uppercase letter';
    if (!/[0-9]/.test(form.password)) return 'Password must contain at least one number';
    if (form.password !== form.confirmPassword) return 'Passwords do not match';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) { setError(validationError); return; }

    setError('');
    setLoading(true);

    const { data, error: authError } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: {
          full_name: form.fullName,
          dob: form.dob,
          gender: form.gender,
        }
      }
    });

    setLoading(false);
    if (authError) { setError(authError.message); return; }
    
    // If sign up succeeded but no session is returned, email confirmation is required
    if (data.user && !data.session) {
      setEmailSent(true);
      return;
    }

    navigate('/register/username');
  };

  const update = (k: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  if (emailSent) {
    return (
      <div className="auth-page">
        <div className="auth-card animate-slide-up" style={{ textAlign: 'center' }}>
          <div className="auth-logo" style={{ justifyContent: 'center' }}>
            <div className="auth-logo-icon">
              <Mail size={22} color="white" />
            </div>
          </div>
          <h1 className="auth-title">Verify your email</h1>
          <p className="auth-subtitle" style={{ lineHeight: 1.6, marginBottom: 24 }}>
            We've sent a verification link to <strong>{form.email}</strong>. 
            Please check your inbox (and spam folder) to activate your account.
          </p>
          <div style={{ padding: '20px', background: 'var(--color-surface-2)', borderRadius: '12px', fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            After verifying, you can sign in to choose your username!
          </div>
          <button className="btn btn-primary btn-full btn-lg" style={{ marginTop: 24 }} onClick={() => navigate('/login')}>
            Return to Sign In
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card animate-slide-up">
        <div className="auth-logo">
          <div className="auth-logo-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          </div>
          <span className="auth-logo-text">MKP Chat</span>
        </div>

        <h1 className="auth-title">Create account</h1>
        <p className="auth-subtitle">Join MKP Chat today</p>

        {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="input-group">
            <label htmlFor="reg-fullname" className="input-label">Full Name</label>
            <div className="input-wrapper">
              <input id="reg-fullname" type="text" className="input" placeholder="John Doe" value={form.fullName}
                onChange={update('fullName')} required style={{ paddingLeft: 44 }} />
              <span className="input-icon" style={{ left: 12 }}><User size={16} /></span>
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="reg-email" className="input-label">Email</label>
            <div className="input-wrapper">
              <input id="reg-email" type="email" className="input" placeholder="you@example.com" value={form.email}
                onChange={update('email')} required style={{ paddingLeft: 44 }} />
              <span className="input-icon" style={{ left: 12 }}><Mail size={16} /></span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="input-group">
              <label htmlFor="reg-dob" className="input-label">Date of Birth</label>
              <div className="input-wrapper">
                <input id="reg-dob" type="date" className="input" value={form.dob}
                  onChange={update('dob')} required style={{ paddingLeft: 44 }} />
                <span className="input-icon" style={{ left: 12 }}><Calendar size={16} /></span>
              </div>
            </div>
            <div className="input-group">
              <label htmlFor="reg-gender" className="input-label">Gender</label>
              <div className="input-wrapper">
                <select id="reg-gender" className="input" value={form.gender} onChange={update('gender')} required style={{ paddingLeft: 44 }}>
                  <option value="">Select</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="non_binary">Non-Binary</option>
                  <option value="prefer_not_to_say">Prefer Not to Say</option>
                </select>
                <span className="input-icon" style={{ left: 12, pointerEvents: 'none' }}><Users size={16} /></span>
              </div>
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="reg-password" className="input-label">Password</label>
            <div className="input-wrapper">
              <input id="reg-password" type={showPass ? 'text' : 'password'} className="input" placeholder="Min 8 chars, 1 uppercase, 1 number"
                value={form.password} onChange={update('password')} required style={{ paddingLeft: 44 }} />
              <span className="input-icon" style={{ left: 12 }}><Lock size={16} /></span>
              <button type="button" className="input-icon" onClick={() => setShowPass(v => !v)} style={{ cursor: 'pointer', background: 'none', border: 'none', pointerEvents: 'auto' }}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="reg-confirm" className="input-label">Confirm Password</label>
            <div className="input-wrapper">
              <input id="reg-confirm" type={showPass ? 'text' : 'password'} className="input" placeholder="Repeat your password"
                value={form.confirmPassword} onChange={update('confirmPassword')} required style={{ paddingLeft: 44 }} />
              <span className="input-icon" style={{ left: 12 }}><Lock size={16} /></span>
            </div>
          </div>

          <button type="submit" className="btn btn-primary btn-full btn-lg" disabled={loading}>
            {loading ? <><span className="loader" style={{ width: 18, height: 18, borderWidth: 2 }} /> Creating account...</> : 'Create Account'}
          </button>
        </form>

        <div className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
