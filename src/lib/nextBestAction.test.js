import { describe, expect, it } from 'vitest';
import { evaluateFollowUpEligibility, FOLLOW_UP_POLICY } from './followUpEngine.js';
import { evaluateNextBestAction } from './nextBestAction.js';

// Fase 2E.1 — testes de paridade usam o motor REAL (evaluateFollowUpEligibility),
// nunca um followUpEvaluation mockado à mão para os casos A-O: a prova de
// paridade só vale se o insumo vier do próprio Follow-up Engine, do
// jeito que ele realmente calcula hoje. Testes de segurança/defensivos
// (seção 19) usam followUpEvaluation construído à mão de propósito,
// para isolar o comportamento do NBA independente de qualquer detalhe
// do motor.

const now = new Date('2026-10-10T12:00:00Z');

function makeLead(overrides) {
  return {
    id: 'lead-x', nome: 'Lead X', etapa: 'Follow-up 1', produto: 'Consórcio',
    telefone: '51992322166', nextActionType: '', deletedAt: null, proximoContato: null,
    createdAt: '2026-09-01T10:00:00Z',
    ...overrides,
  };
}

function iso(d) { return d.toISOString(); }
function hoursAgo(h) { return iso(new Date(now.getTime() - h * 3600 * 1000)); }
function daysAgo(d) { return hoursAgo(d * 24); }

function attempt(type, occurredAt, outcome) {
  return { leadId: 'lead-x', type, direction: 'outbound', channel: type === 'call' ? 'phone' : type, occurredAt, metadata: { activity_class: 'attempt', ...(outcome ? { outcome } : {}) } };
}
function engagementInbound(type, occurredAt) {
  return { leadId: 'lead-x', type, direction: 'inbound', channel: type, occurredAt, metadata: { activity_class: 'engagement' } };
}
function proposalSent(occurredAt) {
  return { leadId: 'lead-x', type: 'proposal', direction: 'outbound', channel: 'manual', occurredAt, metadata: { activity_class: 'attempt', outcome: 'sent' } };
}

function evaluate(lead, interactions) {
  return evaluateFollowUpEligibility({ lead, interactions, tasks: [], now, policy: FOLLOW_UP_POLICY });
}

