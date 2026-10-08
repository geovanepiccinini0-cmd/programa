// Fase 3.5.2.2 — Resolução do contexto de envio outbound a partir da
// CONVERSA INBOUND EXISTENTE.
//
// Fase 3.5.2.2 (correção pós-auditoria): o destinatário NUNCA é mais
// lido de leads.phone_normalized (campo editável pelo próprio dono do
// lead a qualquer momento — ver src/lib/db.js, leadToRow). A partir da
// migration 022, cada linha inbound de whatsapp_messages carrega sua
// própria identidade imutável (contact_phone_normalized, o wa_id real
// informado pela Meta para aquela mensagem específica) — é essa coluna,
// nunca a do lead, que este módulo usa como fonte de autoridade do
// destinatário. Editar o telefone cadastral do lead NUNCA mais altera
// o destinatário de uma conversa WhatsApp existente.
//
// Responsabilidade ÚNICA: dado (userId verificado, leadId informado
// pelo chamador), resolver — a partir do próprio banco, NUNCA do
// corpo da requisição — a conta de integração, a identidade imutável
// do destinatário e a janela de atendimento de 24h. integration_account_id,
// contact_phone_normalized e todo o resto NUNCA são aceitos como input
// externo — só derivados aqui, sempre a partir de linhas já existentes
// e validadas.
//
// GARANTIA REFORÇADA (defesa em profundidade, nunca a única camada):
// esta resolução é só o PRIMEIRO nível de checagem (rejeita rápido com
// uma resposta HTTP amigável). A identidade aqui resolvida é
// REVALIDADA de forma independente e transacional dentro da própria
// RPC reserve_whatsapp_outbound_attempt (migration 022) — se algo
// mudar entre esta leitura e a reserva (ex. nova mensagem inbound
// ambígua chega nesse intervalo), a RPC recusa, nunca esta camada
// sozinha.
//
// Este módulo NUNCA reserva, nunca inicia, nunca confirma um envio —
// isso pertence exclusivamente a whatsappOutboundRepository.ts (RPCs
// 020/021/022). Client sempre injetado (nunca criado aqui) — 100%
// testável em Vitest/Node.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser.

export const OUTBOUND_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ResolvedOutboundSendContext {
  leadId: string;
  integrationAccountId: string;
  phoneNumberId: string;
  // Fase 3.5.2.2 — identidade imutável do contato, lida de
  // whatsapp_messages.contact_phone_normalized (NUNCA de
  // leads.phone_normalized).
  contactPhoneNormalized: string;
  lastInboundAt: Date;
  windowExpiresAt: Date;
}

export type ResolveOutboundSendContextResult =
  | { status: 'OK'; context: ResolvedOutboundSendContext }
  | { status: 'LEAD_NOT_FOUND' }
  | { status: 'LEAD_FORBIDDEN' }
  | { status: 'LEAD_DELETED' }
  | { status: 'NO_INBOUND_CONVERSATION' }
  // Fase 3.5.2.2 — a conversa inbound existe, mas os dados persistidos
  // são insuficientes (linha histórica anterior à migration 022, sem
  // contact_phone_normalized) ou ambíguos (mais de uma identidade
  // distinta dentro da janela de 24h) para estabelecer o destinatário
  // com segurança. NUNCA presumido/recuperado de um campo não
  // validado (leads.phone_normalized) — bloqueado explicitamente.
  | { status: 'IDENTITY_UNAVAILABLE' }
  | { status: 'IDENTITY_AMBIGUOUS' }
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
        gte(column: string, value: unknown): PromiseLike<SupabaseQueryResult>;
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

