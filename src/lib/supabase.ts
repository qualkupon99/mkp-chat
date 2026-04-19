import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export const FUNCTIONS_URL = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string;

export type Profile = {
  id: string;
  full_name: string;
  username: string;
  email: string;
  dob: string;
  gender: 'male' | 'female' | 'non_binary' | 'prefer_not_to_say';
  avatar_url: string | null;
  privacy_mode: 'public' | 'private';
  is_suspended: boolean;
  last_seen_at: string | null;
  username_changed_at: string | null;
  ui_preferences: {
    theme_color?: string;
    mode?: 'light' | 'dark' | 'system';
    bubble_style?: 'rounded' | 'classic' | 'compact';
    call_privacy?: 'everyone' | 'contacts' | 'nobody';
    font_size?: 'small' | 'medium' | 'large';
    chat_bg?: string;
    notification_sound?: boolean;
  };
  is_admin?: boolean;
  created_at: string;
};

export type Chat = {
  id: string;
  type: 'personal' | 'random' | 'group';
  created_at: string;
  last_message_at: string | null;
  active: boolean;
  is_group?: boolean;
  name?: string;
  avatar_url?: string;
  admin_id?: string;
};

export type Message = {
  id: string;
  chat_id: string;
  sender_id: string | null;
  receiver_id: string | null;
  content: string | null;
  media_url: string | null;
  media_type: 'image' | 'emoji' | 'voice' | null;
  status: 'sent' | 'delivered' | 'read';
  is_read: boolean;
  deleted_for_users: string[];
  is_deleted_globally: boolean;
  created_at: string;
  read_at: string | null;
  expires_at: string | null;
};

export type Status = {
  id: string;
  user_id: string;
  content: string;
  visibility: 'contacts' | 'public';
  created_at: string;
  expires_at: string;
};