describe('Fase 2E.1 — evaluateNextBestAction — paridade conceitual com suggestedAction', () => {
  it('A) never_contacted + explicit call -> type/channel iguais ao suggestedAction, intent first_contact, confidence explicit', () => {
    const lead = makeLead({ nextActionType: 'call' });
    const followUpEvaluation = evaluate(lead, []);
    expect(followUpEvaluation.reason).toBe('never_contacted');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({
      type: followUpEvaluation.suggestedAction.type,
      channel: followUpEvaluation.suggestedAction.channel,
      intent: 'first_contact',
      reasonCode: 'never_contacted',
      confidence: 'explicit',
    });
    expect(nba.type).toBe('call');
  });

  it('B) never_contacted + explicit whatsapp -> paridade, intent first_contact, confidence explicit', () => {
    const lead = makeLead({ nextActionType: 'whatsapp' });
    const followUpEvaluation = evaluate(lead, []);
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({
      type: 'whatsapp', channel: followUpEvaluation.suggestedAction.channel,
      intent: 'first_contact', reasonCode: 'never_contacted', confidence: 'explicit',
    });
  });

  it('C) never_contacted sem explicit -> null (suggestedAction também é null, zero default inventado)', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, []);
    expect(followUpEvaluation.suggestedAction).toBeNull();
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull();
  });

  it('D) no_response_after_attempt (call vencida, sem explicit) -> call/phone, intent retry, confidence rule', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [attempt('call', hoursAgo(30), 'no_answer')]);
    expect(followUpEvaluation.reason).toBe('no_response_after_attempt');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('E) no_response_after_attempt (whatsapp vencida, sem explicit) -> whatsapp/whatsapp, intent retry, confidence rule', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [attempt('whatsapp', hoursAgo(30))]);
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' });
  });

  it('F) tentativa anterior call + explicit whatsapp -> whatsapp vence (precedência humana), confidence explicit', () => {
    const lead = makeLead({ nextActionType: 'whatsapp' });
    const followUpEvaluation = evaluate(lead, [attempt('call', hoursAgo(30), 'no_answer')]);
    expect(followUpEvaluation.reason).toBe('no_response_after_attempt');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'explicit' });
  });

  it('G) cadence_exhausted (call) -> call/phone, intent retry, confidence rule', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [
      attempt('call', daysAgo(10), 'no_answer'), attempt('whatsapp', daysAgo(5)), attempt('call', hoursAgo(30), 'no_answer'),
    ]);
    expect(followUpEvaluation.reason).toBe('cadence_exhausted');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'cadence_exhausted', confidence: 'rule' });
  });

  it('H) cadence_exhausted (whatsapp) -> whatsapp/whatsapp, intent retry', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [
      attempt('call', daysAgo(10), 'no_answer'), attempt('call', daysAgo(5), 'no_answer'), attempt('whatsapp', hoursAgo(30)),
    ]);
    expect(followUpEvaluation.reason).toBe('cadence_exhausted');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'retry', reasonCode: 'cadence_exhausted', confidence: 'rule' });
  });

  it('I) reactivation_due (call) -> call/phone, intent reactivate, confidence rule', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [
      attempt('call', daysAgo(20), 'no_answer'), attempt('whatsapp', daysAgo(15)), attempt('call', daysAgo(10), 'no_answer'),
    ]);
    expect(followUpEvaluation.reason).toBe('reactivation_due');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'call', channel: 'phone', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'rule' });
  });

  it('J) reactivation_due (whatsapp) -> whatsapp/whatsapp, intent reactivate', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [
      attempt('whatsapp', daysAgo(20)), attempt('call', daysAgo(15), 'no_answer'), attempt('whatsapp', daysAgo(10)),
    ]);
    expect(followUpEvaluation.reason).toBe('reactivation_due');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'rule' });
  });

  it('K) proposal sem explicit (só a proposta, zero tentativa anterior) -> null', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [proposalSent(hoursAgo(60))]);
    expect(followUpEvaluation.reason).toBe('no_response_after_proposal');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull();
  });

  it('K.1) REGRESSÃO-CHAVE: proposal sem explicit, mas com tentativa call ANTERIOR à proposta -> ainda null (fecha o vazamento, não repete canal obsoleto)', () => {
    const lead = makeLead({ nextActionType: '' });
    const interactions = [attempt('call', hoursAgo(200), 'no_answer'), proposalSent(hoursAgo(60))];
    const followUpEvaluation = evaluate(lead, interactions);
    expect(followUpEvaluation.reason).toBe('no_response_after_proposal');
    // Confirma a premissa do override: o suggestedAction BRUTO do motor
    // ainda vaza o canal da tentativa pré-proposta — é exatamente esse
    // vazamento que o NBA decide não reproduzir.
    expect(followUpEvaluation.suggestedAction).toEqual({ type: 'call', channel: 'phone' });
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull();
  });

  it('L) proposal + explicit call -> call/phone, intent proposal_follow_up, confidence explicit', () => {
    const lead = makeLead({ nextActionType: 'call' });
    const followUpEvaluation = evaluate(lead, [proposalSent(hoursAgo(60))]);
    expect(followUpEvaluation.reason).toBe('no_response_after_proposal');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'call', channel: 'phone', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'explicit' });
  });

  it('M) proposal + explicit whatsapp -> whatsapp/whatsapp, intent proposal_follow_up, confidence explicit', () => {
    const lead = makeLead({ nextActionType: 'whatsapp' });
    const followUpEvaluation = evaluate(lead, [proposalSent(hoursAgo(60))]);
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'explicit' });
  });

  it('N) engagement após tentativa whatsapp (sem nova tentativa) -> comportamento equivalente ao atual (whatsapp/whatsapp, intent retry)', () => {
    const lead = makeLead({ nextActionType: '' });
    const interactions = [attempt('whatsapp', hoursAgo(150)), engagementInbound('whatsapp', hoursAgo(100))];
    const followUpEvaluation = evaluate(lead, interactions);
    expect(followUpEvaluation.reason).toBe('no_new_attempt_since_engagement');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'whatsapp', channel: 'whatsapp', intent: 'retry', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
  });

  it('O) engagement após tentativa call (sem nova tentativa) -> comportamento equivalente ao atual (call/phone, intent retry)', () => {
    const lead = makeLead({ nextActionType: '' });
    const interactions = [
      attempt('call', hoursAgo(150), 'no_answer'),
      { leadId: 'lead-x', type: 'call', direction: 'outbound', channel: 'phone', occurredAt: hoursAgo(100), metadata: { activity_class: 'engagement', outcome: 'connected' } },
    ];
    const followUpEvaluation = evaluate(lead, interactions);
    expect(followUpEvaluation.reason).toBe('no_new_attempt_since_engagement');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toEqual({ type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' });
  });
});

