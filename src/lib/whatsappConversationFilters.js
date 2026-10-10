// Fase 3.6.0 (busca/etapa/tags) + 3.6.4 (não lidas/estado operacional/
// telefone/prioridade visual) — Busca e filtros da caixa de entrada
// WhatsApp. Lógica pura (zero React/Supabase), mesmo padrão de
// whatsappMessages.js/whatsappSend.js — testável sem mocks de UI.
//
// IMPORTANTE (ajuste obrigatório do diagnóstico da Fase 3.6, ainda
// válido): nenhuma função aqui lê ou depende de
// whatsapp_messages.read_at/delivered_at/sent_at — esses campos são
// exclusivamente status de entrega da Meta (webhook de status, Fase
// 3.5.2.3), nunca um conceito de atendimento/leitura humana. O
// filtro "não lidas" desta fase usa EXCLUSIVAMENTE
// whatsappUnreadTracking.js (leitura humana, last_read_at, Fase
// 3.6.3) — nunca read_at da Meta. O filtro por estado operacional
// usa EXCLUSIVAMENTE conversationOperationalState.js (Fase 3.6.2) —
// nunca o status de entrega.
//
// `conversations` aqui é sempre o resultado de buildConversationSummaries
// (src/lib/whatsappMessages.js), já ordenado por sortConversationsByRecency
// — este módulo NUNCA reordena (requisito explícito da 3.6.4: preservar
// a ordenação por última atividade real), só filtra
// (Array.prototype.filter preserva a ordem do array de entrada). A
// priorização visual (conversationNeedsAttention,
// conversationOperationalState.js) é aplicada pela UI como
// destaque/badge, nunca como critério de ordenação.

import { normalizeText } from '../utils.js';
import { unreadCountForLead } from './whatsappUnreadTracking.js';

export const EMPTY_CONVERSATION_FILTERS = {
  searchText: '',
  etapa: null,
  tags: [],
  // Fase 3.6.4 — novos critérios, sempre combináveis (AND) com os já
  // existentes, mesmo princípio da 3.6.0.
  unreadOnly: false,
  status: null,
};

export function hasActiveConversationFilters(filters) {
  if (!filters) return false;
  return (
    (filters.searchText || '').trim().length > 0
    || Boolean(filters.etapa)
    || (filters.tags && filters.tags.length > 0)
    || Boolean(filters.unreadOnly)
    || Boolean(filters.status)
  );
}

// Dígitos puros de um valor qualquer (busca por telefone nunca exige
// que o atendente digite formatação idêntica à exibida — compara só
// os dígitos, mesmo princípio de normalizePhoneIdentity mas sem
// nenhuma das regras de DDI/DDD daquele módulo: aqui é busca textual
// livre, nunca validação de identidade).
function digitsOnly(value) {
  return (value || '').replace(/\D/g, '');
}

// Mapa leadId -> lead (etapa/tags), construído pelo chamador a partir
// do array `leads` já carregado pelo hook (useWhatsAppInbox) — nunca
// uma nova consulta ao Supabase.
export function buildLeadsById(leads) {
  const map = {};
  for (const lead of leads || []) {
    if (lead && lead.id) map[lead.id] = lead;
  }
  return map;
}

// Fase 3.6.4 — busca passa a cobrir nome OU telefone do lead (OR
// entre os dois campos — o atendente não precisa saber de antemão
// qual vai bater). `searchDigits` vazio (busca sem nenhum dígito,
// ex. "joão") nunca tenta casar por telefone — só nome, preservando
// 100% o comportamento da 3.6.0 para esse caso.
function matchesSearchText(conversation, lead, normalizedSearch, searchDigits) {
  if (!normalizedSearch && !searchDigits) return true;
  if (normalizedSearch && normalizeText(conversation.leadNome).includes(normalizedSearch)) return true;
  if (searchDigits) {
    const leadDigits = digitsOnly(lead && lead.telefone);
    if (leadDigits && leadDigits.includes(searchDigits)) return true;
  }
  return false;
}

function matchesEtapa(lead, etapa) {
  if (!etapa) return true;
  return Boolean(lead) && lead.etapa === etapa;
}

// Combinação por tags: OR entre as tags selecionadas (a conversa
// aparece se o lead tiver AO MENOS UMA das tags marcadas) — mesma
// semântica usual de filtro multi-seleção já praticada no restante do
// CRM (ex. Kanban não filtra por tag hoje, mas é o comportamento
// padrão esperado para "filtrar por tags" em lista).
function matchesTags(lead, selectedTags) {
  if (!selectedTags || selectedTags.length === 0) return true;
  if (!lead || !Array.isArray(lead.tags) || lead.tags.length === 0) return false;
  return selectedTags.some((tag) => lead.tags.includes(tag));
}

