import { describe, expect, it } from 'vitest';
import {
  formatFollowUpReason, formatFollowUpTimeLabel, formatSuggestedAction,
  getOperationalBlockers, formatOperationalBlocker, hasMissingPhoneWarning,
  shouldShowAttemptCount, formatAttemptCount,
} from './followUpPresentation.js';
import { FOLLOW_UP_STATUS, FOLLOW_UP_REASON } from './followUpEngine.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
function hoursFromNow(h) { return new Date(NOW.getTime() + h * 3600000).toISOString(); }

function makeEvaluation(overrides = {}) {
  return {
    status: FOLLOW_UP_STATUS.DUE,
    eligible: true,
    reason: FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT,
    since: null,
    dueAt: hoursFromNow(-3),
    anchorInteractionId: null,
    anchorOccurredAt: null,
    suggestedAction: null,
    attemptCount: 1,
    blockers: [],
    dedupeKey: 'lead-1:no_response_after_attempt:anchor',
    ...overrides,
  };
}

describe('Fase 2C.2B — formatFollowUpReason', () => {
  const cases = [
    [FOLLOW_UP_REASON.NEVER_CONTACTED, 'Nunca contatado', 'Lead cadastrado, ainda sem nenhuma tentativa de contato.'],
    [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT, 'Sem resposta após tentativa', 'Você tentou contato e ainda não teve retorno do cliente.'],
    [FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL, 'Sem resposta após proposta', 'A proposta foi enviada e o cliente ainda não respondeu.'],
    [FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT, 'Sem novo contato desde a resposta', 'O cliente respondeu, mas ainda não houve uma nova tentativa sua.'],
    [FOLLOW_UP_REASON.CADENCE_EXHAUSTED, 'Cadência esgotada', 'Todas as tentativas previstas já foram feitas. Aguardando janela de reativação.'],
    [FOLLOW_UP_REASON.REACTIVATION_DUE, 'Pronto para reativar', 'Passou o tempo de espera — é hora de tentar reativar o contato.'],
  ];

  cases.forEach(([reason, label, subtitle]) => {
    it(`${reason} -> "${label}"`, () => {
      const result = formatFollowUpReason(makeEvaluation({ reason }));
      expect(result).toEqual({ label, subtitle });
    });
  });

  it('blocked (reason null) -> null', () => {
    expect(formatFollowUpReason(makeEvaluation({ status: FOLLOW_UP_STATUS.BLOCKED, reason: null }))).toBeNull();
  });
});

describe('Fase 2C.2B — formatFollowUpTimeLabel', () => {
  it('due genérico: "Vencido ..." ', () => {
    const ev = makeEvaluation({ status: FOLLOW_UP_STATUS.DUE, reason: FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT, dueAt: hoursFromNow(-3) });
    expect(formatFollowUpTimeLabel(ev, NOW)).toBe('Vencido há 3 h');
  });

  it('waiting genérico: "Vence ..."', () => {
    const ev = makeEvaluation({ status: FOLLOW_UP_STATUS.WAITING, reason: FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT, dueAt: hoursFromNow(6) });
    expect(formatFollowUpTimeLabel(ev, NOW)).toBe('Vence em 6 h');
  });

  it('waiting cadence_exhausted: "Reativação ..."', () => {
    const ev = makeEvaluation({ status: FOLLOW_UP_STATUS.WAITING, reason: FOLLOW_UP_REASON.CADENCE_EXHAUSTED, dueAt: hoursFromNow(96) });
    expect(formatFollowUpTimeLabel(ev, NOW)).toBe('Reativação em 4 dias');
  });

  it('due reactivation_due: "Reativação disponível" (sem framing de "Vencido")', () => {
    const ev = makeEvaluation({ status: FOLLOW_UP_STATUS.DUE, reason: FOLLOW_UP_REASON.REACTIVATION_DUE, dueAt: hoursFromNow(-200) });
    expect(formatFollowUpTimeLabel(ev, NOW)).toBe('Reativação disponível');
  });

  it('blocked: nunca inventa prazo (null)', () => {
    const ev = makeEvaluation({ status: FOLLOW_UP_STATUS.BLOCKED, reason: null, dueAt: null });
    expect(formatFollowUpTimeLabel(ev, NOW)).toBeNull();
  });

  it('dueAt null (never_contacted sem createdAt), status due: null (não há relógio para mostrar)', () => {
    const ev = makeEvaluation({ status: FOLLOW_UP_STATUS.DUE, reason: FOLLOW_UP_REASON.NEVER_CONTACTED, dueAt: null });
    expect(formatFollowUpTimeLabel(ev, NOW)).toBeNull();
  });
});

