import { useState, useEffect, useRef, useMemo } from 'react';
import { Globe, Users, Smile, X, Plus, Mic } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { supabase } from '../lib/supabase';
import type { Status, Profile } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { formatDistanceToNow } from 'date-fns';
import StatusViewer from '../components/StatusViewer';

type StatusWithProfile = Status & { profile: Profile };

export default function StatusPage() {
  const { user } = useAuth();
  const [statuses, setStatuses] = useState<StatusWithProfile[]>([]);
  const [content, setContent] = useState('');
  const [visibility, setVisibility] = useState<'contacts' | 'public'>('contacts');
  const [showEmoji, setShowEmoji] = useState(false);
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [viewedIds, setViewedIds] = useState<string[]>([]);
  const [viewerActive, setViewerActive] = useState<boolean>(false);
  const [viewerStatuses, setViewerStatuses] = useState<StatusWithProfile[]>([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const emojiRef = useRef<HTMLDivElement>(null);

  // Load viewed state from local storage securely
  useEffect(() => {
    try {
      const stored = localStorage.getItem('mkp_viewed_statuses');
      if (stored) setViewedIds(JSON.parse(stored));
    } catch {}
  }, []);

  const markViewed = (id: string) => {
    setViewedIds(prev => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      localStorage.setItem('mkp_viewed_statuses', JSON.stringify(next));
      return next;
    });
  };

  // FIX: Single JOIN query instead of N+1 loop
  const loadStatuses = async () => {
    if (!user) return;
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('statuses')
      .select('*, profile:profiles(*)')
      .gt('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[StatusPage] loadStatuses error:', error.message);
      setLoading(false);
      return;
    }

    setStatuses((data as StatusWithProfile[]) || []);
    setLoading(false);
  };

  useEffect(() => { loadStatuses(); }, [user]);

  // FIX: Guard subscription with user check; use optimistic append on INSERT
  useEffect(() => {
    if (!user) return;

    const sub = supabase.channel('status-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'statuses' },
        async (payload) => {
          // Fetch the single new status with profile JOIN instead of reloading everything
          const { data } = await supabase
            .from('statuses')
            .select('*, profile:profiles(*)')
            .eq('id', payload.new.id)
            .single();

          if (data) {
            setStatuses(prev => [data as StatusWithProfile, ...prev]);
          }
        })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'statuses' },
        (payload) => {
          // Optimistically remove from state by id
          setStatuses(prev => prev.filter(s => s.id !== payload.old.id));
        })
      .subscribe();

    return () => { sub.unsubscribe(); };
  }, [user]);

  const postStatus = async () => {
    if (!content.trim() || !user) return;
    setPosting(true);
    const { error } = await supabase.from('statuses').insert({
      user_id: user.id,
      content: content.trim(),
      visibility,
    });
    if (error) console.error('[StatusPage] postStatus error:', error.message);
    setContent('');
    setPosting(false);
    // Realtime will handle the append, but reload to get the profile join
    loadStatuses();
  };

  const deleteStatus = async (id: string) => {
    await supabase.from('statuses').delete().eq('id', id);
    // Optimistic: realtime DELETE handler will remove it, but also remove locally
    setStatuses(prev => prev.filter(s => s.id !== id));
  };

  const handleEmoji = (emojiData: EmojiClickData) => {
    if (content.length < 280) setContent(prev => prev + emojiData.emoji);
    setShowEmoji(false);
  };

  const handleMicClick = () => {
    alert("Voice Status recording will be here! Need to connect to Supabase Storage first.");
  };

  const charRemaining = 280 - content.length;
  const initials = (name: string) => name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || '?';

  // Group statuses by user for WhatsApp-like presentation
  const { myStatuses, groupedOthers } = useMemo(() => {
    const mine: StatusWithProfile[] = [];
    const others = new Map<string, StatusWithProfile[]>();

    statuses.forEach(s => {
      if (s.user_id === user?.id) {
        mine.push(s);
      } else {
        if (!others.has(s.user_id)) others.set(s.user_id, []);
        others.get(s.user_id)!.push(s);
      }
    });

    // Reverse mine so newest is first in the individual card view if needed,
    // actually chronological is fine since we ordered by created_at desc
    return { myStatuses: mine, groupedOthers: Array.from(others.values()) };
  }, [statuses, user?.id]);

  const openViewerForGroup = (group: StatusWithProfile[]) => {
    // Sort chronological for viewer
    const sorted = [...group].sort((a,b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    // Find first unviewed
    const firstUnviewedIdx = sorted.findIndex(s => !viewedIds.includes(s.id));
    setViewerIndex(firstUnviewedIdx === -1 ? 0 : firstUnviewedIdx);
    setViewerStatuses(sorted);
    setViewerActive(true);
  };

  return (
    <div className="status-page">
      <div className="page-header">
        <div>
          <div className="page-header-title">Status</div>
          <div className="page-header-subtitle">{statuses.length} active update{statuses.length !== 1 ? 's' : ''}</div>
        </div>
      </div>

      {/* Composer */}
      <div className="status-composer">
        <textarea
          className="status-textarea"
          placeholder="What's on your mind? (Text & emoji only)"
          value={content}
          onChange={e => setContent(e.target.value.slice(0, 280))}
          maxLength={280}
        />
        {showEmoji && (
          <div ref={emojiRef} style={{ marginBottom: 8 }}>
            <EmojiPicker theme={Theme.DARK} onEmojiClick={handleEmoji} width="100%" height={320} />
          </div>
        )}
        <div className="status-composer-footer">
          <button className="btn btn-ghost btn-icon" onClick={() => setShowEmoji(v => !v)}>
            {showEmoji ? <X size={18} /> : <Smile size={18} />}
          </button>

          <select
            className="input"
            value={visibility}
            onChange={e => setVisibility(e.target.value as 'contacts' | 'public')}
            style={{ width: 'auto', padding: '7px 32px 7px 10px', fontSize: '0.8125rem' }}
          >
            <option value="contacts">Contacts only</option>
            <option value="public">Public (Anyone)</option>
          </select>

          <span className={`char-count${charRemaining < 50 ? ' warn' : ''}${charRemaining < 20 ? ' danger' : ''}`}>
            {charRemaining}
          </span>

          <button
            className="btn btn-ghost" style={{ padding: '7px', borderRadius: '50%', color: 'var(--color-primary)' }}
            onClick={handleMicClick} title="Voice Status (Tap & Talk)"
          >
            <Mic size={20} />
          </button>

          <button
            className="btn btn-primary"
            style={{ padding: '7px 18px', fontSize: '0.875rem' }}
            onClick={postStatus}
            disabled={posting || !content.trim()}
          >
            {posting ? 'Posting...' : 'Post Status'}
          </button>
        </div>
      </div>

      {/* WhatsApp-Style Horizontal Story Feed */}
      <div style={{ margin: '0 20px', paddingBottom: '16px', borderBottom: '1px solid var(--color-border)' }}>
        <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 12 }}>Recent Updates</h3>
        
        <div className="horizontal-scroll hide-scrollbar" style={{ gap: 16 }}>
          {/* Always show "My Status" add button */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0, cursor: 'pointer' }} onClick={() => document.querySelector<HTMLTextAreaElement>('.status-textarea')?.focus()}>
            <div style={{ position: 'relative' }}>
              <div className="avatar avatar-lg" style={{ border: '2px solid var(--color-bg)' }}>
                {user?.user_metadata?.avatar_url 
                  ? <img src={user.user_metadata.avatar_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                  : initials(user?.user_metadata?.full_name || 'Me')}
              </div>
              <div style={{ position: 'absolute', bottom: -2, right: -2, background: 'var(--color-primary)', borderRadius: '50%', padding: 2, border: '2px solid var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Plus size={12} color="white" strokeWidth={4} />
              </div>
            </div>
            <span style={{ fontSize: '0.75rem', fontWeight: 500 }}>My status</span>
          </div>

          {loading ? (
             <div style={{display:'flex', alignItems:'center', padding:'0 20px'}}><div className="loader" /></div>
          ) : (
            groupedOthers.map(group => {
              const allViewed = group.every(s => viewedIds.includes(s.id));
              const latestProfile = group[0].profile;
              return (
                <div 
                  key={latestProfile.id} 
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0 }}
                  onClick={() => openViewerForGroup(group)}
                >
                  <div className={`status-ring ${allViewed ? 'viewed' : ''}`}>
                    <div className="avatar avatar-lg">
                      {latestProfile.avatar_url 
                        ? <img src={latestProfile.avatar_url} alt="" style={{width:'100%',height:'100%',objectFit:'cover'}}/>
                        : initials(latestProfile.full_name || '?')
                      }
                    </div>
                  </div>
                  <span style={{ fontSize: '0.75rem', fontWeight: 500, maxWidth: 64, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {latestProfile.full_name?.split(' ')[0] || 'User'}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div style={{ padding: '0 20px', marginTop: 24 }}>
         <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 12 }}>My Updates</h3>
      </div>

      <div className="status-feed">
        {loading ? null : myStatuses.length === 0 ? (
          <div className="empty-state" style={{ marginTop: 0, padding: 32 }}>
            <p className="empty-state-title" style={{ fontSize: '0.9375rem' }}>No active statuses</p>
            <p className="empty-state-desc" style={{ fontSize: '0.8125rem' }}>Your text and voice statuses will appear here.</p>
          </div>
        ) : myStatuses.map(s => (
          <div key={s.id} className="status-card animate-fade-in" style={{ cursor: 'pointer' }} onClick={() => openViewerForGroup([s])}>
            <div className="status-card-header">
              <div className="status-ring viewed" style={{ padding: 2 }}>
                <div className="avatar avatar-sm">
                  {s.profile?.avatar_url
                    ? <img src={s.profile.avatar_url} alt={s.profile.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                    : initials(s.profile?.full_name || '?')
                  }
                </div>
              </div>
              <div className="status-card-meta">
                <div className="status-card-name" style={{ fontSize: '0.875rem' }}>View Status</div>
                <div className="status-card-time">
                  <span>{formatDistanceToNow(new Date(s.created_at), { addSuffix: true })}</span>
                  <span className={`visibility-badge ${s.visibility === 'public' ? 'visibility-public' : 'visibility-contacts'}`}>
                    {s.visibility === 'public' ? <><Globe size={10} /> Public</> : <><Users size={10} /> Contacts</>}
                  </span>
                </div>
              </div>
              <button 
                className="btn btn-ghost btn-icon" 
                style={{ width: 28, height: 28, marginLeft: 'auto' }} 
                onClick={(e) => { e.stopPropagation(); deleteStatus(s.id); }}
              >
                <X size={14} />
              </button>
            </div>
            <p className="status-card-content" style={{ fontSize: '0.875rem', marginTop: 12 }}>{s.content}</p>
          </div>
        ))}
      </div>

      {viewerActive && viewerStatuses.length > 0 && (
        <StatusViewer 
          statuses={viewerStatuses} 
          initialIndex={viewerIndex} 
          onClose={() => setViewerActive(false)} 
          onStatusViewed={markViewed}
        />
      )}
    </div>
  );
}
