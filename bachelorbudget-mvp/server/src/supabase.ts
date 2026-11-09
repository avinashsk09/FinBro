import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseAnonKey) {
    return null;
  }
  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export async function checkSupabaseConnection(): Promise<{
  connected: boolean;
  url: string;
  projectId: string;
  latencyMs?: number;
  error?: string;
}> {
  const sb = getSupabaseClient();
  const projectId = supabaseUrl.replace(/^https?:\/\//, '').split('.')[0] || 'unknown';
  if (!sb) {
    return {
      connected: false,
      url: supabaseUrl,
      projectId,
      error: 'Supabase credentials (SUPABASE_URL, SUPABASE_ANON_KEY) are not set',
    };
  }

  const start = Date.now();
  try {
    const { error } = await sb.from('expenses').select('id', { count: 'exact', head: true });
    const latencyMs = Date.now() - start;
    if (error && error.code !== 'PGRST116') {
      return { connected: false, url: supabaseUrl, projectId, latencyMs, error: error.message };
    }
    return { connected: true, url: supabaseUrl, projectId, latencyMs };
  } catch (err) {
    return {
      connected: false,
      url: supabaseUrl,
      projectId,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function syncTransactionToSupabase(
  tx: Record<string, unknown>,
  userId: number,
): Promise<{ success: boolean; error?: string }> {
  const sb = getSupabaseClient();
  if (!sb) return { success: false, error: 'Supabase not configured' };

  try {
    const { error } = await sb.from('expenses').upsert(
      {
        id: tx.id,
        user_id: userId,
        title: tx.title,
        amount: tx.amount,
        currency: tx.currency || 'INR',
        category: tx.category,
        date: tx.date,
        note: tx.note || '',
        shared: Boolean(tx.shared),
        people: typeof tx.people === 'string' ? JSON.parse(tx.people as string) : tx.people || [],
        shares: typeof tx.shares === 'string' ? JSON.parse(tx.shares as string) : tx.shares || [],
        payer: tx.payer || 'Me',
        split_method: tx.splitMethod || tx.split_method || 'equal',
        household_id: tx.householdId ?? tx.household_id ?? null,
        account_id: tx.accountId ?? tx.account_id ?? null,
        type: tx.type || 'expense',
        payment_mode: tx.paymentMode || tx.payment_mode || 'UPI',
        source: tx.source || 'manual',
      },
      { onConflict: 'id' },
    );
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function syncSettlementToSupabase(
  settlement: {
    householdId?: number | null;
    from: string;
    to: string;
    amount: number;
    currency: string;
    settled?: boolean;
    upiReference?: string;
  },
): Promise<{ success: boolean; error?: string }> {
  const sb = getSupabaseClient();
  if (!sb) return { success: false, error: 'Supabase not configured' };

  try {
    const { error } = await sb.from('settlements').insert({
      household_id: settlement.householdId ?? null,
      from_user: settlement.from,
      to_user: settlement.to,
      amount: settlement.amount,
      currency: settlement.currency || 'INR',
      settled: Boolean(settlement.settled),
      settled_at: settlement.settled ? new Date().toISOString() : null,
      upi_reference: settlement.upiReference || null,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
