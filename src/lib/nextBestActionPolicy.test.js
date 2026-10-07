import { describe, it, expect } from 'vitest';
import { evaluateNextBestActionPolicy } from './nextBestActionPolicy.js';
import { buildCommercialInteractionHistory } from './commercialInteractionHistory.js';

// Fase 2E.4.2 — testes da policy comercial pura. Mesma convenção já
// estabelecida no projeto (2E.1/2E.4.1): determinismo/pureza provados
// comportamentalmente, nunca por checagem estática de texto-fonte.

function makeLead(overrides = {}) {
  return {
    id: 'lead-1',
    nome: 'Lead Teste',
    telefone: '51999999999',
    etapa: 'Novo Lead',
    produto: 'Consórcio',
    tipo: '',
    leadTemperature: '',
    priority: 'normal',
    nextActionType: '',
    nextActionNote: '',
    ...overrides,
  };
}

function makeEvaluation(overrides = {}) {
  return {
    status: 'due',
    eligible: true,
    reason: 'never_contacted',
    since: null,
    dueAt: null,
    anchorInteractionId: null,
    anchorOccurredAt: null,
    suggestedAction: null,
    attemptCount: 0,
    blockers: [],
    dedupeKey: 'lead-1:never_contacted:none',
    ...overrides,
  };
}

// history duck-typed direto (contrato da 2E.4.1), sem depender de
// buildCommercialInteractionHistory na maioria dos testes — isola o
// teste da policy do teste da camada de histórico. Alguns testes
// específicos (integração/paridade/Proposal Leak) usam o builder real.
function makeHistory(overrides = {}) {
  return {
    attempts: [],
    engagements: [],
    proposals: [],
    meetings: [],
    lastAttempt: null,
    previousAttempt: null,
    lastEngagement: null,
    lastProposal: null,
    lastMeeting: null,
    attemptCount: 0,
    attemptCountByChannel: { phone: 0, whatsapp: 0, in_person: 0 },
    lastAttemptChannel: null,
    previousAttemptChannel: null,
    lastEngagementChannel: null,
    ...overrides,
  };
}

let seq = 0;
function makeInteraction(overrides = {}) {
  seq += 1;
  return { id: `it-${seq}`, leadId: 'lead-1', type: 'call', direction: 'outbound', channel: 'phone', content: '', metadata: { activity_class: 'attempt', source: 'user' }, occurredAt: '2026-01-10T10:00:00.000Z', createdAt: '2026-01-10T10:00:00.000Z', createdBy: 'user-1', ...overrides };
}
function callNoAnswer(occurredAt) { return makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt }); }
function callConnected(occurredAt) { return makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', metadata: { activity_class: 'engagement', outcome: 'connected' }, occurredAt }); }
function whatsappSent(occurredAt) { return makeInteraction({ type: 'whatsapp', direction: 'outbound', channel: 'whatsapp', metadata: { activity_class: 'attempt' }, occurredAt }); }
function whatsappReceived(occurredAt) { return makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt }); }
function meetingHeld(occurredAt) { return makeInteraction({ type: 'meeting', direction: 'outbound', channel: 'in_person', metadata: { activity_class: 'engagement', outcome: 'held' }, occurredAt }); }
function proposalSent(occurredAt) { return makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt }); }

