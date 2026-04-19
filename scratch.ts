import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

// Load env vars
const envFile = fs.readFileSync('.env', 'utf8');
const lines = envFile.split('\n');
const env: Record<string, string> = {};
for (const line of lines) {
  if (line.trim() && !line.startsWith('#')) {
    const [key, ...value] = line.split('=');
    env[key.trim()] = value.join('=').trim().replace(/^"|"$/g, '');
  }
}

const supabase = createClient(env['VITE_SUPABASE_URL'], env['VITE_SUPABASE_ANON_KEY']);

async function check() {
  console.log("Checking DB policies for chat_participants...");
  const { data: policies, error: polErr } = await supabase.rpc('get_policies');
  if (polErr) console.error("Could not fetch policies via RPC", polErr.message);

  console.log("Checking if receiver_id is nullable in messages...");
  // Try to insert a dummy group message to see the exact error
  // Wait, we need an admin key or valid user. Let's just ask Postgrest for schema using a trick or just write a generic SQL fix.
}

check();
