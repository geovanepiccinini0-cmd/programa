import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  buildFollowUpQueue, sortDueFollowUps, sortWaitingFollowUps, sortBlockedFollowUps,
  getDueFollowUps, getWaitingFollowUps, getBlockedFollowUps,
} from './followUpQueue.js';
import * as followUpEngineModule from './followUpEngine.js';
import { FOLLOW_UP_STATUS, FOLLOW_UP_REASON } from './followUpEngine.js';
import * as commercialInteractionHistoryModule from './commercialInteractionHistory.js';
import * as nextBestActionPolicyModule from './nextBestActionPolicy.js';
import * as nextBestActionShadowModule from './nextBestActionShadow.js';
import * as operationalRecommendationModule from './operationalRecommendation.js';
import * as nextBestActionPresentationModule from './nextBestActionPresentation.js';

// Fase 2C.2A — fila de follow-up (domínio puro). NOW fixo para
// determinismo.
const NOW = new Date('2026-10-10T12:00:00.000Z');
function hoursAgo(h) { return new Date(NOW.getTime() - h * 3600000).toISOString(); }
function daysAgo(d) { return hoursAgo(d * 24); }

function makeLead(overrides = {}) {
  return {
    id: 'lead-1',
    nome: 'Lilliane',
    etapa: 'Negociação',
    telefone: '54999999999',
    proximoContato: '',
    nextActionType: '',
    priority: 'normal',
    leadTemperature: '',
    createdAt: '2026-09-01T09:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

let idCounter = 0;
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
  return { id: 'task-1', leadId: 'lead-1', origem: 'lead-agenda', concluida: false, ...overrides };
}

function build(leads, interactions = [], tasks = [], now = NOW, policy) {
  return buildFollowUpQueue({ leads, interactions, tasks, now, ...(policy ? { policy } : {}) });
}

describe('Fase 2C.2A — buildFollowUpQueue', () => {
  it('1) coleção vazia -> fila vazia', () => {
    expect(build([])).toEqual([]);
  });

  it('2) um lead never_contacted', () => {
    const lead = makeLead();
    const queue = build([lead]);
    expect(queue).toHaveLength(1);
    expect(queue[0].lead).toBe(lead);
    expect(queue[0].error).toBeNull();
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
  });

  it('3) múltiplos leads: cada um recebe seu próprio item, na ordem recebida', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b' });
    const leadC = makeLead({ id: 'lead-c' });
    const queue = build([leadA, leadB, leadC]);
    expect(queue.map((item) => item.lead.id)).toEqual(['lead-a', 'lead-b', 'lead-c']);
  });

  it('4) interactions corretamente agrupadas por lead', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b' });
    const attemptA = makeInteraction({ leadId: 'lead-a', occurredAt: hoursAgo(30) }); // vencida -> due
    const queue = build([leadA, leadB], [attemptA]);
    const itemA = queue.find((i) => i.lead.id === 'lead-a');
    const itemB = queue.find((i) => i.lead.id === 'lead-b');
    expect(itemA.evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(itemA.evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(itemB.evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
  });

  it('5) interaction de lead A nunca influencia lead B', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b' });
    const manyAttemptsA = [
      makeInteraction({ leadId: 'lead-a', type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(10) }),
      makeInteraction({ leadId: 'lead-a', type: 'call', occurredAt: daysAgo(5) }),
      makeInteraction({ leadId: 'lead-a', type: 'call', metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' }, occurredAt: daysAgo(1) }),
    ];
    const queue = build([leadA, leadB], manyAttemptsA);
    const itemB = queue.find((i) => i.lead.id === 'lead-b');
    expect(itemB.evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
    expect(itemB.evaluation.attemptCount).toBe(0);
  });

  it('6) tasks corretamente agrupadas por lead', () => {
    const leadA = makeLead({ id: 'lead-a', proximoContato: '2026-12-01' });
    const leadB = makeLead({ id: 'lead-b' });
    const attemptB = makeInteraction({ leadId: 'lead-b', occurredAt: hoursAgo(30) });
    const taskA = makeTask({ leadId: 'lead-a' });
    const queue = build([leadA, leadB], [attemptB], [taskA]);
    const itemA = queue.find((i) => i.lead.id === 'lead-a');
    const itemB = queue.find((i) => i.lead.id === 'lead-b');
    expect(itemA.evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(itemB.evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('7) task de lead A nunca bloqueia lead B', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b' });
    const attemptB = makeInteraction({ leadId: 'lead-b', occurredAt: hoursAgo(30) });
    const taskA = makeTask({ leadId: 'lead-a' }); // lead-agenda pendente só de A
    const queue = build([leadA, leadB], [attemptB], [taskA]);
    const itemB = queue.find((i) => i.lead.id === 'lead-b');
    expect(itemB.evaluation.blockers).not.toContain('lead_agenda_pendente');
    expect(itemB.evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('8) Ganho continua retornado como blocked (não omitido da fila)', () => {
    const lead = makeLead({ etapa: 'Ganho' });
    const queue = build([lead]);
    expect(queue).toHaveLength(1);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(queue[0].evaluation.blockers).toContain('etapa_ganho');
  });

  it('9) Perdido continua retornado como blocked', () => {
    const lead = makeLead({ etapa: 'Perdido' });
    const queue = build([lead]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(queue[0].evaluation.blockers).toContain('etapa_perdido');
  });

  it('10) deleted continua retornado como blocked', () => {
    const lead = makeLead({ deletedAt: '2026-10-01T00:00:00.000Z' });
    const queue = build([lead]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(queue[0].evaluation.blockers).toContain('deleted');
  });

  it('11) due', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('12) waiting', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ occurredAt: hoursAgo(2) });
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING);
  });

  it('13) blocked', () => {
    const lead = makeLead({ proximoContato: '2026-12-25' });
    const queue = build([lead]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
  });

  it('14) due + sem_telefone', () => {
    const lead = makeLead({ telefone: '' });
    const attempt = makeInteraction({ occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(queue[0].evaluation.blockers).toContain('sem_telefone');
  });

  it('25) resultado preserva a evaluation completa do engine (nenhum campo descartado)', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    const keys = Object.keys(queue[0].evaluation).sort();
    expect(keys).toEqual(
      ['anchorInteractionId', 'anchorOccurredAt', 'attemptCount', 'blockers', 'dedupeKey', 'dueAt', 'eligible', 'reason', 'since', 'status', 'suggestedAction'].sort(),
    );
  });

  it('26) erro isolado de um lead (malformado) não destrói a avaliação dos demais', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b' });
    const queue = build([null, leadA, leadB]);
    expect(queue).toHaveLength(3);
    expect(queue[0].lead).toBeNull();
    expect(queue[0].evaluation).toBeNull();
    expect(typeof queue[0].error).toBe('string');
    expect(queue[0].error.length).toBeGreaterThan(0);
    expect(queue[1].error).toBeNull();
    expect(queue[1].evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
    expect(queue[2].error).toBeNull();
    expect(queue[2].evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
  });

  it('20) interactions fora de ordem de inserção produzem o mesmo resultado', () => {
    const lead = makeLead();
    const older = makeInteraction({ occurredAt: hoursAgo(40) });
    const newer = makeInteraction({ occurredAt: hoursAgo(5) });
    const q1 = build([lead], [older, newer]);
    const q2 = build([lead], [newer, older]);
    expect(q1[0].evaluation.anchorOccurredAt).toBe(newer.occurredAt);
    expect(q2[0].evaluation.anchorOccurredAt).toBe(newer.occurredAt);
  });

  it('21) tasks fora de ordem não afetam o resultado', () => {
    const lead = makeLead();
    const t1 = makeTask({ id: 'a', concluida: true });
    const t2 = makeTask({ id: 'b', concluida: false });
    const q1 = build([lead], [], [t1, t2]);
    const q2 = build([lead], [], [t2, t1]);
    expect(q1[0].evaluation.blockers).toEqual(q2[0].evaluation.blockers);
  });

  it('22) inputs não mutados (leads/interactions/tasks congelados não geram erro)', () => {
    const leads = Object.freeze([Object.freeze(makeLead())]);
    const interactions = Object.freeze([Object.freeze(makeInteraction({ occurredAt: hoursAgo(30) }))]);
    const tasks = Object.freeze([]);
    expect(() => buildFollowUpQueue({ leads, interactions, tasks, now: NOW })).not.toThrow();
    expect(leads).toHaveLength(1);
    expect(interactions).toHaveLength(1);
  });

  it('23) now injetável: o mesmo histórico produz status diferente conforme `now`', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ occurredAt: hoursAgo(10) });
    const soon = build([lead], [attempt], [], new Date(NOW.getTime() - 9 * 3600000));
    const later = build([lead], [attempt], [], new Date(NOW.getTime() + 20 * 3600000));
    expect(soon[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(later[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
  });

  it('24) policy custom injetável', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ occurredAt: hoursAgo(2) });
    const defaultPolicy = build([lead], [attempt]);
    const customPolicy = build([lead], [attempt], [], NOW, { attempt: { hoursUntilDue: 1 }, proposal: { hoursUntilDue: 48 }, noNewAttemptSinceEngagement: { hoursUntilDue: 96 }, maxAttempts: 3, reactivationAfterMaxAttempts: { daysUntilDue: 7 } });
    expect(defaultPolicy[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING); // 2h < 24h padrão
    expect(customPolicy[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE); // 2h >= 1h customizado
  });

  it('Fase 2C.2A.1 — policy customizada (congelada) não é mutada; buildFollowUpQueue só repassa ao engine', () => {
    const customPolicy = Object.freeze({
      attempt: Object.freeze({ hoursUntilDue: 1 }),
      proposal: Object.freeze({ hoursUntilDue: 48 }),
      noNewAttemptSinceEngagement: Object.freeze({ hoursUntilDue: 96 }),
      maxAttempts: 3,
      reactivationAfterMaxAttempts: Object.freeze({ daysUntilDue: 7 }),
    });
    const lead = makeLead();
    const attempt = makeInteraction({ occurredAt: hoursAgo(2) });

    expect(() => build([lead], [attempt], [], NOW, customPolicy)).not.toThrow();
  });
});

describe('Fase 2E.3 — Next Best Action (shadow/display-only) dentro de buildFollowUpQueue', () => {
  it('A) Due never_contacted + explicit whatsapp -> nbaPresentation = WhatsApp / Primeiro contato', () => {
    const lead = makeLead({ nextActionType: 'whatsapp' });
    const queue = build([lead]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Primeiro contato' });
  });

  it('B) Due no_response_after_attempt (call vencida) -> nbaPresentation = Ligação / Nova tentativa de contato', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'call', channel: 'phone', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Nova tentativa de contato' });
  });

  it('C) Due no_response_after_attempt (whatsapp vencida) -> nbaPresentation = WhatsApp / Nova tentativa de contato', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_ATTEMPT);
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Nova tentativa de contato' });
  });

  it('D) Due reactivation_due -> reasonLabel "Reativação" (Fase 2E.5.1B: actionLabel agora reflete a alternância operacional da Commercial Policy, não mais o último canal repetido)', () => {
    const lead = makeLead();
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(20) }),
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(15) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(10) }),
    ];
    const queue = build([lead], attempts);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.REACTIVATION_DUE);
    expect(queue[0].nbaPresentation.reasonLabel).toBe('Reativação');
    // último canal tentado foi 'call' -> Commercial Policy alterna para whatsapp (operacional desde 2E.5.1B).
    expect(queue[0].nbaPresentation.actionLabel).toBe('WhatsApp');
  });

  it('E) Due no_response_after_proposal sem explicit -> nbaPresentation null', () => {
    const lead = makeLead();
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(60) });
    const queue = build([lead], [proposal]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(queue[0].nbaPresentation).toBeNull();
  });

  it('F) Due no_response_after_proposal + explicit whatsapp -> nbaPresentation = WhatsApp / Follow-up da proposta', () => {
    const lead = makeLead({ nextActionType: 'whatsapp' });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(60) });
    const queue = build([lead], [proposal]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Follow-up da proposta' });
  });

  it('G) Waiting carrega nbaPresentation internamente no item, sem mudar status/pertencimento à lista', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(2) }); // dentro da janela de 24h -> waiting
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Nova tentativa de contato' });
    // o item carrega o metadado, mas sortWaitingFollowUps/getWaitingFollowUps continuam filtrando só por status.
    expect(getWaitingFollowUps(queue)).toHaveLength(1);
    expect(getDueFollowUps(queue)).toHaveLength(0);
  });

  it('H) Blocked -> nbaPresentation null, mesmo com nextActionType explícito válido', () => {
    const lead = makeLead({ etapa: 'Ganho', nextActionType: 'whatsapp' });
    const queue = build([lead]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(queue[0].nbaPresentation).toBeNull();
  });

  it('I) erro isolado de um lead (malformado) continua isolado -- nbaPresentation null nesse item, os demais corretos', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b', nextActionType: 'call' });
    const queue = build([null, leadA, leadB]);
    expect(queue[0].evaluation).toBeNull();
    expect(queue[0].nbaPresentation).toBeNull();
    expect(typeof queue[0].error).toBe('string');
    // Fase 2E.5.1B: never_contacted sem explicit agora É uma recomendação
    // operacional válida (Commercial Policy V1 recomenda Ligação) — antes
    // da ativação (2E.4.3), isso era null (NBA legado exigia explicit).
    expect(queue[1].nbaPresentation).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Primeiro contato' });
    expect(queue[2].nbaPresentation).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Primeiro contato' });
  });

  it('J) contagens due/waiting/blocked não mudam com a adição do metadado nbaPresentation', () => {
    const due = makeLead({ id: 'due', nextActionType: 'whatsapp' });
    const waiting = makeLead({ id: 'waiting' });
    const blocked = makeLead({ id: 'blocked', proximoContato: '2026-12-25' });
    const queue = build(
      [due, waiting, blocked],
      [
        makeInteraction({ leadId: 'due', occurredAt: hoursAgo(30) }),
        makeInteraction({ leadId: 'waiting', occurredAt: hoursAgo(2) }),
      ],
    );
    // mesmas contagens/pertencimento de sempre (2C.2A/2C.2B), independente de nbaPresentation existir ou não por item.
    expect(getDueFollowUps(queue).map((i) => i.lead.id)).toEqual(['due']);
    expect(getWaitingFollowUps(queue).map((i) => i.lead.id)).toEqual(['waiting']);
    expect(getBlockedFollowUps(queue).map((i) => i.lead.id)).toEqual(['blocked']);
    expect(sortDueFollowUps(queue)).toHaveLength(1);
    expect(sortWaitingFollowUps(queue)).toHaveLength(1);
    expect(sortBlockedFollowUps(queue)).toHaveLength(1);
  });
});

