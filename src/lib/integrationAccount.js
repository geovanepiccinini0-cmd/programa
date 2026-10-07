// Fase 3.2.1 — Pure Integration Account Resolver. Resolve candidatos
// já buscados pela futura camada server-side (nunca por esta função
// — zero import, zero I/O, zero rede, zero Supabase) em um resultado
// explícito de resolução de conta. Mesmo padrão já estabelecido em
// src/lib/phoneIdentity.js: pura, determinística, nunca muta input.
//
// Ownership (userId) NUNCA é aceito como entrada externa desta
// função — não existe, e nunca deve existir, nenhum parâmetro
// userId/resolvedUserId/ownerId nesta assinatura. A única origem
// possível de userId no resultado é o campo .userId de um candidate
// que já corresponde exatamente a (provider, externalAccountId) —
// nunca um valor vindo do payload de um provider externo (Meta),
// do browser, ou de qualquer outro parâmetro.
//
// Matching é exato, case-sensitive, por igualdade estrita (===) —
// esta função nunca canonicaliza (isso é responsabilidade de uma
// camada separada, Fase 3.2.2). Também nunca confia que `candidates`
// já veio corretamente filtrado pela futura repository layer: refaz
// o matching por (provider, externalAccountId) aqui mesmo, como
// defesa contra um bug de query de quem chamar esta função.

export const INTEGRATION_ACCOUNT_RESOLUTION_STATUS = {
  RESOLVED: 'RESOLVED',
  NOT_FOUND: 'NOT_FOUND',
  INACTIVE: 'INACTIVE',
  AMBIGUOUS: 'AMBIGUOUS',
  INVALID_INPUT: 'INVALID_INPUT',
};

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Nunca lança, mesmo para candidate null/undefined/primitivo — um
// candidate malformado simplesmente não casa com nada (fail-closed),
// nunca "envenena" um match válido de outro candidate no mesmo array.
function readField(candidate, key) {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  return candidate[key];
}

function invalidInput(reason) {
  return { status: INTEGRATION_ACCOUNT_RESOLUTION_STATUS.INVALID_INPUT, reason };
}

export function resolveIntegrationAccount(provider, externalAccountId, candidates) {
  if (!isNonBlankString(provider)) {
    return invalidInput('provider deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!isNonBlankString(externalAccountId)) {
    return invalidInput('externalAccountId deve ser uma string nao vazia e nao so-whitespace');
  }
  if (!Array.isArray(candidates)) {
    return invalidInput('candidates deve ser um array');
  }

  const matches = candidates.filter((candidate) => (
    readField(candidate, 'provider') === provider
    && readField(candidate, 'externalAccountId') === externalAccountId
  ));

  if (matches.length === 0) {
    return { status: INTEGRATION_ACCOUNT_RESOLUTION_STATUS.NOT_FOUND };
  }

  if (matches.length > 1) {
    return { status: INTEGRATION_ACCOUNT_RESOLUTION_STATUS.AMBIGUOUS, candidates: matches };
  }

  const match = matches[0];
  const active = readField(match, 'active');

  // "Não confirmadamente ativo" (false, ausente, ou qualquer valor
  // que não seja estritamente o booleano true) é tratado da mesma
  // forma: INACTIVE. Nunca RESOLVED sem confirmação explícita de
  // active === true.
  if (active !== true) {
    return {
      status: INTEGRATION_ACCOUNT_RESOLUTION_STATUS.INACTIVE,
      integrationAccountId: readField(match, 'integrationAccountId'),
    };
  }

  const userId = readField(match, 'userId');
  const integrationAccountId = readField(match, 'integrationAccountId');

  if (!isNonBlankString(userId)) {
    return invalidInput('candidate correspondente nao possui userId valido');
  }
  if (!isNonBlankString(integrationAccountId)) {
    return invalidInput('candidate correspondente nao possui integrationAccountId valido');
  }

  return {
    status: INTEGRATION_ACCOUNT_RESOLUTION_STATUS.RESOLVED,
    userId,
    integrationAccountId,
  };
}
