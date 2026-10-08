import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { leadsApi, whatsappMessagesApi } from '../lib/db.js';
import { applyRealtimeChange } from './useAppState.js';
import {
  buildConversationSummaries,
  sortConversationsByRecency,
  sortMessagesChronologically,
  mergeOlderPage,
  mergeFetchedSnapshot,
  mergeRealtimeMessage,
  shouldApplyLeadRealtimeChange,
  subscribeToWhatsAppInboxRealtime,
  PAGE_SIZE,
  RECENT_WINDOW_SIZE,
} from '../lib/whatsappMessages.js';

// Fase 3.5.1 — Caixa de entrada WhatsApp, SOMENTE LEITURA.
// Fase 3.5.1 (correção pós-auditoria) — ver comentários inline para
// cada um dos 4 findings corrigidos (HIGH paginação, MEDIUM corrida
// fetch/Realtime, MEDIUM retry sem cancelamento, MEDIUM nomes de lead
// desatualizados) e o LOW documentado (admin).
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
//
// LOW (documentado, decisão pendente, NUNCA amplie permissões aqui):
// `leadsApi.fetchAll(userId)`/`whatsappMessagesApi.fetchRecentForUser(userId,...)`
// são chamados SEMPRE com o userId do usuário logado — mesmo para um
// admin. A RLS (migration 018/schema.sql) permitiria a um admin ler
// todas as linhas (policy "admin pode ler tudo"), mas esta tela
// mantém DELIBERADAMENTE o comportamento restrito a "só minhas
// conversas" por agora (mesmo para admin) — nunca o contrário (nunca
// menos restritivo que a RLS). Ampliar isso para "admin vê tudo"
// (equivalente a MetricasView.jsx, que já usa leadsApi.fetchAllForAdmin()
// para esse fim) é uma decisão de produto EXPLICITAMENTE fora do
// escopo desta correção — não implementada aqui de propósito.
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
  const [threadRetryToken, setThreadRetryToken] = useState(0);
  const [hasMoreOlderMessages, setHasMoreOlderMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);

  // Carrega leads (nome de exibição + reaproveitar LeadModal na
  // navegação "ver lead") e a janela recente de mensagens — mesma
  // proteção contra race/usuário trocado já usada em useAppState.js
  // (invalida o state ANTES do fetch, cancelamento via flag local).
  //
  // Fase 3.5.1 — correção do finding MEDIUM "corrida fetch vs
  // Realtime": `setRecentMessages` NUNCA substitui o estado por
  // `messagesData` diretamente — sempre via mergeFetchedSnapshot, que
  // preserva qualquer mensagem que o canal Realtime já tenha entregue
  // ENQUANTO este fetch estava em voo (ver whatsappMessages.js). O
  // `setRecentMessages([])` abaixo, antes do fetch, ainda é necessário
  // e correto: limpa explicitamente o estado de um usuário/janela
  // ANTERIOR antes de buscar o novo, nunca mistura dados entre
  // usuários — só a resolução do fetch em si deixou de ser uma
  // substituição cega.
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
        setRecentMessages((prev) => mergeFetchedSnapshot(prev, messagesData));
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

  // Fase 3.5.1 — correção do finding MEDIUM "retry sem cancelamento":
  // loadThread continua recebendo o leadId explicitamente (nunca lê de
  // closure), mas agora é chamado EXCLUSIVAMENTE pelo efeito abaixo —
  // nunca diretamente por retryThread (ver correção adiante). Isso
  // garante que a função de limpeza (`cancelled`) retornada é SEMPRE
  // executada pelo React antes de qualquer nova chamada (troca de
  // conversa OU retry), nunca descartada.
  const loadThread = useCallback((leadId) => {
    if (!leadId) return undefined;
    let cancelled = false;
    setThreadLoading(true);
    setThreadError(null);
    setThreadMessages([]);
    whatsappMessagesApi.fetchPageForLead(leadId, { limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        // mergeFetchedSnapshot (nunca substituição direta): preserva
        // qualquer mensagem que o Realtime já tenha entregue para esta
        // MESMA conversa enquanto esta página estava em voo (o reset
        // setThreadMessages([]) acima já garante que nada de uma
        // conversa ANTERIOR sobrevive para ser mesclado aqui).
        setThreadMessages((prev) => sortMessagesChronologically(mergeFetchedSnapshot(prev, page)));
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

  // Fase 3.5.1 — correção do finding MEDIUM "retry sem cancelamento":
  // `threadRetryToken` entra na dependência deste efeito — retryThread
  // (abaixo) só incrementa o token, NUNCA chama loadThread diretamente.
  // Isso significa que um retry e uma troca de conversa percorrem
  // EXATAMENTE o mesmo caminho de cancelamento: ao trocar de conversa
  // (ou disparar outro retry) antes de uma chamada anterior resolver,
  // o React executa a limpeza (`cancelled=true`) dessa chamada anterior
  // ANTES de iniciar a nova — nunca mais um fetch "órfão" sem guarda
  // pode sobrescrever a conversa atualmente selecionada.
  useEffect(() => {
    if (!selectedLeadId) {
      setThreadMessages([]);
      setThreadError(null);
      setHasMoreOlderMessages(false);
      return undefined;
    }
    return loadThread(selectedLeadId);
  }, [selectedLeadId, loadThread, threadRetryToken]);

  const retryThread = useCallback(() => {
    setThreadRetryToken((n) => n + 1);
  }, []);

  // Fase 3.5.1 — correção do finding HIGH "paginação com timestamps
  // iguais": o cursor agora é o PAR (occurred_at, id) da mensagem mais
  // antiga já carregada — nunca só occurred_at (ver db.js para o
  // filtro composto real). mergeOlderPage já é seguro quanto a
  // corrida/duplicação (usa a forma funcional `setThreadMessages(prev
  // => ...)`, recalculando sobre o estado MAIS ATUAL no momento da
  // resolução, nunca uma captura obsoleta).
  const loadOlderMessages = useCallback(async () => {
    if (!selectedLeadId || loadingOlderMessages || threadMessages.length === 0) return;
    setLoadingOlderMessages(true);
    try {
      const oldest = threadMessages[0];
      const olderPage = await whatsappMessagesApi.fetchPageForLead(selectedLeadId, {
        beforeOccurredAt: oldest.occurredAt,
        beforeId: oldest.id,
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

  // Realtime — UM ÚNICO canal (nunca dois) escutando tanto
  // whatsapp_messages quanto leads (correção do finding MEDIUM "nomes
  // de lead desatualizados"): lead novo (INSERT, ex. criado pela RPC
  // de inbound) ou editado (UPDATE, ex. via "Ver lead") atualiza
  // `leads` ao vivo via applyRealtimeChange — o MESMO mecanismo já
  // usado/aprovado em useAppState.js, reaproveitado aqui (nunca
  // reimplementado), o que automaticamente corrige o nome exibido em
  // `leadNomeById`/`conversations` sem nenhuma consulta adicional.
  // Mensagens novas/alteradas continuam atualizando a lista de
  // conversas (pool `recentMessages`, via mergeRealtimeMessage — upsert
  // por id, nunca duplica) e, se forem da conversa aberta, também a
  // thread visível. Segurança da ENTREGA de qualquer um dos dois
  // eventos continua sendo a RLS do Postgres (Supabase Realtime
  // respeita RLS de SELECT), nunca um filtro de frontend.
  useEffect(() => {
    if (!userId) return undefined;
    const unsubscribe = subscribeToWhatsAppInboxRealtime(supabase, {
      onMessageChange: (payload) => {
        setRecentMessages((prev) => mergeRealtimeMessage(prev, payload));
        const changedLeadId = (payload.new && payload.new.lead_id) || (payload.old && payload.old.lead_id);
        if (changedLeadId && changedLeadId === selectedLeadId) {
          setThreadMessages((prev) => sortMessagesChronologically(mergeRealtimeMessage(prev, payload)));
        }
      },
      // Correção do finding MEDIUM da auditoria final: ignora
      // eventos cujo row.user_id não corresponda ao usuário logado —
      // mesmo guard de useAppState.js:446, reproduzido via
      // shouldApplyLeadRealtimeChange (src/lib/whatsappMessages.js).
      // Sem isso, um admin (cuja RLS de leads permite "ler tudo")
      // acumularia no estado local leads de OUTROS vendedores, mesmo
      // esta tela sendo deliberadamente restrita a "só minhas
      // conversas".
      onLeadChange: (payload) => {
        if (!shouldApplyLeadRealtimeChange(payload, userId)) return;
        applyRealtimeChange(setLeads, leadsApi.fromRow, payload);
      },
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