// Fase 3.6.4 — filtro "só não lidas". Usa EXCLUSIVAMENTE
// unreadCountForLead (whatsappUnreadTracking.js, leitura HUMANA via
// last_read_at) — nunca whatsapp_messages.read_at/delivered_at/sent_at
// (Meta). `unreadCounts` ausente/null com o filtro ativo nunca finge
// corresponder — trata como 0 não lidas (mesmo fallback seguro já
// usado por unreadCountForLead), nunca lança.
function matchesUnread(conversation, unreadOnly, unreadCounts) {
  if (!unreadOnly) return true;
  return unreadCountForLead(unreadCounts, conversation.leadId) > 0;
}

// Fase 3.6.4 (correção pós-revisão do PR #71, achado CONFIRMED) —
// filtro por estado OPERACIONAL (Fase 3.6.2) — nunca o status de
// entrega da Meta. `conversationStatesByLead` vem de
// buildConversationOperationalStatesMap (conversationOperationalState.js),
// que SEMPRE tem uma entrada por leadId pedido QUANDO O FETCH EM LOTE
// JÁ RESOLVEU para aquele leadId — mas nem o mapa inteiro, nem uma
// entrada específica dele, podem ser tratados como "resolvido" só
// porque existem: uma chave AUSENTE (`conversation.leadId` ainda não
// é chave do mapa) significa "ainda não sabemos" (primeiro
// carregamento em andamento, falha que preservou um mapa de um
// conjunto de leads menor, ou uma conversa nova que apareceu antes do
// próximo fetch em lote) — nunca equivalente a "sabemos que não tem
// linha" (que é hasRow:false, uma resposta REAL do servidor). Por
// isso NUNCA cai no fallback DEFAULT_CONVERSATION_OPERATIONAL_STATUS
// quando a chave está ausente — só quando ela EXISTE com
// hasRow:false. Uma conversa cujo estado ainda não foi determinado
// NUNCA finge corresponder a um filtro de estado ativo: fica de fora
// até o mapa real chegar (a UI usa conversationStatesLoading/
// conversationStatesError para explicar esse "fora" ao usuário, nunca
// este módulo, que é puramente lógico).
function matchesStatus(conversation, status, conversationStatesByLead) {
  if (!status) return true;
  if (!conversationStatesByLead) return false;
  const state = conversationStatesByLead[conversation.leadId];
  if (!state) return false;
  return state.status === status;
}

// Filtra `conversations` (lista de resumos já ordenada) combinando
// busca por nome/telefone + etapa + tags + não lidas + estado
// operacional (todos combináveis, AND entre os critérios — mesmo
// princípio da 3.6.0, estendido na 3.6.4). Nunca busca o lead/estado
// no Supabase — usa exclusivamente `leadsById`/`unreadCounts`/
// `conversationStatesByLead` já em memória (o chamador, useWhatsAppInbox,
// é quem busca). Uma conversa cujo lead ainda não foi carregado (não
// deveria ocorrer, mas defensivo) nunca casa com um filtro de
// etapa/tags ativo — nunca mostrado por engano, nunca lançado.
//
// `context` é um 4º parâmetro OPCIONAL (retrocompatível com as
// chamadas da 3.6.0/3.6.3 que só passavam 3 argumentos) — omiti-lo
// simplesmente desativa os critérios novos (unreadOnly/status),
// comportando-se exatamente como antes desta fase.
export function filterConversations(conversations, leadsById, filters, context = {}) {
  const { unreadCounts, conversationStatesByLead } = context;
  const normalizedSearch = normalizeText((filters && filters.searchText) || '').trim();
  const searchDigits = digitsOnly((filters && filters.searchText) || '');
  const etapa = (filters && filters.etapa) || null;
  const tags = (filters && filters.tags) || [];
  const unreadOnly = Boolean(filters && filters.unreadOnly);
  const status = (filters && filters.status) || null;

  return conversations.filter((conversation) => {
    const lead = leadsById ? leadsById[conversation.leadId] : undefined;
    return (
      matchesSearchText(conversation, lead, normalizedSearch, searchDigits)
      && matchesEtapa(lead, etapa)
      && matchesTags(lead, tags)
      && matchesUnread(conversation, unreadOnly, unreadCounts)
      && matchesStatus(conversation, status, conversationStatesByLead)
    );
  });
}
