import { describe, expect, it } from 'vitest';
import {
  formatPhoneBR, fmtDate, moneyFormat, parseMoneyValue, leadMatchesSearch,
  isTaskOverdue, minutesUntil, upcomingAppointments, leadHasNoNextAction,
  classifyLeadPriority, isValidBackup, normalizeBackup, todayStr,
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
