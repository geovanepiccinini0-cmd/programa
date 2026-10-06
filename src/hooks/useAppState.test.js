import { describe, expect, it, vi, beforeEach } from 'vitest';

// Fase 2C.2A — logStageChange chama interactionsApi/auditLogApi de
// '../lib/db.js' direto (sem injeção de dependência, diferente de
// runCompleteTaskWithResult). Para testar sem bater no Supabase real,
// mocka-se só esse módulo; as demais funções testadas neste arquivo são
// puras e nunca tocam db.js.
vi.mock('../lib/db.js', () => ({
  leadsApi: {}, tasksApi: {}, templatesApi: {},
  interactionsApi: { insert: vi.fn(), fetchAllForUser: vi.fn() },
  auditLogApi: { insert: vi.fn() },
}));

import {
  pendingAutoTasksForLeads, autoTaskHorarioUpdates, pendingRotinaTasks,
  computeLeadAgendaTaskData, reconcileLeadAgendaActions,
  computeStageTimestamps, computeStageChangeInteraction, shouldClearNextContato,
  computeNoteInteractionData,
  computeLastActivityAt, computeLastContactAttemptAt, computeLastCustomerEngagementAt,
  computeCommercialInteractionData,
  shouldOfferResultCapture, runCompleteTaskWithResult,
  logStageChange, insertInteractionAndTrack,
} from './useAppState.js';
import { interactionsApi, auditLogApi } from '../lib/db.js';
import { todayStr } from '../utils.js';
import { DIAS_SEMANA } from '../constants.js';

// Simula o efeito de applyLeadAgendaActions sobre uma lista de tasks, sem
// bater no Supabase — usado para testar a orquestração de reconcileLeadAgendaActions
// do jeito que saveLead/o carregamento inicial realmente a aplicam.
function applyActionsToTasks(actions, tasks) {
  let result = tasks.slice();
  actions.forEach((action, i) => {
    if (action.type === 'insert') result.push({ id: 'novo-' + i, ...action.data });
    else if (action.type === 'update') result = result.map((t) => (t.id === action.id ? { ...t, ...action.data } : t));
    else if (action.type === 'delete') result = result.filter((t) => t.id !== action.id);
  });
  return result;
}

describe('pendingAutoTasksForLeads (lógica de follow-up)', () => {
  const today = todayStr();

  it('cria Follow-up para lead ativo com próximo contato vencido/hoje', () => {
    const leads = [{ id: 'l1', nome: 'Ana', etapa: 'Novo Lead', proximoContato: today, proximoContatoHorario: '10:00' }];
    const pending = pendingAutoTasksForLeads(leads, []);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ titulo: 'Follow-up: Ana', categoria: 'Follow-up', data: today, horario: '10:00', leadId: 'l1', origem: 'auto' });
  });

  it('não duplica Follow-up se já existe tarefa auto para a mesma data', () => {
    const leads = [{ id: 'l1', nome: 'Ana', etapa: 'Novo Lead', proximoContato: today }];
    const tasks = [{ leadId: 'l1', origem: 'auto', data: today }];
    expect(pendingAutoTasksForLeads(leads, tasks)).toHaveLength(0);
  });

  it('ignora leads Ganho/Perdido e sem próximo contato', () => {
    const leads = [
      { id: 'l1', nome: 'Ganho', etapa: 'Ganho', proximoContato: today },
      { id: 'l2', nome: 'SemContato', etapa: 'Novo Lead', proximoContato: '' },
      { id: 'l3', nome: 'Futuro', etapa: 'Novo Lead', proximoContato: '2099-01-01' },
    ];
    expect(pendingAutoTasksForLeads(leads, [])).toHaveLength(0);
  });
});

describe('autoTaskHorarioUpdates', () => {
  it('sincroniza horário da tarefa auto existente com o horário atual do lead', () => {
    const today = todayStr();
    const leads = [{ id: 'l1', nome: 'Ana', proximoContato: today, proximoContatoHorario: '15:00' }];
    const tasks = [{ id: 't1', leadId: 'l1', origem: 'auto', data: today, horario: '' }];
    const updates = autoTaskHorarioUpdates(leads, tasks);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ id: 't1', horario: '15:00' });
  });

  it('não gera update quando já está sincronizado', () => {
    const today = todayStr();
    const leads = [{ id: 'l1', nome: 'Ana', proximoContato: today, proximoContatoHorario: '15:00' }];
    const tasks = [{ id: 't1', leadId: 'l1', origem: 'auto', data: today, horario: '15:00' }];
    expect(autoTaskHorarioUpdates(leads, tasks)).toHaveLength(0);
  });
});

describe('pendingRotinaTasks', () => {
  it('cria a tarefa do dia para rotina ativa configurada para hoje', () => {
    const todayAbrev = DIAS_SEMANA[new Date().getDay()];
    const templates = [{ id: 'tpl1', titulo: 'Gravar reels', categoria: 'Conteúdo', horario: '09:00', dias: [todayAbrev], ativo: true }];
    const pending = pendingRotinaTasks(templates, []);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ titulo: 'Gravar reels', templateId: 'tpl1', origem: 'rotina' });
  });

  it('não cria tarefa para rotina inativa nem para dia não configurado', () => {
    const outroDia = DIAS_SEMANA[(new Date().getDay() + 1) % 7];
    const templates = [
      { id: 'tpl1', titulo: 'Inativa', categoria: 'Conteúdo', dias: [outroDia], ativo: false },
      { id: 'tpl2', titulo: 'Outro dia', categoria: 'Conteúdo', dias: [outroDia], ativo: true },
    ];
    expect(pendingRotinaTasks(templates, [])).toHaveLength(0);
  });
});

