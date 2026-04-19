-- MKP Chat: Fix Ghost Users (Missing Profiles)
-- Run this in your Supabase SQL Editor to manually sync any auth users that
-- were created by the Admin panel but failed to get a profile entry setup.

INSERT INTO public.profiles (
  id, 
  email, 
  full_name, 
  username, 
  privacy_mode, 
  is_admin, 
  created_at,
  dob,
  gender
)
SELECT 
  au.id, 
  au.email, 
  COALESCE(au.raw_user_meta_data->>'full_name', 'Admin User'),
  COALESCE(
    au.raw_user_meta_data->>'username', 
    'user_' || substr(au.id::text, 1, 8)
  ),
  'public', 
  COALESCE((au.raw_user_meta_data->>'is_admin')::boolean, false),
  CASE WHEN au.created_at IS NOT NULL THEN au.created_at ELSE now() END,
  COALESCE(au.raw_user_meta_data->>'dob', '1990-01-01')::DATE,
  COALESCE(au.raw_user_meta_data->>'gender', 'prefer_not_to_say')
FROM 
  auth.users au
LEFT JOIN 
  public.profiles p ON au.id = p.id
WHERE 
  p.id IS NULL
ON CONFLICT (id) DO NOTHING;
