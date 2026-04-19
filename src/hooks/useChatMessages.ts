import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Message as SupabaseMessage } from '../lib/supabase';

export type Message = SupabaseMessage & { isOptimistic?: boolean; expires_at?: string | null };

export function useChatMessages(userId: string | undefined, partnerId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['messages', userId, partnerId], [userId, partnerId]);

  // 1. Pagination fetcher
  const fetchMessages = async ({ pageParam = 0 }) => {
    if (!userId || !partnerId) return [];
    const limit = 50;
    const start = pageParam * limit;
    const end = start + limit - 1;

    // Use RPC or explicit query to get messages between specific pair safely
    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .or(`and(sender_id.eq.${userId},receiver_id.eq.${partnerId}),and(sender_id.eq.${partnerId},receiver_id.eq.${userId})`)
      .not('deleted_for_users', 'cs', `{${userId}}`) // exclude if I deleted it for myself
      .order('created_at', { ascending: false })
      .range(start, end);

    if (error) {
      console.error('[useChatMessages] fetch error:', error);
      throw error;
    }
    return data || [];
  };

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError } =
    useInfiniteQuery({
      queryKey,
      queryFn: fetchMessages,
      getNextPageParam: (lastPage, allPages) => lastPage.length === 50 ? allPages.length : undefined,
      initialPageParam: 0,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    });

  const queryMessages = data ? data.pages.flat().reverse() as Message[] : [];

  // Update a single message locally in the react-query cache
  const upsertLocalMessage = useCallback((msg: Message) => {
    queryClient.setQueryData(queryKey, (oldData: any) => {
      if (!oldData) return { pages: [[msg]], pageParams: [0] };
      const pages = oldData.pages.map((page: any[]) => {
        const idx = page.findIndex((m: any) => m.id === msg.id);
        if (idx !== -1) {
          const updated = [...page];
          updated[idx] = { ...updated[idx], ...msg, isOptimistic: false };
          return updated;
        }
        return page;
      });

      // If it's a completely new message not currently in cache, prepend it to the first page (newest since we order desc)
      const found = oldData.pages.some((page: any[]) => page.some((m: any) => m.id === msg.id));
      if (!found) {
        const newPages = [...pages];
        newPages[0] = [msg, ...(newPages[0] || [])];
        return { ...oldData, pages: newPages };
      }
      return { ...oldData, pages };
    });
  }, [queryClient, queryKey]);

  // 2. Action: Send Message
  const sendMessage = useCallback(async (
    content: string | null, 
    mediaUrl: string | null, 
    mediaType: 'image' | 'emoji' | 'voice' | null, 
    destructSeconds: number | null
  ) => {
    if (!partnerId || !userId) return;
    if (!content && !mediaUrl) return;

    // ── Pre-flight: verify profile exists (prevents FK constraint error) ──
    const { data: profileCheck } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    if (!profileCheck) {
      alert('Your profile is not set up yet. Please complete onboarding first.');
      window.location.href = '/onboarding';
      return;
    }

    const messageId = crypto.randomUUID();
    const expiresAt = destructSeconds
      ? new Date(Date.now() + destructSeconds * 1000).toISOString()
      : null;

    const optimisticMsg: Message = {
      id: messageId,
      chat_id: 'legacy',
      sender_id: userId,
      receiver_id: partnerId,
      content: content,
      media_url: mediaUrl,
      media_type: mediaType,
      status: 'sent',
      is_read: false,
      deleted_for_users: [],
      is_deleted_globally: false,
      created_at: new Date().toISOString(),
      read_at: null,
      expires_at: expiresAt,
      isOptimistic: true,
    };

    // Append to UI immediately
    upsertLocalMessage(optimisticMsg);

    try {
      const { data, error } = await supabase.from('messages').insert({
        id: messageId,
        sender_id: userId,
        receiver_id: partnerId,
        content: content,
        media_url: mediaUrl,
        media_type: mediaType,
        expires_at: expiresAt,
        status: 'sent',
      }).select().single();

      if (error) throw error;
      
      // Update with server confirmed timestamp
      if (data) upsertLocalMessage({ ...data, isOptimistic: false });
    } catch (err: any) {
      console.error('[useChatMessages] send error:', err);
      // Rollback optimistic message if failed
      queryClient.setQueryData(queryKey, (old: any) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p: any[]) => p.filter(m => m.id !== messageId))
        };
      });

      // User-friendly error messages
      const msg = err?.message || 'Unknown error';
      if (msg.includes('foreign key constraint') || msg.includes('fkey')) {
        alert('Your profile is incomplete. Please complete your profile setup before sending messages.');
        window.location.href = '/onboarding';
      } else {
        alert(`Message failed to send: ${msg}`);
      }
    }
  }, [userId, partnerId, upsertLocalMessage, queryClient, queryKey]);

  // 3. Action: Delete for me
  const deleteForMe = useCallback(async (msgId: string) => {
    const msg = queryMessages.find(m => m.id === msgId);
    if (!msg) return;

    // Local UI update
    queryClient.setQueryData(queryKey, (oldData: any) => {
      if (!oldData) return oldData;
      return {
        ...oldData,
        pages: oldData.pages.map((page: any[]) => page.filter((m: any) => m.id !== msgId))
      };
    });

    try {
      const updated = [...(msg.deleted_for_users || []), userId];
      await supabase.from('messages').update({ deleted_for_users: updated }).eq('id', msgId);
    } catch(e) {
      console.error('[useChatMessages] deleteForMe error:', e);
    }
  }, [userId, queryClient, queryKey, queryMessages]);

  // 4. Action: Delete for everyone
  const deleteForEveryone = useCallback(async (msgId: string) => {
    try {
      // Optimistic update
      upsertLocalMessage({ 
        ...(queryMessages.find(m => m.id === msgId) as Message), 
        is_deleted_globally: true, 
        content: '🚫 This message was deleted', 
        media_url: null 
      });

      await supabase.from('messages')
        .update({ is_deleted_globally: true, content: '🚫 This message was deleted', media_url: null })
        .eq('id', msgId);
    } catch(e) {
      console.error('[useChatMessages] deleteForEveryone error:', e);
    }
  }, [queryMessages, upsertLocalMessage]);

  return {
    messages: queryMessages,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    sendMessage,
    deleteForMe,
    deleteForEveryone,
    upsertLocalMessage
  };
}
