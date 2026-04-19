/**
 * CallOverlay.tsx — Production WebRTC Call System
 *
 * FIXED BUGS:
 * ① Race condition: caller now queues ICE candidates and only subscribes
 *   to the signal channel AFTER getting the real DB callId — receiver
 *   can never send the answer before the caller is listening.
 * ② connectionState alone is unreliable; also listen to iceConnectionState
 *   and trigger 'connected' on ontrack.
 * ③ Audio element properly managed via ref, not document.getElementById.
 * ④ Removed unreliable free TURN server (was throwing 400s).
 * ⑤ Full mobile responsiveness — 100dvh, touch targets, safe areas.
 */

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  PhoneOff, Mic, MicOff, Video as VideoIcon, VideoOff,
  Phone, X, PhoneIncoming, PhoneMissed, RotateCcw
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

// ─── Constants ────────────────────────────────────────────────────────────────
const RINGTONE_URL  = 'https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3';
const DIALTONE_URL  = 'https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3';
const CALL_TIMEOUT  = 60_000;

// Only reliable public STUN servers — TURN via openrelay was returning 400s
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
];

// ─── Types ────────────────────────────────────────────────────────────────────
type CallStatus = 'dialing' | 'ringing' | 'connecting' | 'connected' | 'declined' | 'declined';

interface CallSession {
  callId:        string;
  isIncoming:    boolean;
  type:          'audio' | 'video';
  partnerId:     string;
  partnerName:   string;
  partnerAvatar: string | null;
  offerSdp:      RTCSessionDescriptionInit | null;
}

// ─── Global styles ────────────────────────────────────────────────────────────
const STYLES = `
  @keyframes callPulse {
    0%   { transform: scale(1);    opacity: 0.6; }
    50%  { transform: scale(1.25); opacity: 0.08; }
    100% { transform: scale(1);    opacity: 0.6; }
  }
  @keyframes callFadeIn  { from { opacity: 0 } to { opacity: 1 } }
  @keyframes callSlideUp {
    from { transform: translateY(48px) scale(0.94); opacity: 0 }
    to   { transform: translateY(0)    scale(1);    opacity: 1 }
  }
  @keyframes callRing {
    0%,100% { transform: rotate(0)    }
    20%     { transform: rotate(-18deg) }
    40%     { transform: rotate(18deg)  }
    60%     { transform: rotate(-10deg) }
    80%     { transform: rotate(10deg)  }
  }
  .call-btn-hover:hover { transform: scale(1.1) !important; }
`;

// ─── AvatarCircle ─────────────────────────────────────────────────────────────
function AvatarCircle({ name, src, size = 96, pulse = false }: {
  name: string; src: string | null; size?: number; pulse?: boolean;
}) {
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {pulse && <>
        <div style={{
          position: 'absolute', inset: -(size * 0.1), borderRadius: '50%',
          border: '2px solid rgba(56,189,248,0.55)',
          animation: 'callPulse 1.7s ease-in-out infinite'
        }} />
        <div style={{
          position: 'absolute', inset: -(size * 0.22), borderRadius: '50%',
          border: '2px solid rgba(56,189,248,0.22)',
          animation: 'callPulse 1.7s 0.55s ease-in-out infinite'
        }} />
      </>}
      <div style={{
        width: size, height: size, borderRadius: '50%', overflow: 'hidden',
        border: '3px solid rgba(56,189,248,0.35)',
        background: 'linear-gradient(135deg,#1e293b,#0f172a)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
      }}>
        {src
          ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ fontSize: size * 0.38, fontWeight: 700, color: '#94a3b8' }}>
              {name?.[0]?.toUpperCase() || '?'}
            </span>
        }
      </div>
    </div>
  );
}

// ─── ControlBtn ───────────────────────────────────────────────────────────────
function ControlBtn({ children, onClick, active, danger, label }: {
  children: React.ReactNode; onClick: () => void;
  active?: boolean; danger?: boolean; label: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <button
        onClick={onClick}
        className="call-btn-hover"
        style={{
          width: danger ? 64 : 56, height: danger ? 64 : 56, borderRadius: '50%',
          cursor: 'pointer', border: 'none', transition: 'transform 0.15s, opacity 0.15s',
          background: danger ? '#ef4444'
            : active  ? 'rgba(239,68,68,0.22)'
            : 'rgba(255,255,255,0.13)',
          outline: active && !danger ? '1px solid rgba(239,68,68,0.4)' : 'none',
          color: active && !danger ? '#ef4444' : 'white',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: danger ? '0 6px 24px rgba(239,68,68,0.45)' : 'none',
          // Mobile: ensure tap target is at least 48px
          minWidth: 48, minHeight: 48
        }}
      >{children}</button>
      <span style={{ color: '#64748b', fontSize: '0.68rem', userSelect: 'none', letterSpacing: '0.02em' }}>
        {label}
      </span>
    </div>
  );
}

