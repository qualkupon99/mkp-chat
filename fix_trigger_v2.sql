CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (
    id, email, full_name, username, privacy_mode, is_admin, dob, gender
  )
  VALUES (
    new.id, 
    new.email, 
    COALESCE(new.raw_user_meta_data->>'full_name', 'Admin Account'),
    COALESCE(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8)),
    'public',
    COALESCE((new.raw_user_meta_data->>'is_admin')::boolean, false),
    COALESCE(new.raw_user_meta_data->>'dob', '2000-01-01'),
    COALESCE(new.raw_user_meta_data->>'gender', 'prefer_not_to_say')
  )
  ON CONFLICT (id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    username = EXCLUDED.username,
    dob = EXCLUDED.dob,
    gender = EXCLUDED.gender;
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
