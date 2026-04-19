import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Get the calling user's JWT to identify them
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401
      })
    }

    // Create a client with the user's token to verify identity
    const supabaseUser = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid session' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 401
      })
    }

    const callerId = user.id
    const { targetId, callType = 'audio', sdp } = await req.json()

    if (!targetId) {
      return new Response(JSON.stringify({ error: 'targetId is required' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      })
    }

    // 1. Fetch target user's privacy preference
    const { data: target, error: targetError } = await supabaseAdmin
      .from('profiles')
      .select('ui_preferences, full_name')
      .eq('id', targetId)
      .single()

    if (targetError || !target) {
      return new Response(JSON.stringify({ error: 'Target user not found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 404
      })
    }

    const privacy = target.ui_preferences?.call_privacy || 'everyone'

    if (privacy === 'nobody') {
      return new Response(JSON.stringify({ error: 'User is not accepting calls' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 403
      })
    }

    if (privacy === 'contacts') {
      const { data: msgs } = await supabaseAdmin.from('messages')
        .select('id')
        .or(`and(sender_id.eq.${callerId},receiver_id.eq.${targetId}),and(sender_id.eq.${targetId},receiver_id.eq.${callerId})`)
        .limit(1)

      if (!msgs || msgs.length === 0) {
        return new Response(JSON.stringify({ error: 'User only accepts calls from contacts' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 403
        })
      }
    }

    // 2. Fetch caller's profile for name/avatar
    const { data: callerProfile } = await supabaseAdmin
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('id', callerId)
      .single()

    // 3. Check for existing active call (prevent duplicates)
    const { data: existingCall } = await supabaseAdmin
      .from('calls')
      .select('id, status')
      .eq('caller_id', callerId)
      .eq('receiver_id', targetId)
      .eq('status', 'calling')
      .single()

    if (existingCall) {
      // Update the existing call with new SDP instead of creating duplicate
      const { data: updatedCall } = await supabaseAdmin
        .from('calls')
        .update({ sdp: sdp || null, created_at: new Date().toISOString() })
        .eq('id', existingCall.id)
        .select()
        .single()

      return new Response(JSON.stringify({ success: true, callId: existingCall.id, reused: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200
      })
    }

    // 4. Insert new call record — this is what triggers the receiver's realtime listener
    const { data: callRecord, error: insertError } = await supabaseAdmin
      .from('calls')
      .insert({
        caller_id: callerId,
        receiver_id: targetId,
        type: callType,
        caller_name: callerProfile?.full_name || 'Unknown',
        caller_avatar: callerProfile?.avatar_url || null,
        status: 'calling',
        sdp: sdp || null
      })
      .select()
      .single()

    if (insertError) {
      console.error('Call insert error:', insertError)
      return new Response(JSON.stringify({ error: 'Failed to create call: ' + insertError.message }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500
      })
    }

    console.log('✅ Call record created:', callRecord.id, '| caller:', callerId, '→ receiver:', targetId)

    return new Response(JSON.stringify({ success: true, callId: callRecord.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200
    })

  } catch (error) {
    console.error('Edge function error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    })
  }
})
