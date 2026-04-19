-- 1. Fix the Supabase Auth Trigger to gracefully extract username and prevent NOT NULL crashes
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, username)
  VALUES (
    new.id, 
    new.email, 
    new.raw_user_meta_data->>'full_name',
    COALESCE(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8))
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    username = EXCLUDED.username;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Force the Supabase REST API (PostgREST) to instantly drop and reload its Schema Cache
-- This permanently fixes the 400 Errors on the `admin_get_all_tickets` RPC.
NOTIFY pgrst, 'reload schema';