function distinctNonNull(rows: Record<string, unknown>[], column: string): Set<unknown> {
  const values = new Set<unknown>();
  for (const row of rows) {
    const value = row[column];
    if (value !== null && value !== undefined) {
      values.add(value);
    }
  }
  return values;
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
    // outra consulta. Nunca mais usado para obter o destinatário —
    // só para validar propriedade/existência.
    const leadResult = await client
      .from('leads')
      .select('id, user_id, deleted_at')
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

    // 2) Mensagem inbound mais recente — única fonte da
    // integration_account_id e da identidade imutável do destinatário
    // (contact_phone_normalized). NUNCA leads.phone_normalized.
    const latestInboundResult = await client
      .from('whatsapp_messages')
      .select('integration_account_id, occurred_at, contact_phone_normalized')
      .eq('lead_id', leadId)
      .eq('direction', 'inbound')
      .order('occurred_at', { ascending: false })
      .limit(1);

    if (latestInboundResult.error) {
      return { status: 'REPOSITORY_ERROR', error: latestInboundResult.error };
    }
    const latestInboundRow = firstRow(latestInboundResult.data);
    if (!latestInboundRow || !isNonBlankString(latestInboundRow.integration_account_id) || !latestInboundRow.occurred_at) {
      return { status: 'NO_INBOUND_CONVERSATION' };
    }

    const integrationAccountId = latestInboundRow.integration_account_id;
    const lastInboundAt = new Date(latestInboundRow.occurred_at as string);
    if (Number.isNaN(lastInboundAt.getTime())) {
      return { status: 'REPOSITORY_ERROR', error: new Error('resolveOutboundSendContext: occurred_at inbound invalido') };
    }

    const latestContactPhoneNormalized = latestInboundRow.contact_phone_normalized;
    if (!isNonBlankString(latestContactPhoneNormalized)) {
      // Linha inbound histórica (anterior à migration 022) sem
      // identidade imutável persistida — dados insuficientes para
      // estabelecer o destinatário com segurança. NUNCA recuperado de
      // leads.phone_normalized como substituto.
      return { status: 'IDENTITY_UNAVAILABLE' };
    }

    // 3) Ambiguidade — mais de uma identidade de contato distinta
    // entre as mensagens inbound deste lead dentro da janela de 24h
    // que fundamenta o atendimento atual. Mesma checagem feita de
    // forma independente dentro da RPC (defesa em profundidade) —
    // aqui só para uma resposta HTTP rápida e amigável.
    const windowStartIso = new Date(lastInboundAt.getTime() - OUTBOUND_MESSAGING_WINDOW_MS).toISOString();
    const windowInboundResult = await client
      .from('whatsapp_messages')
      .select('contact_phone_normalized')
      .eq('lead_id', leadId)
      .eq('direction', 'inbound')
      .gte('occurred_at', windowStartIso);

    if (windowInboundResult.error) {
      return { status: 'REPOSITORY_ERROR', error: windowInboundResult.error };
    }
    if (!Array.isArray(windowInboundResult.data)) {
      return { status: 'REPOSITORY_ERROR', error: new Error('resolveOutboundSendContext: resposta inesperada na checagem de ambiguidade') };
    }
    const distinctContacts = distinctNonNull(windowInboundResult.data as Record<string, unknown>[], 'contact_phone_normalized');
    if (distinctContacts.size > 1) {
      return { status: 'IDENTITY_AMBIGUOUS' };
    }

    // 4) Conta de integração — deve existir, estar ativa, pertencer ao
    // MESMO usuário, e ser EXPLICITAMENTE provider='whatsapp' (nunca
    // inferido do contexto — item 2 do pedido de correção).
    const accountResult = await client
      .from('integration_accounts')
      .select('id, active, user_id, provider, external_account_id')
      .eq('id', integrationAccountId);

    if (accountResult.error) {
      return { status: 'REPOSITORY_ERROR', error: accountResult.error };
    }
    const accountRow = firstRow(accountResult.data);
    if (
      !accountRow
      || accountRow.active !== true
      || accountRow.user_id !== userId
      || accountRow.provider !== 'whatsapp'
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
        contactPhoneNormalized: latestContactPhoneNormalized,
        lastInboundAt,
        windowExpiresAt,
      },
    };
  } catch (thrown) {
    return { status: 'REPOSITORY_ERROR', error: thrown };
  }
}
