import { describe, expect, it } from 'vitest';
import {
  formatPhoneBR, fmtDate, moneyFormat, parseMoneyValue, leadMatchesSearch,
  isTaskOverdue, minutesUntil, upcomingAppointments, leadHasNoNextAction,
  classifyLeadPriority, isValidBackup, normalizeBackup, todayStr,
  formatRelativeTime, getStaleLeads, formatStaleDaysLabel,
} from './utils.js';

describe('formatPhoneBR', () => {
  it('formata progressivamente enquanto o usuário digita', () => {
    expect(formatPhoneBR('5')).toBe('(5');
    expect(formatPhoneBR('54')).toBe('(54');
    expect(formatPhoneBR('549')).toBe('(54) 9');
    expect(formatPhoneBR('54999887766')).toBe('(54) 9 9988-7766');
  });

  it('ignora caracteres não numéricos e limita a 11 dígitos', () => {
    expect(formatPhoneBR('(54) 9 9988-7766 extra')).toBe('(54) 9 9988-7766');
  });

  it('retorna vazio para entrada vazia', () => {
    expect(formatPhoneBR('')).toBe('');
    expect(formatPhoneBR(null)).toBe('');
  });
});

describe('fmtDate', () => {
  it('formata data ISO para dd/mm', () => {
    expect(fmtDate('2026-09-14')).toBe('14/09');
  });
  it('retorna travessão para data vazia', () => {
    expect(fmtDate('')).toBe('—');
    expect(fmtDate(null)).toBe('—');
  });
});

describe('moneyFormat / parseMoneyValue', () => {
  it('formata dígitos em moeda pt-BR', () => {
    expect(moneyFormat('300000')).toBe('300.000,00');
  });
  it('parseMoneyValue extrai o valor inteiro a partir do texto formatado', () => {
    expect(parseMoneyValue('300.000,00')).toBe(300000);
  });
  it('lida com string vazia', () => {
    expect(moneyFormat('')).toBe('');
    expect(parseMoneyValue('')).toBe('');
  });
});

describe('leadMatchesSearch', () => {
  const lead = { nome: 'José Mauricio', telefone: '(51) 9 9616-1228' };
  it('casa por nome ignorando acento e caixa', () => {
    expect(leadMatchesSearch(lead, 'jose mauricio')).toBe(true);
    expect(leadMatchesSearch(lead, 'MAURICIO')).toBe(true);
  });
  it('casa por telefone ignorando máscara', () => {
    expect(leadMatchesSearch(lead, '96161228')).toBe(true);
    expect(leadMatchesSearch(lead, '(51) 9 9616-1228')).toBe(true);
  });
  it('não casa com termo não relacionado', () => {
    expect(leadMatchesSearch(lead, 'xyz')).toBe(false);
  });
  it('busca vazia casa com tudo', () => {
    expect(leadMatchesSearch(lead, '')).toBe(true);
  });
});

describe('isTaskOverdue', () => {
  it('tarefa concluída nunca está atrasada', () => {
    expect(isTaskOverdue({ concluida: true, data: '2020-01-01' })).toBe(false);
  });
  it('tarefa sem data nunca está atrasada', () => {
    expect(isTaskOverdue({ concluida: false, data: null })).toBe(false);
  });
  it('tarefa com data passada está atrasada', () => {
    expect(isTaskOverdue({ concluida: false, data: '2020-01-01' })).toBe(true);
  });
  it('tarefa de hoje sem horário não está atrasada', () => {
    expect(isTaskOverdue({ concluida: false, data: todayStr() })).toBe(false);
  });
});

