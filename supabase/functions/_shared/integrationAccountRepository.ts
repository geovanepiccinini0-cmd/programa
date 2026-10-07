// Fase 3.2.2.1 — Server-only Integration Account Repository.
//
// Responsabilidade ÚNICA: buscar linhas de public.integration_accounts
// e mapeá-las (snake_case -> camelCase) para o formato de candidate que
// src/lib/integrationAccount.js (resolveIntegrationAccount, Fase 3.2.1)
// já espera. Este módulo NUNCA decide RESOLVED/NOT_FOUND/INACTIVE/
// AMBIGUOUS — isso pertence exclusivamente ao resolver puro, numa fase
// posterior de composição (server boundary). Este módulo também nunca
// escreve no banco, nunca toca integration_events, nunca cria lead ou
// interaction.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser. Roda em runtime Deno (Edge
// Functions), mas nesta fase não lê Deno.env nem cria nenhum client
// real: o client Supabase chega inteiramente por dependency injection,
// o que mantém este módulo 100% testável localmente, sem rede, sem
// Supabase, sem secret algum.
//
// Nunca importa src/lib/supabaseClient.js (client do browser, chave
// anon), nunca importa React, nunca importa src/lib/integrationAccount.js
// (o resolver puro) — essa composição é decidida numa fase posterior.

export interface IntegrationAccountCandidate {
  provider: unknown;
  externalAccountId: unknown;
  userId: unknown;
  integrationAccountId: unknown;
  active: unknown;
}

export type RepositoryResult =
  | { status: 'OK'; candidates: IntegrationAccountCandidate[] }
  | { status: 'REPOSITORY_ERROR'; error: unknown };

export interface SupabaseQueryResult {
  data: unknown[] | null;
  error: unknown | null;
}

// Contrato estrutural mínimo do client injetado — só o suficiente para
// a query que este módulo precisa, nunca o tipo completo do
// @supabase/supabase-js (facilita mock nos testes, evita acoplamento
// e evita instalar dependência nova).
export interface SupabaseServiceClientLike {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value: unknown): PromiseLike<SupabaseQueryResult>;
      };
    };
  };
}

const TABLE = 'integration_accounts';
const SELECT_COLUMNS = 'id, provider, external_account_id, user_id, active';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Precondição de contrato (não é um outcome de negócio/DB): chamar
// esta função com provider/externalAccountId/client fora da forma
// esperada é erro de programação de quem chama, não um estado de
// repository a ser representado como REPOSITORY_ERROR — por isso
// lança de forma síncrona, antes de qualquer tentativa de consulta.
// Deliberadamente NÃO reaproveita INVALID_INPUT do resolver puro
// (responsabilidades diferentes: aquele é sobre domínio/negócio,
// isto é sobre o contrato desta função) e deliberadamente NÃO
// introduz um novo status tipo INVALID_REPOSITORY_INPUT — mantém o
// contrato simples: precondição clara, documentada, testada.
function assertValidInput(
  input: { provider: unknown; externalAccountId: unknown },
  supabaseServiceClient: unknown,
): void {
  if (!isNonBlankString(input?.provider)) {
    throw new TypeError('findIntegrationAccountCandidates: provider deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isNonBlankString(input?.externalAccountId)) {
    throw new TypeError('findIntegrationAccountCandidates: externalAccountId deve ser uma string nao vazia e nao so-whitespace');
  }
  if (
    supabaseServiceClient === null
    || typeof supabaseServiceClient !== 'object'
    || typeof (supabaseServiceClient as { from?: unknown }).from !== 'function'
  ) {
    throw new TypeError('findIntegrationAccountCandidates: supabaseServiceClient deve expor um metodo from(table)');
  }
}

// Mapeamento fiel, determinístico, sem canonicalização, sem defaults,
// sem inferência — nunca "conserta" a linha. Um campo ausente na row
// permanece undefined no candidate (nunca um fallback tipo false/'').
// Nunca lança, mesmo para row null/undefined/primitivo — a validação
// de forma do candidate é responsabilidade do resolver puro, não
// deste mapeamento. Nunca muta a row recebida.
function mapRowToCandidate(row: unknown): IntegrationAccountCandidate {
  const safeRow = (row !== null && typeof row === 'object') ? (row as Record<string, unknown>) : {};
  return {
    integrationAccountId: safeRow.id,
    provider: safeRow.provider,
    externalAccountId: safeRow.external_account_id,
    userId: safeRow.user_id,
    active: safeRow.active,
  };
}

export async function findIntegrationAccountCandidates(
  input: { provider: unknown; externalAccountId: unknown },
  supabaseServiceClient: SupabaseServiceClientLike,
): Promise<RepositoryResult> {
  assertValidInput(input, supabaseServiceClient);

  try {
    const { data, error } = await supabaseServiceClient
      .from(TABLE)
      .select(SELECT_COLUMNS)
      .eq('provider', input.provider)
      .eq('external_account_id', input.externalAccountId);

    if (error) {
      return { status: 'REPOSITORY_ERROR', error };
    }

    // Fail-closed: um client estruturalmente inconsistente (data não
    // é array, mesmo sem error) nunca é silenciosamente tratado como
    // "zero linhas" — isso seria inventar um resultado que o client
    // não forneceu de fato.
    if (!Array.isArray(data)) {
      return {
        status: 'REPOSITORY_ERROR',
        error: new Error('Supabase client retornou data inconsistente (nao e array e nenhum error foi reportado)'),
      };
    }

    return { status: 'OK', candidates: data.map(mapRowToCandidate) };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}
