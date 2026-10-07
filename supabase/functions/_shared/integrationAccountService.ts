// Fase 3.2.3.3 — Composição server-side: service-role client × repository.
//
// Responsabilidade ÚNICA: obter um Supabase client (via uma factory
// injetada, nunca criado aqui) e repassá-lo para a busca de candidates
// (via uma função injetada, nunca a implementação concreta importada
// diretamente aqui) — nada além disso. Zero resolução de domínio (isso
// é resolveIntegrationAccount, src/lib/integrationAccount.js, composto
// numa fase futura), zero query própria, zero canonicalization do
// resultado do repository.
//
// Dependency injection, não um import direto do adapter Deno-only
// (supabase/functions/_shared/supabaseServiceRuntime.ts): aquele arquivo
// contém um specifier `npm:` que não resolve em Vitest/Node, então
// importá-lo aqui tornaria este módulo tão não-testável quanto ele.
// Este módulo recebe `getServiceClient`/`findCandidates` como deps,
// mantendo-se 100% testável em Vitest/Node, sem runtime Deno, sem rede,
// sem secret real. O binding com os módulos reais (supabaseServiceRuntime.ts
// + integrationAccountRepository.ts) fica para quem efetivamente consumir
// esta composição numa fase futura (ex.: um Edge Function endpoint) —
// nenhum arquivo de binding Deno-only é criado nesta fase por falta de
// consumidor real ainda.
//
// Ownership (userId) nunca é lido, decidido ou validado aqui — o `input`
// só carrega provider/externalAccountId e é repassado verbatim para
// `findCandidates`. Esta função nunca aceita userId/ownerId/createdBy
// como parâmetro.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

import type {
  RepositoryResult,
  SupabaseServiceClientLike,
} from './integrationAccountRepository.ts';

export type GetServiceClientFn = () => SupabaseServiceClientLike;

export type FindIntegrationAccountCandidatesFn = (
  input: { provider: unknown; externalAccountId: unknown },
  supabaseServiceClient: SupabaseServiceClientLike,
) => Promise<RepositoryResult>;

export interface IntegrationAccountServiceDeps {
  getServiceClient: GetServiceClientFn;
  findCandidates: FindIntegrationAccountCandidatesFn;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

// Precondição de contrato desta composição (erro de programação de quem
// chama), nunca um outcome de negócio/repository — por isso lança antes
// de invocar qualquer dependência. Não duplica a validação de
// provider/externalAccountId: essa já é responsabilidade exclusiva de
// findIntegrationAccountCandidates (o repository real).
function assertValidDeps(deps: unknown): IntegrationAccountServiceDeps {
  if (
    deps === null
    || typeof deps !== 'object'
    || !isFunction((deps as { getServiceClient?: unknown }).getServiceClient)
  ) {
    throw new TypeError('findIntegrationAccountCandidatesWithServiceRole: deps.getServiceClient deve ser uma function');
  }
  if (!isFunction((deps as { findCandidates?: unknown }).findCandidates)) {
    throw new TypeError('findIntegrationAccountCandidatesWithServiceRole: deps.findCandidates deve ser uma function');
  }
  return deps as IntegrationAccountServiceDeps;
}

export async function findIntegrationAccountCandidatesWithServiceRole(
  input: { provider: unknown; externalAccountId: unknown },
  deps: IntegrationAccountServiceDeps,
): Promise<RepositoryResult> {
  const { getServiceClient, findCandidates } = assertValidDeps(deps);

  // Propositalmente sem try/catch: uma exceção de getServiceClient() é
  // falha de configuração/criação do client (propaga como está, nunca
  // REPOSITORY_ERROR). O resultado de findCandidates (OK ou
  // REPOSITORY_ERROR) é devolvido sem qualquer adulteração; se
  // findCandidates rejeitar (sua própria precondição de contrato), a
  // rejeição também propaga sem conversão.
  const client = getServiceClient();
  return findCandidates(input, client);
}
