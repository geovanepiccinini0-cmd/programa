import { useCallback, useEffect, useRef, useState } from 'react';
import { DIAS_SEMANA, CONTACT_ATTEMPT_TYPES } from '../constants.js';
import { todayStr, normalizeBackup } from '../utils.js';
import { leadsApi, tasksApi, templatesApi, interactionsApi, auditLogApi } from '../lib/db.js';
import { supabase } from '../lib/supabaseClient.js';

// Infraestrutura RESERVADA para um futuro motor de automações comerciais
// (lead sem resposta, pós-proposta, reativação etc.) — ver decisão em
// docs/CRM_V2_PHASE_01_REPORT.md / discussão da correção de duplicidade
// Follow-up x Contato. NÃO é mais chamada automaticamente pelo simples
// preenchimento de proximoContato no salvamento/carregamento do lead:
// isso passou a gerar/reconciliar só a tarefa "Contato" (origem
// 'lead-agenda', via computeLeadAgendaTaskData/reconcileLeadAgendaActions).
// Mantida para uso futuro por uma automação com condição própria
// explícita (não "proximoContato preenchido").
export function pendingAutoTasksForLeads(leads, tasks) {
  const today = todayStr();
  const pending = [];
  leads.forEach((l) => {
    if (l.etapa === 'Ganho' || l.etapa === 'Perdido') return;
    if (!l.proximoContato) return;
    if (l.proximoContato > today) return;
    const jaTem = tasks.some((t) => t.leadId === l.id && t.origem === 'auto' && t.data === l.proximoContato)
      || pending.some((t) => t.leadId === l.id);
    if (!jaTem) {
      pending.push({ titulo: 'Follow-up: ' + l.nome, categoria: 'Follow-up', data: l.proximoContato, horario: l.proximoContatoHorario || '', concluida: false, leadId: l.id, origem: 'auto' });
    }
  });
  return pending;
}

// Infraestrutura RESERVADA, assim como pendingAutoTasksForLeads acima:
// só sincroniza horário de tarefas origem='auto' (geradas por
// pendingAutoTasksForLeads). Sem chamada automática nesta fase.
export function autoTaskHorarioUpdates(leads, tasks) {
  const updates = [];
  leads.forEach((l) => {
    if (!l.proximoContato) return;
    const existing = tasks.find((t) => t.leadId === l.id && t.origem === 'auto' && t.data === l.proximoContato);
    if (existing && (existing.horario || '') !== (l.proximoContatoHorario || '')) {
      updates.push({ ...existing, horario: l.proximoContatoHorario || '' });
    }
  });
  return updates;
}

export function pendingRotinaTasks(templates, tasks) {
  const todayAbrev = DIAS_SEMANA[new Date().getDay()];
  const today = todayStr();
  const pending = [];
  templates.forEach((tpl) => {
    if (!tpl.ativo) return;
    if (!tpl.dias.includes(todayAbrev)) return;
    const jaTem = tasks.some((t) => t.templateId === tpl.id && t.data === today)
      || pending.some((t) => t.templateId === tpl.id);
    if (!jaTem) {
      pending.push({ titulo: tpl.titulo, categoria: tpl.categoria, data: today, horario: tpl.horario || '', concluida: false, leadId: null, origem: 'rotina', templateId: tpl.id });
    }
  });
  return pending;
}

export function computeLeadAgendaTaskData(lead) {
  const ativo = lead.etapa !== 'Ganho' && lead.etapa !== 'Perdido';
  if (!ativo || !lead.proximoContato) return null;
  return {
    titulo: 'Contato: ' + lead.nome,
    categoria: 'Agenda/Ligação',
    data: lead.proximoContato,
    horario: lead.proximoContatoHorario || '',
    concluida: false,
    leadId: lead.id,
    origem: 'lead-agenda',
  };
}

export function reconcileLeadAgendaActions(affectedLeads, tasks) {
  const actions = [];
  affectedLeads.forEach((lead) => {
    const desired = computeLeadAgendaTaskData(lead);
    const existing = tasks.find((t) => t.origem === 'lead-agenda' && t.leadId === lead.id);
    if (!desired) {
      if (existing) actions.push({ type: 'delete', id: existing.id });
      return;
    }
    if (existing) {
      const changed = existing.titulo !== desired.titulo || existing.data !== desired.data || existing.horario !== desired.horario;
      if (changed) actions.push({ type: 'update', id: existing.id, data: desired });
    } else {
      actions.push({ type: 'insert', data: desired });
    }
  });
  return actions;
}

