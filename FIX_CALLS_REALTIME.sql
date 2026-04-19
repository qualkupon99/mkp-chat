-- ============================================================
-- MKP Chat — WebRTC Calls Realtime Fix
-- Run this file in the Supabase SQL Editor
-- ============================================================

-- Ensure the calls table is actually broadcasting realtime events
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE calls;
  END IF;
END $$;

-- Fix the calls table RLS to make sure users can see their own calls
ALTER TABLE public.calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "calls_select" ON public.calls;
DROP POLICY IF EXISTS "calls_insert" ON public.calls;
DROP POLICY IF EXISTS "calls_update" ON public.calls;

-- Anyone can see their own calls (caller or receiver)
CREATE POLICY "calls_select" ON public.calls FOR SELECT TO authenticated
USING (caller_id = auth.uid() OR receiver_id = auth.uid());

-- User can initiate a call
CREATE POLICY "calls_insert" ON public.calls FOR INSERT TO authenticated
WITH CHECK (caller_id = auth.uid());

-- Both caller and receiver can update status
CREATE POLICY "calls_update" ON public.calls FOR UPDATE TO authenticated
USING (caller_id = auth.uid() OR receiver_id = auth.uid());

SELECT 'Calling fixes applied successfully! ✅' AS result;
