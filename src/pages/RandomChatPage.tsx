import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shuffle, X, Send, Smile } from 'lucide-react';
import EmojiPicker, { Theme } from 'emoji-picker-react';
import type { EmojiClickData } from 'emoji-picker-react';
import { supabase } from '../lib/supabase';
import type { Message, Profile } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { format } from 'date-fns';

type Phase = 'idle' | 'searching' | 'matched' | 'timeout' | 'error';

export default function RandomChatPage() {
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('idle');
  const [chatId, setChatId] = useState<string | null>(null);
  const [partnerUsername, setPartnerUsername] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [timeLeft, setTimeLeft] = useState(60);
  const [activeUsers, setActiveUsers] = useState<Profile[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Fetch some active users for the display
    const fetchActiveUsers = async () => {
      const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .gt('last_seen_at', fiveMinsAgo)
        .neq('id', user?.id)
        .limit(10);
      
      if (data) setActiveUsers(data as Profile[]);
    };
    
    if (user) {
      fetchActiveUsers();
    }

    return () => {
      clearTimeout(timeoutRef.current!);
      clearInterval(countdownRef.current!);
    };
  }, [user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const startSearch = async () => {
    if (!session) return;
    setPhase('searching');
    setTimeLeft(60);

    // Subscribe to our queue row to see if we get matched
    const matchChannel = supabase.channel(`queue:${user!.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'random_pairing_queue',
        filter: `user_id=eq.${user!.id}`
      }, async (payload) => {
        if (payload.new.status === 'matched' && payload.new.chat_id) {
          clearTimeout(timeoutRef.current!);
          clearInterval(countdownRef.current!);
          
          const { data: p } = await supabase.from('chat_participants')
            .select('user_id')
            .eq('chat_id', payload.new.chat_id)
            .neq('user_id', user!.id)
            .single();
            
          let pName = 'Anonymous';
          if (p) {
            const { data: profile } = await supabase.from('profiles').select('username').eq('id', p.user_id).single();
            if (profile) pName = profile.username;
          }

          setChatId(payload.new.chat_id);
          setPartnerUsername(pName);
          setPhase('matched');
          matchChannel.unsubscribe();
        }
      })
      .subscribe();

    // Call postgres RPC instead of edge function
    const { data: result } = await supabase.rpc('join_random_queue');
    const matchData = result as any;

    if (matchData?.matched) {
      // Matched immediately
      clearTimeout(timeoutRef.current!);
      clearInterval(countdownRef.current!);
      setChatId(matchData.chat_id);
      setPartnerUsername(matchData.partner_username);
      setPhase('matched');
      matchChannel.unsubscribe();
      return;
    }

    // Start 60s countdown
    countdownRef.current = setInterval(() => setTimeLeft(t => t - 1), 1000);

    timeoutRef.current = setTimeout(async () => {
      clearInterval(countdownRef.current!);
      matchChannel.unsubscribe();
      // Leave queue
      await supabase.rpc('leave_random_queue');
      setPhase('timeout');
    }, 60000);
  };

  // Subscribe to chat messages when matched
  useEffect(() => {
    if (!chatId || phase !== 'matched') return;

    // Load existing messages
    supabase.from('messages').select('*').eq('chat_id', chatId)
      .order('created_at', { ascending: true }).then(({ data }) => setMessages((data as Message[]) || []));

    const sub = supabase.channel(`random-chat:${chatId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `chat_id=eq.${chatId}`
      }, (payload) => setMessages(prev => [...prev, payload.new as Message]))
      .subscribe();

    return () => { sub.unsubscribe(); };
  }, [chatId, phase]);

  const disconnect = async () => {
    if (session) {
      await supabase.rpc('leave_random_queue');
      if (chatId) {
        await supabase.from('chats').update({ active: false }).eq('id', chatId);
      }
    }
    navigate('/');
  };

  const sendMessage = async () => {
    const msg = text.trim();
    if (!msg || !chatId || !user) return;
    setText('');
    await supabase.from('messages').insert({
      chat_id: chatId, sender_id: user.id, content: msg
    });
    await supabase.from('chats').update({ last_message_at: new Date().toISOString() }).eq('id', chatId);
  };

  const handleEmoji = (emojiData: EmojiClickData) => {
    setText(prev => prev + emojiData.emoji);
    setShowEmoji(false);
  };

  if (phase === 'matched' && chatId) {
    return (
      <div className="conversation-page">
        <div className="page-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
            <div className="avatar avatar-sm" style={{ background: 'linear-gradient(135deg, #a855f7, #7c3aed)' }}>
              {partnerUsername[0]?.toUpperCase() || '?'}
            </div>
            <div>
              <div className="page-header-title" style={{ fontSize: '0.9375rem' }}>@{partnerUsername}</div>
              <div className="page-header-subtitle" style={{ color: '#22D3EE' }}>● Connected via Random Chat</div>
            </div>
          </div>
          <button className="btn btn-danger" style={{ fontSize: '0.8125rem', padding: '6px 14px' }} onClick={disconnect}>
            <X size={16} /> Disconnect
          </button>
        </div>

        <div style={{ background: 'rgba(168, 85, 247, 0.05)', borderBottom: '1px solid rgba(168, 85, 247, 0.15)', padding: '8px 20px', fontSize: '0.75rem', color: '#94A3B8' }}>
          ⚡ Anonymous random chat — messages will be deleted 1 hour after disconnect
        </div>

        <div className="messages-container">
          {messages.map(msg => (
            <div key={msg.id} className={`message-row ${msg.sender_id === user?.id ? 'sent' : 'received'} animate-fade-in`}>
              <div className={`message-bubble ${msg.sender_id === user?.id ? 'sent' : 'received'}`}
                style={msg.sender_id !== user?.id ? { background: 'rgba(168, 85, 247, 0.15)', borderColor: 'rgba(168, 85, 247, 0.3)' } : {}}>
                <div className="bubble-content">{msg.content}</div>
                <div className="bubble-time">{format(new Date(msg.created_at), 'HH:mm')}</div>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {showEmoji && (
          <div className="emoji-picker-wrapper">
            <EmojiPicker theme={Theme.DARK} onEmojiClick={handleEmoji} width={320} height={360} />
          </div>
        )}

        <div className="message-input-container">
          <button className="btn btn-ghost btn-icon" onClick={() => setShowEmoji(v => !v)}>
            {showEmoji ? <X size={20} /> : <Smile size={20} />}
          </button>
          <textarea className="message-input" placeholder="Type a message..."
            value={text} onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            rows={1} style={{ resize: 'none' }} />
          <button className="send-btn" onClick={sendMessage} disabled={!text.trim()}>
            <Send size={18} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="random-chat-page">
      {phase === 'idle' && (
        <>
          <div className="random-chat-icon">
            <Shuffle size={36} color="white" />
          </div>
          <div>
            <h2 style={{ color: 'var(--color-text)', marginBottom: 8 }}>Random Chat</h2>
            <p style={{ color: 'var(--color-text-secondary)', maxWidth: 280, margin: '0 auto' }}>
              Connect anonymously with a random user. Text & emoji only. No history saved.
            </p>
          </div>
          <button className="btn btn-primary btn-lg" onClick={startSearch} style={{ marginTop: 24, marginBottom: 24 }}>
            <Shuffle size={18} /> Start Random Chat
          </button>

          {activeUsers.length > 0 && (
            <div style={{ marginTop: 24, width: '100%', maxWidth: 400 }}>
              <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 12, textAlign: 'left' }}>
                Currently Active Users ({activeUsers.length}{activeUsers.length === 10 ? '+' : ''})
              </div>
              <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 12, WebkitOverflowScrolling: 'touch' }}>
                {activeUsers.map(u => (
                  <div key={u.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 60 }}>
                    <div className="avatar avatar-md" style={{ position: 'relative' }}>
                      {u.avatar_url ? (
                        <img src={u.avatar_url} alt={u.full_name} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                      ) : (
                        u.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
                      )}
                      <div style={{ position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, backgroundColor: '#22c55e', borderRadius: '50%', border: '2px solid var(--color-surface)' }} />
                    </div>
                    <span style={{ fontSize: '0.75rem', color: 'var(--color-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 64 }}>
                      {u.full_name.split(' ')[0]}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {phase === 'searching' && (
        <>
          <div className="random-chat-icon">
            <Shuffle size={36} color="white" />
          </div>
          <div>
            <h2 style={{ color: 'var(--color-text)', marginBottom: 8 }}>Finding a match...</h2>
            <p style={{ color: 'var(--color-text-secondary)' }}>Looking for someone to connect with</p>
          </div>
          <div className="searching-animation">
            <div className="dot" />
            <div className="dot" />
            <div className="dot" />
          </div>
          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            Timeout in <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{timeLeft}s</span>
          </div>
          <button className="btn btn-secondary" onClick={() => { clearTimeout(timeoutRef.current!); clearInterval(countdownRef.current!); setPhase('idle'); }}>
            Cancel
          </button>
        </>
      )}

      {phase === 'timeout' && (
        <>
          <div style={{ width: 80, height: 80, background: 'rgba(248,113,113,0.1)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid rgba(248,113,113,0.3)' }}>
            <X size={36} color="#F87171" />
          </div>
          <div>
            <h2 style={{ color: 'var(--color-text)', marginBottom: 8 }}>No one available</h2>
            <p style={{ color: 'var(--color-text-secondary)' }}>No one available right now. Try again later.</p>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button className="btn btn-primary" onClick={() => { setPhase('idle'); setTimeLeft(60); }}>Try Again</button>
            <button className="btn btn-secondary" onClick={() => navigate('/')}>Go Back</button>
          </div>
        </>
      )}
    </div>
  );
}
