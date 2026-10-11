import { describe, expect, test } from 'vitest';
// Correção pós-revisão do PR #76 (achado 4) — fixa o fuso do PROCESSO
// de teste para o Brasil (UTC-3), ANTES de qualquer import/uso de
// Date neste arquivo, para reproduzir deterministicamente o cenário
// real da operação (navegador em horário local brasileiro) — nunca
// depender do TZ do ambiente de CI (que pode ser UTC).
process.env.TZ = 'America/Sao_Paulo';
import {
  AUTO_STAGE_TASK_ORIGEM,
  AUTO_STAGE_TASK_RULES,
  shouldGenerateAutoStageTask,
  computeAutoStageTaskData,
  hasPendingAutoStageTask,
  buildAutoStageTaskAction,
} from './autoStageTasks.js';

const NOW = new Date('2026-10-12T09:00:00.000Z');

function makeLead(overrides = {}) {
  return {
    id: 'lead-1',
    nome: 'Lilliane',
    etapa: 'Proposta',
    deletedAt: null,
    ...overrides,
  };
}

describe('shouldGenerateAutoStageTask — requisito 3 (só mudança efetiva de etapa)', () => {
  test('etapa realmente mudou -> true', () => {
    expect(shouldGenerateAutoStageTask({ prevEtapa: 'Qualificação', newEtapa: 'Proposta' })).toBe(true);
  });

  test('mesma etapa (re-render/salvar cadastro sem mudar etapa) -> false', () => {
    expect(shouldGenerateAutoStageTask({ prevEtapa: 'Proposta', newEtapa: 'Proposta' })).toBe(false);
  });

  test('lead recém-criado (sem prevEtapa) -> false, mesmo já nascendo numa etapa configurada', () => {
    expect(shouldGenerateAutoStageTask({ prevEtapa: undefined, newEtapa: 'Proposta' })).toBe(false);
    expect(shouldGenerateAutoStageTask({ prevEtapa: null, newEtapa: 'Proposta' })).toBe(false);
  });
});

