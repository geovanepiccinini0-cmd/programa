// Fase 3.6.2 — Estados operacionais de atendimento da conversa
// WhatsApp (pendente_resposta / em_atendimento / aguardando_cliente /
// concluido).
//
// Responsabilidade ÚNICA: chamar a RPC
// apply_whatsapp_conversation_operational_event (migration 024) a
// partir dos DOIS composition roots já aprovados
// (whatsapp-webhook/handler.ts após uma mensagem inbound ser
// efetivamente persistida; whatsapp-send/handler.ts após um envio ser
// efetivamente confirmado) — NUNCA antes do evento real, NUNCA
// especulativo.
//
// DISTINÇÃO EXPLÍCITA (nunca confundida): este é o estado
// OPERACIONAL/HUMANO da conversa (quem precisa agir agora), nunca o
// status de ENTREGA da Meta (whatsapp_messages.status/sent_at/
// delivered_at/read_at, Fase 3.5.2.3) — este módulo nunca lê nem
// escreve em whatsapp_messages.
//
// Client sempre injetado (nunca criado aqui) — 100% testável em
// Vitest/Node. Vive em supabase/functions/_shared/ — fora de src/,
// nunca alcançado pelo build do Vite/bundle do browser.

export type ConversationOperationalEventType = 'inbound_received' | 'outbound_sent';

export interface ApplyConversationOperationalEventInput {
  leadId: string;
  eventType: ConversationOperationalEventType;
  // Correção pós-revisão do PR #68 (achado CONFIRMED: sem isto, um
  // evento atrasado ou fora de ordem podia sobrescrever um estado
  // mais recente — ver migration 024, seção D). SEMPRE o timestamp
  // REAL do evento (occurredAt da mensagem inbound; o instante da
  // confirmação outbound) — NUNCA "agora" por conveniência quando o
  // evento em si já tem um timestamp mais preciso disponível.
  eventTimestamp: string;
}

export type ApplyConversationOperationalEventResult =
  | { outcome: 'APPLIED'; status: string }
  | { outcome: 'REPOSITORY_ERROR'; error: unknown };

export interface ConversationStateServiceClient {
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertValidClient(client: unknown): ConversationStateServiceClient {
  if (
    client === null
    || typeof client !== 'object'
    || typeof (client as { rpc?: unknown }).rpc !== 'function'
  ) {
    throw new TypeError('applyConversationOperationalEvent: supabaseServiceClient deve expor um metodo rpc(fn, params)');
  }
  return client as ConversationStateServiceClient;
}

// Melhor esforço do ponto de vista do CHAMADOR (ver handler.ts dos
// dois webhooks): esta função em si nunca "esconde" um erro — sempre
// retorna REPOSITORY_ERROR em vez de lançar para entradas válidas,
// mas o CHAMADOR decide (e já decide, nos dois composition roots) que
// uma falha aqui nunca altera o resultado do fluxo principal (ACK do
// webhook / resposta de envio), porque esta tabela é um eixo
// secundário, nunca a fonte de verdade de entrega/recebimento.
export async function applyConversationOperationalEvent(
  input: ApplyConversationOperationalEventInput,
  supabaseServiceClient: unknown,
): Promise<ApplyConversationOperationalEventResult> {
  const client = assertValidClient(supabaseServiceClient);

  if (!isNonBlankString(input?.leadId)) {
    throw new TypeError('applyConversationOperationalEvent: leadId deve ser uma string nao vazia');
  }
  if (input?.eventType !== 'inbound_received' && input?.eventType !== 'outbound_sent') {
    throw new TypeError('applyConversationOperationalEvent: eventType deve ser inbound_received ou outbound_sent');
  }
  if (!isNonBlankString(input?.eventTimestamp)) {
    throw new TypeError('applyConversationOperationalEvent: eventTimestamp deve ser uma string nao vazia');
  }

  try {
    const { data, error } = await client.rpc('apply_whatsapp_conversation_operational_event', {
      p_lead_id: input.leadId,
      p_event_type: input.eventType,
      p_event_timestamp: input.eventTimestamp,
    });

    if (error) return { outcome: 'REPOSITORY_ERROR', error };

    const row = Array.isArray(data) && data.length === 1 ? (data[0] as Record<string, unknown>) : null;
    if (!row || typeof row.status !== 'string') {
      return { outcome: 'REPOSITORY_ERROR', error: new Error('apply_whatsapp_conversation_operational_event: resposta inesperada (esperada exatamente 1 linha com status)') };
    }

    return { outcome: 'APPLIED', status: row.status };
  } catch (thrown) {
    return { outcome: 'REPOSITORY_ERROR', error: thrown };
  }
}