describe('minutesUntil / upcomingAppointments', () => {
  it('retorna null sem data ou horário', () => {
    expect(minutesUntil(null, '10:00')).toBeNull();
    expect(minutesUntil('2026-01-01', null)).toBeNull();
  });

  it('filtra só tarefas de Agenda/Ligação de hoje dentro da janela', () => {
    const today = todayStr();
    function hmPlus(mins) {
      const d = new Date(Date.now() + mins * 60000);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    const tasks = [
      { id: '1', categoria: 'Agenda/Ligação', concluida: false, data: today, horario: hmPlus(15) },
      { id: '2', categoria: 'Agenda/Ligação', concluida: false, data: today, horario: hmPlus(45) },
      { id: '3', categoria: 'Follow-up', concluida: false, data: today, horario: hmPlus(5) },
      { id: '4', categoria: 'Agenda/Ligação', concluida: true, data: today, horario: hmPlus(5) },
    ];
    const result = upcomingAppointments(tasks, 30);
    expect(result.map((r) => r.task.id)).toEqual(['1']);
  });
});

describe('leadHasNoNextAction / classifyLeadPriority (V2)', () => {
  const base = { etapa: 'Qualificação', proximoContato: '', leadTemperature: '', priority: 'normal', ultimaAtualizacao: todayStr(), criadoEm: todayStr() };

  it('lead ativo sem próximo contato não tem próxima ação', () => {
    expect(leadHasNoNextAction(base)).toBe(true);
  });

  it('lead ativo com próximo contato tem próxima ação', () => {
    expect(leadHasNoNextAction({ ...base, proximoContato: '2099-01-01' })).toBe(false);
  });

  it('lead Ganho/Perdido nunca conta como sem próxima ação', () => {
    expect(leadHasNoNextAction({ ...base, etapa: 'Ganho' })).toBe(false);
    expect(leadHasNoNextAction({ ...base, etapa: 'Perdido' })).toBe(false);
  });

  it('classifyLeadPriority marca SEM PRÓXIMA AÇÃO e não marca ATRASADO/HOJE', () => {
    const tags = classifyLeadPriority(base);
    expect(tags).toContain('SEM PRÓXIMA AÇÃO');
    expect(tags).not.toContain('ATRASADO');
    expect(tags).not.toContain('HOJE');
  });

  it('classifyLeadPriority marca ATRASADO para contato vencido', () => {
    const tags = classifyLeadPriority({ ...base, proximoContato: '2000-01-01' });
    expect(tags).toContain('ATRASADO');
  });

  it('classifyLeadPriority marca QUENTE e URGENTE conforme os campos', () => {
    const tags = classifyLeadPriority({ ...base, proximoContato: '2099-01-01', leadTemperature: 'hot', priority: 'urgent' });
    expect(tags).toContain('QUENTE');
    expect(tags).toContain('URGENTE');
  });

  it('lead Ganho/Perdido não recebe nenhuma classificação', () => {
    expect(classifyLeadPriority({ ...base, etapa: 'Ganho' })).toEqual([]);
  });
});

// Etapa A — alertas de leads sem movimentação. getStaleLeads/
// formatStaleDaysLabel nunca reimplementam o limiar — toda asserção
// aqui existe para provar que a DELEGAÇÃO para classifyLeadPriority/
// STALE_DAYS está correta, nunca para testar um cálculo próprio novo.
describe('getStaleLeads / formatStaleDaysLabel (Etapa A)', () => {
  function daysAgoStr(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  const activeBase = { id: 'l1', nome: 'Ana', etapa: 'Qualificação', proximoContato: '', leadTemperature: '', priority: 'normal' };

  it('lead ativo com última atualização >= STALE_DAYS (15) conta como parado', () => {
    const lead = { ...activeBase, ultimaAtualizacao: daysAgoStr(15) };
    expect(getStaleLeads([lead])).toEqual([lead]);
  });

  it('lead ativo com última atualização < STALE_DAYS (14) NÃO conta como parado', () => {
    const lead = { ...activeBase, ultimaAtualizacao: daysAgoStr(14) };
    expect(getStaleLeads([lead])).toEqual([]);
  });

  it('usa criadoEm quando ultimaAtualizacao está vazio (mesmo fallback de classifyLeadPriority)', () => {
    const lead = { ...activeBase, ultimaAtualizacao: '', criadoEm: daysAgoStr(20) };
    expect(getStaleLeads([lead])).toEqual([lead]);
  });

  it('lead Ganho/Perdido NUNCA é considerado parado, mesmo há muito tempo sem atualização', () => {
    const ganho = { ...activeBase, id: 'l2', etapa: 'Ganho', ultimaAtualizacao: daysAgoStr(400) };
    const perdido = { ...activeBase, id: 'l3', etapa: 'Perdido', ultimaAtualizacao: daysAgoStr(400) };
    expect(getStaleLeads([ganho, perdido])).toEqual([]);
  });

  it('lead sem nenhuma data-base (ultimaAtualizacao e criadoEm ausentes) nunca conta como parado', () => {
    const lead = { ...activeBase, ultimaAtualizacao: '', criadoEm: '' };
    expect(getStaleLeads([lead])).toEqual([]);
  });

  it('mistura de leads: só os realmente parados são devolvidos, preservando os dados originais (nunca muta)', () => {
    const stale = { ...activeBase, id: 'stale-1', ultimaAtualizacao: daysAgoStr(30) };
    const fresh = { ...activeBase, id: 'fresh-1', ultimaAtualizacao: daysAgoStr(1) };
    const result = getStaleLeads([stale, fresh]);
    expect(result).toEqual([stale]);
    expect(fresh).toEqual({ ...activeBase, id: 'fresh-1', ultimaAtualizacao: daysAgoStr(1) });
  });

  it('lista vazia/nula/indefinida -> array vazio, nunca lança', () => {
    expect(getStaleLeads([])).toEqual([]);
    expect(getStaleLeads(null)).toEqual([]);
    expect(getStaleLeads(undefined)).toEqual([]);
  });

  it('entrada com item nulo/indefinido na lista -> ignorado, nunca lança', () => {
    const lead = { ...activeBase, ultimaAtualizacao: daysAgoStr(20) };
    expect(getStaleLeads([null, lead, undefined])).toEqual([lead]);
  });

  it('formatStaleDaysLabel devolve "Sem atualização de cadastro há Nd" (correção pós-revisão do PR #73 — a fonte é ultimaAtualizacao, nunca o histórico de contato comercial)', () => {
    const lead = { ...activeBase, ultimaAtualizacao: daysAgoStr(20) };
    expect(formatStaleDaysLabel(lead)).toBe('Sem atualização de cadastro há 20d');
  });

  it('formatStaleDaysLabel devolve null quando não há nenhuma data-base, nunca lança', () => {
    expect(formatStaleDaysLabel({ ...activeBase, ultimaAtualizacao: '', criadoEm: '' })).toBeNull();
  });
});

describe('isValidBackup / normalizeBackup (compatibilidade V1/V2)', () => {
  it('rejeita backup sem leads/tasks como array', () => {
    expect(isValidBackup(null)).toBe(false);
    expect(isValidBackup({})).toBe(false);
    expect(isValidBackup({ leads: [], tasks: 'x' })).toBe(false);
  });

  it('aceita backup v1 (sem backupVersion/interactions)', () => {
    const v1 = { leads: [{ id: '1' }], tasks: [{ id: 't1' }], templates: [] };
    expect(isValidBackup(v1)).toBe(true);
    const normalized = normalizeBackup(v1);
    expect(normalized.backupVersion).toBe(1);
    expect(normalized.interactions).toEqual([]);
    expect(normalized.leads).toHaveLength(1);
  });

  it('aceita backup v2 (com backupVersion e interactions)', () => {
    const v2 = {
      backupVersion: 2, leads: [{ id: '1' }], tasks: [], templates: [],
      interactions: [{ id: 'i1', leadId: '1' }],
    };
    const normalized = normalizeBackup(v2);
    expect(normalized.backupVersion).toBe(2);
    expect(normalized.interactions).toHaveLength(1);
  });
});

describe('formatRelativeTime (Fase 2B — relógios de atividade)', () => {
  const NOW = new Date('2026-10-10T12:00:00.000Z');

  it('null -> "—"', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—');
    expect(formatRelativeTime('', NOW)).toBe('—');
  });

  it('menos de 1 minuto -> "agora"', () => {
    expect(formatRelativeTime('2026-10-10T11:59:40.000Z', NOW)).toBe('agora');
  });

  it('minutos', () => {
    expect(formatRelativeTime('2026-10-10T11:52:00.000Z', NOW)).toBe('há 8 min.');
  });

  it('horas', () => {
    expect(formatRelativeTime('2026-10-10T09:00:00.000Z', NOW)).toBe('há 3 h');
  });

  it('ontem', () => {
    expect(formatRelativeTime('2026-10-09T12:00:00.000Z', NOW)).toBe('ontem');
  });

  it('dias', () => {
    expect(formatRelativeTime('2026-10-06T12:00:00.000Z', NOW)).toBe('há 4 dias');
  });

  it('meses', () => {
    expect(formatRelativeTime('2026-08-10T12:00:00.000Z', NOW)).toBe('há 2 meses');
  });

  it('usa o `now` injetado, não Date.now() real', () => {
    const past = new Date(NOW.getTime() - 5 * 60000).toISOString();
    expect(formatRelativeTime(past, NOW)).toBe('há 5 min.');
    expect(formatRelativeTime(past, new Date(NOW.getTime() + 60 * 60000))).not.toBe('há 5 min.');
  });
});
