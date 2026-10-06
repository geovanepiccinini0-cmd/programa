import { describe, expect, it } from 'vitest';
import {
  pendingAutoTasksForLeads, autoTaskHorarioUpdates, pendingRotinaTasks,
  computeLeadAgendaTaskData, reconcileLeadAgendaActions,
  computeStageTimestamps, computeStageChangeInteraction, shouldClearNextContato,
  computeNoteInteractionData,
  computeLastActivityAt, computeLastContactAt, computeLastCustomerEngagementAt,
} from './useAppState.js';
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

  it('4) last_contact_at considera attempt + engagement e ignora internal', () => {
    const interactions = [
      { occurredAt: '2026-10-01T09:00:00.000Z', metadata: { activity_class: 'attempt' } },
      { occurredAt: '2026-10-05T09:00:00.000Z', metadata: { activity_class: 'internal' } }, // mais recente, mas ignorado
      { occurredAt: '2026-10-02T09:00:00.000Z', metadata: { activity_class: 'engagement' } },
    ];
    expect(computeLastContactAt(interactions)).toBe('2026-10-02T09:00:00.000Z');
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
    expect(computeLastContactAt([])).toBeNull();
    expect(computeLastCustomerEngagementAt([])).toBeNull();
  });

  it('8) apenas eventos internal: last_contact_at e last_customer_engagement_at ficam null (last_activity_at não)', () => {
    const interactions = [
      { occurredAt: '2026-10-01T09:00:00.000Z', metadata: { activity_class: 'internal' } },
      { occurredAt: '2026-10-02T09:00:00.000Z', metadata: { activity_class: 'internal' } },
    ];
    expect(computeLastContactAt(interactions)).toBeNull();
    expect(computeLastCustomerEngagementAt(interactions)).toBeNull();
    expect(computeLastActivityAt(interactions)).toBe('2026-10-02T09:00:00.000Z');
  });

  it('9) WhatsApp enviado (attempt) e depois cliente responde (engagement): os dois relógios de contato avançam juntos, conforme o exemplo aprovado', () => {
    const interactions = [
      { occurredAt: '2026-10-10T09:00:00.000Z', metadata: { activity_class: 'attempt' } },
      { occurredAt: '2026-10-10T11:00:00.000Z', metadata: { activity_class: 'engagement' } },
    ];
    expect(computeLastContactAt(interactions)).toBe('2026-10-10T11:00:00.000Z');
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
