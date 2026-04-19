-- 1. Make user_id optional so anonymous users can submit tickets
ALTER TABLE help_tickets ALTER COLUMN user_id DROP NOT NULL;

-- 2. Add guest_id column to track anonymous users by local storage UUID
ALTER TABLE help_tickets ADD COLUMN IF NOT EXISTS guest_id TEXT;

-- 3. Replace the Admin RPC to use LEFT JOIN so anonymous tickets don't vanish
CREATE OR REPLACE FUNCTION admin_get_all_tickets()
RETURNS TABLE(
  id UUID, user_id UUID, guest_id TEXT, subject TEXT, status TEXT,
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
  SELECT t.id, t.user_id, t.guest_id, t.subject, t.status, t.created_at, t.updated_at,
         COALESCE(p.username, 'Guest_' || SUBSTRING(t.guest_id, 1, 6)) as username, 
         COALESCE(p.full_name, 'Anonymous Guest') as full_name, 
         COALESCE(p.email, 'guest@mkp.local') as email
  FROM help_tickets t
  LEFT JOIN profiles p ON p.id = t.user_id
  ORDER BY t.created_at DESC;
END;
$$;

-- 4. Update Policy to let anyone insert a ticket (if they want to)
-- We allow insertion regardless of auth state, but restrict SELECTs.
DROP POLICY IF EXISTS "Users can insert own tickets" ON help_tickets;

CREATE POLICY "Anyone can insert a ticket"
  ON help_tickets FOR INSERT
  WITH CHECK (
    (auth.uid() IS NOT NULL AND user_id = auth.uid()) 
    OR 
    (auth.uid() IS NULL AND guest_id IS NOT NULL)
  );

-- 5. Help messages allow inserts from anonymous
DROP POLICY IF EXISTS "Ticket participants can insert messages" ON help_messages;

CREATE POLICY "Ticket participants can insert messages"
  ON help_messages FOR INSERT
  WITH CHECK (
    (auth.uid() IS NOT NULL AND sender_id = auth.uid())
    OR
    (auth.uid() IS NULL AND sender_role = 'user')
    OR
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND is_admin = TRUE)
  );