describe('Fase 2E.4.3 — Shadow comparison (Commercial Policy V1) dentro de buildFollowUpQueue', () => {
  it('G) never_contacted: current=null (NBA V1 exige explicit), candidate=call/phone/first_contact/rule -> candidate_only', () => {
    const lead = makeLead();
    const queue = build([lead]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
    expect(queue[0].nbaShadow.current).toBeNull();
    expect(queue[0].nbaShadow.candidate).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
    expect(queue[0].nbaShadow.status).toBe('candidate_only');
  });

  it('H) attempt 1 (call vencida, sem explicit): current e candidate coincidem -> match', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.attemptCount).toBe(1);
    expect(queue[0].nbaShadow.status).toBe('match');
    expect(queue[0].nbaShadow.current).toEqual(queue[0].nbaShadow.candidate);
  });

  it('I) attempt >=2 (duas calls sem resposta): current repete call, candidate alterna para whatsapp -> changed_action', () => {
    const lead = makeLead();
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(3) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) }),
    ];
    const queue = build([lead], attempts);
    expect(queue[0].evaluation.attemptCount).toBe(2);
    expect(queue[0].nbaShadow.current.type).toBe('call');
    expect(queue[0].nbaShadow.candidate).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'switch_channel', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
    expect(queue[0].nbaShadow.status).toBe('changed_action');
  });

  it('J) cadence_exhausted: current repete último canal, candidate alterna -> changed_action', () => {
    const lead = makeLead();
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(10) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(3) }),
    ];
    const queue = build([lead], attempts);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.CADENCE_EXHAUSTED);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(queue[0].nbaShadow.current.channel).toBe('phone');
    expect(queue[0].nbaShadow.candidate).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'switch_channel', reasonCode: 'cadence_exhausted', confidence: 'rule' });
    expect(queue[0].nbaShadow.status).toBe('changed_action');
  });

  it('K) reactivation_due: current repete último canal (whatsapp), candidate alterna para call -> changed_action', () => {
    const lead = makeLead();
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(20) }),
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(15) }),
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(10) }),
    ];
    const queue = build([lead], attempts);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.REACTIVATION_DUE);
    expect(queue[0].nbaShadow.current.channel).toBe('whatsapp');
    expect(queue[0].nbaShadow.candidate).toEqual({ type: 'call', channel: 'phone', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'rule' });
    expect(queue[0].nbaShadow.status).toBe('changed_action');
  });

  it('L) engagement (teste central): 10:00 call_no_answer, +24h whatsapp_received, após janela de 96h -> current usa a tentativa anterior (call), candidate usa o canal do engajamento (whatsapp) -> changed_action', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) });
    const engagement = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: daysAgo(5) });
    const queue = build([lead], [attempt, engagement]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(queue[0].nbaShadow.current).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
    expect(queue[0].nbaShadow.candidate).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'continue_conversation', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
    expect(queue[0].nbaShadow.status).toBe('changed_action');
  });

  it('M/N) proposal sem engagement: current=null (gate anti-leak 2E.1), candidate=null -> both_null; evaluation.suggestedAction continua vazando "call" (nível do engine, isolado do NBA)', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(2) });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) });
    const queue = build([lead], [attempt, proposal]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(queue[0].evaluation.suggestedAction).toEqual({ type: 'call', channel: 'phone' }); // leak confirmado no engine
    expect(queue[0].nbaShadow.current).toBeNull();
    expect(queue[0].nbaShadow.candidate).toBeNull();
    expect(queue[0].nbaShadow.status).toBe('both_null');
  });

  it('O) proposal com engagement phone anterior: current=null, candidate=call/phone/proposal_follow_up -> candidate_only', () => {
    const lead = makeLead();
    const engagement = makeInteraction({ type: 'call', metadata: { activity_class: 'engagement', outcome: 'connected' }, occurredAt: hoursAgo(2) });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) });
    const queue = build([lead], [engagement, proposal]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(queue[0].nbaShadow.current).toBeNull();
    expect(queue[0].nbaShadow.candidate).toEqual({ type: 'call', channel: 'phone', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'rule' });
    expect(queue[0].nbaShadow.status).toBe('candidate_only');
  });

  it('P) proposal com engagement whatsapp anterior: candidate=whatsapp/proposal_follow_up -> candidate_only', () => {
    const lead = makeLead();
    const engagement = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: hoursAgo(2) });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) });
    const queue = build([lead], [engagement, proposal]);
    expect(queue[0].nbaShadow.candidate).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'rule' });
    expect(queue[0].nbaShadow.status).toBe('candidate_only');
  });

  it('Q/R/S/T) explicit call/whatsapp/meeting/proposal em never_contacted: current e candidate coincidem -> match', () => {
    ['call', 'whatsapp', 'meeting', 'proposal'].forEach((nextActionType) => {
      const lead = makeLead({ nextActionType });
      const queue = build([lead]);
      expect(queue[0].nbaShadow.status).toBe('match');
      expect(queue[0].nbaShadow.current.confidence).toBe('explicit');
      expect(queue[0].nbaShadow.candidate.confidence).toBe('explicit');
      expect(queue[0].nbaShadow.current.type).toBe(nextActionType);
    });
  });

  it('explicit em no_new_attempt_since_engagement: type/channel/confidence/reasonCode coincidem, mas intent diverge (retry vs continue_conversation) -> changed_action, reportado exatamente (não maquiado)', () => {
    const lead = makeLead({ nextActionType: 'call' });
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) });
    const engagement = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: daysAgo(5) });
    const queue = build([lead], [attempt, engagement]);
    const { current, candidate, status } = queue[0].nbaShadow;
    expect(current.type).toBe('call');
    expect(candidate.type).toBe('call');
    expect(current.channel).toBe(candidate.channel);
    expect(current.confidence).toBe(candidate.confidence);
    expect(current.reasonCode).toBe(candidate.reasonCode);
    expect(current.intent).toBe('retry'); // NBA V1 (REASON_INTENT antigo)
    expect(candidate.intent).toBe('continue_conversation'); // Policy V1 (REASON_INTENT novo)
    expect(status).toBe('changed_action'); // divergência real, não escondida
  });

  it('U) follow_up: current cai no fallthrough legado do engine (infere pela última tentativa, NÃO null), candidate suprime -> current_only', () => {
    const lead = makeLead({ nextActionType: 'follow_up' });
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    expect(queue[0].nbaShadow.current).not.toBeNull(); // comportamento legado real: NÃO é null
    expect(queue[0].nbaShadow.current.type).toBe('call');
    expect(queue[0].nbaShadow.candidate).toBeNull();
    expect(queue[0].nbaShadow.status).toBe('current_only');
  });

  it('V) other: mesmo comportamento de U (current_only)', () => {
    const lead = makeLead({ nextActionType: 'other' });
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(30) });
    const queue = build([lead], [attempt]);
    expect(queue[0].nbaShadow.current).not.toBeNull();
    expect(queue[0].nbaShadow.candidate).toBeNull();
    expect(queue[0].nbaShadow.status).toBe('current_only');
  });

  it('W/AF) blocked (Ganho/Perdido/deleted/agenda pendente): current=null, candidate=null -> both_null, mesmo com explicit válido; comportamento terminal do item inalterado', () => {
    const ganho = makeLead({ id: 'ganho', etapa: 'Ganho', nextActionType: 'whatsapp' });
    const queue = build([ganho]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(queue[0].nbaShadow).toEqual({ status: 'both_null', current: null, candidate: null });
  });

  it('X) waiting: shadow é calculado normalmente mesmo fora de due (observação futura, sem nenhuma UI nova)', () => {
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(2) }); // dentro de 24h -> waiting
    const queue = build([lead], [attempt]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(queue[0].nbaShadow).not.toBeNull();
    expect(queue[0].nbaShadow.status).toBe('match'); // attempt 1, sem divergência aprovada nesta rodada
  });

  it('Y) mesmo dataset: interactions de um lead nunca contaminam o nbaShadow.candidate de outro lead', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b' });
    const engagementA = makeInteraction({ leadId: 'lead-a', type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: daysAgo(5) });
    const attemptA = makeInteraction({ leadId: 'lead-a', type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) });
    const queue = build([leadA, leadB], [attemptA, engagementA]);
    const itemB = queue.find((i) => i.lead.id === 'lead-b');
    expect(itemB.evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
    expect(itemB.nbaShadow.candidate).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
    expect(itemB.nbaShadow.status).toBe('candidate_only'); // nunca herda o "whatsapp" de lead-a
  });

  it('Z) [SUPERADO PELA 2E.5.1B] nbaPresentation agora é derivado do candidate/operational, não mais do current, mesmo quando shadow.status=changed_action', () => {
    // Até a 2E.4.3 (Shadow Mode), este teste provava o inverso: que
    // nbaPresentation SÓ refletia o current, nunca o candidate — essa
    // era exatamente a garantia de "Shadow Mode nunca altera UI". A
    // Fase 2E.5.1B inverte essa garantia DE PROPÓSITO: agora o
    // candidate (via operationalRecommendation) é a fonte operacional,
    // e nbaShadow.current preserva o valor antigo só para auditoria.
    const lead = makeLead();
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) });
    const engagement = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: daysAgo(5) });
    const queue = build([lead], [attempt, engagement]);
    expect(queue[0].nbaShadow.status).toBe('changed_action');
    // nbaShadow.current preserva o valor antigo (auditoria), mas NÃO alimenta mais nbaPresentation:
    expect(queue[0].nbaShadow.current).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
    expect(queue[0].nbaShadow.candidate.channel).toBe('whatsapp');
    expect(queue[0].operationalRecommendation).toEqual(queue[0].nbaShadow.candidate);
    // nbaPresentation agora reflete o OPERACIONAL (candidate/whatsapp), nunca mais o current (call):
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Retomar após resposta do cliente' });
  });

  it('AB) contagens due/waiting/blocked permanecem idênticas com nbaShadow presente no item', () => {
    const due = makeLead({ id: 'due', nextActionType: 'whatsapp' });
    const waiting = makeLead({ id: 'waiting' });
    const blocked = makeLead({ id: 'blocked', proximoContato: '2026-12-25' });
    const queue = build(
      [due, waiting, blocked],
      [
        makeInteraction({ leadId: 'due', occurredAt: hoursAgo(30) }),
        makeInteraction({ leadId: 'waiting', occurredAt: hoursAgo(2) }),
      ],
    );
    expect(getDueFollowUps(queue).map((i) => i.lead.id)).toEqual(['due']);
    expect(getWaitingFollowUps(queue).map((i) => i.lead.id)).toEqual(['waiting']);
    expect(getBlockedFollowUps(queue).map((i) => i.lead.id)).toEqual(['blocked']);
    expect(queue.every((i) => 'nbaShadow' in i)).toBe(true);
  });

  it('AC) inputs congelados (leads/interactions/tasks) continuam não gerando erro com o shadow calculado', () => {
    const leads = Object.freeze([Object.freeze(makeLead())]);
    const interactions = Object.freeze([Object.freeze(makeInteraction({ occurredAt: hoursAgo(30) }))]);
    const tasks = Object.freeze([]);
    let queue;
    expect(() => { queue = buildFollowUpQueue({ leads, interactions, tasks, now: NOW }); }).not.toThrow();
    expect(queue[0].nbaShadow).not.toBeNull();
  });

  it('AD/AE) interaction malformada/tipo desconhecido misturada ao histórico -> shadow ainda calculado com segurança, sem afetar o item', () => {
    const lead = makeLead();
    const good = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) });
    const unknown = makeInteraction({ type: 'mystery', metadata: { activity_class: 'attempt' }, occurredAt: hoursAgo(10) });
    const noTimestamp = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: undefined });
    const queue = build([lead], [good, unknown, noTimestamp]);
    expect(queue[0].error).toBeNull();
    expect(queue[0].nbaShadow).not.toBeNull();
    expect(queue[0].nbaShadow.status).toBe('match'); // só "good" conta, igual ao teste H
  });

  it('erro isolado de lead malformado -> nbaShadow null nesse item, demais itens com shadow normal', () => {
    const leadA = makeLead({ id: 'lead-a' });
    const leadB = makeLead({ id: 'lead-b' });
    const queue = build([null, leadA, leadB]);
    expect(queue[0].nbaShadow).toBeNull();
    expect(queue[1].nbaShadow).not.toBeNull();
    expect(queue[2].nbaShadow).not.toBeNull();
  });
});

