// Fase 3.6.0 — Busca e filtros da caixa de entrada WhatsApp. Lógica
// pura (zero React/Supabase), mesmo padrão de whatsappMessages.js/
// whatsappSend.js — testável sem mocks de UI.
//
// IMPORTANTE (ajuste obrigatório do diagnóstico da Fase 3.6): nenhuma
// função aqui lê ou depende de whatsapp_messages.read_at/delivered_at/
// sent_at — esses campos são exclusivamente status de entrega da Meta
// (webhook de status, Fase 3.5.2.3), nunca um conceito de atendimento/
// leitura humana. Esta fase não introduz "não lida" — só busca por
// nome e filtro por etapa/tags do LEAD, a partir de dados já
// carregados (nunca dispara fetch novo).
//
// `conversations` aqui é sempre o resultado de buildConversationSummaries
// (src/lib/whatsappMessages.js), já ordenado por sortConversationsByRecency
// — este módulo NUNCA reordena (requisito 6: preservar cronologia),
// só filtra (Array.prototype.filter preserva a ordem do array de
// entrada).

import { normalizeText } from '../utils.js';

export const EMPTY_CONVERSATION_FILTERS = {
  searchText: '',
  etapa: null,
  tags: [],
};

export function hasActiveConversationFilters(filters) {
  if (!filters) return false;
  return (
    (filters.searchText || '').trim().length > 0
    || Boolean(filters.etapa)
    || (filters.tags && filters.tags.length > 0)
  );
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

function matchesSearchText(conversation, normalizedSearch) {
  if (!normalizedSearch) return true;
  return normalizeText(conversation.leadNome).includes(normalizedSearch);
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

// Filtra `conversations` (lista de resumos já ordenada) combinando
// busca por nome + etapa + tags (requisito 4: todos combináveis, AND
// entre os três critérios). Nunca busca o lead no Supabase — usa
// exclusivamente `leadsById` (já em memória). Uma conversa cujo lead
// ainda não foi carregado (não deveria ocorrer, mas defensivo) nunca
// casa com um filtro de etapa/tags ativo — nunca mostrado por engano,
// nunca lançado.
export function filterConversations(conversations, leadsById, filters) {
  const normalizedSearch = normalizeText((filters && filters.searchText) || '').trim();
  const etapa = (filters && filters.etapa) || null;
  const tags = (filters && filters.tags) || [];

  return conversations.filter((conversation) => {
    const lead = leadsById ? leadsById[conversation.leadId] : undefined;
    return (
      matchesSearchText(conversation, normalizedSearch)
      && matchesEtapa(lead, etapa)
      && matchesTags(lead, tags)
    );
  });
}
