import { describe, expect, it } from 'vitest';
import { evaluateFollowUpEligibility, FOLLOW_UP_POLICY, FOLLOW_UP_STATUS, FOLLOW_UP_REASON, FOLLOW_UP_BLOCKER } from './followUpEngine.js';

// Fase 2C.1 — Follow-up Eligibility Engine. NOW fixo para determinismo
// (nunca Date.now()/new Date() implícito nos testes).
const NOW = new Date('2026-10-10T12:00:00.000Z');

function hoursAgo(h) { return new Date(NOW.getTime() - h * 3600000).toISOString(); }
function minutesAgo(m) { return new Date(NOW.getTime() - m * 60000).toISOString(); }
function daysAgo(d) { return hoursAgo(d * 24); }

let idCounter = 0;
function makeLead(overrides = {}) {
  return {
    id: 'lead-1',
    nome: 'Lilliane',
    etapa: 'Negociação',
    telefone: '54999999999',
    proximoContato: '',
    nextActionType: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function makeInteraction(overrides = {}) {
  idCounter += 1;
  return {
    id: 'int-' + idCounter,
    leadId: 'lead-1',
    type: 'call',
    direction: 'outbound',
    channel: 'phone',
    metadata: { activity_class: 'attempt', source: 'user' },
    occurredAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return { id: 'task-1', leadId: 'lead-1', origem: 'lead-agenda', concluida: false, categoria: 'Agenda/Ligação', ...overrides };
}

function evaluate(lead, interactions, tasks = [], now = NOW, policy = FOLLOW_UP_POLICY) {
  return evaluateFollowUpEligibility({ lead, interactions, tasks, now, policy });
}

describe('Fase 2C.1 — never_contacted / attempt / boundary', () => {
  it('1) lead novo sem interactions -> never_contacted, due', () => {
    const lead = makeLead();
    const r = evaluate(lead, []);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(r.eligible).toBe(true);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
    expect(r.anchorInteractionId).toBeNull();
    expect(r.anchorOccurredAt).toBeNull();
    expect(r.since).toBe(lead.createdAt);
    expect(r.blockers).toEqual([]);
  });

  it('2) tentativa recente (2h atrás) -> waiting', () => {
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(2) });
    const r = evaluate(makeLead(), [attempt]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(r.anchorInteractionId).toBe(attempt.id);
  });

  it('3) tentativa exatamente no boundary de 24h -> due (now >= dueAt)', () => {
    const attempt = makeInteraction({ occurredAt: hoursAgo(24) });
    const r = evaluate(makeLead(), [attempt]);
    expect(r.dueAt).toBe(attempt.occurredAt && new Date(new Date(attempt.occurredAt).getTime() + 24 * 3600000).toISOString());
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('3b) um minuto antes do boundary -> ainda waiting', () => {
    const attempt = makeInteraction({ occurredAt: minutesAgo(24 * 60 - 1) });
    const r = evaluate(makeLead(), [attempt]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.WAITING);
  });

  it('4) tentativa vencida (30h) -> due', () => {
    const attempt = makeInteraction({ occurredAt: hoursAgo(30) });
    const r = evaluate(makeLead(), [attempt]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(r.eligible).toBe(true);
  });
});

describe('Fase 2C.1 — WhatsApp / call / meeting / proposal', () => {
  it('5) WhatsApp outbound (sent) vencido -> no_response_after_attempt, due', () => {
    const sent = makeInteraction({ type: 'whatsapp', direction: 'outbound', channel: 'whatsapp', occurredAt: hoursAgo(30), metadata: { activity_class: 'attempt', source: 'user' } });
    const r = evaluate(makeLead(), [sent]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('6) WhatsApp inbound posterior ao outbound -> cliente respondeu, vira no_new_attempt_since_engagement (não "sem resposta")', () => {
    const sent = makeInteraction({ type: 'whatsapp', direction: 'outbound', channel: 'whatsapp', occurredAt: hoursAgo(3), metadata: { activity_class: 'attempt', source: 'user' } });
    const received = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', occurredAt: hoursAgo(2), metadata: { activity_class: 'engagement', source: 'user' } });
    const r = evaluate(makeLead(), [sent, received]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(r.anchorInteractionId).toBe(received.id);
    expect(r.status).toBe(FOLLOW_UP_STATUS.WAITING); // só 2h desde o engajamento, dentro das 96h
    // attemptCount conta só tentativas DEPOIS do último engajamento — a tentativa de 3h atrás foi ANTES
    expect(r.attemptCount).toBe(0);
  });

  it('7) call no_answer vencida -> no_response_after_attempt, due', () => {
    const call = makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', occurredAt: hoursAgo(30), metadata: { activity_class: 'attempt', outcome: 'no_answer', source: 'user' } });
    const r = evaluate(makeLead(), [call]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('8) call connected recente -> engagement, no_new_attempt_since_engagement, waiting', () => {
    const call = makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', occurredAt: hoursAgo(3), metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' } });
    const r = evaluate(makeLead(), [call]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(r.status).toBe(FOLLOW_UP_STATUS.WAITING);
  });

  it('9) proposal_sent recente -> no_response_after_proposal, waiting', () => {
    const proposal = makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt: hoursAgo(3), metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } });
    const r = evaluate(makeLead(), [proposal]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(r.status).toBe(FOLLOW_UP_STATUS.WAITING);
  });

  it('10) proposal_sent vencida (>48h) -> no_response_after_proposal, due', () => {
    const proposal = makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt: hoursAgo(49), metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } });
    const r = evaluate(makeLead(), [proposal]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('proposal_sent nunca participa de no_response_after_attempt mesmo sendo activity_class=attempt', () => {
    const proposal = makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt: hoursAgo(1), metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } });
    const r = evaluate(makeLead(), [proposal]);
    expect(r.reason).not.toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(r.attemptCount).toBe(0); // proposal não conta como "tentativa de contato" para este motor
  });

  it('11) meeting held -> engagement, no_new_attempt_since_engagement', () => {
    const meeting = makeInteraction({ type: 'meeting', direction: 'outbound', channel: 'in_person', occurredAt: hoursAgo(5), metadata: { activity_class: 'engagement', outcome: 'held', source: 'user' } });
    const r = evaluate(makeLead(), [meeting]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(r.anchorInteractionId).toBe(meeting.id);
  });

  it('12) engagement sem nova tentativa há muito tempo (>96h) -> due', () => {
    const call = makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', occurredAt: daysAgo(6), metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' } });
    const r = evaluate(makeLead(), [call]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
  });
});

describe('Fase 2C.1 — attemptCount / cadência / reativação', () => {
  it('13) múltiplas tentativas desde o último engajamento são contadas corretamente', () => {
    const engagement = makeInteraction({ type: 'call', occurredAt: daysAgo(20), metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' } });
    const a1 = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(15), metadata: { activity_class: 'attempt', source: 'user' } });
    const a2 = makeInteraction({ type: 'call', occurredAt: daysAgo(10), metadata: { activity_class: 'attempt', outcome: 'no_answer', source: 'user' } });
    const r = evaluate(makeLead(), [engagement, a1, a2]);
    expect(r.attemptCount).toBe(2);
  });

  it('14) attemptCount >= maxAttempts, dentro da janela de reativação -> cadence_exhausted, waiting', () => {
    const a1 = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(10) });
    const a2 = makeInteraction({ type: 'call', occurredAt: daysAgo(8) });
    const a3 = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(1) }); // mais recente -> anchor
    const r = evaluate(makeLead(), [a1, a2, a3]);
    expect(r.attemptCount).toBe(3);
    expect(r.reason).toBe(FOLLOW_UP_REASON.CADENCE_EXHAUSTED);
    expect(r.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(r.anchorInteractionId).toBe(a3.id);
  });

  it('15) cadence_exhausted perto do boundary de reativação (6 dias) -> ainda waiting', () => {
    const a1 = makeInteraction({ occurredAt: daysAgo(20) });
    const a2 = makeInteraction({ occurredAt: daysAgo(15) });
    const a3 = makeInteraction({ occurredAt: daysAgo(6) }); // 1 dia antes dos 7 dias de reativação
    const r = evaluate(makeLead(), [a1, a2, a3]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.CADENCE_EXHAUSTED);
    expect(r.status).toBe(FOLLOW_UP_STATUS.WAITING);
  });

  it('16) reactivation_due após 7 dias da última tentativa -> due', () => {
    const a1 = makeInteraction({ occurredAt: daysAgo(20) });
    const a2 = makeInteraction({ occurredAt: daysAgo(15) });
    const a3 = makeInteraction({ occurredAt: daysAgo(10) }); // > 7 dias atrás
    const r = evaluate(makeLead(), [a1, a2, a3]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.REACTIVATION_DUE);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(r.eligible).toBe(true);
  });
});

describe('Fase 2C.1 — blockers absolutos', () => {
  it('17) etapa Ganho -> blocked', () => {
    const r = evaluate(makeLead({ etapa: 'Ganho' }), []);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.eligible).toBe(false);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.ETAPA_GANHO);
    expect(r.reason).toBeNull();
  });

  it('18) etapa Perdido -> blocked', () => {
    const r = evaluate(makeLead({ etapa: 'Perdido' }), []);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.ETAPA_PERDIDO);
  });

  it('19) deletedAt preenchido -> blocked', () => {
    const r = evaluate(makeLead({ deletedAt: '2026-10-01T00:00:00.000Z' }), []);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.DELETED);
  });
});

