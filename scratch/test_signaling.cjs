const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function testSignaling() {
  console.log('--- CALL SIGNALING TEST ---');
  
  // 1. Fetch a target user (not yourself)
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    console.error('Not logged in. Please check .env');
    return;
  }
  
  const { data: profiles } = await supabase.from('profiles').select('id, full_name').neq('id', user.id).limit(1);
  if (!profiles || profiles.length === 0) {
    console.error('No other users found to test with.');
    return;
  }
  
  const target = profiles[0];
  console.log(`Testing call to: ${target.full_name} (${target.id})`);
  
  // 2. Insert into calls
  const { data, error } = await supabase.from('calls').insert({
    caller_id: user.id,
    receiver_id: target.id,
    type: 'audio',
    caller_name: 'Test Runner',
    status: 'calling'
  }).select();
  
  if (error) {
    console.error('INSERT FAILED:', error.message);
    console.error('HINT: Check RLS policies or table existence.');
  } else {
    console.log('INSERT SUCCESS:', data[0]);
    
    // 3. Cleanup
    const { error: delError } = await supabase.from('calls').delete().eq('id', data[0].id);
    if (delError) console.error('Cleanup failed:', delError.message);
    else console.log('Cleanup success.');
  }
}

testSignaling();
