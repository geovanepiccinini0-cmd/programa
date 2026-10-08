// Fase 3.5.1 — Caixa de entrada WhatsApp (somente leitura): lógica pura
// de leitura/agrupamento/ordenação/paginação/merge de realtime sobre
// public.whatsapp_messages (migration 018) — zero import de React/
// Supabase, mesmo padrão de src/lib/commercialInteractionHistory.js.
//
// Nomes de coluna usados aqui (via whatsappMessageFromRow) são
// exatamente os da migration 018 — nunca inventados: id, user_id,
// lead_id, integration_account_id, integration_event_id,
// lead_interaction_id, provider, external_message_id, direction,
// message_type, content, status, error_code, occurred_at, sent_at,
// delivered_at, read_at, created_at.
//
// Esta fase é EXCLUSIVAMENTE leitura: nenhuma função aqui cria,
// atualiza ou envia mensagem — isso seria a RPC/Edge Function de
// produção (fora de escopo, migrations 018/019 intocadas).

export function whatsappMessageFromRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    leadId: r.lead_id,
    integrationAccountId: r.integration_account_id,
    integrationEventId: r.integration_event_id,
    leadInteractionId: r.lead_interaction_id,
    provider: r.provider,
    externalMessageId: r.external_message_id,
    direction: r.direction,
    messageType: r.message_type,
    content: r.content,
    status: r.status,
    errorCode: r.error_code,
    occurredAt: r.occurred_at,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export const PAGE_SIZE = 30;
export const RECENT_WINDOW_SIZE = 300;

// Placeholder para mensagens não-textuais — NUNCA tenta baixar/exibir
// a mídia em si (fora de escopo desta fase, decisão já registrada na
// Fase 3.4.1: whatsapp_messages.content nunca guarda payload de mídia).
const NON_TEXT_PLACEHOLDERS = {
  image: '📷 Imagem',
  audio: '🎤 Áudio',
  video: '🎥 Vídeo',
  document: '📄 Documento',
  sticker: '🙂 Sticker',
  location: '📍 Localização',
  contacts: '👤 Contato',
};

// Retorna o texto bruto a exibir — NUNCA sanitiza/escapa HTML aqui:
// essa responsabilidade é do React, que escapa automaticamente todo
// conteúdo renderizado como {texto} dentro de JSX (nunca
// dangerouslySetInnerHTML, nunca interpretado como HTML). Esta função
// só decide QUAL string mostrar, verbatim.
export function messageDisplayText(message) {
  if (!message) return '';
  if (typeof message.content === 'string' && message.content.trim().length > 0) {
    return message.content;
  }
  return NON_TEXT_PLACEHOLDERS[message.messageType] || '📎 Mensagem';
}

export function messagePreviewText(message, maxLength = 60) {
  const text = messageDisplayText(message);
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

// Agrupa mensagens por lead_id, mantendo só a MAIS RECENTE de cada
// lead (por occurredAt) — não assume que `messages` já venha ordenado.
// `leadNomeById`: mapa opcional {leadId: nome} para exibição; lead
// desconhecido/ainda não carregado cai no fallback 'Lead', nunca lança.
export function buildConversationSummaries(messages, leadNomeById = {}) {
  const latestByLead = new Map();
  for (const m of messages) {
    const current = latestByLead.get(m.leadId);
    if (!current || new Date(m.occurredAt).getTime() > new Date(current.occurredAt).getTime()) {
      latestByLead.set(m.leadId, m);
    }
  }
  return Array.from(latestByLead.entries()).map(([leadId, lastMessage]) => ({
    leadId,
    leadNome: leadNomeById[leadId] || 'Lead',
    lastMessage,
    lastMessageAt: lastMessage.occurredAt,
    preview: messagePreviewText(lastMessage),
  }));
}

export function sortConversationsByRecency(conversations) {
  return [...conversations].sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
  );
}

