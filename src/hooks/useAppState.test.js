import { describe, expect, it } from 'vitest';
import {
  pendingAutoTasksForLeads, autoTaskHorarioUpdates, pendingRotinaTasks,
  computeLeadAgendaTaskData, reconcileLeadAgendaActions,
  computeStageTimestamps, computeStageChangeInteraction,
} from './useAppState.js';
import { todayStr } from '../utils.js';
import { DIAS_SEMANA } from '../constants.js';

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
