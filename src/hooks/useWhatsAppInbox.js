import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { leadsApi, whatsappMessagesApi } from '../lib/db.js';
import {
  buildConversationSummaries,
  sortConversationsByRecency,
  sortMessagesChronologically,
  mergeOlderPage,
  mergeRealtimeMessage,
  subscribeToWhatsAppMessages,
  PAGE_SIZE,
  RECENT_WINDOW_SIZE,
} from '../lib/whatsappMessages.js';

// Fase 3.5.1 — Caixa de entrada WhatsApp, SOMENTE LEITURA.
//
// Hook self-contido (mesmo padrão de MetricasView.jsx: busca os
// próprios dados via as *Api existentes, nunca entrelaçado com
// useAppState.js) — minimiza o raio de alteração desta fase. Toda a
// lógica de agrupamento/ordenação/paginação/merge de realtime é
// delegada a src/lib/whatsappMessages.js (puro, testado); este hook só
// faz a fiação com React/Supabase (useState/useEffect/supabase.channel),
// mesmo princípio já usado em useCommercialRegistration.js.
//
// Consultas sempre com a sessão autenticada do usuário (client de
// src/lib/supabaseClient.js, anon key) — NUNCA service_role no
// navegador. A segurança real é a RLS de public.whatsapp_messages
// (migration 018: só SELECT para dono/admin) — este hook nunca decide
// autorização, só exibe o que a RLS já deixou passar.
export function useWhatsAppInbox(userId) {
  const [leads, setLeads] = useState([]);
  const [recentMessages, setRecentMessages] = useState([]);
  const [recentWindowSize, setRecentWindowSize] = useState(RECENT_WINDOW_SIZE);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState(null);
  const [conversationsRetryToken, setConversationsRetryToken] = useState(0);
  const [hasMoreConversationHistory, setHasMoreConversationHistory] = useState(false);

  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);

  // Carrega leads (só para nome de exibição + reaproveitar LeadModal
  // na navegação "ver lead") e a janela recente de mensagens — mesma
  // proteção contra race/usuário trocado já usada em useAppState.js
  // (invalida o state ANTES do fetch, cancelamento via flag local).
  useEffect(() => {
    let cancelled = false;
    setConversationsLoading(true);
    setConversationsError(null);
    setLeads([]);
    setRecentMessages([]);
    Promise.all([
      leadsApi.fetchAll(userId),
      whatsappMessagesApi.fetchRecentForUser(userId, recentWindowSize),
    ])
      .then(([leadsData, messagesData]) => {
        if (cancelled) return;
        setLeads(leadsData);
        setRecentMessages(messagesData);
        setHasMoreConversationHistory(messagesData.length >= recentWindowSize);
        setConversationsLoading(false);
      })
      .catch((e) => {
        if (!cancelled) { setConversationsError(e); setConversationsLoading(false); }
      });
    return () => { cancelled = true; };
  }, [userId, recentWindowSize, conversationsRetryToken]);

  const refetchConversations = useCallback(() => {
    setConversationsRetryToken((n) => n + 1);
  }, []);

  const loadMoreConversationHistory = useCallback(() => {
    setRecentWindowSize((n) => n + RECENT_WINDOW_SIZE);
  }, []);

  const leadNomeById = useMemo(() => {
    const map = {};
    leads.forEach((l) => { map[l.id] = l.nome; });
    return map;
  }, [leads]);

  const conversations = useMemo(
    () => sortConversationsByRecency(buildConversationSummaries(recentMessages, leadNomeById)),
    [recentMessages, leadNomeById],
  );

  const selectedLead = useMemo(
    () => leads.find((l) => l.id === selectedLeadId) || null,
    [leads, selectedLeadId],
  );

  const loadThread = useCallback((leadId) => {
    if (!leadId) return;
    let cancelled = false;
    setThreadLoading(true);
    setThreadError(null);
    setThreadMessages([]);
    whatsappMessagesApi.fetchPageForLead(leadId, { limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setThreadMessages(sortMessagesChronologically(page));
        setHasMoreOlderMessages(page.length >= PAGE_SIZE);
        setThreadLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setThreadError(e);
        setThreadLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const selectConversation = useCallback((leadId) => {
    setSelectedLeadId(leadId);
  }, []);

  useEffect(() => {
    if (!selectedLeadId) {
      setThreadMessages([]);
      setThreadError(null);
      setHasMoreOlderMessages(false);
      return;
    }
    const cleanup = loadThread(selectedLeadId);
    return cleanup;
  }, [selectedLeadId, loadThread]);

  const retryThread = useCallback(() => {
    if (selectedLeadId) loadThread(selectedLeadId);
  }, [selectedLeadId, loadThread]);

  const loadOlderMessages = useCallback(async () => {
    if (!selectedLeadId || loadingOlderMessages || threadMessages.length === 0) return;
    setLoadingOlderMessages(true);
    try {
      const oldest = threadMessages[0];
      const olderPage = await whatsappMessagesApi.fetchPageForLead(selectedLeadId, {
        beforeOccurredAt: oldest.occurredAt,
        limit: PAGE_SIZE,
      });
      setThreadMessages((prev) => mergeOlderPage(prev, olderPage));
      setHasMoreOlderMessages(olderPage.length >= PAGE_SIZE);
    } catch (e) {
      setThreadError(e);
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [selectedLeadId, loadingOlderMessages, threadMessages]);

  // Realtime — mesmo padrão de useAppState.js (channel + postgres_changes
  // + cleanup via removeChannel), aqui restrito à tabela nova. Segurança
  // da ENTREGA do evento continua sendo a RLS do Postgres (Supabase
  // Realtime respeita RLS de SELECT ao decidir o que entregar a cada
  // sessão) — nunca um filtro de frontend. Toda mensagem nova/alterada
  // atualiza a lista de conversas (pool `recentMessages`) e, se for da
  // conversa aberta, também a thread visível.
  useEffect(() => {
    if (!userId) return undefined;
    const unsubscribe = subscribeToWhatsAppMessages(supabase, (payload) => {
      setRecentMessages((prev) => mergeRealtimeMessage(prev, payload));
      const changedLeadId = (payload.new && payload.new.lead_id) || (payload.old && payload.old.lead_id);
      if (changedLeadId && changedLeadId === selectedLeadId) {
        setThreadMessages((prev) => sortMessagesChronologically(mergeRealtimeMessage(prev, payload)));
      }
    });
    return unsubscribe;
  }, [userId, selectedLeadId]);

  return {
    conversations,
    conversationsLoading,
    conversationsError,
    refetchConversations,
    hasMoreConversationHistory,
    loadMoreConversationHistory,

    selectedLeadId,
    selectedLead,
    selectConversation,

    threadMessages,
    threadLoading,
    threadError,
    retryThread,
    hasMoreOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,

    leads,
  };
}
