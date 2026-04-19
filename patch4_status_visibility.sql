-- ============================================================
-- MKP Chat — Patch 4: Fix Status Visibility
-- Run in Supabase SQL Editor
-- ============================================================

-- 1. Ensure the statuses table has RLS enabled
ALTER TABLE public.statuses ENABLE ROW LEVEL SECURITY;

-- 2. Drop existing restrictive policies to prevent conflicts
DROP POLICY IF EXISTS "Users can view own statuses" ON public.statuses;
DROP POLICY IF EXISTS "Users can insert own statuses" ON public.statuses;
DROP POLICY IF EXISTS "Users can update own statuses" ON public.statuses;
DROP POLICY IF EXISTS "Users can delete own statuses" ON public.statuses;
DROP POLICY IF EXISTS "Anyone can view statuses" ON public.statuses;

-- 3. Create correct SELECT policy: All authenticated users can view all statuses
CREATE POLICY "All authenticated users can view statuses"
  ON public.statuses FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- 4. Create correct INSERT policy: Users can only insert their own statuses
CREATE POLICY "Users can insert own statuses"
  ON public.statuses FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- 5. Create correct UPDATE policy: Users can only update their own statuses
CREATE POLICY "Users can update own statuses"
  ON public.statuses FOR UPDATE
  USING (user_id = auth.uid());

-- 6. Create correct DELETE policy: Users can only delete their own statuses
CREATE POLICY "Users can delete own statuses"
  ON public.statuses FOR DELETE
  USING (user_id = auth.uid());

SELECT 'Patch 4 applied successfully! All users can now see statuses. ✅' AS result;
