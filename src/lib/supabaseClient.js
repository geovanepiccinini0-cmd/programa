import { createClient } from '@supabase/supabase-js';

// A anon/publishable key do Supabase é segura para expor publicamente:
// a proteção real dos dados é feita pela Row Level Security no banco
// (veja supabase/schema.sql), não pelo sigilo desta chave. Por isso ela
// pode ficar direto no código, sem precisar de variáveis de ambiente
// no provedor de hospedagem.
const DEFAULT_URL = 'https://zxhhaovyqqqnllldnwdg.supabase.co';
const DEFAULT_ANON_KEY = 'sb_publishable_8W5W8iv8RKKQ6xmB1gmSvw_8ISRCJRu';

const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured ? createClient(url, anonKey) : null;
