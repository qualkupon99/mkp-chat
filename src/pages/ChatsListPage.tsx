import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Search, Plus, MessageSquare, Shuffle, Trash2, Archive, Lock, Users, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useActiveChat } from '../context/ActiveChatContext';
import { formatDistanceToNow } from 'date-fns';
import { useQuery } from '@tanstack/react-query';

type ChatWithPartner = {
  partnerId: string;
  lastMessage: string;
  lastMessageType: string;
  lastMessageAt: string;
  unreadCount: number;
  partner: Profile & { is_group?: boolean; admin_id?: string };
  isGroup?: boolean;
};

type ChatPref = { is_archived: boolean; is_locked: boolean; lock_pin: string | null };

export default function ChatsListPage() {
  const { user, onlineUserIds } = useAuth();
  const { setActivePartner } = useActiveChat();
  const navigate = useNavigate();

  const [chats, setChats] = useState<ChatWithPartner[]>([]);

  const [prefs, setPrefs] = useState<Record<string, ChatPref>>({});
  const [search, setSearch] = useState('');

  const [showFindUser, setShowFindUser] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findResults, setFindResults] = useState<Profile[]>([]);
  const [groupName, setGroupName] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<Profile[]>([]);

  const [contextMenu, setContextMenu] = useState<{ chat: ChatWithPartner; x: number; y: number } | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const [showLockedSection, setShowLockedSection] = useState(false);
  const [unlockedChats, setUnlockedChats] = useState<Set<string>>(new Set());
  const [lockModal, setLockModal] = useState<{ chat: ChatWithPartner; action: 'lock' | 'unlock' | 'access' } | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  // Ref keeps current group IDs accessible inside realtime closures
  // without needing them as a dependency (avoids subscription churn)
  const groupChatIdsRef = useRef<string[]>([]);

  // ── LOAD DATA (Cached with React Query for instant navigation) ────────
  const { data: chatsData, isLoading, refetch } = useQuery({
    queryKey: ['chat-list', user?.id],
    enabled: !!user,
    staleTime: 30_000, // Serve from cache for 30s to make shifting back instant
    refetchOnWindowFocus: false,
    queryFn: async () => {
      if (!user) return [];

      // Run all independent queries in parallel
      const [participantsResult, prefsResult] = await Promise.all([
        supabase.from('chat_participants').select('chat_id').eq('user_id', user.id),
        supabase.from('user_chat_prefs').select('*').eq('user_id', user.id),
      ]);

      const gIds = participantsResult.data?.map((p: any) => p.chat_id) || [];
      groupChatIdsRef.current = gIds; // keep ref in sync

      const groupChatQuery = gIds.length > 0 ? `,chat_id.in.(${gIds.join(',')})` : '';

      // Fetch messages + group details in parallel; LIMIT messages to keep it fast
      const [messagesResult, groupDetailsResult] = await Promise.all([
        supabase
          .from('messages')
          // CRITICAL FIX: Ensure 'status' is fetched so we can accurately check read receipts
          .select('id, sender_id, receiver_id, content, media_type, status, chat_id, created_at, is_read, deleted_for_users')
          .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}${groupChatQuery}`)
          .order('created_at', { ascending: false })
          .limit(100),
        gIds.length > 0
          ? supabase.from('chats').select('*').in('id', gIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const prefsMap: Record<string, ChatPref> = {};
      prefsResult.data?.forEach((p: any) => {
        prefsMap[p.ref_key] = { is_archived: p.is_archived, is_locked: p.is_locked, lock_pin: p.lock_pin };
      });
      setPrefs(prefsMap);

      const messages = messagesResult.data || [];
      const groupDetails = groupDetailsResult.data || [];

      const map = new Map<string, any>();
      messages.forEach((msg: any) => {
        if (msg.deleted_for_users?.includes(user.id)) return;
        const isGroupMsg = gIds.includes(msg.chat_id);
        const pid = isGroupMsg ? msg.chat_id : (msg.sender_id === user.id ? msg.receiver_id : msg.sender_id);
        if (!pid) return;
        if (!map.has(pid)) {
          map.set(pid, {
            is_group: isGroupMsg,
            last_message: msg.content,
            last_message_type: msg.media_type,
            last_message_at: msg.created_at,
            unread_count: (msg.receiver_id === user.id && msg.status !== 'read') ? 1 : 0,
          });
        } else if (msg.receiver_id === user.id && msg.status !== 'read') {
          map.get(pid).unread_count++;
        }
      });

      groupDetails.forEach((g: any) => {
        if (!map.has(g.id))
          map.set(g.id, { is_group: true, last_message: 'Group created', last_message_type: 'text', last_message_at: g.created_at, unread_count: 0 });
      });

      const partnerIds = Array.from(map.keys()).filter(id => !gIds.includes(id) && Boolean(id));
      const { data: profiles } = partnerIds.length > 0
        ? await supabase.from('profiles').select('*').in('id', partnerIds)
        : { data: [] as any[] };

      const enriched: ChatWithPartner[] = Array.from(map.entries()).map(([pId, data]) => {
        let partnerInfo: any;
        if (data.is_group) {
          const g = groupDetails.find((gr: any) => gr.id === pId);
          partnerInfo = { id: pId, full_name: g?.name || 'Unknown Group', username: '', avatar_url: g?.avatar_url || null, is_group: true, admin_id: g?.admin_id };
        } else {
          partnerInfo = profiles?.find((p: any) => p.id === pId);
        }
        return {
          partnerId: pId,
          lastMessage: data.last_message || (data.last_message_type === 'image' ? '📷 Image' : data.last_message_type === 'voice' ? '🎤 Voice note' : ''),
          lastMessageType: data.last_message_type,
          lastMessageAt: data.last_message_at,
          unreadCount: data.unread_count,
          partner: partnerInfo,
          isGroup: data.is_group,
        };
      }).filter((c: any) => c.partner)
        .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

      return enriched;
    }
  });

  // Sync the cached data to local state for fast UI manipulation (realtime updates)
  useEffect(() => {
    if (chatsData) setChats(chatsData);
  }, [chatsData]);

  // useQuery automatically fetches on mount, so no need for an extra useEffect here

  // ── REALTIME – targeted fast updates, no full refetch ──────────────────
  useEffect(() => {
    if (!user) return;
    if (Notification.permission === 'default') Notification.requestPermission();

    const sub = supabase
      .channel('sidebar-updates')
      // New messages addressed to me
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `receiver_id=eq.${user.id}`,
      }, async (payload) => {
        const msg = payload.new as any;
        // The AuthContext 'global-delivery' already handles marking this as delivered.
        // Push notification when app is backgrounded
        if (document.visibilityState !== 'visible') {
          new Notification('New Message', { body: msg.content || 'Sent a media file', icon: '/favicon.ico' });
        }
        
        // Update local state directly instead of refetching everything!
        setChats(prev => {
          const exists = prev.some(c => c.partnerId === msg.sender_id);
          if (!exists) {
            // Only refetch if it's a completely new chat we don't know about
            setTimeout(() => refetch(), 1000);
            return prev;
          }
          return prev.map(c => {
            if (c.partnerId === msg.sender_id) {
              return {
                ...c,
                lastMessage: msg.content || (msg.media_type === 'image' ? '📷 Image' : msg.media_type === 'voice' ? '🎤 Voice note' : ''),
                lastMessageType: msg.media_type,
                lastMessageAt: msg.created_at,
                unreadCount: c.unreadCount + 1,
              };
            }
            return c;
          }).sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
        });
      })
      // Messages I sent (may open a new chat row)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `sender_id=eq.${user.id}`,
      }, (payload) => {
        const msg = payload.new as any;
        setChats(prev => {
          const exists = prev.some(c => c.partnerId === msg.receiver_id || (msg.chat_id && c.partnerId === msg.chat_id));
          if (!exists) {
            setTimeout(() => refetch(), 500);
            return prev;
          }
          return prev.map(c => {
            if (c.partnerId === msg.receiver_id || c.partnerId === msg.chat_id) {
              return {
                ...c,
                lastMessage: msg.content || (msg.media_type === 'image' ? '📷 Image' : msg.media_type === 'voice' ? '🎤 Voice note' : ''),
                lastMessageType: msg.media_type,
                lastMessageAt: msg.created_at,
              };
            }
            return c;
          }).sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
        });
      })
      // Status/read updates — only update the changed chat row in state, no DB refetch
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `receiver_id=eq.${user.id}`,
      }, (payload) => {
        const msg = payload.new as any;
        setChats(prev => prev.map(c => {
          const isMatch = c.partnerId === msg.sender_id || c.partnerId === msg.chat_id;
          if (!isMatch) return c;
          // Decrement unread count when message is marked read
          if (msg.status === 'read' && c.unreadCount > 0) {
            return { ...c, unreadCount: Math.max(0, c.unreadCount - 1) };
          }
          return c;
        }));
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `sender_id=eq.${user.id}`,
      }, (payload) => {
        // A message I sent was deleted globally – update preview text
        const msg = payload.new as any;
        if (msg.is_deleted_globally) {
          setChats(prev => prev.map(c =>
            c.partnerId === msg.receiver_id
              ? { ...c, lastMessage: '🚫 Message deleted' }
              : c
          ));
        }
      })
      .subscribe();

    return () => { sub.unsubscribe(); };
  }, [user, refetch]);

  // ── REALTIME (group messages from OTHER members) ────────────────────────
  // Server-side filters can't match chat_id dynamically, so we use a broad
  // subscription and filter client-side via the ref (no stale closure).
  useEffect(() => {
    if (!user) return;

    const groupSub = supabase
      .channel('sidebar-group-inserts')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      }, (payload) => {
        const msg = payload.new as any;
        // Only care about messages in my groups sent by someone else
        if (
          msg.sender_id !== user.id &&
          msg.receiver_id !== user.id &&
          groupChatIdsRef.current.includes(msg.chat_id)
        ) {
          setChats(prev => prev.map(c => {
            if (c.partnerId === msg.chat_id) {
              return {
                ...c,
                lastMessage: msg.content || (msg.media_type === 'image' ? '📷 Image' : '🎤 Voice note'),
                lastMessageType: msg.media_type,
                lastMessageAt: msg.created_at,
                unreadCount: c.unreadCount + 1,
              };
            }
            return c;
          }).sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()));
        }
      })
      .subscribe();

    return () => { groupSub.unsubscribe(); };
  }, [user, refetch]);


  // ── SEARCH ──────────────────────────────────────────────────────────────
  const searchUsers = useCallback(async (q: string) => {
    if (!q || q.length < 2) { setFindResults([]); return; }
    const { data } = await supabase.from('profiles').select('*').or(`username.ilike.%${q}%,full_name.ilike.%${q}%`).neq('id', user!.id).limit(10);
    setFindResults((data as Profile[]) || []);
  }, [user]);

  useEffect(() => { const t = setTimeout(() => searchUsers(findQuery), 400); return () => clearTimeout(t); }, [findQuery, searchUsers]);

  // ── CHAT ACTIONS ────────────────────────────────────────────────────────
  const setPref = async (refKey: string, updates: Partial<ChatPref>) => {
    if (!user) return;
    const existing = prefs[refKey] || { is_archived: false, is_locked: false, lock_pin: null };
    const merged = { ...existing, ...updates };
    await supabase.from('user_chat_prefs').upsert({ user_id: user.id, ref_key: refKey, ...merged });
    setPrefs(prev => ({ ...prev, [refKey]: merged }));
  };

  const deleteChat = async (chat: ChatWithPartner) => {
    if (!user) return;
    if (chat.isGroup) {
      const isAdmin = chat.partner.admin_id === user.id;
      if (isAdmin) {
        if (!confirm(`Delete group "${chat.partner.full_name}" for everyone?`)) return;
        await supabase.from('chats').delete().eq('id', chat.partnerId);
      } else {
        if (!confirm(`Leave group "${chat.partner.full_name}"?`)) return;
        await supabase.from('chat_participants').delete().eq('chat_id', chat.partnerId).eq('user_id', user.id);
      }
    } else {
      if (!confirm('Delete this chat for you?')) return;
      const { data: msgs } = await supabase.from('messages').select('id, deleted_for_users')
        .or(`and(sender_id.eq.${user.id},receiver_id.eq.${chat.partnerId}),and(sender_id.eq.${chat.partnerId},receiver_id.eq.${user.id})`);
      for (const m of (msgs || [])) {
        await supabase.from('messages').update({ deleted_for_users: [...(m.deleted_for_users || []), user.id] }).eq('id', m.id);
      }
    }
    setContextMenu(null);
    refetch();
  };

  const toggleArchive = async (chat: ChatWithPartner) => {
    const current = prefs[chat.partnerId]?.is_archived ?? false;
    await setPref(chat.partnerId, { is_archived: !current });
    setContextMenu(null);
    refetch();
  };

  const handleLockAction = async () => {
    if (!lockModal || !user) return;
    const { chat, action } = lockModal;
    if (action === 'lock') {
      if (pinInput.length !== 4) { setPinError('PIN must be exactly 4 digits'); return; }
      await setPref(chat.partnerId, { is_locked: true, lock_pin: pinInput });
    } else if (action === 'unlock') {
      if (pinInput !== prefs[chat.partnerId]?.lock_pin) { setPinError('Incorrect PIN'); return; }
      await setPref(chat.partnerId, { is_locked: false, lock_pin: null });
    } else {
      if (pinInput !== prefs[chat.partnerId]?.lock_pin) { setPinError('Incorrect PIN'); return; }
      setUnlockedChats(prev => new Set([...prev, chat.partnerId]));
    }
    setLockModal(null); setPinInput(''); setPinError('');
    refetch();
  };

  const handleChatClick = (chat: ChatWithPartner, e: React.MouseEvent) => {
    if (selectMode) {
      e.preventDefault();
      setSelectedChats(prev => {
        const n = new Set(prev);
        if (n.has(chat.partnerId)) n.delete(chat.partnerId); else n.add(chat.partnerId);
        return n;
      });
      return;
    }
    if (prefs[chat.partnerId]?.is_locked && !unlockedChats.has(chat.partnerId)) {
      e.preventDefault();
      setLockModal({ chat, action: 'access' });
    }
  };

  const bulkDelete = async () => {
    for (const id of selectedChats) { const c = chats.find(ch => ch.partnerId === id); if (c) await deleteChat(c); }
    setSelectedChats(new Set()); setSelectMode(false);
  };

  const bulkArchive = async () => {
    for (const id of selectedChats) { const c = chats.find(ch => ch.partnerId === id); if (c) await toggleArchive(c); }
    setSelectedChats(new Set()); setSelectMode(false);
  };

  // ── GROUP CREATE ────────────────────────────────────────────────────────
  const createGroup = async () => {
    if (!groupName.trim() || selectedUsers.length === 0 || !user) return;
    const { data: newGroup, error } = await supabase.from('chats').insert({
      type: 'personal', is_group: true, active: true, name: groupName.trim(), admin_id: user.id
    }).select().single();
    if (error || !newGroup) { console.error('Group creation error:', error); alert(`Failed: ${error?.message}`); return; }
    await supabase.from('chat_participants').insert([{ chat_id: newGroup.id, user_id: user.id }, ...selectedUsers.map(u => ({ chat_id: newGroup.id, user_id: u.id }))]);
    setShowCreateGroup(false); setGroupName(''); setSelectedUsers([]);
    navigate(`/group/${newGroup.id}`);
  };

  const toggleUserForGroup = (u: Profile) => {
    if (selectedUsers.find(su => su.id === u.id)) setSelectedUsers(prev => prev.filter(su => su.id !== u.id));
    else setSelectedUsers(prev => [...prev, u]);
  };

  const startChat = (partnerId: string) => {
    const u = findResults.find(f => f.id === partnerId);
    if (u) setActivePartner(u);
    setShowFindUser(false);
    navigate(`/chat/${partnerId}`);
  };

  // ── DERIVED LISTS ───────────────────────────────────────────────────────
  const filtered = chats.filter(c => {
    const n = c.partner.full_name?.toLowerCase() || '';
    const u = c.partner.username?.toLowerCase() || '';
    return n.includes(search.toLowerCase()) || u.includes(search.toLowerCase());
  });

  const archivedList = filtered.filter(c => prefs[c.partnerId]?.is_archived);
  const activeList = filtered.filter(c => !prefs[c.partnerId]?.is_archived);
  const visibleList = activeList.filter(c => !prefs[c.partnerId]?.is_locked || unlockedChats.has(c.partnerId));
  const lockedHiddenList = activeList.filter(c => prefs[c.partnerId]?.is_locked && !unlockedChats.has(c.partnerId));

  const initials = (name: string) => name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || '?';
  // Use live Supabase Presence (AuthContext) for accurate online status — not stale DB values
  const isOnline = (partnerId: string) => onlineUserIds.has(partnerId);

  // ── RENDER CHAT ROW ─────────────────────────────────────────────────────
  const renderChatRow = (chat: ChatWithPartner) => {
    const isGroup = chat.isGroup;
    const isLocked = prefs[chat.partnerId]?.is_locked && !unlockedChats.has(chat.partnerId);
    const isSelected = selectedChats.has(chat.partnerId);

    return (
      <div key={chat.partnerId} onContextMenu={e => { e.preventDefault(); setContextMenu({ chat, x: e.clientX, y: e.clientY }); }}>
        <Link
          to={isGroup ? `/group/${chat.partnerId}` : `/chat/${chat.partnerId}`}
          className="chat-list-item"
          style={{ background: isSelected ? 'rgba(56,189,248,0.12)' : undefined }}
          onClick={e => handleChatClick(chat, e)}
        >
          {selectMode && (
            <div style={{ width: 22, height: 22, borderRadius: '50%', border: `2px solid ${isSelected ? 'var(--color-primary)' : 'var(--color-border)'}`, background: isSelected ? 'var(--color-primary)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 8, flexShrink: 0 }}>
              {isSelected && <Check size={12} color="white" />}
            </div>
          )}

          <div className="avatar avatar-md" style={{ position: 'relative', flexShrink: 0, background: isGroup ? 'linear-gradient(135deg, #38BDF8, #818CF8)' : '' }}>
            {chat.partner.avatar_url
              ? <img src={chat.partner.avatar_url} alt={chat.partner.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
              : (isGroup
                  ? <span style={{ color: 'white', fontWeight: 700, fontSize: '0.75rem' }}>{initials(chat.partner.full_name)}</span>
                  : initials(chat.partner.full_name))
            }
            {!isGroup && isOnline(chat.partnerId) && (
              <div style={{ position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, backgroundColor: '#22c55e', borderRadius: '50%', border: '2px solid var(--color-surface)' }} />
            )}
          </div>

          <div className="chat-item-info">
            <div className="chat-item-header">
              <span className="chat-item-name" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {isGroup && <Users size={11} color="var(--color-text-muted)" />}
                {chat.partner.full_name}
                {isLocked && <Lock size={11} color="var(--color-text-muted)" />}
                {prefs[chat.partnerId]?.is_archived && <Archive size={11} color="var(--color-text-muted)" />}
              </span>
              <span className="chat-item-time">
                {chat.lastMessageAt ? formatDistanceToNow(new Date(chat.lastMessageAt), { addSuffix: false }) : ''}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span className="chat-item-preview">{isLocked ? '🔒 Tap to unlock' : (chat.lastMessage || 'No messages yet')}</span>
              {chat.unreadCount > 0 && <span className="badge">{chat.unreadCount}</span>}
            </div>
          </div>
        </Link>
      </div>
    );
  };

  // ── JSX ─────────────────────────────────────────────────────────────────
  return (
    <div className="chat-list-page" onClick={() => contextMenu && setContextMenu(null)}>

      {/* Search */}
      <div className="search-bar">
        <div className="input-wrapper" style={{ borderRadius: 'var(--radius-full)' }}>
          <span className="search-icon"><Search size={16} /></span>
          <input type="text" className="search-input" placeholder="Search chats..." value={search} onChange={e => setSearch(e.target.value)} />
          <button className="btn btn-ghost btn-icon" style={{ position: 'absolute', right: 4, borderRadius: 'var(--radius-full)' }} onClick={() => navigate('/random-chat')} title="Random Chat">
            <Shuffle size={18} />
          </button>
        </div>
      </div>

      {/* Action Buttons */}
      <div style={{ padding: '8px 16px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '6px 10px' }} onClick={() => setShowFindUser(true)}><Plus size={13} /> New Chat</button>
        <button className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '6px 10px' }} onClick={() => setShowCreateGroup(true)}><Users size={13} /> New Group</button>
        <button className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '6px 10px' }} onClick={() => navigate('/random-chat')}><Shuffle size={13} /> Random</button>
        <button className={`btn ${selectMode ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: '0.78rem', padding: '6px 10px' }} onClick={() => { setSelectMode(v => !v); setSelectedChats(new Set()); }}>
          <Check size={13} /> {selectMode ? 'Cancel' : 'Select'}
        </button>
      </div>

      {/* Multi-select Action Bar */}
      {selectMode && selectedChats.size > 0 && (
        <div style={{ padding: '8px 16px', display: 'flex', gap: 8, alignItems: 'center', background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)' }}>
          <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>{selectedChats.size} selected</span>
          <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '0.78rem' }} onClick={bulkArchive}><Archive size={13} /> Archive</button>
          <button style={{ padding: '5px 10px', fontSize: '0.78rem', background: '#ef4444', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }} onClick={bulkDelete}><Trash2 size={13} /> Delete</button>
        </div>
      )}

      {/* Chat List */}
      <div className="chat-list">
        {isLoading ? (
          <div className="empty-state"><div className="loader" /></div>
        ) : visibleList.length === 0 && lockedHiddenList.length === 0 && archivedList.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><MessageSquare size={28} color="var(--color-text-muted)" /></div>
            <p className="empty-state-title">No chats yet</p>
            <p className="empty-state-desc">Start a conversation by clicking "New Chat"</p>
          </div>
        ) : (
          <>
            {visibleList.map(renderChatRow)}

            {/* Locked section */}
            {lockedHiddenList.length > 0 && (
              <>
                <button onClick={() => setShowLockedSection(v => !v)} style={{ width: '100%', padding: '10px 16px', background: 'none', border: 'none', borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                  <Lock size={13} /> Locked Chats ({lockedHiddenList.length})
                  {showLockedSection ? <ChevronDown size={13} style={{ marginLeft: 'auto' }} /> : <ChevronRight size={13} style={{ marginLeft: 'auto' }} />}
                </button>
                {showLockedSection && lockedHiddenList.map(chat => (
                  <div key={chat.partnerId} className="chat-list-item" style={{ cursor: 'pointer' }} onClick={() => setLockModal({ chat, action: 'access' })}>
                    <div className="avatar avatar-md" style={{ background: '#1e293b', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Lock size={18} color="#64748b" /></div>
                    <div className="chat-item-info">
                      <div className="chat-item-header"><span className="chat-item-name">🔒 {chat.partner.full_name}</span></div>
                      <span className="chat-item-preview" style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>Enter PIN to open</span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Archived section */}
            {archivedList.length > 0 && (
              <>
                <button onClick={() => setShowArchived(v => !v)} style={{ width: '100%', padding: '10px 16px', background: 'none', border: 'none', borderTop: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                  <Archive size={13} /> Archived ({archivedList.length})
                  {showArchived ? <ChevronDown size={13} style={{ marginLeft: 'auto' }} /> : <ChevronRight size={13} style={{ marginLeft: 'auto' }} />}
                </button>
                {showArchived && archivedList.map(renderChatRow)}
              </>
            )}
          </>
        )}
      </div>

      {/* Context Menu (right-click) */}
      {contextMenu && (
        <div style={{ position: 'fixed', top: contextMenu.y, left: Math.min(contextMenu.x, window.innerWidth - 210), background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: 9999, minWidth: 200, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
          {[
            { emoji: prefs[contextMenu.chat.partnerId]?.is_archived ? '📤' : '📥', label: prefs[contextMenu.chat.partnerId]?.is_archived ? 'Unarchive' : 'Archive', action: () => toggleArchive(contextMenu.chat), danger: false },
            { emoji: prefs[contextMenu.chat.partnerId]?.is_locked ? '🔓' : '🔒', label: prefs[contextMenu.chat.partnerId]?.is_locked ? 'Remove Lock' : 'Lock Chat', action: () => { setLockModal({ chat: contextMenu.chat, action: prefs[contextMenu.chat.partnerId]?.is_locked ? 'unlock' : 'lock' }); setContextMenu(null); }, danger: false },
            { emoji: contextMenu.chat.isGroup ? (contextMenu.chat.partner.admin_id === user?.id ? '🗑️' : '🚪') : '🗑️', label: contextMenu.chat.isGroup ? (contextMenu.chat.partner.admin_id === user?.id ? 'Delete Group' : 'Leave Group') : 'Delete Chat', action: () => deleteChat(contextMenu.chat), danger: true },
          ].map((item, i) => (
            <button key={i} onClick={item.action} style={{ width: '100%', padding: '11px 16px', background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', fontSize: '0.875rem', color: item.danger ? '#ef4444' : 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 10, transition: 'background 0.15s' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-surface-2)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
              <span>{item.emoji}</span> {item.label}
            </button>
          ))}
        </div>
      )}

      {/* PIN Modal (Lock/Unlock/Access) */}
      {lockModal && (
        <div className="modal-overlay" onClick={() => { setLockModal(null); setPinInput(''); setPinError(''); }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 300, textAlign: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: 8 }}>{lockModal.action === 'lock' ? '🔒' : '🔑'}</div>
            <h3 className="modal-title">{lockModal.action === 'lock' ? 'Set PIN Lock' : lockModal.action === 'unlock' ? 'Remove Lock' : 'Unlock Chat'}</h3>
            <p className="modal-desc" style={{ marginBottom: 16 }}>
              {lockModal.action === 'lock' ? 'Enter a 4-digit PIN to lock this chat' : 'Enter your 4-digit PIN to continue'}
            </p>
            <input
              type="password" inputMode="numeric" maxLength={4} className="input"
              style={{ width: '100%', textAlign: 'center', fontSize: '2.5rem', letterSpacing: '1rem', paddingLeft: '1rem', marginBottom: 4 }}
              placeholder="••••" value={pinInput}
              onChange={e => { setPinInput(e.target.value.replace(/\D/g, '')); setPinError(''); }}
              autoFocus onKeyDown={e => e.key === 'Enter' && handleLockAction()}
            />
            {pinError && <p style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: 8 }}>{pinError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { setLockModal(null); setPinInput(''); setPinError(''); }}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleLockAction}>
                {lockModal.action === 'lock' ? 'Lock' : lockModal.action === 'unlock' ? 'Remove' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Find User Modal */}
      {showFindUser && (
        <div className="modal-overlay" onClick={() => setShowFindUser(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Find User</h3>
            <p className="modal-desc">Search by username or name to start a new chat</p>
            <div className="input-wrapper" style={{ marginBottom: 16 }}>
              <span className="search-icon"><Search size={16} /></span>
              <input type="text" className="input search-input" style={{ paddingLeft: 40, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }} placeholder="Search username or name..." value={findQuery} onChange={e => setFindQuery(e.target.value)} autoFocus />
            </div>
            <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {findResults.map(u => (
                <div key={u.id} className="find-user-item" onClick={() => startChat(u.id)}>
                  <div className="avatar avatar-sm">{u.avatar_url ? <img src={u.avatar_url} alt={u.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : initials(u.full_name)}</div>
                  <div><div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{u.full_name}</div><div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>@{u.username}</div></div>
                </div>
              ))}
              {findQuery.length >= 2 && findResults.length === 0 && <p style={{ textAlign: 'center', color: 'var(--color-text-muted)', fontSize: '0.875rem', padding: 16 }}>No users found</p>}
            </div>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setShowFindUser(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Create Group Modal */}
      {showCreateGroup && (
        <div className="modal-overlay" onClick={() => setShowCreateGroup(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Create New Group</h3>
            <input type="text" className="input" style={{ width: '100%', marginBottom: 16 }} placeholder="Group Name" value={groupName} onChange={e => setGroupName(e.target.value)} autoFocus />
            <p className="modal-desc">Search and select users to add</p>
            <div className="input-wrapper" style={{ marginBottom: 12 }}>
              <span className="search-icon"><Search size={16} /></span>
              <input type="text" className="input search-input" style={{ paddingLeft: 40, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }} placeholder="Search..." value={findQuery} onChange={e => setFindQuery(e.target.value)} />
            </div>
            {selectedUsers.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {selectedUsers.map(u => (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', background: 'var(--color-primary)', color: 'white', padding: '3px 8px', borderRadius: 16, fontSize: '0.75rem' }}>
                    {u.full_name}
                    <button style={{ background: 'none', border: 'none', color: 'white', marginLeft: 5, cursor: 'pointer', padding: 0, lineHeight: 1 }} onClick={() => toggleUserForGroup(u)}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {findResults.map(u => {
                const isSelected = selectedUsers.some(su => su.id === u.id);
                return (
                  <div key={u.id} className="find-user-item" style={{ border: `1px solid ${isSelected ? 'var(--color-primary)' : 'transparent'}`, background: isSelected ? 'var(--color-surface-2)' : 'transparent' }} onClick={() => toggleUserForGroup(u)}>
                    <div className="avatar avatar-sm">{u.avatar_url ? <img src={u.avatar_url} alt={u.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : initials(u.full_name)}</div>
                    <div><div style={{ fontWeight: 600, fontSize: '0.875rem' }}>{u.full_name}</div><div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>@{u.username}</div></div>
                    {isSelected && <Check size={16} color="var(--color-primary)" style={{ marginLeft: 'auto' }} />}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={() => setShowCreateGroup(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={createGroup} disabled={!groupName.trim() || selectedUsers.length === 0}>Create Group</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
