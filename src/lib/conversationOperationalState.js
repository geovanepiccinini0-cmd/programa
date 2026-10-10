// Fase 3.6.2 — Estados operacionais de atendimento da conversa
// WhatsApp (migration 024, tabela whatsapp_conversation_state).
// Lógica pura (zero React/Supabase), mesmo padrão de constants.js —
// testável sem mocks de UI.
//
// DISTINÇÃO EXPLÍCITA (nunca confundida): isto é o estado
// OPERACIONAL/HUMANO da conversa (quem precisa agir agora), nunca o
// status de ENTREGA da Meta (whatsapp_messages.status/sent_at/
// delivered_at/read_at, Fase 3.5.2.3). Este módulo nunca lê nem
// deriva nada de whatsapp_messages.

export const CONVERSATION_OPERATIONAL_STATES = [
  { value: 'pendente_resposta', label: 'Pendente de resposta' },
  { value: 'em_atendimento', label: 'Em atendimento' },
  { value: 'aguardando_cliente', label: 'Aguardando cliente' },
  { value: 'concluido', label: 'Concluído' },
];

export const CONVERSATION_OPERATIONAL_STATE_LABELS = CONVERSATION_OPERATIONAL_STATES.reduce(
  (acc, s) => { acc[s.value] = s.label; return acc; },
  {},
);

export function conversationOperationalStateLabel(status) {
  return CONVERSATION_OPERATIONAL_STATE_LABELS[status] || 'Pendente de resposta';
}

// Mapeia a linha de public.whatsapp_conversation_state (migration
// 024) para camelCase — mesmo princípio de whatsappMessageFromRow
// (src/lib/whatsappMessages.js).
export function conversationOperationalStateFromRow(r) {
  if (!r) return null;
  return {
    leadId: r.lead_id,
    userId: r.user_id,
    status: r.status,
    updatedAt: r.updated_at,
    // Fase 3.6.3 — timestamp de leitura HUMANA (atendente), nunca
    // whatsapp_messages.read_at (leitura da Meta). null = conversa
    // ainda nunca aberta pelo atendente.
    lastReadAt: r.last_read_at ?? null,
  };
}

// HOTFIX pós-incidente em produção (alteração manual de status
// falhando com HTTP 403 / SQLSTATE 42501) — classifica o erro do
// PASSO 2 (INSERT) do novo fluxo de duas etapas de
// conversationStateApi.setStatus (db.js): '23505' é o SQLSTATE de
// unique_violation — significa que outra inserção (quase sempre a
// RPC automática apply_whatsapp_conversation_operational_event,
// service_role, migration 024) criou a linha para este lead_id
// exatamente entre o UPDATE (passo 1, que não encontrou nenhuma
// linha) e o INSERT (passo 2) — nunca um erro real a propagar, só o
// sinal para repetir o UPDATE uma vez (a linha concorrente já
// existe). Extraído como função pura só para documentar
// explicitamente esse contrato de erro e ser testável sem mockar o
// cliente Supabase.
export function isConversationStateUniqueViolation(error) {
  return Boolean(error) && error.code === '23505';
}
