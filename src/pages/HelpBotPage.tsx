import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Send, Image, CheckCircle, Clock, AlertCircle, HelpCircle, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { format } from 'date-fns';

type Ticket = {
  id: string;
  subject: string;
  status: 'open' | 'in_progress' | 'resolved';
  created_at: string;
};

type HelpMessage = {
  id: string;
  ticket_id: string;
  sender_role: 'user' | 'admin';
  sender_id: string | null;
  content: string | null;
  media_url: string | null;
  created_at: string;
};

type Phase = 'landing' | 'chat';

const BOT_GREETING = "👋 Hi! I'm the MKP support bot. Please describe your issue below and our admin team will respond as soon as possible. You can also attach a screenshot.";

export default function HelpBotPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const [phase, setPhase] = useState<Phase>('landing');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<HelpMessage[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Track guests if not logged in
  const getGuestId = () => {
    let gid = localStorage.getItem('mkp_guest_id');
    if (!gid) {
      gid = crypto.randomUUID();
      localStorage.setItem('mkp_guest_id', gid);
    }
    return gid;
  };

  const isGuest = !user;
  const guestId = isGuest ? getGuestId() : null;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [subject, setSubject] = useState('');
  const [subjectInput, setSubjectInput] = useState('');
  const [resolvedBanner, setResolvedBanner] = useState(false);

  // FIX: Separate query building to avoid immutable builder chaining bug
  // The original code created a query base then called .eq() on it but didn't
  // re-assign the result for the conditional branch — the base query ran instead.
  useEffect(() => {
    const loadExistingTicket = async () => {
      let data;
      let error;

      if (user) {
        // Logged-in user: look for open ticket by user_id
        // FIX: .maybeSingle() returns null (not 406) when no row exists
        const result = await supabase
          .from('help_tickets')
          .select('*')
          .eq('user_id', user.id)
          .neq('status', 'resolved')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        data = result.data;
        error = result.error;
      } else {
        // Guest: look for open ticket by guest_id
        // FIX: .maybeSingle() returns null (not 406) when no row exists
        const result = await supabase
          .from('help_tickets')
          .select('*')
          .eq('guest_id', guestId)
          .neq('status', 'resolved')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        data = result.data;
        error = result.error;
      }

      if (error) {
        console.error('[HelpBotPage] Load ticket error:', error.message, error.code);
        return; // Don't crash — just show the landing/chat phase as is
      }
      if (data) {
        setTicket(data as Ticket);
        setPhase('chat');
        loadMessages(data.id);
      }
      // data === null means no existing ticket — stay on landing/chat phase
    };

    loadExistingTicket();
  }, [user, guestId]);


  const loadMessages = async (ticketId: string) => {
    const { data, error } = await supabase.from('help_messages')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[HelpBotPage] loadMessages error:', error.message);
      return;
    }
    setMessages((data as HelpMessage[]) || []);
  };

  // Realtime subscription for admin replies
  useEffect(() => {
    if (!ticket) return;
    const sub = supabase.channel(`help-ticket-${ticket.id}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'help_messages',
        filter: `ticket_id=eq.${ticket.id}`,
      }, (payload) => {
        setMessages(prev => {
          // Deduplicate: don't add if already in state
          if (prev.some(m => m.id === payload.new.id)) return prev;
          return [...prev, payload.new as HelpMessage];
        });
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'help_tickets',
        filter: `id=eq.${ticket.id}`,
      }, (payload) => {
        if (payload.new.status === 'resolved') {
          setResolvedBanner(true);
          setTicket(prev => prev ? { ...prev, status: 'resolved' } : prev);
        }
      })
      .subscribe();

    return () => { sub.unsubscribe(); };
  }, [ticket?.id]);

  useEffect(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
  }, [messages.length]);

  const createTicketAndSend = async (content: string, mediaUrl?: string) => {
    setSending(true);
    setErrorMsg(null);

    // FIX: Build insert payload correctly — use guest_id for guests (requires DB schema to have guest_id column)
    const insertPayload = user
      ? { user_id: user.id, subject: subject || 'Support Request', status: 'open' }
      : { guest_id: guestId, subject: subject || 'Guest Support Request', status: 'open' };

    const { data: newTicket, error: ticketErr } = await supabase
      .from('help_tickets')
      .insert(insertPayload)
      .select()
      .single();

    if (ticketErr || !newTicket) {
      console.error('[HelpBotPage] Ticket create error:', ticketErr?.message);
      setErrorMsg(`Failed to create support ticket: ${ticketErr?.message || 'Unknown error'}. Please try again.`);
      setSending(false);
      return;
    }

    console.log('[HelpBotPage] Ticket created:', newTicket.id);
    setTicket(newTicket as Ticket);

    // Send first message
    const { error: msgErr } = await supabase.from('help_messages').insert({
      ticket_id: newTicket.id,
      sender_role: 'user',
      sender_id: user?.id || null,
      content,
      media_url: mediaUrl || null,
    });

    if (msgErr) {
      console.error('[HelpBotPage] First message error:', msgErr.message);
    } else {
      // Load messages to populate state (realtime will also fire)
      loadMessages(newTicket.id);
    }

    setSending(false);
  };

  const sendMessage = async (content?: string, mediaUrl?: string) => {
    const msg = content || text.trim();
    if (!msg && !mediaUrl) return;
    setSending(true);
    setText('');
    setErrorMsg(null);

    if (!ticket) {
      await createTicketAndSend(msg, mediaUrl);
    } else {
      const { error: sendErr } = await supabase.from('help_messages').insert({
        ticket_id: ticket.id,
        sender_role: 'user',
        sender_id: user?.id || null,
        content: msg || null,
        media_url: mediaUrl || null,
      });
      if (sendErr) {
        console.error('[HelpBotPage] sendMessage error:', sendErr.message);
        setErrorMsg(`Failed to send message: ${sendErr.message}`);
      }
    }
    setSending(false);
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);

    const folderName = user?.id || `guest_${guestId}`;
    const fileName = `help/${folderName}/${Date.now()}_${file.name}`;

    const { data, error } = await supabase.storage.from('chat-media').upload(fileName, file);
    if (!error && data) {
      const { data: { publicUrl } } = supabase.storage.from('chat-media').getPublicUrl(fileName);
      await sendMessage('📎 Attached screenshot:', publicUrl);
    } else if (error) {
      console.error('[HelpBotPage] Image upload error:', error.message);
      setErrorMsg('Failed to upload image. Please try again.');
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const startNewTicket = () => {
    setTicket(null);
    setMessages([]);
    setPhase('chat');
    setResolvedBanner(false);
    setErrorMsg(null);
  };

  const statusColor = (s: string) => s === 'resolved' ? '#22c55e' : s === 'in_progress' ? '#f59e0b' : '#38bdf8';
  const statusIcon = (s: string) => s === 'resolved' ? <CheckCircle size={14} /> : s === 'in_progress' ? <Clock size={14} /> : <AlertCircle size={14} />;

  // ── Landing ─────────────────────────────────────────────────────────────────
  if (phase === 'landing') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 32, textAlign: 'center', background: 'var(--color-bg)' }}>
        <div style={{ width: 80, height: 80, borderRadius: '50%', background: 'var(--color-primary-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--color-primary)', animation: 'pulse 2s infinite' }}>
          <HelpCircle size={40} color="var(--color-primary)" />
        </div>
        <div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: 8 }}>Help & Support</h2>
          <p style={{ color: 'var(--color-text-muted)', maxWidth: 280, lineHeight: 1.6 }}>
            Having trouble? Our admin team is here to help. Describe your issue and we'll get back to you quickly.
          </p>
        </div>

        {/* Subject input */}
        <div style={{ width: '100%', maxWidth: 360 }}>
          <input
            className="input"
            style={{ width: '100%', marginBottom: 12 }}
            placeholder="Subject (optional)"
            value={subjectInput}
            onChange={e => setSubjectInput(e.target.value)}
          />
          <button
            className="btn btn-primary btn-lg"
            style={{ width: '100%' }}
            onClick={() => { setSubject(subjectInput || 'Support Request'); setPhase('chat'); }}
          >
            Start Support Chat
          </button>
        </div>

        <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
          <ArrowLeft size={16} /> Go Back
        </button>
      </div>
    );
  }

  // ── Chat Phase ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-bg)' }}>
      {/* Header */}
      <div className="page-header">
        <button className="btn btn-ghost btn-icon" onClick={() => navigate(-1)}><ArrowLeft size={20} /></button>
        <div className="avatar avatar-sm" style={{ background: 'var(--color-primary-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <HelpCircle size={20} color="var(--color-primary)" />
        </div>
        <div style={{ flex: 1 }}>
          <div className="page-header-title">MKP Support</div>
          {ticket && (
            <div className="page-header-subtitle" style={{ display: 'flex', alignItems: 'center', gap: 4, color: statusColor(ticket.status) }}>
              {statusIcon(ticket.status)}
              <span style={{ textTransform: 'capitalize', fontSize: '0.75rem', fontWeight: 600 }}>{ticket.status.replace('_', ' ')}</span>
            </div>
          )}
        </div>
        {ticket?.status === 'resolved' && (
          <button className="btn btn-secondary" style={{ fontSize: '0.75rem', padding: '5px 12px' }} onClick={startNewTicket}>
            New Ticket
          </button>
        )}
      </div>

      {/* Resolved banner */}
      {resolvedBanner && (
        <div style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.875rem', color: '#22c55e' }}>
          <CheckCircle size={16} />
          <span style={{ flex: 1 }}>✅ Your issue has been marked as resolved by admin.</span>
          <button onClick={() => setResolvedBanner(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#22c55e' }}><X size={14} /></button>
        </div>
      )}

      {/* Error banner */}
      {errorMsg && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.875rem', color: '#ef4444' }}>
          <AlertCircle size={16} />
          <span style={{ flex: 1 }}>{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><X size={14} /></button>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 8px' }}>
        {/* Bot greeting */}
        <div className="message-row received animate-fade-in" style={{ marginBottom: 12 }}>
          <div className="avatar avatar-sm" style={{ background: 'var(--color-primary-subtle)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <HelpCircle size={16} color="var(--color-primary)" />
          </div>
          <div className="message-bubble received" style={{ maxWidth: '80%' }}>
            <div className="bubble-content" style={{ fontSize: '0.875rem', lineHeight: 1.5 }}>{BOT_GREETING}</div>
            <div className="bubble-time">Support Bot</div>
          </div>
        </div>

        {messages.map(msg => {
          const isMe = msg.sender_role === 'user';
          return (
            <div key={msg.id} className={`message-row ${isMe ? 'sent' : 'received'} animate-fade-in`}>
              {!isMe && (
                <div className="avatar avatar-sm" style={{ background: 'linear-gradient(135deg,#ef4444,#b91c1c)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '0.65rem', fontWeight: 700 }}>
                  ADM
                </div>
              )}
              <div className={`message-bubble ${isMe ? 'sent' : 'received'}`}>
                {msg.media_url && (
                  <img src={msg.media_url} alt="Screenshot" style={{ maxWidth: '100%', borderRadius: 8, marginBottom: msg.content ? 8 : 0, cursor: 'pointer' }} onClick={() => window.open(msg.media_url!, '_blank')} />
                )}
                {msg.content && <div className="bubble-content">{msg.content}</div>}
                <div className="bubble-time">{format(new Date(msg.created_at), 'HH:mm')}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {ticket?.status === 'resolved' ? (
        <div style={{ padding: 16, textAlign: 'center', background: 'var(--color-surface)', borderTop: '1px solid var(--color-border)', color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
          This ticket is resolved. <button onClick={startNewTicket} style={{ color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Open a new ticket?</button>
        </div>
      ) : (
        <div className="message-input-container">
          <button className="btn btn-ghost btn-icon" onClick={() => fileRef.current?.click()} disabled={uploading} title="Attach screenshot">
            <Image size={20} />
          </button>
          <input type="file" ref={fileRef} style={{ display: 'none' }} accept="image/*" onChange={handleImageUpload} />
          <textarea
            className="message-input"
            placeholder="Describe your issue..."
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            rows={1}
            style={{ resize: 'none' }}
            disabled={sending}
          />
          <button className="send-btn" onClick={() => sendMessage()} disabled={!text.trim() || sending}>
            <Send size={18} />
          </button>
        </div>
      )}
    </div>
  );
}
