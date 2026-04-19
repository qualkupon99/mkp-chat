import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || 'your_supabase_url';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || 'your_anon_key';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const ch = supabase.channel('test-channel');

ch.on('broadcast', { event: 'test' }, (payload) => console.log('payload', payload))
  .subscribe((status) => {
    console.log('Test channel status:', status);
    process.exit(0);
  });
