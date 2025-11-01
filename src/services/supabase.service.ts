import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Service role client for server-side operations
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Helper functions
export const verifySupabaseToken = async (token: string) => {
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  return { user, error };
};

// Fix: Use listUsers with email filter instead of getUserByEmail
export const getUserByEmail = async (email: string) => {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({
    page: 1,
    perPage: 1000
  });
  
  if (error) {
    return { user: null, error };
  }
  
  // Find user by email
  const user = data.users.find(user => user.email === email);
  return { user: user || null, error: null };
};

// Alternative method using database query (more efficient)
export const findSupabaseUserByEmail = async (email: string) => {
  try {
    // Query the auth.users table directly using your database connection
    const { data, error } = await supabaseAdmin
      .from('auth.users')
      .select('*')
      .eq('email', email)
      .single();
      
    return { user: data, error };
  } catch (error) {
    return { user: null, error };
  }
};