describe('Fase 2E.4.3.2 — isolamento de falha do shadow (fail-open)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('A-G) Due: throw exclusivo em evaluateNextBestActionPolicy -> item sobrevive intacto, só nbaShadow vira null', () => {
    vi.spyOn(nextBestActionPolicyModule, 'evaluateNextBestActionPolicy').mockImplementation(() => { throw new Error('bug exclusivo do shadow, simulado'); });

    const lead = makeLead(); // never_contacted -> due
    const queue = build([lead]);

    expect(queue).toHaveLength(1); // A) item continua existindo
    expect(queue[0].evaluation).not.toBeNull(); // B)
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE); // C)
    expect(queue[0].nbaPresentation).toBeNull(); // D) igual ao current (never_contacted sem explicit -> null, inalterado)
    expect(queue[0].error).toBeNull(); // E)
    expect(queue[0].nbaShadow).toBeNull(); // F)
    expect(getDueFollowUps(queue).map((i) => i.lead.id)).toEqual([lead.id]); // G)
  });

  it('8) Waiting: throw exclusivo no shadow -> lead continua em getWaitingFollowUps, evaluation/nbaPresentation preservados', () => {
    vi.spyOn(nextBestActionPolicyModule, 'evaluateNextBestActionPolicy').mockImplementation(() => { throw new Error('bug exclusivo do shadow, simulado'); });

    const lead = makeLead();
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(2) }); // dentro de 24h -> waiting
    const queue = build([lead], [attempt]);

    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Nova tentativa de contato' }); // comportamento atual preservado
    expect(queue[0].nbaShadow).toBeNull();
    expect(queue[0].error).toBeNull();
    expect(getWaitingFollowUps(queue).map((i) => i.lead.id)).toEqual([lead.id]);
  });

  it('9) Blocked: throw exclusivo no shadow -> lead continua em getBlockedFollowUps, evaluation preservada', () => {
    vi.spyOn(nextBestActionPolicyModule, 'evaluateNextBestActionPolicy').mockImplementation(() => { throw new Error('bug exclusivo do shadow, simulado'); });

    const lead = makeLead({ etapa: 'Ganho' });
    const queue = build([lead]);

    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(queue[0].nbaShadow).toBeNull();
    expect(queue[0].error).toBeNull();
    expect(getBlockedFollowUps(queue).map((i) => i.lead.id)).toEqual([lead.id]);
  });

  it('10) caminho operacional REAL continua com a semântica antiga de erro (catch interno não esconde falha de evaluateFollowUpEligibility)', () => {
    vi.spyOn(followUpEngineModule, 'evaluateFollowUpEligibility').mockImplementation(() => { throw new Error('falha real no motor'); });

    const lead = makeLead();
    const queue = build([lead]);

    expect(queue[0].evaluation).toBeNull();
    expect(queue[0].error).toBe('falha real no motor');
    expect(queue[0].nbaPresentation).toBeNull();
    expect(queue[0].nbaShadow).toBeNull();
    expect(getDueFollowUps(queue)).toHaveLength(0);
  });

  it('11) history throw -> mesma proteção (nbaShadow null, item operacional preservado)', () => {
    vi.spyOn(commercialInteractionHistoryModule, 'buildCommercialInteractionHistory').mockImplementation(() => { throw new Error('bug exclusivo do history, simulado'); });

    const lead = makeLead();
    const queue = build([lead]);

    expect(queue[0].evaluation).not.toBeNull();
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(queue[0].error).toBeNull();
    expect(queue[0].nbaShadow).toBeNull();
  });

  it('12) comparator throw -> mesma proteção (nbaShadow null, item operacional preservado)', () => {
    vi.spyOn(nextBestActionShadowModule, 'compareNextBestActions').mockImplementation(() => { throw new Error('bug exclusivo do comparator, simulado'); });

    const lead = makeLead();
    const queue = build([lead]);

    expect(queue[0].evaluation).not.toBeNull();
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(queue[0].error).toBeNull();
    expect(queue[0].nbaShadow).toBeNull();
  });

  it('13) sem erro: todos os resultados da 2E.4.3 permanecem exatamente iguais (regressão zero no caminho feliz)', () => {
    const lead = makeLead();
    const queue = build([lead]);
    expect(queue[0].nbaShadow.status).toBe('candidate_only'); // never_contacted, igual à 2E.4.3
  });
});

