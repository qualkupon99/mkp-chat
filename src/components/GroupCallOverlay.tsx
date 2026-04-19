import { useEffect, useState, useRef } from 'react';
import { PhoneOff, Mic, MicOff, Video as VideoIcon, VideoOff, Phone, X, Users, ArrowDown, UserPlus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';

const ringtoneUrl = "https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3";
const dialtoneUrl = "https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3";

function VideoTile({ stream, isLocal, name }: { stream: MediaStream | null, isLocal: boolean, name?: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: '#000', borderRadius: 12, overflow: 'hidden' }}>
      <video
        ref={videoRef}
        autoPlay
        muted={isLocal}
        playsInline
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: isLocal ? 'scaleX(-1)' : 'none'
        }}
      />
      {name && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(0,0,0,0.6)', padding: '2px 8px', borderRadius: 12, fontSize: '0.75rem', color: 'white' }}>
          {name}
        </div>
      )}
    </div>
  );
}

export default function GroupCallOverlay() {
  const { user } = useAuth();
  const [session, setSession] = useState<any>(null);
  
  // Realtime
  useEffect(() => {
    if (!user) return;

    // 1. Listen for OUTGOING calls triggered by UI
    const handleInitCall = (e: any) => {
      const { partnerId, type, partnerName, partnerAvatar, callerName, callerAvatar } = e.detail;
      if (!type.startsWith('group-')) return;

      setSession({
        groupId: partnerId,
        type,
        groupName: partnerName,
        groupAvatar: partnerAvatar,
        callerId: user.id,
        callerName,
        callerAvatar,
        isIncoming: false
      });
    };
    document.addEventListener('init-call', handleInitCall);

    // 2. Listen for INCOMING calls globally (Persistent signaling)
    const discovery = supabase.channel(`call-discovery`)
      .on('broadcast', { event: 'group-call-offer' }, async (payload) => {
        const p = payload.payload;
        if (p.caller_id === user.id) return;
        
        console.log("Group call detected via broadcast:", p);
        
        // Check if we belong to this group
        const { data: participants } = await supabase.from('chat_participants')
          .select('id').eq('chat_id', p.group_id).eq('user_id', user.id).single();
          
        if (participants && !session) {
          console.log("We are in this group! Triggering Overlay...");
          setSession({
            groupId: p.group_id,
            type: p.type,
            groupName: p.group_name || 'Group Call',
            groupAvatar: p.group_avatar,
            callerId: p.caller_id,
            callerName: p.caller_name,
            callerAvatar: p.caller_avatar,
            isIncoming: true,
          });
        }
      }).subscribe();


    return () => {
      document.removeEventListener('init-call', handleInitCall);
      supabase.removeChannel(discovery);
    };
  }, [user, session]);

  if (!session) return null;

  return <GroupCallInterface session={session} onClose={() => setSession(null)} />;
}

