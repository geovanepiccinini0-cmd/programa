import { describe, it, expect, vi, afterEach } from 'vitest';
import { selectOperationalRecommendation, OPERATIONAL_RECOMMENDATION_SOURCE } from './operationalRecommendation.js';
import { buildFollowUpQueue } from './followUpQueue.js';
import * as nextBestActionPolicyModule from './nextBestActionPolicy.js';
import { evaluateNextBestAction } from './nextBestAction.js';

function nba(overrides = {}) {
  return { type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule', ...overrides };
}

describe('Fase 2E.5.1A — selectOperationalRecommendation', () => {
  it('1) source=current + current objeto -> devolve esse objeto (mesma referência)', () => {
    const current = nba();
    const candidate = nba({ type: 'whatsapp', channel: 'whatsapp' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current, candidate });
    expect(r).toBe(current);
  });

  it('2) source=current + current null -> null', () => {
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current: null, candidate: nba() });
    expect(r).toBeNull();
  });

  it('3) source=current ignora qualquer candidate diferente', () => {
    const current = nba({ type: 'call' });
    const candidate = nba({ type: 'meeting', channel: 'in_person', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current, candidate });
    expect(r).toBe(current);
    expect(r.type).toBe('call');
  });

  it('4) source=commercial_policy + candidate objeto -> devolve esse objeto (mesma referência)', () => {
    const current = nba();
    const candidate = nba({ type: 'whatsapp', channel: 'whatsapp' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY, current, candidate });
    expect(r).toBe(candidate);
  });

  it('5) source=commercial_policy + candidate null -> null', () => {
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY, current: nba(), candidate: null });
    expect(r).toBeNull();
  });

  it('6) source=commercial_policy + candidate null NUNCA cai para current (regra crítica, mesmo current sendo um objeto válido)', () => {
    const current = nba({ type: 'call', channel: 'phone' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY, current, candidate: null });
    expect(r).toBeNull();
    expect(r).not.toBe(current);
  });

  it('7) source inválido (string desconhecida) -> null, nunca current automático', () => {
    const current = nba();
    const r = selectOperationalRecommendation({ source: 'bogus_source', current, candidate: nba({ type: 'whatsapp' }) });
    expect(r).toBeNull();
  });

  it('7.1) source inválido mesmo com candidate null também -> null (não é "escolhe o outro por default")', () => {
    const r = selectOperationalRecommendation({ source: 'bogus_source', current: nba(), candidate: null });
    expect(r).toBeNull();
  });

  it('8) source ausente (undefined) -> null', () => {
    const r = selectOperationalRecommendation({ current: nba(), candidate: nba() });
    expect(r).toBeNull();
  });

  it('8.1) source null explícito -> null', () => {
    const r = selectOperationalRecommendation({ source: null, current: nba(), candidate: nba() });
    expect(r).toBeNull();
  });

  it('9) nunca muta current nem candidate', () => {
    const current = nba();
    const candidate = nba({ type: 'whatsapp', channel: 'whatsapp' });
    const snapshotCurrent = JSON.stringify(current);
    const snapshotCandidate = JSON.stringify(candidate);
    selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current, candidate });
    selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY, current, candidate });
    selectOperationalRecommendation({ source: 'bogus', current, candidate });
    expect(JSON.stringify(current)).toBe(snapshotCurrent);
    expect(JSON.stringify(candidate)).toBe(snapshotCandidate);
  });

  it('10) comportamento de referência documentado: o objeto devolvido é === ao objeto recebido, nunca um clone', () => {
    const current = nba();
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current, candidate: null });
    expect(r).toBe(current); // === , não toEqual
  });

  it('11) meeting: selector é agnóstico de type — só seleciona, nunca julga o conteúdo', () => {
    const meetingRec = nba({ type: 'meeting', channel: 'in_person', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY, current: null, candidate: meetingRec });
    expect(r).toBe(meetingRec);
  });

  it('12) proposal: idem', () => {
    const proposalRec = nba({ type: 'proposal', channel: 'manual', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'rule' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY, current: null, candidate: proposalRec });
    expect(r).toBe(proposalRec);
  });

  it('13) call: idem', () => {
    const callRec = nba({ type: 'call', channel: 'phone' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current: callRec, candidate: null });
    expect(r).toBe(callRec);
  });

  it('14) whatsapp: idem', () => {
    const waRec = nba({ type: 'whatsapp', channel: 'whatsapp' });
    const r = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY, current: null, candidate: waRec });
    expect(r).toBe(waRec);
  });

  it('determinismo: mesma entrada -> mesma saída em chamadas repetidas', () => {
    const current = nba();
    const candidate = nba({ type: 'whatsapp', channel: 'whatsapp' });
    const results = Array.from({ length: 5 }, () => selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current, candidate }));
    results.forEach((r) => expect(r).toBe(results[0]));
  });
});

