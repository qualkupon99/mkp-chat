-- Phase 2 Fix: Add missing expires_at column
-- This fixes the "could not find expires_at column" Supabase Postgres error during sending messages with expiry.

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone NULL;
