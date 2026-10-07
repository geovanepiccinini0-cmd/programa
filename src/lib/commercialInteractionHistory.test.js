import { describe, it, expect } from 'vitest';
import { buildCommercialInteractionHistory } from './commercialInteractionHistory.js';

// Fase 2E.4.1 — testes da "memória comercial estruturada". Mesma
// convenção já estabelecida no projeto (ver nextBestAction.test.js/
// followUpEngine.test.js): nenhuma checagem estática de texto-fonte
// (grep por "Date.now"/"Math.random") — pureza/determinismo são
// provados COMPORTAMENTALMENTE (mesma entrada -> mesma saída, sempre,
// independente de quando o teste roda).

const BASE = '2026-01-10T';

function iso(hour, day = 10) {
  return `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

let seq = 0;
function makeInteraction(overrides = {}) {
  seq += 1;
  return {
    id: `it-${seq}`,
    leadId: 'lead-1',
    type: 'call',
    direction: 'outbound',
    channel: 'phone',
    content: '',
    metadata: { activity_class: 'attempt', source: 'user' },
    occurredAt: iso(10),
    createdAt: iso(10),
    createdBy: 'user-1',
    ...overrides,
  };
}

function callNoAnswer(occurredAt, extra = {}) {
  return makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', metadata: { activity_class: 'attempt', outcome: 'no_answer', source: 'user' }, occurredAt, ...extra });
}

function callConnected(occurredAt, extra = {}) {
  return makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user' }, occurredAt, ...extra });
}

function whatsappSent(occurredAt, extra = {}) {
  return makeInteraction({ type: 'whatsapp', direction: 'outbound', channel: 'whatsapp', metadata: { activity_class: 'attempt', source: 'user' }, occurredAt, ...extra });
}

function whatsappReceived(occurredAt, extra = {}) {
  return makeInteraction({ type: 'whatsapp', direction: 'inbound', channel: 'whatsapp', metadata: { activity_class: 'engagement', source: 'user' }, occurredAt, ...extra });
}

function meetingHeld(occurredAt, extra = {}) {
  return makeInteraction({ type: 'meeting', direction: 'outbound', channel: 'in_person', metadata: { activity_class: 'engagement', outcome: 'held', source: 'user' }, occurredAt, ...extra });
}

function proposalSent(occurredAt, extra = {}) {
  return makeInteraction({ type: 'proposal', direction: 'outbound', channel: 'manual', metadata: { activity_class: 'attempt', outcome: 'sent', source: 'user' }, occurredAt, ...extra });
}

function note(occurredAt, extra = {}) {
  return makeInteraction({ type: 'note', direction: 'internal', channel: 'manual', metadata: { activity_class: 'internal', source: 'user' }, occurredAt, ...extra });
}

function stageChange(occurredAt, extra = {}) {
  return makeInteraction({ type: 'stage_change', direction: 'internal', channel: 'crm', metadata: { from_stage: 'Novo Lead', to_stage: 'Ligação', activity_class: 'internal', source: 'user' }, occurredAt, ...extra });
}

describe('Fase 2E.4.1 — buildCommercialInteractionHistory — contrato vazio/nulo', () => {
  it('A) input vazio -> snapshot zerado, nenhum throw', () => {
    const h = buildCommercialInteractionHistory([]);
    expect(h.attempts).toEqual([]);
    expect(h.engagements).toEqual([]);
    expect(h.proposals).toEqual([]);
    expect(h.meetings).toEqual([]);
    expect(h.lastAttempt).toBeNull();
    expect(h.previousAttempt).toBeNull();
    expect(h.lastEngagement).toBeNull();
    expect(h.lastProposal).toBeNull();
    expect(h.lastMeeting).toBeNull();
    expect(h.attemptCount).toBe(0);
    expect(h.attemptCountByChannel).toEqual({ phone: 0, whatsapp: 0, in_person: 0 });
    expect(h.lastAttemptChannel).toBeNull();
    expect(h.previousAttemptChannel).toBeNull();
    expect(h.lastEngagementChannel).toBeNull();
  });

  it('B) null -> tratado como "sem histórico", mesmo resultado de []', () => {
    expect(buildCommercialInteractionHistory(null)).toEqual(buildCommercialInteractionHistory([]));
  });

  it('B.1) undefined -> mesmo tratamento', () => {
    expect(buildCommercialInteractionHistory(undefined)).toEqual(buildCommercialInteractionHistory([]));
  });

  it('B.2) valor não-array (ex. objeto solto) -> tratado como "sem histórico", nunca lança', () => {
    expect(() => buildCommercialInteractionHistory({ not: 'an array' })).not.toThrow();
    expect(buildCommercialInteractionHistory({ not: 'an array' })).toEqual(buildCommercialInteractionHistory([]));
  });
});

describe('Fase 2E.4.1 — projeções individuais por tipo real', () => {
  it('C) call_no_answer -> attempt, não engagement, não meeting, não proposal', () => {
    const it1 = callNoAnswer(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attempts).toEqual([it1]);
    expect(h.engagements).toEqual([]);
    expect(h.meetings).toEqual([]);
    expect(h.proposals).toEqual([]);
    expect(h.attemptCount).toBe(1);
    expect(h.lastAttemptChannel).toBe('phone');
  });

  it('D) whatsapp_sent -> attempt, canal whatsapp', () => {
    const it1 = whatsappSent(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attempts).toEqual([it1]);
    expect(h.engagements).toEqual([]);
    expect(h.lastAttemptChannel).toBe('whatsapp');
  });

  it('E) whatsapp_received -> engagement, NÃO attempt (inbound)', () => {
    const it1 = whatsappReceived(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.engagements).toEqual([it1]);
    expect(h.attempts).toEqual([]);
    expect(h.attemptCount).toBe(0);
    expect(h.lastEngagementChannel).toBe('whatsapp');
  });

  it('F) call_connected -> attempt E engagement simultaneamente', () => {
    const it1 = callConnected(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attempts).toEqual([it1]);
    expect(h.engagements).toEqual([it1]);
    expect(h.attemptCount).toBe(1);
    expect(h.lastAttemptChannel).toBe('phone');
    expect(h.lastEngagementChannel).toBe('phone');
  });

  it('G) meeting_held -> attempt, engagement E meeting simultaneamente', () => {
    const it1 = meetingHeld(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attempts).toEqual([it1]);
    expect(h.engagements).toEqual([it1]);
    expect(h.meetings).toEqual([it1]);
    expect(h.lastAttemptChannel).toBe('in_person');
    expect(h.lastEngagementChannel).toBe('in_person');
    expect(h.lastMeeting).toBe(it1);
  });

  it('H) proposal_sent -> só proposal, nunca attempt/engagement', () => {
    const it1 = proposalSent(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.proposals).toEqual([it1]);
    expect(h.attempts).toEqual([]);
    expect(h.engagements).toEqual([]);
    expect(h.attemptCount).toBe(0);
    expect(h.lastProposal).toBe(it1);
  });
});

describe('Fase 2E.4.1 — sequências e precedência', () => {
  it('I) call -> whatsapp: lastAttempt=whatsapp, previousAttempt=call', () => {
    const c = callNoAnswer(iso(10));
    const w = whatsappSent(iso(11));
    const h = buildCommercialInteractionHistory([c, w]);
    expect(h.lastAttempt).toBe(w);
    expect(h.previousAttempt).toBe(c);
    expect(h.lastAttemptChannel).toBe('whatsapp');
    expect(h.previousAttemptChannel).toBe('phone');
  });

  it('J) whatsapp -> call: lastAttempt=call, previousAttempt=whatsapp', () => {
    const w = whatsappSent(iso(10));
    const c = callNoAnswer(iso(11));
    const h = buildCommercialInteractionHistory([w, c]);
    expect(h.lastAttempt).toBe(c);
    expect(h.previousAttempt).toBe(w);
  });

  it('K) call -> whatsapp -> call: lastAttempt=call(2), previousAttempt=whatsapp, attemptCount=3', () => {
    const c1 = callNoAnswer(iso(10));
    const w = whatsappSent(iso(11));
    const c2 = callNoAnswer(iso(12));
    const h = buildCommercialInteractionHistory([c1, w, c2]);
    expect(h.lastAttempt).toBe(c2);
    expect(h.previousAttempt).toBe(w);
    expect(h.attemptCount).toBe(3);
    expect(h.attemptCountByChannel).toEqual({ phone: 2, whatsapp: 1, in_person: 0 });
  });

  it('L) attempt + proposal: proposal NÃO desloca lastAttempt', () => {
    const c = callNoAnswer(iso(10));
    const p = proposalSent(iso(12));
    const h = buildCommercialInteractionHistory([c, p]);
    expect(h.lastAttempt).toBe(c);
    expect(h.lastProposal).toBe(p);
    expect(h.attemptCount).toBe(1);
  });

  it('M) attempt + engagement (whatsapp_sent -> whatsapp_received)', () => {
    const w1 = whatsappSent(iso(10));
    const w2 = whatsappReceived(iso(11));
    const h = buildCommercialInteractionHistory([w1, w2]);
    expect(h.lastAttemptChannel).toBe('whatsapp');
    expect(h.lastEngagementChannel).toBe('whatsapp');
    expect(h.attemptCount).toBe(1);
    expect(h.lastAttempt).toBe(w1);
    expect(h.lastEngagement).toBe(w2);
  });

  it('N) proposal mais recente não desloca lastAttempt (exemplo da especificação: 10h call_no_answer, 11h whatsapp_sent, 12h proposal_sent)', () => {
    const c = callNoAnswer(iso(10));
    const w = whatsappSent(iso(11));
    const p = proposalSent(iso(12));
    const h = buildCommercialInteractionHistory([c, w, p]);
    expect(h.lastAttempt).toBe(w);
    expect(h.previousAttempt).toBe(c);
    expect(h.lastProposal).toBe(p);
  });

  it('O) engagement mais recente correto entre vários engagements', () => {
    const e1 = callConnected(iso(10));
    const e2 = meetingHeld(iso(12));
    const h = buildCommercialInteractionHistory([e1, e2]);
    expect(h.lastEngagement).toBe(e2);
    expect(h.lastEngagementChannel).toBe('in_person');
  });

  it('P) previousAttempt correto com 1 único attempt -> null', () => {
    const c = callNoAnswer(iso(10));
    const h = buildCommercialInteractionHistory([c]);
    expect(h.lastAttempt).toBe(c);
    expect(h.previousAttempt).toBeNull();
    expect(h.previousAttemptChannel).toBeNull();
  });

  it('Q) counts por canal com histórico misto', () => {
    const items = [callNoAnswer(iso(10)), whatsappSent(iso(11)), meetingHeld(iso(12)), callConnected(iso(13))];
    const h = buildCommercialInteractionHistory(items);
    expect(h.attemptCount).toBe(4);
    expect(h.attemptCountByChannel).toEqual({ phone: 2, whatsapp: 1, in_person: 1 });
  });
});

describe('Fase 2E.4.1 — ordering / tie-break / malformed', () => {
  it('R) entrada fora de ordem -> saída ordenada corretamente (cronológica crescente)', () => {
    const c1 = callNoAnswer(iso(10));
    const w = whatsappSent(iso(11));
    const c2 = callNoAnswer(iso(14));
    const shuffled = [c2, c1, w];
    const h = buildCommercialInteractionHistory(shuffled);
    expect(h.attempts).toEqual([c1, w, c2]);
    expect(h.lastAttempt).toBe(c2);
    expect(h.previousAttempt).toBe(w);
  });

  it('S) timestamps occurredAt iguais -> tie-break por createdAt, depois id, nunca pela ordem do array de entrada', () => {
    const tied = iso(10);
    const a = callNoAnswer(tied, { id: 'b-id', createdAt: iso(9) });
    const b = whatsappSent(tied, { id: 'a-id', createdAt: iso(8) });
    // b tem createdAt mais antigo -> deve vir primeiro, mesmo com id "a-id" < "b-id"
    // e mesmo entrando depois no array de entrada (prova que não é "ordem incidental").
    const h1 = buildCommercialInteractionHistory([a, b]);
    const h2 = buildCommercialInteractionHistory([b, a]);
    expect(h1.attempts).toEqual([b, a]);
    expect(h2.attempts).toEqual([b, a]);
  });

  it('S.1) occurredAt E createdAt iguais -> tie-break final por id (lexicográfico)', () => {
    const tied = iso(10);
    const z = callNoAnswer(tied, { id: 'z-id', createdAt: tied });
    const a = whatsappSent(tied, { id: 'a-id', createdAt: tied });
    const h = buildCommercialInteractionHistory([z, a]);
    expect(h.attempts).toEqual([a, z]);
  });

  it('T) occurredAt inválido/ausente -> excluído de todas as projeções, sem lançar', () => {
    const good = callNoAnswer(iso(10));
    const badMissing = whatsappSent(undefined, { id: 'bad-1' });
    const badInvalid = meetingHeld('not-a-date', { id: 'bad-2' });
    const h = buildCommercialInteractionHistory([good, badMissing, badInvalid]);
    expect(h.attempts).toEqual([good]);
    expect(h.attemptCount).toBe(1);
    expect(h.meetings).toEqual([]);
  });

  it('T.1) occurredAt null explícito -> mesma exclusão conservadora', () => {
    const h = buildCommercialInteractionHistory([callNoAnswer(null, { id: 'bad-3' })]);
    expect(h.attempts).toEqual([]);
    expect(h.attemptCount).toBe(0);
  });
});

describe('Fase 2E.4.1 — legacy / desconhecido / internal', () => {
  it('U) metadata ausente (null) -> nunca promovido a attempt/engagement/proposal por inferência', () => {
    const legacy = makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', metadata: null, occurredAt: iso(10) });
    const h = buildCommercialInteractionHistory([legacy]);
    expect(h.attempts).toEqual([]);
    expect(h.engagements).toEqual([]);
    expect(h.attemptCount).toBe(0);
  });

  it('V) activity_class ausente dentro de metadata -> mesma exclusão conservadora', () => {
    const legacy = makeInteraction({ type: 'call', direction: 'outbound', channel: 'phone', metadata: { source: 'user' }, occurredAt: iso(10) });
    const h = buildCommercialInteractionHistory([legacy]);
    expect(h.attempts).toEqual([]);
    expect(h.engagements).toEqual([]);
  });

  it('W) channel desconhecido não entra em attemptCountByChannel como chave dinâmica', () => {
    const weird = callNoAnswer(iso(10), { channel: 'carrier-pigeon' });
    const h = buildCommercialInteractionHistory([weird]);
    expect(h.attemptCountByChannel).toEqual({ phone: 0, whatsapp: 0, in_person: 0 });
    expect(Object.keys(h.attemptCountByChannel)).toEqual(['phone', 'whatsapp', 'in_person']);
    expect(h.lastAttemptChannel).toBe('carrier-pigeon');
  });

  it('W.1) channel ausente -> resolvido pelo type (fallback documentado, nunca inventa canal fora do mapa)', () => {
    const legacyNoChannel = callNoAnswer(iso(10), { channel: undefined });
    const h = buildCommercialInteractionHistory([legacyNoChannel]);
    expect(h.lastAttemptChannel).toBe('phone');
    expect(h.attemptCountByChannel.phone).toBe(1);
  });

  it('X) type desconhecido -> ignorado em todas as projeções comerciais, nunca lança', () => {
    const weird = makeInteraction({ type: 'mystery_type', direction: 'outbound', channel: 'phone', metadata: { activity_class: 'attempt' }, occurredAt: iso(10) });
    const h = buildCommercialInteractionHistory([weird]);
    expect(h.attempts).toEqual([]);
    expect(h.engagements).toEqual([]);
    expect(h.meetings).toEqual([]);
    expect(h.proposals).toEqual([]);
  });

  it('Y) interaction internal (note/stage_change) -> fora de todas as projeções comerciais', () => {
    const n = note(iso(10));
    const s = stageChange(iso(11));
    const h = buildCommercialInteractionHistory([n, s]);
    expect(h.attempts).toEqual([]);
    expect(h.engagements).toEqual([]);
    expect(h.proposals).toEqual([]);
    expect(h.meetings).toEqual([]);
  });

  it('Z) proposal nunca conta como attempt, mesmo sendo o único registro', () => {
    const p = proposalSent(iso(10));
    const h = buildCommercialInteractionHistory([p]);
    expect(h.attemptCount).toBe(0);
    expect(h.attemptCountByChannel).toEqual({ phone: 0, whatsapp: 0, in_person: 0 });
  });

  it('AA) meeting ocupa 3 projeções ao mesmo tempo (attempts + engagements + meetings), sem duplicar o registro em si', () => {
    const m = meetingHeld(iso(10));
    const h = buildCommercialInteractionHistory([m]);
    expect(h.attempts).toHaveLength(1);
    expect(h.engagements).toHaveLength(1);
    expect(h.meetings).toHaveLength(1);
    expect(h.attempts[0]).toBe(m);
    expect(h.engagements[0]).toBe(m);
    expect(h.meetings[0]).toBe(m);
  });
});

describe('Fase 2E.4.1 — imutabilidade e determinismo', () => {
  it('AB) nunca muta o array de entrada (ordem original preservada)', () => {
    const c2 = callNoAnswer(iso(14));
    const c1 = callNoAnswer(iso(10));
    const w = whatsappSent(iso(11));
    const input = [c2, c1, w];
    const snapshotBefore = [...input];
    buildCommercialInteractionHistory(input);
    expect(input).toEqual(snapshotBefore);
    expect(input[0]).toBe(c2); // mesma ordem de entrada, não re-ordenado in-place
  });

  it('AB.1) nunca muta os objetos interaction (nem o topo, nem metadata)', () => {
    const it1 = callNoAnswer(iso(10));
    const frozenShape = JSON.stringify(it1);
    buildCommercialInteractionHistory([it1]);
    expect(JSON.stringify(it1)).toBe(frozenShape);
  });

  it('AB.2) arrays retornados são cópias novas, nunca a referência do array de entrada', () => {
    const input = [callNoAnswer(iso(10))];
    const h = buildCommercialInteractionHistory(input);
    expect(h.attempts).not.toBe(input);
  });

  it('AC) determinismo: mesma entrada produz exatamente a mesma saída em chamadas repetidas', () => {
    const items = [callNoAnswer(iso(10)), whatsappSent(iso(11)), meetingHeld(iso(12)), proposalSent(iso(13))];
    const h1 = buildCommercialInteractionHistory(items);
    const h2 = buildCommercialInteractionHistory(items);
    expect(h1).toEqual(h2);
  });

  it('AD/AE) determinismo independente de quando o teste roda (prova comportamental de "sem Date.now/Math.random" — mesma convenção de nextBestAction.test.js)', () => {
    const items = [callNoAnswer(iso(10)), whatsappSent(iso(11))];
    const results = Array.from({ length: 5 }, () => buildCommercialInteractionHistory(items));
    results.forEach((r) => expect(r).toEqual(results[0]));
  });
});

describe('Fase 2E.4.1 — duplicatas (sem dedupe)', () => {
  it('22) duas interactions distintas com o mesmo "formato" são dois fatos, nenhuma é descartada', () => {
    const a = whatsappSent(iso(10), { id: 'dup-a' });
    const b = whatsappSent(iso(10), { id: 'dup-b', createdAt: iso(10) });
    const h = buildCommercialInteractionHistory([a, b]);
    expect(h.attempts).toHaveLength(2);
    expect(h.attemptCount).toBe(2);
  });

  it('22.1) IDs idênticos no input (cenário artificial) -> nenhum sistema de dedupe é aplicado, ambos preservados', () => {
    const a = whatsappSent(iso(10), { id: 'same-id' });
    const b = whatsappSent(iso(11), { id: 'same-id' });
    const h = buildCommercialInteractionHistory([a, b]);
    expect(h.attempts).toHaveLength(2);
    expect(h.lastAttempt).toBe(b);
  });
});

describe('Fase 2E.4.1 — paridade conceitual com Follow-up Engine', () => {
  // Mesma semântica de isContactAttemptInteraction/isEngagementInteraction/
  // isProposalSentInteraction (followUpEngine.js, privadas) comprovada
  // contra as MESMAS 6 ações comerciais reais (computeCommercialInteractionData,
  // useAppState.js) — sem importar nenhum internal do engine.
  it('24.1) call_no_answer: attempt=true, engagement=false (mesma classificação do engine)', () => {
    const h = buildCommercialInteractionHistory([callNoAnswer(iso(10))]);
    expect(h.attemptCount).toBe(1);
    expect(h.engagements).toEqual([]);
  });

  it('24.2) whatsapp_sent: attempt=true, engagement=false', () => {
    const h = buildCommercialInteractionHistory([whatsappSent(iso(10))]);
    expect(h.attemptCount).toBe(1);
    expect(h.engagements).toEqual([]);
  });

  it('24.3) call_connected: attempt=true, engagement=true (dupla classificação, igual ao engine)', () => {
    const it1 = callConnected(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attemptCount).toBe(1);
    expect(h.engagements).toEqual([it1]);
  });

  it('24.4) whatsapp_received: attempt=false (inbound), engagement=true', () => {
    const it1 = whatsappReceived(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attemptCount).toBe(0);
    expect(h.engagements).toEqual([it1]);
  });

  it('24.5) meeting_held: attempt=true, engagement=true, meeting=true', () => {
    const it1 = meetingHeld(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attemptCount).toBe(1);
    expect(h.engagements).toEqual([it1]);
    expect(h.meetings).toEqual([it1]);
  });

  it('24.6) proposal_sent: attempt=false, engagement=false, proposal=true (nunca reinicia cadência de tentativa, igual ao engine)', () => {
    const it1 = proposalSent(iso(10));
    const h = buildCommercialInteractionHistory([it1]);
    expect(h.attemptCount).toBe(0);
    expect(h.engagements).toEqual([]);
    expect(h.proposals).toEqual([it1]);
  });
});