describe('computeLeadAgendaTaskData / reconcileLeadAgendaActions (reconciliação lead ↔ agenda)', () => {
  it('gera dados da tarefa Contato para lead ativo com próximo contato', () => {
    const lead = { id: 'l1', nome: 'Ana', etapa: 'Novo Lead', proximoContato: '2099-01-01', proximoContatoHorario: '10:00' };
    const data = computeLeadAgendaTaskData(lead);
    expect(data).toMatchObject({ titulo: 'Contato: Ana', categoria: 'Agenda/Ligação', data: '2099-01-01', horario: '10:00', leadId: 'l1', origem: 'lead-agenda' });
  });

  it('retorna null para lead Ganho/Perdido ou sem próximo contato', () => {
    expect(computeLeadAgendaTaskData({ id: 'l1', nome: 'A', etapa: 'Ganho', proximoContato: '2099-01-01' })).toBeNull();
    expect(computeLeadAgendaTaskData({ id: 'l1', nome: 'A', etapa: 'Novo Lead', proximoContato: '' })).toBeNull();
  });

  it('reconcileLeadAgendaActions insere quando não existe, atualiza quando mudou, e apaga quando o lead deixou de ter próximo contato', () => {
    const leadNovo = { id: 'l1', nome: 'Ana', etapa: 'Novo Lead', proximoContato: '2099-01-01', proximoContatoHorario: '10:00' };
    expect(reconcileLeadAgendaActions([leadNovo], [])).toEqual([
      { type: 'insert', data: computeLeadAgendaTaskData(leadNovo) },
    ]);

    const existente = { id: 't1', origem: 'lead-agenda', leadId: 'l1', titulo: 'Contato: Ana', data: '2099-01-01', horario: '09:00' };
    const atualizacoes = reconcileLeadAgendaActions([leadNovo], [existente]);
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]).toMatchObject({ type: 'update', id: 't1' });

    const leadSemContato = { ...leadNovo, proximoContato: '' };
    const delecoes = reconcileLeadAgendaActions([leadSemContato], [existente]);
    expect(delecoes).toEqual([{ type: 'delete', id: 't1' }]);
  });
});

describe('computeStageTimestamps (mudança de etapa)', () => {
  it('marca won_at e zera lost_at ao entrar em Ganho', () => {
    const r = computeStageTimestamps('Ganho');
    expect(r.wonAt).not.toBeNull();
    expect(r.lostAt).toBeNull();
  });

  it('marca lost_at e zera won_at ao entrar em Perdido', () => {
    const r = computeStageTimestamps('Perdido');
    expect(r.lostAt).not.toBeNull();
    expect(r.wonAt).toBeNull();
  });

  it('zera os dois para qualquer outra etapa', () => {
    expect(computeStageTimestamps('Qualificação')).toEqual({ wonAt: null, lostAt: null });
  });
});

describe('computeStageChangeInteraction (geração de interações)', () => {
  it('gera interação stage_change com metadata from/to quando a etapa muda', () => {
    const prevLead = { id: 'l1', etapa: 'Proposta' };
    const interaction = computeStageChangeInteraction(prevLead, 'Negociação');
    expect(interaction).toMatchObject({
      leadId: 'l1', type: 'stage_change', metadata: { from_stage: 'Proposta', to_stage: 'Negociação' },
    });
  });

  it('retorna null quando a etapa não muda', () => {
    expect(computeStageChangeInteraction({ id: 'l1', etapa: 'Proposta' }, 'Proposta')).toBeNull();
  });

  it('retorna null sem lead anterior (criação de lead novo)', () => {
    expect(computeStageChangeInteraction(null, 'Novo Lead')).toBeNull();
  });
});

describe('Fase 2A.1 — fundação de dados do Activity/Interaction Engine', () => {
  it('1) note: activity_class=internal, source=user, created_by preenchido', () => {
    const data = computeNoteInteractionData('l1', 'Cliente pediu para ligar semana que vem', 'user-abc');
    expect(data).toMatchObject({
      leadId: 'l1',
      type: 'note',
      content: 'Cliente pediu para ligar semana que vem',
      metadata: { activity_class: 'internal', source: 'user' },
      createdBy: 'user-abc',
    });
  });

  it('2) stage_change: activity_class=internal, source=user, created_by preenchido, from_stage/to_stage preservados', () => {
    const prevLead = { id: 'l1', etapa: 'Proposta' };
    const interaction = computeStageChangeInteraction(prevLead, 'Negociação', 'user-abc');
    expect(interaction).toMatchObject({
      leadId: 'l1',
      type: 'stage_change',
      createdBy: 'user-abc',
      metadata: {
        from_stage: 'Proposta',
        to_stage: 'Negociação',
        activity_class: 'internal',
        source: 'user',
      },
    });
  });

  it('3) last_activity_at considera qualquer classe (até sem metadata)', () => {
    const interactions = [
      { occurredAt: '2026-10-01T10:00:00.000Z', metadata: { activity_class: 'internal' } },
      { occurredAt: '2026-10-02T10:00:00.000Z', metadata: null },
      { occurredAt: '2026-10-03T10:00:00.000Z', metadata: { activity_class: 'engagement' } },
    ];
    expect(computeLastActivityAt(interactions)).toBe('2026-10-03T10:00:00.000Z');
  });

  it('4) last_contact_attempt_at considera call/whatsapp/meeting outbound (attempt ou engagement) e ignora internal', () => {
    const interactions = [
      { type: 'call', direction: 'outbound', occurredAt: '2026-10-01T09:00:00.000Z', metadata: { activity_class: 'attempt' } },
      { type: 'stage_change', direction: 'internal', occurredAt: '2026-10-05T09:00:00.000Z', metadata: { activity_class: 'internal' } }, // mais recente, mas ignorado
      { type: 'whatsapp', direction: 'outbound', occurredAt: '2026-10-02T09:00:00.000Z', metadata: { activity_class: 'attempt' } },
    ];
    expect(computeLastContactAttemptAt(interactions)).toBe('2026-10-02T09:00:00.000Z');
  });

  it('5) last_customer_engagement_at considera somente engagement', () => {
    const interactions = [
      { occurredAt: '2026-10-01T09:00:00.000Z', metadata: { activity_class: 'attempt' } },
      { occurredAt: '2026-10-02T09:00:00.000Z', metadata: { activity_class: 'engagement' } },
      { occurredAt: '2026-10-03T09:00:00.000Z', metadata: { activity_class: 'internal' } },
    ];
    expect(computeLastCustomerEngagementAt(interactions)).toBe('2026-10-02T09:00:00.000Z');
  });

  it('6) eventos fora de ordem de inserção: usa occurred_at, não a ordem do array/created_at', () => {
    const interactions = [
      { occurredAt: '2026-10-10T09:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', metadata: { activity_class: 'engagement' } },
      { occurredAt: '2026-10-05T09:00:00.000Z', createdAt: '2026-10-09T00:00:00.000Z', metadata: { activity_class: 'engagement' } },
    ];
    expect(computeLastCustomerEngagementAt(interactions)).toBe('2026-10-10T09:00:00.000Z');
  });

  it('7) coleção vazia: resultado previsível (null) para os três relógios', () => {
    expect(computeLastActivityAt([])).toBeNull();
    expect(computeLastContactAttemptAt([])).toBeNull();
    expect(computeLastCustomerEngagementAt([])).toBeNull();
  });

  it('8) apenas eventos internal: last_contact_attempt_at e last_customer_engagement_at ficam null (last_activity_at não)', () => {
    const interactions = [
      { type: 'note', direction: 'internal', occurredAt: '2026-10-01T09:00:00.000Z', metadata: { activity_class: 'internal' } },
      { type: 'stage_change', direction: 'internal', occurredAt: '2026-10-02T09:00:00.000Z', metadata: { activity_class: 'internal' } },
    ];
    expect(computeLastContactAttemptAt(interactions)).toBeNull();
    expect(computeLastCustomerEngagementAt(interactions)).toBeNull();
    expect(computeLastActivityAt(interactions)).toBe('2026-10-02T09:00:00.000Z');
  });

  it('9) WhatsApp enviado (attempt, 09:00) e depois cliente responde (engagement inbound, 11:00): a resposta do cliente NÃO atualiza "última tentativa" (decisão da Fase 2B) — só "último engajamento"', () => {
    const interactions = [
      { type: 'whatsapp', direction: 'outbound', occurredAt: '2026-10-10T09:00:00.000Z', metadata: { activity_class: 'attempt' } },
      { type: 'whatsapp', direction: 'inbound', occurredAt: '2026-10-10T11:00:00.000Z', metadata: { activity_class: 'engagement' } },
    ];
    expect(computeLastContactAttemptAt(interactions)).toBe('2026-10-10T09:00:00.000Z');
    expect(computeLastCustomerEngagementAt(interactions)).toBe('2026-10-10T11:00:00.000Z');
  });
});

