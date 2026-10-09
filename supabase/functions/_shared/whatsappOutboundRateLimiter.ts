// Fase 3.5.2.2 — Rate limiting de abuso para o envio outbound.
//
// AVISO HONESTO (nunca escondido): este módulo é uma proteção de
// ABUSO best-effort — conta tentativas recentes do usuário e recusa
// acima de um limiar. NÃO é a fronteira de segurança contra envio
// duplicado (essa já existe e já foi provada empiricamente: o claim
// por client_token + o CAS atômico queued->sending, migrations
// 020/021). Duas chamadas verdadeiramente simultâneas podem, em
// teoria, ler a mesma contagem antes de qualquer uma inserir
// (race benigna de at most +1 sobre o limiar) — isso é aceitável para
// um limite de abuso, e seria INACEITÁVEL se fosse a defesa contra
// duplicidade (que não é — essa responsabilidade nunca é delegada a
// este módulo).
//
// Client sempre injetado (nunca criado aqui) — 100% testável em
// Vitest/Node.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export const OUTBOUND_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const OUTBOUND_RATE_LIMIT_MAX_ATTEMPTS_PER_WINDOW = 20;

export type CheckOutboundRateLimitResult =
  | { status: 'RATE_OK' }
  | { status: 'RATE_LIMITED' }
  | { status: 'REPOSITORY_ERROR'; error: unknown };

export interface SupabaseCountQueryResult {
  count: number | null;
  error: unknown | null;
}

// Contrato estrutural mínimo — só o suficiente para uma contagem
// filtrada por usuário e janela de tempo.
export interface RateLimitServiceClient {
  from(table: string): {
    select(columns: string, options: { count: 'exact'; head: true }): {
      eq(column: string, value: unknown): {
        gte(column: string, value: string): PromiseLike<SupabaseCountQueryResult>;
      };
    };
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidInput(userId: unknown, client: unknown): RateLimitServiceClient {
  if (!isNonBlankString(userId)) {
    throw new TypeError('checkOutboundRateLimit: userId deve ser uma string nao vazia');
  }
  if (
    client === null
    || typeof client !== 'object'
    || typeof (client as { from?: unknown }).from !== 'function'
  ) {
    throw new TypeError('checkOutboundRateLimit: supabaseServiceClient deve expor um metodo from(table)');
  }
  return client as RateLimitServiceClient;
}

export async function checkOutboundRateLimit(
  input: { userId: unknown },
  supabaseServiceClient: unknown,
  now: () => Date,
  maxAttemptsPerWindow: number = OUTBOUND_RATE_LIMIT_MAX_ATTEMPTS_PER_WINDOW,
): Promise<CheckOutboundRateLimitResult> {
  const client = assertValidInput(input?.userId, supabaseServiceClient);
  const userId = input.userId as string;
  const windowStart = new Date(now().getTime() - OUTBOUND_RATE_LIMIT_WINDOW_MS).toISOString();

  try {
    const { count, error } = await client
      .from('whatsapp_messages')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('last_attempted_at', windowStart);

    if (error) {
      return { status: 'REPOSITORY_ERROR', error };
    }
    if (typeof count !== 'number') {
      return { status: 'REPOSITORY_ERROR', error: new Error('checkOutboundRateLimit: count ausente na resposta do client') };
    }

    return count >= maxAttemptsPerWindow ? { status: 'RATE_LIMITED' } : { status: 'RATE_OK' };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}
