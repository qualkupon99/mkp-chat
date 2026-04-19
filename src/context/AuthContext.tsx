import React, { createContext, useContext, useEffect, useState, useMemo, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile } from '../lib/supabase';

type AuthContextType = {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** Set of user IDs currently online (updates instantly via Presence) */
  onlineUserIds: Set<string>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  profile: null,
  loading: true,
  onlineUserIds: new Set(),
  signOut: async () => {},
  refreshProfile: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const presenceChannelRef = useRef<any>(null);

  const fetchProfile = async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (!error && data) {
      setProfile(data as Profile);
      return;
    }

    // Profile row doesn't exist — the DB trigger may have failed silently.
    // Create a minimal profile row so the user can reach the onboarding page.
    if (error && error.code === 'PGRST116') {
      console.warn('[Auth] No profile found for user', userId, '— creating fallback profile');
      const { data: authUser } = await supabase.auth.getUser();
      const meta = authUser?.user?.user_metadata || {};
      const emailPrefix = (authUser?.user?.email || 'user').split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase();

      const { data: newProfile, error: insertErr } = await supabase
        .from('profiles')
        .upsert({
          id: userId,
          email: authUser?.user?.email || '',
          full_name: meta.full_name || '',
          username: emailPrefix + '_' + userId.substring(0, 6),
          privacy_mode: 'public',
        }, { onConflict: 'id' })
        .select()
        .single();

      if (!insertErr && newProfile) {
        setProfile(newProfile as Profile);
      } else {
        console.error('[Auth] Failed to create fallback profile:', insertErr);
      }
    }
  };

  const refreshProfile = async () => {
    if (user) await fetchProfile(user.id);
  };

  // ── Auth session setup ────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Real-time own profile sync ────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const profileChannel = supabase
      .channel(`profile-updates-${user.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `id=eq.${user.id}`
      }, (payload) => {
        setProfile(payload.new as Profile);
      })
      .subscribe();

    return () => { profileChannel.unsubscribe(); };
  }, [user]);

  // ── Supabase Presence: tracks OWN presence AND exposes who is online ──────
  //
  // IMPORTANT: all .on('presence', ...) handlers MUST be attached BEFORE
  // .subscribe() is called — this is enforced by Supabase's RealtimeChannel.
  //
  // ConversationPage and ChatsListPage read `onlineUserIds` from context;
  // they must NOT subscribe to 'user-presence' themselves.
  useEffect(() => {
    if (!user) return;

    const channel = supabase.channel('user-presence', {
      config: { presence: { key: user.id } },
    });

    // Attach authoritative sync listener before subscribe
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        setOnlineUserIds(new Set(Object.keys(state)));
      });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        // Track self as online
        await channel.track({ user_id: user.id, online_at: new Date().toISOString() });
        // Write to DB so last_seen_at is accurate
        await supabase.from('profiles')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', user.id);
      }
    });

    presenceChannelRef.current = channel;

    // Instantly go offline when tab is hidden, back online when visible
    const handleVisibility = () => {
      if (document.hidden) {
        channel.untrack();
        supabase.from('profiles')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', user.id);
      } else {
        channel.track({ user_id: user.id, online_at: new Date().toISOString() });
        supabase.from('profiles')
          .update({ last_seen_at: new Date().toISOString() })
          .eq('id', user.id);
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      channel.untrack();
      supabase.removeChannel(channel);
      presenceChannelRef.current = null;
      setOnlineUserIds(new Set());
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [user]);

  // ── Global delivery: mark pending messages as 'delivered' on login ────────
  useEffect(() => {
    if (!user) return;

    // Retroactively mark all 'sent' messages as 'delivered' when user opens app
    supabase
      .from('messages')
      .update({ status: 'delivered' })
      .eq('receiver_id', user.id)
      .eq('status', 'sent')
      .then(() => {});

    const deliveryChannel = supabase
      .channel('global-delivery')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `receiver_id=eq.${user.id}`
      }, async (payload) => {
        const msg = payload.new;
        if (msg.status === 'sent') {
          await supabase.from('messages')
            .update({ status: 'delivered' })
            .eq('id', msg.id)
            .eq('status', 'sent');
        }
      })
      .subscribe();

    return () => { deliveryChannel.unsubscribe(); };
  }, [user]);

  const signOut = async () => {
    if (presenceChannelRef.current) {
      await presenceChannelRef.current.untrack();
    }
    if (user) {
      await supabase.from('profiles')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('id', user.id);
    }
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setProfile(null);
    setOnlineUserIds(new Set());
  };

  const contextValue = useMemo(() => ({
    user, session, profile, loading, onlineUserIds, signOut, refreshProfile
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [user, session, profile, loading, onlineUserIds]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
};
