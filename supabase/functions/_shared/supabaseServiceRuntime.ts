// Fase 3.2.3.2 — Adapter Deno-only para o client service-role do Supabase.
//
// Responsabilidade ÚNICA: ligar o core testável (supabaseServiceConfig.ts
// + supabaseServiceClient.ts, Fase 3.2.3.1) ao runtime Deno real — nada
// além disso. Zero validação, zero auth options, zero lógica de domínio
// própria: tudo isso já vive no core e nunca é duplicado aqui.
//
// Este arquivo NUNCA é importado por Vitest/Node (o specifier `npm:`
// abaixo não resolve fora do Deno) e NUNCA é importado por src/ — vive
// em supabase/functions/_shared/, fora do grafo do Vite. Validação desta
// fase é estrutural/de regressão, não execução: não há rede, Supabase,
// secret real ou Deno disponível neste ambiente.
//
// Nunca decide ownership/resolução de conta e nunca é importado pelo
// repository (supabase/functions/_shared/integrationAccountRepository.ts)
// nem o importa — a composição entre os dois fica para uma fase futura.

import { createClient } from 'npm:@supabase/supabase-js@2.110.0';
import { readSupabaseServiceConfig } from './supabaseServiceConfig.ts';
import { createSupabaseServiceClient } from './supabaseServiceClient.ts';

export function getSupabaseServiceClient() {
  const config = readSupabaseServiceConfig((key: string) => Deno.env.get(key));

  return createSupabaseServiceClient(config, createClient);
}
