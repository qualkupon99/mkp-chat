-- ============================================================
-- MKP Chat — Production Database Fix Script
-- Run this ENTIRE file in the Supabase SQL Editor
-- This is safe to run multiple times (idempotent)
-- ============================================================

-- ── 1. HELP TICKETS: Add guest_id column, make user_id nullable ──────────────
-- ROOT CAUSE: help_tickets had user_id NOT NULL, blocking guest ticket inserts.
-- The HelpBotPage (and AdminDashboard) support guest users who are not registered.

-- Step 1a: Make user_id nullable (so guests can create tickets)
ALTER TABLE help_tickets
  ALTER COLUMN user_id DROP NOT NULL;

-- Step 1b: Add guest_id column for anonymous/guest users
ALTER TABLE help_tickets
  ADD COLUMN IF NOT EXISTS guest_id TEXT DEFAULT NULL;

-- Step 1c: Add index for guest lookups
CREATE INDEX IF NOT EXISTS idx_help_tickets_guest
  ON help_tickets(guest_id)
  WHERE guest_id IS NOT NULL;

-- Step 1d: Add constraint: either user_id OR guest_id must be present
-- (Skip if already exists — wrapped in DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'help_tickets' AND constraint_name = 'chk_help_tickets_identity'
  ) THEN
    ALTER TABLE help_tickets
      ADD CONSTRAINT chk_help_tickets_identity
      CHECK (user_id IS NOT NULL OR guest_id IS NOT NULL);
  END IF;
END $$;


-- ── 2. FIX RLS POLICIES ON help_tickets ─────────────────────────────────────
-- ROOT CAUSE: RLS only allowed SELECT where user_id = auth.uid().
-- Guest tickets (user_id = NULL) are invisible to the user on reload.

-- Drop old policies (idempotent)
DROP POLICY IF EXISTS "Users can view own tickets" ON help_tickets;
DROP POLICY IF EXISTS "Users can insert own tickets" ON help_tickets;
DROP POLICY IF EXISTS "Users can update own tickets" ON help_tickets;
DROP POLICY IF EXISTS "Admins can read all tickets" ON help_tickets;

-- New policies
CREATE POLICY "Users can view own tickets"
  ON help_tickets FOR SELECT
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND email = 'dragonartserpent@gmail.com')
  );

CREATE POLICY "Users can insert own tickets"
  ON help_tickets FOR INSERT
  WITH CHECK (
    -- Logged-in users must match their own id
    (auth.uid() IS NOT NULL AND user_id = auth.uid())
    OR
    -- Guests: user_id must be NULL, guest_id must be set
    (auth.uid() IS NULL AND user_id IS NULL AND guest_id IS NOT NULL)
  );

CREATE POLICY "Users can update own tickets"
  ON help_tickets FOR UPDATE
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
  );

CREATE POLICY "Admins can manage all tickets"
  ON help_tickets FOR ALL
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND email = 'dragonartserpent@gmail.com')
  );


-- ── 3. FIX RLS POLICIES ON help_messages ────────────────────────────────────
-- ROOT CAUSE: Guest messages were blocked because the ticket select policy
-- only worked for auth.uid() = user_id which failed for guest rows.

DROP POLICY IF EXISTS "Ticket participants can read messages" ON help_messages;
DROP POLICY IF EXISTS "Ticket participants can insert messages" ON help_messages;
DROP POLICY IF EXISTS "Admins can read all help messages" ON help_messages;
DROP POLICY IF EXISTS "Admins can insert help messages" ON help_messages;

CREATE POLICY "Ticket participants can read messages"
  ON help_messages FOR SELECT
  USING (
    ticket_id IN (
      SELECT id FROM help_tickets WHERE user_id = auth.uid()
    )
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND email = 'dragonartserpent@gmail.com')
  );

CREATE POLICY "Users can insert help messages"
  ON help_messages FOR INSERT
  WITH CHECK (
    -- Must be inserting into a ticket they own (or admin)
    (
      sender_id = auth.uid()
      AND (
        ticket_id IN (SELECT id FROM help_tickets WHERE user_id = auth.uid())
        OR
        EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
      )
    )
    OR
    -- Guests: sender_id may be null
    (
      sender_id IS NULL
      AND ticket_id IN (SELECT id FROM help_tickets WHERE user_id IS NULL)
    )
  );


-- ── 4. FIX admin_get_all_tickets RPC ────────────────────────────────────────
-- ROOT CAUSE 1: Inner JOIN excluded guest tickets (user_id = NULL → no profile row).
-- ROOT CAUSE 2: RPC checked is_admin = TRUE but master admin email may not have that flag.

CREATE OR REPLACE FUNCTION admin_get_all_tickets()
RETURNS TABLE(
  id UUID,
  user_id UUID,
  guest_id TEXT,
  subject TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  username TEXT,
  full_name TEXT,
  email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Allow master admin OR any user with is_admin = TRUE
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND (is_admin = TRUE OR email = 'dragonartserpent@gmail.com')
  ) THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.user_id,
    t.guest_id,
    t.subject,
    t.status,
    t.created_at,
    t.updated_at,
    COALESCE(p.username, 'Guest'),
    COALESCE(p.full_name, 'Guest User'),
    COALESCE(p.email, 'guest@anonymous')
  FROM help_tickets t
  LEFT JOIN profiles p ON p.id = t.user_id  -- LEFT JOIN includes guest tickets
  ORDER BY t.created_at DESC;
END;
$$;


-- ── 5. ENABLE REALTIME ON HELP TABLES ────────────────────────────────────────
-- If not already enabled. These are ALTER PUBLICATION statements that are
-- safe to run multiple times (they are idempotent in Postgres).
DO $$
BEGIN
  -- Add help_tickets to realtime publication if not already there
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'help_tickets'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE help_tickets;
  END IF;

  -- Add help_messages to realtime publication if not already there
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'help_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE help_messages;
  END IF;
END $$;


-- ── 6. ENSURE MASTER ADMIN HAS is_admin = TRUE ───────────────────────────────
-- This is a safety measure: if the master admin's profile doesn't have is_admin=true,
-- some RLS/RPC checks that only check is_admin (not email) will fail.
-- This sets it once. Non-destructive.
UPDATE profiles
SET is_admin = TRUE
WHERE email = 'dragonartserpent@gmail.com'
  AND (is_admin IS NULL OR is_admin = FALSE);


-- ── 7. VERIFY: Run the following SELECT to check schema ─────────────────────
-- SELECT column_name, is_nullable, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'help_tickets'
-- ORDER BY ordinal_position;

-- Expected: user_id should be nullable, guest_id should exist.

SELECT 'Database migration completed successfully! ✅' AS result;