describe('Fase 2C.1 — Ajuste 4: proximoContato + lead-agenda (conjunto, conservador)', () => {
  it('20) próximo contato futuro -> blocked', () => {
    const lead = makeLead({ proximoContato: '2026-12-25' });
    const r = evaluate(lead, [], [makeTask({ data: '2026-12-25' })]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.PROXIMO_CONTATO_AGENDADO);
  });

  it('21) próximo contato hoje -> blocked', () => {
    const lead = makeLead({ proximoContato: '2026-10-10' });
    const r = evaluate(lead, [], [makeTask({ data: '2026-10-10' })]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.PROXIMO_CONTATO_AGENDADO);
  });

  it('22) próximo contato vencido mas task lead-agenda AINDA pendente -> blocked (conservador: data vencida não desarma o blocker)', () => {
    const lead = makeLead({ proximoContato: '2026-09-01' });
    const r = evaluate(lead, [], [makeTask({ data: '2026-09-01' })]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toEqual(expect.arrayContaining([FOLLOW_UP_BLOCKER.PROXIMO_CONTATO_AGENDADO, FOLLOW_UP_BLOCKER.LEAD_AGENDA_PENDENTE]));
  });

  it('23) proximoContato preenchido SEM task correspondente (estado inconsistente) -> ainda bloqueia, só pelo sinal do lead', () => {
    const lead = makeLead({ proximoContato: '2026-10-15' });
    const r = evaluate(lead, [], []); // nenhuma task
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.PROXIMO_CONTATO_AGENDADO);
    expect(r.blockers).not.toContain(FOLLOW_UP_BLOCKER.LEAD_AGENDA_PENDENTE);
  });

  it('24) task lead-agenda pendente SEM proximoContato (estado inconsistente) -> ainda bloqueia, só pelo sinal da task', () => {
    const lead = makeLead({ proximoContato: '' });
    const r = evaluate(lead, [], [makeTask()]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.LEAD_AGENDA_PENDENTE);
    expect(r.blockers).not.toContain(FOLLOW_UP_BLOCKER.PROXIMO_CONTATO_AGENDADO);
  });

  it('25) task origem=automation pendente -> blocked (idempotência)', () => {
    const lead = makeLead();
    const r = evaluate(lead, [], [makeTask({ origem: 'automation', categoria: 'Follow-up', concluida: false })]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.FOLLOW_UP_AUTOMATICO_PENDENTE);
  });

  it('task lead-agenda CONCLUÍDA não bloqueia (só pendente bloqueia)', () => {
    const lead = makeLead();
    const r = evaluate(lead, [], [makeTask({ concluida: true })]);
    expect(r.blockers).not.toContain(FOLLOW_UP_BLOCKER.LEAD_AGENDA_PENDENTE);
  });
});

