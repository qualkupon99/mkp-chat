-- =====================================================================
-- FIX FOR: duplicate key value violates unique constraint "profiles_pkey"
-- =====================================================================

-- Problem Explanation: 
-- In Supabase, the `auth.users` trigger automatically inserts a row into the `public.profiles` table upon user registration. 
-- If your Admin creation script (or RPC `admin_create_user`) attempts to manually insert into `public.profiles` right after calling auth.admin.createUser, it causes a duplicate UUID conflict.

-- FIX PART 1: CONFLICT RESOLUTION
-- Ensure that any custom functions (like your 'admin_create_user' RPC) handle the insert gracefully by using 'ON CONFLICT DO UPDATE' or 'DO NOTHING'.
-- Example script to recreate your trigger or RPC gracefully:
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (new.id, new.email, new.raw_user_meta_data->>'full_name')
  ON CONFLICT (id) DO NOTHING; -- This prevents duplicate key errors
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- FIX PART 2: SEQUENCE FIX (If you changed profiles.id to an INT/SERIAL)
-- ONLY RUN THIS IF `profiles.id` IS AN INTEGER (not UUID) AND SEQUENCE IS OUT OF SYNC
-- SELECT setval(pg_get_serial_sequence('profiles', 'id'), coalesce(max(id),0) + 1, false) FROM profiles;

-- =====================================================================
-- Call Privacy (RLS Policy equivalent for call table)
-- =====================================================================
-- Note: Since we implemented the Edge Function (initiate-call) middleware,
-- direct client-side broadcasting is bypassed and privacy is strictly enforced backend!
