import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Send, Image, Smile, X, Mic, Phone, Video, Trash2, Globe } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { supabase } from '../lib/supabase';
import type { Message as SupabaseMessage, Profile } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { format, isToday, isYesterday, isSameDay } from 'date-fns';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import imageCompression from 'browser-image-compression';

type Message = SupabaseMessage & { isOptimistic?: boolean; expires_at?: string | null };

export default function GroupConversationPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [group, setGroup] = useState<any>(null);
  const [participants, setParticipants] = useState<Profile[]>([]);
  const [groupLoading, setGroupLoading] = useState(true);
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);

  const chatChannelRef = useRef<any>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioChunks = useRef<Blob[]>([]);

  // Load Group Details & Participants
  useEffect(() => {
    async function initGroup() {
      if (!user || !groupId) return;

      // Retry up to 5 times in case RLS participant row hasn't committed yet
      let g = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data } = await supabase.from('chats').select('*').eq('id', groupId).single();
        if (data) { g = data; break; }
        await new Promise(r => setTimeout(r, 600)); // wait 600ms then retry
      }
      if (g) setGroup(g);

      const { data: pData } = await supabase
        .from('chat_participants')
        .select('user_id')
        .eq('chat_id', groupId);

      if (pData) {
        const uIds = pData.map((p: any) => p.user_id);
        const { data: profiles } = await supabase.from('profiles').select('*').in('id', uIds);
        if (profiles) setParticipants(profiles as Profile[]);
      }
      setGroupLoading(false);
    }
    initGroup();
  }, [user, groupId]);

  // Infinite Query for Group Messages
  const fetchMessages = async ({ pageParam = 0 }) => {
    if (!user || !groupId) return [];
    const limit = 50;
    const start = pageParam * limit;
    const end = start + limit - 1;

    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', groupId)
      .not('deleted_for_users', 'cs', `{${user.id}}`)
      .order('created_at', { ascending: false })
      .range(start, end);

    return data || [];
  };

  const queryKey = useMemo(() => ['messages', 'group', groupId], [groupId]);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
  } = useInfiniteQuery({
    queryKey,
    queryFn: fetchMessages,
    getNextPageParam: (lastPage, allPages) => lastPage.length === 50 ? allPages.length : undefined,
    initialPageParam: 0,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const queryMessages = data ? data.pages.flat().reverse() as Message[] : [];
  const scrollToBottom = () => bottomRef.current?.scrollIntoView();

  useEffect(() => {
    if (!isFetchingNextPage) setTimeout(scrollToBottom, 100);
  }, [queryMessages.length, isFetchingNextPage]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop === 0 && hasNextPage && !isFetchingNextPage) fetchNextPage();
  };

  const handleNewMessage = useCallback((msg: any) => {
    if (!msg || msg.chat_id !== groupId) return;
    queryClient.setQueryData(queryKey, (oldData: any) => {
      if (!oldData) return { pages: [[msg]], pageParams: [0] };
      const pages = [...oldData.pages];
      if (!pages[0]) pages[0] = [];
      const existingIdx = pages[0].findIndex((m: any) => m.id === msg.id);
      if (existingIdx !== -1) {
        pages[0][existingIdx] = { ...msg, isOptimistic: false };
      } else {
        pages[0] = [msg, ...pages[0]];
      }
      return { ...oldData, pages };
    });
    setTimeout(scrollToBottom, 50);
  }, [groupId, queryClient, queryKey]);

  // Real-time Group Messaging
  useEffect(() => {
    if (!user || !groupId) return;

    const channel = supabase.channel(`group-room-${groupId}`, {
      config: { broadcast: { self: false } }
    });

    let lastMarkTime = 0;
    const markAsRead = async () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible' || now - lastMarkTime < 2000) return;
      lastMarkTime = now;
      try {
        await supabase.from('messages').update({ status: 'read', is_read: true })
          .eq('chat_id', groupId).neq('sender_id', user.id).eq('is_read', false);
      } catch(e) { console.error('[GroupChat] Error marking as read', e); }
    };

    channel
      .on('postgres_changes', { 
        event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${groupId}` 
      }, async (payload) => {
        handleNewMessage(payload.new);
        if (payload.new.sender_id !== user.id && document.visibilityState === 'visible') {
          markAsRead(); // Throttled
        }
      })
      .on('postgres_changes', { 
        event: 'UPDATE', schema: 'public', table: 'messages', filter: `chat_id=eq.${groupId}` 
      }, (payload) => {
        const msg = payload.new as any;
        queryClient.setQueryData(queryKey, (oldData: any) => {
          if (!oldData) return oldData;
          return { ...oldData, pages: oldData.pages.map((page: any[]) => page.map((m: any) => m.id === msg.id ? { ...m, ...msg } : m)) };
        });
      })
      .subscribe();

    chatChannelRef.current = channel;
    markAsRead();

    const onVisibilityChange = () => { if (document.visibilityState === 'visible') markAsRead(); };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [user, groupId, queryClient, queryKey, handleNewMessage]);

  const sendMessage = useCallback(async (content?: string, mediaUrl?: string, mediaType?: 'image' | 'emoji' | 'voice') => {
    if (!groupId || !user) return;
    const msgContent = content || null;
    if (!msgContent && !mediaUrl) return;

    const messageId = crypto.randomUUID();
    const optimisticMsg: Message = {
      id: messageId,
      chat_id: groupId,
      sender_id: user.id,
      receiver_id: null,
      content: msgContent,
      media_url: mediaUrl || null,
      media_type: mediaType || null,
      status: 'sent',
      is_read: false,
      deleted_for_users: [],
      is_deleted_globally: false,
      created_at: new Date().toISOString(),
      read_at: null,
      expires_at: null,
      isOptimistic: true,
    };

    queryClient.setQueryData(queryKey, (oldData: any) => {
      if (!oldData) return oldData;
      const pages = [...oldData.pages];
      pages[0] = [optimisticMsg, ...(pages[0] || [])];
      return { ...oldData, pages };
    });
    setTimeout(scrollToBottom, 50);

    const { data: insertedMsg, error } = await supabase.from('messages').insert({
      id: messageId,
      chat_id: groupId,
      sender_id: user.id,
      content: msgContent,
      media_url: mediaUrl || null,
      media_type: mediaType || null,
      status: 'sent',
    }).select().single();

    if (error) {
      console.error('Group message send error:', error);
      queryClient.setQueryData(queryKey, (oldData: any) => {
        if (!oldData) return oldData;
        return { ...oldData, pages: oldData.pages.map((page: any[]) => page.filter((m: any) => m.id !== messageId)) };
      });
      return;
    }

    // Remove the optimistic UI state and commit the single tick instantly.
    if (insertedMsg) {
      handleNewMessage(insertedMsg);
    }
  }, [groupId, user, queryClient, queryKey, handleNewMessage]);

  const handleSend = async () => {
    const msg = text.trim();
    if (!msg) return;
    setText('');
    await sendMessage(msg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    setText(prev => prev + emojiData.emoji);
    setShowEmoji(false);
    inputRef.current?.focus();
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !groupId) return;
    setUploading(true);
    try {
      const options = { maxSizeMB: 1, maxWidthOrHeight: 1280, useWebWorker: true };
      const compressed = await imageCompression(file, options);
      const fileName = `${user?.id}/${Date.now()}_${compressed.name}`;
      const { data, error } = await supabase.storage.from('chat-media').upload(fileName, compressed);
      if (!error && data) {
        const { data: { publicUrl } } = supabase.storage.from('chat-media').getPublicUrl(fileName);
        await sendMessage(undefined, publicUrl, 'image');
      }
    } catch (err) { console.error('Image upload error', err); }
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
      await sendMessage(undefined, publicUrl, 'voice');
    }
    setUploading(false);
  };

  const deleteForMe = async (msgId: string) => {
    if (!user) return;
    const { data: msg } = await supabase.from('messages').select('deleted_for_users').eq('id', msgId).single();
    if (msg) {
      const updated = [...(msg.deleted_for_users || []), user.id];
      await supabase.from('messages').update({ deleted_for_users: updated }).eq('id', msgId);
      queryClient.invalidateQueries({ queryKey: ['messages', 'group', groupId] });
    }
  };

  const deleteForEveryone = async (msgId: string) => {
    await supabase.from('messages').update({ is_deleted_globally: true, content: '🚫 This message was deleted', media_url: null }).eq('id', msgId);
  };

  const formatDateSeparator = (date: Date) => {
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';
    return format(date, 'MMMM d, yyyy');
  };

  const initials = (name: string) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  };

  const isSent = (msg: Message) => msg.sender_id === user?.id;

  const handleCall = async (type: 'audio' | 'video') => {
    if (!group || !user) return;
    document.dispatchEvent(new CustomEvent('init-call', {
      detail: {
        partnerId: groupId,
        type: `group-${type}`,
        partnerName: group.name || 'Group Call',
        partnerAvatar: group.avatar_url,
        callerName: user?.user_metadata?.full_name || 'User',
        callerAvatar: null,
      }
    }));
  };

  if (isLoading || groupLoading) return <div className="empty-state"><div className="loader" /></div>;

  if (isError) return (
    <div className="empty-state">
      <div className="empty-state-icon">❌</div>
      <div className="empty-state-title">Failed to load group chat</div>
      <button className="btn btn-primary" onClick={() => window.location.reload()}>Retry</button>
    </div>
  );

  if (!group) return (
    <div className="empty-state">
      <div className="empty-state-icon">❓</div>
      <div className="empty-state-title">Group not found</div>
      <button className="btn btn-primary" onClick={() => navigate('/')}>Back to Chats</button>
    </div>
  );

  return (
    <div className="conversation-page">
      {/* Header */}
      <div className="page-header">
        <button className="btn btn-ghost btn-icon" onClick={() => navigate('/')}>
          <ArrowLeft size={20} />
        </button>
        <div className="avatar avatar-sm" style={{ background: 'linear-gradient(135deg, #38BDF8, #818CF8)', flexShrink: 0 }}>
          {group.avatar_url
            ? <img src={group.avatar_url} alt={group.name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
            : <span style={{ color: 'white', fontWeight: 'bold', fontSize: '0.75rem' }}>{initials(group.name)}</span>
          }
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div className="page-header-title" style={{ fontSize: '0.9375rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {group.name || 'Group Chat'}
          </div>
          <div className="page-header-subtitle">
            {participants.length} member{participants.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn btn-ghost btn-icon" onClick={() => handleCall('audio')}><Phone size={18} /></button>
          <button className="btn btn-ghost btn-icon" onClick={() => handleCall('video')}><Video size={18} /></button>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-container" onScroll={handleScroll} ref={scrollContainerRef}>
        {isFetchingNextPage && <div style={{ textAlign: 'center', padding: 8 }}><div className="loader" style={{ width: 20, height: 20 }} /></div>}

        {queryMessages.map((msg, i) => {
          const msgDate = new Date(msg.created_at);
          const prevMsg = queryMessages[i - 1];
          const showSeparator = !prevMsg || !isSameDay(new Date(prevMsg.created_at), msgDate);
          if (msg.deleted_for_users?.includes(user!.id)) return null;

          const sender = participants.find(p => p.id === msg.sender_id);

          return (
            <div key={msg.id}>
              {showSeparator && <div className="date-separator">{formatDateSeparator(msgDate)}</div>}
              <div className={`message-row ${isSent(msg) ? 'sent' : 'received'} animate-fade-in`} style={{ position: 'relative' }}>

                {!isSent(msg) && (
                  <div className="avatar avatar-sm" style={{ flexShrink: 0 }} title={sender?.full_name}>
                    {sender?.avatar_url
                      ? <img src={sender.avatar_url} alt={sender.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                      : initials(sender?.full_name || 'U')
                    }
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', alignItems: isSent(msg) ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                  {/* Username above received messages */}
                  {!isSent(msg) && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-primary)', fontWeight: 600, marginLeft: 4, marginBottom: 2 }}>
                      {sender?.full_name || sender?.username || 'Unknown'}
                    </span>
                  )}

                  <div
                    className={`message-bubble ${isSent(msg) ? 'sent' : 'received'} ${msg.is_deleted_globally ? 'deleted' : ''}`}
                    style={{ opacity: msg.isOptimistic ? 0.7 : 1 }}
                  >
                    {msg.is_deleted_globally ? (
                      <div className="bubble-content" style={{ fontStyle: 'italic', color: 'var(--color-text-muted)' }}>🚫 This message was deleted</div>
                    ) : msg.media_type === 'image' && msg.media_url ? (
                      <img src={msg.media_url} className="bubble-image" alt="Shared image" onClick={() => window.open(msg.media_url!, '_blank')} />
                    ) : msg.media_type === 'voice' && msg.media_url ? (
                      <audio controls src={msg.media_url} className="audio-player" style={{ height: 32, outline: 'none' }} />
                    ) : (
                      <div className="bubble-content">{msg.content}</div>
                    )}
                    <div className="bubble-time">{format(msgDate, 'HH:mm')}</div>

                    <div className="message-actions" style={{ position: 'absolute', top: 0, right: isSent(msg) ? '100%' : 'auto', left: isSent(msg) ? 'auto' : '100%', padding: '0 8px', opacity: 0, transition: 'opacity 0.2s', display: 'flex', gap: 4 }}>
                      <button onClick={() => deleteForMe(msg.id)} title="Delete for me"><Trash2 size={14} /></button>
                      {isSent(msg) && !msg.is_deleted_globally && (
                        <button onClick={() => deleteForEveryone(msg.id)} title="Delete for everyone"><Globe size={14} /></button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Emoji Picker */}
      {showEmoji && (
        <div className="emoji-picker-wrapper">
          <EmojiPicker theme={Theme.DARK} onEmojiClick={handleEmojiClick} width={320} height={380} />
        </div>
      )}

      {/* Message Input */}
      <div className="message-input-container">
        <button className="btn btn-ghost btn-icon" onClick={() => setShowEmoji(v => !v)}>
          {showEmoji ? <X size={20} /> : <Smile size={20} />}
        </button>
        <button className="btn btn-ghost btn-icon" onClick={() => fileRef.current?.click()} disabled={uploading || recording}>
          <Image size={20} />
        </button>
        <input type="file" ref={fileRef} style={{ display: 'none' }} accept="image/*" onChange={handleImageUpload} />

        {recording ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', color: '#ef4444' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ef4444', animation: 'pulse 1s infinite' }} />
            Recording voice note...
          </div>
        ) : (
          <textarea
            ref={inputRef}
            className="message-input"
            placeholder="Message group..."
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            style={{ resize: 'none' }}
            disabled={uploading}
          />
        )}

        {text.trim() || uploading ? (
          <button className="send-btn" onClick={handleSend} disabled={uploading}>
            <Send size={18} />
          </button>
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
    </div>
  );
}