describe('Correção: agendamento (proximoContato) não deve mais gerar Follow-up duplicado', () => {
  // A orquestração real de saveLead/carregamento inicial (useAppState.js) hoje só
  // chama reconcileLeadAgendaActions para proximoContato — pendingAutoTasksForLeads
  // segue existindo (infraestrutura reservada) mas não é mais acionada por esse
  // caminho. Estes testes simulam exatamente essa orquestração nova.

  it('A) lead sem proximoContato: nenhuma tarefa automática (nem Follow-up nem Contato)', () => {
    const lead = { id: 'l1', nome: 'Ana', etapa: 'Novo Lead', proximoContato: '', proximoContatoHorario: '' };
    expect(pendingAutoTasksForLeads([lead], [])).toHaveLength(0);
    expect(reconcileLeadAgendaActions([lead], [])).toHaveLength(0);
  });

  it('B) lead com proximoContato+horario: a orquestração nova cria exatamente 1 tarefa (Contato/lead-agenda)', () => {
    const lead = { id: 'l1', nome: 'Lilliane', etapa: 'Novo Lead', proximoContato: '2026-10-06', proximoContatoHorario: '09:30' };
    const actions = reconcileLeadAgendaActions([lead], []);
    const tasks = applyActionsToTasks(actions, []);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ titulo: 'Contato: Lilliane', categoria: 'Agenda/Ligação', origem: 'lead-agenda', data: '2026-10-06', horario: '09:30' });
    expect(tasks.some((t) => t.origem === 'auto')).toBe(false);
  });

  it('C) salvar novamente o mesmo lead sem mudar data/horário: continua existindo só 1 tarefa', () => {
    const lead = { id: 'l1', nome: 'Lilliane', etapa: 'Novo Lead', proximoContato: '2026-10-06', proximoContatoHorario: '09:30' };
    let tasks = applyActionsToTasks(reconcileLeadAgendaActions([lead], []), []);
    const actionsSegundoSave = reconcileLeadAgendaActions([lead], tasks);
    expect(actionsSegundoSave).toHaveLength(0);
    tasks = applyActionsToTasks(actionsSegundoSave, tasks);
    expect(tasks).toHaveLength(1);
  });

  it('D) alterar data/horário do próximo contato: atualiza a tarefa existente, não duplica', () => {
    const lead = { id: 'l1', nome: 'Lilliane', etapa: 'Novo Lead', proximoContato: '2026-10-06', proximoContatoHorario: '09:30' };
    let tasks = applyActionsToTasks(reconcileLeadAgendaActions([lead], []), []);
    const leadReagendado = { ...lead, proximoContato: '2026-10-07', proximoContatoHorario: '14:00' };
    const actions = reconcileLeadAgendaActions([leadReagendado], tasks);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('update');
    tasks = applyActionsToTasks(actions, tasks);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ data: '2026-10-07', horario: '14:00' });
  });

  it('E) remover o próximo contato: a tarefa lead-agenda correspondente é removida', () => {
    const lead = { id: 'l1', nome: 'Lilliane', etapa: 'Novo Lead', proximoContato: '2026-10-06', proximoContatoHorario: '09:30' };
    let tasks = applyActionsToTasks(reconcileLeadAgendaActions([lead], []), []);
    const leadSemContato = { ...lead, proximoContato: '', proximoContatoHorario: '' };
    const actions = reconcileLeadAgendaActions([leadSemContato], tasks);
    expect(actions).toEqual([{ type: 'delete', id: tasks[0].id }]);
    tasks = applyActionsToTasks(actions, tasks);
    expect(tasks).toHaveLength(0);
  });

  it('F) concluir tarefa lead-agenda indica que o próximo contato do lead deve ser limpo (regra preservada)', () => {
    expect(shouldClearNextContato({ id: 't1', leadId: 'l1', origem: 'lead-agenda' }, true)).toBe(true);
    expect(shouldClearNextContato({ id: 't1', leadId: 'l1', origem: 'auto' }, true)).toBe(true); // comportamento preservado p/ Follow-up manual/futuro
  });

  it('F2) desmarcar (não concluir) uma tarefa não limpa o próximo contato', () => {
    expect(shouldClearNextContato({ id: 't1', leadId: 'l1', origem: 'lead-agenda' }, false)).toBe(false);
  });

  it('F3) tarefa manual (sem leadId) nunca limpa próximo contato de ninguém', () => {
    expect(shouldClearNextContato({ id: 't1', leadId: null, origem: 'manual' }, true)).toBe(false);
  });

  it('G) inicialização/reload com lead que já tem proximoContato: reconcilia só a tarefa Contato, não cria Follow-up auto', () => {
    const today = todayStr();
    const lead = { id: 'l1', nome: 'Lilliane', etapa: 'Novo Lead', proximoContato: today, proximoContatoHorario: '09:30' };
    // Mesma orquestração do useEffect de carregamento inicial (sem tasks ainda no banco):
    const tasksAposInit = applyActionsToTasks(reconcileLeadAgendaActions([lead], []), []);
    expect(tasksAposInit).toHaveLength(1);
    expect(tasksAposInit[0].origem).toBe('lead-agenda');
    expect(tasksAposInit.some((t) => t.origem === 'auto')).toBe(false);
    // pendingAutoTasksForLeads continua funcionando como função pura (infraestrutura
    // reservada), só não é mais chamada nessa orquestração — por isso ela sozinha
    // ainda retornaria uma Follow-up se fosse invocada, mas não é:
    expect(pendingAutoTasksForLeads([lead], [])).toHaveLength(1);
  });

  it('H) lead movido para Ganho: a tarefa Contato existente é removida (reconciliação), sem regressão', () => {
    const lead = { id: 'l1', nome: 'Ana', etapa: 'Novo Lead', proximoContato: '2026-10-06', proximoContatoHorario: '10:00' };
    let tasks = applyActionsToTasks(reconcileLeadAgendaActions([lead], []), []);
    expect(tasks).toHaveLength(1);
    const leadGanho = { ...lead, etapa: 'Ganho' };
    const actions = reconcileLeadAgendaActions([leadGanho], tasks);
    expect(actions).toEqual([{ type: 'delete', id: tasks[0].id }]);
    tasks = applyActionsToTasks(actions, tasks);
    expect(tasks).toHaveLength(0);
  });

  it('H2) lead movido para Perdido: mesmo comportamento de remoção da tarefa Contato', () => {
    const lead = { id: 'l1', nome: 'Ana', etapa: 'Novo Lead', proximoContato: '2026-10-06', proximoContatoHorario: '10:00' };
    let tasks = applyActionsToTasks(reconcileLeadAgendaActions([lead], []), []);
    const leadPerdido = { ...lead, etapa: 'Perdido' };
    const actions = reconcileLeadAgendaActions([leadPerdido], tasks);
    expect(actions).toEqual([{ type: 'delete', id: tasks[0].id }]);
    tasks = applyActionsToTasks(actions, tasks);
    expect(tasks).toHaveLength(0);
  });
});

