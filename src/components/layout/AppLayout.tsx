import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { MessageSquare, Radio, Settings, LogOut, Shuffle, Shield, HelpCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import CallOverlay from '../CallOverlay';
import GroupCallOverlay from '../GroupCallOverlay';

export default function AppLayout() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const isChatPage = location.pathname.startsWith('/chat/');

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  const avatarInitials = profile?.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : '?';

  const navItems = [
    { to: '/', label: 'Chats', icon: <MessageSquare size={20} />, end: true },
    { to: '/status', label: 'Status', icon: <Radio size={20} /> },
    { to: '/random-chat', label: 'Random', icon: <Shuffle size={20} /> },
    { to: '/settings', label: 'Settings', icon: <Settings size={20} /> },
    { to: '/help', label: 'Support', icon: <HelpCircle size={20} /> },
  ];

  if (profile?.email === 'dragonartserpent@gmail.com' || profile?.is_admin) {
    navItems.push({ to: '/admin', label: 'Admin', icon: <Shield size={20} /> });
  }

  return (
    <div className="app-container">
      {/* Desktop Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="sidebar-logo-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
            </div>
            MKP Chat
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `sidebar-nav-item${isActive ? ' active' : ''}`}
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-content">
          {/* Sidebar chat list is shown in ChatsListPage */}
        </div>

        <div style={{ padding: '8px' }}>
          <div className="sidebar-profile" onClick={() => navigate('/settings')}>
            <div className="avatar avatar-sm">
              {profile?.avatar_url
                ? <img src={profile.avatar_url} alt={profile.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                : avatarInitials
              }
            </div>
            <div className="sidebar-profile-info">
              <div className="sidebar-profile-name">{profile?.full_name || 'User'}</div>
              <div className="sidebar-profile-username">@{profile?.username || '...'}</div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); handleSignOut(); }}
              className="btn btn-ghost btn-icon"
              title="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="main-content">
        <Outlet />
      </main>

      {/* Mobile Bottom Nav */}
      <nav className={`bottom-nav ${isChatPage ? 'mobile-hidden' : ''}`}>
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Global Call Overlay */}
      <CallOverlay />
      <GroupCallOverlay />
    </div>
  );
}