describe('Fase 2E.4.2 — gates estruturais', () => {
  it('A) blocked -> null, sem exceções', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ status: 'blocked', reason: null }), history: makeHistory() });
    expect(r).toBeNull();
  });

  it('A.1) blocked com nextActionType explícito ainda assim -> null (blocked vence tudo)', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionType: 'call' }), followUpEvaluation: makeEvaluation({ status: 'blocked', reason: null }), history: makeHistory() });
    expect(r).toBeNull();
  });

  it('B) evaluation ausente (undefined) -> null', () => {
    expect(evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: undefined, history: makeHistory() })).toBeNull();
  });

  it('B.1) evaluation null -> null', () => {
    expect(evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: null, history: makeHistory() })).toBeNull();
  });

  it('B.2) evaluation malformada (string solta) -> null, sem lançar', () => {
    expect(() => evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: 'not an object', history: makeHistory() })).not.toThrow();
    expect(evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: 'not an object', history: makeHistory() })).toBeNull();
  });

  it('C) unknown reason -> null', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'algo_inventado' }), history: makeHistory() });
    expect(r).toBeNull();
  });

  it('C.1) reason ausente (null) com status due -> null', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: null }), history: makeHistory() });
    expect(r).toBeNull();
  });

  it('C.2) status desconhecido -> null (prefere null, mesma política de reason desconhecido)', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ status: 'esperando_ai' }), history: makeHistory() });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — never_contacted', () => {
  it('D) never_contacted sem intenção explícita -> call/phone, rule', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
  });

  it('E) never_contacted + explicit whatsapp -> whatsapp/whatsapp, explicit', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionType: 'whatsapp' }), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit' });
  });

  it('F) never_contacted + explicit meeting -> meeting/in_person, explicit', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionType: 'meeting' }), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(r).toEqual({ type: 'meeting', channel: 'in_person', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit' });
  });

  it('G) never_contacted + explicit proposal -> proposal/manual, explicit', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionType: 'proposal' }), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(r).toEqual({ type: 'proposal', channel: 'manual', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit' });
  });

  it('H) never_contacted + nextActionType=follow_up -> null (suprime, não cai no default call)', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionType: 'follow_up' }), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(r).toBeNull();
  });

  it('I) never_contacted + nextActionType=other -> null', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionType: 'other' }), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — no_response_after_attempt', () => {
  it('J) attemptCount<=1, lastAttemptChannel=phone -> repete: call/phone, intent retry', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('K) attemptCount<=1, lastAttemptChannel=whatsapp -> repete: whatsapp/whatsapp', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }),
      history: makeHistory({ lastAttemptChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('J.1) attemptCount=0 também conta como "<=1" (repete)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 0 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r.channel).toBe('phone');
    expect(r.intent).toBe('retry');
  });

  it('L) attemptCount>=2, lastAttemptChannel=phone -> alterna: whatsapp/whatsapp, intent switch_channel', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 2 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'switch_channel', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('M) attemptCount>=2, lastAttemptChannel=whatsapp -> alterna: call/phone', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 2 }),
      history: makeHistory({ lastAttemptChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'switch_channel', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('attemptCount malformado (não-number) -> null, nunca lança', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 'dois' }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — cadence_exhausted', () => {
  it('N) exhausted, lastAttemptChannel=phone -> whatsapp, intent switch_channel', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'cadence_exhausted', status: 'waiting', attemptCount: 3 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'switch_channel', reasonCode: 'cadence_exhausted', confidence: 'rule' });
  });

  it('O) exhausted, lastAttemptChannel=whatsapp -> call, intent switch_channel', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'cadence_exhausted', status: 'waiting', attemptCount: 3 }),
      history: makeHistory({ lastAttemptChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'switch_channel', reasonCode: 'cadence_exhausted', confidence: 'rule' });
  });

  it('exhausted sem lastAttemptChannel -> null', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'cadence_exhausted', status: 'waiting', attemptCount: 3 }),
      history: makeHistory({ lastAttemptChannel: null }),
    });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — reactivation_due', () => {
  it('P) reactivation, lastAttemptChannel=phone -> whatsapp, intent reactivate (não switch_channel)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'reactivation_due', attemptCount: 3 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'rule' });
  });

  it('Q) reactivation, lastAttemptChannel=whatsapp -> call, intent reactivate', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'reactivation_due', attemptCount: 3 }),
      history: makeHistory({ lastAttemptChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'rule' });
  });
});

