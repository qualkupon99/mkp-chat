-- ============================================================
-- MKP Chat — GROUP CHAT FIX (RLS & Schema)
-- Run this file in the Supabase SQL Editor
-- Safe to run multiple times (idempotent)
-- ============================================================

-- ── 1. FIX `messages` foreign key and nullability constraints ────────────────
-- Group messages do not have a specific `receiver_id`. 
-- We must ensure the DB allows `receiver_id` to be NULL.
DO $$
BEGIN
  ALTER TABLE public.messages ALTER COLUMN receiver_id DROP NOT NULL;
EXCEPTION
  WHEN undefined_column THEN NULL;
END $$;


-- ── 2. RLS POLICIES — CHATS TABLE ───────────────────────────────────────────
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;

-- Drop existing to avoid conflicts
DROP POLICY IF EXISTS "chats_select" ON public.chats;
DROP POLICY IF EXISTS "chats_insert" ON public.chats;
DROP POLICY IF EXISTS "chats_update" ON public.chats;
DROP POLICY IF EXISTS "chats_delete" ON public.chats;

-- SELECT: A user can see the chat if they are the admin OR a participant
CREATE POLICY "chats_select" ON public.chats FOR SELECT TO authenticated
USING (
  admin_id = auth.uid() OR 
  id IN (SELECT chat_id FROM public.chat_participants WHERE user_id = auth.uid())
);

-- INSERT: Any authenticated user can create a group chat
CREATE POLICY "chats_insert" ON public.chats FOR INSERT TO authenticated
WITH CHECK (true);

-- UPDATE: Only the group admin can change group details
CREATE POLICY "chats_update" ON public.chats FOR UPDATE TO authenticated
USING (admin_id = auth.uid());

-- DELETE: Only the group admin can delete the group
CREATE POLICY "chats_delete" ON public.chats FOR DELETE TO authenticated
USING (admin_id = auth.uid());


-- ── 3. RLS POLICIES — CHAT_PARTICIPANTS TABLE ────────────────────────────────
ALTER TABLE public.chat_participants ENABLE ROW LEVEL SECURITY;

-- Drop existing
DROP POLICY IF EXISTS "chat_participants_select" ON public.chat_participants;
DROP POLICY IF EXISTS "chat_participants_insert" ON public.chat_participants;
DROP POLICY IF EXISTS "chat_participants_delete" ON public.chat_participants;

-- SELECT: Authenticated users can see participants (needed to render UI lists)
CREATE POLICY "chat_participants_select" ON public.chat_participants FOR SELECT TO authenticated
USING (true);

-- INSERT: We allow any authenticated user to create participants (so they can invite others when creating the group)
CREATE POLICY "chat_participants_insert" ON public.chat_participants FOR INSERT TO authenticated
WITH CHECK (true);

-- DELETE: A user can leave, OR the group admin can kick them out
CREATE POLICY "chat_participants_delete" ON public.chat_participants FOR DELETE TO authenticated
USING (
  user_id = auth.uid() OR 
  EXISTS (SELECT 1 FROM public.chats WHERE id = chat_id AND admin_id = auth.uid())
);


-- ── 4. ENSURE REALTIME IS ENABLED FOR GROUPS ────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chats'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chats;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'chat_participants'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE chat_participants;
  END IF;
END $$;

SELECT 'Group fixes applied successfully! ✅' AS result;