describe('Fase 2C.1 — note/stage_change não alteram a regra', () => {
  it('26) nota interna recente não muda a avaliação (baseada na tentativa antiga)', () => {
    const oldAttempt = makeInteraction({ occurredAt: hoursAgo(30) });
    const recentNote = makeInteraction({ type: 'note', direction: 'internal', channel: 'manual', occurredAt: hoursAgo(1), metadata: { activity_class: 'internal', source: 'user' } });
    const r = evaluate(makeLead(), [oldAttempt, recentNote]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(r.anchorInteractionId).toBe(oldAttempt.id);
  });

  it('27) stage_change recente não muda a avaliação', () => {
    const oldAttempt = makeInteraction({ occurredAt: hoursAgo(30) });
    const recentStageChange = makeInteraction({ type: 'stage_change', direction: 'internal', channel: 'crm', occurredAt: hoursAgo(1), metadata: { from_stage: 'Qualificação', to_stage: 'Negociação', activity_class: 'internal', source: 'user' } });
    const r = evaluate(makeLead(), [oldAttempt, recentStageChange]);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(r.anchorInteractionId).toBe(oldAttempt.id);
  });
});

describe('Fase 2C.1 — ordem e legado', () => {
  it('28) interações fora de ordem de inserção produzem o mesmo resultado', () => {
    const older = makeInteraction({ occurredAt: hoursAgo(40) });
    const newer = makeInteraction({ occurredAt: hoursAgo(5) });
    const r1 = evaluate(makeLead(), [older, newer]);
    const r2 = evaluate(makeLead(), [newer, older]);
    expect(r1.anchorInteractionId).toBe(newer.id);
    expect(r2.anchorInteractionId).toBe(newer.id);
    expect(r1.status).toBe(r2.status);
  });

  it('29) tasks fora de ordem não afetam blockers', () => {
    const t1 = makeTask({ id: 'a', concluida: true });
    const t2 = makeTask({ id: 'b', concluida: false });
    const r1 = evaluate(makeLead(), [], [t1, t2]);
    const r2 = evaluate(makeLead(), [], [t2, t1]);
    expect(r1.blockers).toEqual(r2.blockers);
  });

  it('30) interação legada (metadata null / stage_change antigo sem activity_class) é ignorada com segurança, nunca conta como attempt/engagement', () => {
    const legacyNote = { id: 'legacy-1', leadId: 'lead-1', type: 'note', direction: '', occurredAt: '2025-01-01T09:00:00.000Z', metadata: null };
    const legacyStageChange = { id: 'legacy-2', leadId: 'lead-1', type: 'stage_change', direction: '', occurredAt: '2025-01-02T09:00:00.000Z', metadata: { from_stage: 'Novo Lead', to_stage: 'Qualificação' } };
    const r = evaluate(makeLead(), [legacyNote, legacyStageChange]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED); // nada conta como tentativa/engajamento real
    expect(() => evaluate(makeLead(), [legacyNote, legacyStageChange])).not.toThrow();
  });
});

describe('Fase 2C.1 — suggestedAction', () => {
  it('31) nextActionType presente e executável tem precedência', () => {
    const attempt = makeInteraction({ type: 'call', channel: 'phone', occurredAt: hoursAgo(30) });
    const r = evaluate(makeLead({ nextActionType: 'whatsapp' }), [attempt]);
    expect(r.suggestedAction).toEqual({ type: 'whatsapp', channel: 'whatsapp' });
  });

  it('32) nextActionType ausente -> infere pelo canal da última tentativa', () => {
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(30) });
    const r = evaluate(makeLead({ nextActionType: '' }), [attempt]);
    expect(r.suggestedAction).toEqual({ type: 'whatsapp', channel: 'whatsapp' });
  });

  it('33) sem nextActionType e sem tentativa de contato (só proposta) -> suggestedAction null, sem inventar canal', () => {
    const proposal = makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt: hoursAgo(1), metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } });
    const r = evaluate(makeLead({ nextActionType: '' }), [proposal]);
    expect(r.suggestedAction).toBeNull();
  });

  it('34) lead sem telefone -> não sugere call/whatsapp, sinaliza sem_telefone sem bloquear status', () => {
    const attempt = makeInteraction({ type: 'call', channel: 'phone', occurredAt: hoursAgo(30) });
    const r = evaluate(makeLead({ telefone: '' }), [attempt]);
    expect(r.suggestedAction).toBeNull();
    expect(r.blockers).toContain(FOLLOW_UP_BLOCKER.SEM_TELEFONE);
    expect(r.status).toBe(FOLLOW_UP_STATUS.DUE); // sem_telefone não é blocker absoluto
    expect(r.eligible).toBe(true);
  });

  it('nextActionType "follow_up"/"other" não mapeiam canal -> cai para inferência pela última tentativa', () => {
    const attempt = makeInteraction({ type: 'meeting', channel: 'in_person', occurredAt: hoursAgo(1), metadata: { activity_class: 'engagement', outcome: 'held', source: 'user' } });
    const r = evaluate(makeLead({ nextActionType: 'follow_up' }), [attempt]);
    expect(r.suggestedAction).toEqual({ type: 'meeting', channel: 'in_person' });
  });
});

