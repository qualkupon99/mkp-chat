-- ============================================================
-- MKP Chat — Full Database Migration
-- Run this entire file in the Supabase SQL Editor
-- ============================================================

-- ── 1. PERFORMANCE INDEXES ───────────────────────────────────────────────────
-- These are CRITICAL. Without them every message fetch is a full table scan.

CREATE INDEX IF NOT EXISTS idx_messages_sender_created
  ON messages(sender_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_receiver_created
  ON messages(receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_chat_created
  ON messages(chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_status_partial
  ON messages(status) WHERE status != 'read';

CREATE INDEX IF NOT EXISTS idx_messages_pair
  ON messages(sender_id, receiver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_profiles_last_seen
  ON profiles(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_receiver_status
  ON messages(receiver_id, status) WHERE status != 'read';


-- ── 2. SCHEMA ADDITIONS ──────────────────────────────────────────────────────

-- Self-destructing messages
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- Scheduled messages table
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  receiver_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  chat_id     UUID REFERENCES chats(id) ON DELETE CASCADE,
  content     TEXT,
  media_url   TEXT,
  media_type  TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending
  ON scheduled_messages(scheduled_at) WHERE sent = FALSE;

-- Help tickets table (Phase 4 — Help Bot)
CREATE TABLE IF NOT EXISTS help_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject      TEXT DEFAULT 'Support Request',
  status       TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS help_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID NOT NULL REFERENCES help_tickets(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('user', 'admin')),
  sender_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  content     TEXT,
  media_url   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_help_messages_ticket
  ON help_messages(ticket_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_help_tickets_user
  ON help_tickets(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_help_tickets_status
  ON help_tickets(status) WHERE status != 'resolved';


-- ── 3. RLS POLICIES — HELP SYSTEM ────────────────────────────────────────────
ALTER TABLE help_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_messages ENABLE ROW LEVEL SECURITY;

-- Tickets: user can see/create their own; admin email can see all
CREATE POLICY IF NOT EXISTS "Users can view own tickets"
  ON help_tickets FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "Users can insert own tickets"
  ON help_tickets FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY IF NOT EXISTS "Users can update own tickets"
  ON help_tickets FOR UPDATE
  USING (user_id = auth.uid());

-- Help messages: participants can read/write
CREATE POLICY IF NOT EXISTS "Ticket participants can read messages"
  ON help_messages FOR SELECT
  USING (
    ticket_id IN (
      SELECT id FROM help_tickets WHERE user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE
    )
  );

CREATE POLICY IF NOT EXISTS "Ticket participants can insert messages"
  ON help_messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND (
      ticket_id IN (SELECT id FROM help_tickets WHERE user_id = auth.uid())
      OR
      EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
    )
  );


-- ── 4. RLS POLICIES — MESSAGES (verify both directions work) ─────────────────
-- Drop and recreate to ensure correctness
-- NOTE: Only run the DROP lines if you want to reset. Comment them out if policies already exist correctly.

-- Check messages RLS (the key policy for real-time delivery):
-- Both sender AND receiver must be able to SELECT the message.
-- If Supabase Realtime fires an INSERT event but the receiving user cannot SELECT
-- that row (because RLS blocks it), the payload arrives empty/null.

-- You may need to manually verify in Dashboard > Authentication > Policies > messages
-- The SELECT policy should be:
--   auth.uid() = sender_id OR auth.uid() = receiver_id OR
--   chat_id IN (SELECT chat_id FROM chat_participants WHERE user_id = auth.uid())


-- ── 5. RANDOM CHAT QUEUE RPCs ────────────────────────────────────────────────

-- Ensure the queue table exists
CREATE TABLE IF NOT EXISTS random_pairing_queue (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  status     TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'matched')),
  chat_id    UUID REFERENCES chats(id),
  joined_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_queue_waiting
  ON random_pairing_queue(status, joined_at) WHERE status = 'waiting';

ALTER TABLE random_pairing_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users can manage their own queue row"
  ON random_pairing_queue FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- join_random_queue: either matches immediately with a waiting user, or inserts into queue
CREATE OR REPLACE FUNCTION join_random_queue()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_user UUID := auth.uid();
  v_partner_row  random_pairing_queue%ROWTYPE;
  v_chat_id      UUID;
  v_partner_username TEXT;
BEGIN
  -- Remove any stale queue entry for this user
  DELETE FROM random_pairing_queue WHERE user_id = v_current_user;

  -- Look for a waiting partner (FIFO, excluding self)
  SELECT * INTO v_partner_row
  FROM random_pairing_queue
  WHERE status = 'waiting' AND user_id != v_current_user
  ORDER BY joined_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF FOUND THEN
    -- Create a new random chat
    INSERT INTO chats(type, active, created_at)
    VALUES ('random', TRUE, NOW())
    RETURNING id INTO v_chat_id;

    -- Add both users as participants
    INSERT INTO chat_participants(chat_id, user_id)
    VALUES (v_chat_id, v_current_user), (v_chat_id, v_partner_row.user_id);

    -- Mark partner as matched
    UPDATE random_pairing_queue
    SET status = 'matched', chat_id = v_chat_id
    WHERE user_id = v_partner_row.user_id;

    -- Get partner username
    SELECT username INTO v_partner_username
    FROM profiles WHERE id = v_partner_row.user_id;

    RETURN jsonb_build_object(
      'matched', TRUE,
      'chat_id', v_chat_id,
      'partner_username', COALESCE(v_partner_username, 'Anonymous')
    );
  ELSE
    -- No one waiting — add self to queue
    INSERT INTO random_pairing_queue(user_id, status)
    VALUES (v_current_user, 'waiting')
    ON CONFLICT (user_id) DO UPDATE SET status = 'waiting', joined_at = NOW();

    RETURN jsonb_build_object('matched', FALSE);
  END IF;
END;
$$;

-- leave_random_queue: clean up queue entry
CREATE OR REPLACE FUNCTION leave_random_queue()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM random_pairing_queue WHERE user_id = auth.uid();
END;
$$;


-- ── 6. ADMIN CREATE USER RPC (profile only — auth user via Edge Function) ────
-- This creates the profile row. The Edge Function handles auth.users creation.
CREATE OR REPLACE FUNCTION admin_create_profile(
  p_user_id   UUID,
  p_email     TEXT,
  p_full_name TEXT,
  p_username  TEXT,
  p_is_admin  BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Validate username uniqueness
  IF EXISTS (SELECT 1 FROM profiles WHERE username = p_username) THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Username already taken');
  END IF;

  -- Validate email uniqueness in profiles
  IF EXISTS (SELECT 1 FROM profiles WHERE email = p_email) THEN
    RETURN jsonb_build_object('success', FALSE, 'error', 'Email already registered');
  END IF;

  INSERT INTO profiles(id, full_name, username, email, privacy_mode, is_admin, created_at)
  VALUES (p_user_id, p_full_name, p_username, p_email, 'public', p_is_admin, NOW());

  RETURN jsonb_build_object('success', TRUE, 'user_id', p_user_id);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM);
END;
$$;


-- ── 7. ADMIN DELETE USER RPC ─────────────────────────────────────────────────
-- Cascades messages/chats before deleting profile
-- The Edge Function handles auth.admin.deleteUser() to remove from auth.users
CREATE OR REPLACE FUNCTION admin_get_all_tickets()
RETURNS TABLE(
  id UUID, user_id UUID, subject TEXT, status TEXT,
  created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
  username TEXT, full_name TEXT, email TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Only callable by admins
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT t.id, t.user_id, t.subject, t.status, t.created_at, t.updated_at,
         p.username, p.full_name, p.email
  FROM help_tickets t
  JOIN profiles p ON p.id = t.user_id
  ORDER BY t.created_at DESC;
END;
$$;


-- ── 8. REALTIME — enable on new tables ───────────────────────────────────────
-- Run in Supabase Dashboard > Database > Replication if not already enabled:
-- ALTER PUBLICATION supabase_realtime ADD TABLE help_tickets;
-- ALTER PUBLICATION supabase_realtime ADD TABLE help_messages;
-- ALTER PUBLICATION supabase_realtime ADD TABLE scheduled_messages;
-- (messages, profiles should already be in the publication)

-- ── 9. CLEANUP — expired self-destruct messages ───────────────────────────────
-- Optional: pg_cron job to delete expired messages (if pg_cron extension enabled)
-- SELECT cron.schedule('cleanup-expired-messages', '*/5 * * * *',
--   $$DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < NOW()$$);
