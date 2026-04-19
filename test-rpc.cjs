const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://xuczkbqbyipzgveukhvk.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1Y3prYnFieWlwemd2ZXVraHZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMjA2NTcsImV4cCI6MjA5MTg5NjY1N30.uk1x62M2e4goljA-ObOObDhxsx1fpP2SV505R3Ck7zQ';

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  const { data, error } = await supabase.rpc('get_recent_chats', { current_user_id: '123' });
  console.log('RPC Error:', error);
  console.log('RPC Data:', data);
}

test();