async function applyLeadAgendaActions(actions, setTasks) {
  for (const action of actions) {
    if (action.type === 'delete') {
      await tasksApi.remove(action.id);
      setTasks((prev) => prev.filter((t) => t.id !== action.id));
    } else if (action.type === 'update') {
      const updated = await tasksApi.update(action.id, action.data);
      setTasks((prev) => prev.map((t) => (t.id === action.id ? updated : t)));
    } else if (action.type === 'insert') {
      const inserted = await tasksApi.insert(action.data);
      setTasks((prev) => [...prev, inserted]);
    }
  }
}

// --- V2 (Fase 1) — registro de mudança de etapa em lead_interactions + audit_log ---

export function computeStageTimestamps(etapa) {
  const now = new Date().toISOString();
  if (etapa === 'Ganho') return { wonAt: now, lostAt: null };
  if (etapa === 'Perdido') return { wonAt: null, lostAt: now };
  return { wonAt: null, lostAt: null };
}

export function computeStageChangeInteraction(prevLead, newEtapa, userId) {
  if (!prevLead || prevLead.etapa === newEtapa) return null;
  return {
    leadId: prevLead.id,
    type: 'stage_change',
    channel: 'crm',
    direction: 'internal',
    content: `Etapa alterada de "${prevLead.etapa}" para "${newEtapa}"`,
    // from_stage/to_stage são o conteúdo original (Fase 1 V2); activity_class/
    // source são o contrato de metadata da Fase 2A (Activity/Interaction
    // Engine) — stage_change é sempre atividade interna, nunca contato com
    // o cliente, mesmo sendo uma ação de um usuário autenticado.
    metadata: { from_stage: prevLead.etapa, to_stage: newEtapa, activity_class: 'internal', source: 'user' },
    createdBy: userId || null,
  };
}

// Nota manual (Fase 2A — Activity/Interaction Engine): também é atividade
// interna por definição, nunca contato com o cliente.
export function computeNoteInteractionData(leadId, content, userId) {
  return {
    leadId,
    type: 'note',
    channel: 'manual',
    direction: 'internal',
    content,
    metadata: { activity_class: 'internal', source: 'user' },
    createdBy: userId || null,
  };
}

// --- Fase 2A.2 — registro rápido de interações comerciais estruturadas ---
//
// Fonte única de verdade para a classificação (type/direction/channel/
// activity_class/outcome). A UI só informa qual ação ocorreu (a chave);
// nunca monta o objeto de interação diretamente. "Proposta enviada" é
// 'attempt', não 'engagement': é uma ação do vendedor, não uma resposta
// confirmada do cliente (ver decisão da Fase 2A.2).
const COMMERCIAL_INTERACTION_ACTIONS = {
  call_connected: {
    type: 'call', direction: 'outbound', channel: 'phone',
    metadata: { activity_class: 'engagement', outcome: 'connected' },
  },
  call_no_answer: {
    type: 'call', direction: 'outbound', channel: 'phone',
    metadata: { activity_class: 'attempt', outcome: 'no_answer' },
  },
  whatsapp_sent: {
    type: 'whatsapp', direction: 'outbound', channel: 'whatsapp',
    metadata: { activity_class: 'attempt' },
  },
  whatsapp_received: {
    type: 'whatsapp', direction: 'inbound', channel: 'whatsapp',
    metadata: { activity_class: 'engagement' },
  },
  meeting_held: {
    type: 'meeting', direction: 'outbound', channel: 'in_person',
    metadata: { activity_class: 'engagement', outcome: 'held' },
  },
  proposal_sent: {
    type: 'proposal', direction: 'outbound', channel: 'manual',
    metadata: { activity_class: 'attempt', outcome: 'sent' },
  },
};

export function computeCommercialInteractionData(leadId, action, userId) {
  const config = COMMERCIAL_INTERACTION_ACTIONS[action];
  if (!config) {
    throw new Error(`Ação de interação comercial desconhecida: "${action}"`);
  }
  return {
    leadId,
    type: config.type,
    direction: config.direction,
    channel: config.channel,
    content: '',
    metadata: { ...config.metadata, source: 'user' },
    createdBy: userId || null,
  };
}