// Fase 3.5.1 — correção do finding HIGH da auditoria independente:
// occurred_at tem granularidade de SEGUNDO (Unix seconds, ver
// whatsappWebhook.ts) — mensagens do mesmo lead no mesmo segundo são
// plausíveis. Um sort/paginação baseado SÓ em occurred_at é não
// determinístico entre execuções quando há empate, e um cursor
// `occurred_at < X` estrito pode pular PERMANENTEMENTE mensagens que
// compartilham o timestamp da borda. A ordenação/paginação real
// (src/lib/db.js) agora usa o cursor composto (occurred_at DESC, id
// DESC) — `id` (uuid) nunca é sequencial/ordenável por si só, mas
// serve como tiebreaker ESTÁVEL (a mesma consulta sempre retorna a
// mesma ordem) e suficiente para nunca excluir uma linha: o par
// (occurred_at, id) é único por construção (id é chave primária).
//
// Histórico cronológico (mais antiga primeiro) para a visualização de
// thread — independente da ordem de chegada do array de entrada.
// Tiebreak por id garante ordem ESTÁVEL entre re-renders quando duas
// mensagens compartilham occurredAt (nunca "pula" nem reordena
// aleatoriamente mensagens empatadas a cada sort).
export function sortMessagesChronologically(messages) {
  return [...messages].sort((a, b) => {
    const diff = new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime();
    if (diff !== 0) return diff;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

// Mescla uma página mais ANTIGA (vinda em ordem desc — "as N mais
// recentes antes do cursor (occurred_at, id)") ao início de uma lista
// já em ordem ascendente, sem nunca duplicar um id já presente
// (idempotente a reaplicações).
export function mergeOlderPage(existingAscending, olderPageDesc) {
  const existingIds = new Set(existingAscending.map((m) => m.id));
  const olderAscending = [...olderPageDesc].reverse().filter((m) => !existingIds.has(m.id));
  return [...olderAscending, ...existingAscending];
}

// Fase 3.5.1 — correção do finding MEDIUM "corrida entre fetch e
// Realtime": NUNCA substituir o estado atual por um snapshot buscado
// (`setX(fetched)`) — sempre mesclar por união de id
// (`setX(prev => mergeFetchedSnapshot(prev, fetched))`). Uma consulta
// que estava em voo quando uma mensagem chegou via Realtime nunca
// apaga essa mensagem: qualquer item já presente em `current` que o
// snapshot buscado não contém é PRESERVADO; para ids presentes nos
// dois, o snapshot buscado vence (leitura mais fresca do banco para
// esses ids especificamente). Nunca duplica (Map por id).
//
// Seguro especificamente para corrida fetch-vs-Realtime (não
// fetch-vs-fetch): dentro do ciclo de vida de UM efeito, só existe uma
// chamada não cancelada por vez (a flag `cancelled` do próprio efeito
// já bloqueia qualquer `.then()` de uma chamada anterior/obsoleta
// antes de chegar aqui) — este merge nunca precisa arbitrar entre
// duas respostas de fetch diferentes, só entre uma resposta de fetch e
// atualizações de Realtime que chegaram durante a mesma janela.
export function mergeFetchedSnapshot(current, fetched) {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of fetched) byId.set(m.id, m);
  return Array.from(byId.values());
}

// Fio fino de inscrição no canal Realtime — extraído para ser
// testável sem React (mesmo princípio de runCommercialRegistration em
// useCommercialRegistration.js): recebe o client já injetado, nunca
// cria/importa @supabase/supabase-js aqui. Retorna a função de
// limpeza (unsubscribe) que o chamador DEVE executar no cleanup do
// useEffect — nunca deixa um canal pendurado entre remontagens/troca
// de usuário.
//
// Fase 3.5.1 — correção do finding MEDIUM "nomes de lead não
// atualizam": UM ÚNICO canal (nunca dois) escuta tanto
// `whatsapp_messages` quanto `leads` — evita subscription duplicada
// (exigência explícita da correção) e cobre tanto lead NOVO (INSERT,
// ex. criado pela RPC de inbound enquanto a caixa está aberta) quanto
// lead EDITADO (UPDATE, ex. via "Ver lead"). onLeadChange é tipicamente
// applyRealtimeChange (useAppState.js, reaproveitado, nunca
// reimplementado) — reaproveita o mecanismo de Realtime já existente e
// aprovado no resto do CRM, em vez de inventar um novo.
export function subscribeToWhatsAppInboxRealtime(supabaseClient, { onMessageChange, onLeadChange }) {
  const channel = supabaseClient
    .channel('crm-piccinini-whatsapp-inbox')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_messages' }, onMessageChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, onLeadChange)
    .subscribe();
  return () => supabaseClient.removeChannel(channel);
}

// Aplica um evento de Supabase Realtime (postgres_changes) a uma lista
// de mensagens JÁ MAPEADA (camelCase) — dedup por id garantido; mesmo
// princípio de applyRealtimeChange (useAppState.js), aqui extraído
// puro/testável. INSERT/UPDATE fazem upsert por id; DELETE remove.
export function mergeRealtimeMessage(messages, payload) {
  if (!payload) return messages;
  if (payload.eventType === 'DELETE') {
    const oldId = payload.old && payload.old.id;
    return messages.filter((m) => m.id !== oldId);
  }
  const row = whatsappMessageFromRow(payload.new);
  const idx = messages.findIndex((m) => m.id === row.id);
  if (idx === -1) return [...messages, row];
  const next = messages.slice();
  next[idx] = row;
  return next;
}