describe('Fase 2C.1 — dedupeKey', () => {
  it('35) dedupeKey é estável para a mesma condição (mesmos inputs por valor, objetos diferentes)', () => {
    const attemptA = makeInteraction({ id: 'fixed-1', occurredAt: hoursAgo(30) });
    const attemptB = { ...attemptA };
    const r1 = evaluate(makeLead(), [attemptA]);
    const r2 = evaluate(makeLead(), [attemptB]);
    expect(r1.dedupeKey).toBe(r2.dedupeKey);
  });

  it('36) dedupeKey muda quando a âncora muda (novo ciclo/nova tentativa)', () => {
    const attempt1 = makeInteraction({ id: 'fixed-a', occurredAt: hoursAgo(30) });
    const attempt2 = makeInteraction({ id: 'fixed-b', occurredAt: hoursAgo(26) });
    const r1 = evaluate(makeLead(), [attempt1]);
    const r2 = evaluate(makeLead(), [attempt2]);
    expect(r1.dedupeKey).not.toBe(r2.dedupeKey);
  });

  it('dedupeKey para blocked não depende de reason/anchor', () => {
    const r = evaluate(makeLead({ etapa: 'Ganho' }), []);
    expect(r.dedupeKey).toBe('lead-1:blocked');
  });
});