describe('computeAutoStageTaskData — requisitos 2/5/9', () => {
  test.each(Object.keys(AUTO_STAGE_TASK_RULES))('etapa configurada "%s" -> gera tarefa com origem auto_stage e etapaGatilho correta', (etapa) => {
    const lead = makeLead({ etapa });
    const task = computeAutoStageTaskData(lead, NOW);
    expect(task).not.toBeNull();
    expect(task.origem).toBe(AUTO_STAGE_TASK_ORIGEM);
    expect(task.etapaGatilho).toBe(etapa);
    expect(task.leadId).toBe('lead-1');
    expect(task.concluida).toBe(false);
    expect(task.titulo).toContain('Lilliane');
    expect(task.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('prazo é relativo a `now`, nunca hardcoded', () => {
    const task = computeAutoStageTaskData(makeLead({ etapa: 'Qualificação' }), NOW);
    expect(task.data).toBe('2026-10-13'); // diasPrazo: 1
    const taskNegociacao = computeAutoStageTaskData(makeLead({ etapa: 'Negociação' }), NOW);
    expect(taskNegociacao.data).toBe('2026-10-14'); // diasPrazo: 2
  });

  // Correção pós-revisão do PR #76 (achado 4) — prova que o prazo usa
  // o DIA CIVIL LOCAL (America/Sao_Paulo, fixado no topo do arquivo),
  // nunca o dia em UTC. `now` = 23:30 local de 12/10 é 02:30 UTC de
  // 13/10 — a versão anterior (soma de ms + toISOString em UTC)
  // devolveria "2026-10-14" (um dia alem do esperado) para diasPrazo=1;
  // a versão corrigida devolve "2026-10-13" (hoje local + 1 dia civil).
  test('mudança de etapa perto da meia-noite local -> prazo calculado pelo dia civil local, nunca pelo dia UTC', () => {
    const lateNightLocal = new Date('2026-10-13T02:30:00.000Z'); // 23:30 de 12/10 em America/Sao_Paulo (UTC-3)
    const task = computeAutoStageTaskData(makeLead({ etapa: 'Qualificação' }), lateNightLocal); // diasPrazo: 1
    expect(task.data).toBe('2026-10-13');
  });

  test('prazo de 2 dias atravessando virada de mês continua correto (overflow de calendário tratado pelo próprio Date)', () => {
    const endOfMonthLocal = new Date('2026-10-31T15:00:00.000Z'); // 12:00 local
    const task = computeAutoStageTaskData(makeLead({ etapa: 'Negociação' }), endOfMonthLocal); // diasPrazo: 2
    expect(task.data).toBe('2026-11-02');
  });

  test.each(['Novo Lead', 'Ligação', 'Atendimento', 'Follow-up 2', 'Follow-up 3'])('etapa sem modelo "%s" -> null, nunca gera tarefa genérica', (etapa) => {
    expect(computeAutoStageTaskData(makeLead({ etapa }), NOW)).toBeNull();
  });

  test.each(['Ganho', 'Perdido'])('etapa terminal "%s" -> null (requisito 9, nunca tarefa para lead encerrado)', (etapa) => {
    expect(computeAutoStageTaskData(makeLead({ etapa }), NOW)).toBeNull();
  });

  test('lead arquivado/excluído (deletedAt) -> null, mesmo numa etapa configurada (requisito 9)', () => {
    expect(computeAutoStageTaskData(makeLead({ etapa: 'Proposta', deletedAt: '2026-10-01T00:00:00.000Z' }), NOW)).toBeNull();
  });

  test('lead ausente/sem etapa -> null, nunca lança', () => {
    expect(computeAutoStageTaskData(null, NOW)).toBeNull();
    expect(computeAutoStageTaskData(makeLead({ etapa: '' }), NOW)).toBeNull();
  });
});

describe('hasPendingAutoStageTask — requisito 6 (1ª linha de defesa contra duplicação)', () => {
  test('já existe uma tarefa auto_stage pendente para o mesmo lead+etapa -> true', () => {
    const tasks = [{ leadId: 'lead-1', origem: AUTO_STAGE_TASK_ORIGEM, etapaGatilho: 'Proposta', concluida: false }];
    expect(hasPendingAutoStageTask(tasks, 'lead-1', 'Proposta')).toBe(true);
  });

  test('a mesma tarefa já CONCLUÍDA não bloqueia uma nova (requisito 8, novo ciclo pela etapa)', () => {
    const tasks = [{ leadId: 'lead-1', origem: AUTO_STAGE_TASK_ORIGEM, etapaGatilho: 'Proposta', concluida: true }];
    expect(hasPendingAutoStageTask(tasks, 'lead-1', 'Proposta')).toBe(false);
  });

  test('tarefa de outro lead não interfere', () => {
    const tasks = [{ leadId: 'lead-2', origem: AUTO_STAGE_TASK_ORIGEM, etapaGatilho: 'Proposta', concluida: false }];
    expect(hasPendingAutoStageTask(tasks, 'lead-1', 'Proposta')).toBe(false);
  });

  test('tarefa do mesmo lead mas de outra etapa não interfere', () => {
    const tasks = [{ leadId: 'lead-1', origem: AUTO_STAGE_TASK_ORIGEM, etapaGatilho: 'Negociação', concluida: false }];
    expect(hasPendingAutoStageTask(tasks, 'lead-1', 'Proposta')).toBe(false);
  });

  test('tarefa manual/lead-agenda/rotina/auto do mesmo lead nunca conta como auto_stage (origem distinta)', () => {
    const tasks = [
      { leadId: 'lead-1', origem: 'manual', etapaGatilho: 'Proposta', concluida: false },
      { leadId: 'lead-1', origem: 'lead-agenda', etapaGatilho: 'Proposta', concluida: false },
      { leadId: 'lead-1', origem: 'auto', etapaGatilho: 'Proposta', concluida: false },
      { leadId: 'lead-1', origem: 'rotina', etapaGatilho: 'Proposta', concluida: false },
    ];
    expect(hasPendingAutoStageTask(tasks, 'lead-1', 'Proposta')).toBe(false);
  });

  // 'automation' é um blocker RESERVADO já existente em
  // followUpEngine.js (hasPendingTaskWithOrigem(leadTasks, lead.id,
  // 'automation')), nunca usado por esta Etapa D — a string é
  // deliberadamente diferente de 'auto_stage' para os dois conceitos
  // nunca se confundirem.
  test('origem reservada "automation" (followUpEngine.js) nunca é confundida com auto_stage', () => {
    const tasks = [{ leadId: 'lead-1', origem: 'automation', etapaGatilho: 'Proposta', concluida: false }];
    expect(hasPendingAutoStageTask(tasks, 'lead-1', 'Proposta')).toBe(false);
    expect(AUTO_STAGE_TASK_ORIGEM).not.toBe('automation');
  });
});

describe('buildAutoStageTaskAction — composição completa (requisitos 3/5/6/7/8/9)', () => {
  test('transição real para etapa configurada, sem duplicata pendente -> devolve os dados da tarefa', () => {
    const action = buildAutoStageTaskAction({ prevEtapa: 'Qualificação', updatedLead: makeLead({ etapa: 'Proposta' }), tasks: [], now: NOW });
    expect(action).not.toBeNull();
    expect(action.etapaGatilho).toBe('Proposta');
  });

  test('sem transição real (mesma etapa) -> null', () => {
    const action = buildAutoStageTaskAction({ prevEtapa: 'Proposta', updatedLead: makeLead({ etapa: 'Proposta' }), tasks: [], now: NOW });
    expect(action).toBeNull();
  });

  test('transição para etapa sem modelo -> null', () => {
    const action = buildAutoStageTaskAction({ prevEtapa: 'Proposta', updatedLead: makeLead({ etapa: 'Novo Lead' }), tasks: [], now: NOW });
    expect(action).toBeNull();
  });

  test('transição para etapa terminal (Ganho/Perdido) -> null, mesmo sendo uma mudança real de etapa', () => {
    const action = buildAutoStageTaskAction({ prevEtapa: 'Negociação', updatedLead: makeLead({ etapa: 'Ganho' }), tasks: [], now: NOW });
    expect(action).toBeNull();
  });

  test('já existe tarefa pendente para o mesmo lead+etapa -> null (nunca duplica)', () => {
    const tasks = [{ leadId: 'lead-1', origem: AUTO_STAGE_TASK_ORIGEM, etapaGatilho: 'Proposta', concluida: false }];
    const action = buildAutoStageTaskAction({ prevEtapa: 'Qualificação', updatedLead: makeLead({ etapa: 'Proposta' }), tasks, now: NOW });
    expect(action).toBeNull();
  });

  test('tarefa anterior da mesma etapa já concluída -> permite gerar uma nova (novo ciclo, requisito 8)', () => {
    const tasks = [{ leadId: 'lead-1', origem: AUTO_STAGE_TASK_ORIGEM, etapaGatilho: 'Proposta', concluida: true }];
    const action = buildAutoStageTaskAction({ prevEtapa: 'Qualificação', updatedLead: makeLead({ etapa: 'Proposta' }), tasks, now: NOW });
    expect(action).not.toBeNull();
  });

  test('lead arquivado/excluído -> null mesmo com transição real para etapa configurada', () => {
    const action = buildAutoStageTaskAction({
      prevEtapa: 'Qualificação',
      updatedLead: makeLead({ etapa: 'Proposta', deletedAt: '2026-10-01T00:00:00.000Z' }),
      tasks: [],
      now: NOW,
    });
    expect(action).toBeNull();
  });
});
