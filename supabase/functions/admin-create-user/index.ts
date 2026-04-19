// admin-create-user/index.ts
// Supabase Edge Function — runs with service role key, can create Auth users

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // Verify the caller has a valid JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing Authorization header', success: false }), { status: 401, headers: corsHeaders });
    }

    // Create admin client (service role — can create/delete auth users)
    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify caller's identity via their JWT
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user: callerUser }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !callerUser) {
      return new Response(JSON.stringify({ error: 'Unauthorized: invalid token', success: false }), { status: 403, headers: corsHeaders });
    }

    // Check caller is admin (is_admin flag OR master email)
    const { data: callerProfile } = await adminClient
      .from('profiles')
      .select('is_admin, email')
      .eq('id', callerUser.id)
      .single();

    const isMasterAdmin = callerProfile?.email === 'dragonartserpent@gmail.com';
    if (!callerProfile?.is_admin && !isMasterAdmin) {
      return new Response(JSON.stringify({ error: 'Forbidden: admin only', success: false }), { status: 403, headers: corsHeaders });
    }

    // Parse request body
    let body: any;
    try {
      const bodyText = await req.text();
      console.log('ADMIN-CREATE-USER: raw body:', bodyText);
      body = JSON.parse(bodyText);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body', success: false }), { status: 400, headers: corsHeaders });
    }

    const { email, password, full_name, username, is_admin } = body;
    console.log('ADMIN-CREATE-USER: payload:', { email, full_name, username, is_admin });

    // Validate required fields
    if (!email?.trim() || !password?.trim() || !full_name?.trim() || !username?.trim()) {
      return new Response(JSON.stringify({ error: 'Missing required fields: email, password, full_name, username', success: false }), { status: 400, headers: corsHeaders });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: 'Password must be at least 6 characters', success: false }), { status: 400, headers: corsHeaders });
    }

    const cleanUsername = username.toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
    const cleanEmail = email.toLowerCase().trim();

    // Check for existing email in auth.users (prevents duplicate auth accounts)
    const { data: existingAuthUsers } = await adminClient.auth.admin.listUsers({ perPage: 1 });
    // Note: listUsers doesn't support filter by email directly, so check profiles table instead
    
    // Check username uniqueness
    const { data: existingUsername } = await adminClient
      .from('profiles')
      .select('id')
      .eq('username', cleanUsername)
      .maybeSingle();
    if (existingUsername) {
      return new Response(JSON.stringify({ error: `Username "@${cleanUsername}" is already taken`, success: false }), { status: 409, headers: corsHeaders });
    }

    // Check email uniqueness in profiles
    const { data: existingEmail } = await adminClient
      .from('profiles')
      .select('id')
      .eq('email', cleanEmail)
      .maybeSingle();
    if (existingEmail) {
      return new Response(JSON.stringify({ error: `Email "${cleanEmail}" is already registered`, success: false }), { status: 409, headers: corsHeaders });
    }

    console.log('ADMIN-CREATE-USER: creating auth user...');

    // Create the auth user — this triggers handle_new_user automatically
    const { data: newAuthUser, error: authError } = await adminClient.auth.admin.createUser({
      email: cleanEmail,
      password,
      email_confirm: true, // Pre-verified — no email confirmation needed
      user_metadata: {
        full_name: full_name.trim(),
        username: cleanUsername,
        is_admin: is_admin || false,  // FIX: pass is_admin so trigger sets it correctly
      },
    });

    if (authError || !newAuthUser?.user) {
      console.error('ADMIN-CREATE-USER: auth error:', authError);
      return new Response(
        JSON.stringify({ error: `Auth Error: ${authError?.message || 'Unknown error'}`, success: false }),
        { status: 400, headers: corsHeaders }
      );
    }

    const newUserId = newAuthUser.user.id;
    console.log('ADMIN-CREATE-USER: auth user created:', newUserId);

    // Wait briefly for the trigger to complete its profile insert
    await new Promise(resolve => setTimeout(resolve, 300));

    // Upsert profile to ensure all fields are set correctly
    // (trigger may have already created a partial row — upsert fills in the rest)
    const { error: profileError } = await adminClient.from('profiles').upsert({
      id: newUserId,
      full_name: full_name.trim(),
      username: cleanUsername,
      email: cleanEmail,
      privacy_mode: 'public',
      is_admin: is_admin || false,
    }, {
      onConflict: 'id',        // Upsert on primary key
      ignoreDuplicates: false,  // Always update existing row
    });

    if (profileError) {
      console.error('ADMIN-CREATE-USER: profile upsert error:', profileError);
      // Don't rollback — auth user was created successfully, profile is secondary
      // The trigger should have created a basic profile; upsert just updates it
      // Only rollback if it's a truly unrecoverable error (e.g. username still taken after dedup)
      if (profileError.code === '23505') {
        // Unique constraint — try with a modified username
        const fallbackUsername = cleanUsername + '_' + newUserId.slice(0, 4);
        const { error: retryError } = await adminClient.from('profiles').upsert({
          id: newUserId,
          full_name: full_name.trim(),
          username: fallbackUsername,
          email: cleanEmail,
          privacy_mode: 'public',
          is_admin: is_admin || false,
        }, { onConflict: 'id' });

        if (retryError) {
          console.error('ADMIN-CREATE-USER: profile retry error:', retryError);
          await adminClient.auth.admin.deleteUser(newUserId);
          return new Response(
            JSON.stringify({ error: `Profile Error: ${retryError.message}`, success: false }),
            { status: 400, headers: corsHeaders }
          );
        }
        // Success with fallback username
        return new Response(
          JSON.stringify({ success: true, user_id: newUserId, note: `Username changed to ${fallbackUsername} (was taken)` }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    console.log('ADMIN-CREATE-USER: success!', newUserId);

    return new Response(
      JSON.stringify({ success: true, user_id: newUserId }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err: any) {
    console.error('ADMIN-CREATE-USER: unexpected error:', err);
    return new Response(
      JSON.stringify({ error: err.message || 'Internal server error', success: false }),
      { status: 500, headers: corsHeaders }
    );
  }
});
