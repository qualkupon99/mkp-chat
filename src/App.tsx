import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { ActiveChatProvider } from './context/ActiveChatContext';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AdminPage from './pages/AdminPage';
import UsernamePage from './pages/UsernamePage';
import OnboardingPage from './pages/OnboardingPage';
import ChatsListPage from './pages/ChatsListPage';
import ConversationPage from './pages/ConversationPage';
import StatusPage from './pages/StatusPage';
import RandomChatPage from './pages/RandomChatPage';
import SettingsPage from './pages/SettingsPage';
import AdminDashboard from './pages/AdminDashboard';
import GroupConversationPage from './pages/GroupConversationPage';
import HelpBotPage from './pages/HelpBotPage';

/** Loading spinner shared by route guards */
function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <div style={{
          width: 52, height: 52,
          background: 'linear-gradient(135deg, #38BDF8, #0EA5E9)',
          borderRadius: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 24px rgba(56,189,248,0.4)'
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
            <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
          </svg>
        </div>
        <div className="loader" />
        <span style={{ color: '#94A3B8', fontSize: '0.875rem' }}>Loading MKP Chat...</span>
      </div>
    </div>
  );
}

/**
 * AuthOnlyRoute — requires login, but does NOT check profile completeness.
 * Used for the onboarding page so it doesn't redirect back to itself.
 */
function AuthOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * ProtectedRoute — requires login AND a complete profile.
 * Redirects to /onboarding if the profile is missing full_name or username.
 */
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, profile, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;

  // Gate: new users must complete onboarding before accessing the app.
  // profile === null means it hasn't been fetched yet OR doesn't exist.
  // Once profile loads, check for required fields.
  if (profile && (!profile.full_name || !profile.username)) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}

const MASTER_ADMIN_EMAIL = 'dragonartserpent@gmail.com';

function AdminProtectedRoute({ children }: { children: React.ReactNode }) {
  const { profile, loading } = useAuth();

  if (loading) return null;

  if (profile?.email !== MASTER_ADMIN_EMAIL && !profile?.is_admin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function App() {
  const { profile } = useAuth();

  // ── Theme mode (dark / light / system) ───────────────────────────────────
  React.useEffect(() => {
    const mode = profile?.ui_preferences?.mode || 'dark';
    if (mode === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else if (mode === 'dark') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (!prefersDark) document.documentElement.setAttribute('data-theme', 'light');
      else document.documentElement.removeAttribute('data-theme');
    }
  }, [profile?.ui_preferences?.mode]);

  // ── Accent color → --color-primary CSS variable ───────────────────────────
  React.useEffect(() => {
    const colorMap: Record<string, string> = {
      sky:    '#38BDF8',
      purple: '#A855F7',
      green:  '#22C55E',
      orange: '#F97316',
      pink:   '#EC4899',
      red:    '#EF4444',
    };
    const key = (profile?.ui_preferences?.theme_color as string) ?? 'sky';
    const accent = colorMap[key] ?? '#38BDF8';
    document.documentElement.style.setProperty('--color-primary', accent);

    // Derive rgb subtle variant for hover/backgrounds
    const hex = accent.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    document.documentElement.style.setProperty(
      '--color-primary-subtle',
      `rgba(${r},${g},${b},0.12)`
    );
    document.documentElement.style.setProperty(
      '--color-primary-glow',
      `rgba(${r},${g},${b},0.4)`
    );
  }, [profile?.ui_preferences?.theme_color]);

  // ── Font size → --font-size-base CSS variable ─────────────────────────────
  React.useEffect(() => {
    const sizeMap: Record<string, string> = {
      small:  '13px',
      medium: '15px',
      large:  '17px',
    };
    const prefs = profile?.ui_preferences as Record<string, string> | undefined;
    const size = sizeMap[prefs?.font_size ?? 'medium'] ?? '15px';
    document.documentElement.style.setProperty('--font-size-base', size);
  }, [(profile?.ui_preferences as Record<string, string> | undefined)?.font_size]);

  // ── Chat background ────────────────────────────────────────────────────────
  React.useEffect(() => {
    const prefs = profile?.ui_preferences as Record<string, string> | undefined;
    const bg = prefs?.chat_bg;
    if (bg) {
      document.documentElement.style.setProperty('--chat-bg', bg);
    } else {
      document.documentElement.style.removeProperty('--chat-bg');
    }
  }, [(profile?.ui_preferences as Record<string, string> | undefined)?.chat_bg]);

  return (
    <ActiveChatProvider>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          {/* Onboarding — uses AuthOnlyRoute (NOT ProtectedRoute!) to avoid infinite redirect */}
          <Route path="/onboarding" element={
            <AuthOnlyRoute><OnboardingPage /></AuthOnlyRoute>
          } />
          {/* Legacy username-only route */}
          <Route path="/register/username" element={
            <AuthOnlyRoute><UsernamePage /></AuthOnlyRoute>
          } />

          {/* Backwards compat */}
          <Route path="/1234/admin" element={<AdminProtectedRoute><AdminDashboard /></AdminProtectedRoute>} />
          
          {/* Public help/support route */}
          <Route path="/help" element={<HelpBotPage />} />

          {/* Protected app routes */}
          <Route path="/" element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }>
            <Route index element={<ChatsListPage />} />
            <Route path="chat/:partnerId" element={<ConversationPage />} />
            <Route path="group/:groupId" element={<GroupConversationPage />} />
            <Route path="status" element={<StatusPage />} />
            <Route path="random-chat" element={<RandomChatPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="admin" element={<AdminProtectedRoute><AdminPage /></AdminProtectedRoute>} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ActiveChatProvider>
  );
}

export default App;