// Fase 2E.5.1A — seção 24: prova de paridade usando o pipeline REAL
// (buildFollowUpQueue, intocado nesta subfase) — não um mock. Extrai o
// `nba` (current) e `nbaShadow.candidate` já calculados por cada item
// real e confirma que, com source=CURRENT, o seletor devolve exatamente
// o mesmo `current` — ou seja, zero mudança operacional seria produzida
// se este seletor fosse integrado à queue hoje, ainda com a fonte em
// CURRENT (preparação, não ativação).
describe('Fase 2E.5.1A — paridade com o pipeline real (buildFollowUpQueue, source=CURRENT)', () => {
  const NOW = new Date('2026-10-10T12:00:00.000Z');
  function hoursAgo(h) { return new Date(NOW.getTime() - h * 3600000).toISOString(); }
  function daysAgo(d) { return hoursAgo(d * 24); }

  function makeLead(overrides = {}) {
    return { id: 'lead-1', nome: 'Teste', etapa: 'Novo Lead', telefone: '51999999999', proximoContato: '', nextActionType: '', createdAt: daysAgo(10), deletedAt: null, ...overrides };
  }

  let seq = 0;
  function makeInteraction(overrides = {}) {
    seq += 1;
    return { id: 'it-' + seq, leadId: 'lead-1', type: 'call', direction: 'outbound', channel: 'phone', metadata: { activity_class: 'attempt' }, occurredAt: hoursAgo(1), ...overrides };
  }

  // item.evaluation não guarda o `nba` bruto (só nbaPresentation) — mas
  // nbaShadow.current É exatamente esse `nba` (mesma referência usada
  // internamente para construir o comparator), reaproveitado aqui só
  // para o teste, sem precisar alterar followUpQueue.js para expor nba.
  function assertParity(leads, interactions = []) {
    const queue = buildFollowUpQueue({ leads, interactions, tasks: [], now: NOW });
    const item = queue[0];
    const current = item.nbaShadow ? item.nbaShadow.current : null;
    const candidate = item.nbaShadow ? item.nbaShadow.candidate : null;
    const selected = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current, candidate });
    expect(selected).toEqual(current);
  }

  it('never_contacted: paridade confirmada', () => {
    assertParity([makeLead()]);
  });

  it('attempt1: paridade confirmada', () => {
    assertParity([makeLead()], [makeInteraction({ occurredAt: hoursAgo(30) })]);
  });

  it('attempt2 (alternância candidate != current): seletor com source=CURRENT ainda devolve current, não o candidate alternado', () => {
    const interactions = [
      makeInteraction({ occurredAt: daysAgo(3) }),
      makeInteraction({ occurredAt: hoursAgo(30) }),
    ];
    const queue = buildFollowUpQueue({ leads: [makeLead()], interactions, tasks: [], now: NOW });
    const item = queue[0];
    expect(item.nbaShadow.status).toBe('changed_action'); // confirma que current e candidate DIVERGEM de verdade aqui
    const selected = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current: item.nbaShadow.current, candidate: item.nbaShadow.candidate });
    expect(selected).toEqual(item.nbaShadow.current);
    expect(selected).not.toEqual(item.nbaShadow.candidate);
  });

  it('engagement: paridade confirmada mesmo com candidate divergente', () => {
    const interactions = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) }),
      makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: daysAgo(5) }),
    ];
    const queue = buildFollowUpQueue({ leads: [makeLead()], interactions, tasks: [], now: NOW });
    const item = queue[0];
    expect(item.nbaShadow.status).toBe('changed_action');
    const selected = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current: item.nbaShadow.current, candidate: item.nbaShadow.candidate });
    expect(selected).toEqual(item.nbaShadow.current);
  });

  it('proposal (both_null): paridade confirmada (ambos null)', () => {
    const interactions = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(2) }),
      makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) }),
    ];
    const queue = buildFollowUpQueue({ leads: [makeLead()], interactions, tasks: [], now: NOW });
    const item = queue[0];
    expect(item.nbaShadow.status).toBe('both_null');
    const selected = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current: item.nbaShadow.current, candidate: item.nbaShadow.candidate });
    expect(selected).toBeNull();
  });

  it('explicit: paridade confirmada', () => {
    assertParity([makeLead({ nextActionType: 'whatsapp' })]);
  });

  it('blocked: paridade confirmada (ambos null)', () => {
    const queue = buildFollowUpQueue({ leads: [makeLead({ etapa: 'Ganho' })], interactions: [], tasks: [], now: NOW });
    const item = queue[0];
    expect(item.evaluation.status).toBe('blocked');
    expect(item.nbaShadow).toEqual({ status: 'both_null', current: null, candidate: null });
    const selected = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current: item.nbaShadow.current, candidate: item.nbaShadow.candidate });
    expect(selected).toBeNull();
  });
});