describe('Fase 2A.2 — computeCommercialInteractionData (registro rápido de interações)', () => {
  it('1) call_connected -> engagement', () => {
    const data = computeCommercialInteractionData('l1', 'call_connected', 'user-abc');
    expect(data).toMatchObject({
      leadId: 'l1', type: 'call', direction: 'outbound', channel: 'phone',
      metadata: { activity_class: 'engagement', outcome: 'connected' },
    });
  });

  it('2) call_no_answer -> attempt', () => {
    const data = computeCommercialInteractionData('l1', 'call_no_answer', 'user-abc');
    expect(data).toMatchObject({
      leadId: 'l1', type: 'call', direction: 'outbound', channel: 'phone',
      metadata: { activity_class: 'attempt', outcome: 'no_answer' },
    });
  });

  it('3) whatsapp_sent (outbound) -> attempt', () => {
    const data = computeCommercialInteractionData('l1', 'whatsapp_sent', 'user-abc');
    expect(data).toMatchObject({
      leadId: 'l1', type: 'whatsapp', direction: 'outbound', channel: 'whatsapp',
      metadata: { activity_class: 'attempt' },
    });
  });

  it('4) whatsapp_received (inbound) -> engagement', () => {
    const data = computeCommercialInteractionData('l1', 'whatsapp_received', 'user-abc');
    expect(data).toMatchObject({
      leadId: 'l1', type: 'whatsapp', direction: 'inbound', channel: 'whatsapp',
      metadata: { activity_class: 'engagement' },
    });
  });

  it('5) meeting_held -> engagement', () => {
    const data = computeCommercialInteractionData('l1', 'meeting_held', 'user-abc');
    expect(data).toMatchObject({
      leadId: 'l1', type: 'meeting', direction: 'outbound', channel: 'in_person',
      metadata: { activity_class: 'engagement', outcome: 'held' },
    });
  });

  it('6) proposal_sent -> attempt (ação do vendedor, não confirmação do cliente)', () => {
    const data = computeCommercialInteractionData('l1', 'proposal_sent', 'user-abc');
    expect(data).toMatchObject({
      leadId: 'l1', type: 'proposal', direction: 'outbound', channel: 'manual',
      metadata: { activity_class: 'attempt', outcome: 'sent' },
    });
  });

  it('7) todas as ações preenchem metadata.source = "user"', () => {
    const actions = ['call_connected', 'call_no_answer', 'whatsapp_sent', 'whatsapp_received', 'meeting_held', 'proposal_sent'];
    actions.forEach((action) => {
      expect(computeCommercialInteractionData('l1', action, 'user-abc').metadata.source).toBe('user');
    });
  });

  it('8) todas as ações preservam createdBy = userId', () => {
    const actions = ['call_connected', 'call_no_answer', 'whatsapp_sent', 'whatsapp_received', 'meeting_held', 'proposal_sent'];
    actions.forEach((action) => {
      expect(computeCommercialInteractionData('l1', action, 'user-abc').createdBy).toBe('user-abc');
    });
  });

  it('9) ação inválida falha de maneira previsível (erro explícito, não payload incorreto)', () => {
    expect(() => computeCommercialInteractionData('l1', 'acao_que_nao_existe', 'user-abc')).toThrow();
  });
});

