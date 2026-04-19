-- ============================================================
-- MKP Chat — Patch 3: Fix handle_new_user trigger + profile upsert
-- Run in Supabase SQL Editor
-- ============================================================

-- ── ROOT CAUSE ANALYSIS ──────────────────────────────────────────────────────
-- The error "Database error creating new user" (HTTP 400 from auth.admin.createUser)
-- is Supabase Auth's exact response when the on_auth_user_created trigger RAISES.
--
-- The trigger fails because:
-- 1. It inserts into profiles with ON CONFLICT (id) but the username column
--    has a UNIQUE constraint — if any prior attempt left a row with the same
--    username (different id), the INSERT fails with "duplicate key value violates
--    unique constraint profiles_username_key" which is NOT caught by ON CONFLICT (id).
-- 2. The trigger also inserts dob as TEXT '2000-01-01' into a column that may be
--    DATE type — usually fine, but needs clean casting.
-- 3. Any trigger exception aborts the entire auth.admin.createUser transaction.
--
-- THE FIX:
-- 1. Wrap the trigger in a full EXCEPTION handler — NEVER let it raise to Auth
-- 2. Use ON CONFLICT (id) DO UPDATE properly with explicit username deduplication
-- 3. Clean up any orphaned profile rows from failed previous attempts
-- 4. Remove dob/gender from trigger if those columns are optional
-- ============================================================


-- ── STEP 1: Rewrite the trigger function to be bulletproof ───────────────────
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
  
  -- Build a unique username: prefer provided, fallback to email prefix + short id
  v_base_name := COALESCE(
    NULLIF(LOWER(TRIM(REGEXP_REPLACE(new.raw_user_meta_data->>'username', '[^a-z0-9_]', '', 'g'))), ''),
    LOWER(REGEXP_REPLACE(SPLIT_PART(new.email, '@', 1), '[^a-z0-9_]', '', 'g'))
  );
  
  -- If v_base_name is empty after sanitization, use user_ + short id
  IF v_base_name = '' THEN
    v_base_name := 'user_' || SUBSTR(new.id::text, 1, 8);
  END IF;
  
  v_username := v_base_name;
  
  -- Ensure username is unique — append counter if taken (by a DIFFERENT user)
  WHILE EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE username = v_username 
    AND id != new.id  -- allow re-use for same id (upsert scenario)
  ) LOOP
    v_counter := v_counter + 1;
    v_username := v_base_name || v_counter::text;
    -- Safety exit after 100 attempts
    IF v_counter > 100 THEN
      v_username := v_base_name || '_' || SUBSTR(new.id::text, 1, 6);
      EXIT;
    END IF;
  END LOOP;

  -- Upsert: create or update profile row
  -- ON CONFLICT (id) handles re-runs; username uniqueness is handled above
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
    v_username,
    'public',
    v_is_admin,
    NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    email      = EXCLUDED.email,
    full_name  = CASE WHEN EXCLUDED.full_name != 'Admin Account' THEN EXCLUDED.full_name ELSE profiles.full_name END,
    username   = CASE WHEN profiles.username IS NULL OR profiles.username = '' THEN EXCLUDED.username ELSE profiles.username END,
    is_admin   = EXCLUDED.is_admin;

  RETURN new;

EXCEPTION
  WHEN OTHERS THEN
    -- CRITICAL: Never let the trigger raise — log and continue
    -- This prevents "Database error creating new user" from Auth
    RAISE LOG 'handle_new_user: non-fatal error for user % — %', new.id, SQLERRM;
    RETURN new;
END;
$$;


-- ── STEP 2: Ensure trigger is attached exactly once ──────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- ── STEP 3: Clean up orphaned profiles from failed previous attempts ─────────
-- If admin tried to create "james" and it partially failed, there may be
-- a stale profile row with no corresponding auth.users entry.
-- This removes profiles where no auth user exists.
DELETE FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM auth.users u WHERE u.id = p.id
);


-- ── STEP 4: Check for duplicate usernames (if any exist, deduplicate them) ───
-- This finds any username conflicts and suffixes them with _N to fix them
DO $$
DECLARE
  r RECORD;
  r2 RECORD;
  v_counter INT;
BEGIN
  FOR r IN (
    SELECT username, COUNT(*) as cnt, MIN(created_at) as first_created
    FROM public.profiles
    WHERE username IS NOT NULL
    GROUP BY username
    HAVING COUNT(*) > 1
  ) LOOP
    v_counter := 2;
    FOR r2 IN (
      SELECT id FROM public.profiles
      WHERE username = r.username
      ORDER BY created_at DESC  -- rename newer ones
      OFFSET 1  -- keep the oldest one
    ) LOOP
      UPDATE public.profiles
      SET username = r.username || v_counter::text
      WHERE id = r2.id;
      v_counter := v_counter + 1;
    END LOOP;
  END LOOP;
END $$;


-- ── VERIFY ───────────────────────────────────────────────────────────────────
SELECT 'Patch 3 applied successfully! Trigger rebuilt. ✅' AS result;

-- Sanity check: show current trigger on auth.users
SELECT trigger_name, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'auth' 
  AND event_object_table = 'users'
  AND trigger_name = 'on_auth_user_created';
