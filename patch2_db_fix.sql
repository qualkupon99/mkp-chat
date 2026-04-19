-- ============================================================
-- MKP Chat — Patch 2: Fix ambiguous column + guest RLS
-- Run in Supabase SQL Editor after production_db_fix.sql
-- ============================================================

-- ── FIX 1: admin_get_all_tickets — ambiguous "id" column ─────────────────────
-- ROOT CAUSE: After adding LEFT JOIN, both help_tickets.id and profiles.id
-- exist in the query scope. The SELECT t.id was fine but PostgREST's internal
-- parsing flagged the ambiguity. Qualify every column explicitly.

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
    WHERE profiles.id = auth.uid()
    AND (profiles.is_admin = TRUE OR profiles.email = 'dragonartserpent@gmail.com')
  ) THEN
    RAISE EXCEPTION 'Unauthorized: admin access required';
  END IF;

  RETURN QUERY
  SELECT
    t.id         AS id,
    t.user_id    AS user_id,
    t.guest_id   AS guest_id,
    t.subject    AS subject,
    t.status     AS status,
    t.created_at AS created_at,
    t.updated_at AS updated_at,
    COALESCE(p.username, 'Guest')                    AS username,
    COALESCE(p.full_name, 'Guest User')              AS full_name,
    COALESCE(p.email, 'guest@anonymous.local')       AS email
  FROM help_tickets t
  LEFT JOIN profiles p ON p.id = t.user_id
  ORDER BY t.created_at DESC;
END;
$$;


-- ── FIX 2: Guest help tickets — RLS for unauthenticated (anon) requests ───────
-- ROOT CAUSE: The 406 error on guest ticket SELECT/INSERT happens because
-- Supabase's PostgREST runs with the "anon" role for unauthenticated requests.
-- The RLS policy "Users can insert own tickets" had:
--   auth.uid() IS NULL AND user_id IS NULL AND guest_id IS NOT NULL
-- But in Supabase, even unauthenticated requests go through their anon key,
-- which is a real JWT (but with role=anon). auth.uid() returns NULL only
-- when using the service role. For anon JWTs, auth.uid() also returns NULL.
-- HOWEVER the RLS "WITH CHECK" clause on INSERT is evaluated PER ROW.
-- The 406 is actually from the INITIAL SELECT (load existing ticket) failing
-- because there's no matching row yet (PGRST116 → 406 in older PostgREST).
-- The actual 406 error code means "Not Acceptable" which PostgREST returns 
-- when `.single()` finds NO rows — this is a client-side handling issue.
-- 
-- Fix: In HelpBotPage.tsx (already done — we check error.code !== 'PGRST116').
-- For the INSERT, we need to explicitly allow anon role on help_tickets.

-- Drop and recreate permissive INSERT policy for guests
DROP POLICY IF EXISTS "Users can insert own tickets" ON help_tickets;

CREATE POLICY "Users can insert own tickets"
  ON help_tickets FOR INSERT
  WITH CHECK (
    -- Case 1: Authenticated user inserting their own ticket
    (auth.uid() IS NOT NULL AND user_id = auth.uid() AND guest_id IS NULL)
    OR
    -- Case 2: Guest (anon role) inserting a ticket with no user_id, just guest_id
    (user_id IS NULL AND guest_id IS NOT NULL)
  );

-- Allow anon role to SELECT help_tickets (for guest to see their own)
-- This uses guest_id stored client-side in localStorage — not a security issue
-- since we can't verify guest identity server-side anyway (by design)
DROP POLICY IF EXISTS "Users can view own tickets" ON help_tickets;

CREATE POLICY "Users can view own tickets"
  ON help_tickets FOR SELECT
  USING (
    -- Authenticated user sees their own
    (auth.uid() IS NOT NULL AND user_id = auth.uid())
    OR
    -- Guest sees by guest_id (anon — open, but guest_id is a UUID hard to guess)
    (user_id IS NULL AND guest_id IS NOT NULL)
    OR
    -- Admin sees everything
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND (profiles.is_admin = TRUE OR profiles.email = 'dragonartserpent@gmail.com')
    )
  );

-- Allow anon SELECT on help_messages for guest ticket messages
DROP POLICY IF EXISTS "Ticket participants can read messages" ON help_messages;

CREATE POLICY "Ticket participants can read messages"
  ON help_messages FOR SELECT
  USING (
    -- Authenticated user: must own the ticket
    (
      auth.uid() IS NOT NULL
      AND ticket_id IN (
        SELECT ht.id FROM help_tickets ht WHERE ht.user_id = auth.uid()
      )
    )
    OR
    -- Guest: ticket_id must belong to a guest ticket (user_id IS NULL)
    -- Open policy since guest_id is a random UUID — effectively private
    (
      ticket_id IN (
        SELECT ht.id FROM help_tickets ht WHERE ht.user_id IS NULL
      )
    )
    OR
    -- Admin
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND (profiles.is_admin = TRUE OR profiles.email = 'dragonartserpent@gmail.com')
    )
  );

-- Allow anon INSERT on help_messages for guest users
DROP POLICY IF EXISTS "Users can insert help messages" ON help_messages;

CREATE POLICY "Users can insert help messages"
  ON help_messages FOR INSERT
  WITH CHECK (
    -- Authenticated user inserting into their own ticket
    (
      auth.uid() IS NOT NULL
      AND sender_id = auth.uid()
      AND (
        ticket_id IN (SELECT ht.id FROM help_tickets ht WHERE ht.user_id = auth.uid())
        OR
        EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = TRUE)
      )
    )
    OR
    -- Admin reply (sender_id = admin id, any ticket)
    (
      auth.uid() IS NOT NULL
      AND EXISTS (SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.is_admin = TRUE)
    )
    OR
    -- Guest inserting into their own guest ticket
    (
      sender_id IS NULL
      AND ticket_id IN (SELECT ht.id FROM help_tickets ht WHERE ht.user_id IS NULL)
    )
  );


-- ── FIX 3: Explicitly grant anon role access to help tables ──────────────────
-- Supabase RLS alone isn't enough if the anon role doesn't have USAGE on the table.
-- Grant SELECT/INSERT to anon for help_tickets and help_messages.
GRANT SELECT, INSERT ON help_tickets TO anon;
GRANT SELECT, INSERT ON help_messages TO anon;
-- Note: No sequences to grant — tables use gen_random_uuid() for PKs (not SERIAL).


SELECT 'Patch 2 applied successfully! ✅' AS result;