describe('Fase 2E.5.1B — ativação operacional (Commercial Policy V1 controla recommendation/CTA)', () => {
  // Fase 2E.5.1B.2 — hardening de higiene de mock (achado da auditoria
  // 2E.5.1B.1, item 28): sem este afterEach, um `vi.spyOn(...)` cujo
  // `vi.restoreAllMocks()` manual está posicionado DEPOIS das
  // assertions nunca executa se a própria assertion lançar — o mock
  // vaza para os testes seguintes e causa falhas em cascata não
  // relacionadas, mascarando a causa real. Mesmo padrão já usado no
  // describe 'Fase 2E.4.3.2' (linha 619) — rede de segurança
  // independente de qualquer `vi.restoreAllMocks()` manual dentro de um
  // teste específico (que continuam, redundantes mas inofensivos).
  afterEach(() => { vi.restoreAllMocks(); });

  it('1) never_contacted sem explicit -> operational call/phone, nbaPresentation Ligação/Primeiro contato', () => {
    const queue = build([makeLead()]);
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Primeiro contato' });
  });

  it('2) attempt1 call -> operational repete call', () => {
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) });
    const queue = build([makeLead()], [attempt]);
    expect(queue[0].evaluation.attemptCount).toBe(1);
    expect(queue[0].operationalRecommendation.type).toBe('call');
    expect(queue[0].operationalRecommendation.intent).toBe('retry');
  });

  it('3) attempt1 whatsapp -> operational repete whatsapp', () => {
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(30) });
    const queue = build([makeLead()], [attempt]);
    expect(queue[0].operationalRecommendation.type).toBe('whatsapp');
  });

  it('4) attempt>=2 call -> operational alterna para whatsapp', () => {
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(3) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) }),
    ];
    const queue = build([makeLead()], attempts);
    expect(queue[0].evaluation.attemptCount).toBe(2);
    expect(queue[0].operationalRecommendation).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'switch_channel', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Nova tentativa de contato' });
  });

  it('5) attempt>=2 whatsapp -> operational alterna para call', () => {
    const attempts = [
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(3) }),
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(30) }),
    ];
    const queue = build([makeLead()], attempts);
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'switch_channel', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('6) cadence_exhausted: operational existe internamente, mas status continua waiting (timing do engine intocado)', () => {
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(10) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(3) }),
    ];
    const queue = build([makeLead()], attempts);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.CADENCE_EXHAUSTED);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.WAITING);
    expect(queue[0].operationalRecommendation).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'switch_channel', reasonCode: 'cadence_exhausted', confidence: 'rule' });
  });

  it('7) reactivation call->whatsapp (ver também teste D acima)', () => {
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(20) }),
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(15) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(10) }),
    ];
    const queue = build([makeLead()], attempts);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.REACTIVATION_DUE);
    expect(queue[0].operationalRecommendation.type).toBe('whatsapp');
  });

  it('8) reactivation whatsapp->call', () => {
    const attempts = [
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(20) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(15) }),
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(10) }),
    ];
    const queue = build([makeLead()], attempts);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.REACTIVATION_DUE);
    expect(queue[0].operationalRecommendation.type).toBe('call');
  });

  it('9) engagement phone -> operational call, presentation "Retomar após resposta do cliente"', () => {
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(6) });
    const engagement = makeInteraction({ type: 'call', metadata: { activity_class: 'engagement', outcome: 'connected' }, occurredAt: daysAgo(5) });
    const queue = build([makeLead()], [attempt, engagement]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'continue_conversation', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Retomar após resposta do cliente' });
  });

  it('10) engagement whatsapp -> operational whatsapp', () => {
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(6) });
    const engagement = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: daysAgo(5) });
    const queue = build([makeLead()], [attempt, engagement]);
    expect(queue[0].operationalRecommendation.type).toBe('whatsapp');
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Retomar após resposta do cliente' });
  });

  it('11) engagement in_person (meeting_held) -> operational null, nbaPresentation null', () => {
    const engagement = makeInteraction({ type: 'meeting', channel: 'in_person', metadata: { activity_class: 'engagement', outcome: 'held' }, occurredAt: daysAgo(5) });
    const queue = build([makeLead()], [engagement]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_NEW_ATTEMPT_SINCE_ENGAGEMENT);
    expect(queue[0].operationalRecommendation).toBeNull();
    expect(queue[0].nbaPresentation).toBeNull();
  });

  it('12) proposal com engagement phone anterior -> operational call', () => {
    const engagement = makeInteraction({ type: 'call', metadata: { activity_class: 'engagement', outcome: 'connected' }, occurredAt: hoursAgo(2) });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) });
    const queue = build([makeLead()], [engagement, proposal]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'rule' });
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Follow-up da proposta' });
  });

  it('13) proposal com engagement whatsapp anterior -> operational whatsapp', () => {
    const engagement = makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement' }, occurredAt: hoursAgo(2) });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) });
    const queue = build([makeLead()], [engagement, proposal]);
    expect(queue[0].operationalRecommendation.type).toBe('whatsapp');
  });

  it('14) proposal sem engagement confiável -> operational null (gate anti-Proposal-Leak permanece ativo mesmo operacional)', () => {
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(2) });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) });
    const queue = build([makeLead()], [attempt, proposal]);
    expect(queue[0].evaluation.reason).toBe(FOLLOW_UP_REASON.NO_RESPONSE_AFTER_PROPOSAL);
    expect(queue[0].evaluation.suggestedAction).toEqual({ type: 'call', channel: 'phone' }); // leak confirmado no engine, isolado
    expect(queue[0].operationalRecommendation).toBeNull();
    expect(queue[0].nbaPresentation).toBeNull();
  });

  ['call', 'whatsapp', 'meeting', 'proposal'].forEach((type) => {
    it(`15-18) explicit ${type} -> operational reflete o tipo explícito`, () => {
      const queue = build([makeLead({ nextActionType: type })]);
      expect(queue[0].operationalRecommendation.type).toBe(type);
      expect(queue[0].operationalRecommendation.confidence).toBe('explicit');
    });
  });

  it('19) explicit follow_up -> operational null (Policy suprime, mesmo com histórico inferível)', () => {
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) });
    const queue = build([makeLead({ nextActionType: 'follow_up' })], [attempt]);
    expect(queue[0].operationalRecommendation).toBeNull();
    expect(queue[0].nbaPresentation).toBeNull();
  });

  it('20) explicit other -> operational null', () => {
    const attempt = makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(30) });
    const queue = build([makeLead({ nextActionType: 'other' })], [attempt]);
    expect(queue[0].operationalRecommendation).toBeNull();
    expect(queue[0].nbaPresentation).toBeNull();
  });

  it('21) blocked -> operational null', () => {
    const queue = build([makeLead({ etapa: 'Ganho' })]);
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.BLOCKED);
    expect(queue[0].operationalRecommendation).toBeNull();
    expect(queue[0].nbaPresentation).toBeNull();
  });

  it('22) candidate null VÁLIDO (proposal sem engagement) != fallback técnico: operational continua null, nunca current', () => {
    const attempt = makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(2) });
    const proposal = makeInteraction({ type: 'proposal', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent' }, occurredAt: hoursAgo(1) });
    const queue = build([makeLead()], [attempt, proposal]);
    // current também seria null aqui (gate 2E.1), então este cenário por si
    // não distingue — o ponto crítico é confirmar que NENHUM dos dois é
    // usado como fallback do outro: nbaShadow prova ambos null por vias
    // independentes (both_null), e operational é null por SELEÇÃO, não
    // por fallback técnico (nenhum throw ocorreu).
    expect(queue[0].nbaShadow.status).toBe('both_null');
    expect(queue[0].operationalRecommendation).toBeNull();
    expect(queue[0].error).toBeNull(); // confirma que não passou pelo catch de erro técnico
  });

  it('23) evaluateNextBestActionPolicy throws -> fallback TÉCNICO para current (nunca null fabricado)', () => {
    vi.spyOn(nextBestActionPolicyModule, 'evaluateNextBestActionPolicy').mockImplementation(() => { throw new Error('falha técnica simulada'); });
    const queue = build([makeLead({ nextActionType: 'call' })]); // explicit -> current != null, prova que o fallback é real
    expect(queue[0].error).toBeNull();
    expect(queue[0].nbaShadow).toBeNull(); // boundary 2 nem é tentado quando boundary 1 falha
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit' });
    vi.restoreAllMocks();
  });

  it('24) buildCommercialInteractionHistory throws -> mesmo fallback técnico para current', () => {
    vi.spyOn(commercialInteractionHistoryModule, 'buildCommercialInteractionHistory').mockImplementation(() => { throw new Error('falha técnica simulada'); });
    const queue = build([makeLead({ nextActionType: 'whatsapp' })]);
    expect(queue[0].error).toBeNull();
    expect(queue[0].nbaShadow).toBeNull();
    expect(queue[0].operationalRecommendation.type).toBe('whatsapp');
    expect(queue[0].operationalRecommendation.confidence).toBe('explicit');
    vi.restoreAllMocks();
  });

  it('25) comparator throws (candidate calculado com sucesso) -> operational continua = candidate, só nbaShadow vira null', () => {
    vi.spyOn(nextBestActionShadowModule, 'compareNextBestActions').mockImplementation(() => { throw new Error('falha técnica simulada no comparator'); });
    const queue = build([makeLead()]); // never_contacted sem explicit -> candidate real = call/phone/rule
    expect(queue[0].error).toBeNull();
    expect(queue[0].nbaShadow).toBeNull();
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
    vi.restoreAllMocks();
  });

  it('26) current/candidate divergence real: operational segue candidate, nbaShadow preserva os dois para auditoria', () => {
    const attempts = [
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: daysAgo(3) }),
      makeInteraction({ type: 'call', metadata: { activity_class: 'attempt', outcome: 'no_answer' }, occurredAt: hoursAgo(30) }),
    ];
    const queue = build([makeLead()], attempts);
    expect(queue[0].nbaShadow.status).toBe('changed_action');
    expect(queue[0].nbaShadow.current.type).toBe('call');
    expect(queue[0].nbaShadow.candidate.type).toBe('whatsapp');
    expect(queue[0].operationalRecommendation).toEqual(queue[0].nbaShadow.candidate);
  });

  it('27) operational presentation reflete o candidate (coerência type/channel/reasonCode/intent preservada pelo gate de presentation)', () => {
    const attempts = [
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: daysAgo(3) }),
      makeInteraction({ type: 'whatsapp', channel: 'whatsapp', occurredAt: hoursAgo(30) }),
    ];
    const queue = build([makeLead()], attempts);
    expect(queue[0].nbaPresentation).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Nova tentativa de contato' });
  });

  it('28) source centralizado: ACTIVE_OPERATIONAL_SOURCE é lido de operationalRecommendation.js, nunca uma string solta duplicada', () => {
    // Prova indireta: o próprio comportamento acima (candidate controlando
    // operational) só é possível porque a constante está configurada para
    // COMMERCIAL_POLICY — não há teste direto de uma constante privada do
    // módulo, mas o grep de produção (auditoria) confirma zero duplicação
    // da string 'commercial_policy' fora de operationalRecommendation.js
    // e followUpQueue.js (um único ponto de leitura).
    const queue = build([makeLead()]);
    expect(queue[0].operationalRecommendation).not.toBeNull(); // prova que a fonte ativa é commercial_policy, não current (que seria null aqui)
  });

  // Fase 2E.5.1B.2 — hardening (Boundary 3/4). Testes 29-31: selector e
  // presentation ganham o mesmo tratamento de erro técnico que history/
  // policy/comparator já tinham — nunca degradam o item inteiro, nunca
  // confundem erro técnico com decisão semântica.

  it('29) selectOperationalRecommendation throws -> fallback TÉCNICO para current (não vira error do item, lead não desaparece da fila)', () => {
    vi.spyOn(operationalRecommendationModule, 'selectOperationalRecommendation').mockImplementation(() => { throw new Error('bug inesperado no seletor, simulado'); });
    const queue = build([makeLead({ nextActionType: 'call' })]); // explicit -> current != null, prova que o fallback é real
    expect(queue[0].evaluation).not.toBeNull();
    expect(queue[0].evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(queue[0].error).toBeNull();
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit' });
  });

  it('30) selectOperationalRecommendation throws com current=null e candidate!=null -> operational null É o fallback técnico (current), nunca o candidate — não pode se confundir com "candidate decidiu null"', () => {
    vi.spyOn(operationalRecommendationModule, 'selectOperationalRecommendation').mockImplementation(() => { throw new Error('bug inesperado no seletor, simulado'); });
    const queue = build([makeLead()]); // never_contacted sem explicit: current (legado) = null, candidate (Policy) = call/phone/first_contact
    expect(queue[0].error).toBeNull();
    expect(queue[0].operationalRecommendation).toBeNull(); // = current (null), não = candidate (que seria call/phone)
  });

  it('31) presentNextBestAction throws -> nbaPresentation vira null, operationalRecommendation PRESERVADA intacta, item não degrada', () => {
    vi.spyOn(nextBestActionPresentationModule, 'presentNextBestAction').mockImplementation(() => { throw new Error('bug inesperado na apresentação, simulado'); });
    const queue = build([makeLead()]); // never_contacted sem explicit -> candidate real = call/phone/rule
    expect(queue[0].evaluation).not.toBeNull();
    expect(queue[0].error).toBeNull();
    expect(queue[0].nbaPresentation).toBeNull();
    expect(queue[0].operationalRecommendation).toEqual({ type: 'call', channel: 'phone', intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'rule' });
  });
});

