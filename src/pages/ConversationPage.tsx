import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Send, Image, Smile, X, Check, CheckCheck, Trash2, Ban,
  Mic, Phone, Video, Globe, Clock, BarChart2, Timer, FileText
} from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useActiveChat } from '../context/ActiveChatContext';
import { format, isToday, isYesterday, isSameDay, formatDistanceToNow } from 'date-fns';
import imageCompression from 'browser-image-compression';
import { useChatMessages } from '../hooks/useChatMessages';
import type { Message } from '../hooks/useChatMessages';
import { useChatRealtime } from '../hooks/useChatRealtime';

// ── Destruct durations ──────────────────────────────────────────────────────
const DESTRUCT_OPTIONS = [
  { label: 'Off', value: null },
  { label: '30s', value: 30 },
  { label: '5m',  value: 300 },
  { label: '1h',  value: 3600 },
  { label: '1d',  value: 86400 },
];

export default function ConversationPage() {
  const { partnerId } = useParams<{ partnerId: string }>();
  const { user, onlineUserIds, profile } = useAuth();
  const { activePartner, setActivePartner } = useActiveChat();
  const navigate = useNavigate();

  const [partner, setPartner] = useState<Profile | null>(activePartner || null);
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isBlocked, setIsBlocked] = useState(false);
  const [hasBlockedThem, setHasBlockedThem] = useState(false);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [partnerLastSeen, setPartnerLastSeen] = useState<string | null>(null);

  // ── Smart replies ─────────────────────────────────────────────────────────
  const [smartReplies, setSmartReplies] = useState<string[]>([]);

  // ── Self-destruct ─────────────────────────────────────────────────────────
  const [destructSeconds, setDestructSeconds] = useState<number | null>(null);
  const [showDestructMenu, setShowDestructMenu] = useState(false);

  // ── Voice-to-text ─────────────────────────────────────────────────────────
  const [listeningSTT, setListeningSTT] = useState(false);

  // ── Analytics panel ───────────────────────────────────────────────────────
  const [showAnalytics, setShowAnalytics] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioChunks = useRef<Blob[]>([]);

  // ── Load Partner & Block Status ────────────────────────────────────────────
  useEffect(() => {
    async function initPartner() {
      if (!user || !partnerId) return;
      const { data: p } = await supabase.from('profiles').select('*').eq('id', partnerId).single();
      if (p) { setPartner(p as Profile); setActivePartner(p as Profile); setPartnerLastSeen(p.last_seen_at); }
      const { data: blocks } = await supabase
        .from('blocked_users').select('*')
        .or(`and(blocker_id.eq.${user.id},blocked_id.eq.${partnerId}),and(blocker_id.eq.${partnerId},blocked_id.eq.${user.id})`);
      if (blocks && blocks.length > 0) {
        setIsBlocked(true);
        setHasBlockedThem(blocks.some(b => b.blocker_id === user.id));
      } else { setIsBlocked(false); setHasBlockedThem(false); }
    }
    initPartner();
  }, [user, partnerId, setActivePartner]);

  // ── Partner presence: live from AuthContext ────────────────────────────────
  const partnerOnline = !!partnerId && onlineUserIds.has(partnerId);
  useEffect(() => {
    if (!partnerId || partnerOnline) return;
    supabase.from('profiles').select('last_seen_at').eq('id', partnerId).single()
      .then(({ data }) => { if (data) setPartnerLastSeen(data.last_seen_at); });
  }, [partnerId, partnerOnline]);


  // ── Modular Hooks Architecture (Phase 7 & 10) ────────────────────────────
  const { 
    messages: queryMessages, 
    isLoading, 
    isError, 
    hasNextPage, 
    isFetchingNextPage, 
    fetchNextPage, 
    sendMessage: rawSendMessage, 
    deleteForMe, 
    deleteForEveryone,
    upsertLocalMessage 
  } = useChatMessages(user?.id, partnerId);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView();
  }, []);

  const { realtimeStatus, partnerTyping, broadcastTyping } = useChatRealtime({
    userId: user?.id,
    partnerId,
    upsertLocalMessage,
    onScrollToBottom: scrollToBottom
  });

  // ── Infinite Query Scroll Handler ──────────────────────────────────────────
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop === 0 && hasNextPage && !isFetchingNextPage) fetchNextPage();
  };

  useEffect(() => {
    if (!isFetchingNextPage) setTimeout(scrollToBottom, 100);
  }, [queryMessages.length, isFetchingNextPage, scrollToBottom]);



  const handleSend = async () => {
    const msg = text.trim();
    if (!msg) return;
    setText('');
    setSmartReplies([]);
    
    // Call raw sendMessage from hook
    await rawSendMessage(msg, null, null, destructSeconds);
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setTimeout(scrollToBottom, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    broadcastTyping();
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    setText(prev => prev + emojiData.emoji);
    setShowEmoji(false);
    inputRef.current?.focus();
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !partnerId) return;
    setUploading(true);
    try {
      const options = { maxSizeMB: 1, maxWidthOrHeight: 1280, useWebWorker: true };
      const compressedFile = await imageCompression(file, options);
      const fileName = `${user?.id}/${Date.now()}_${compressedFile.name}`;
      const { data, error } = await supabase.storage.from('chat-media').upload(fileName, compressedFile);
      if (!error && data) {
        const { data: { publicUrl } } = supabase.storage.from('chat-media').getPublicUrl(fileName);
        await rawSendMessage(null, publicUrl, 'image', destructSeconds);
      }
    } catch (err) { console.error('Compression error', err); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunks.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.current.push(e.data); };
      recorder.onstop = uploadRecording;
      setMediaRecorder(recorder);
      recorder.start();
      setRecording(true);
    } catch (e) { console.error('Mic access denied'); }
  };

  const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      setRecording(false);
    }
  };

  const uploadRecording = async () => {
    if (audioChunks.current.length === 0) return;
    setUploading(true);
    const blob = new Blob(audioChunks.current, { type: 'audio/webm' });
    const fileName = `${user?.id}/${Date.now()}_voice.webm`;
    const { data, error } = await supabase.storage.from('voice-notes').upload(fileName, blob);
    if (!error && data) {
      const { data: { publicUrl } } = supabase.storage.from('voice-notes').getPublicUrl(fileName);
      await rawSendMessage(null, publicUrl, 'voice', destructSeconds);
    }
    setUploading(false);
  };

  // ── Voice-to-text (Web Speech API) ────────────────────────────────────────
  const startVoiceToText = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert('Voice-to-text is not supported in this browser.'); return; }
    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.onstart = () => setListeningSTT(true);
    recognition.onend = () => setListeningSTT(false);
    recognition.onerror = () => setListeningSTT(false);
    recognition.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setText(prev => prev + (prev ? ' ' : '') + transcript);
      inputRef.current?.focus();
    };
    recognition.start();
  };



  const formatDateSeparator = (date: Date) => {
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMMM d, yyyy');
  };

  const initials = (name: string) => {
    if (!name) return '?';
    try { return name.split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase() || '?'; }
    catch (e) { return '?'; }
  };
  const isSent = (msg: Message) => msg.sender_id === user?.id;

  const getStatusText = () => {
    if (partnerTyping) return 'typing...';
    if (partnerOnline) return 'Online';
    if (!partnerLastSeen) return 'Offline';
    return `Last seen ${formatDistanceToNow(new Date(partnerLastSeen), { addSuffix: true })}`;
  };

  /** Tick logic (WhatsApp-style) */
  const getTicks = (msg: Message) => {
    if (!isSent(msg)) return null;
    if (msg.isOptimistic) return (
      <span className="ticks-container sending"><Clock size={13} color="var(--color-text-muted)" strokeWidth={2} /></span>
    );
    if (msg.status === 'read') return (
      <span className="ticks-container read"><CheckCheck size={15} color="var(--color-primary)" strokeWidth={2.5} /></span>
    );
    if (msg.status === 'delivered') return (
      <span className="ticks-container delivered"><CheckCheck size={15} color="var(--color-text-muted)" strokeWidth={2} /></span>
    );
    return (
      <span className="ticks-container sent"><Check size={15} color="var(--color-text-muted)" strokeWidth={2} /></span>
    );
  };

  const handleCall = async (type: 'audio' | 'video') => {
    if (!partner || !user) return;
    if (isBlocked) { alert('You cannot call a blocked user.'); return; }
    const privacy = partner.ui_preferences?.call_privacy || 'everyone';
    if (privacy === 'nobody') { alert(`${partner.full_name} is not accepting calls.`); return; }
    if (privacy === 'contacts' && queryMessages.length === 0) { alert(`${partner.full_name} only accepts calls from existing contacts.`); return; }
    document.dispatchEvent(new CustomEvent('init-call', { detail: {
      partnerId, type,
      partnerName: partner.full_name, partnerAvatar: partner.avatar_url,
      callerName: profile?.full_name, callerAvatar: profile?.avatar_url
    }}));
  };

  // ── Analytics ──────────────────────────────────────────────────────────────
  const analyticsData = (() => {
    const msgs = queryMessages.filter(m => !m.is_deleted_globally && !m.deleted_for_users?.includes(user?.id || ''));
    const mySent = msgs.filter(m => m.sender_id === user?.id);
    const theirSent = msgs.filter(m => m.sender_id === partnerId);
    const images = msgs.filter(m => m.media_type === 'image').length;
    const voices = msgs.filter(m => m.media_type === 'voice').length;
    const byDay: Record<string, number> = {};
    msgs.forEach(m => {
      const day = format(new Date(m.created_at), 'EEE');
      byDay[day] = (byDay[day] || 0) + 1;
    });
    const maxDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
    return { total: msgs.length, mySent: mySent.length, theirSent: theirSent.length, images, voices, busiestDay: maxDay?.[0] || '—' };
  })();

  if (isLoading) return <div className="empty-state"><div className="loader" /></div>;

  if (isError) return (
    <div className="empty-state">
      <div className="empty-state-icon">❌</div>
      <div className="empty-state-title">Failed to load chat</div>
      <div className="empty-state-desc">Please check your connection and try again.</div>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>Retry</button>
    </div>
  );

  if (!partner) return (
    <div className="empty-state">
      <div className="empty-state-icon">❓</div>
      <div className="empty-state-title">User not found</div>
      <div className="empty-state-desc">The user you are looking for does not exist or has deleted their account.</div>
      <button className="btn btn-primary" onClick={() => navigate('/')}>Back to Chats</button>
    </div>
  );

  return (
    <div className="conversation-page" style={{ '--chat-bg-override': 'var(--chat-bg, var(--color-bg))' } as any}>
      {/* Header */}
      <div className="page-header">
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/')}><ArrowLeft size={20} /></button>
        <div className="avatar avatar-sm">
          {partner.avatar_url
            ? <img src={partner.avatar_url} alt={partner.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
            : initials(partner.full_name)
          }
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div className="page-header-title" style={{ fontSize: '0.9375rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{partner.full_name || 'User'}</div>
          <div className="page-header-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: partnerTyping ? 'var(--color-primary)' : partnerOnline ? '#22c55e' : 'var(--color-text-muted)', fontWeight: (partnerTyping || partnerOnline) ? 600 : 400, transition: 'color 0.3s' }}>
              {getStatusText()}
            </span>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              backgroundColor: realtimeStatus === 'SUBSCRIBED' ? '#22c55e' : '#ef4444',
              boxShadow: realtimeStatus === 'SUBSCRIBED' ? '0 0 8px #22c55e' : 'none',
              transition: 'all 0.3s'
            }} title={realtimeStatus === 'SUBSCRIBED' ? 'Connected' : 'Connecting...'} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {!isBlocked && (
            <>
              <button className="btn btn-ghost btn-icon" onClick={() => handleCall('audio')}><Phone size={18} /></button>
              <button className="btn btn-ghost btn-icon" onClick={() => handleCall('video')}><Video size={18} /></button>
            </>
          )}
          <button className="btn btn-ghost btn-icon" onClick={() => setShowAnalytics(v => !v)} title="Chat Insights">
            <BarChart2 size={18} />
          </button>
        </div>
      </div>

      {/* Analytics Panel */}
      {showAnalytics && (
        <div style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', padding: '12px 20px', animation: 'slideDown 0.2s ease' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Chat Insights</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {[
              { label: 'Total', value: analyticsData.total },
              { label: 'You sent', value: analyticsData.mySent },
              { label: 'They sent', value: analyticsData.theirSent },
              { label: 'Images', value: analyticsData.images },
              { label: 'Voices', value: analyticsData.voices },
              { label: 'Busiest day', value: analyticsData.busiestDay },
            ].map(item => (
              <div key={item.label} style={{ background: 'var(--color-surface-2)', borderRadius: 10, padding: '8px 10px', textAlign: 'center' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--color-primary)' }}>{item.value}</div>
                <div style={{ fontSize: '0.65rem', color: 'var(--color-text-muted)', textTransform: 'uppercase' }}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        className="messages-container"
        onScroll={handleScroll}
        ref={scrollContainerRef}
        style={{ background: 'var(--chat-bg, var(--color-bg))' }}
      >
        {isFetchingNextPage && <div style={{ textAlign: 'center', padding: 8 }}><div className="loader" style={{ width: 20, height: 20 }}/></div>}

        {queryMessages.map((msg, i) => {
          const msgDate = new Date(msg.created_at);
          const prevMsg = queryMessages[i - 1];
          const showSeparator = !prevMsg || !isSameDay(new Date(prevMsg.created_at), msgDate);
          if (msg.deleted_for_users?.includes(user!.id)) return null;
          const isExpired = msg.expires_at && new Date(msg.expires_at) <= new Date();
          if (isExpired) return null;

          return (
            <div key={msg.id}>
              {showSeparator && <div className="date-separator">{formatDateSeparator(msgDate)}</div>}
              <div className={`message-row ${isSent(msg) ? 'sent' : 'received'} animate-fade-in`} style={{ position: 'relative' }}>
                {!isSent(msg) && partner && (
                  <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
                    {partner.avatar_url
                      ? <img src={partner.avatar_url} alt={partner.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                      : initials(partner.full_name)
                    }
                  </div>
                )}
                <div className={`message-bubble ${isSent(msg) ? 'sent' : 'received'} ${msg.is_deleted_globally ? 'deleted' : ''}`} style={{ opacity: msg.isOptimistic ? 0.7 : 1 }}>
                  {msg.is_deleted_globally ? (
                    <div className="bubble-content" style={{ fontStyle: 'italic', color: 'var(--color-text-muted)' }}>🚫 This message was deleted</div>
                  ) : msg.media_type === 'image' && msg.media_url ? (
                    <img src={msg.media_url} className="bubble-image" alt="Shared image" onClick={() => window.open(msg.media_url!, '_blank')} />
                  ) : msg.media_type === 'voice' && msg.media_url ? (
                    <audio controls src={msg.media_url} className="audio-player" style={{ height: 32, outline: 'none' }} />
                  ) : (
                    <div className="bubble-content">{msg.content}</div>
                  )}
                  <div className="bubble-time">
                    {format(msgDate, 'HH:mm')}
                    {msg.expires_at && (
                      <span title="Self-destructs" style={{ marginLeft: 3, color: '#f59e0b', fontSize: '0.6rem' }}>⏱</span>
                    )}
                    <span style={{ marginLeft: 4, display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' }}>
                      {getTicks(msg)}
                    </span>
                  </div>
                  <div className="message-actions" style={{ position: 'absolute', top: 0, right: isSent(msg) ? '100%' : 'auto', left: isSent(msg) ? 'auto' : '100%', padding: '0 8px', opacity: 0, transition: 'opacity 0.2s', display: 'flex', gap: 4 }}>
                    <button onClick={() => deleteForMe(msg.id)} title="Delete for me"><Trash2 size={14} /></button>
                    {isSent(msg) && msg.media_type !== 'voice' && !msg.is_deleted_globally && (
                      <button onClick={() => deleteForEveryone(msg.id)} title="Delete for everyone"><Globe size={14} /></button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {/* Partner typing indicator */}
        {partnerTyping && (
          <div className="message-row received animate-fade-in">
            <div className="avatar avatar-sm" style={{ flexShrink: 0 }}>
              {partner.avatar_url
                ? <img src={partner.avatar_url} alt={partner.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                : initials(partner.full_name)
              }
            </div>
            <div className="message-bubble received" style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {[0, 0.2, 0.4].map((delay, idx) => (
                  <div key={idx} style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: 'var(--color-text-muted)',
                    animation: `typingBounce 1.2s ${delay}s infinite ease-in-out`
                  }} />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Smart Reply chips */}
      {smartReplies.length > 0 && !isBlocked && (
        <div style={{ display: 'flex', gap: 8, padding: '6px 16px', overflowX: 'auto', scrollbarWidth: 'none', background: 'var(--color-bg)' }}>
          {smartReplies.map((reply, i) => (
            <button key={i} onClick={() => { setText(reply); inputRef.current?.focus(); }}
              style={{
                flexShrink: 0, padding: '5px 14px', borderRadius: 20,
                background: 'var(--color-primary-subtle)', border: '1px solid var(--color-primary)',
                color: 'var(--color-primary)', fontSize: '0.8125rem', cursor: 'pointer',
                whiteSpace: 'nowrap', transition: 'all 0.15s',
              }}>
              {reply}
            </button>
          ))}
        </div>
      )}

      {/* Emoji Picker */}
      {showEmoji && (
        <div className="emoji-picker-wrapper">
          <EmojiPicker theme={Theme.DARK} onEmojiClick={handleEmojiClick} width={320} height={380} />
        </div>
      )}

      {/* Self-destruct menu */}
      {showDestructMenu && (
        <div style={{ padding: '8px 16px', background: 'var(--color-surface)', borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginRight: 4 }}>Self-destruct:</span>
          {DESTRUCT_OPTIONS.map(opt => (
            <button key={String(opt.value)} onClick={() => { setDestructSeconds(opt.value); setShowDestructMenu(false); }}
              style={{
                padding: '4px 10px', borderRadius: 16, fontSize: '0.75rem', cursor: 'pointer',
                background: destructSeconds === opt.value ? 'var(--color-primary)' : 'var(--color-surface-2)',
                color: destructSeconds === opt.value ? '#fff' : 'var(--color-text)',
                border: `1px solid ${destructSeconds === opt.value ? 'var(--color-primary)' : 'var(--color-border)'}`,
                transition: 'all 0.15s',
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      {isBlocked ? (
        <div style={{ padding: 16, textAlign: 'center', backgroundColor: 'var(--color-surface)', color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Ban size={16} /> {hasBlockedThem ? 'You blocked this user.' : 'You cannot reply to this conversation.'}
        </div>
      ) : (
        <div className="message-input-container">
          <button className="btn btn-ghost btn-icon" onClick={() => setShowEmoji(v => !v)}>
            {showEmoji ? <X size={20} /> : <Smile size={20} />}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={() => fileRef.current?.click()} disabled={uploading || recording}>
            <Image size={20} />
          </button>
          <input type="file" ref={fileRef} style={{ display: 'none' }} accept="image/*" onChange={handleImageUpload} />

          {/* Voice-to-text button */}
          <button
            className="btn btn-ghost btn-icon"
            onClick={startVoiceToText}
            title="Voice to text"
            style={{ color: listeningSTT ? '#ef4444' : undefined }}
          >
            <FileText size={18} />
          </button>

          {/* Self-destruct toggle */}
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => setShowDestructMenu(v => !v)}
            title="Self-destruct timer"
            style={{ color: destructSeconds ? '#f59e0b' : undefined }}
          >
            <Timer size={18} />
          </button>

          {recording ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', color: '#ef4444' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ef4444', animation: 'pulse 1s infinite' }} />
              Recording voice note...
            </div>
          ) : (
            <textarea
              ref={inputRef}
              className="message-input"
              placeholder={destructSeconds ? `⏱ ${DESTRUCT_OPTIONS.find(o=>o.value===destructSeconds)?.label} · Type a message...` : 'Type a message...'}
              value={text}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              rows={1}
              style={{ resize: 'none' }}
              disabled={uploading}
            />
          )}

          {text.trim() || uploading ? (
            <button className="send-btn" onClick={handleSend} disabled={uploading}><Send size={18} /></button>
          ) : (
            <button
              className={`btn btn-ghost btn-icon ${recording ? 'recording' : ''}`}
              onMouseDown={startRecording} onMouseUp={stopRecording}
              onTouchStart={startRecording} onTouchEnd={stopRecording}
              style={{ color: recording ? '#ef4444' : 'inherit' }}
            >
              <Mic size={20} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
