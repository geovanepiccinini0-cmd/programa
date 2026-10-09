import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { leadsApi, whatsappMessagesApi, conversationStateApi } from '../lib/db.js';
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
import {
  generateClientToken,
  computeSendGateStatus,
  buildOptimisticMessage,
  mergeOptimisticWithAuthoritative,
  statusForOutcomeKind,
  classifySendOutcome,
  invokeWhatsappSend,
  SEND_ERROR_MESSAGES,
} from '../lib/whatsappSend.js';
import {
  EMPTY_CONVERSATION_FILTERS,
  buildLeadsById,
  filterConversations,
} from '../lib/whatsappConversationFilters.js';

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

  // Fase 3.5.2.4 — Interface de envio. `pendingSends` guarda mensagens
  // otimistas locais (uma por intenção de envio, nunca persistida —
  // ver whatsappSend.js) até a linha autoritativa correspondente
  // chegar via Realtime (reconciliada por clientToken, nunca por id:
  // o id real só é conhecido depois da resposta da Edge Function).
  const [pendingSends, setPendingSends] = useState([]);
  const [composerSending, setComposerSending] = useState(false);
  const [composerNotice, setComposerNotice] = useState(null);

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

  // Fase 3.6.0 — busca/filtros da lista de conversas. Opera
  // exclusivamente sobre `conversations` (já carregado, já ordenado
  // por recência) e `leads` (já em memória) — nunca dispara uma nova
  // consulta ao Supabase, nunca abrange conversas ainda não trazidas
  // pela paginação (`hasMoreConversationHistory`). Nunca usa
  // read_at/delivered_at/sent_at (status de entrega da Meta) como
  // critério — só nome, etapa e tags do LEAD.
  const [conversationFilters, setConversationFilters] = useState(EMPTY_CONVERSATION_FILTERS);

  const leadsById = useMemo(() => buildLeadsById(leads), [leads]);

  const filteredConversations = useMemo(
    () => filterConversations(conversations, leadsById, conversationFilters),
    [conversations, leadsById, conversationFilters],
  );

  const clearConversationFilters = useCallback(() => {
    setConversationFilters(EMPTY_CONVERSATION_FILTERS);
  }, []);

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

  // Fase 3.6.2 — estado OPERACIONAL de atendimento (nunca confundido
  // com status de entrega da Meta, ver conversationOperationalState.js).
  // Carregado/atualizado só para a conversa SELECIONADA — nunca para
  // toda a lista (evita N consultas/subscrições simultâneas). `null`
  // é um valor legítimo (conversa ainda sem nenhum evento automático
  // registrado — tratado pela UI como "pendente_resposta" implícito
  // via conversationOperationalStateLabel).
  const [conversationState, setConversationState] = useState(null);

  useEffect(() => {
    if (!selectedLeadId) {
      setConversationState(null);
      return undefined;
    }
    let cancelled = false;
    conversationStateApi.fetchForLead(selectedLeadId)
      .then((state) => { if (!cancelled) setConversationState(state); })
      .catch(() => { if (!cancelled) setConversationState(null); });
    return () => { cancelled = true; };
  }, [selectedLeadId]);

  // Realtime escopado só à conversa aberta (filtro server-side por
  // lead_id) — canal PRÓPRIO e isolado do canal principal de
  // whatsapp_messages/leads (nunca reaproveita/alarga aquele, que já
  // está aprovado e testado para seu próprio escopo). Refeito a cada
  // troca de conversa.
  useEffect(() => {
    if (!selectedLeadId) return undefined;
    const channel = supabase
      .channel(`crm-piccinini-conversation-state-${selectedLeadId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'whatsapp_conversation_state', filter: `lead_id=eq.${selectedLeadId}`,
      }, (payload) => {
        setConversationState(conversationStateApi.fromRow(payload.new || null));
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [selectedLeadId]);

  // Alteração manual (requisito explícito da Fase 3.6.2) — UPDATE/
  // upsert direto via RLS (dono do lead), nunca uma RPC: as transições
  // AUTOMÁTICAS (inbound_received/outbound_sent) são exclusivas das
  // Edge Functions (service_role) — este caminho nunca as reexecuta
  // nem as substitui, só sobrescreve o status atual por decisão
  // explícita do usuário.
  const setConversationStatus = useCallback(async (status) => {
    if (!selectedLeadId) return;
    const updated = await conversationStateApi.setStatus(selectedLeadId, status);
    setConversationState(updated);
  }, [selectedLeadId]);

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

  // Fase 3.5.2.4 — limpa o aviso do composer (ex. "janela de 24h
  // encerrada" de uma conversa anterior) ao trocar de conversa — nunca
  // deixa um erro de uma intenção de envio de OUTRO lead vazar para a
  // conversa recém-aberta. `pendingSends` nunca é limpo aqui de
  // propósito: cada item já carrega seu próprio leadId e só é
  // exibido na thread correspondente (ver threadMessagesWithPending
  // abaixo) — trocar de conversa e voltar preserva o status de um
  // envio ainda em andamento.
  useEffect(() => {
    setComposerNotice(null);
  }, [selectedLeadId]);

  // Fase 3.5.2.4 — remove do overlay otimista local qualquer intenção
  // cuja linha autoritativa já tenha chegado (recentMessages é
  // atualizado via Realtime para TODAS as conversas, nunca só a
  // selecionada — ver assinatura mais abaixo). mergeOptimisticWithAuthoritative
  // já evita a duplicação visual mesmo antes desta limpeza; isto só
  // libera memória, nunca a correção em si.
  useEffect(() => {
    setPendingSends((prev) => {
      if (prev.length === 0) return prev;
      const knownTokens = new Set(recentMessages.map((m) => m.clientToken).filter((t) => t != null));
      const next = prev.filter((p) => !knownTokens.has(p.clientToken));
      return next.length === prev.length ? prev : next;
    });
  }, [recentMessages]);

  // Mensagens exibidas na thread aberta: autoritativas (banco/Realtime)
  // + pendentes otimistas desta MESMA conversa ainda não reconciliadas.
  // Nunca duplica (mergeOptimisticWithAuthoritative dedup por
  // clientToken) e nunca mistura pendentes de outra conversa.
  const threadMessagesWithPending = useMemo(() => {
    const pendingForThisLead = pendingSends.filter((p) => p.leadId === selectedLeadId);
    return sortMessagesChronologically(mergeOptimisticWithAuthoritative(threadMessages, pendingForThisLead));
  }, [threadMessages, pendingSends, selectedLeadId]);

  // Fase 3.5.2.4 — heurística client-side (nunca a autoridade real,
  // ver computeSendGateStatus) usada só para desabilitar o composer
  // antecipadamente e mostrar o aviso certo, evitando uma chamada HTTP
  // claramente fadada ao WINDOW_CLOSED/NO_INBOUND_CONVERSATION.
  const sendGate = useMemo(
    () => computeSendGateStatus(threadMessages, new Date()),
    [threadMessages],
  );

  // Fase 3.5.2.4 — envia uma mensagem para a conversa SELECIONADA.
  // Regras de segurança (nunca relaxadas aqui): só chama
  // invokeWhatsappSend com {leadId, content, clientToken} — nunca
  // telefone/conta/userId no payload (a Edge Function resolve tudo a
  // partir do JWT da sessão); um clientToken NOVO é gerado só nesta
  // função, uma vez por clique explícito — nunca regenerado
  // silenciosamente para repetir uma tentativa anterior. `composerSending`
  // bloqueia qualquer nova chamada enquanto uma está em voo (prevenção
  // de duplo clique, requisito 8) — nunca duas chamadas concorrentes
  // para a mesma conversa.
  const sendMessage = useCallback(async (content) => {
    if (!selectedLeadId || !userId) return;
    if (composerSending) return;
    const trimmed = typeof content === 'string' ? content.trim() : '';
    if (trimmed.length === 0) return;

    const gate = computeSendGateStatus(threadMessages, new Date());
    if (!gate.canSend) {
      setComposerNotice({ kind: gate.reason, windowExpiresAt: gate.windowExpiresAt });
      return;
    }

    const leadId = selectedLeadId;
    const clientToken = generateClientToken();
    const optimistic = buildOptimisticMessage({ leadId, userId, content: trimmed, clientToken });

    setComposerNotice(null);
    setComposerSending(true);
    setPendingSends((prev) => [...prev, optimistic]);

    try {
      const result = await invokeWhatsappSend(supabase, { leadId, content: trimmed, clientToken });
      const classified = classifySendOutcome(result);
      const bubbleStatus = statusForOutcomeKind(classified.kind);

      if (bubbleStatus) {
        // Uma linha real existe no banco (messageId presente) — nunca
        // removida aqui; a troca pela linha autoritativa acontece
        // sozinha quando o Realtime a entregar (ver efeito acima).
        // NUNCA marcado como 'delivered'/'read' aqui — só a confirmação
        // de aceite da Meta ('sent') ou estados de incerteza/falha.
        setPendingSends((prev) => prev.map((p) => (
          p.clientToken === clientToken
            ? { ...p, status: bubbleStatus, errorCode: classified.errorCode ?? null }
            : p
        )));
      } else {
        // Nenhuma linha foi criada — nunca deixa uma bolha "fantasma"
        // para uma intenção que não chegou a existir no banco.
        setPendingSends((prev) => prev.filter((p) => p.clientToken !== clientToken));
      }
      if (classified.kind !== 'accepted') {
        setComposerNotice({ kind: classified.kind, windowExpiresAt: classified.windowExpiresAt ?? null });
      }
    } finally {
      setComposerSending(false);
    }
  }, [selectedLeadId, userId, composerSending, threadMessages]);

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
    conversations: filteredConversations,
    conversationsLoading,
    conversationsError,
    refetchConversations,
    hasMoreConversationHistory,
    loadMoreConversationHistory,

    // Fase 3.6.0 — busca/filtros (ver bloco acima).
    conversationFilters,
    setConversationFilters,
    clearConversationFilters,
    totalConversationsCount: conversations.length,

    selectedLeadId,
    selectedLead,
    selectConversation,

    // Fase 3.6.2 — estado operacional (ver bloco acima).
    conversationState,
    setConversationStatus,

    threadMessages: threadMessagesWithPending,
    threadLoading,
    threadError,
    retryThread,
    hasMoreOlderMessages,
    loadingOlderMessages,
    loadOlderMessages,

    // Fase 3.5.2.4 — Interface de envio.
    sendMessage,
    composerSending,
    composerNotice,
    sendGate,

    leads,
  };
}