describe('Fase 2C.2A — sortDueFollowUps', () => {
  it('15) ranking: urgent > high > normal > low', () => {
    const urgent = makeLead({ id: 'u', priority: 'urgent' });
    const high = makeLead({ id: 'h', priority: 'high' });
    const normal = makeLead({ id: 'n', priority: 'normal' });
    const low = makeLead({ id: 'l', priority: 'low' });
    const attempts = [urgent, high, normal, low].map((l) => makeInteraction({ leadId: l.id, occurredAt: hoursAgo(30) }));
    const queue = build([low, normal, urgent, high], attempts);
    const sorted = sortDueFollowUps(queue);
    expect(sorted.map((i) => i.lead.id)).toEqual(['u', 'h', 'n', 'l']);
  });

  it('16) mesma priority: mais vencido primeiro', () => {
    const recent = makeLead({ id: 'recent' });
    const old = makeLead({ id: 'old' });
    const attemptRecent = makeInteraction({ leadId: 'recent', occurredAt: hoursAgo(25) }); // venceu há pouco
    const attemptOld = makeInteraction({ leadId: 'old', occurredAt: hoursAgo(60) }); // venceu há mais tempo
    const queue = build([recent, old], [attemptRecent, attemptOld]);
    const sorted = sortDueFollowUps(queue);
    expect(sorted.map((i) => i.lead.id)).toEqual(['old', 'recent']);
  });

  it('17) empate de priority e dueAt: hot > warm > cold > vazio', () => {
    const sameTime = hoursAgo(30);
    const hot = makeLead({ id: 'hot', leadTemperature: 'hot' });
    const warm = makeLead({ id: 'warm', leadTemperature: 'warm' });
    const cold = makeLead({ id: 'cold', leadTemperature: 'cold' });
    const none = makeLead({ id: 'none', leadTemperature: '' });
    const attempts = [hot, warm, cold, none].map((l) => makeInteraction({ leadId: l.id, occurredAt: sameTime }));
    const queue = build([none, cold, warm, hot], attempts);
    const sorted = sortDueFollowUps(queue);
    expect(sorted.map((i) => i.lead.id)).toEqual(['hot', 'warm', 'cold', 'none']);
  });

  it('18) empate total: tie-break determinístico por nome+id', () => {
    const sameTime = hoursAgo(30);
    const leadB = makeLead({ id: 'lead-b', nome: 'Ana' });
    const leadA = makeLead({ id: 'lead-a', nome: 'Ana' }); // mesmo nome, id diferente
    const attempts = [leadA, leadB].map((l) => makeInteraction({ leadId: l.id, occurredAt: sameTime }));
    const queue = build([leadB, leadA], attempts);
    const sorted1 = sortDueFollowUps(queue);
    const sorted2 = sortDueFollowUps(build([leadB, leadA], attempts)); // recomputa do zero
    expect(sorted1.map((i) => i.lead.id)).toEqual(sorted2.map((i) => i.lead.id)); // determinístico
    expect(sorted1.map((i) => i.lead.id)).toEqual(['lead-a', 'lead-b']); // ordem alfabética por id após nome igual
  });

  it('19) sortDueFollowUps não muta o array recebido', () => {
    const leadA = makeLead({ id: 'a' });
    const leadB = makeLead({ id: 'b' });
    const attempts = [
      makeInteraction({ leadId: 'a', occurredAt: hoursAgo(30) }),
      makeInteraction({ leadId: 'b', occurredAt: hoursAgo(60) }),
    ];
    const queue = build([leadA, leadB], attempts);
    const originalOrder = queue.map((i) => i.lead.id);
    const frozenQueue = Object.freeze(queue);
    const sorted = sortDueFollowUps(frozenQueue);
    expect(queue.map((i) => i.lead.id)).toEqual(originalOrder); // original intacto
    expect(sorted).not.toBe(queue); // nova coleção
  });

  it('só itens due entram no resultado de sortDueFollowUps', () => {
    const due = makeLead({ id: 'due' });
    const waiting = makeLead({ id: 'waiting' });
    const blocked = makeLead({ id: 'blocked', proximoContato: '2026-12-25' });
    const queue = build(
      [due, waiting, blocked],
      [
        makeInteraction({ leadId: 'due', occurredAt: hoursAgo(30) }),
        makeInteraction({ leadId: 'waiting', occurredAt: hoursAgo(2) }),
      ],
    );
    const sorted = sortDueFollowUps(queue);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].lead.id).toBe('due');
  });

  it('Fase 2C.2A.1 — status due com dueAt=null (never_contacted sem createdAt): comportamento atual CONGELADO — comparator trata null como timestamp 0 (mais vencido dentro da mesma priority)', () => {
    const leadNullDue = makeLead({ id: 'null-due', createdAt: '' });
    const leadRealDue = makeLead({ id: 'real-due' });
    const attempt = makeInteraction({ leadId: 'real-due', occurredAt: hoursAgo(30) });

    const queue = build([leadRealDue, leadNullDue], [attempt]);
    const nullItem = queue.find((i) => i.lead.id === 'null-due');
    expect(nullItem.evaluation.status).toBe(FOLLOW_UP_STATUS.DUE);
    expect(nullItem.evaluation.reason).toBe(FOLLOW_UP_REASON.NEVER_CONTACTED);
    expect(nullItem.evaluation.dueAt).toBeNull();

    const sorted = sortDueFollowUps(queue);
    // dueAt=null -> tratado como timestamp 0 (1970), portanto "mais vencido" que qualquer dueAt real dentro da mesma priority.
    expect(sorted.map((i) => i.lead.id)).toEqual(['null-due', 'real-due']);
  });
});

