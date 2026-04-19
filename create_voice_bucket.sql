-- MKP Chat: Voice Notes Storage Bucket Setup
-- Run this in your Supabase SQL Editor to resolve the 400 error on Voice Note uploads

-- 1. Create the bucket
INSERT INTO storage.buckets (id, name, public, "file_size_limit", "allowed_mime_types")
VALUES (
    'voice-notes',
    'voice-notes',
    true,        -- Public so <audio src="..."> URLs work easily
    10485760,    -- 10MB limit (sufficient for voice notes)
    ARRAY['audio/webm', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'video/webm']
) ON CONFLICT (id) DO NOTHING;

-- 2. Setup public ready access (download/view)
CREATE POLICY "Public Read Access"
ON storage.objects FOR SELECT
USING (bucket_id = 'voice-notes');

-- 3. Allow authenticated users to upload their own voice notes
CREATE POLICY "Auth Upload Access"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'voice-notes' 
    AND auth.role() = 'authenticated'
);

-- 4. Allow users to update their own notes
CREATE POLICY "Auth Update Access"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'voice-notes' 
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);

-- 5. Allow users to delete their own notes
CREATE POLICY "Auth Delete Access"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'voice-notes' 
    AND auth.role() = 'authenticated'
    AND (storage.foldername(name))[1] = auth.uid()::text
);
