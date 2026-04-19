import { useState, useRef, useCallback } from 'react';
import { Camera, ChevronRight, LogOut, Moon, Sun, Monitor, AlertTriangle, Type, Palette, Bell, HelpCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { differenceInDays } from 'date-fns';

const CHAT_BG_PRESETS = [
  { label: 'Default', value: null },
  { label: 'Midnight', value: '#0a0a1a' },
  { label: 'Deep Blue', value: 'linear-gradient(160deg,#0f0c29,#302b63,#24243e)' },
  { label: 'Forest', value: 'linear-gradient(160deg,#134e5e,#71b280)' },
  { label: 'Sunset', value: 'linear-gradient(160deg,#f7971e,#ffd200)' },
  { label: 'Violet', value: 'linear-gradient(160deg,#4776e6,#8e54e9)' },
  { label: 'Rose', value: 'linear-gradient(160deg,#f953c6,#b91d73)' },
  { label: 'Slate', value: '#1e293b' },
];

const ACCENT_COLORS = [
  { name: 'Sky Blue', value: '#38BDF8', key: 'sky' },
  { name: 'Purple',   value: '#A855F7', key: 'purple' },
  { name: 'Green',    value: '#22C55E', key: 'green' },
  { name: 'Orange',   value: '#F97316', key: 'orange' },
  { name: 'Pink',     value: '#EC4899', key: 'pink' },
  { name: 'Red',      value: '#EF4444', key: 'red' },
];

export default function SettingsPage() {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [editName, setEditName] = useState(false);
  const [editUsername, setEditUsername] = useState(false);
  const [newName, setNewName] = useState(profile?.full_name || '');
  const [newUsername, setNewUsername] = useState(profile?.username || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState('');

  const cooldownDays = profile?.username_changed_at
    ? Math.max(0, 5 - differenceInDays(new Date(), new Date(profile.username_changed_at)))
    : 0;
  const canChangeUsername = cooldownDays === 0;

  const showMsg = (text: string) => { setMsg(text); setTimeout(() => setMsg(''), 3000); };

  const saveDisplayName = async () => {
    if (!user || !newName.trim()) return;
    setSaving(true);
    const { error } = await supabase.from('profiles').update({ full_name: newName.trim() }).eq('id', user.id);
    setSaving(false);
    if (error) { showMsg('Failed to update: ' + error.message); return; }
    await refreshProfile();
    setEditName(false);
    showMsg('Display name updated!');
  };

  const saveUsername = async () => {
    if (!user || !newUsername.trim() || !canChangeUsername) return;
    setSaving(true);
    const { error } = await supabase.from('profiles')
      .update({ username: newUsername.toLowerCase().trim(), username_changed_at: new Date().toISOString() })
      .eq('id', user.id);
    setSaving(false);
    if (error) { showMsg('Username already taken!'); return; }
    await refreshProfile();
    setEditUsername(false);
    showMsg('Username updated!');
  };

  const uploadAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    setUploading(true);
    const fileName = `${user.id}/${Date.now()}.${file.name.split('.').pop()}`;
    const { data, error } = await supabase.storage.from('avatars').upload(fileName, file, { upsert: true });
    if (!error && data) {
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(fileName);
      await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', user.id);
      await refreshProfile();
      showMsg('Avatar updated!');
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const updatePreference = useCallback(async (key: string, value: any) => {
    if (!user || !profile) return;
    const newPrefs = { ...profile.ui_preferences, [key]: value };
    const { error } = await supabase.from('profiles').update({ ui_preferences: newPrefs }).eq('id', user.id);
    if (error) { console.error('[Settings] preference update failed:', error); showMsg('Update failed'); return; }
    await refreshProfile();
  }, [user, profile, refreshProfile]);

  const togglePrivacy = async () => {
    if (!user || !profile) return;
    const newMode = profile.privacy_mode === 'public' ? 'private' : 'public';
    const { error } = await supabase.from('profiles').update({ privacy_mode: newMode }).eq('id', user.id);
    if (error) { showMsg('Failed to update privacy'); return; }
    await refreshProfile();
  };

  const handleSignOut = async () => { await signOut(); navigate('/login'); };

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  const currentTheme = profile?.ui_preferences?.mode || 'dark';
  const currentFontSize = profile?.ui_preferences?.font_size || 'medium';
  const currentBg = profile?.ui_preferences?.chat_bg as string | undefined;
  const notifSound = profile?.ui_preferences?.notification_sound !== false; // default true

  return (
    <div className="settings-page">
      <div className="page-header" style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--color-bg-elevated)' }}>
        <div className="page-header-title">Settings</div>
      </div>

      <div className="settings-content">
        {msg && (
          <div style={{ padding: '12px 16px', background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.25)', borderRadius: 'var(--radius-md)', color: '#22D3EE', fontSize: '0.875rem', animation: 'fadeIn 0.3s ease', margin: '0 0 8px 0' }}>
            ✓ {msg}
          </div>
        )}

        {/* Profile */}
        <div className="settings-section">
          <div className="settings-section-title">Profile</div>
          <div className="settings-avatar-section">
            <div style={{ position: 'relative' }}>
              <div className="avatar avatar-xl">
                {profile?.avatar_url
                  ? <img src={profile.avatar_url} alt={profile.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                  : initials
                }
              </div>
              <button
                onClick={() => fileRef.current?.click()}
                style={{ position: 'absolute', bottom: 0, right: 0, width: 28, height: 28, borderRadius: '50%', background: 'var(--color-primary)', border: '2px solid var(--color-bg-elevated)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                disabled={uploading}
              >
                <Camera size={12} color="white" />
              </button>
            </div>
            <div style={{ fontWeight: 600 }}>{profile?.full_name}</div>
            <div style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>@{profile?.username}</div>
            <input type="file" ref={fileRef} style={{ display: 'none' }} accept="image/*" onChange={uploadAvatar} />
          </div>

          {/* Display Name */}
          <div className="settings-item" onClick={() => { setEditName(true); setNewName(profile?.full_name || ''); }}>
            <div className="settings-item-label">Display Name</div>
            <div className="settings-item-value">{profile?.full_name}</div>
            <ChevronRight size={16} color="var(--color-text-muted)" />
          </div>
          {editName && (
            <div style={{ padding: '12px 20px', background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)' }}>
              <input type="text" className="input" value={newName} onChange={e => setNewName(e.target.value)} maxLength={60} autoFocus style={{ width: '100%', marginBottom: 10 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" style={{ fontSize: '0.8125rem', padding: '7px 16px' }} onClick={saveDisplayName} disabled={saving}>Save</button>
                <button className="btn btn-secondary" style={{ fontSize: '0.8125rem', padding: '7px 16px' }} onClick={() => setEditName(false)}>Cancel</button>
              </div>
            </div>
          )}

          {/* Username */}
          <div className="settings-item" onClick={() => canChangeUsername && setEditUsername(true)}>
            <div className="settings-item-label">Username</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="settings-item-value">@{profile?.username}</div>
              {!canChangeUsername && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertTriangle size={12} color="var(--color-warning)" />
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-warning)' }}>{cooldownDays}d cooldown</span>
                </div>
              )}
            </div>
            {canChangeUsername && <ChevronRight size={16} color="var(--color-text-muted)" />}
          </div>
          {editUsername && canChangeUsername && (
            <div style={{ padding: '12px 20px', background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)' }}>
              <input type="text" className="input" value={newUsername} onChange={e => setNewUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} maxLength={20} autoFocus style={{ width: '100%', marginBottom: 4 }} />
              <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginBottom: 10 }}>After saving, you must wait 5 days to change again</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary" style={{ fontSize: '0.8125rem', padding: '7px 16px' }} onClick={saveUsername} disabled={saving}>Save</button>
                <button className="btn btn-secondary" style={{ fontSize: '0.8125rem', padding: '7px 16px' }} onClick={() => setEditUsername(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        {/* Appearance */}
        <div className="settings-section">
          <div className="settings-section-title">Appearance</div>

          {/* Theme Mode */}
          <div className="settings-item" style={{ cursor: 'default' }}>
            <div className="settings-item-label"><Moon size={15} style={{ marginRight: 6, display: 'inline' }} />Theme</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { key: 'dark',   icon: <Moon size={14} />,    label: 'Dark' },
                { key: 'light',  icon: <Sun size={14} />,     label: 'Light' },
                { key: 'system', icon: <Monitor size={14} />, label: 'Auto' },
              ].map(t => (
                <button key={t.key}
                  className={`btn ${currentTheme === t.key ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '5px 10px', fontSize: '0.75rem', gap: 4 }}
                  onClick={() => updatePreference('mode', t.key)}>
                  {t.icon}{t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Accent Color */}
          <div className="settings-item" style={{ cursor: 'default' }}>
            <div className="settings-item-label"><Palette size={15} style={{ marginRight: 6, display: 'inline' }} />Accent Color</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {ACCENT_COLORS.map(color => (
                <button
                  key={color.key}
                  title={color.name}
                  onClick={() => updatePreference('theme_color', color.key)}
                  style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: color.value, border: 'none', cursor: 'pointer',
                    boxShadow: profile?.ui_preferences?.theme_color === color.key
                      ? `0 0 0 2px var(--color-bg), 0 0 0 4px ${color.value}`
                      : 'none',
                    transition: 'box-shadow 0.2s',
                    transform: profile?.ui_preferences?.theme_color === color.key ? 'scale(1.15)' : 'scale(1)',
                  }}
                />
              ))}
            </div>
          </div>

          {/* Font Size */}
          <div className="settings-item" style={{ cursor: 'default' }}>
            <div className="settings-item-label"><Type size={15} style={{ marginRight: 6, display: 'inline' }} />Font Size</div>
            <div style={{ display: 'flex', backgroundColor: 'var(--color-bg-input)', borderRadius: 'var(--radius-md)', padding: 4 }}>
              {(['small', 'medium', 'large'] as const).map(size => (
                <button key={size}
                  onClick={() => updatePreference('font_size', size)}
                  style={{
                    flex: 1, padding: '6px 8px', fontSize: size === 'small' ? '0.7rem' : size === 'large' ? '0.9rem' : '0.8rem',
                    fontWeight: 600, borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                    background: currentFontSize === size ? 'var(--color-primary)' : 'transparent',
                    color: currentFontSize === size ? '#fff' : 'var(--color-text-secondary)',
                    transition: 'all 0.2s', textTransform: 'capitalize',
                  }}>
                  {size}
                </button>
              ))}
            </div>
          </div>

          {/* Bubble Style */}
          <div className="settings-item" style={{ cursor: 'default' }}>
            <div className="settings-item-label">Bubble Style</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['rounded', 'classic', 'compact'] as const).map(s => (
                <button key={s}
                  className={`btn ${profile?.ui_preferences?.bubble_style === s ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '5px 10px', fontSize: '0.75rem', textTransform: 'capitalize' }}
                  onClick={() => updatePreference('bubble_style', s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Chat Background */}
          <div className="settings-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
            <div className="settings-item-label">Chat Background</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {CHAT_BG_PRESETS.map(preset => (
                <button
                  key={preset.label}
                  title={preset.label}
                  onClick={() => updatePreference('chat_bg', preset.value)}
                  style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: preset.value || 'var(--color-bg)',
                    border: `2px solid ${currentBg === preset.value ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    cursor: 'pointer', transition: 'all 0.2s',
                    position: 'relative', overflow: 'hidden',
                  }}>
                  {!preset.value && (
                    <span style={{ fontSize: '0.55rem', color: 'var(--color-text-muted)', position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>Off</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Notifications */}
        <div className="settings-section">
          <div className="settings-section-title">Notifications</div>
          <div className="settings-item" onClick={() => updatePreference('notification_sound', !notifSound)} style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Bell size={16} color="var(--color-text-muted)" />
              <div className="settings-item-label">Notification Sounds</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="settings-item-value">{notifSound ? 'On' : 'Off'}</span>
              <label className="toggle">
                <input type="checkbox" checked={notifSound} readOnly />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        </div>

        {/* Privacy */}
        <div className="settings-section">
          <div className="settings-section-title">Privacy</div>
          <div className="settings-item" onClick={togglePrivacy} style={{ cursor: 'pointer' }}>
            <div className="settings-item-label">Profile Visibility</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="settings-item-value" style={{ textTransform: 'capitalize' }}>{profile?.privacy_mode}</span>
              <label className="toggle">
                <input type="checkbox" checked={profile?.privacy_mode === 'public'} readOnly />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          <div className="settings-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '16px 20px' }}>
            <div className="settings-item-label">Who can call you</div>
            <div style={{ display: 'flex', backgroundColor: 'var(--color-bg-input)', borderRadius: 'var(--radius-md)', padding: 4, width: '100%' }}>
              {[
                { key: 'everyone', label: 'Everyone' },
                { key: 'contacts', label: 'My Chats' },
                { key: 'nobody',   label: 'Nobody' },
              ].map(opt => (
                <button key={opt.key} onClick={() => updatePreference('call_privacy', opt.key)}
                  style={{
                    flex: 1, padding: '8px 4px', fontSize: '0.75rem', fontWeight: 600,
                    borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                    background: (profile?.ui_preferences?.call_privacy || 'everyone') === opt.key ? 'var(--color-primary)' : 'transparent',
                    color: (profile?.ui_preferences?.call_privacy || 'everyone') === opt.key ? '#fff' : 'var(--color-text-secondary)',
                    transition: 'all 0.2s',
                  }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Help */}
        <div className="settings-section">
          <div className="settings-section-title">Support</div>
          <div className="settings-item" onClick={() => navigate('/help')} style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <HelpCircle size={16} color="var(--color-text-muted)" />
              <div className="settings-item-label">Help & Support</div>
            </div>
            <ChevronRight size={16} color="var(--color-text-muted)" />
          </div>
        </div>

        {/* Account */}
        <div className="settings-section">
          <div className="settings-section-title">Account</div>
          <div className="settings-item" style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', cursor: 'default' }}>
            <div>
              <div style={{ fontWeight: 600, color: 'var(--color-text)', marginBottom: 2 }}>Email</div>
              <div>{profile?.email}</div>
            </div>
          </div>
          <div className="settings-item" onClick={handleSignOut} style={{ color: 'var(--color-error)' }}>
            <LogOut size={18} />
            <div className="settings-item-label" style={{ color: 'var(--color-error)' }}>Sign Out</div>
          </div>
        </div>
      </div>
    </div>
  );
}