// ─── IncomingCallModal ────────────────────────────────────────────────────────
function IncomingCallModal({ session, onAccept, onReject }: { session: CallSession; onAccept: () => void; onReject: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setElapsed(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const a = new Audio(RINGTONE_URL);
    a.loop = true;
    a.play().catch(() => {});
    return () => { a.pause(); a.src = ''; };
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(20px)',
      animation: 'callFadeIn 0.2s ease',
      // Mobile safe area
      paddingBottom: 'env(safe-area-inset-bottom)',
      paddingTop: 'env(safe-area-inset-top)',
    }}>
      <div style={{
        background: 'linear-gradient(145deg, #1e293b 0%, #0f172a 100%)',
        borderRadius: 28, padding: '44px 40px 36px',
        boxShadow: '0 32px 80px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.06)',
        textAlign: 'center', width: 'min(340px, 90vw)',
        animation: 'callSlideUp 0.35s cubic-bezier(0.34,1.56,0.64,1)'
      }}>
        <div style={{ marginBottom: 20 }}>
          <AvatarCircle name={session.partnerName} src={session.partnerAvatar} size={88} pulse />
        </div>

        <div style={{
          color: '#38bdf8', fontSize: '0.72rem', letterSpacing: '0.12em',
          textTransform: 'uppercase', marginBottom: 6,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5
        }}>
          <PhoneIncoming size={12} style={{ animation: 'callRing 1s ease-in-out infinite' }} />
          Incoming {session.type} call
        </div>

        <h2 style={{ color: '#f1f5f9', margin: '0 0 4px', fontSize: 'clamp(1.2rem, 5vw, 1.5rem)', fontWeight: 700 }}>
          {session.partnerName}
        </h2>
        <p style={{ color: disconnecting ? '#ef4444' : '#475569', fontSize: '0.83rem', margin: '0 0 36px', fontWeight: disconnecting ? 600 : 400 }}>
          {disconnecting ? 'Call disconnected...' : `Ringing${elapsed > 0 ? ` · ${elapsed}s` : '...'}`}
        </p>

        <div style={{ display: 'flex', justifyContent: 'center', gap: 'clamp(32px, 12vw, 60px)' }}>
          {[
            { label: 'Decline', icon: <X size={26} />, color: '#ef4444', shadow: 'rgba(239,68,68,0.5)', fn: () => {
              if (disconnecting) return;
              setDisconnecting(true);
              setTimeout(() => onReject(), 1000);
            }},
            { label: 'Accept',  icon: <Phone size={26} />, color: '#22c55e', shadow: 'rgba(34,197,94,0.5)', fn: () => !disconnecting && onAccept() }
          ].map(b => (
            <div key={b.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <button onClick={b.fn} className="call-btn-hover" style={{
                width: 68, height: 68, borderRadius: '50%', background: b.color,
                border: 'none', color: 'white', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 6px 24px ${b.shadow}`, transition: 'transform 0.15s',
                // Extra animation for accept button
                animation: b.label === 'Accept' ? 'callRing 1s 1s ease-in-out infinite' : 'none'
              }}>{b.icon}</button>
              <span style={{ color: '#64748b', fontSize: '0.75rem' }}>{b.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── ActiveCallInterface ──────────────────────────────────────────────────────
function ActiveCallInterface({ session, onClose }: { session: CallSession; onClose: () => void }) {
  const { user } = useAuth();

  const [status,       setStatus]       = useState<CallStatus>(session.isIncoming ? 'ringing' : 'dialing');
  const [localStream,  setLocalStream]  = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [audioMuted,   setAudioMuted]   = useState(false);
  const [videoMuted,   setVideoMuted]   = useState(session.type === 'video'); // video off initially
  const [duration,     setDuration]     = useState(0);
  const [error,        setError]        = useState<string | null>(null);
  const [facingMode,   setFacingMode]   = useState<'user' | 'environment'>('user');

  const peerRef         = useRef<RTCPeerConnection | null>(null);
  const sigChanRef      = useRef<any>(null);
  const dbChanRef       = useRef<any>(null);
  const localStreamRef  = useRef<MediaStream | null>(null);
  const localVidRef     = useRef<HTMLVideoElement | null>(null);
  const remoteVidRef    = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef  = useRef<HTMLAudioElement | null>(null);
  // Queue for outgoing ICE candidates before signal channel is ready
  const outIceQueue     = useRef<RTCIceCandidateInit[]>([]);
  // Queue for incoming ICE candidates before remote desc is set
  const inIceQueue      = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescReady = useRef(false);
  const sigChanReady    = useRef(false);
  const canSendIceRef   = useRef(false);
  const callIdRef       = useRef(session.callId);
  const cancelledRef    = useRef(false);
  const durationRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef      = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const connTimeoutRef   = useRef<ReturnType<typeof setTimeout>  | null>(null);
  const statusRef       = useRef<CallStatus>(session.isIncoming ? 'ringing' : 'dialing');

  const setStatusSafe = useCallback((s: CallStatus) => {
    if (cancelledRef.current) return;
    statusRef.current = s;
    setStatus(s);
  }, []);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ── Duration timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (status === 'connected') {
      durationRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    }
    return () => { if (durationRef.current) clearInterval(durationRef.current); };
  }, [status]);

  // ── Dial/ring tones ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== 'dialing' && status !== 'ringing') return;
    const a = new Audio(status === 'ringing' ? RINGTONE_URL : DIALTONE_URL);
    a.loop = true;
    a.play().catch(() => {});
    return () => { a.pause(); a.src = ''; };
  }, [status]);

  // ── Bind local video ref ────────────────────────────────────────────────────
  useEffect(() => {
    if (localVidRef.current && localStream) {
      localVidRef.current.srcObject = localStream;
      localVidRef.current.play().catch(() => {});
    }
  }, [localStream]);

  // ── Bind remote stream to element ───────────────────────────────────────────
  useEffect(() => {
    if (!remoteStream) return;
    if (session.type === 'video' && remoteVidRef.current) {
      remoteVidRef.current.srcObject = remoteStream;
      remoteVidRef.current.play().catch(() => {});
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.play().catch(() => {});
    }
  }, [remoteStream, session.type]);

  // ── Get local media ─────────────────────────────────────────────────────────
  const getMedia = useCallback(async (fMode: 'user' | 'environment' = 'user'): Promise<MediaStream | null> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: session.type === 'video'
          ? { facingMode: fMode, width: { ideal: 1280 }, height: { ideal: 720 } }
          : false
      });
      
      // Feature request: video starts OFF manually
      if (session.type === 'video') {
        stream.getVideoTracks().forEach(t => t.enabled = false);
      }
      
      setLocalStream(stream);
      localStreamRef.current = stream;
      return stream;
    } catch (e: any) {
      const msg = e?.name === 'NotAllowedError'
        ? 'Microphone/camera permission denied. Please allow access in browser settings.'
        : `Could not access media: ${e?.message}`;
      setError(msg);
      return null;
    }
  }, [session.type]);

  // ── Drain incoming ICE queue ────────────────────────────────────────────────
  const drainInIce = useCallback(async () => {
    const pc = peerRef.current;
    if (!pc) return;
    while (inIceQueue.current.length > 0) {
      const c = inIceQueue.current.shift()!;
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
  }, []);

  // ── Send signal via broadcast ───────────────────────────────────────────────
  const sendSignal = useCallback((evt: string, payload: Record<string, unknown>) => {
    sigChanRef.current?.send({ type: 'broadcast', event: evt, payload });
  }, []);

  // ── Drain outgoing ICE queue ────────────────────────────────────────────────
  const drainOutIce = useCallback(() => {
    if (!canSendIceRef.current || !sigChanReady.current) return;
    if (outIceQueue.current.length > 0) {
      const candidates = [...outIceQueue.current];
      outIceQueue.current = [];
      sendSignal('ice-batch', { candidates, uid: user?.id });
    }
  }, [sendSignal, user?.id]);

  // Handle batch sending for live 'onicecandidate' events
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueIceCandidate = useCallback((c: RTCIceCandidateInit) => {
    outIceQueue.current.push(c);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(() => {
        drainOutIce();
        batchTimerRef.current = null;
      }, 250); // Bundle ICE candidates every 250ms
    }
  }, [drainOutIce]);

  // ── Receive ICE candidate ───────────────────────────────────────────────────
  const handleRemoteIce = useCallback(async (candidate: RTCIceCandidateInit) => {
    if (!remoteDescReady.current) {
      inIceQueue.current.push(candidate);
      return;
    }
    try {
      if (peerRef.current?.signalingState !== 'closed')
        await peerRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (_) {}
  }, []);

  // ── Update DB call status ───────────────────────────────────────────────────
  const updateStatus = useCallback(async (s: string, extra?: Record<string, unknown>) => {
    await supabase.from('calls').update({ status: s, ...extra }).eq('id', callIdRef.current);
  }, []);

  // ── Subscribe to a signal broadcast channel ─────────────────────────────────
  const subscribeSignalChannel = useCallback((callId: string, onReady: () => void) => {
    if (sigChanRef.current) supabase.removeChannel(sigChanRef.current);

    const ch = supabase.channel(`call-sig-${callId}`, {
      config: { broadcast: { self: false } }
    });
    sigChanRef.current = ch;

    ch
      .on('broadcast', { event: 'answer' }, async (msg) => {
        if (session.isIncoming) return;
        const pc = peerRef.current;
        if (!pc || pc.signalingState === 'closed') return;
        console.log('[WebRTC] 📨 Received answer SDP via broadcast');
        try {
          if (!remoteDescReady.current) {
            await pc.setRemoteDescription(new RTCSessionDescription(msg.payload.sdp as RTCSessionDescriptionInit));
            remoteDescReady.current = true;
            await drainInIce();
            
            canSendIceRef.current = true;
            drainOutIce();
            
            if (statusRef.current !== 'connected') {
              setStatusSafe('connecting');
              // Safety: If stuck in connecting for 15s, fail the call
              if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
              connTimeoutRef.current = setTimeout(() => {
                if (statusRef.current === 'connecting' && !cancelledRef.current) {
                  setError('Connection failed. Please check your internet or retry.');
                }
              }, 15000);
            }
          }
        } catch (e) { console.error('[WebRTC] setRemoteDesc(answer) error:', e); }
      })
      .on('broadcast', { event: 'ice' }, (msg) => {
        if (msg.payload?.uid === user?.id) return;
        if (msg.payload?.c) handleRemoteIce(msg.payload.c as RTCIceCandidateInit);
      })
      .on('broadcast', { event: 'ice-batch' }, (msg) => {
        if (msg.payload?.uid === user?.id) return;
        const candidates = msg.payload?.candidates as RTCIceCandidateInit[];
        if (Array.isArray(candidates)) {
          candidates.forEach(c => handleRemoteIce(c));
        }
      })
      .on('broadcast', { event: 'end' }, () => {
        if (!cancelledRef.current) { setStatusSafe('declined'); setTimeout(onClose, 1500); }
      })
      .subscribe((s) => {
        console.log('[Signal] Channel status:', s, 'for:', callId);
        if (s === 'SUBSCRIBED') {
          sigChanReady.current = true;
          onReady();
        }
      });

    return ch;
  }, [session.isIncoming, user?.id, drainInIce, drainOutIce, handleRemoteIce, setStatusSafe, onClose]);

  // ── Subscribe to DB status updates ─────────────────────────────────────────
  const subscribeDbChannel = useCallback((callId: string) => {
    if (dbChanRef.current) supabase.removeChannel(dbChanRef.current);

    const ch = supabase.channel(`call-db-${callId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}`
      }, async (payload) => {
        const row = payload.new as any;
        const s = row.status;
        console.log('[Call] DB status:', s);
        
        if (s === 'rejected') { setStatusSafe('declined'); setTimeout(onClose, 2500); return; }
        if (s === 'declined')    { setStatusSafe('declined');    setTimeout(onClose, 1500); return; }
        if (s === 'missed')   { setStatusSafe('declined');    setTimeout(onClose, 2000); return; }

        if (s === 'accepted' && row.sdp && !session.isIncoming) {
           const pc = peerRef.current;
           if (pc && pc.signalingState !== 'closed' && !remoteDescReady.current) {
             console.log('[WebRTC] 📨 Received answer SDP via DB');
             try {
                await pc.setRemoteDescription(new RTCSessionDescription(row.sdp));
                remoteDescReady.current = true;
                await drainInIce();
                
                canSendIceRef.current = true;
                drainOutIce();
                
                if (statusRef.current !== 'connected') {
                  setStatusSafe('connecting');
                }
             } catch (e) {
                console.error('[WebRTC] DB setRemoteDesc error:', e);
             }
           }
        }
      })
      .subscribe();

    dbChanRef.current = ch;
  }, [setStatusSafe, onClose, session.isIncoming, drainInIce, drainOutIce]);

  // Fallback DB Polling to ensure we don't miss state changes
  useEffect(() => {
    const t = setInterval(async () => {
      const cid = callIdRef.current;
      if (!cid || cancelledRef.current || statusRef.current === 'declined') return;
      const { data, error } = await supabase.from('calls').select('status, sdp').eq('id', cid).single();
      if (!data || error) return;
      
      const s = data.status;
      if (s === 'rejected' && statusRef.current !== 'declined') { setStatusSafe('declined'); setTimeout(onClose, 2500); }
      else if ((s === 'declined' || s === 'missed') && statusRef.current !== 'declined') { setStatusSafe('declined'); setTimeout(onClose, 1500); }
      else if (s === 'accepted' && data.sdp && !session.isIncoming) {
         const pc = peerRef.current;
         if (pc && pc.signalingState !== 'closed' && !remoteDescReady.current) {
             console.log('[WebRTC] 📨 Received answer SDP via Poll');
             try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                remoteDescReady.current = true;
                await drainInIce();
                canSendIceRef.current = true;
                drainOutIce();
                if (statusRef.current !== 'connected') setStatusSafe('connecting');
             } catch (e) { console.error('[WebRTC] Poll setRemoteDesc error:', e); }
         }
      }
    }, 2500);
    return () => clearInterval(t);
  }, [session.isIncoming, drainInIce, drainOutIce, setStatusSafe, onClose]);

  // ── Create peer connection ──────────────────────────────────────────────────
  const createPC = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.ontrack = (evt) => {
      console.log('[WebRTC] 🎥 ontrack — streams:', evt.streams.length, 'kind:', evt.track.kind);
      if (evt.streams[0]) {
        setRemoteStream(evt.streams[0]);
        // Trigger connected state as soon as we receive media
        if (statusRef.current !== 'connected') {
          setStatusSafe('connected');
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log('[WebRTC] connectionState:', s);
      if (s === 'connected') {
        setStatusSafe('connected');
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      }
      if (s === 'failed' || s === 'closed') {
        if (!cancelledRef.current) { setStatusSafe('declined'); setTimeout(onClose, 2000); }
      }
    };

    // iceConnectionState is more reliable for detecting actual media flow
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log('[WebRTC] iceConnectionState:', s);
      if (s === 'connected' || s === 'completed') {
        setStatusSafe('connected');
        if (connTimeoutRef.current) { clearTimeout(connTimeoutRef.current); connTimeoutRef.current = null; }
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      }
      if (s === 'failed') {
        console.log('[WebRTC] ICE failed — trying ICE restart');
        pc.restartIce(); // automatic ICE restart on failure
      }
    };

    pc.onicecandidate = (evt) => {
      if (!evt.candidate) return;
      const c = evt.candidate.toJSON();
      queueIceCandidate(c);
    };

    pc.onsignalingstatechange = () => console.log('[WebRTC] signalingState:', pc.signalingState);
    pc.onicegatheringstatechange = () => console.log('[WebRTC] iceGatheringState:', pc.iceGatheringState);

    peerRef.current = pc;
    return pc;
  }, [sendSignal, setStatusSafe, onClose, user?.id]);

  // ── MAIN CALL INIT ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;

    async function init() {
      const pc = createPC();

      if (session.isIncoming) {
        // ════════════════════════════════════════════════════════════════════
        // RECEIVER FLOW
        // callId is the real DB id from the postgres_changes INSERT event
        // offerSdp is the caller's SDP from the DB row
        // ════════════════════════════════════════════════════════════════════
        callIdRef.current = session.callId;
        console.log('[WebRTC] 📲 Receiver flow for call:', session.callId);

        // Get local media
        const stream = await getMedia();
        if (!stream || cancelledRef.current) return;

        // Add tracks BEFORE setRemoteDescription / createAnswer
        stream.getTracks().forEach(t => {
          console.log('[WebRTC] Receiver adding track:', t.kind);
          pc.addTrack(t, stream);
        });

        // Set remote description (caller's offer from DB)
        await pc.setRemoteDescription(new RTCSessionDescription(session.offerSdp!));
        remoteDescReady.current = true;
        await drainInIce();

        // Create answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log('[WebRTC] ✅ Receiver created answer');

        if (cancelledRef.current) return;

        // Subscribe to signal channel with real callId, then send answer
        subscribeSignalChannel(session.callId, () => {
          sendSignal('answer', { sdp: answer });
          console.log('[WebRTC] 📤 Receiver sent answer via broadcast');
          
          // Receiver can start sending ICE once answer is sent
          canSendIceRef.current = true;
          drainOutIce();
        });

        // Subscribe to DB for declined/missed events
        subscribeDbChannel(session.callId);

        // Update DB status and SAVE ANSWER for bulletproof signaling
        await updateStatus('accepted', { sdp: answer });
        if (statusRef.current !== 'connected') {
          setStatusSafe('connecting');
        }

      } else {
        // ════════════════════════════════════════════════════════════════════
        // CALLER FLOW
        // No tempId race condition — we insert first, THEN subscribe
        // ════════════════════════════════════════════════════════════════════
        console.log('[WebRTC] 📞 Caller flow to:', session.partnerId);

        // 1. Get local media
        const stream = await getMedia();
        if (!stream || cancelledRef.current) return;

        // 2. Add tracks BEFORE createOffer
        stream.getTracks().forEach(t => {
          console.log('[WebRTC] Caller adding track:', t.kind);
          pc.addTrack(t, stream);
        });

        // 3. Create offer + setLocalDescription
        //    ICE gathering starts now — candidates queued in outIceQueue
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log('[WebRTC] ✅ Caller created offer');

        // 4. Fetch caller profile
        const { data: me } = await supabase
          .from('profiles').select('full_name, avatar_url').eq('id', user!.id).single();

        // 5. INSERT into DB → returns real callId
        //    This triggers receiver's postgres_changes INSERT listener
        const { data: rec, error } = await supabase
          .from('calls')
          .insert({
            caller_id:     user!.id,
            receiver_id:   session.partnerId,
            type:          session.type,
            caller_name:   me?.full_name   || 'Unknown',
            caller_avatar: me?.avatar_url  || null,
            status:        'calling',
            sdp:           offer
          })
          .select('id').single();

        if (error || !rec) {
          console.error('[Call] ❌ Insert failed:', error?.message);
          setError('Failed to start call. Please try again.');
          return;
        }

        const realId = rec.id;
        callIdRef.current = realId;
        console.log('[Call] ✅ DB record created:', realId);

        // React 18 Strict Mode fix: If unmounted during DB insert, kill the ghost call immediately
        if (cancelledRef.current) {
           console.log('[Call] ⚠️ Unmounted during init, killing ghost call:', realId);
           supabase.from('calls').update({ status: 'declined' }).eq('id', realId);
           return;
        }

        // 🔥 TRUE REAL-TIME BYPASS: Broadcast directly to receiver instantly
        supabase.channel(`incoming-${session.partnerId}`).send({
          type: 'broadcast',
          event: 'ring',
          payload: {
            callId: realId,
            type: session.type,
            caller_id: user!.id,
            caller_name: me?.full_name || 'Unknown Caller',
            caller_avatar: me?.avatar_url || null,
            sdp: offer
          }
        }).catch(err => console.log('Broadcast err', err));

        // 6. NOW subscribe to signal channel with REAL callId
        //    Receiver hasn't sent answer yet (they're waiting for their
        //    signal channel to subscribe too — no race condition)
        subscribeSignalChannel(realId, () => {
          // On channel SUBSCRIBED: drain queued outgoing ICE candidates
          // (They will only actually send if we already have the remote answer)
          drainOutIce();
        });

        // 7. Subscribe to DB channel with real callId
        subscribeDbChannel(realId);

        // 8. Call timeout
        timeoutRef.current = setTimeout(async () => {
          await supabase.from('calls').update({ status: 'missed' }).eq('id', realId);
          try {
            await supabase.from('messages').insert({
              sender_id: user!.id,
              receiver_id: session.partnerId,
              content: session.type === 'video' ? '📹 Missed video call' : '📞 Missed voice call',
              status: 'sent'
            });
          } catch (e) { console.log('[Call] missed log error', e); }
          if (!cancelledRef.current) { setStatusSafe('declined'); setTimeout(onClose, 2000); }
        }, CALL_TIMEOUT);
      }
    }

    init().catch(e => {
      console.error('[Call] init error:', e);
      setError(`Call error: ${e?.message || 'Unknown error'}`);
    });

    const handleUnload = () => {
      if (callIdRef.current) {
        // Use navigator.sendBeacon or fetch with keepalive if possible, 
        // but for status update we just trigger a quick end broadcast
        sendSignal('end', {});
        // Fire and forget DB update
        updateStatus('declined');
      }
    };
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      console.log('[Call] Cleaning up ActiveCallInterface...');
      window.removeEventListener('beforeunload', handleUnload);
      cancelledRef.current = true;
      localStreamRef.current?.getTracks().forEach(t => { t.enabled = false; t.stop(); });
      
      const pc = peerRef.current;
      if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        if (pc.signalingState !== 'closed') pc.close();
      }
      
      if (sigChanRef.current) supabase.removeChannel(sigChanRef.current);
      if (dbChanRef.current)  supabase.removeChannel(dbChanRef.current);
      if (durationRef.current) clearInterval(durationRef.current);
      if (timeoutRef.current)  clearTimeout(timeoutRef.current);
      if (connTimeoutRef.current) clearTimeout(connTimeoutRef.current);
    };
  }, [user?.id]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const insertCallLog = async (finalStatus: 'declined' | 'rejected' | 'missed' | 'declined') => {
    try {
      const isVideo = session.type === 'video';
      let content = isVideo ? '📹 Video Call' : '📞 Voice Call';
      
      if (finalStatus === 'declined' && duration > 0) {
        content += ` declined • ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}`;
      } else if (finalStatus === 'declined' && duration === 0) {
        content = isVideo ? '📹 Missed video call' : '📞 Missed voice call';
      } else if (finalStatus === 'declined' || finalStatus === 'rejected') {
        content = isVideo ? '📹 Declined video call' : '📞 Declined voice call';
      } else if (finalStatus === 'missed') {
        content = isVideo ? '📹 Missed video call' : '📞 Missed voice call';
      }

      await supabase.from('messages').insert({
        sender_id: user!.id,
        receiver_id: session.partnerId,
        content: content,
        status: 'sent'
      });
    } catch (e) {
      console.error('[CallLog] Failed to insert:', e);
    }
  };

  // const handleDecline = useCallback(async () => {
  //   try {
  //     setStatusSafe('declined');
  //     await updateStatus('rejected');
  //     await insertCallLog('declined');
  //   } catch (e) {
  //     console.warn('[Call] Decline error:', e);
  //   } finally {
  //     onClose();
  //   }
  // }, [updateStatus, insertCallLog, onClose, setStatusSafe]);

  const handleEnd = useCallback(async () => {
    try {
      setStatusSafe('declined');
      sendSignal('end', {});
      await updateStatus('declined');
      await insertCallLog('declined');
    } catch (e) {
      console.warn('[Call] End error:', e);
    } finally {
      // Small Delay to show "Call declined" before closing
      setTimeout(onClose, 1200);
    }
  }, [updateStatus, insertCallLog, onClose, setStatusSafe, sendSignal]);

  const toggleAudio = () => {
    localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = !t.enabled; });
    setAudioMuted(m => !m);
  };

  const toggleVideo = () => {
    localStreamRef.current?.getVideoTracks().forEach(t => { t.enabled = !t.enabled; });
    setVideoMuted(m => !m);
  };

  // ── Camera flip (mobile) ────────────────────────────────────────────────────
  const flipCamera = useCallback(async () => {
    const newMode: 'user' | 'environment' = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(newMode);
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: newMode }
      });
      const pc = peerRef.current;
      const videoTrack = newStream.getVideoTracks()[0];
      if (pc && videoTrack) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(videoTrack);
      }
      // Stop old video track
      localStreamRef.current?.getVideoTracks().forEach(t => t.stop());
      // Merge: keep old audio, use new video
      const combined = new MediaStream([
        ...(localStreamRef.current?.getAudioTracks() || []),
        videoTrack
      ]);
      setLocalStream(combined);
      localStreamRef.current = combined;
    } catch (e) { console.warn('[Camera] Flip failed:', e); }
  }, [facingMode]);

  // ─── Render ────────────────────────────────────────────────────────────────
  const name    = session.partnerName   || 'Unknown';
  const avatar  = session.partnerAvatar;
  const isVideo = session.type === 'video';
  const showVideoUI = status === 'connected' && isVideo;

  const statusLabel: Record<CallStatus, string> = {
    dialing:    'Calling...',
    ringing:    isVideo ? 'Incoming video call' : 'Incoming voice call',
    connecting: 'Connecting...',
    connected:  fmt(duration),
    declined:   'Call declined',
    declined:      'Call declined'
  };
  const statusColor: Record<CallStatus, string> = {
    dialing:    '#38bdf8', ringing:   '#38bdf8',
    connecting: '#f59e0b', connected: '#22c55e',
    declined:   '#ef4444', declined:     '#ef4444'
  };

  if (error) return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000, background: '#0f172a',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', color: 'white', padding: 32, textAlign: 'center',
      paddingBottom: 'env(safe-area-inset-bottom)'
    }}>
      <PhoneMissed size={52} color="#ef4444" style={{ marginBottom: 20 }} />
      <h3 style={{ fontSize: 'clamp(1rem, 4vw, 1.25rem)', margin: '0 0 12px' }}>Call Failed</h3>
      <p style={{ color: '#64748b', maxWidth: 300, lineHeight: 1.6, fontSize: '0.9rem' }}>{error}</p>
      <button onClick={onClose} style={{
        marginTop: 24, padding: '14px 32px', borderRadius: 14,
        background: '#ef4444', border: 'none', color: 'white',
        cursor: 'pointer', fontWeight: 600, fontSize: '0.95rem', minWidth: 120
      }}>Close</button>
    </div>
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000,
      // Use dynamic viewport height for mobile browsers (avoids address bar issues)
      height: '100dvh',
      background: showVideoUI ? '#000' : 'linear-gradient(160deg, #0f172a 0%, #1e293b 100%)',
      display: 'flex', flexDirection: 'column', color: 'white',
      animation: 'callFadeIn 0.3s ease',
      paddingTop: 'env(safe-area-inset-top)',
      paddingBottom: 'env(safe-area-inset-bottom)',
    }}>
      {/* ── Remote video (fullscreen) ─────────────────────────────────────── */}
      {isVideo && (
        <video ref={remoteVidRef} autoPlay playsInline style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover',
          opacity: showVideoUI ? 1 : 0, transition: 'opacity 0.5s'
        }} />
      )}

      {/* ── Remote audio (always present) ────────────────────────────────── */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* ── Video call top bar ─────────────────────────────────────────────── */}
      {showVideoUI && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 4,
          padding: '16px 20px 40px',
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.6), transparent)',
          display: 'flex', alignItems: 'center', gap: 10,
          paddingTop: 'calc(env(safe-area-inset-top) + 16px)'
        }}>
          <AvatarCircle name={name} src={avatar} size={36} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{name}</div>
            <div style={{ color: '#22c55e', fontSize: '0.78rem', fontWeight: 600 }}>{fmt(duration)}</div>
          </div>
        </div>
      )}

      {/* ── Main center area ─────────────────────────────────────────────────── */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        position: 'relative', zIndex: 1,
        padding: '24px clamp(16px, 5vw, 40px)',
        opacity: showVideoUI ? 0 : 1, pointerEvents: showVideoUI ? 'none' : 'auto',
        transition: 'opacity 0.5s'
      }}>
        <div style={{ textAlign: 'center', marginBottom: status === 'ringing' ? 0 : 48 }}>
          <div style={{ marginBottom: 20 }}>
            <AvatarCircle name={name} src={avatar}
              size={Math.min(130, window.innerWidth * 0.32)}
              pulse={status === 'dialing' || status === 'ringing'} />
          </div>
          <h2 style={{
            fontSize: 'clamp(1.4rem, 6vw, 1.9rem)',
            fontWeight: 700, margin: '0 0 8px', letterSpacing: '-0.02em'
          }}>{name}</h2>
          <p style={{
            fontSize: '0.88rem', textTransform: 'uppercase', letterSpacing: '0.1em',
            margin: 0, color: statusColor[status], fontWeight: 600
          }}>{statusLabel[status]}</p>
        </div>

        {/* Redundant center buttons removed - acceptance is handled via Modal */}
      </div>

      {/* ── Local video PiP ──────────────────────────────────────────────────── */}
      {isVideo && localStream && (
        <div style={{
          position: 'absolute',
          bottom: 'calc(env(safe-area-inset-bottom) + 110px)',
          right: 16, zIndex: 5,
          width: 'clamp(80px, 22vw, 110px)',
          height: 'clamp(110px, 30vw, 155px)',
          borderRadius: 14, overflow: 'hidden',
          boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
          border: '2px solid rgba(255,255,255,0.2)'
        }}>
          <video ref={localVidRef} autoPlay playsInline muted style={{
            width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)'
          }} />
        </div>
      )}

      {/* ── Control bar ──────────────────────────────────────────────────────── */}
      {(status === 'dialing' || status === 'connecting' || status === 'connected' || status === 'ringing') && (
        <div style={{
          display: 'flex', justifyContent: 'center', alignItems: 'flex-end',
          gap: 'clamp(12px, 4vw, 24px)',
          padding: `16px clamp(16px, 5vw, 40px) clamp(24px, 6vw, 44px)`,
          position: 'relative', zIndex: 4,
          background: showVideoUI
            ? 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)'
            : 'transparent'
        }}>
          {/* Controls are available even before full connection */}
          <>
            <ControlBtn onClick={toggleAudio} active={audioMuted} label={audioMuted ? 'Unmute' : 'Mute'}>
              {audioMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </ControlBtn>

            {isVideo && <>
              <ControlBtn onClick={toggleVideo} active={videoMuted} label={videoMuted ? 'Cam On' : 'Cam Off'}>
                {videoMuted ? <VideoOff size={20} /> : <VideoIcon size={20} />}
              </ControlBtn>
              <ControlBtn onClick={flipCamera} label="Flip">
                <RotateCcw size={20} />
              </ControlBtn>
            </>}
          </>

          <ControlBtn danger onClick={handleEnd} label="End">
            <PhoneOff size={22} />
          </ControlBtn>
        </div>
      )}
    </div>
  );
}

// ─── CallOverlay (Root, always mounted) ──────────────────────────────────────
export default function CallOverlay() {
  const { user } = useAuth();
  const [incoming, setIncoming] = useState<CallSession | null>(null);
  const [active,   setActive]   = useState<CallSession | null>(null);
  const activeRef = useRef<CallSession | null>(null);
  const processedCallsRef = useRef<Set<string>>(new Set());

  const activate = useCallback((s: CallSession | null) => {
    activeRef.current = s;
    setActive(s);
  }, []);

  // ── Listen for outgoing call dispatch ───────────────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (!d || String(d.type || '').startsWith('group-')) return;
      if (activeRef.current) { console.warn('[CallOverlay] Already in call'); return; }
      console.log('[CallOverlay] Outgoing call to:', d.partnerId);
      activate({
        callId:        '',              // filled after DB insert in ActiveCallInterface
        isIncoming:    false,
        type:          d.type || 'audio',
        partnerId:     d.partnerId,
        partnerName:   d.partnerName   || 'Unknown',
        partnerAvatar: d.partnerAvatar || null,
        offerSdp:      null
      });
    };
    document.addEventListener('init-call', handler);
    return () => document.removeEventListener('init-call', handler);
  }, []);

  // ── Listen for incoming calls via Supabase Realtime (with Bulletproof Fallback) ──────
  useEffect(() => {
    if (!user?.id) return;
    
    // Bulletproof Fallback: Fetch any currently ringing calls repeatedly
    // This entirely circumvents Supabase Realtime limits/hangups on free tiers
    const checkActiveCalls = async () => {
      if (activeRef.current) return;
      
      const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
      const { data, error } = await supabase
        .from('calls')
        .select('*')
        .eq('receiver_id', user.id)
        .eq('status', 'calling')
        .gte('created_at', oneMinuteAgo)
        .order('created_at', { ascending: false })
        .limit(1);
        
      if (!error && data && data.length > 0) {
        const row = data[0];
        
        // Prevent setting state repeatedly if it's already ringing, or if we locally processed it
        if (processedCallsRef.current.has(row.id)) return;
        setIncoming(prev => {
          if (prev?.callId === row.id) return prev;
          
          console.log('[CallOverlay] ✅ Found ringing call via fallback fetch!');
          return {
            callId:        row.id,
            isIncoming:    true,
            type:          (row.type as 'audio' | 'video') || 'audio',
            partnerId:     row.caller_id,
            partnerName:   row.caller_name   || 'Unknown Caller',
            partnerAvatar: row.caller_avatar || null,
            offerSdp:      row.sdp
          };
        });
      } else {
        // If the call was rejected/declined/missed, clear incoming overlay
        setIncoming(prev => (prev ? null : prev));
      }
    };
    
    // Initial fetch
    checkActiveCalls();
    
    // Start interval
    const pollInterval = window.setInterval(checkActiveCalls, 3000);

    console.log('[CallOverlay] Listening for calls. user:', user.id);

    const ch = supabase
      .channel(`incoming-${user.id}`)
      .on('broadcast', { event: 'ring' }, async (msg: any) => {
        const { callId, type, caller_id, caller_name, caller_avatar, sdp } = msg.payload;
        if (activeRef.current) {
          await supabase.from('calls').update({ status: 'declined' }).eq('id', callId);
          return;
        }
        if (processedCallsRef.current.has(callId)) return;
        
        setIncoming(prev => {
          if (prev?.callId === callId) return prev;
          console.log('[CallOverlay] ⚡ True Real-Time Broadcast Triggered!');
          return {
            callId, isIncoming: true, type, partnerId: caller_id, partnerName: caller_name, partnerAvatar: caller_avatar, offerSdp: sdp
          };
        });
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'calls',
        filter: `receiver_id=eq.${user.id}`
      }, (payload) => {
        const row = (payload.new || payload.old) as any;
        console.log(`[CallOverlay] 📞 ${payload.eventType} for call:`, row.id, 'status:', row.status);

        if ((payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') && row.status === 'calling') {
          if (activeRef.current) {
            console.warn('[CallOverlay] Busy — auto-rejecting');
            supabase.from('calls').update({ status: 'declined' }).eq('id', row.id);
            return;
          }

          setIncoming({
            callId:        row.id,
            isIncoming:    true,
            type:          (row.type as 'audio' | 'video') || 'audio',
            partnerId:     row.caller_id,
            partnerName:   row.caller_name   || 'Unknown Caller',
            partnerAvatar: row.caller_avatar || null,
            offerSdp:      row.sdp
          });
        } else if (payload.eventType === 'UPDATE') {
          // Caller cancelled or timed out
          if (row.status !== 'calling') {
            setIncoming(prev => (prev?.callId === row.id ? null : prev));
          }
        }
      })
      .subscribe(status => {
        console.log('[CallOverlay] Subscription:', status);
        if (status === 'SUBSCRIBED') checkActiveCalls();
      });

    return () => { 
      clearInterval(pollInterval);
      supabase.removeChannel(ch); 
    };
  }, [user?.id]);

  const acceptCall = useCallback(() => {
    if (!incoming) return;
    processedCallsRef.current.add(incoming.callId);
    const s = { ...incoming };
    setIncoming(null);
    activate(s);
  }, [incoming]);

  const rejectCall = useCallback(async () => {
    if (!incoming) return;
    processedCallsRef.current.add(incoming.callId);
    await supabase.from('calls').update({ status: 'declined' }).eq('id', incoming.callId);
    setIncoming(null);
  }, [incoming]);

  const closeActive = useCallback(() => activate(null), []);

  return (
    <>
      <style>{STYLES}</style>

      {incoming && !active && (
        <IncomingCallModal session={incoming} onAccept={acceptCall} onReject={rejectCall} />
      )}

      {active && (
        <ActiveCallInterface session={active} onClose={closeActive} />
      )}
    </>
  );
}