// Fase 2E.5.1A — seção 19: composição com o hardening ef96b5d (2E.4.3.2).
// Se operationalRecommendation fosse integrado hoje com source=CURRENT,
// uma falha exclusiva do candidate (nbaShadow=null, fail-open já
// existente) NÃO pode afetar o resultado — current já é extraído
// independentemente do candidate ter falhado ou não.
describe('Fase 2E.5.1A — composição com o fail-open do shadow (candidate throw não afeta source=CURRENT)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('candidate throw no pipeline real -> nbaShadow null, mas selector(source=CURRENT) ainda devolve o current correto', () => {
    vi.spyOn(nextBestActionPolicyModule, 'evaluateNextBestActionPolicy').mockImplementation(() => { throw new Error('bug exclusivo do candidate, simulado'); });

    const NOW = new Date('2026-10-10T12:00:00.000Z');
    const lead = { id: 'lead-1', nome: 'Teste', etapa: 'Novo Lead', telefone: '51999999999', proximoContato: '', nextActionType: '', createdAt: '2026-09-01T00:00:00.000Z', deletedAt: null };
    const queue = buildFollowUpQueue({ leads: [lead], interactions: [], tasks: [], now: NOW });
    const item = queue[0];

    expect(item.error).toBeNull();
    expect(item.nbaShadow).toBeNull(); // fail-open já existente (2E.4.3.2), confirmado ainda intacto

    // Mesmo sem nbaShadow (candidate indisponível), o current isolado
    // (via evaluateNextBestAction direto, não afetado pelo mock de
    // policy) continua correto, e o selector com source=CURRENT reflete
    // exatamente isso — nunca null por causa da falha do candidate.
    const current = evaluateNextBestAction({ lead, followUpEvaluation: item.evaluation });
    const selected = selectOperationalRecommendation({ source: OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT, current, candidate: null });
    expect(selected).toEqual(current);
    expect(selected).toBeNull(); // never_contacted sem explicit -> null é o current real aqui, confirmando que não é um null "por erro"
  });
});
