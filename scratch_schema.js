const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function checkSchema() {
  // Query 1: Get messages schema
  const { data: messages, error: err1 } = await supabase.from('messages').select('*').limit(1);
  console.log('Messages fetch error:', err1);

  // Query 2: Get a user from profiles
  const { data: profiles, error: err2 } = await supabase.from('profiles').select('id, full_name').limit(2);
  console.log('Profiles:', profiles);

  // Query 3: Check FK constraints by querying pg_catalog via RPC if possible? Can't do that easily without admin key or an RPC.
  // Instead, let's just create an invalid message and see the exact error.
  const { error: err3 } = await supabase.from('messages').insert({
    chat_id: '00000000-0000-0000-0000-000000000000',
    sender_id: '00000000-0000-0000-0000-000000000000',
    receiver_id: '00000000-0000-0000-0000-000000000000',
    content: 'test'
  });
  console.log('Insert error:', err3);
}

checkSchema();