describe('Fase 2A.3 — shouldOfferResultCapture (tarefa → resultado → interação)', () => {
  it('1) true para lead-agenda com leadId', () => {
    expect(shouldOfferResultCapture({ id: 't1', leadId: 'l1', origem: 'lead-agenda' })).toBe(true);
  });

  it('2) false para lead-agenda sem leadId', () => {
    expect(shouldOfferResultCapture({ id: 't1', leadId: null, origem: 'lead-agenda' })).toBe(false);
  });

  it('3) false para auto, mesmo com leadId (auto permanece fora de qualquer fluxo novo)', () => {
    expect(shouldOfferResultCapture({ id: 't1', leadId: 'l1', origem: 'auto' })).toBe(false);
  });

  it('4) false para manual', () => {
    expect(shouldOfferResultCapture({ id: 't1', leadId: null, origem: 'manual' })).toBe(false);
  });

  it('5) false para rotina', () => {
    expect(shouldOfferResultCapture({ id: 't1', leadId: null, origem: 'rotina' })).toBe(false);
  });
});

describe('Fase 2A.3 — runCompleteTaskWithResult (orquestração: interação primeiro, task depois)', () => {
  const leadAgendaTask = { id: 't1', leadId: 'l1', origem: 'lead-agenda' };

  it('6) Atendeu: insertInteraction (call_connected) acontece antes de toggleTask', async () => {
    const order = [];
    const insertInteraction = vi.fn(async (data) => { order.push(['insert', data]); return { id: 'int-1', ...data }; });
    const toggleTask = vi.fn(async (id) => { order.push(['toggle', id]); });

    await runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', { insertInteraction, toggleTask });

    expect(order.map((o) => o[0])).toEqual(['insert', 'toggle']);
    expect(insertInteraction).toHaveBeenCalledTimes(1);
    expect(insertInteraction.mock.calls[0][0]).toMatchObject({ type: 'call', metadata: { activity_class: 'engagement', outcome: 'connected' } });
    expect(toggleTask).toHaveBeenCalledWith('t1');
  });

  it('7) Não atendeu: insertInteraction (call_no_answer) acontece antes de toggleTask', async () => {
    const order = [];
    const insertInteraction = vi.fn(async (data) => { order.push(['insert', data]); return { id: 'int-1', ...data }; });
    const toggleTask = vi.fn(async (id) => { order.push(['toggle', id]); });

    await runCompleteTaskWithResult(leadAgendaTask, 'call_no_answer', 'user-abc', { insertInteraction, toggleTask });

    expect(order.map((o) => o[0])).toEqual(['insert', 'toggle']);
    expect(insertInteraction.mock.calls[0][0]).toMatchObject({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' } });
  });

  it('8) metadata.task_id é incluído no objeto passado para insertInteraction (chegaria intacto até interactionToRow)', async () => {
    const insertInteraction = vi.fn(async (data) => ({ id: 'int-1', ...data }));
    const toggleTask = vi.fn(async () => {});

    await runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', { insertInteraction, toggleTask });

    expect(insertInteraction.mock.calls[0][0].metadata).toMatchObject({
      activity_class: 'engagement', outcome: 'connected', source: 'user', task_id: 't1',
    });
    expect(insertInteraction.mock.calls[0][0].createdBy).toBe('user-abc');
  });

  it('10) falha no insert: toggleTask NÃO é chamado', async () => {
    const insertInteraction = vi.fn(async () => { throw new Error('Falha de rede simulada'); });
    const toggleTask = vi.fn(async () => {});

    await expect(runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', { insertInteraction, toggleTask }))
      .rejects.toThrow('Falha de rede simulada');
    expect(toggleTask).not.toHaveBeenCalled();
  });

  it('11) falha no toggle depois do insert: erro propaga, insertInteraction não é chamado de novo (interação não é desfeita)', async () => {
    const insertInteraction = vi.fn(async (data) => ({ id: 'int-1', ...data }));
    const toggleTask = vi.fn(async () => { throw new Error('Falha ao concluir a tarefa'); });

    await expect(runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', { insertInteraction, toggleTask }))
      .rejects.toThrow('Falha ao concluir a tarefa');
    expect(insertInteraction).toHaveBeenCalledTimes(1);
  });

  it('não oferece resultado (ex. rotina): não chama insertInteraction nem toggleTask', async () => {
    const insertInteraction = vi.fn();
    const toggleTask = vi.fn();
    const rotinaTask = { id: 't2', leadId: null, origem: 'rotina' };

    await runCompleteTaskWithResult(rotinaTask, 'call_connected', 'user-abc', { insertInteraction, toggleTask });

    expect(insertInteraction).not.toHaveBeenCalled();
    expect(toggleTask).not.toHaveBeenCalled();
  });
});

describe('Fase 2B — matriz completa dos três relógios (trava a decisão semântica desta fase)', () => {
  // Interações no formato real (como vêm de interactionFromRow): type,
  // direction, metadata.activity_class/outcome, occurredAt.
  const note = { type: 'note', direction: 'internal', occurredAt: '2026-10-01T09:00:00.000Z', metadata: { activity_class: 'internal', source: 'user' } };
  const stageChange = { type: 'stage_change', direction: 'internal', occurredAt: '2026-10-01T10:00:00.000Z', metadata: { activity_class: 'internal', source: 'user' } };
  const callNoAnswer = { type: 'call', direction: 'outbound', occurredAt: '2026-10-02T09:00:00.000Z', metadata: { activity_class: 'attempt', outcome: 'no_answer', source: 'user' } };
  const callConnected = { type: 'call', direction: 'outbound', occurredAt: '2026-10-03T09:00:00.000Z', metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' } };
  const whatsappSent = { type: 'whatsapp', direction: 'outbound', occurredAt: '2026-10-04T09:00:00.000Z', metadata: { activity_class: 'attempt', source: 'user' } };
  const whatsappReceived = { type: 'whatsapp', direction: 'inbound', occurredAt: '2026-10-05T09:00:00.000Z', metadata: { activity_class: 'engagement', source: 'user' } };
  const meetingHeld = { type: 'meeting', direction: 'outbound', occurredAt: '2026-10-06T09:00:00.000Z', metadata: { activity_class: 'engagement', outcome: 'held', source: 'user' } };
  const proposalSent = { type: 'proposal', direction: 'outbound', occurredAt: '2026-10-07T09:00:00.000Z', metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } };
  const legacyNote = { type: 'note', direction: '', occurredAt: '2025-01-01T09:00:00.000Z', metadata: null };
  const legacyStageChange = { type: 'stage_change', direction: '', occurredAt: '2025-01-02T09:00:00.000Z', metadata: { from_stage: 'Novo Lead', to_stage: 'Qualificação' } };

  it('A) coleção vazia -> três null', () => {
    expect(computeLastActivityAt([])).toBeNull();
    expect(computeLastContactAttemptAt([])).toBeNull();
    expect(computeLastCustomerEngagementAt([])).toBeNull();
  });

  it('B) somente note/stage_change -> activity preenchida, attempt null, engagement null', () => {
    const interactions = [note, stageChange];
    expect(computeLastActivityAt(interactions)).toBe(stageChange.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBeNull();
    expect(computeLastCustomerEngagementAt(interactions)).toBeNull();
  });

  it('C) call no_answer outbound -> activity + attempt, não engagement', () => {
    const interactions = [callNoAnswer];
    expect(computeLastActivityAt(interactions)).toBe(callNoAnswer.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBe(callNoAnswer.occurredAt);
    expect(computeLastCustomerEngagementAt(interactions)).toBeNull();
  });

  it('D) call connected outbound -> os três', () => {
    const interactions = [callConnected];
    expect(computeLastActivityAt(interactions)).toBe(callConnected.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBe(callConnected.occurredAt);
    expect(computeLastCustomerEngagementAt(interactions)).toBe(callConnected.occurredAt);
  });

  it('E) whatsapp outbound attempt -> activity + attempt, não engagement', () => {
    const interactions = [whatsappSent];
    expect(computeLastActivityAt(interactions)).toBe(whatsappSent.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBe(whatsappSent.occurredAt);
    expect(computeLastCustomerEngagementAt(interactions)).toBeNull();
  });

  it('F) whatsapp inbound engagement -> activity + engagement, NÃO attempt', () => {
    const interactions = [whatsappReceived];
    expect(computeLastActivityAt(interactions)).toBe(whatsappReceived.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBeNull();
    expect(computeLastCustomerEngagementAt(interactions)).toBe(whatsappReceived.occurredAt);
  });

  it('G) meeting held outbound engagement -> os três', () => {
    const interactions = [meetingHeld];
    expect(computeLastActivityAt(interactions)).toBe(meetingHeld.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBe(meetingHeld.occurredAt);
    expect(computeLastCustomerEngagementAt(interactions)).toBe(meetingHeld.occurredAt);
  });

  it('H) proposal sent outbound attempt -> activity, NÃO attempt (contact), NÃO engagement [decisão da Fase 2B]', () => {
    const interactions = [proposalSent];
    expect(computeLastActivityAt(interactions)).toBe(proposalSent.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBeNull();
    expect(computeLastCustomerEngagementAt(interactions)).toBeNull();
  });

  it('I) occurredAt fora de ordem de inserção -> usa o maior occurredAt, não a posição no array', () => {
    const interactions = [callConnected, callNoAnswer]; // callConnected (dia 3) inserido antes de callNoAnswer (dia 2)
    expect(computeLastContactAttemptAt(interactions)).toBe(callConnected.occurredAt);
  });

  it('J) legado (metadata null / stage_change antigo sem activity_class) -> conta em activity, nunca em attempt/engagement', () => {
    const interactions = [legacyNote, legacyStageChange];
    expect(computeLastActivityAt(interactions)).toBe(legacyStageChange.occurredAt);
    expect(computeLastContactAttemptAt(interactions)).toBeNull();
    expect(computeLastCustomerEngagementAt(interactions)).toBeNull();
  });

  it('K) cenário real homologado da Lilliane: call no_answer depois call connected -> tentativa e engajamento acompanham o connected (mais recente)', () => {
    const interactions = [callNoAnswer, callConnected]; // no_answer em 02/10, connected em 03/10
    expect(computeLastContactAttemptAt(interactions)).toBe(callConnected.occurredAt);
    expect(computeLastCustomerEngagementAt(interactions)).toBe(callConnected.occurredAt);
  });
});

describe('Fase 2C.2A — logStageChange (único ponto de escrita de interactions fora de useState que não usa DI)', () => {
  const prevLead = { id: 'lead-1', etapa: 'Negociação' };
  const updatedLead = { id: 'lead-1', etapa: 'Ganho' };

  beforeEach(() => {
    interactionsApi.insert.mockReset();
    auditLogApi.insert.mockReset();
  });

  it('1) etapa mudou: insere a interação e aplica a LINHA DEVOLVIDA pelo insert ao estado (nunca um objeto local inventado)', async () => {
    const insertedRow = { id: 'int-server-1', leadId: 'lead-1', type: 'stage_change', metadata: { from_stage: 'Negociação', to_stage: 'Ganho', activity_class: 'internal', source: 'user' } };
    interactionsApi.insert.mockResolvedValueOnce(insertedRow);
    auditLogApi.insert.mockResolvedValueOnce({});
    const setInteractions = vi.fn();

    await logStageChange(prevLead, updatedLead, 'user-abc', setInteractions);

    expect(interactionsApi.insert).toHaveBeenCalledTimes(1);
    expect(setInteractions).toHaveBeenCalledTimes(1);
    const updater = setInteractions.mock.calls[0][0];
    expect(updater([])).toEqual([insertedRow]); // é a linha do servidor, não um objeto recriado localmente
  });

  it('2) etapa não mudou: não insere nada e não chama setInteractions (sem duplicidade/ruído no estado)', async () => {
    const setInteractions = vi.fn();
    await logStageChange(prevLead, { id: 'lead-1', etapa: 'Negociação' }, 'user-abc', setInteractions);
    expect(interactionsApi.insert).not.toHaveBeenCalled();
    expect(setInteractions).not.toHaveBeenCalled();
  });

  it('3) falha no insert: não chama setInteractions (nenhuma interação fantasma no estado) e não propaga o erro (mudança de etapa já persistida não pode cair)', async () => {
    interactionsApi.insert.mockRejectedValueOnce(new Error('relation "lead_interactions" does not exist'));
    const setInteractions = vi.fn();

    await expect(logStageChange(prevLead, updatedLead, 'user-abc', setInteractions)).resolves.toBeUndefined();
    expect(setInteractions).not.toHaveBeenCalled();
  });

  it('4) falha no audit_log depois do insert de sucesso: a interação já aplicada ao estado não é desfeita (decisão explícita, sem rollback)', async () => {
    const insertedRow = { id: 'int-server-2', leadId: 'lead-1' };
    interactionsApi.insert.mockResolvedValueOnce(insertedRow);
    auditLogApi.insert.mockRejectedValueOnce(new Error('relation "audit_log" does not exist'));
    const setInteractions = vi.fn();

    await expect(logStageChange(prevLead, updatedLead, 'user-abc', setInteractions)).resolves.toBeUndefined();
    expect(setInteractions).toHaveBeenCalledTimes(1);
  });

  it('5) setInteractions é chamado no máximo uma vez por chamada (sem duplicidade)', async () => {
    interactionsApi.insert.mockResolvedValueOnce({ id: 'int-server-3', leadId: 'lead-1' });
    auditLogApi.insert.mockResolvedValueOnce({});
    const setInteractions = vi.fn();

    await logStageChange(prevLead, updatedLead, 'user-abc', setInteractions);

    expect(setInteractions.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('Fase 2C.2A.1 — insertInteractionAndTrack (helper extraído, usado por addInteractionNote/registerCommercialInteraction/completeTaskWithResult)', () => {
  beforeEach(() => {
    interactionsApi.insert.mockReset();
  });

  it('insere UMA vez e aplica a linha devolvida pelo servidor ao estado UMA vez, devolvendo essa mesma linha', async () => {
    const insertedRow = { id: 'int-x', leadId: 'lead-1', type: 'note' };
    interactionsApi.insert.mockResolvedValueOnce(insertedRow);
    const setInteractions = vi.fn();
    const payload = { leadId: 'lead-1', type: 'note', content: 'oi' };

    const result = await insertInteractionAndTrack(payload, setInteractions);

    expect(interactionsApi.insert).toHaveBeenCalledTimes(1);
    expect(interactionsApi.insert).toHaveBeenCalledWith(payload);
    expect(setInteractions).toHaveBeenCalledTimes(1);
    expect(setInteractions.mock.calls[0][0]([])).toEqual([insertedRow]);
    expect(result).toBe(insertedRow); // a mesma linha, não uma cópia reconstruída
  });

  it('insert falha: setInteractions não é chamado (nenhuma interaction fantasma) e o erro propaga para o chamador decidir', async () => {
    interactionsApi.insert.mockRejectedValueOnce(new Error('Falha de rede simulada'));
    const setInteractions = vi.fn();

    await expect(insertInteractionAndTrack({ leadId: 'lead-1' }, setInteractions)).rejects.toThrow('Falha de rede simulada');
    expect(setInteractions).not.toHaveBeenCalled();
  });
});

describe('Fase 2C.2A.1 — addInteractionNote (composição real: computeNoteInteractionData + insertInteractionAndTrack)', () => {
  // addInteractionNote, dentro do hook, é literalmente
  // `(leadId, content) => insertInteractionAndTrack(computeNoteInteractionData(leadId, content, userId), setInteractions)`
  // — sem lógica extra. Testar essa composição direta exercita o
  // comportamento real da função sem precisar renderizar o hook (zero
  // React Testing Library no projeto).
  beforeEach(() => {
    interactionsApi.insert.mockReset();
  });

  it('computeNoteInteractionData produz o payload correto, passado intacto para interactionsApi.insert (1x)', async () => {
    const insertedRow = { id: 'int-note-1', leadId: 'lead-1', type: 'note', content: 'ligar de novo' };
    interactionsApi.insert.mockResolvedValueOnce(insertedRow);
    const setInteractions = vi.fn();

    const payload = computeNoteInteractionData('lead-1', 'ligar de novo', 'user-abc');
    const result = await insertInteractionAndTrack(payload, setInteractions);

    expect(interactionsApi.insert).toHaveBeenCalledTimes(1);
    expect(interactionsApi.insert).toHaveBeenCalledWith(payload);
    expect(payload).toMatchObject({ leadId: 'lead-1', type: 'note', content: 'ligar de novo', createdBy: 'user-abc', metadata: { activity_class: 'internal', source: 'user' } });
    // a row que "entra no state" e é devolvida é a do servidor, não o payload local:
    expect(setInteractions.mock.calls[0][0]([])).toEqual([insertedRow]);
    expect(result).toBe(insertedRow);
  });

  it('insert falha: state não recebe interaction falsa (mesma semântica de erro de sempre)', async () => {
    interactionsApi.insert.mockRejectedValueOnce(new Error('Falha de rede simulada'));
    const setInteractions = vi.fn();

    await expect(
      insertInteractionAndTrack(computeNoteInteractionData('lead-1', 'nota', 'user-abc'), setInteractions),
    ).rejects.toThrow('Falha de rede simulada');
    expect(setInteractions).not.toHaveBeenCalled();
  });
});

describe('Fase 2C.2A.1 — registerCommercialInteraction (composição real: computeCommercialInteractionData + insertInteractionAndTrack)', () => {
  beforeEach(() => {
    interactionsApi.insert.mockReset();
  });

  it('computeCommercialInteractionData continua sendo a fonte única de classificação, passada intacta para o insert (1x)', async () => {
    const insertedRow = { id: 'int-com-1', leadId: 'lead-1', type: 'call', metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' } };
    interactionsApi.insert.mockResolvedValueOnce(insertedRow);
    const setInteractions = vi.fn();

    const payload = computeCommercialInteractionData('lead-1', 'call_connected', 'user-abc');
    const result = await insertInteractionAndTrack(payload, setInteractions);

    expect(interactionsApi.insert).toHaveBeenCalledTimes(1);
    expect(interactionsApi.insert).toHaveBeenCalledWith(payload);
    expect(payload).toMatchObject({ type: 'call', direction: 'outbound', metadata: { activity_class: 'engagement', outcome: 'connected' } });
    expect(setInteractions.mock.calls[0][0]([])).toEqual([insertedRow]);
    expect(result).toBe(insertedRow);
  });

  it('insert falha: zero atualização de state', async () => {
    interactionsApi.insert.mockRejectedValueOnce(new Error('Falha de rede simulada'));
    const setInteractions = vi.fn();

    await expect(
      insertInteractionAndTrack(computeCommercialInteractionData('lead-1', 'whatsapp_sent', 'user-abc'), setInteractions),
    ).rejects.toThrow('Falha de rede simulada');
    expect(setInteractions).not.toHaveBeenCalled();
  });
});

describe('Fase 2C.2A.1 — completeTaskWithResult, cabo real (runCompleteTaskWithResult + insertInteractionAndTrack, exatamente como no hook)', () => {
  // Reproduz a composição exata usada dentro de useAppState.js:
  //   insertInteraction: (data) => insertInteractionAndTrack(data, setInteractions)
  // Isso cobre a ligação real interactionsApi.insert -> row do servidor ->
  // setInteractions (1x), por cima da orquestração pura já testada acima
  // (Fase 2A.3), sem duplicar nenhuma lógica de produção.
  const leadAgendaTask = { id: 't1', leadId: 'l1', origem: 'lead-agenda' };

  beforeEach(() => {
    interactionsApi.insert.mockReset();
  });

  it('Atendeu: 1 insert + 1 setInteractions + toggleTask chamado depois', async () => {
    const insertedRow = { id: 'int-1', leadId: 'l1', type: 'call' };
    interactionsApi.insert.mockResolvedValueOnce(insertedRow);
    const setInteractions = vi.fn();
    const toggleTask = vi.fn(async () => {});

    await runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', {
      insertInteraction: (data) => insertInteractionAndTrack(data, setInteractions),
      toggleTask,
    });

    expect(interactionsApi.insert).toHaveBeenCalledTimes(1);
    expect(setInteractions).toHaveBeenCalledTimes(1);
    expect(setInteractions.mock.calls[0][0]([])).toEqual([insertedRow]);
    expect(toggleTask).toHaveBeenCalledWith('t1');
  });

  it('Não atendeu: 1 insert + 1 setInteractions', async () => {
    interactionsApi.insert.mockResolvedValueOnce({ id: 'int-2', leadId: 'l1', type: 'call' });
    const setInteractions = vi.fn();
    const toggleTask = vi.fn(async () => {});

    await runCompleteTaskWithResult(leadAgendaTask, 'call_no_answer', 'user-abc', {
      insertInteraction: (data) => insertInteractionAndTrack(data, setInteractions),
      toggleTask,
    });

    expect(interactionsApi.insert).toHaveBeenCalledTimes(1);
    expect(setInteractions).toHaveBeenCalledTimes(1);
  });

  it('insert falha: zero setInteractions e toggleTask NÃO é chamado', async () => {
    interactionsApi.insert.mockRejectedValueOnce(new Error('Falha de rede simulada'));
    const setInteractions = vi.fn();
    const toggleTask = vi.fn(async () => {});

    await expect(
      runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', {
        insertInteraction: (data) => insertInteractionAndTrack(data, setInteractions),
        toggleTask,
      }),
    ).rejects.toThrow('Falha de rede simulada');

    expect(setInteractions).not.toHaveBeenCalled();
    expect(toggleTask).not.toHaveBeenCalled();
  });

  it('toggleTask falha depois do insert: a interaction já aplicada ao estado permanece (sem rollback)', async () => {
    const insertedRow = { id: 'int-3', leadId: 'l1', type: 'call' };
    interactionsApi.insert.mockResolvedValueOnce(insertedRow);
    const setInteractions = vi.fn();
    const toggleTask = vi.fn(async () => { throw new Error('Falha ao concluir a tarefa'); });

    await expect(
      runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', {
        insertInteraction: (data) => insertInteractionAndTrack(data, setInteractions),
        toggleTask,
      }),
    ).rejects.toThrow('Falha ao concluir a tarefa');

    expect(setInteractions).toHaveBeenCalledTimes(1);
    expect(setInteractions.mock.calls[0][0]([])).toEqual([insertedRow]); // permanece, não é desfeita
  });

  it('nunca chama insertInteractionAndTrack mais de uma vez por chamada (sem duplicidade de interaction no state)', async () => {
    interactionsApi.insert.mockResolvedValueOnce({ id: 'int-4', leadId: 'l1', type: 'call' });
    const setInteractions = vi.fn();
    const toggleTask = vi.fn(async () => {});

    await runCompleteTaskWithResult(leadAgendaTask, 'call_connected', 'user-abc', {
      insertInteraction: (data) => insertInteractionAndTrack(data, setInteractions),
      toggleTask,
    });

    expect(interactionsApi.insert.mock.calls.length).toBe(1);
    expect(setInteractions.mock.calls.length).toBe(1);
  });

  // "Só concluir" não passa por runCompleteTaskWithResult/insertInteractionAndTrack
  // de forma alguma: confirmado por leitura de TaskCompletionControl.jsx
  // (intocado nesta fase) — o botão "Só concluir" chama onToggleTask(task.id)
  // DIRETO (linha 64), nunca onCompleteWithResult. Como são caminhos de
  // código inteiramente separados (toggleTask não importa interactionsApi),
  // "zero insert + zero state update" é garantido pela própria separação de
  // responsabilidades, não por este teste — documentado aqui em vez de
  // simulado artificialmente.
});
