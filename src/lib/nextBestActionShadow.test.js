import { describe, it, expect } from 'vitest';
import { compareNextBestActions, NBA_SHADOW_STATUS } from './nextBestActionShadow.js';

function nba(overrides = {}) {
  return { type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule', ...overrides };
}

describe('Fase 2E.4.3 — compareNextBestActions', () => {
  it('A) ambos null -> both_null', () => {
    const r = compareNextBestActions(null, null);
    expect(r).toEqual({ status: 'both_null', current: null, candidate: null });
  });

  it('A.1) ambos undefined -> both_null', () => {
    const r = compareNextBestActions(undefined, undefined);
    expect(r.status).toBe(NBA_SHADOW_STATUS.BOTH_NULL);
  });

  it('B) estruturalmente equivalentes (mesmos 5 campos) -> match, mesmo sendo objetos distintos', () => {
    const current = nba();
    const candidate = nba(); // objeto diferente, mesmos valores
    expect(current).not.toBe(candidate);
    const r = compareNextBestActions(current, candidate);
    expect(r.status).toBe('match');
    expect(r.current).toBe(current);
    expect(r.candidate).toBe(candidate);
  });

  it('C) current null, candidate presente -> candidate_only', () => {
    const candidate = nba();
    const r = compareNextBestActions(null, candidate);
    expect(r).toEqual({ status: 'candidate_only', current: null, candidate });
  });

  it('D) current presente, candidate null -> current_only', () => {
    const current = nba();
    const r = compareNextBestActions(current, null);
    expect(r).toEqual({ status: 'current_only', current, candidate: null });
  });

  it('E) ambos presentes mas divergem em pelo menos 1 campo -> changed_action', () => {
    const current = nba({ channel: 'phone', type: 'call' });
    const candidate = nba({ channel: 'whatsapp', type: 'whatsapp' });
    const r = compareNextBestActions(current, candidate);
    expect(r.status).toBe('changed_action');
  });

  it('E.1) divergência só em confidence já basta para changed_action', () => {
    const current = nba({ confidence: 'rule' });
    const candidate = nba({ confidence: 'explicit' });
    expect(compareNextBestActions(current, candidate).status).toBe('changed_action');
  });

  it('E.2) divergência só em intent já basta para changed_action', () => {
    const current = nba({ intent: 'retry' });
    const candidate = nba({ intent: 'switch_channel' });
    expect(compareNextBestActions(current, candidate).status).toBe('changed_action');
  });

  it('F) independência de ordem de propriedades (nunca usa JSON.stringify)', () => {
    const current = { type: 'call', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' };
    const candidateReordered = { confidence: 'rule', reasonCode: 'no_response_after_attempt', intent: 'retry', channel: 'phone', type: 'call' };
    expect(JSON.stringify(current)).not.toBe(JSON.stringify(candidateReordered));
    expect(compareNextBestActions(current, candidateReordered).status).toBe('match');
  });

  it('F.1) campo extra irrelevante (ex. um futuro campo não comparado) não afeta o match', () => {
    const current = nba();
    const candidate = { ...nba(), somethingExtraNotInContract: 'x' };
    expect(compareNextBestActions(current, candidate).status).toBe('match');
  });

  it('imutabilidade: nunca muta current/candidate recebidos', () => {
    const current = nba();
    const candidate = nba({ channel: 'whatsapp', type: 'whatsapp' });
    const snapshotCurrent = JSON.stringify(current);
    const snapshotCandidate = JSON.stringify(candidate);
    compareNextBestActions(current, candidate);
    expect(JSON.stringify(current)).toBe(snapshotCurrent);
    expect(JSON.stringify(candidate)).toBe(snapshotCandidate);
  });

  it('determinismo: mesma entrada -> mesma saída em chamadas repetidas', () => {
    const current = nba();
    const candidate = nba({ channel: 'whatsapp', type: 'whatsapp' });
    const results = Array.from({ length: 5 }, () => compareNextBestActions(current, candidate));
    results.forEach((r) => expect(r).toEqual(results[0]));
  });

  it('contrato de retorno: exatamente {status, current, candidate}, nunca campos extras', () => {
    const r = compareNextBestActions(nba(), nba());
    expect(Object.keys(r).sort()).toEqual(['candidate', 'current', 'status']);
  });
});