// --- Fase 2A.1 — três relógios de atividade/contato, a partir de uma
// coleção de lead_interactions. Usam occurred_at (não a ordem do array
// nem created_at). Coleção vazia, ou nenhuma interação da classe
// buscada, retornam null (documentado: "sem dado" != "contato há muito
// tempo" — quem consumir isso não deve tratar null como data remota).

function maxOccurredAt(interactions, predicate) {
  let maxTime = -Infinity;
  let max = null;
  interactions.forEach((it) => {
    if (predicate && !predicate(it)) return;
    if (!it.occurredAt) return;
    const t = new Date(it.occurredAt).getTime();
    if (Number.isNaN(t) || t <= maxTime) return;
    maxTime = t;
    max = it.occurredAt;
  });
  return max;
}

// last_activity_at: qualquer interação, qualquer activity_class.
export function computeLastActivityAt(interactions) {
  return maxOccurredAt(interactions);
}

// last_contact_attempt_at: só tipos de contato (CONTACT_ATTEMPT_TYPES,
// agora em constants.js — reaproveitado também pelo Follow-up
// Eligibility Engine em followUpEngine.js, sem que nenhum dos dois
// módulos dependa do outro), só
// direction='outbound' (fomos nós que agimos — uma resposta do cliente,
// ex. whatsapp inbound, é engajamento dele, não "nossa tentativa"), e só
// activity_class 'attempt' ou 'engagement' (ignora 'internal').
export function computeLastContactAttemptAt(interactions) {
  return maxOccurredAt(interactions, (it) => {
    if (!CONTACT_ATTEMPT_TYPES.includes(it.type)) return false;
    if (it.direction !== 'outbound') return false;
    const cls = it.metadata && it.metadata.activity_class;
    return cls === 'attempt' || cls === 'engagement';
  });
}

// last_customer_engagement_at: só 'engagement' (interação efetiva).
export function computeLastCustomerEngagementAt(interactions) {
  return maxOccurredAt(interactions, (it) => it.metadata && it.metadata.activity_class === 'engagement');
}

// Fase 2C.2A.1 — helper neutro para o único padrão repetido em todos os
// pontos de escrita de interactions (logStageChange, addInteractionNote,
// registerCommercialInteraction, completeTaskWithResult): insere e aplica
// a LINHA DEVOLVIDA PELO SERVIDOR ao estado central, nunca um objeto
// local reconstruído. Extraído só para poder testar essa ligação direto
// (mockando interactionsApi.insert), sem precisar renderizar o hook —
// não reimplementa nem decide nada que já não estivesse em cada chamador.
export async function insertInteractionAndTrack(data, setInteractions) {
  const inserted = await interactionsApi.insert(data);
  setInteractions((prev) => [...prev, inserted]);
  return inserted;
}

// Fase 2C.2B — extraída do efeito de bootstrap/retry de interactions só
// para poder testar, sem renderizar o hook, a única decisão real que o
// efeito toma antes de disparar a query: sem userId, nem chama
// fetchAllForUser (zero query). Com userId, delega 100% à API já
// existente — nenhuma lógica nova de leitura.
export function fetchInteractionsForUser(userId) {
  return userId ? interactionsApi.fetchAllForUser(userId) : Promise.resolve([]);
}

// As tabelas lead_interactions/audit_log são novas (Fase 1 V2): se a
// migration ainda não foi rodada no Supabase, o insert falha — isso não
// pode derrubar a troca de etapa em si (já persistida em leads), então
// o erro é só avisado no console.
export async function logStageChange(prevLead, updatedLead, userId, setInteractions) {
  const interaction = computeStageChangeInteraction(prevLead, updatedLead.etapa, userId);
  if (!interaction) return;
  try {
    await insertInteractionAndTrack(interaction, setInteractions);
    await auditLogApi.insert({
      entityType: 'lead',
      entityId: updatedLead.id,
      action: 'stage_change',
      oldData: { etapa: prevLead.etapa },
      newData: { etapa: updatedLead.etapa },
    });
  } catch (e) {
    console.warn('Não foi possível registrar o histórico de mudança de etapa (migrations 007/011 já foram rodadas no Supabase?):', e);
  }
}

