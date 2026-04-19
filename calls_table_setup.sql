-- ============================================================
-- MKP Chat — Calls Table Setup + RLS + Realtime
-- Run this ENTIRE file in Supabase SQL Editor
-- ============================================================

-- ── 1. CREATE CALLS TABLE ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  receiver_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'calling'
                  CHECK (status IN ('calling', 'accepted', 'rejected', 'ended', 'missed')),
  type          TEXT NOT NULL DEFAULT 'audio'
                  CHECK (type IN ('audio', 'video')),
  caller_name   TEXT,
  caller_avatar TEXT,
  sdp           JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. INDEXES ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_calls_receiver_status
  ON calls(receiver_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_calls_caller_status
  ON calls(caller_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_calls_status
  ON calls(status) WHERE status = 'calling';

-- ── 3. AUTO-UPDATE updated_at ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_calls_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS calls_updated_at_trigger ON calls;
CREATE TRIGGER calls_updated_at_trigger
  BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION update_calls_updated_at();

-- ── 4. AUTO-EXPIRE STALE CALLS ─────────────────────────────────────────────────
-- Mark calls as 'missed' if still 'calling' after 60 seconds
CREATE OR REPLACE FUNCTION expire_stale_calls()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE calls
  SET status = 'missed'
  WHERE status = 'calling'
    AND created_at < NOW() - INTERVAL '60 seconds';
END;
$$;

-- ── 5. ENABLE ROW LEVEL SECURITY ───────────────────────────────────────────────
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

-- ── 6. RLS POLICIES ────────────────────────────────────────────────────────────
-- Drop old policies first (safe re-run)
DROP POLICY IF EXISTS "Caller can insert call"           ON calls;
DROP POLICY IF EXISTS "Call participants can read"       ON calls;
DROP POLICY IF EXISTS "Call participants can update"     ON calls;
DROP POLICY IF EXISTS "Call participants can delete"     ON calls;

-- Caller can create a call
CREATE POLICY "Caller can insert call"
  ON calls FOR INSERT
  WITH CHECK (caller_id = auth.uid());

-- Both caller and receiver can read their calls
CREATE POLICY "Call participants can read"
  ON calls FOR SELECT
  USING (caller_id = auth.uid() OR receiver_id = auth.uid());

-- Both can update status (accept/reject/end)
CREATE POLICY "Call participants can update"
  ON calls FOR UPDATE
  USING (caller_id = auth.uid() OR receiver_id = auth.uid());

-- Both can delete/cleanup
CREATE POLICY "Call participants can delete"
  ON calls FOR DELETE
  USING (caller_id = auth.uid() OR receiver_id = auth.uid());

-- ── 7. ENABLE REALTIME ─────────────────────────────────────────────────────────
-- Safe: only adds if not already a member (prevents "already member" error)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calls;
  END IF;
END $$;

-- ── 8. CLEANUP OLD STALE CALLS (run once) ─────────────────────────────────────
-- Remove any stuck 'calling' records older than 5 minutes
UPDATE calls SET status = 'missed'
WHERE status = 'calling' AND created_at < NOW() - INTERVAL '5 minutes';

-- ── 9. VERIFY ─────────────────────────────────────────────────────────────────
-- Run these to verify setup:
-- SELECT * FROM calls LIMIT 5;
-- SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
