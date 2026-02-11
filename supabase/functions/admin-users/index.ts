import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    // Verify the caller is an admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Не авторизован' }), { 
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const anonClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data: { user: caller } } = await anonClient.auth.getUser(authHeader.replace('Bearer ', ''));
    
    if (!caller) {
      return new Response(JSON.stringify({ error: 'Не авторизован' }), { 
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    // Check admin role
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: roleData } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', caller.id)
      .eq('role', 'admin')
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Нет прав администратора' }), { 
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      });
    }

    const { action, ...params } = await req.json();

    if (action === 'create') {
      const { email, password, displayName, role } = params;
      
      // Create user via admin API
      const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      });

      if (createError) throw createError;

      // The trigger will create profile and default role (viewer)
      // If role is not viewer, update it
      if (role && role !== 'viewer' && newUser.user) {
        await adminClient
          .from('user_roles')
          .update({ role })
          .eq('user_id', newUser.user.id);
      }

      return new Response(JSON.stringify({ success: true, userId: newUser.user?.id }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } else if (action === 'delete') {
      const { userId } = params;
      
      // Don't allow deleting yourself
      if (userId === caller.id) {
        return new Response(JSON.stringify({ error: 'Нельзя удалить свой аккаунт' }), { 
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      const { error: deleteError } = await adminClient.auth.admin.deleteUser(userId);
      if (deleteError) throw deleteError;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } else if (action === 'updateRole') {
      const { userId, role } = params;
      
      if (userId === caller.id) {
        return new Response(JSON.stringify({ error: 'Нельзя менять свою роль' }), { 
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        });
      }

      const { error: updateError } = await adminClient
        .from('user_roles')
        .update({ role })
        .eq('user_id', userId);
      
      if (updateError) throw updateError;

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });

    } else if (action === 'list') {
      // List all users with profiles and roles
      const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers();
      if (listError) throw listError;

      const { data: profiles } = await adminClient.from('profiles').select('*');
      const { data: roles } = await adminClient.from('user_roles').select('*');

      const enrichedUsers = users.map(u => ({
        id: u.id,
        email: u.email,
        displayName: profiles?.find(p => p.user_id === u.id)?.display_name || u.email,
        role: roles?.find(r => r.user_id === u.id)?.role || 'viewer',
        createdAt: u.created_at,
      }));

      return new Response(JSON.stringify({ users: enrichedUsers }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { 
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    });

  } catch (error) {
    console.error('Admin users error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Ошибка сервера' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
