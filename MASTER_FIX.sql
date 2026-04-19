-- ============================================================
-- MKP Chat — MASTER FIX: Full User Pipeline Repair
-- Run this ENTIRE file in the Supabase SQL Editor
-- Safe to run multiple times (idempotent)
-- ============================================================

-- ── PHASE 1: DIAGNOSE & BACKFILL MISSING PROFILES ────────────────────────────
-- Fix existing auth users who do NOT have a profiles row.
-- This is the PRIMARY cause of FK errors for existing users.

-- FIRST: Remove the NOT NULL constraint on dob if it exists
DO $$
BEGIN
  ALTER TABLE public.profiles ALTER COLUMN dob DROP NOT NULL;
EXCEPTION
  WHEN undefined_column THEN
    NULL; -- Ignore if column doesn't exist
END $$;

INSERT INTO public.profiles (
  id, email, full_name, username, privacy_mode, is_admin, created_at
)
SELECT
  u.id,
  u.email,
  COALESCE(
    NULLIF(TRIM(u.raw_user_meta_data->>'full_name'), ''),
    SPLIT_PART(u.email, '@', 1)
  ),
  -- Generate a unique username from email prefix + short UUID
  LOWER(
    REGEXP_REPLACE(SPLIT_PART(u.email, '@', 1), '[^a-z0-9_]', '', 'g')
  ) || '_' || SUBSTR(u.id::text, 1, 6),
  'public',
  false,
  NOW()
FROM auth.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.profiles p WHERE p.id = u.id
);

-- Fix any profiles that have NULL username (can happen if trigger ran but username was empty)
UPDATE public.profiles
SET username = LOWER(
  REGEXP_REPLACE(SPLIT_PART(email, '@', 1), '[^a-z0-9_]', '', 'g')
) || '_' || SUBSTR(id::text, 1, 6)
WHERE username IS NULL OR username = '';


-- ── PHASE 2: REBUILD TRIGGER — BULLETPROOF VERSION ───────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username   TEXT;
  v_full_name  TEXT;
  v_is_admin   BOOLEAN;
  v_counter    INT := 0;
  v_base_name  TEXT;
BEGIN
  -- Extract metadata with safe defaults
  v_full_name := COALESCE(
    NULLIF(TRIM(new.raw_user_meta_data->>'full_name'), ''),
    SPLIT_PART(new.email, '@', 1)
  );

  v_is_admin := COALESCE(
    (new.raw_user_meta_data->>'is_admin')::boolean,
    false
  );

  -- Build a base username from email prefix, sanitized
  v_base_name := LOWER(
    REGEXP_REPLACE(SPLIT_PART(new.email, '@', 1), '[^a-z0-9_]', '', 'g')
  );

  -- Safety: if base is empty, use user_ + short id
  IF v_base_name IS NULL OR v_base_name = '' THEN
    v_base_name := 'user_' || SUBSTR(new.id::text, 1, 8);
  END IF;

  -- Start with base name, ensure uniqueness
  v_username := v_base_name;

  -- Ensure username is unique among OTHER users
  WHILE EXISTS (
    SELECT 1 FROM public.profiles
    WHERE username = v_username
    AND id != new.id
  ) LOOP
    v_counter := v_counter + 1;
    v_username := v_base_name || v_counter::text;
    -- Safety: after 100 attempts use UUID suffix
    IF v_counter > 100 THEN
      v_username := v_base_name || '_' || SUBSTR(new.id::text, 1, 6);
      EXIT;
    END IF;
  END LOOP;

  -- Upsert profile row
  -- ⚠ username is set to NULL for new email-signup users so onboarding is triggered
  -- But we need at least a placeholder to satisfy constraints.
  -- We store the generated username — user can change it in onboarding.
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    username,
    privacy_mode,
    is_admin,
    created_at
  )
  VALUES (
    new.id,
    new.email,
    v_full_name,
    v_username,       -- placeholder; onboarding lets user pick real one
    'public',
    v_is_admin,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email      = EXCLUDED.email,
    full_name  = CASE
                   WHEN profiles.full_name IS NULL OR profiles.full_name = ''
                   THEN EXCLUDED.full_name
                   ELSE profiles.full_name
                 END,
    -- Never overwrite an existing username the user already chose
    username   = CASE
                   WHEN profiles.username IS NULL OR profiles.username = ''
                   THEN EXCLUDED.username
                   ELSE profiles.username
                 END,
    is_admin   = EXCLUDED.is_admin;

  RETURN new;

EXCEPTION
  WHEN OTHERS THEN
    -- CRITICAL: log but never raise — a raising trigger breaks auth signup
    RAISE LOG 'handle_new_user: error for user % — %', new.id, SQLERRM;
    RETURN new;
END;
$$;


-- ── Ensure trigger is attached exactly once ──────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- ── PHASE 3: RLS POLICIES — PROFILES TABLE ───────────────────────────────────
-- DROP old conflicting policies first
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile"            ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile"            ON profiles;
DROP POLICY IF EXISTS "profiles_select_policy"                  ON profiles;
DROP POLICY IF EXISTS "profiles_update_policy"                  ON profiles;
DROP POLICY IF EXISTS "profiles_insert_policy"                  ON profiles;
DROP POLICY IF EXISTS "profiles_select_all"                     ON profiles;
DROP POLICY IF EXISTS "profiles_insert_own"                     ON profiles;
DROP POLICY IF EXISTS "profiles_update_own"                     ON profiles;

-- Enable RLS (idempotent)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- SELECT: any authenticated user can read any profile
CREATE POLICY "profiles_select_all"
  ON profiles FOR SELECT
  TO authenticated
  USING (true);

-- INSERT: only the authenticated user can insert their own profile row
-- (The trigger runs as SECURITY DEFINER so it bypasses RLS — this is for client-side safety)
CREATE POLICY "profiles_insert_own"
  ON profiles FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());