describe('Fase 2E.4.2 — no_new_attempt_since_engagement', () => {
  it('R) lastEngagementChannel=whatsapp -> whatsapp, intent continue_conversation', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'continue_conversation', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
  });

  it('S) lastEngagementChannel=phone -> call, intent continue_conversation', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: 'phone' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'continue_conversation', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
  });

  it('T) lastEngagementChannel=in_person -> null (nunca recomenda reunião automática)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: 'in_person' }),
    });
    expect(r).toBeNull();
  });

  it('lastEngagementChannel ausente -> null', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: null }),
    });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — no_response_after_proposal + Proposal Leak guard', () => {
  it('U) engagement phone ANTES da proposta -> call, intent proposal_follow_up', () => {
    const anchor = '2026-01-10T12:00:00.000Z';
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: anchor }),
      history: makeHistory({ lastEngagement: { occurredAt: '2026-01-10T09:00:00.000Z' }, lastEngagementChannel: 'phone' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'rule' });
  });

  it('V) engagement whatsapp NO MOMENTO exato da proposta -> whatsapp, intent proposal_follow_up', () => {
    const anchor = '2026-01-10T12:00:00.000Z';
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: anchor }),
      history: makeHistory({ lastEngagement: { occurredAt: anchor }, lastEngagementChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'rule' });
  });

  it('W) sem nenhum engagement -> null', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: '2026-01-10T12:00:00.000Z' }),
      history: makeHistory({ lastEngagement: null }),
    });
    expect(r).toBeNull();
  });

  it('W.1) anchorOccurredAt ausente/inválido -> null ("sem anchor confiável")', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: null }),
      history: makeHistory({ lastEngagement: { occurredAt: '2026-01-10T09:00:00.000Z' }, lastEngagementChannel: 'phone' }),
    });
    expect(r).toBeNull();
  });

  it('W.2) engagement DEPOIS da proposta (inconsistência history/evaluation) -> null, nunca usado', () => {
    const anchor = '2026-01-10T12:00:00.000Z';
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: anchor }),
      history: makeHistory({ lastEngagement: { occurredAt: '2026-01-10T13:00:00.000Z' }, lastEngagementChannel: 'phone' }),
    });
    expect(r).toBeNull();
  });

  it('X) Proposal Leak adversarial — cenário real via buildCommercialInteractionHistory: 10h call_no_answer, 11h proposal_sent, SEM engagement; evaluation artificial com suggestedAction=call vazado -> policy NÃO copia, retorna null', () => {
    const c = callNoAnswer('2026-01-10T10:00:00.000Z');
    const p = proposalSent('2026-01-10T11:00:00.000Z');
    const history = buildCommercialInteractionHistory([c, p]);
    // Confirma que o vazamento realmente existe no history (não há engagement algum).
    expect(history.lastEngagement).toBeNull();

    const leakedEvaluation = makeEvaluation({
      reason: 'no_response_after_proposal',
      anchorOccurredAt: '2026-01-10T11:00:00.000Z',
      suggestedAction: { type: 'call', channel: 'phone' }, // vazamento artificial do engine
    });
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: leakedEvaluation, history });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — precedência explícita (vence TODAS as regras)', () => {
  it('Y) explicit beats alternation (attempt>=2 alternaria para whatsapp; explicit=call vence)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead({ nextActionType: 'call' }),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 2 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }), // regra escolheria whatsapp
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'explicit' });
  });

  it('Z) explicit beats engagement rule (regra escolheria whatsapp; explicit=call vence)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead({ nextActionType: 'call' }),
      followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'continue_conversation', reasonCode: 'no_new_attempt_since_engagement', confidence: 'explicit' });
  });

  it('AA) explicit beats proposal rule', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead({ nextActionType: 'whatsapp' }),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: '2026-01-10T12:00:00.000Z' }),
      history: makeHistory({ lastEngagement: null }), // regra sem explicit daria null
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'explicit' });
  });

  it('AB) explicit beats reactivation (regra escolheria whatsapp; explicit=call vence)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead({ nextActionType: 'call' }),
      followUpEvaluation: makeEvaluation({ reason: 'reactivation_due', attemptCount: 3 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'explicit' });
  });
});

