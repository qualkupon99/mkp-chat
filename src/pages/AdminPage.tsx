import { useState, useEffect, useCallback } from 'react';
import {
  Users, MessageSquare, Radio, Shield,
  RefreshCw, Trash2, UserX, UserCheck, X, Check,
  UserPlus, Loader2, AlertCircle, ArrowLeft, Search,
  HelpCircle, Send, CheckCircle
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { format, formatDistanceToNow } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

type AdminUser = {
  id: string; full_name: string; username: string; email: string;
  created_at: string; last_seen_at: string | null;
  privacy_mode: string; is_suspended: boolean; is_admin?: boolean;
};

type AdminStatus = {
  id: string; user_id: string; content: string; visibility: string;
  created_at: string; expires_at: string; username?: string;
};

type HelpTicket = {
  id: string;
  user_id: string | null;
  guest_id: string | null;
  subject: string;
  status: string;
  created_at: string;
  updated_at: string;
  username: string;
  full_name: string;
  email: string;
};

type HelpMessageRow = {
  id: string; ticket_id: string; sender_role: 'user' | 'admin';
  content: string | null; media_url: string | null; created_at: string;
};

type Analytics = {
  totalUsers: number; activeUsers: number; totalMessages: number;
  activeStatuses: number; randomChatsToday: number; openTickets: number;
};

const MASTER_ADMIN_EMAIL = 'dragonartserpent@gmail.com';

export default function AdminPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'analytics' | 'users' | 'statuses' | 'create' | 'tickets'>('analytics');

  const [analytics, setAnalytics] = useState<Analytics>({ totalUsers: 0, activeUsers: 0, totalMessages: 0, activeStatuses: 0, randomChatsToday: 0, openTickets: 0 });
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [statuses, setStatuses] = useState<AdminStatus[]>([]);
  const [tickets, setTickets] = useState<HelpTicket[]>([]);
  const [selectedTicket, setSelectedTicket] = useState<HelpTicket | null>(null);
  const [ticketMessages, setTicketMessages] = useState<HelpMessageRow[]>([]);
  const [adminReply, setAdminReply] = useState('');
  const [loading, setLoading] = useState(false);
  const [userSearch, setUserSearch] = useState('');

  const [userPage, setUserPage] = useState(0);
  const PAGE_SIZE = 20;

  const [createForm, setCreateForm] = useState({ email: '', password: '', fullName: '', username: '', isAdmin: false });
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState(false);

  // Guard: Only admins can see this page
  const isAdmin = profile?.email === MASTER_ADMIN_EMAIL || profile?.is_admin;
  if (!isAdmin) {
    return (
      <div className="empty-state">
        <Shield size={48} color="#ef4444" />
        <h2 className="empty-state-title">Access Denied</h2>
        <p className="empty-state-desc">You do not have administrative privileges.</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>Return Home</button>
      </div>
    );
  }

  const loadAnalytics = useCallback(async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const now = new Date().toISOString();

    const [
      { count: totalUsers },
      { count: activeUsers },
      { count: totalMessages },
      { count: activeStatuses },
      { count: randomChatsToday },
      { count: openTickets },
    ] = await Promise.all([
      supabase.from('profiles').select('id', { count: 'exact', head: true }),
      supabase.from('profiles').select('id', { count: 'exact', head: true }).gt('last_seen_at', sevenDaysAgo),
      supabase.from('messages').select('id', { count: 'exact', head: true }).gt('created_at', twentyFourHoursAgo),
      supabase.from('statuses').select('id', { count: 'exact', head: true }).gt('expires_at', now),
      supabase.from('chats').select('id', { count: 'exact', head: true }).eq('type', 'random').gt('created_at', todayStart.toISOString()),
      supabase.from('help_tickets').select('id', { count: 'exact', head: true }).neq('status', 'resolved'),
    ]);

    setAnalytics({
      totalUsers: totalUsers || 0, activeUsers: activeUsers || 0,
      totalMessages: totalMessages || 0, activeStatuses: activeStatuses || 0,
      randomChatsToday: randomChatsToday || 0, openTickets: openTickets || 0,
    });
  }, []);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    let query = supabase.from('profiles').select('*').order('created_at', { ascending: false });
    if (userSearch.trim()) {
      query = query.or(`username.ilike.%${userSearch}%,full_name.ilike.%${userSearch}%,email.ilike.%${userSearch}%`);
    } else {
      query = query.range(userPage * PAGE_SIZE, (userPage + 1) * PAGE_SIZE - 1);
    }
    const { data } = await query;
    setUsers((data as AdminUser[]) || []);
    setLoading(false);
  }, [userPage, userSearch]);

  const loadStatuses = useCallback(async () => {
    setLoading(true);
    const now = new Date().toISOString();
    // Fix: single JOIN query instead of N+1 fetches
    const { data: statusData } = await supabase
      .from('statuses')
      .select('*, profiles!inner(username)')
      .gt('expires_at', now)
      .order('created_at', { ascending: false });

    if (!statusData) { setLoading(false); return; }
    const enriched = statusData.map((s: any) => ({ ...s, username: s.profiles?.username || 'unknown' }));
    setStatuses(enriched as AdminStatus[]);
    setLoading(false);
  }, []);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    // Use the RPC we created that joins profiles
    const { data, error } = await supabase.rpc('admin_get_all_tickets');
    if (error) {
      console.error('FRONTEND DEBUG - loadTickets error:', error);
    }
    console.log('FRONTEND DEBUG - loaded tickets:', data);
    setTickets((data as HelpTicket[]) || []);
    setLoading(false);
  }, []);

  const loadTicketMessages = async (ticketId: string) => {
    const { data } = await supabase.from('help_messages')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true });
    setTicketMessages((data as HelpMessageRow[]) || []);
  };

  useEffect(() => {
    loadAnalytics();
    if (tab === 'users') loadUsers();
    if (tab === 'statuses') loadStatuses();
    if (tab === 'tickets') loadTickets();
  }, [tab, loadUsers, loadStatuses, loadAnalytics, loadTickets]);

  // Search debounce
  useEffect(() => {
    if (tab !== 'users') return;
    const t = setTimeout(() => loadUsers(), 400);
    return () => clearTimeout(t);
  }, [userSearch, loadUsers, tab]);

  // Realtime for global new tickets
  useEffect(() => {
    if (!isAdmin) return;
    const globalSub = supabase.channel('global-tickets-admin')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'help_tickets' }, () => {
        // When a new ticket appears and we are an admin, reload tickets and maybe analytics
        loadTickets();
        loadAnalytics();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'help_tickets' }, () => {
        loadTickets();
        loadAnalytics();
      })
      .subscribe();
      
    return () => { globalSub.unsubscribe(); };
  }, [isAdmin, loadTickets, loadAnalytics]);

  // Realtime for tickets tab
  useEffect(() => {
    if (tab !== 'tickets' || !selectedTicket) return;
    const sub = supabase.channel(`admin-ticket-${selectedTicket.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'help_messages', filter: `ticket_id=eq.${selectedTicket.id}` },
        (payload) => setTicketMessages(prev => [...prev, payload.new as HelpMessageRow]))
      .subscribe();
    return () => { sub.unsubscribe(); };
  }, [selectedTicket?.id, tab]);

  const sendAdminReply = async () => {
    if (!adminReply.trim() || !selectedTicket || !profile) return;
    await supabase.from('help_messages').insert({
      ticket_id: selectedTicket.id,
      sender_role: 'admin',
      sender_id: profile.id,
      content: adminReply.trim(),
    });
    setAdminReply('');
  };

  const resolveTicket = async (ticketId: string) => {
    await supabase.from('help_tickets').update({ status: 'resolved', updated_at: new Date().toISOString() }).eq('id', ticketId);
    // Send auto-message
    await supabase.from('help_messages').insert({
      ticket_id: ticketId,
      sender_role: 'admin',
      sender_id: profile?.id,
      content: '✅ Your issue has been resolved! If you have more questions, feel free to open a new support ticket.',
    });
    loadTickets();
    setSelectedTicket(null);
    setTicketMessages([]);
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateLoading(true);
    setCreateError(null);
    setCreateSuccess(false);

    try {
      // Get session
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError || !session?.access_token) {
        throw new Error('Your session has expired or is invalid. Please refresh the page or log out and log back in.');
      }

      console.log('FRONTEND DEBUG - Sending create user request');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-create-user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          email: createForm.email,
          password: createForm.password,
          full_name: createForm.fullName,
          username: createForm.username.toLowerCase().replace(/\s/g, ''),
          is_admin: createForm.isAdmin,
        }),
      });

      let result;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        result = await res.json();
      } else {
        const text = await res.text();
        console.error('FRONTEND DEBUG - Non-JSON response:', text);
        if (res.status === 401) throw new Error('Unauthorized (401). Your login session may be invalid. Please refresh.');
        throw new Error(`Server returned ${res.status}: ${text || 'Unknown error'}`);
      }

      if (!res.ok || !result.success) {
        throw new Error(result.error || `Failed with status ${res.status}`);
      }

      setCreateSuccess(true);
      setCreateForm({ email: '', password: '', fullName: '', username: '', isAdmin: false });
      loadAnalytics();
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create user');
    } finally {
      setCreateLoading(false);
    }
  };

  const suspendUser = async (u: AdminUser) => {
    const { error } = await supabase.from('profiles').update({ is_suspended: !u.is_suspended }).eq('id', u.id);
    if (!error) loadUsers();
  };

  const deleteUser = async (userId: string) => {
    if (!confirm('Permanently delete this user? This removes all their data.')) return;
    // Call edge function to also delete from auth.users
    const { data: { session } } = await supabase.auth.getSession();
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-delete-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ user_id: userId }),
    });
    loadUsers();
  };

  const statusColor = (s: string) => s === 'resolved' ? '#22c55e' : s === 'in_progress' ? '#f59e0b' : '#38bdf8';

  return (
    <div className="admin-page animate-fade-in" style={{ height: '100dvh', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)' }}>
      {/* Header */}
      <div className="admin-header" style={{ flexShrink: 0, background: 'var(--color-bg-elevated)', padding: '12px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/')}><ArrowLeft size={18} /></button>
        <Shield size={20} color="var(--color-primary)" />
        <div style={{ fontWeight: 700, fontSize: '1rem' }}>MKP Admin Center</div>
        <div style={{ marginLeft: 'auto' }}>
          <button className="btn btn-ghost btn-icon" onClick={() => loadAnalytics()}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, overflowX: 'auto', paddingBottom: 8, scrollbarWidth: 'none' }}>
          {[
            { id: 'analytics', label: 'Analytics',    icon: <MessageSquare size={16} /> },
            { id: 'users',     label: 'Users',         icon: <Users size={16} /> },
            { id: 'statuses',  label: 'Statuses',      icon: <Radio size={16} /> },
            { id: 'tickets',   label: `Support${analytics.openTickets > 0 ? ` (${analytics.openTickets})` : ''}`, icon: <HelpCircle size={16} /> },
            { id: 'create',    label: 'Create User',   icon: <UserPlus size={16} /> },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id as any)}
              className={`btn ${tab === t.id ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '8px 16px', borderRadius: 20, whiteSpace: 'nowrap' }}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* ── ANALYTICS ─────────────────────────────────────────────────────── */}
        {tab === 'analytics' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
            {[
              { label: 'Total Users',    value: analytics.totalUsers,       color: 'var(--color-primary)' },
              { label: 'Active (7d)',    value: analytics.activeUsers,       color: '#10b981' },
              { label: 'Messages (24h)', value: analytics.totalMessages,     color: '#f59e0b' },
              { label: 'Active Status',  value: analytics.activeStatuses,    color: '#ec4899' },
              { label: 'Random Chats',   value: analytics.randomChatsToday,  color: '#8b5cf6' },
              { label: 'Open Tickets',   value: analytics.openTickets,       color: '#ef4444' },
            ].map(card => (
              <div key={card.label} className="card" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{card.label}</div>
                <div style={{ fontSize: '1.75rem', fontWeight: 800, color: card.color }}>{card.value.toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}

        {/* ── USERS ─────────────────────────────────────────────────────────── */}
        {tab === 'users' && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {/* Search bar */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)' }}>
              <div className="input-wrapper">
                <span className="search-icon"><Search size={16} /></span>
                <input type="text" className="input search-input" placeholder="Search by name, username, email..." value={userSearch} onChange={e => setUserSearch(e.target.value)} style={{ paddingLeft: 40 }} />
                {userSearch && <button style={{ position: 'absolute', right: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)' }} onClick={() => setUserSearch('')}><X size={14} /></button>}
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 600 }}>
                <thead style={{ background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)' }}>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '12px 16px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>PROFILE</th>
                    <th style={{ textAlign: 'left', padding: '12px 16px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>STATUS</th>
                    <th style={{ textAlign: 'left', padding: '12px 16px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>JOINED</th>
                    <th style={{ textAlign: 'right', padding: '12px 16px', fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: 32 }}><div className="loader" /></td></tr>
                  ) : users.map(u => (
                    <tr key={u.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '12px 16px' }}>
                        <div style={{ fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          {u.full_name}
                          {u.is_admin && <span style={{ fontSize: '0.6rem', background: 'var(--color-primary)', color: '#fff', padding: '1px 6px', borderRadius: 10 }}>ADMIN</span>}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>@{u.username} · {u.email}</div>
                      </td>
                      <td style={{ padding: '12px 16px' }}>
                        <span className={`badge ${u.is_suspended ? 'badge-danger' : 'badge-success'}`} style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
                          {u.is_suspended ? 'Suspended' : 'Active'}
                        </span>
                        {u.last_seen_at && (
                          <div style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)', marginTop: 2 }}>
                            {formatDistanceToNow(new Date(u.last_seen_at), { addSuffix: true })}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '12px 16px', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                        {format(new Date(u.created_at), 'MMM d, yyyy')}
                      </td>
                      <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost btn-icon" onClick={async () => { await supabase.from('profiles').update({ is_admin: !u.is_admin }).eq('id', u.id); loadUsers(); }} title={u.is_admin ? 'Demote Admin' : 'Promote to Admin'}>
                            <Shield size={16} color={u.is_admin ? 'var(--color-primary)' : 'var(--color-text-muted)'} />
                          </button>
                          <button className="btn btn-ghost btn-icon" onClick={() => suspendUser(u)} title={u.is_suspended ? 'Unsuspend' : 'Suspend'}>
                            {u.is_suspended ? <UserCheck size={16} color="#10b981" /> : <UserX size={16} color="#ef4444" />}
                          </button>
                          <button className="btn btn-ghost btn-icon" onClick={() => deleteUser(u.id)} style={{ color: '#ef4444' }}><Trash2 size={16} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!loading && users.length === 0 && (
                    <tr><td colSpan={4} style={{ textAlign: 'center', padding: 32, color: 'var(--color-text-muted)' }}>No users found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {!userSearch && (
              <div style={{ padding: 12, borderTop: '1px solid var(--color-border)', display: 'flex', justifyContent: 'center', gap: 12 }}>
                <button disabled={userPage === 0} onClick={() => setUserPage(p => p - 1)} className="btn btn-secondary btn-sm">Previous</button>
                <div style={{ display: 'flex', alignItems: 'center', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>Page {userPage + 1}</div>
                <button disabled={users.length < PAGE_SIZE} onClick={() => setUserPage(p => p + 1)} className="btn btn-secondary btn-sm">Next</button>
              </div>
            )}
          </div>
        )}

        {/* ── STATUSES ──────────────────────────────────────────────────────── */}
        {tab === 'statuses' && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ background: 'var(--color-surface-2)' }}>
                <tr>
                  <th style={{ textAlign: 'left', padding: 12, fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>USER</th>
                  <th style={{ textAlign: 'left', padding: 12, fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>CONTENT</th>
                  <th style={{ textAlign: 'right', padding: 12, fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {statuses.map(s => (
                  <tr key={s.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: 12, fontWeight: 600 }}>@{s.username}</td>
                    <td style={{ padding: 12, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.875rem' }}>{s.content}</td>
                    <td style={{ padding: 12, textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-icon" style={{ color: '#ef4444' }} onClick={async () => { await supabase.from('statuses').delete().eq('id', s.id); loadStatuses(); }}>
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
                {statuses.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-muted)' }}>No active statuses to moderate</td></tr>}
              </tbody>
            </table>
          </div>
        )}

        {/* ── HELP TICKETS ──────────────────────────────────────────────────── */}
        {tab === 'tickets' && (
          <div style={{ display: 'grid', gridTemplateColumns: selectedTicket ? '1fr 1fr' : '1fr', gap: 16 }}>
            {/* Tickets list */}
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', fontWeight: 700, fontSize: '0.875rem' }}>
                Help Tickets
              </div>
              {loading ? (
                <div style={{ textAlign: 'center', padding: 32 }}><div className="loader" /></div>
              ) : tickets.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-muted)' }}>No tickets yet 🎉</div>
              ) : tickets.map(t => (
                <div key={t.id}
                  onClick={() => { setSelectedTicket(t); loadTicketMessages(t.id); }}
                  style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', cursor: 'pointer', background: selectedTicket?.id === t.id ? 'var(--color-surface-2)' : 'transparent', transition: 'background 0.15s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: '0.875rem', flex: 1 }}>{t.subject}</span>
                    <span style={{ fontSize: '0.7rem', fontWeight: 700, color: statusColor(t.status), textTransform: 'uppercase' }}>{t.status.replace('_', ' ')}</span>
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                    {t.guest_id ? 'Guest User' : `@${t.username}`} · {formatDistanceToNow(new Date(t.created_at), { addSuffix: true })}
                  </div>
                </div>
              ))}
            </div>

            {/* Ticket chat panel */}
            {selectedTicket && (
              <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: '60vh' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: '0.875rem' }}>{selectedTicket.subject}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                      {selectedTicket.guest_id ? 'Guest User' : `@${selectedTicket.username} · ${selectedTicket.email}`}
                    </div>
                  </div>
                  {selectedTicket.status !== 'resolved' && (
                    <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '5px 12px', color: '#22c55e', borderColor: '#22c55e' }} onClick={() => resolveTicket(selectedTicket.id)}>
                      <CheckCircle size={14} /> Resolve
                    </button>
                  )}
                  <button className="btn btn-ghost btn-icon" onClick={() => setSelectedTicket(null)}><X size={16} /></button>
                </div>

                {/* Messages */}
                <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ticketMessages.map(msg => (
                    <div key={msg.id} style={{ display: 'flex', justifyContent: msg.sender_role === 'admin' ? 'flex-end' : 'flex-start' }}>
                      <div style={{
                        maxWidth: '75%', padding: '8px 12px', borderRadius: 12, fontSize: '0.875rem',
                        background: msg.sender_role === 'admin' ? 'var(--color-primary)' : 'var(--color-surface-2)',
                        color: msg.sender_role === 'admin' ? '#fff' : 'var(--color-text)',
                      }}>
                        {msg.media_url && <img src={msg.media_url} alt="Screenshot" style={{ maxWidth: '100%', borderRadius: 8, marginBottom: 4 }} />}
                        {msg.content && <div>{msg.content}</div>}
                        <div style={{ fontSize: '0.65rem', opacity: 0.7, marginTop: 4 }}>{format(new Date(msg.created_at), 'HH:mm')}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Admin reply input */}
                {selectedTicket.status !== 'resolved' && (
                  <div style={{ padding: 12, borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8 }}>
                    <input className="input" style={{ flex: 1 }} placeholder="Type your reply..." value={adminReply} onChange={e => setAdminReply(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') sendAdminReply(); }} />
                    <button className="btn btn-primary" onClick={sendAdminReply} disabled={!adminReply.trim()}><Send size={16} /></button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── CREATE USER ───────────────────────────────────────────────────── */}
        {tab === 'create' && (
          <div className="animate-slide-up" style={{ maxWidth: 500, margin: '0 auto' }}>
            <div className="card" style={{ padding: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
                <div style={{ width: 40, height: 40, background: 'var(--color-primary-subtle)', color: 'var(--color-primary)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <UserPlus size={20} />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.25rem', marginBottom: 2 }}>Create User Account</h3>
                  <p style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>Creates a fully verified account via Edge Function</p>
                </div>
              </div>

              <form onSubmit={handleCreateUser} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="form-group">
                  <label className="label">Full Name</label>
                  <input className="input" placeholder="e.g. John Doe" value={createForm.fullName} onChange={e => setCreateForm(f => ({ ...f, fullName: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="label">Username</label>
                  <input className="input" placeholder="e.g. john_doe" value={createForm.username} onChange={e => setCreateForm(f => ({ ...f, username: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="label">Email Address</label>
                  <input className="input" type="email" placeholder="john@example.com" value={createForm.email} onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label className="label">Password</label>
                  <input className="input" type="password" placeholder="Min 6 characters" value={createForm.password} onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))} required minLength={6} />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'var(--color-surface-2)', borderRadius: 12, border: '1px solid var(--color-border)', cursor: 'pointer' }}
                  onClick={() => setCreateForm(f => ({ ...f, isAdmin: !f.isAdmin }))}>
                  <div style={{ width: 20, height: 20, borderRadius: 6, border: '2px solid var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', background: createForm.isAdmin ? 'var(--color-primary)' : 'transparent', transition: 'all 0.2s', flexShrink: 0 }}>
                    {createForm.isAdmin && <Check size={14} color="white" />}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>Authorize as Admin</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)' }}>This user will have full access to management features</div>
                  </div>
                </div>

                {createError && <div className="error-box"><AlertCircle size={16} /> {createError}</div>}
                {createSuccess && <div style={{ color: '#10b981', background: 'rgba(16,185,129,0.1)', padding: 12, borderRadius: 8, fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: 8 }}><Check size={16} /> User created successfully!</div>}

                <button className="btn btn-primary btn-lg" style={{ marginTop: 8 }} disabled={createLoading}>
                  {createLoading ? <Loader2 className="animate-spin" size={18} /> : 'Create Account'}
                </button>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