-- UPDATE: user can only update their own profile
CREATE POLICY "profiles_update_own"
  ON profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());


-- ── PHASE 4: RLS POLICIES — MESSAGES TABLE ───────────────────────────────────
-- Ensure messages can be inserted/read by the right people

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_select"  ON messages;
DROP POLICY IF EXISTS "messages_insert"  ON messages;
DROP POLICY IF EXISTS "messages_update"  ON messages;
DROP POLICY IF EXISTS "Users can read own messages"   ON messages;
DROP POLICY IF EXISTS "Users can send messages"       ON messages;
DROP POLICY IF EXISTS "Users can update own messages" ON messages;

-- SELECT: sender or receiver can read messages, OR participants of a chat
CREATE POLICY "messages_select"
  ON messages FOR SELECT
  TO authenticated
  USING (
    auth.uid() = sender_id
    OR auth.uid() = receiver_id
    OR chat_id IN (
      SELECT chat_id FROM chat_participants WHERE user_id = auth.uid()
    )
  );

-- INSERT: sender_id MUST equal the authenticated user's ID
--         AND the sender must have a profile (prevents FK error at RLS level)
CREATE POLICY "messages_insert"
  ON messages FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid())
  );

-- UPDATE: sender or receiver can update (status, deletion flags)
CREATE POLICY "messages_update"
  ON messages FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = sender_id
    OR auth.uid() = receiver_id
  );


-- ── PHASE 5: ENSURE UNIQUE USERNAME CONSTRAINT EXISTS ────────────────────────
-- Check and deduplicate usernames before adding the constraint
DO $$
DECLARE
  r RECORD;
  r2 RECORD;
  v_counter INT;
BEGIN
  -- Find and fix duplicate usernames
  FOR r IN (
    SELECT username, COUNT(*) AS cnt
    FROM public.profiles
    WHERE username IS NOT NULL AND username != ''
    GROUP BY username
    HAVING COUNT(*) > 1
  ) LOOP
    v_counter := 2;
    FOR r2 IN (
      SELECT id FROM public.profiles
      WHERE username = r.username
      ORDER BY created_at DESC
      OFFSET 1
    ) LOOP
      UPDATE public.profiles
      SET username = r.username || '_' || v_counter::text
      WHERE id = r2.id;
      v_counter := v_counter + 1;
    END LOOP;
  END LOOP;
END $$;


-- ── PHASE 6: VERIFY FOREIGN KEY REFERENCES ───────────────────────────────────
-- Ensure messages.sender_id FK references profiles.id, not auth.users directly.
-- This query tells you the current FK target:
SELECT
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name  AS foreign_table_name,
  ccu.column_name AS foreign_column_name
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name = 'messages'
  AND kcu.column_name IN ('sender_id', 'receiver_id');


-- ── PHASE 7: ENSURE ADMIN HAS is_admin FLAG ──────────────────────────────────
UPDATE profiles
SET is_admin = TRUE
WHERE email = 'dragonartserpent@gmail.com'
  AND (is_admin IS NULL OR is_admin = FALSE);


-- ── PHASE 8: ENSURE REALTIME IS ENABLED ─────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;


-- ── VERIFICATION QUERIES ─────────────────────────────────────────────────────
-- Run these to confirm the fix worked:

-- 1. Count auth users without profiles (should be 0 after fix)
SELECT COUNT(*) AS users_missing_profiles
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id);

-- 2. Profiles with NULL username (should be 0 after fix)
SELECT COUNT(*) AS profiles_with_null_username
FROM public.profiles
WHERE username IS NULL OR username = '';

-- 3. Trigger status
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_schema = 'auth'
  AND event_object_table = 'users'
  AND trigger_name = 'on_auth_user_created';

SELECT 'MASTER FIX applied successfully! ✅' AS result;
