// Fase 3.5.2.2 — Resolução do contexto de envio outbound a partir da
// CONVERSA INBOUND EXISTENTE.
//
// Responsabilidade ÚNICA: dado (userId verificado, leadId informado
// pelo chamador), resolver — a partir do próprio banco, NUNCA do
// corpo da requisição — a conta de integração, o destinatário e a
// janela de atendimento de 24h. Isso implementa diretamente a decisão
// de produto da Fase 3.5.2 (V1 só envia para leads com conversa
// inbound já existente) e a exigência de segurança da Fase 3.5.2.2
// (item 2/3): `integration_account_id`, `phone_number_id` e o
// destinatário NUNCA são aceitos como input externo — só derivados
// aqui, sempre a partir de linhas já existentes e validadas.
//
// Este módulo NUNCA reserva, nunca inicia, nunca confirma um envio —
// isso pertence exclusivamente a whatsappOutboundRepository.ts (RPCs
// 020/021). Client sempre injetado (nunca criado aqui) — 100%
// testável em Vitest/Node.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export const OUTBOUND_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ResolvedOutboundSendContext {
  leadId: string;
  integrationAccountId: string;
  phoneNumberId: string;
  recipientPhoneNormalized: string;
  lastInboundAt: Date;
  windowExpiresAt: Date;
}

export type ResolveOutboundSendContextResult =
  | { status: 'OK'; context: ResolvedOutboundSendContext }
  | { status: 'LEAD_NOT_FOUND' }
  | { status: 'LEAD_FORBIDDEN' }
  | { status: 'LEAD_DELETED' }
  | { status: 'NO_INBOUND_CONVERSATION' }
  | { status: 'INTEGRATION_ACCOUNT_INACTIVE' }
  | { status: 'WINDOW_CLOSED'; windowExpiresAt: Date }
  | { status: 'REPOSITORY_ERROR'; error: unknown };

export interface SupabaseQueryResult {
  data: unknown[] | null;
  error: unknown | null;
}

// Contrato estrutural mínimo — só o suficiente para as três queries
// desta fase, nunca o tipo completo de @supabase/supabase-js.
export interface SendContextServiceClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        eq(column: string, value?: unknown): PromiseLike<SupabaseQueryResult>;
        order(column: string, options: { ascending: boolean }): {
          limit(count: number): PromiseLike<SupabaseQueryResult>;
        };
      };
    };
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidInput(userId: unknown, leadId: unknown, client: unknown): SendContextServiceClient {
  if (!isNonBlankString(userId)) {
    throw new TypeError('resolveOutboundSendContext: userId deve ser uma string nao vazia');
  }
  if (!isNonBlankString(leadId)) {
    throw new TypeError('resolveOutboundSendContext: leadId deve ser uma string nao vazia');
  }
  if (
    client === null
    || typeof client !== 'object'
    || typeof (client as { from?: unknown }).from !== 'function'
  ) {
    throw new TypeError('resolveOutboundSendContext: supabaseServiceClient deve expor um metodo from(table)');
  }
  return client as SendContextServiceClient;
}

function firstRow(data: unknown[] | null): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0];
  return (row !== null && typeof row === 'object') ? (row as Record<string, unknown>) : null;
}

export async function resolveOutboundSendContext(
  input: { userId: unknown; leadId: unknown },
  supabaseServiceClient: unknown,
  now: () => Date,
): Promise<ResolveOutboundSendContextResult> {
  const client = assertValidInput(input?.userId, input?.leadId, supabaseServiceClient);
  const userId = input.userId as string;
  const leadId = input.leadId as string;

  try {
    // 1) Lead — ownership e soft-delete são checados ANTES de qualquer
    // outra consulta (fail fast, nunca revela a existência de um lead
    // de outro usuário através de um caminho diferente).
    const leadResult = await client
      .from('leads')
      .select('id, user_id, deleted_at, phone_normalized')
      .eq('id', leadId);

    if (leadResult.error) {
      return { status: 'REPOSITORY_ERROR', error: leadResult.error };
    }
    const leadRow = firstRow(leadResult.data);
    if (!leadRow) {
      return { status: 'LEAD_NOT_FOUND' };
    }
    if (leadRow.user_id !== userId) {
      return { status: 'LEAD_FORBIDDEN' };
    }
    if (leadRow.deleted_at !== null && leadRow.deleted_at !== undefined) {
      return { status: 'LEAD_DELETED' };
    }
    const recipientPhoneNormalized = leadRow.phone_normalized;
    if (!isNonBlankString(recipientPhoneNormalized)) {
      // Lead sem telefone normalizado utilizável — nunca inventa um
      // destinatário, nunca aceita um substituto do corpo da
      // requisição (item 2 do pedido).
      return { status: 'NO_INBOUND_CONVERSATION' };
    }

    // 2) Conversa inbound mais recente — única fonte da
    // integration_account_id (decisão V1: nunca aceita do chamador) e
    // da janela de atendimento de 24h.
    const inboundResult = await client
      .from('whatsapp_messages')
      .select('integration_account_id, occurred_at')
      .eq('lead_id', leadId)
      .eq('direction', 'inbound')
      .order('occurred_at', { ascending: false })
      .limit(1);

    if (inboundResult.error) {
      return { status: 'REPOSITORY_ERROR', error: inboundResult.error };
    }
    const inboundRow = firstRow(inboundResult.data);
    if (!inboundRow || !isNonBlankString(inboundRow.integration_account_id) || !inboundRow.occurred_at) {
      return { status: 'NO_INBOUND_CONVERSATION' };
    }

    const integrationAccountId = inboundRow.integration_account_id;
    const lastInboundAt = new Date(inboundRow.occurred_at as string);
    if (Number.isNaN(lastInboundAt.getTime())) {
      return { status: 'REPOSITORY_ERROR', error: new Error('resolveOutboundSendContext: occurred_at inbound invalido') };
    }

    // 3) Conta de integração — deve existir, estar ativa, e pertencer
    // ao MESMO usuário (defesa em profundidade: o trigger de 018/021
    // já garante isso na escrita, mas esta leitura nunca confia
    // apenas nisso).
    const accountResult = await client
      .from('integration_accounts')
      .select('id, active, user_id, external_account_id')
      .eq('id', integrationAccountId);

    if (accountResult.error) {
      return { status: 'REPOSITORY_ERROR', error: accountResult.error };
    }
    const accountRow = firstRow(accountResult.data);
    if (
      !accountRow
      || accountRow.active !== true
      || accountRow.user_id !== userId
      || !isNonBlankString(accountRow.external_account_id)
    ) {
      return { status: 'INTEGRATION_ACCOUNT_INACTIVE' };
    }

    const windowExpiresAt = new Date(lastInboundAt.getTime() + OUTBOUND_MESSAGING_WINDOW_MS);
    if (now().getTime() > windowExpiresAt.getTime()) {
      return { status: 'WINDOW_CLOSED', windowExpiresAt };
    }

    return {
      status: 'OK',
      context: {
        leadId,
        integrationAccountId,
        phoneNumberId: accountRow.external_account_id,
        recipientPhoneNormalized,
        lastInboundAt,
        windowExpiresAt,
      },
    };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}