// Concluir uma tarefa vinculada a um lead (Contato/lead-agenda ou, se
// existir, Follow-up/auto) zera o próximo contato do lead — regra
// preservada da versão anterior, agora isolada para ser testável.
export function shouldClearNextContato(task, concluindo) {
  return Boolean(concluindo && task.leadId && (task.origem === 'auto' || task.origem === 'lead-agenda'));
}

// Fase 2A.3 — só tarefas lead-agenda (a Contato: {nome} gerada a partir de
// proximoContato) oferecem captura de resultado comercial ao concluir.
// Deliberadamente NÃO inclui 'auto': é infraestrutura reservada e não deve
// voltar a participar de nenhum fluxo novo.
export function shouldOfferResultCapture(task) {
  return Boolean(task.leadId) && task.origem === 'lead-agenda';
}

// Fase 2A.3 — orquestração pura (efeitos colaterais injetados em `deps`,
// testável sem Supabase/React): registra a interação comercial PRIMEIRO
// via computeCommercialInteractionData (classificação nunca duplicada
// aqui, só acrescenta metadata.task_id como contexto) e só conclui a
// tarefa se o insert tiver sucesso. Se insertInteraction falhar, deps.
// toggleTask nunca é chamado. Se deps.toggleTask falhar depois, o erro
// propaga e a interação já gravada não é desfeita (sem rollback
// automático, decisão explícita desta fase). "Só concluir" não passa
// por aqui — é só o toggleTask de sempre, chamado direto pela UI.
export async function runCompleteTaskWithResult(task, actionKey, userId, deps) {
  if (!task || !shouldOfferResultCapture(task)) return;
  const data = computeCommercialInteractionData(task.leadId, actionKey, userId);
  await deps.insertInteraction({ ...data, metadata: { ...data.metadata, task_id: task.id } });
  await deps.toggleTask(task.id);
}

// Fase 3.5.1 — exportada (sem nenhuma alteração de comportamento) para
// ser reaproveitada por useWhatsAppInbox.js (mecanismo de merge de
// Realtime já existente/aprovado, nunca duplicado/reimplementado).
export function applyRealtimeChange(setState, fromRow, payload) {
  if (payload.eventType === 'DELETE') {
    setState((prev) => prev.filter((item) => item.id !== payload.old.id));
    return;
  }
  const row = fromRow(payload.new);
  setState((prev) => {
    const idx = prev.findIndex((item) => item.id === row.id);
    if (idx === -1) return [...prev, row];
    const next = prev.slice();
    next[idx] = row;
    return next;
  });
}