describe('Fase 2C.2A — getDueFollowUps / getWaitingFollowUps / getBlockedFollowUps', () => {
  it('filtram puramente por status, sem recomputar nada', () => {
    const due = makeLead({ id: 'due' });
    const waiting = makeLead({ id: 'waiting' });
    const blocked = makeLead({ id: 'blocked', proximoContato: '2026-12-25' });
    const queue = build(
      [due, waiting, blocked],
      [
        makeInteraction({ leadId: 'due', occurredAt: hoursAgo(30) }),
        makeInteraction({ leadId: 'waiting', occurredAt: hoursAgo(2) }),
      ],
    );
    expect(getDueFollowUps(queue).map((i) => i.lead.id)).toEqual(['due']);
    expect(getWaitingFollowUps(queue).map((i) => i.lead.id)).toEqual(['waiting']);
    expect(getBlockedFollowUps(queue).map((i) => i.lead.id)).toEqual(['blocked']);
  });
});

describe('Fase 2C.2B — sortWaitingFollowUps', () => {
  it('só itens waiting entram no resultado', () => {
    const due = makeLead({ id: 'due' });
    const waiting = makeLead({ id: 'waiting' });
    const blocked = makeLead({ id: 'blocked', proximoContato: '2026-12-25' });
    const queue = build(
      [due, waiting, blocked],
      [
        makeInteraction({ leadId: 'due', occurredAt: hoursAgo(30) }),
        makeInteraction({ leadId: 'waiting', occurredAt: hoursAgo(2) }),
      ],
    );
    const sorted = sortWaitingFollowUps(queue);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].lead.id).toBe('waiting');
  });

  it('dueAt mais próximo de vencer primeiro (ordem crescente)', () => {
    const soon = makeLead({ id: 'soon' });
    const later = makeLead({ id: 'later' });
    const attemptSoon = makeInteraction({ leadId: 'soon', occurredAt: hoursAgo(23) }); // dueAt em 1h
    const attemptLater = makeInteraction({ leadId: 'later', occurredAt: hoursAgo(1) }); // dueAt em 23h
    const queue = build([later, soon], [attemptLater, attemptSoon]);
    const sorted = sortWaitingFollowUps(queue);
    expect(sorted.map((i) => i.lead.id)).toEqual(['soon', 'later']);
  });

  it('tie-break determinístico por nome+id quando dueAt é idêntico', () => {
    const sameAttemptTime = hoursAgo(2);
    const leadB = makeLead({ id: 'lead-b', nome: 'Carlos' });
    const leadA = makeLead({ id: 'lead-a', nome: 'Carlos' });
    const attempts = [leadA, leadB].map((l) => makeInteraction({ leadId: l.id, occurredAt: sameAttemptTime }));
    const queue = build([leadB, leadA], attempts);
    const sorted = sortWaitingFollowUps(queue);
    expect(sorted.map((i) => i.lead.id)).toEqual(['lead-a', 'lead-b']);
  });

  it('Fase 2C.2B.1 — B) dueAt válido antes de dueAt null (null vai para o fim, nunca para o início)', () => {
    const leadValid = makeLead({ id: 'valid-due' });
    const leadNull = makeLead({ id: 'null-due' });
    const itemValid = { lead: leadValid, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: hoursAgo(-5) }, error: null }; // vence em 5h
    const itemNull = { lead: leadNull, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: null }, error: null };
    const sorted = sortWaitingFollowUps([itemNull, itemValid]);
    expect(sorted.map((i) => i.lead.id)).toEqual(['valid-due', 'null-due']);
  });

  it('Fase 2C.2B.1 — C) dueAt válido antes de dueAt undefined', () => {
    const leadValid = makeLead({ id: 'valid-due' });
    const leadUndefined = makeLead({ id: 'undefined-due' });
    const itemValid = { lead: leadValid, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: hoursAgo(-5) }, error: null };
    const itemUndefined = { lead: leadUndefined, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: undefined }, error: null };
    const sorted = sortWaitingFollowUps([itemUndefined, itemValid]);
    expect(sorted.map((i) => i.lead.id)).toEqual(['valid-due', 'undefined-due']);
  });

  it('Fase 2C.2B.1 — D) dueAt válido antes de dueAt inválido (string não parseável)', () => {
    const leadValid = makeLead({ id: 'valid-due' });
    const leadInvalid = makeLead({ id: 'invalid-due' });
    const itemValid = { lead: leadValid, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: hoursAgo(-5) }, error: null };
    const itemInvalid = { lead: leadInvalid, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: 'not-a-date' }, error: null };
    const sorted = sortWaitingFollowUps([itemInvalid, itemValid]);
    expect(sorted.map((i) => i.lead.id)).toEqual(['valid-due', 'invalid-due']);
  });

  it('Fase 2C.2B.1 — E) todos sem dueAt válido: nome/id determina a ordem, nunca lança/gera NaN', () => {
    const leadNull = makeLead({ id: 'null-due', nome: 'Bruno' });
    const leadUndefined = makeLead({ id: 'undefined-due', nome: 'Ana' });
    const leadInvalid = makeLead({ id: 'invalid-due', nome: 'Carlos' });
    const itemNull = { lead: leadNull, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: null }, error: null };
    const itemUndefined = { lead: leadUndefined, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: undefined }, error: null };
    const itemInvalid = { lead: leadInvalid, evaluation: { status: FOLLOW_UP_STATUS.WAITING, dueAt: 'not-a-date' }, error: null };
    let sorted;
    expect(() => { sorted = sortWaitingFollowUps([itemNull, itemInvalid, itemUndefined]); }).not.toThrow();
    expect(sorted.map((i) => i.lead.id)).toEqual(['undefined-due', 'null-due', 'invalid-due']); // Ana, Bruno, Carlos
  });

  it('não muta o array recebido', () => {
    const a = makeLead({ id: 'a' });
    const b = makeLead({ id: 'b' });
    const attempts = [
      makeInteraction({ leadId: 'a', occurredAt: hoursAgo(1) }),
      makeInteraction({ leadId: 'b', occurredAt: hoursAgo(5) }),
    ];
    const queue = build([a, b], attempts);
    const originalOrder = queue.map((i) => i.lead.id);
    const frozenQueue = Object.freeze(queue);
    const sorted = sortWaitingFollowUps(frozenQueue);
    expect(queue.map((i) => i.lead.id)).toEqual(originalOrder);
    expect(sorted).not.toBe(queue);
  });
});