describe('Fase 2E.1 — evaluateNextBestAction — segurança / defensivo', () => {
  it('blocked (status) -> null, mesmo com suggestedAction (não deveria ter, mas defensivo)', () => {
    const nba = evaluateNextBestAction({
      lead: makeLead({}), interactions: [], tasks: [],
      followUpEvaluation: { status: 'blocked', reason: null, suggestedAction: null, blockers: ['etapa_ganho'] },
      now, policy: FOLLOW_UP_POLICY,
    });
    expect(nba).toBeNull();
  });

  it('terminal real via engine (etapa Ganho) -> blocked -> null', () => {
    const lead = makeLead({ etapa: 'Ganho', nextActionType: 'call' });
    const followUpEvaluation = evaluate(lead, []);
    expect(followUpEvaluation.status).toBe('blocked');
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull();
  });

  it('nextActionType desconhecido ("follow_up") -> não é explicit, cai para inferência (ou null se não houver tentativa)', () => {
    const lead = makeLead({ nextActionType: 'follow_up' });
    const followUpEvaluation = evaluate(lead, []);
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull(); // never_contacted, sem tentativa anterior, nextActionType não executável -> null
  });

  it('nextActionType desconhecido ("other") -> mesmo tratamento', () => {
    const lead = makeLead({ nextActionType: 'other' });
    const followUpEvaluation = evaluate(lead, []);
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull();
  });

  it('followUpEvaluation null/undefined -> null, sem lançar exceção', () => {
    expect(evaluateNextBestAction({ lead: makeLead({}), interactions: [], tasks: [], followUpEvaluation: null, now, policy: FOLLOW_UP_POLICY })).toBeNull();
    expect(evaluateNextBestAction({ lead: makeLead({}), interactions: [], tasks: [], followUpEvaluation: undefined, now, policy: FOLLOW_UP_POLICY })).toBeNull();
  });

  it('lead null/undefined -> não lança exceção, trata nextActionType como não-explícito', () => {
    const followUpEvaluation = { status: 'due', reason: 'never_contacted', suggestedAction: null, blockers: [] };
    expect(() => evaluateNextBestAction({ lead: null, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY })).not.toThrow();
    expect(evaluateNextBestAction({ lead: null, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY })).toBeNull();
    expect(evaluateNextBestAction({ lead: undefined, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY })).toBeNull();
  });

  it('interactions vazias -> não usadas pela política desta fase, zero crash', () => {
    const lead = makeLead({ nextActionType: 'call' });
    const followUpEvaluation = evaluate(lead, []);
    expect(() => evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY })).not.toThrow();
  });

  it('interactions legacy (metadata null) não afetam o NBA (ele nem olha para elas)', () => {
    const lead = makeLead({ nextActionType: '' });
    const legacyInteractions = [{ leadId: 'lead-x', type: 'call', direction: 'outbound', channel: 'phone', occurredAt: hoursAgo(10), metadata: null }];
    const followUpEvaluation = evaluate(lead, legacyInteractions);
    // O próprio motor já ignora com segurança (confirmado em followUpEngine.test.js) -> never_contacted continua devendo ser verdade.
    expect(followUpEvaluation.reason).toBe('never_contacted');
    const nba = evaluateNextBestAction({ lead, interactions: legacyInteractions, tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull();
  });

  it('interaction de tipo desconhecido não produz recomendação fabricada', () => {
    const lead = makeLead({ nextActionType: '' });
    const weird = [{ leadId: 'lead-x', type: 'carta_pombo', direction: 'outbound', channel: 'pombo', occurredAt: hoursAgo(10), metadata: { activity_class: 'attempt' } }];
    const followUpEvaluation = evaluate(lead, weird);
    const nba = evaluateNextBestAction({ lead, interactions: weird, tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    // Motor não reconhece 'carta_pombo' como contact attempt type -> continua never_contacted -> null.
    expect(followUpEvaluation.reason).toBe('never_contacted');
    expect(nba).toBeNull();
  });

  it('whatsapp_received (inbound) nunca é tratado como tentativa pelo NBA (ele só reflete o que o motor já decidiu)', () => {
    const lead = makeLead({ nextActionType: '' });
    const interactions = [engagementInbound('whatsapp', hoursAgo(10))];
    const followUpEvaluation = evaluate(lead, interactions);
    expect(followUpEvaluation.reason).toBe('no_new_attempt_since_engagement');
    const nba = evaluateNextBestAction({ lead, interactions, tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    // Zero tentativa outbound -> suggestedAction do motor é null -> NBA também null (nunca inventa a partir do engajamento inbound).
    expect(followUpEvaluation.suggestedAction).toBeNull();
    expect(nba).toBeNull();
  });

  it('proposal_sent nunca é tratado como "última tentativa" (reflete o próprio motor)', () => {
    const lead = makeLead({ nextActionType: '' });
    const followUpEvaluation = evaluate(lead, [proposalSent(hoursAgo(10))]);
    expect(followUpEvaluation.suggestedAction).toBeNull();
    const nba = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nba).toBeNull();
  });

  it('empate de timestamp entre duas tentativas: NBA não tem lógica própria de desempate — só reflete fielmente o que o motor decidiu, para a MESMA evaluation', () => {
    // Nota (achado desta auditoria, fora de escopo corrigir — zero diff
    // exigido em followUpEngine.js): o próprio motor resolve empate
    // exato de occurredAt pela ORDEM do array (maxInteractionBy usa
    // `t <= bestTime`, então o primeiro elemento do array vence em caso
    // de empate exato) — não é um dado determinístico como um id. Isso é
    // uma propriedade preexistente do motor, não introduzida aqui. O que
    // este teste prova é que o NBA nunca adiciona uma SEGUNDA política de
    // desempate própria: para uma evaluation fixa (já resolvida pelo
    // motor, nesta ordem de array), o NBA sempre devolve exatamente o
    // que essa evaluation.suggestedAction diz — nunca recalcula nada.
    const lead = makeLead({ nextActionType: '' });
    const sameTime = hoursAgo(30);
    const interactions = [attempt('call', sameTime, 'no_answer'), attempt('whatsapp', sameTime)];
    const followUpEvaluation = evaluate(lead, interactions);
    const nbaA = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    const nbaB = evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(nbaA).toEqual(nbaB);
    expect(nbaA.type).toBe(followUpEvaluation.suggestedAction.type);
    expect(nbaA.channel).toBe(followUpEvaluation.suggestedAction.channel);
  });

  it('não muta o array de interactions recebido', () => {
    const lead = makeLead({ nextActionType: '' });
    const interactions = [attempt('call', hoursAgo(30), 'no_answer')];
    const snapshot = JSON.parse(JSON.stringify(interactions));
    const followUpEvaluation = evaluate(lead, interactions);
    evaluateNextBestAction({ lead, interactions, tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(interactions).toEqual(snapshot);
  });

  it('não muta o objeto lead recebido', () => {
    const lead = makeLead({ nextActionType: 'call' });
    const snapshot = JSON.parse(JSON.stringify(lead));
    const followUpEvaluation = evaluate(lead, []);
    evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(lead).toEqual(snapshot);
  });

  it('não muta o followUpEvaluation recebido', () => {
    const lead = makeLead({ nextActionType: 'call' });
    const followUpEvaluation = evaluate(lead, []);
    const snapshot = JSON.parse(JSON.stringify(followUpEvaluation));
    evaluateNextBestAction({ lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY });
    expect(followUpEvaluation).toEqual(snapshot);
  });

  it('mesma entrada produz exatamente a mesma saída (determinístico, sem Date.now interno)', () => {
    const lead = makeLead({ nextActionType: 'whatsapp' });
    const followUpEvaluation = evaluate(lead, []);
    const args = { lead, interactions: [], tasks: [], followUpEvaluation, now, policy: FOLLOW_UP_POLICY };
    const a = evaluateNextBestAction(args);
    const b = evaluateNextBestAction(args);
    expect(a).toEqual(b);
  });

  it('reasonCode desconhecido/legado (não um dos 6 reasons reais) -> null, nunca fabrica intent', () => {
    const nba = evaluateNextBestAction({
      lead: makeLead({ nextActionType: 'call' }), interactions: [], tasks: [],
      followUpEvaluation: { status: 'due', reason: 'reason_futuro_desconhecido', suggestedAction: { type: 'call', channel: 'phone' }, blockers: [] },
      now, policy: FOLLOW_UP_POLICY,
    });
    expect(nba).toBeNull();
  });
});
