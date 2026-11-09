import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase: SupabaseClient | null = (supabaseUrl && supabaseAnonKey)
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    })
  : null;

export async function checkClientSupabaseHealth(): Promise<{
  connected: boolean;
  projectId: string;
  latencyMs?: number;
  error?: string;
}> {
  if (!supabase || !supabaseUrl) {
    return {
      connected: false,
      projectId: 'none',
      error: 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set',
    };
  }

  const projectId = supabaseUrl.replace(/^https?:\/\//, '').split('.')[0] || 'unknown';
  const start = performance.now();
  try {
    const { error } = await supabase.from('expenses').select('id', { count: 'exact', head: true });
    const latencyMs = Math.round(performance.now() - start);
    if (error && error.code !== 'PGRST116') {
      return { connected: false, projectId, latencyMs, error: error.message };
    }
    return { connected: true, projectId, latencyMs };
  } catch (err) {
    return {
      connected: false,
      projectId,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