describe('Fase 2E.4.2 — follow_up/other suprimem inferência em TODOS os reasons', () => {
  const REASONS = ['never_contacted', 'no_response_after_attempt', 'cadence_exhausted', 'reactivation_due', 'no_new_attempt_since_engagement', 'no_response_after_proposal'];

  it.each(REASONS)('AC) nextActionType=follow_up -> null para reason=%s, mesmo quando a regra inferiria algo', (reason) => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead({ nextActionType: 'follow_up' }),
      followUpEvaluation: makeEvaluation({ reason, attemptCount: 3, anchorOccurredAt: '2026-01-10T12:00:00.000Z' }),
      history: makeHistory({ lastAttemptChannel: 'phone', lastEngagementChannel: 'phone', lastEngagement: { occurredAt: '2026-01-10T09:00:00.000Z' } }),
    });
    expect(r).toBeNull();
  });

  it.each(REASONS)('AD) nextActionType=other -> null para reason=%s, mesmo quando a regra inferiria algo', (reason) => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead({ nextActionType: 'other' }),
      followUpEvaluation: makeEvaluation({ reason, attemptCount: 3, anchorOccurredAt: '2026-01-10T12:00:00.000Z' }),
      history: makeHistory({ lastAttemptChannel: 'phone', lastEngagementChannel: 'phone', lastEngagement: { occurredAt: '2026-01-10T09:00:00.000Z' } }),
    });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — malformed / canais inválidos', () => {
  it('AE) history malformado (string solta) -> null para reason que depende de history, nunca lança', () => {
    expect(() => evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }), history: 'not an object' })).not.toThrow();
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }), history: 'not an object' });
    expect(r).toBeNull();
  });

  it('AE.1) history null -> mesma exclusão conservadora', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'reactivation_due', attemptCount: 3 }), history: null });
    expect(r).toBeNull();
  });

  it('AE.2) history undefined, reason never_contacted -> AINDA recomenda call (não depende de history)', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: undefined });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
  });

  it('AF) lastAttemptChannel desconhecido -> null (nunca propaga canal inventado)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }),
      history: makeHistory({ lastAttemptChannel: 'carrier-pigeon' }),
    });
    expect(r).toBeNull();
  });

  it('AG) lastAttemptChannel="manual" -> null (nunca vira recomendação automática)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }),
      history: makeHistory({ lastAttemptChannel: 'manual' }),
    });
    expect(r).toBeNull();
  });

  it('AG.1) lastEngagementChannel="manual" -> null', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: 'manual' }),
    });
    expect(r).toBeNull();
  });
});

describe('Fase 2E.4.2 — waiting ainda recebe recomendação (WHAT, não WHEN)', () => {
  it('AH) status=waiting, reason=no_new_attempt_since_engagement -> recomendação igual à de due', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ status: 'waiting', reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: 'whatsapp' }),
    });
    expect(r).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'continue_conversation', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
  });

  it('AH.1) status=waiting, never_contacted (caso real: nunca deveria ocorrer no engine, mas policy não lança) -> call', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ status: 'waiting', reason: 'never_contacted' }),
      history: makeHistory(),
    });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
  });
});

describe('Fase 2E.4.2 — imutabilidade e determinismo', () => {
  it('AI) nunca muta lead', () => {
    const lead = makeLead({ nextActionType: 'call' });
    const snapshot = JSON.stringify(lead);
    evaluateNextBestActionPolicy({ lead, followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(JSON.stringify(lead)).toBe(snapshot);
  });

  it('AJ) nunca muta followUpEvaluation', () => {
    const evaluation = makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 2 });
    const snapshot = JSON.stringify(evaluation);
    evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: evaluation, history: makeHistory({ lastAttemptChannel: 'phone' }) });
    expect(JSON.stringify(evaluation)).toBe(snapshot);
  });

  it('AK) nunca muta history', () => {
    const history = makeHistory({ lastAttemptChannel: 'phone', attempts: [callNoAnswer('2026-01-10T10:00:00.000Z')] });
    const snapshot = JSON.stringify(history);
    evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }), history });
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('AL) determinismo: mesma entrada -> mesma saída em chamadas repetidas', () => {
    const lead = makeLead();
    const evaluation = makeEvaluation({ reason: 'reactivation_due', attemptCount: 3 });
    const history = makeHistory({ lastAttemptChannel: 'whatsapp' });
    const results = Array.from({ length: 5 }, () => evaluateNextBestActionPolicy({ lead, followUpEvaluation: evaluation, history }));
    results.forEach((r) => expect(r).toEqual(results[0]));
  });
});

