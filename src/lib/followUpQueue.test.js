import { describe, expect, it } from 'vitest';
import { buildFollowUpQueue, sortDueFollowUps, getDueFollowUps, getWaitingFollowUps, getBlockedFollowUps } from './followUpQueue.js';
import { FOLLOW_UP_STATUS, FOLLOW_UP_REASON } from './followUpEngine.js';

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
