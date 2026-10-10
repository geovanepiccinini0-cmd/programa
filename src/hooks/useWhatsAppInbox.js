import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  buildUnreadCountsMap,
  applyIncomingMessageToUnreadCounts,
  clearUnreadCountForLead,
  isConversationActivelyOpen,
} from '../lib/whatsappUnreadTracking.js';
import {
  buildConversationOperationalStatesMap,
  applyConversationStateRealtimeEvent,
  shouldForceConversationStatesResync,
} from '../lib/conversationOperationalState.js';

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
  // Fase 3.6.3 — contadores de não lidas (leitura humana), ver
  // whatsappUnreadTracking.js. Mapa leadId -> unreadCount, sempre
  // recalculado do servidor no login/reload e ajustado localmente via
  // Realtime (nunca a fonte de verdade — ver comentário do módulo).
  const [unreadCounts, setUnreadCounts] = useState({});
  const [recentWindowSize, setRecentWindowSize] = useState(RECENT_WINDOW_SIZE);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsError, setConversationsError] = useState(null);
  const [conversationsRetryToken, setConversationsRetryToken] = useState(0);
  const [hasMoreConversationHistory, setHasMoreConversationHistory] = useState(false);

  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  // Fase 3.6.3 (correção pós-revisão do PR #70, achado CONFIRMED) —
  // espelho em ref de `threadLoading`, lido pelo handler Realtime
  // (onMessageChange) para decidir se a conversa está REALMENTE
  // visível antes de marcar uma mensagem como lida automaticamente.
  // Um ref (nunca o próprio `threadLoading` na dependência do efeito
  // de subscrição) evita recriar o canal Realtime a cada
  // carregamento/descarregamento de thread — só o VALOR mais recente
  // importa no momento em que uma mensagem chega, nunca a
  // re-subscrição em si.
  const threadLoadingRef = useRef(threadLoading);
  useEffect(() => { threadLoadingRef.current = threadLoading; }, [threadLoading]);
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

  // Fase 3.6.3 — contagem inicial de não lidas, uma única chamada
  // agregada (whatsapp_unread_counts()) por login/troca de usuário —
  // nunca N consultas por conversa. Recalculada do zero aqui a cada
  // montagem/reload, autocorrigindo qualquer ajuste local feito via
  // Realtime na sessão anterior.
  useEffect(() => {
    if (!userId) { setUnreadCounts({}); return undefined; }
    let cancelled = false;
    conversationStateApi.fetchUnreadCounts()
      .then((rows) => { if (!cancelled) setUnreadCounts(buildUnreadCountsMap(rows)); })
      .catch(() => { if (!cancelled) setUnreadCounts({}); });
    return () => { cancelled = true; };
  }, [userId, conversationsRetryToken]);

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

  // Fase 3.6.0 (busca/etapa/tags) + 3.6.4 (não lidas/estado
  // operacional/telefone) — busca/filtros da lista de conversas.
  // Opera exclusivamente sobre `conversations` (já carregado, já
  // ordenado por recência), `leads`, `unreadCounts` e
  // `conversationStatesByLead` (todos já em memória) — nunca dispara
  // uma nova consulta ao Supabase a partir do próprio filtro, nunca
  // abrange conversas ainda não trazidas pela paginação
  // (`hasMoreConversationHistory`). Nunca usa read_at/delivered_at/
  // sent_at (status de entrega da Meta) como critério.
  const [conversationFilters, setConversationFilters] = useState(EMPTY_CONVERSATION_FILTERS);

  const leadsById = useMemo(() => buildLeadsById(leads), [leads]);

  // Fase 3.6.4 — conjunto de leadIds efetivamente CARREGADOS na lista
  // (nunca toda a base) — é esse conjunto, e só ele, que é usado para
  // o fetch em lote de estados operacionais abaixo (requisito
  // explícito: "respeitando... o conjunto de conversas carregadas").
  // `Key` é uma assinatura estável (ids ordenados) usada só como
  // dependência de efeito — evita refetch quando o CONJUNTO de ids é
  // o mesmo mas a ordem mudou (ex. reordenação por nova mensagem).
  const conversationLeadIds = useMemo(() => conversations.map((c) => c.leadId), [conversations]);
  const conversationLeadIdsKey = useMemo(
    () => [...conversationLeadIds].sort().join(','),
    [conversationLeadIds],
  );

  // Fase 3.6.4 — estados operacionais de TODAS as conversas
  // carregadas (nunca só da selecionada, ao contrário do bloco já
  // existente da 3.6.2 mais abaixo, que continua INTOCADO — este é
  // um mapa ADICIONAL, só para filtro/priorização visual da lista).
  //
  // Requisito explícito (correção obrigatória do diagnóstico): uma
  // FALHA de carregamento NUNCA é tratada como "todos os estados
  // ausentes" — `conversationStatesError` é um estado SEPARADO de
  // `conversationStatesByLead`; em caso de erro, o último mapa bom
  // conhecido é PRESERVADO (nunca zerado), e a UI decide o que
  // mostrar com base no erro explícito, nunca inferindo ausência a
  // partir de um mapa vazio por falha.
  const [conversationStatesByLead, setConversationStatesByLead] = useState({});
  const [conversationStatesLoading, setConversationStatesLoading] = useState(false);
  const [conversationStatesError, setConversationStatesError] = useState(null);
  const [conversationStatesRetryToken, setConversationStatesRetryToken] = useState(0);

  useEffect(() => {
    if (!userId || conversationLeadIds.length === 0) {
      setConversationStatesByLead({});
      setConversationStatesError(null);
      setConversationStatesLoading(false);
      return undefined;
    }
    let cancelled = false;
    setConversationStatesLoading(true);
    conversationStateApi.fetchForLeads(conversationLeadIds)
      .then((states) => {
        if (cancelled) return;
        setConversationStatesByLead(buildConversationOperationalStatesMap(conversationLeadIds, states));
        setConversationStatesError(null);
        setConversationStatesLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Nunca substitui o mapa atual por {} — preserva o último
        // conhecido (pode estar desatualizado, mas nunca inventa
        // "todas ausentes" por causa de uma falha de rede/RLS).
        setConversationStatesError(e);
        setConversationStatesLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- conversationLeadIdsKey já representa conversationLeadIds de forma estável; incluir o array também causaria refetch por troca de referência sem troca de conteúdo.
  }, [userId, conversationLeadIdsKey, conversationStatesRetryToken]);

  const retryConversationStates = useCallback(() => {
    setConversationStatesRetryToken((n) => n + 1);
  }, []);

  // Fase 3.6.4 (correção pós-revisão do PR #71, achados CONFIRMED 2 e
  // 3) — Realtime NÃO filtrado para whatsapp_conversation_state
  // (canal próprio, nunca reaproveita o canal por-lead da 3.6.2 nem o
  // canal principal de mensagens/leads). Guard de posse por
  // `user_id` (mesmo princípio já usado para `leads` em
  // shouldApplyLeadRealtimeChange) é defesa em profundidade. Só
  // atualiza leadIds que já fazem parte do mapa carregado (nunca
  // expande o conjunto definido pelo fetch em lote) —
  // applyConversationStateRealtimeEvent (conversationOperationalState.js,
  // puro e testado) garante isso. Cobre diretamente o cenário
  // "alteração de estado em outra aba/dispositivo".
  //
  // DEPENDÊNCIA DE CONFIGURAÇÃO EM PRODUÇÃO (documentar, nunca
  // alterar sem autorização explícita): este canal só recebe eventos
  // se a tabela public.whatsapp_conversation_state estiver incluída
  // na publication `supabase_realtime` do Supabase. As migrations
  // 018 e 007 fazem isso explicitamente via
  // "alter publication supabase_realtime add table ...", mas NENHUMA
  // migration faz isso para whatsapp_conversation_state (024) nem
  // para leads — o canal principal de leads já em produção sugere
  // que essas tabelas foram habilitadas manualmente pelo painel do
  // Supabase em algum momento anterior a este código. Esta fase NÃO
  // executa nenhum ALTER PUBLICATION (proibido pelas restrições desta
  // fase).
  //
  // RECUPERAÇÃO SEM DEPENDER DE SELEÇÃO MANUAL DE CONVERSA (correção
  // do achado 2) — dois mecanismos independentes, cobrindo os dois
  // jeitos de "Realtime indisponível":
  // 1. `status` do próprio `subscribe()` — `CHANNEL_ERROR`/
  //    `TIMED_OUT`/`CLOSED` são falhas de CONEXÃO detectáveis; ao
  //    ocorrerem, força uma ressincronização IMEDIATA via fetch em
  //    lote (shouldForceConversationStatesResync, puro e testado) —
  //    nunca espera o atendente selecionar outra conversa.
  // 2. POLLING periódico (abaixo) — mitigação para o caso que o
  //    status NUNCA detecta: a tabela simplesmente não está na
  //    publication (o `subscribe()` reporta `SUBSCRIBED` normalmente,
  //    mas nenhum evento desta tabela jamais chega). Sem o polling,
  //    esse cenário deixaria os estados parados indefinidamente até
  //    uma ação manual (selecionar conversa, ou o botão "Tentar
  //    novamente" do aviso de erro) — o polling garante que os dados
  //    nunca ficam "presos", mesmo que o Realtime esteja
  //    completamente fora do ar para esta tabela em produção.
  useEffect(() => {
    if (!userId) return undefined;
    const channel = supabase
      .channel(`crm-piccinini-conversation-states-list-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversation_state' }, (payload) => {
        setConversationStatesByLead((prev) => applyConversationStateRealtimeEvent(prev, payload, userId));
      })
      .subscribe((status) => {
        if (shouldForceConversationStatesResync(status)) {
          setConversationStatesRetryToken((n) => n + 1);
        }
      });
    return () => supabase.removeChannel(channel);
  }, [userId]);

  // Fase 3.6.4 (correção pós-revisão do PR #71, achado CONFIRMED 2) —
  // polling de segurança: mitiga especificamente o cenário em que a
  // tabela não está na publication supabase_realtime (nenhum erro de
  // canal detectável, só silêncio permanente). Intervalo longo (60s,
  // nunca mais agressivo que isso — esta é uma rede de segurança,
  // não o caminho principal de atualização) e só dispara com a aba
  // em primeiro plano (mesmo princípio de isConversationActivelyOpen,
  // whatsappUnreadTracking.js — nunca gasta rede com o CRM em
  // segundo plano). Reaproveita o MESMO retry token do botão manual
  // "Tentar novamente" — nenhum caminho de dados novo, só mais uma
  // forma de disparar o fetch em lote já existente.
  useEffect(() => {
    if (!userId) return undefined;
    const intervalId = setInterval(() => {
      const documentVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
      if (documentVisible) setConversationStatesRetryToken((n) => n + 1);
    }, 60000);
    return () => clearInterval(intervalId);
  }, [userId]);

  const filteredConversations = useMemo(
    () => filterConversations(conversations, leadsById, conversationFilters, { unreadCounts, conversationStatesByLead }),
    [conversations, leadsById, conversationFilters, unreadCounts, conversationStatesByLead],
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

  // Fase 3.6.3 (correção pós-revisão do PR #70, achado CONFIRMED) —
  // feedback de sincronização de leitura: quando a persistência de
  // `markRead` falha depois do contador já ter sido zerado
  // OTIMISTICAMENTE, o badge local pode estar mentindo (mostrando
  // "lida" quando o servidor nunca recebeu isso). Nunca confiamos no
  // zerado local nesse caso — ressincronizamos a contagem real do
  // servidor (fonte de verdade, ver whatsapp_unread_counts()) e
  // expomos um aviso textual para a UI, limpo automaticamente quando
  // a ressincronização é bem-sucedida.
  const [unreadSyncNotice, setUnreadSyncNotice] = useState(null);

  const recoverUnreadCountsAfterFailure = useCallback(() => {
    setUnreadSyncNotice('Não foi possível confirmar a leitura desta conversa no servidor. Recarregando contadores...');
    conversationStateApi.fetchUnreadCounts()
      .then((rows) => {
        setUnreadCounts(buildUnreadCountsMap(rows));
        setUnreadSyncNotice(null);
      })
      .catch(() => {
        setUnreadSyncNotice('Não foi possível confirmar a leitura desta conversa. Os contadores podem estar desatualizados.');
      });
  }, []);

  // Abrir uma conversa é o momento em que o atendente a "lê": zera o
  // contador local OTIMISTICAMENTE (nunca deixa o badge antigo
  // visível até a resposta do servidor) e persiste via markRead
  // (RPC mark_whatsapp_conversation_read, migration 025 — nunca mais
  // um timestamp do navegador, nunca toca `status` operacional da
  // Fase 3.6.2). Se a persistência falhar, o zerado otimista pode
  // estar ERRADO (mensagem ainda não lida no servidor) — nunca
  // ignoramos esse erro: ressincronizamos a contagem real do
  // servidor em vez de confiar no estado local.
  const selectConversation = useCallback((leadId) => {
    setSelectedLeadId(leadId);
    if (!leadId) return;
    setUnreadCounts((prev) => clearUnreadCountForLead(prev, leadId));
    conversationStateApi.markRead(leadId).catch(() => {
      recoverUnreadCountsAfterFailure();
    });
  }, [recoverUnreadCountsAfterFailure]);

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
        // Fase 3.6.3 — só INSERT de mensagem INBOUND nova interessa
        // ao contador de não lidas (nunca UPDATE de status de
        // entrega da Meta, que também dispara este mesmo evento).
        if (payload.eventType === 'INSERT' && payload.new && payload.new.direction === 'inbound') {
          const incoming = { leadId: payload.new.lead_id, direction: payload.new.direction };
          // Correção pós-revisão do PR #70 (achado CONFIRMED): nunca
          // basta `incoming.leadId === selectedLeadId` — isso só diz
          // que o lead está selecionado EM MEMÓRIA, não que o
          // atendente está de fato vendo a conversa agora (aba em
          // segundo plano, troca de conversa com a thread ainda
          // carregando). isConversationActivelyOpen checa as três
          // condições reais antes de considerar a mensagem "lida ao
          // vivo" (ver whatsappUnreadTracking.js).
          const documentVisible = typeof document === 'undefined' ? true : document.visibilityState === 'visible';
          const activelyOpen = isConversationActivelyOpen(selectedLeadId, incoming.leadId, {
            threadLoading: threadLoadingRef.current,
            documentVisible,
          });
          if (activelyOpen) {
            // Conversa REALMENTE visível agora: a mensagem chega e é
            // "lida ao vivo" pelo atendente — nunca incrementa, e
            // avança last_read_at no servidor (now() do SERVIDOR via
            // RPC, nunca o relógio do navegador) para que ela não
            // reapareça como não lida num reload imediatamente após.
            // Falha de persistência aqui NUNCA é ignorada: como esta
            // mensagem nunca foi contada localmente (nem incrementada
            // nem exibida como não lida), uma falha silenciosa
            // deixaria o servidor com um estado "não lido" que o
            // cliente nunca mostra — ressincronizamos para garantir
            // que o contador real volte a aparecer se a escrita
            // falhou.
            conversationStateApi.markRead(incoming.leadId).catch(() => {
              recoverUnreadCountsAfterFailure();
            });
          } else {
            // Não está realmente visível (outra conversa, aba em
            // segundo plano, ou thread ainda carregando) — sempre
            // incrementa, mesmo que o lead esteja selecionado em
            // memória.
            setUnreadCounts((prev) => applyIncomingMessageToUnreadCounts(prev, incoming, null));
          }
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
  }, [userId, selectedLeadId, recoverUnreadCountsAfterFailure]);

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

    // Fase 3.6.3 — contadores de não lidas (ver bloco acima).
    unreadCounts,
    unreadSyncNotice,

    // Fase 3.6.2 — estado operacional (ver bloco acima).
    conversationState,
    setConversationStatus,

    // Fase 3.6.4 — estados operacionais EM LOTE (filtro/priorização
    // visual da lista) + diagnóstico de falha separado de ausência.
    conversationStatesByLead,
    conversationStatesLoading,
    conversationStatesError,
    retryConversationStates,

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