describe('Fase 2C.2B — sortBlockedFollowUps', () => {
  it('só itens blocked entram no resultado', () => {
    const due = makeLead({ id: 'due' });
    const blocked = makeLead({ id: 'blocked', proximoContato: '2026-12-25' });
    const queue = build([due, blocked], [makeInteraction({ leadId: 'due', occurredAt: hoursAgo(30) })]);
    const sorted = sortBlockedFollowUps(queue);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].lead.id).toBe('blocked');
  });

  it('ordena por nome alfabético', () => {
    const zeca = makeLead({ id: 'z', nome: 'Zeca', proximoContato: '2026-12-25' });
    const ana = makeLead({ id: 'a', nome: 'Ana', proximoContato: '2026-12-25' });
    const queue = build([zeca, ana]);
    const sorted = sortBlockedFollowUps(queue);
    expect(sorted.map((i) => i.lead.id)).toEqual(['a', 'z']);
  });

  it('id como desempate quando o nome é idêntico', () => {
    const leadB = makeLead({ id: 'lead-b', nome: 'Rafa', proximoContato: '2026-12-25' });
    const leadA = makeLead({ id: 'lead-a', nome: 'Rafa', proximoContato: '2026-12-25' });
    const queue = build([leadB, leadA]);
    const sorted = sortBlockedFollowUps(queue);
    expect(sorted.map((i) => i.lead.id)).toEqual(['lead-a', 'lead-b']);
  });

  it('não muta o array recebido', () => {
    const a = makeLead({ id: 'a', nome: 'Ana', proximoContato: '2026-12-25' });
    const b = makeLead({ id: 'b', nome: 'Bia', proximoContato: '2026-12-25' });
    const queue = build([b, a]);
    const originalOrder = queue.map((i) => i.lead.id);
    const frozenQueue = Object.freeze(queue);
    const sorted = sortBlockedFollowUps(frozenQueue);
    expect(queue.map((i) => i.lead.id)).toEqual(originalOrder);
    expect(sorted).not.toBe(queue);
  });
});
