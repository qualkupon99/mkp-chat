import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Message } from './useChatMessages';

interface RealtimeHookProps {
  userId: string | undefined;
  partnerId: string | undefined;
  upsertLocalMessage: (msg: Message) => void;
  onScrollToBottom?: () => void;
}

export function useChatRealtime({ userId, partnerId, upsertLocalMessage, onScrollToBottom }: RealtimeHookProps) {
  const [realtimeStatus, setRealtimeStatus] = useState<string>('connecting');
  const [partnerTyping, setPartnerTyping] = useState(false);
  
  const chatChannelRef = useRef<any>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypeSentRef = useRef<number>(0);

  useEffect(() => {
    if (!userId || !partnerId) return;

    // Use a unique channel for this pair's presence/typing
    const channelName = `chat-room-${[userId, partnerId].sort().join('-')}`;
    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false } }
    });

    // Handle incoming new messages
    const handleInsert = async (payload: any) => {
      const msg = payload.new as Message;
      if (!msg) return;

      // Ensure it's for this specific chat
      const isThisPair = (msg.sender_id === userId && msg.receiver_id === partnerId) ||
                         (msg.sender_id === partnerId && msg.receiver_id === userId);
      if (!isThisPair) return;

      upsertLocalMessage(msg);
      if (onScrollToBottom) setTimeout(onScrollToBottom, 50);

      // System Ticks: If I am receiving this message, upgrade its status in DB immediately
      if (msg.receiver_id === userId) {
        if (document.visibilityState === 'visible') {
          // I am currently looking at the chat -> "read" (Blue Ticks)
          if (msg.status !== 'read') {
             await supabase.from('messages')
               .update({ status: 'read', is_read: true, read_at: new Date().toISOString() })
               .eq('id', msg.id);
          }
        } else {
          // App is in background or another tab -> "delivered" (Double Grey Ticks)
          if (msg.status === 'sent') {
             await supabase.from('messages')
               .update({ status: 'delivered' })
               .eq('id', msg.id);
          }
        }
      }
    };

    // Handle updates (like when partner reads your message, or modifies it)
    const handleUpdate = (payload: any) => {
      const msg = payload.new as Message;
      const isThisPair = (msg.sender_id === userId && msg.receiver_id === partnerId) ||
                         (msg.sender_id === partnerId && msg.receiver_id === userId);
      if (isThisPair) {
        upsertLocalMessage(msg);
      }
    };

    channel
      // 1. Listen ONLY to messages sent to me (this prevents the huge data firehose)
      .on('postgres_changes', { 
        event: 'INSERT', schema: 'public', table: 'messages', filter: `receiver_id=eq.${userId}` 
      }, handleInsert)
      
      // 2. Listen ONLY to messages I sent (in case I am on two devices)
      .on('postgres_changes', { 
        event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${userId}` 
      }, handleInsert)

      // 3. Listen to updates on messages I SENT (partner marking as delivered/read)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${userId}`
      }, handleUpdate)

      // 4. Listen to updates on messages SENT TO ME (partner deleting globally)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'messages', filter: `receiver_id=eq.${userId}`
      }, handleUpdate)

      // 5. Broadcast: Typing indicator
      .on('broadcast', { event: 'typing' }, (payload) => {
        if (payload.payload?.user_id !== partnerId) return;
        setPartnerTyping(true);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setPartnerTyping(false), 3000);
      })

      .subscribe((status, err) => {
        setRealtimeStatus(status);
        if (err) console.error('[useChatRealtime] Subscription error:', err);
        if (status === 'CHANNEL_ERROR') {
          console.warn('[useChatRealtime] Channel error, recovering in 2s...');
          setTimeout(() => channel.subscribe(), 2000);
        }
      });

    chatChannelRef.current = channel;

    // --- Foreground Read Receipt Catch-up ---
    let isMarking = false;
    const markAsRead = async () => {
      if (document.visibilityState !== 'visible' || isMarking) return;
      isMarking = true;
      try {
        await supabase.from('messages')
          .update({ status: 'read', is_read: true, read_at: new Date().toISOString() })
          .eq('sender_id', partnerId)
          .eq('receiver_id', userId)
          .not('status', 'eq', 'read'); // Don't update if already read
      } catch(e) { console.error('Error marking as read', e); }
      finally {
        setTimeout(() => { isMarking = false; }, 2000);
      }
    };
    
    // Trigger immediately upon open
    markAsRead();

    // Trigger when tab regains focus
    document.addEventListener('visibilitychange', markAsRead);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', markAsRead);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [userId, partnerId, upsertLocalMessage, onScrollToBottom]);

  // Broadcast typing event (throttled max 1 per 2 sec)
  const broadcastTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypeSentRef.current < 2000) return;
    lastTypeSentRef.current = now;
    chatChannelRef.current?.send({
      type: 'broadcast', event: 'typing',
      payload: { user_id: userId },
    });
  }, [userId]);

  return { realtimeStatus, partnerTyping, broadcastTyping };
}