describe('Fase 2E.4.2 — campos deliberadamente NÃO usados', () => {
  const evaluation = makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 });
  const history = makeHistory({ lastAttemptChannel: 'phone' });
  const expected = { type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' };

  it('AM) etapa não influencia (mesmo resultado em qualquer etapa)', () => {
    ['Novo Lead', 'Ligação', 'Proposta', 'Negociação', 'Follow-up 2'].forEach((etapa) => {
      expect(evaluateNextBestActionPolicy({ lead: makeLead({ etapa }), followUpEvaluation: evaluation, history })).toEqual(expected);
    });
  });

  it('AN) leadTemperature não influencia', () => {
    ['', 'cold', 'warm', 'hot'].forEach((leadTemperature) => {
      expect(evaluateNextBestActionPolicy({ lead: makeLead({ leadTemperature }), followUpEvaluation: evaluation, history })).toEqual(expected);
    });
  });

  it('AO) priority não influencia', () => {
    ['low', 'normal', 'high', 'urgent'].forEach((priority) => {
      expect(evaluateNextBestActionPolicy({ lead: makeLead({ priority }), followUpEvaluation: evaluation, history })).toEqual(expected);
    });
  });

  it('AP) produto não influencia', () => {
    ['Consórcio', 'Carta Contemplada', 'Imóvel', 'Financiamento', 'Home Equity'].forEach((produto) => {
      expect(evaluateNextBestActionPolicy({ lead: makeLead({ produto }), followUpEvaluation: evaluation, history })).toEqual(expected);
    });
  });

  it('AQ) nextActionNote nunca é interpretado (texto que "parece" um comando não muda nada)', () => {
    const withNote = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionNote: 'ligar urgente agora, não whatsapp' }), followUpEvaluation: evaluation, history });
    const withoutNote = evaluateNextBestActionPolicy({ lead: makeLead({ nextActionNote: '' }), followUpEvaluation: evaluation, history });
    expect(withNote).toEqual(expected);
    expect(withNote).toEqual(withoutNote);
  });

  it('AR) history.attemptCount NUNCA substitui followUpEvaluation.attemptCount', () => {
    // history.attemptCount=5 (bruto, muitas tentativas no total) mas
    // followUpEvaluation.attemptCount=1 (semântica temporal vigente) ->
    // deve repetir (branch "<=1"), nunca alternar.
    const richHistory = makeHistory({ lastAttemptChannel: 'phone', attemptCount: 5, attemptCountByChannel: { phone: 4, whatsapp: 1, in_person: 0 } });
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }), history: richHistory });
    expect(r).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('AS) suggestedAction do followUpEvaluation NUNCA controla a policy (varia livremente, resultado não muda)', () => {
    const base = { reason: 'no_response_after_proposal', anchorOccurredAt: '2026-01-10T12:00:00.000Z' };
    const h = makeHistory({ lastEngagement: null });
    const r1 = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ ...base, suggestedAction: null }), history: h });
    const r2 = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ ...base, suggestedAction: { type: 'call', channel: 'phone' } }), history: h });
    const r3 = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ ...base, suggestedAction: { type: 'meeting', channel: 'in_person' } }), history: h });
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
  });
});

describe('Fase 2E.4.2 — meeting/proposal nunca inferidos automaticamente', () => {
  it('AT) meeting nunca aparece com confidence=rule, em nenhum reason', () => {
    const scenarios = [
      { reason: 'never_contacted', history: makeHistory() },
      { reason: 'no_new_attempt_since_engagement', history: makeHistory({ lastEngagementChannel: 'in_person' }) },
    ];
    scenarios.forEach(({ reason, history }) => {
      const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason }), history });
      if (r) expect(r.type).not.toBe('meeting');
    });
  });

  it('AU) proposal nunca aparece com confidence=rule, em nenhum reason', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: '2026-01-10T12:00:00.000Z' }),
      history: makeHistory({ lastEngagement: { occurredAt: '2026-01-10T09:00:00.000Z' }, lastEngagementChannel: 'phone' }),
    });
    expect(r.type).not.toBe('proposal');
    expect(r.confidence).toBe('rule');
  });
});