describe('Fase 2C.2B — formatSuggestedAction', () => {
  it('call -> Ligação', () => {
    expect(formatSuggestedAction(makeEvaluation({ suggestedAction: { type: 'call', channel: 'phone' } }))).toBe('Ligação');
  });
  it('whatsapp -> WhatsApp', () => {
    expect(formatSuggestedAction(makeEvaluation({ suggestedAction: { type: 'whatsapp', channel: 'whatsapp' } }))).toBe('WhatsApp');
  });
  it('meeting -> Reunião', () => {
    expect(formatSuggestedAction(makeEvaluation({ suggestedAction: { type: 'meeting', channel: 'in_person' } }))).toBe('Reunião');
  });
  it('proposal -> Proposta', () => {
    expect(formatSuggestedAction(makeEvaluation({ suggestedAction: { type: 'proposal', channel: 'manual' } }))).toBe('Proposta');
  });
  it('null -> null (nenhuma linha mostrada)', () => {
    expect(formatSuggestedAction(makeEvaluation({ suggestedAction: null }))).toBeNull();
  });
});

describe('Fase 2C.2B — getOperationalBlockers / formatOperationalBlocker', () => {
  it('mantém só os 3 blockers operacionais, descarta estruturais e sem_telefone', () => {
    const ev = makeEvaluation({ blockers: ['etapa_ganho', 'proximo_contato_agendado', 'sem_telefone', 'deleted'] });
    expect(getOperationalBlockers(ev)).toEqual(['proximo_contato_agendado']);
  });

  it('múltiplos blockers operacionais simultâneos: todos preservados', () => {
    const ev = makeEvaluation({ blockers: ['lead_agenda_pendente', 'follow_up_automatico_pendente'] });
    expect(getOperationalBlockers(ev)).toEqual(['lead_agenda_pendente', 'follow_up_automatico_pendente']);
  });

  it('só blocker estrutural: lista vazia (lead some da aba Bloqueados)', () => {
    const ev = makeEvaluation({ blockers: ['etapa_ganho'] });
    expect(getOperationalBlockers(ev)).toEqual([]);
  });

  it('formatOperationalBlocker mapeia os 3 códigos corretamente', () => {
    expect(formatOperationalBlocker('proximo_contato_agendado')).toBe('Já tem contato agendado');
    expect(formatOperationalBlocker('lead_agenda_pendente')).toBe('Tarefa de contato já pendente');
    expect(formatOperationalBlocker('follow_up_automatico_pendente')).toBe('Já existe um follow-up pendente');
  });

  it('formatOperationalBlocker de um código desconhecido -> null', () => {
    expect(formatOperationalBlocker('etapa_ganho')).toBeNull();
  });
});

describe('Fase 2C.2B — hasMissingPhoneWarning', () => {
  it('true quando sem_telefone está nos blockers', () => {
    expect(hasMissingPhoneWarning(makeEvaluation({ blockers: ['sem_telefone'] }))).toBe(true);
  });
  it('false quando não está', () => {
    expect(hasMissingPhoneWarning(makeEvaluation({ blockers: [] }))).toBe(false);
  });
});

describe('Fase 2C.2B — shouldShowAttemptCount', () => {
  it('true para no_response_after_attempt / cadence_exhausted / reactivation_due', () => {
    expect(shouldShowAttemptCount(makeEvaluation({ reason: FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT }))).toBe(true);
    expect(shouldShowAttemptCount(makeEvaluation({ reason: FOLLOW_UP_REASON.CADENCE_EXHAUSTED }))).toBe(true);
    expect(shouldShowAttemptCount(makeEvaluation({ reason: FOLLOW_UP_REASON.REACTIVATION_DUE }))).toBe(true);
  });

  it('false para never_contacted / no_response_after_proposal / no_new_attempt_since_engagement', () => {
    expect(shouldShowAttemptCount(makeEvaluation({ reason: FOLLOW_UP_REASON.NEVER_CONTACTED }))).toBe(false);
    expect(shouldShowAttemptCount(makeEvaluation({ reason: FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL }))).toBe(false);
    expect(shouldShowAttemptCount(makeEvaluation({ reason: FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT }))).toBe(false);
  });

  it('false quando blocked (reason null)', () => {
    expect(shouldShowAttemptCount(makeEvaluation({ status: FOLLOW_UP_STATUS.BLOCKED, reason: null }))).toBe(false);
  });
});

describe('Fase 2C.2B — formatAttemptCount', () => {
  it('usa o denominador da policy padrão (maxAttempts=3)', () => {
    expect(formatAttemptCount(makeEvaluation({ attemptCount: 2 }))).toBe('2/3 tentativas');
  });

  it('usa o denominador de uma policy customizada, nunca hardcoded', () => {
    expect(formatAttemptCount(makeEvaluation({ attemptCount: 1 }), { maxAttempts: 5 })).toBe('1/5 tentativas');
  });
});
