// Fase 3.2.3.1 — Factory testável do client service-role do Supabase.
//
// Responsabilidade ÚNICA: validar precondições mínimas de um config já
// lido (ver supabaseServiceConfig.ts) e chamar a factory `createClientFn`
// injetada com (url, serviceRoleKey, options) — nada além disso. NUNCA
// importa o `createClient` real de @supabase/supabase-js (isso fica
// para o adapter Deno-only da Fase 3.2.3.2) — a factory chega
// inteiramente por dependency injection, o que mantém este módulo
// 100% testável em Vitest/Node, sem runtime Deno, sem rede, sem
// secret real.
//
// Nunca decide ownership/resolução de conta — isso permanece
// exclusivamente em src/lib/integrationAccount.js (resolver puro) e em
// supabase/functions/_shared/integrationAccountRepository.ts
// (repository), nenhum dos dois importado aqui. O repository, por sua
// vez, nunca cria seu próprio client — sempre recebe um já pronto
// (produzido por este módulo, numa fase futura de composição) via
// dependency injection.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

import type { SupabaseServiceConfig } from './supabaseServiceConfig.ts';

// Contrato mínimo das options passadas a createClientFn — nunca o tipo
// completo de @supabase/supabase-js (evita acoplamento e import do
// pacote real neste módulo).
export interface SupabaseServiceClientOptions {
  auth: {
    persistSession: false;
    autoRefreshToken: false;
    detectSessionInUrl: false;
  };
}

export type CreateSupabaseClientFn<TClient> = (
  url: string,
  serviceRoleKey: string,
  options: SupabaseServiceClientOptions,
) => TClient;

// Construída de novo a cada chamada (ver uso em createSupabaseServiceClient)
// — nunca um objeto module-level compartilhado. Um objeto único reutilizado
// entre chamadas seria estado mutável global observável: se createClientFn
// (ou qualquer código que receba essa referência) mutar o objeto, a mutação
// vazaria para todas as chamadas seguintes, mesmo as de configs diferentes.
function buildServiceClientOptions(): SupabaseServiceClientOptions {
  return {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Precondição de contrato (erro de programação/configuração de quem
// chama), nunca um outcome de negócio — por isso lança de forma
// síncrona, antes de qualquer chamada a createClientFn. Mesmo que o
// config normalmente já venha validado por readSupabaseServiceConfig,
// esta função falha fechado por conta própria: nunca confia
// silenciosamente que o chamador validou corretamente.
function assertValidConfig(config: unknown): SupabaseServiceConfig {
  if (config === null || typeof config !== 'object') {
    throw new TypeError('createSupabaseServiceClient: config deve ser um objeto');
  }
  const { url, serviceRoleKey } = config as { url?: unknown; serviceRoleKey?: unknown };
  if (!isNonBlankString(url)) {
    throw new TypeError('createSupabaseServiceClient: config.url ausente ou vazia (nao pode ser whitespace-only)');
  }
  if (!isNonBlankString(serviceRoleKey)) {
    throw new TypeError('createSupabaseServiceClient: config.serviceRoleKey ausente ou vazia (nao pode ser whitespace-only)');
  }
  return { url, serviceRoleKey };
}

export function createSupabaseServiceClient<TClient>(
  config: SupabaseServiceConfig,
  createClientFn: CreateSupabaseClientFn<TClient>,
): TClient {
  const { url, serviceRoleKey } = assertValidConfig(config);

  if (typeof createClientFn !== 'function') {
    throw new TypeError('createSupabaseServiceClient: createClientFn deve ser uma function');
  }

  // Propositalmente sem try/catch: uma exceção de createClientFn é erro
  // de criação/configuração do client, nunca convertida para
  // REPOSITORY_ERROR (que pertence exclusivamente à camada de query do
  // repository) e nunca logada aqui.
  return createClientFn(url, serviceRoleKey, buildServiceClientOptions());
}