describe('Fase 2C.1 — pureza: now injetável, imutabilidade, timezone', () => {
  it('37) now injetável: o mesmo histórico produz status diferente conforme o `now` passado', () => {
    const attempt = makeInteraction({ occurredAt: hoursAgo(10) });
    const rSoon = evaluate(makeLead(), [attempt], [], new Date(NOW.getTime() - 9 * 3600000)); // 1h depois da tentativa
    const rLater = evaluate(makeLead(), [attempt], [], new Date(NOW.getTime() + 20 * 3600000)); // bem depois do prazo
    expect(rSoon.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(rLater.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('38) timezone: ISO com offset explícito produz o mesmo resultado que o equivalente em UTC', () => {
    const attemptUTC = makeInteraction({ occurredAt: '2026-10-09T12:00:00.000Z' });
    const attemptOffset = makeInteraction({ occurredAt: '2026-10-09T09:00:00.000-03:00' }); // mesmo instante
    const r1 = evaluate(makeLead(), [attemptUTC]);
    const r2 = evaluate(makeLead(), [attemptOffset]);
    expect(r1.status).toBe(r2.status);
    expect(r1.dueAt).toBe(r2.dueAt);
  });

  it('39) inputs não são mutados (lead/interactions/tasks congelados não geram erro nem mudam)', () => {
    const lead = Object.freeze(makeLead());
    const attempt = Object.freeze(makeInteraction({ occurredAt: hoursAgo(30) }));
    const task = Object.freeze(makeTask({ concluida: true }));
    const interactions = Object.freeze([attempt]);
    const tasks = Object.freeze([task]);
    expect(() => evaluateFollowUpEligibility({ lead, interactions, tasks, now: NOW, policy: FOLLOW_UP_POLICY })).not.toThrow();
    expect(interactions).toEqual([attempt]);
    expect(tasks).toEqual([task]);
  });
});

// Fase 2C.1.1 — hardening: casos identificados na revisão estática do
// commit 72a206a, agora congelados explicitamente em teste. Nenhuma
// mudança de comportamento foi feita — estes testes só tornam
// observável o que o motor já fazia.
describe('Fase 2C.1.1 — reset completo da cadência (cenário composto de 4 passos)', () => {
  it('Dia1/Dia2 (tentativas pré-engajamento) ficam fora do ciclo atual; attemptCount=1; reason reflete a tentativa do Dia4', () => {
    const dia1 = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', direction: 'outbound', occurredAt: daysAgo(4), metadata: { activity_class: 'attempt', source: 'user' } });
    const dia2 = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', direction: 'outbound', occurredAt: daysAgo(3), metadata: { activity_class: 'attempt', source: 'user' } });
    const dia3 = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', direction: 'inbound', occurredAt: daysAgo(2), metadata: { activity_class: 'engagement', source: 'user' } });
    const dia4 = makeInteraction({ type: 'call', channel: 'phone', direction: 'outbound', occurredAt: daysAgo(1), metadata: { activity_class: 'attempt', outcome: 'no_answer', source: 'user' } });

    const r = evaluate(makeLead(), [dia1, dia2, dia3, dia4]);

    // attemptCount=1 só é possível se o Dia3 (engajamento) tiver sido
    // usado como fronteira — se a fronteira fosse "sempre", dia1+dia2+dia4
    // dariam attemptCount=3; se fosse "nunca houve engajamento", também
    // dariam 3. Logo attemptCount=1 prova que lastEngagement=Dia3 foi
    // corretamente usado.
    expect(r.attemptCount).toBe(1);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(r.anchorInteractionId).toBe(dia4.id);
    expect(r.anchorOccurredAt).toBe(dia4.occurredAt);
  });
});

describe('Fase 2C.1.1 — interação com duplo papel (attempt + engagement na mesma linha)', () => {
  it('09:00 call_no_answer, 10:00 call_connected -> lastEngagement=10:00, attemptCount=0, no_new_attempt_since_engagement', () => {
    const noAnswer = makeInteraction({ occurredAt: '2026-10-09T09:00:00.000Z', metadata: { activity_class: 'attempt', outcome: 'no_answer', source: 'user' } });
    const connected = makeInteraction({ occurredAt: '2026-10-09T10:00:00.000Z', metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' } });
    const r = evaluate(makeLead(), [noAnswer, connected]);
    expect(r.anchorOccurredAt).toBe(connected.occurredAt);
    expect(r.anchorInteractionId).toBe(connected.id);
    // a própria call_connected não pode contar como tentativa posterior a si mesma
    expect(r.attemptCount).toBe(0);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
  });

  it('09:00 call_connected, 11:00 whatsapp_sent -> lastEngagement=09:00, attemptCount=1, no_response_after_attempt', () => {
    const connected = makeInteraction({ occurredAt: '2026-10-09T09:00:00.000Z', metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' } });
    const sent = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', direction: 'outbound', occurredAt: '2026-10-09T11:00:00.000Z', metadata: { activity_class: 'attempt', source: 'user' } });
    const r = evaluate(makeLead(), [connected, sent]);
    expect(r.anchorOccurredAt).toBe(sent.occurredAt);
    expect(r.attemptCount).toBe(1);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
  });
});

describe('Fase 2C.1.1 — ciclo completo cadence_exhausted -> reactivation_due', () => {
  it('nunca existe status=due com reason=cadence_exhausted; dedupeKey muda entre os dois estágios', () => {
    const a1 = makeInteraction({ occurredAt: daysAgo(20) });
    const a2 = makeInteraction({ occurredAt: daysAgo(15) });
    const a3 = makeInteraction({ occurredAt: daysAgo(10) }); // anchor: attemptCount atinge 3 aqui

    const anchorTime = new Date(a3.occurredAt).getTime();
    const sixDaysAfter = new Date(anchorTime + 6 * 24 * 3600000); // ainda dentro da janela de 7 dias
    const sevenDaysAfter = new Date(anchorTime + 7 * 24 * 3600000); // boundary exato

    const beforeBoundary = evaluate(makeLead(), [a1, a2, a3], [], sixDaysAfter);
    expect(beforeBoundary.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(beforeBoundary.reason).toBe(FOLLOW_UP_REASON.CADENCE_EXHAUSTED);

    const atBoundary = evaluate(makeLead(), [a1, a2, a3], [], sevenDaysAfter);
    expect(atBoundary.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(atBoundary.reason).toBe(FOLLOW_UP_REASON.REACTIVATION_DUE);

    // nunca a combinação contraditória status=due + reason=cadence_exhausted
    expect(beforeBoundary.status === FOLLOW_UP_STATUS.DUE && beforeBoundary.reason === FOLLOW_UP_REASON.CADENCE_EXHAUSTED).toBe(false);
    expect(atBoundary.status === FOLLOW_UP_STATUS.DUE && atBoundary.reason === FOLLOW_UP_REASON.CADENCE_EXHAUSTED).toBe(false);

    // dedupeKey muda porque `reason` faz parte da chave — mesma âncora, chaves diferentes
    expect(beforeBoundary.dedupeKey).toBe(`lead-1:cadence_exhausted:${a3.id}`);
    expect(atBoundary.dedupeKey).toBe(`lead-1:reactivation_due:${a3.id}`);
    expect(beforeBoundary.dedupeKey).not.toBe(atBoundary.dedupeKey);
  });
});

describe('Fase 2C.1.1 — precedência em timestamp idêntico (congelando o comportamento atual)', () => {
  it('proposal_sent e whatsapp_sent no mesmo instante -> attempt vence proposal', () => {
    const sameTime = hoursAgo(10);
    const proposal = makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt: sameTime, metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } });
    const whatsapp = makeInteraction({ type: 'whatsapp', direction: 'outbound', channel: 'whatsapp', occurredAt: sameTime, metadata: { activity_class: 'attempt', source: 'user' } });
    const r = evaluate(makeLead(), [proposal, whatsapp]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
  });

  it('customer engagement (inbound) e proposal_sent no mesmo instante -> engagement vence proposal', () => {
    const sameTime = hoursAgo(10);
    const proposal = makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt: sameTime, metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } });
    const received = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', occurredAt: sameTime, metadata: { activity_class: 'engagement', source: 'user' } });
    const r = evaluate(makeLead(), [proposal, received]);
    expect(r.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(r.anchorInteractionId).toBe(received.id);
  });
});

describe('Fase 2C.1.1 — blocker de automation é incondicional (vence qualquer reason subjacente)', () => {
  it('sem task automation -> no_response_after_attempt; com task automation pendente -> blocked, independente do reason que existiria', () => {
    const attempt = makeInteraction({ occurredAt: hoursAgo(30) });
    const withoutAutomation = evaluate(makeLead(), [attempt], []);
    expect(withoutAutomation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(withoutAutomation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);

    const withAutomation = evaluate(makeLead(), [attempt], [makeTask({ origem: 'automation', categoria: 'Follow-up', concluida: false })]);
    expect(withAutomation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(withAutomation.reason).toBeNull();
    expect(withAutomation.blockers).toContain(FOLLOW_UP_BLOCKER.FOLLOW_UP_AUTOMATICO_PENDENTE);
  });

  it('o mesmo vale quando o reason subjacente seria no_response_after_proposal', () => {
    const proposal = makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt: hoursAgo(49), metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' } });
    const withoutAutomation = evaluate(makeLead(), [proposal], []);
    expect(withoutAutomation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);

    const withAutomation = evaluate(makeLead(), [proposal], [makeTask({ origem: 'automation', concluida: false })]);
    expect(withAutomation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
  });
});

describe('Fase 2C.1.1 — [semântica V1, sujeita a revisão futura] nova tentativa empurra a janela de reativação', () => {
  it('uma nova tentativa antes do vencimento muda a âncora e reinicia os 7 dias a partir dela', () => {
    const lead = makeLead();
    const a1 = makeInteraction({ occurredAt: '2026-09-01T00:00:00.000Z' });
    const a2 = makeInteraction({ occurredAt: '2026-09-10T00:00:00.000Z' });
    const a3 = makeInteraction({ occurredAt: '2026-09-20T00:00:00.000Z' }); // anchor original -> due em 2026-09-27
    const now1 = new Date('2026-09-26T00:00:00.000Z'); // antes do vencimento original

    const before = evaluate(lead, [a1, a2, a3], [], now1);
    expect(before.anchorOccurredAt).toBe(a3.occurredAt);
    expect(before.dueAt).toBe('2026-09-27T00:00:00.000Z');
    expect(before.reason).toBe(FOLLOW_UP_REASON.CADENCE_EXHAUSTED);

    const a4 = makeInteraction({ occurredAt: '2026-09-24T00:00:00.000Z' }); // nova tentativa Y, antes do vencimento de a3
    const after = evaluate(lead, [a1, a2, a3, a4], [], now1);
    expect(after.anchorOccurredAt).toBe(a4.occurredAt); // âncora mudou para Y
    expect(after.dueAt).toBe('2026-10-01T00:00:00.000Z'); // Y + 7 dias — janela reiniciada
    expect(after.reason).toBe(FOLLOW_UP_REASON.CADENCE_EXHAUSTED); // ainda dentro da nova janela, com now1 fixo
  });
});