describe('Fase 2E.4.2 — enumerações permitidas (intents/confidence)', () => {
  const ALLOWED_INTENTS = new Set(['first_contact', 'retry', 'switch_channel', 'reactivate', 'continue_conversation', 'proposal_follow_up']);
  const ALLOWED_CONFIDENCE = new Set(['explicit', 'rule']);

  it('28/29) toda saída não-nula usa só intents/confidence da lista aprovada nesta fase', () => {
    const samples = [
      evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() }),
      evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 2 }), history: makeHistory({ lastAttemptChannel: 'phone' }) }),
      evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'cadence_exhausted', status: 'waiting', attemptCount: 3 }), history: makeHistory({ lastAttemptChannel: 'phone' }) }),
      evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'reactivation_due', attemptCount: 3 }), history: makeHistory({ lastAttemptChannel: 'phone' }) }),
      evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }), history: makeHistory({ lastEngagementChannel: 'phone' }) }),
      evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: '2026-01-10T12:00:00.000Z' }), history: makeHistory({ lastEngagement: { occurredAt: '2026-01-10T09:00:00.000Z' }, lastEngagementChannel: 'phone' }) }),
      evaluateNextBestActionPolicy({ lead: makeLead({ nextActionType: 'meeting' }), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() }),
    ];
    samples.forEach((r) => {
      expect(r).not.toBeNull();
      expect(ALLOWED_INTENTS.has(r.intent)).toBe(true);
      expect(ALLOWED_CONFIDENCE.has(r.confidence)).toBe(true);
      expect(r).not.toHaveProperty('fallback');
      expect(r).not.toHaveProperty('score');
      expect(r).not.toHaveProperty('probability');
    });
  });

  it('29.1) output sempre tem exatamente os 5 campos do contrato, nunca mais', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(Object.keys(r).sort()).toEqual(['channel', 'confidence', 'intent', 'reasonCode', 'type'].sort());
  });
});

describe('Fase 2E.4.2 — diferenças deliberadas vs. NBA atual (nextBestAction.js, 2E.1)', () => {
  it('30.1) never_contacted sem explicit: NBA V1 = null; policy V1 = call (divergência intencional)', () => {
    const r = evaluateNextBestActionPolicy({ lead: makeLead(), followUpEvaluation: makeEvaluation({ reason: 'never_contacted' }), history: makeHistory() });
    expect(r).not.toBeNull();
    expect(r.type).toBe('call');
  });

  it('30.2) tentativa >=2: NBA V1 repete canal; policy V1 alterna (divergência intencional)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 2 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }),
    });
    expect(r.channel).toBe('whatsapp'); // NBA V1 teria repetido 'phone'
  });

  it('30.3) cadence/reactivation: NBA V1 repete; policy V1 alterna (divergência intencional)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'reactivation_due', attemptCount: 3 }),
      history: makeHistory({ lastAttemptChannel: 'whatsapp' }),
    });
    expect(r.channel).toBe('phone'); // NBA V1 teria repetido 'whatsapp'
  });

  it('30.4) engagement: NBA V1 pode usar tentativa anterior ao engajamento; policy V1 usa o canal do próprio engajamento (divergência intencional)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_new_attempt_since_engagement' }),
      history: makeHistory({ lastEngagementChannel: 'whatsapp' }),
    });
    expect(r.channel).toBe('whatsapp');
  });

  it('30.5) proposal: NBA V1 = null sem explicit; policy V1 = último engagement confiável ou null (divergência intencional, mesma resposta só quando não há engagement confiável)', () => {
    const withEngagement = evaluateNextBestActionPolicy({
      lead: makeLead(),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_proposal', anchorOccurredAt: '2026-01-10T12:00:00.000Z' }),
      history: makeHistory({ lastEngagement: { occurredAt: '2026-01-10T09:00:00.000Z' }, lastEngagementChannel: 'whatsapp' }),
    });
    expect(withEngagement).not.toBeNull(); // NBA V1 teria sido null aqui
  });

  it('30.6) follow_up/other: NBA V1 cai em fallthrough silencioso (infere pela última tentativa); policy V1 suprime explicitamente com null (divergência intencional)', () => {
    const r = evaluateNextBestActionPolicy({
      lead: makeLead({ nextActionType: 'follow_up' }),
      followUpEvaluation: makeEvaluation({ reason: 'no_response_after_attempt', attemptCount: 1 }),
      history: makeHistory({ lastAttemptChannel: 'phone' }), // NBA V1/engine inferiria call aqui
    });
    expect(r).toBeNull();
  });
});
