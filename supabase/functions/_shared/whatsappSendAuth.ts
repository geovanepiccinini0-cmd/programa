// Fase 3.5.2.2 — Verificação de identidade para o envio outbound.
//
// Responsabilidade ÚNICA: obter a identidade EFETIVAMENTE verificada
// do chamador — NUNCA decodificar o JWT localmente (isso só prova que
// o token tem a FORMA de um JWT assinado com uma chave que talvez
// corresponda ao projeto; nunca prova que a sessão ainda é válida,
// não foi revogada, nem que o usuário ainda existe). A única forma
// aceita aqui é `auth.getUser(jwt)`, que o Supabase Auth valida no
// servidor a cada chamada — mesmo princípio já exigido na revisão de
// arquitetura da Fase 3.5.2 ("usar auth.getUser(), nunca apenas
// decodificar").
//
// Client sempre injetado (nunca criado aqui) — 100% testável em
// Vitest/Node, zero Deno/Supabase/rede reais necessários.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export interface VerifiedIdentity {
  userId: string;
}

export type VerifyIdentityResult =
  | { status: 'OK'; identity: VerifiedIdentity }
  | { status: 'UNAUTHENTICATED' }
  | { status: 'REPOSITORY_ERROR'; error: unknown };

// Contrato estrutural mínimo — só o suficiente para a verificação,
// nunca o tipo completo de @supabase/supabase-js.
export interface AuthClientLike {
  auth: {
    getUser(jwt?: string): PromiseLike<{
      data: { user: { id: unknown } | null } | null;
      error: unknown;
    }>;
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidClient(client: unknown): AuthClientLike {
  if (
    client === null
    || typeof client !== 'object'
    || (client as { auth?: unknown }).auth === null
    || typeof (client as { auth?: unknown }).auth !== 'object'
    || typeof (client as { auth: { getUser?: unknown } }).auth.getUser !== 'function'
  ) {
    throw new TypeError('verifyAuthenticatedIdentity: authClient deve expor auth.getUser(jwt)');
  }
  return client as AuthClientLike;
}

// Extrai o JWT do header Authorization — sem decodificar seu
// conteúdo, apenas separando o esquema "Bearer " do token. Ausência,
// esquema errado, ou token vazio são tratados exatamente da mesma
// forma (UNAUTHENTICATED) — nunca distinguidos na resposta, para não
// revelar detalhes de implementação a um chamador não autenticado.
function extractBearerToken(authorizationHeader: unknown): string | null {
  if (typeof authorizationHeader !== 'string') return null;
  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) return null;
  const token = authorizationHeader.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

export async function verifyAuthenticatedIdentity(
  authorizationHeader: unknown,
  authClient: unknown,
): Promise<VerifyIdentityResult> {
  const client = assertValidClient(authClient);

  const jwt = extractBearerToken(authorizationHeader);
  if (jwt === null) {
    return { status: 'UNAUTHENTICATED' };
  }

  try {
    const { data, error } = await client.auth.getUser(jwt);

    if (error) {
      return { status: 'UNAUTHENTICATED' };
    }
    const userId = data?.user?.id;
    if (!isNonBlankString(userId)) {
      return { status: 'UNAUTHENTICATED' };
    }

    return { status: 'OK', identity: { userId } };
  } catch (thrown) {
    // Falha de transporte/infra ao validar a sessão NUNCA é tratada
    // como "autenticado" por omissão — fail-closed, mas distinta de
    // UNAUTHENTICATED (é uma falha nossa, não uma prova de identidade
    // inválida) para permitir uma resposta 500 honesta ao invés de
    // 401 incorreto.
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}
