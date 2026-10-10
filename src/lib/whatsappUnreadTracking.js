// Fase 3.6.3 — Controle de leitura humana e mensagens não lidas.
// Lógica pura (zero React/Supabase), mesmo padrão de
// whatsappConversationFilters.js/conversationOperationalState.js —
// testável sem mocks de UI.
//
// DISTINÇÃO EXPLÍCITA (nunca confundida): "não lida" aqui é SEMPRE
// leitura HUMANA do atendente (whatsapp_conversation_state.last_read_at,
// migration 025), nunca whatsapp_messages.read_at (leitura da Meta
// sobre mensagem OUTBOUND, Fase 3.5.2.3). Este módulo nunca lê nem
// deriva nada de read_at/delivered_at/sent_at.
//
// Fonte de verdade do CONTADOR é sempre o servidor (whatsapp_unread_counts(),
// migration 025) — nunca um contador materializado/incrementado no
// cliente que poderia divergir. O estado local (buildUnreadCountsMap +
// applyIncomingMessageToUnreadCounts) é só uma OTIMIZAÇÃO para não
// refazer a consulta agregada a cada mensagem — o próximo reload
// (F5/novo login) sempre recalcula do zero a partir do servidor,
// autocorrigindo qualquer imprecisão client-side.

// Mapa lead_id -> unread_count, a partir das linhas de
// whatsapp_unread_counts() (RPC). Nunca lança — linhas malformadas
// são ignoradas, nunca propagam NaN/undefined para a UI.
export function buildUnreadCountsMap(rows) {
  const map = {};
  for (const row of rows || []) {
    if (!row || !row.leadId) continue;
    const count = Number(row.unreadCount);
    map[row.leadId] = Number.isFinite(count) && count > 0 ? count : 0;
  }
  return map;
}

export function unreadCountForLead(unreadCounts, leadId) {
  if (!unreadCounts || !leadId) return 0;
  return unreadCounts[leadId] || 0;
}

// Aplica uma mensagem recém-chegada via Realtime ao mapa de
// contadores — SÓ incrementa para mensagens INBOUND (requisito
// explícito: nunca contar o que o próprio CRM enviou) de uma
// conversa que NÃO é a atualmente aberta (`selectedLeadId`) — a
// conversa aberta é tratada como "sendo lida ao vivo" pelo próprio
// atendente (ver markConversationRead, chamado separadamente pelo
// hook sempre que uma mensagem chega para a conversa aberta).
// Nunca muta o mapa recebido — retorna um novo objeto (mesmo
// princípio de imutabilidade já usado em whatsappMessages.js).
export function applyIncomingMessageToUnreadCounts(unreadCounts, message, selectedLeadId) {
  if (!message || message.direction !== 'inbound') return unreadCounts;
  if (!message.leadId || message.leadId === selectedLeadId) return unreadCounts;

  const current = unreadCounts || {};
  return {
    ...current,
    [message.leadId]: (current[message.leadId] || 0) + 1,
  };
}

// Zera o contador local de um lead (usado otimisticamente no momento
// em que o atendente abre a conversa, antes mesmo da persistência do
// last_read_at no servidor resolver) — nunca deixa o badge "piscar"
// com o valor antigo entre o clique e a resposta do UPDATE.
export function clearUnreadCountForLead(unreadCounts, leadId) {
  if (!unreadCounts || !leadId || !(leadId in unreadCounts)) return unreadCounts;
  const next = { ...unreadCounts };
  next[leadId] = 0;
  return next;
}
