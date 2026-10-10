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

// Fase 3.6.4 — valor padrão para uma conversa que ainda não tem
// NENHUMA linha em whatsapp_conversation_state (nenhum evento
// automático/manual chegou a criar uma) — mesmo fallback que
// conversationOperationalStateLabel já aplicava implicitamente.
// Centralizado aqui para nunca duplicar a string literal em
// whatsappConversationFilters.js/useWhatsAppInbox.js.
export const DEFAULT_CONVERSATION_OPERATIONAL_STATUS = 'pendente_resposta';

export function conversationOperationalStateLabel(status) {
  return CONVERSATION_OPERATIONAL_STATE_LABELS[status] || CONVERSATION_OPERATIONAL_STATE_LABELS[DEFAULT_CONVERSATION_OPERATIONAL_STATUS];
}

// Fase 3.6.4 — "aguardando resposta" (requisito 4 do escopo da fase):
// é o estado em que o CLIENTE enviou e o CRM ainda não respondeu —
// exatamente `pendente_resposta` (ver comentário da 024 em
// CONVERSATION_OPERATIONAL_STATES). Usado só para PRIORIZAÇÃO
// VISUAL (badge/destaque) — nunca para reordenar a lista, que
// continua exclusivamente por última atividade real
// (sortConversationsByRecency, whatsappMessages.js).
export function conversationNeedsAttention(status) {
  return (status || DEFAULT_CONVERSATION_OPERATIONAL_STATUS) === 'pendente_resposta';
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

// Fase 3.6.4 — agregação em LOTE para a lista inteira de conversas
// (filtro/priorização por estado operacional, requisito 3: "carregue
// estados operacionais em lote, respeitando... o conjunto de
// conversas carregadas"). Pura — recebe os `leadIds` já carregados
// (de `conversations`, nunca uma varredura solta da tabela) e os
// `states` já buscados (um fetch em lote, ver
// conversationStateApi.fetchForLeads em db.js) e devolve um mapa
// `leadId -> estado`, SEMPRE com uma entrada para cada leadId pedido
// — nunca omite um lead só porque ele não tem linha ainda.
//
// DISTINÇÃO EXPLÍCITA (requisito 4 do escopo desta fase): `hasRow`
// diferencia "conversa sem nenhum evento ainda" (hasRow: false,
// status default) de um estado real já persistido (hasRow: true) —
// os dois têm o MESMO `status` aparente quando a linha real também
// está em pendente_resposta, mas só `hasRow` permite ao chamador
// nunca confundir "nunca houve evento" com "sabemos que há um
// evento e é esse". Uma FALHA de carregamento (o fetch em lote
// rejeitou) nunca passa por esta função — o chamador (useWhatsAppInbox)
// preserva o último mapa bom conhecido e expõe o erro em um estado
// SEPARADO (`conversationStatesError`), nunca aqui dentro: esta
// função só conhece "pedido vs. encontrado", nunca "a consulta
// falhou".
export function buildConversationOperationalStatesMap(leadIds, states) {
  const byLeadId = {};
  for (const state of states || []) {
    if (state && state.leadId) byLeadId[state.leadId] = state;
  }
  const map = {};
  for (const leadId of leadIds || []) {
    if (!leadId) continue;
    const found = byLeadId[leadId];
    map[leadId] = found
      ? { ...found, hasRow: true }
      : {
        leadId,
        userId: null,
        status: DEFAULT_CONVERSATION_OPERATIONAL_STATUS,
        updatedAt: null,
        lastReadAt: null,
        hasRow: false,
      };
  }
  return map;
}

// Fase 3.6.4 (correção pós-revisão do PR #71) — aplica um evento
// Realtime de whatsapp_conversation_state ao mapa em lote. Extraído
// do hook para ser puro e testável sem mocks de Supabase/React —
// cobre exatamente o cenário "alteração de estado em outra aba/
// dispositivo" (requisito 3 da correção).
//
// Regras, todas defensivas (nunca lança, nunca expande o escopo):
// - linha sem `lead_id` -> ignorado, mapa inalterado (mesma
//   referência, nunca um novo objeto por engano).
// - `row.user_id` presente e diferente de `userId` -> ignorado
//   (defesa em profundidade; a RLS da 024 já deveria impedir a
//   entrega, mas nunca confiamos só nisso).
// - `lead_id` que NÃO faz parte do mapa já carregado -> ignorado.
//   Nunca adiciona uma conversa nova por este caminho — o conjunto
//   de conversas cobertas pelo fetch em lote (requisito "respeitar o
//   conjunto de conversas carregadas") só cresce pelo próprio fetch
//   em lote, nunca pelo Realtime.
// - DELETE (payload.new ausente) -> volta ao default (hasRow:false),
//   nunca remove a entrada do mapa (a conversa continua carregada,
//   só sem estado real).
export function applyConversationStateRealtimeEvent(conversationStatesByLead, payload, userId) {
  const row = (payload && (payload.new || payload.old)) || null;
  if (!row || !row.lead_id) return conversationStatesByLead;
  if (row.user_id && userId && row.user_id !== userId) return conversationStatesByLead;
  if (!conversationStatesByLead || !(row.lead_id in conversationStatesByLead)) return conversationStatesByLead;

  const mappedRow = payload.new ? conversationOperationalStateFromRow(payload.new) : null;
  return {
    ...conversationStatesByLead,
    [row.lead_id]: mappedRow
      ? { ...mappedRow, hasRow: true }
      : {
        leadId: row.lead_id,
        userId: null,
        status: DEFAULT_CONVERSATION_OPERATIONAL_STATUS,
        updatedAt: null,
        lastReadAt: null,
        hasRow: false,
      },
  };
}

// Fase 3.6.4 (correção pós-revisão do PR #71) — decide se um status
// de assinatura Realtime (supabase-js `channel.subscribe(callback)`)
// exige forçar uma ressincronização via fetch em lote, em vez de
// esperar passivamente por eventos que podem nunca chegar.
//
// IMPORTANTE (documentar o limite real desta função, nunca prometer
// mais do que ela detecta): `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED` são
// falhas de CONEXÃO (rede caiu, timeout do servidor, canal encerrado)
// — nunca o caso de "a tabela não está na publication
// supabase_realtime". Nesse segundo caso, o `subscribe()` tipicamente
// reporta `SUBSCRIBED` normalmente (o websocket foi aceito), mas
// NENHUM evento de `whatsapp_conversation_state` jamais chega — esta
// função não tem como diferenciar isso de "não há mudanças para
// mostrar" a partir do status sozinho. É por isso que a recuperação
// real contra esse cenário específico é o POLLING periódico (ver
// useWhatsAppInbox.js), nunca só este status callback.
export function shouldForceConversationStatesResync(status) {
  return status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED';
}