export function useAppState(userId) {
  const [leads, setLeads] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Fase 2C.2A — estado central de interactions, para a futura fila de
  // follow-up (Shadow Mode) avaliar todos os leads sem N+1 fetch. Busca
  // deliberadamente INDEPENDENTE do efeito de leads/tasks/templates
  // abaixo: se falhar, o CRM continua abrindo normalmente (leads/tasks
  // são mais importantes que Shadow Mode) — só a fila futura veria
  // interactionsError. interactionsApi.fetchAllForUser faz uma única
  // query (sem N+1), mas SEM paginação explícita — o PostgREST/Supabase
  // tem um limite padrão de 1000 linhas por request; em bases muito
  // grandes (milhares de interactions) isso poderia truncar
  // silenciosamente. Limitação arquitetural conhecida, não resolvida
  // nesta fase (não implementar paginação agora; não inferir
  // truncamento só por "vieram exatamente 1000 registros" — isso não
  // prova nada, geraria falso positivo).
  const [interactions, setInteractions] = useState([]);
  const [interactionsLoading, setInteractionsLoading] = useState(true);
  const [interactionsError, setInteractionsError] = useState(null);
  // Fase 2C.2B — bump para refazer o fetch (botão "Tentar novamente" do
  // Shadow Mode); ver efeito abaixo e refetchInteractions.
  const [interactionsRetryToken, setInteractionsRetryToken] = useState(0);
  const autoTasksChecked = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [leadsData, tasksData, templatesData] = await Promise.all([
          leadsApi.fetchAll(userId), tasksApi.fetchAll(userId), templatesApi.fetchAll(userId),
        ]);
        if (cancelled) return;
        setLeads(leadsData);
        setTasks(tasksData);
        setTemplates(templatesData);
        setLoading(false);

        if (!autoTasksChecked.current) {
          autoTasksChecked.current = true;
          // pendingAutoTasksForLeads/autoTaskHorarioUpdates (origem 'auto')
          // NÃO são chamadas aqui de propósito: um reload da aplicação não
          // deve recriar tarefas Follow-up só porque o lead tem
          // proximoContato preenchido. Isso é infraestrutura reservada
          // para um futuro motor de automações — ver comentário acima das
          // funções. proximoContato é reconciliado só para a tarefa
          // "Contato" (lead-agenda) logo abaixo.
          const pending = pendingRotinaTasks(templatesData, tasksData);
          for (const p of pending) {
            const inserted = await tasksApi.insert(p);
            if (cancelled) return;
            setTasks((prev) => [...prev, inserted]);
          }

          const leadAgendaActions = reconcileLeadAgendaActions(leadsData, tasksData);
          await applyLeadAgendaActions(leadAgendaActions, setTasks);
        }
      } catch (e) {
        if (!cancelled) { setError(e); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  // Fase 2C.2A — fetch independente, nunca mistura com o loading/error
  // principal (leads/tasks/templates) acima.
  //
  // Fase 2C.2A.1 — hardening: `interactions` é invalidado (volta a [])
  // IMEDIATAMENTE a cada execução deste efeito, antes de buscar os dados
  // do `userId` atual. Isso garante que, ao trocar de usuário, dados da
  // sessão anterior nunca fiquem visíveis — nem durante o fetch nem se
  // ele falhar (sem isso, uma falha no fetch do novo usuário deixaria os
  // dados do usuário anterior parados no state). Essa mesma invalidação
  // NÃO foi aplicada ao bootstrap legado de leads/tasks/templates acima
  // (mesma assimetria pré-existente identificada na revisão da Fase
  // 2C.2A — fora do escopo desta sub-fase, que trata só de interactions).
  //
  // Fase 2C.2B — `interactionsRetryToken` é o único motivo além de
  // `userId` para este efeito rodar de novo: "Tentar novamente" (retry)
  // só incrementa esse contador (refetchInteractions abaixo), reaproveitando
  // o MESMO efeito/mesma proteção contra race — nunca uma lógica de fetch
  // separada. Isso garante de graça que um retry antigo nunca sobrescreve
  // o state de um usuário novo: se `userId` mudar enquanto um retry está
  // em voo, o cleanup desta mesma execução já marca `cancelled=true` antes
  // da próxima rodar, exatamente como já acontecia para a troca de userId.
  useEffect(() => {
    let cancelled = false;
    setInteractions([]);
    setInteractionsError(null);
    setInteractionsLoading(Boolean(userId));
    fetchInteractionsForUser(userId)
      .then((data) => { if (!cancelled) { setInteractions(data); setInteractionsLoading(false); } })
      .catch((e) => { if (!cancelled) { setInteractionsError(e); setInteractionsLoading(false); } });
    return () => { cancelled = true; };
  }, [userId, interactionsRetryToken]);

  // Fase 2C.2B — só dispara o efeito acima de novo (via o token), nunca
  // duplica a lógica de fetch/loading/error que já vive ali.
  const refetchInteractions = useCallback(() => {
    setInteractionsRetryToken((n) => n + 1);
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel('crm-piccinini-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (payload) => {
        const row = payload.new || payload.old;
        if (row.user_id !== userId) return; // ignora leads de outros usuários na visão pessoal
        applyRealtimeChange(setLeads, leadsApi.fromRow, payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => applyRealtimeChange(setTasks, tasksApi.fromRow, payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'templates' }, (payload) => applyRealtimeChange(setTemplates, templatesApi.fromRow, payload))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId]);

  const saveLead = useCallback(async (id, data) => {
    const prevLead = id ? leads.find((l) => l.id === id) : null;
    const etapaChanged = Boolean(prevLead) && prevLead.etapa !== data.etapa;
    const stageFields = etapaChanged ? computeStageTimestamps(data.etapa) : {};
    const saved = id
      ? await leadsApi.update(id, { ...data, ...stageFields, ultimaAtualizacao: todayStr() })
      : await leadsApi.insert({ ...data, criadoEm: todayStr(), ultimaAtualizacao: todayStr() });
    setLeads((prev) => (id ? prev.map((l) => (l.id === id ? saved : l)) : [...prev, saved]));
    if (etapaChanged) await logStageChange(prevLead, saved, userId, setInteractions);
    // proximoContato é um AGENDAMENTO: gera/reconcilia só a tarefa
    // "Contato" (lead-agenda). NÃO dispara pendingAutoTasksForLeads
    // (Follow-up/origem 'auto') — isso ficou reservado para uma automação
    // futura com condição própria, não para o simples preenchimento de
    // próximo contato. Ver comentário nas duas funções acima.
    await applyLeadAgendaActions(reconcileLeadAgendaActions([saved], tasks), setTasks);
  }, [tasks, leads, userId]);

  const deleteLead = useCallback(async (id) => {
    const relatedTasks = tasks.filter((t) => t.leadId === id);
    await Promise.all(relatedTasks.map((t) => tasksApi.remove(t.id)));
    await leadsApi.remove(id);
    setLeads((prev) => prev.filter((l) => l.id !== id));
    setTasks((prev) => prev.filter((t) => t.leadId !== id));
    // lead_interactions tem on delete cascade no banco; aqui só mantemos o
    // state central (Fase 2C.2A) consistente com isso, mesmo padrão já
    // aplicado a tasks acima.
    setInteractions((prev) => prev.filter((i) => i.leadId !== id));
  }, [tasks]);

  const moveStage = useCallback(async (id, dir, STAGES) => {
    const lead = leads.find((l) => l.id === id);
    if (!lead) return;
    const idx = STAGES.indexOf(lead.etapa);
    const next = idx + dir;
    if (next < 0 || next >= STAGES.length) return;
    const novaEtapa = STAGES[next];
    const stageFields = computeStageTimestamps(novaEtapa);
    const updated = await leadsApi.update(id, { ...lead, etapa: novaEtapa, ...stageFields, ultimaAtualizacao: todayStr() });
    setLeads((prev) => prev.map((l) => (l.id === id ? updated : l)));
    await applyLeadAgendaActions(reconcileLeadAgendaActions([updated], tasks), setTasks);
    await logStageChange(lead, updated, userId, setInteractions);
  }, [leads, tasks, userId]);

  const setLeadStage = useCallback(async (id, etapa) => {
    const lead = leads.find((l) => l.id === id);
    if (!lead || lead.etapa === etapa) return;
    const stageFields = computeStageTimestamps(etapa);
    const updated = await leadsApi.update(id, { ...lead, etapa, ...stageFields, ultimaAtualizacao: todayStr() });
    setLeads((prev) => prev.map((l) => (l.id === id ? updated : l)));
    await applyLeadAgendaActions(reconcileLeadAgendaActions([updated], tasks), setTasks);
    await logStageChange(lead, updated, userId, setInteractions);
  }, [leads, tasks, userId]);

  const addInteractionNote = useCallback((leadId, content) => (
    insertInteractionAndTrack(computeNoteInteractionData(leadId, content, userId), setInteractions)
  ), [userId]);

  const registerCommercialInteraction = useCallback((leadId, action) => (
    insertInteractionAndTrack(computeCommercialInteractionData(leadId, action, userId), setInteractions)
  ), [userId]);

  const addTask = useCallback(async (titulo, categoria, data, horario) => {
    const inserted = await tasksApi.insert({ titulo, categoria, data, horario, concluida: false, leadId: null, origem: 'manual' });
    setTasks((prev) => [...prev, inserted]);
  }, []);

  const toggleTask = useCallback(async (id) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const concluindo = !t.concluida;
    const updated = await tasksApi.update(id, { ...t, concluida: concluindo });
    setTasks((prev) => prev.map((x) => (x.id === id ? updated : x)));

    if (shouldClearNextContato(t, concluindo)) {
      const lead = leads.find((l) => l.id === t.leadId);
      if (lead && lead.proximoContato) {
        const cleared = await leadsApi.update(lead.id, { ...lead, proximoContato: '', proximoContatoHorario: '' });
        setLeads((prev) => prev.map((l) => (l.id === lead.id ? cleared : l)));
        await applyLeadAgendaActions(reconcileLeadAgendaActions([cleared], tasks), setTasks);
      }
    }
  }, [tasks, leads]);

  // Fase 2A.3 — conecta a conclusão de uma tarefa lead-agenda ao Activity
  // Engine (2A.2). A sequência (interação antes da tarefa, sem reimplementar
  // toggleTask) está em runCompleteTaskWithResult, testável isoladamente.
  const completeTaskWithResult = useCallback(async (id, actionKey) => {
    const t = tasks.find((x) => x.id === id);
    await runCompleteTaskWithResult(t, actionKey, userId, {
      insertInteraction: (data) => insertInteractionAndTrack(data, setInteractions),
      toggleTask,
    });
  }, [tasks, userId, toggleTask]);

  const deleteTask = useCallback(async (id) => {
    await tasksApi.remove(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addRotina = useCallback(async (titulo, categoria, horario, dias) => {
    const sortedDias = [...dias].sort((a, b) => DIAS_SEMANA.indexOf(a) - DIAS_SEMANA.indexOf(b));
    const tpl = await templatesApi.insert({ titulo, categoria, horario, dias: sortedDias, ativo: true });
    setTemplates((prev) => [...prev, tpl]);
    const pending = pendingRotinaTasks([tpl], tasks);
    for (const p of pending) {
      const inserted = await tasksApi.insert(p);
      setTasks((prev) => [...prev, inserted]);
    }
  }, [tasks]);

  const toggleRotinaAtiva = useCallback(async (id) => {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    const updated = await templatesApi.update(id, { ...tpl, ativo: !tpl.ativo });
    setTemplates((prev) => prev.map((t) => (t.id === id ? updated : t)));
    if (updated.ativo) {
      const pending = pendingRotinaTasks([updated], tasks);
      for (const p of pending) {
        const inserted = await tasksApi.insert(p);
        setTasks((prev) => [...prev, inserted]);
      }
    }
  }, [templates, tasks]);

  const deleteRotina = useCallback(async (id) => {
    await templatesApi.remove(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const importBackup = useCallback(async (rawBackup) => {
    const backup = normalizeBackup(rawBackup);
    await Promise.all(tasks.map((t) => tasksApi.remove(t.id)));
    await Promise.all(leads.map((l) => leadsApi.remove(l.id)));
    await Promise.all(templates.map((t) => templatesApi.remove(t.id)));

    const leadIdMap = new Map();
    const newLeads = [];
    for (const l of backup.leads) {
      const inserted = await leadsApi.insert(l);
      leadIdMap.set(l.id, inserted.id);
      newLeads.push(inserted);
    }

    const templateIdMap = new Map();
    const newTemplates = [];
    for (const tpl of backup.templates) {
      const inserted = await templatesApi.insert(tpl);
      templateIdMap.set(tpl.id, inserted.id);
      newTemplates.push(inserted);
    }

    const newTasks = [];
    for (const t of backup.tasks) {
      const inserted = await tasksApi.insert({
        ...t,
        leadId: t.leadId ? leadIdMap.get(t.leadId) || null : null,
        templateId: t.templateId ? templateIdMap.get(t.templateId) || null : null,
      });
      newTasks.push(inserted);
    }

    // backup.interactions só existe em backups v2 (backupVersion >= 2);
    // normalizeBackup já trata backups v1 (sem essa chave) como [],
    // sem quebrar o restore. Os leads antigos já foram excluídos acima,
    // o que já apaga em cascata (on delete cascade) as interações deles.
    const newInteractions = [];
    for (const it of backup.interactions) {
      if (!it.leadId || !leadIdMap.has(it.leadId)) continue;
      const inserted = await interactionsApi.insert({ ...it, leadId: leadIdMap.get(it.leadId) });
      newInteractions.push(inserted);
    }

    setLeads(newLeads);
    setTemplates(newTemplates);
    setTasks(newTasks);
    // Fase 2C.2A — substitui por completo, mesmo padrão de leads/tasks/
    // templates acima (importBackup é um replace total, não um merge).
    setInteractions(newInteractions);
  }, [leads, tasks, templates]);

  return {
    leads, tasks, templates, loading, error,
    interactions, interactionsLoading, interactionsError, refetchInteractions,
    saveLead, deleteLead, moveStage, setLeadStage,
    addTask, toggleTask, deleteTask, completeTaskWithResult,
    addRotina, toggleRotinaAtiva, deleteRotina,
    importBackup,
    addInteractionNote,
    registerCommercialInteraction,
  };
}