function GroupCallInterface({ session, onClose }: { session: any, onClose: () => void }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<'ringing' | 'connecting' | 'connected'>('ringing');
  
  const [isMinimized, setIsMinimized] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(false);

  const handleInvite = () => {
    supabase.channel('call-discovery').send({
         type: 'broadcast', event: 'group-call-offer',
         payload: { 
            group_id: session.groupId, caller_id: user!.id, type: session.type,
            caller_name: session.callerName, caller_avatar: session.callerAvatar,
            group_name: session.groupName, group_avatar: session.groupAvatar
         }
    });
  };
  const [isVideoMuted, setIsVideoMuted] = useState(session.type === 'group-audio');
  
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const peersRef = useRef<Record<string, RTCPeerConnection>>({});
  const signalingChannel = useRef<any>(null);
  
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // --- AUDIO FEEDBACK ---
  useEffect(() => {
    if (status === 'ringing') {
      const audio = new Audio(session.isIncoming ? ringtoneUrl : dialtoneUrl);
      audio.loop = true;
      audioRef.current = audio;
      audio.play().catch(e => console.log("Audio play blocked", e));

      // Auto-join if OUTGOING
      if (!session.isIncoming) {
        handleAccept();
      }
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [status]);

  const startLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: session.type === 'group-video'
      });
      setLocalStream(stream);
      localStreamRef.current = stream;
      return stream;
    } catch (e: any) {
      if (session.type === 'group-video') {
         try {
            const a = await navigator.mediaDevices.getUserMedia({ audio: true });
            setLocalStream(a);
            localStreamRef.current = a;
            setIsVideoMuted(true);
            return a;
         } catch(e2) {}
      }
      return null;
    }
  };

  const createPeer = (peerId: string) => {
    if (peersRef.current[peerId]) return peersRef.current[peerId];
    
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    pc.ontrack = (event) => {
      setRemoteStreams(prev => ({ ...prev, [peerId]: event.streams[0] }));
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && signalingChannel.current) {
        signalingChannel.current.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: event.candidate, sender_id: user!.id, target_id: peerId }
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        const newRemotes = { ...remoteStreams };
        delete newRemotes[peerId];
        setRemoteStreams(newRemotes);
      }
    };

    peersRef.current[peerId] = pc;
    return pc;
  };

  const handleAccept = async () => {
    setStatus('connecting');
    await startLocalStream();
    
    // First, if OUTGOING, tell the network we are ringing the group
    if (!session.isIncoming) {
       supabase.channel('call-discovery').send({
         type: 'broadcast', event: 'group-call-offer',
         payload: { 
            group_id: session.groupId, caller_id: user!.id, type: session.type,
            caller_name: session.callerName, caller_avatar: session.callerAvatar,
            group_name: session.groupName, group_avatar: session.groupAvatar
         }
       });
    }

    // Join Group Room
    const channel = supabase.channel(`group-webrtc-${session.groupId}`);
    signalingChannel.current = channel;

    channel.on('broadcast', { event: 'peer-joined' }, async (payload) => {
      const newPeerId = payload.payload.sender_id;
      if (newPeerId === user!.id) return;
      
      // MESH DETERMINISM: Only the user with the higher ID initiates the offer
      // This prevents the 'InvalidStateError' when two clients send offers simultaneously
      if (user!.id > newPeerId) {
        const pc = createPeer(newPeerId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        channel.send({
          type: 'broadcast', event: 'offer',
          payload: { sdp: offer, sender_id: user!.id, target_id: newPeerId }
        });
      } else {
        // We wait passively to receive the offer and reply with an answer
        createPeer(newPeerId);
      }
    })
    .on('broadcast', { event: 'offer' }, async (payload) => {
      const { sdp, sender_id, target_id } = payload.payload;
      if (target_id !== user!.id) return;
      
      const pc = createPeer(sender_id);
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      channel.send({
        type: 'broadcast', event: 'answer',
        payload: { sdp: answer, sender_id: user!.id, target_id: sender_id }
      });
    })
    .on('broadcast', { event: 'answer' }, async (payload) => {
      const { sdp, sender_id, target_id } = payload.payload;
      if (target_id !== user!.id) return;
      
      const pc = peersRef.current[sender_id];
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    })
    .on('broadcast', { event: 'ice-candidate' }, async (payload) => {
      const { candidate, sender_id, target_id } = payload.payload;
      if (target_id !== user!.id) return;

      const pc = peersRef.current[sender_id];
      if (pc && candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate));
    })
    .on('broadcast', { event: 'peer-left' }, (payload) => {
      const leftId = payload.payload.sender_id;
      if (peersRef.current[leftId]) {
         peersRef.current[leftId].close();
         delete peersRef.current[leftId];
         setRemoteStreams(prev => {
            const next = { ...prev };
            delete next[leftId];
            return next;
         });
      }
    })
    .subscribe(async (s) => {
      if (s === 'SUBSCRIBED') {
        setStatus('connected');
        channel.send({ type: 'broadcast', event: 'peer-joined', payload: { sender_id: user!.id } });
      }
    });
  };

  const cleanup = () => {
    Object.values(peersRef.current).forEach(pc => pc.close());
    peersRef.current = {};
    if (localStreamRef.current) localStreamRef.current.getTracks().forEach(t => t.stop());
    if (signalingChannel.current) {
        signalingChannel.current.send({ type: 'broadcast', event: 'peer-left', payload: { sender_id: user!.id } });
        supabase.removeChannel(signalingChannel.current);
    }
    onClose();
  };

  const toggleAudio = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getAudioTracks()[0];
      if (track) {
        track.enabled = !track.enabled;
        setIsAudioMuted(!track.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getVideoTracks()[0];
      if (track) {
        track.enabled = !track.enabled;
        setIsVideoMuted(!track.enabled);
      }
    }
  };

  // Rendering Mesh Grid
  const remoteEntries = Object.entries(remoteStreams);
  const totalStreams = remoteEntries.length + (localStreamRef.current ? 1 : 0);
  
  let gridStyle = { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  if (totalStreams > 1) gridStyle = { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' };
  if (totalStreams > 4) gridStyle = { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(3, 1fr)' };

  if (isMinimized) {
    return (
      <div 
        onClick={() => setIsMinimized(false)}
        style={{
          position: 'fixed', bottom: 80, right: 20, zIndex: 99999,
          width: 64, height: 64, borderRadius: '50%',
          background: '#22c55e', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(34, 197, 94, 0.4)', cursor: 'pointer',
          animation: 'callPulse 2s infinite'
        }}>
        <Phone size={28} />
      </div>
    );
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000, backgroundColor: '#0f172a',
      display: 'flex', flexDirection: 'column', color: 'white', animation: 'fadeIn 0.3s'
    }}>
      {/* Top action bar: Minimize and Add */}
      {(status === 'connecting' || status === 'connected') && (
        <div style={{ position: 'absolute', top: 20, left: 20, right: 20, zIndex: 10, display: 'flex', justifyContent: 'space-between', pointerEvents: 'none' }}>
            <button onClick={() => setIsMinimized(true)} style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.5)', border: 'none', color: 'white', width: 44, height: 44, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
               <ArrowDown size={20} />
            </button>
            <button onClick={handleInvite} style={{ pointerEvents: 'auto', background: 'rgba(56,189,248,0.2)', border: '1px solid var(--color-primary)', color: 'var(--color-primary)', height: 44, padding: '0 16px', borderRadius: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontWeight: 600 }}>
               <UserPlus size={18} /> Invite
            </button>
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', padding: 24 }}>
        
        {/* Ringing UI */}
        {status === 'ringing' && session.isIncoming && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 140, height: 140, borderRadius: '50%', overflow: 'hidden', marginBottom: 24, padding: 4, background: 'linear-gradient(135deg, #38BDF8, #818CF8)', boxShadow: '0 0 30px rgba(56, 189, 248, 0.4)' }}>
               {session.groupAvatar ? <img src={session.groupAvatar} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} /> : <Users size={80} color="white" style={{ margin: 30 }} />}
            </div>
            <h2 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>{session.groupName}</h2>
            <p style={{ margin: '12px 0 0 0', color: '#94a3b8', fontSize: '1rem', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Group Call initiated by {session.callerName}
            </p>

            <div style={{ display: 'flex', gap: 40, marginTop: 60, zIndex: 10 }}>
              <button onClick={cleanup} style={{ width: 72, height: 72, borderRadius: '50%', border: 'none', backgroundColor: '#ef4444', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 10px 15px rgba(0,0,0,0.2)' }}>
                <X size={32} />
              </button>
              <button onClick={handleAccept} style={{ width: 72, height: 72, borderRadius: '50%', border: 'none', backgroundColor: '#22c55e', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 20px rgba(34, 197, 94, 0.4)' }}>
                <Phone size={32} />
              </button>
            </div>
          </div>
        )}

        {/* Connecting / Connected UI */}
        {(status === 'connecting' || status === 'connected') && (
           <div style={{ flex: 1, display: 'grid', gap: 8, ...gridStyle }}>
              {/* Local Video */}
              {localStream && (
                 <div style={{ position: 'relative' }}>
                    <VideoTile stream={localStream} isLocal={true} name="You" />
                    {isVideoMuted && (
                       <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1e293b', borderRadius: 12 }}>
                         <div style={{ textAlign: 'center' }}>
                            <VideoOff size={32} color="#64748b" style={{ marginBottom: 8 }} />
                            {session.type === 'group-audio' && <p style={{ margin: 0, color: '#94a3b8' }}>Audio Only</p>}
                         </div>
                       </div>
                    )}
                 </div>
              )}
              {/* Remote Videos */}
              {remoteEntries.map(([id, stream]) => (
                 <div key={id} style={{ position: 'relative' }}>
                    <VideoTile stream={stream} isLocal={false} name="Participant" />
                    {stream.getVideoTracks().length === 0 && (
                       <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#1e293b', borderRadius: 12 }}>
                          <Users size={32} color="#64748b" />
                       </div>
                    )}
                 </div>
              ))}
              
              {/* Placeholders if only you are connected */}
              {remoteEntries.length === 0 && status === 'connected' && (
                 <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 12 }}>
                    <Users size={48} color="#475569" style={{ marginBottom: 16 }} />
                    <p style={{ color: '#94a3b8' }}>Waiting for others to join...</p>
                 </div>
              )}
           </div>
        )}

      </div>

      {(status === 'connecting' || status === 'connected') && (
        <div style={{ height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 24, paddingBottom: 20, zIndex: 10 }}>
          <button onClick={toggleAudio} style={{ width: 56, height: 56, borderRadius: '50%', border: 'none', backgroundColor: isAudioMuted ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.1)', color: isAudioMuted ? '#000' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {isAudioMuted ? <MicOff size={24} /> : <Mic size={24} />}
          </button>

          {session.type === 'group-video' && (
            <button onClick={toggleVideo} style={{ width: 56, height: 56, borderRadius: '50%', border: 'none', backgroundColor: isVideoMuted ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.1)', color: isVideoMuted ? '#000' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {isVideoMuted ? <VideoOff size={24} /> : <VideoIcon size={24} />}
            </button>
          )}

          <button onClick={cleanup} style={{ width: 64, height: 64, borderRadius: '50%', border: 'none', backgroundColor: '#ef4444', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(239, 68, 68, 0.4)' }}>
            <PhoneOff size={28} />
          </button>
        </div>
      )}
    </div>
  );
}
